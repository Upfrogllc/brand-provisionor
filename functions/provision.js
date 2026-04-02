/**
 * Upfrog GHL Provisioner — Netlify Function
 * Each step runs independently. One failure never stops the others.
 * Every step logs ✓ success or ⚠ failure with the reason.
 */
export const handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  const respond = (body, status = 200) => ({
    statusCode: status, headers, body: JSON.stringify(body),
  });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')   return respond({ error: 'Method not allowed' }, 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond({ error: 'Invalid JSON' }, 400); }

  const { secret, locationId, apiKey, brand = {} } = body;

  if (!process.env.UPFROG_SECRET || secret !== process.env.UPFROG_SECRET)
    return respond({ error: 'Unauthorized' }, 401);
  if (!locationId || !apiKey)
    return respond({ error: 'locationId and apiKey required' }, 400);

  // ── Brand config ─────────────────────────────────────────
  const B = {
    name:    brand.name         || 'Upfrog Brand',
    phone:   brand.phone        || '',
    slug:    brand.slug         || 'brand',
    vert:    brand.vertical     || 'windows',
    primary: brand.colorPrimary || '0e2a47',
    accent:  brand.colorAccent  || '3a9bd5',
    results: brand.resultsUrl   || '',
    worker:  brand.workerUrl    || '',
  };

  // ── GHL fetch helper ─────────────────────────────────────
  async function ghl(method, path, data = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Version':       '2021-07-28',
      },
    };
    if (data) opts.body = JSON.stringify(data);
    const res  = await fetch(`https://services.leadconnectorhq.com${path}`, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json).slice(0, 250)}`);
    return json;
  }

  // ── Step runner — each step isolated, never throws ───────
  // Returns { ok, data, error }
  async function step(name, fn) {
    result.log.push(`── ${name}`);
    try {
      const data = await fn();
      result.log.push(`✓ ${name}`);
      return { ok: true, data };
    } catch(e) {
      result.log.push(`⚠ ${name}: ${e.message}`);
      result.steps_failed.push(name);
      return { ok: false, error: e.message };
    }
  }

  // ── Result object ────────────────────────────────────────
  const result = {
    ok: true,
    location_id:    locationId,
    location_name:  null,
    brand_slug:     B.slug,
    brand_name:     B.name,
    brand_phone:    B.phone,
    brand_vertical: B.vert,
    colors:         { primary: B.primary, accent: B.accent },
    results_url:    B.results,
    worker_url:     B.worker,
    custom_fields:  {},
    pipeline_id:    null,
    pipeline_stages:{},
    calendar_id:    null,
    calendar_embed: null,
    webhook_url:    null,
    tag_name:       null,
    tag_id:         null,
    workflow_id:    null,
    sms_templates:  {},
    email_templates:{},
    steps_failed:   [],
    provisioned_at: new Date().toISOString(),
    log:            [],
  };

  // ════════════════════════════════════════════════════════
  // STEP 1 — Verify location access
  // ════════════════════════════════════════════════════════
  const verifyResult = await step('Verify location', async () => {
    const r = await ghl('GET', `/locations/${locationId}`);
    result.location_name = r.location?.name || r.name;
    return r;
  });

  // If we can't even connect, stop here — nothing else will work
  if (!verifyResult.ok) {
    result.ok    = false;
    result.error = 'Could not connect to GHL location. Check your API key and Location ID.';
    return respond(result, 500);
  }

  // ════════════════════════════════════════════════════════
  // STEP 2 — Custom fields
  // ════════════════════════════════════════════════════════
  await step('Custom fields', async () => {
    const FIELDS = [
      { key: 'price_good',       label: 'Price Good',       dataType: 'TEXT'      },
      { key: 'price_better',     label: 'Price Better',     dataType: 'TEXT'      },
      { key: 'price_best',       label: 'Price Best',       dataType: 'TEXT'      },
      { key: 'price_per_window', label: 'Price Per Window', dataType: 'TEXT'      },
      { key: 'window_count',     label: 'Window Count',     dataType: 'NUMERICAL' },
      { key: 'year_built',       label: 'Year Built',       dataType: 'NUMERICAL' },
      { key: 'sqft',             label: 'Sqft',             dataType: 'NUMERICAL', systemField: 'contact.square_footage' },
      { key: 'stories',          label: 'Stories',          dataType: 'NUMERICAL' },
      { key: 'install_type',     label: 'Install Type',     dataType: 'TEXT'      },
      { key: 'glass_package',    label: 'Glass Package',    dataType: 'TEXT'      },
      { key: 'window_types',     label: 'Window Types',     dataType: 'TEXT'      },
      { key: 'addon_list',       label: 'Addon List',       dataType: 'TEXT'      },
      { key: 'addon_total',      label: 'Addon Total',      dataType: 'TEXT'      },
      { key: 'lead_paint_flag',  label: 'Lead Paint Flag',  dataType: 'TEXT'      },
      { key: 'bay_bow_detected', label: 'Bay Bow Detected', dataType: 'TEXT'      },
      { key: 'lead_source',      label: 'Lead Source',      dataType: 'TEXT'      },
      { key: 'analysis_path',    label: 'Analysis Path',    dataType: 'TEXT'      },
      { key: 'property_address', label: 'Property Address', dataType: 'TEXT'      },
      { key: 'estimate_url',     label: 'Estimate URL',     dataType: 'TEXT'      },
      { key: 'tcpa_consent',     label: 'TCPA Consent',     dataType: 'TEXT'      },
    ];

    // Fetch existing to avoid duplicates
    let existing = [];
    try {
      const ef = await ghl('GET', `/locations/${locationId}/customFields`);
      existing = ef.customFields || ef.fields || [];
    } catch {}

    // Create each field independently
    for (const f of FIELDS) {
      // System fields already exist in GHL — find by fieldKey
      if (f.systemField) {
        const sys = existing.find(e => e.fieldKey === f.systemField || e.fieldKey?.includes(f.key));
        result.custom_fields[f.key] = sys?.id || null;
        result.log.push(`  · ${f.label}: system field (${result.custom_fields[f.key] || 'not found'})`);
        continue;
      }
      const found = existing.find(e => e.name === f.label || e.fieldKey?.includes(f.key));
      if (found) {
        result.custom_fields[f.key] = found.id;
        result.log.push(`  · ${f.label}: exists (${found.id})`);
        continue;
      }
      try {
        const r = await ghl('POST', `/locations/${locationId}/customFields`, {
          name: f.label, dataType: f.dataType, model: 'contact',
        });
        result.custom_fields[f.key] = r.customField?.id || r.id || null;
        result.log.push(`  ✓ ${f.label}: ${result.custom_fields[f.key]}`);
      } catch(e) {
        result.custom_fields[f.key] = null;
        result.log.push(`  ⚠ ${f.label}: ${e.message.slice(0, 80)}`);
      }
    }
  });

  // ════════════════════════════════════════════════════════
  // STEP 3 — Pipeline
  // ════════════════════════════════════════════════════════
  await step('Pipeline', async () => {
    const name = `${B.name} — ${B.vert === 'windows' ? 'Window' : 'Lawn'} Leads`;
    const ep   = await ghl('GET', `/opportunities/pipelines?locationId=${locationId}`);
    const found = (ep.pipelines || []).find(p => p.name === name);
    if (found) {
      result.pipeline_id = found.id;
      (found.stages || []).forEach(s => { result.pipeline_stages[s.name] = s.id; });
      result.log.push(`  · Already exists: ${result.pipeline_id}`);
      return;
    }
    const pr = await ghl('POST', `/opportunities/pipelines`, {
      locationId, name,
      stages: ['New Lead','Estimate Viewed','Eval Booked','Eval Completed','Closed Won','Closed Lost']
              .map((n, i) => ({ name: n, position: i })),
    });
    result.pipeline_id = pr.pipeline?.id || pr.id;
    (pr.pipeline?.stages || []).forEach(s => { result.pipeline_stages[s.name] = s.id; });
    result.log.push(`  · ID: ${result.pipeline_id}`);
  });

  // ════════════════════════════════════════════════════════
  // STEP 4 — Tag
  // ════════════════════════════════════════════════════════
  const TAG_NAME = `${B.vert === 'windows' ? 'Window' : 'Lawn'} Lead`;
  result.tag_name = TAG_NAME;

  await step('Tag', async () => {
    try {
      const r = await ghl('POST', `/locations/${locationId}/tags`, { name: TAG_NAME });
      result.tag_id = r.tag?.id || r.id || null;
      result.log.push(`  · Created ID: ${result.tag_id}`);
    } catch(e) {
      // Tag already exists — fetch it
      if (e.message.includes('already exist')) {
        const list = await ghl('GET', `/locations/${locationId}/tags?limit=100`);
        const tags = list.tags || list.data || [];
        const found = tags.find(t => t.name === TAG_NAME);
        result.tag_id = found?.id || null;
        result.log.push(`  · Already exists, ID: ${result.tag_id}`);
      } else {
        throw e; // re-throw real errors
      }
    }
  });

  // ════════════════════════════════════════════════════════
  // STEP 5 — SMS templates (each one independent)
  // ════════════════════════════════════════════════════════
  const SMS_LIST = [
    { key: 'instant',    name: `[${B.slug}] Instant`,
      body: `Hi {{contact.first_name}}, your ${B.name} estimate is ready! View pricing + book your free in-home eval: {{contact.estimate_url}} — Reply STOP to opt out` },
    { key: 'nudge_1hr',  name: `[${B.slug}] 1hr nudge`,
      body: `Still thinking, {{contact.first_name}}? Your estimate expires tonight. Book free eval: {{contact.estimate_url}} · ${B.phone}` },
    { key: 'day2_fin',   name: `[${B.slug}] Day2 financing`,
      body: `{{contact.first_name}}, new windows from $89/mo — 0% interest 18 months. See options: {{contact.estimate_url}} · ${B.name}` },
    { key: 'day5_value', name: `[${B.slug}] Day5 value`,
      body: `Are your windows drafty, {{contact.first_name}}? New windows cut energy bills 15-25%. Your estimate: {{contact.estimate_url}}` },
    { key: 'day7_close', name: `[${B.slug}] Day7 close`,
      body: `Last chance {{contact.first_name}} — holding your price through Sunday + free screens on every window. ${B.phone}` },
  ];

  for (const t of SMS_LIST) {
    await step(`SMS: ${t.key}`, async () => {
      const r = await ghl('POST', `/locations/${locationId}/templates`, {
        name: t.name, type: 'sms', body: t.body,
      });
      // Log every key in the response so we can see the shape
      result.log.push(`  · Response keys: ${Object.keys(r).join(', ')}`);
      result.sms_templates[t.key] = r.template?.id || r.id || r._id || r.templateId || null;
      result.log.push(`  · ID: ${result.sms_templates[t.key]}`);
    });
  }

  // ════════════════════════════════════════════════════════
  // STEP 6 — Email templates (each one independent)
  // ════════════════════════════════════════════════════════
  const EMAIL_BASE = `<div style="max-width:580px;margin:32px auto;font-family:Arial,sans-serif">
<div style="background:#${B.accent};padding:24px;text-align:center">
  <h1 style="color:#fff;margin:0;font-size:22px">${B.name}</h1>
</div>
<div style="padding:28px">
  <p style="font-size:16px">Hi {{contact.first_name}},</p>
  <p>Your window estimate is still waiting. We prepared Good, Better, and Best options for your home.</p>
  <div style="background:#f0f8ff;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
    <p style="margin:0 0 4px;font-size:12px;color:#6b7280">Better package</p>
    <p style="margin:0;font-size:32px;font-weight:700;color:#0e2a47">{{contact.price_better}}</p>
    <p style="margin:4px 0 0;font-size:12px;color:#6b7280">{{contact.window_count}} windows installed</p>
  </div>
  <p>Free in-home eval — 30 minutes, zero obligation.</p>
  <div style="text-align:center;margin:24px 0">
    <a href="{{contact.estimate_url}}" style="background:#${B.accent};color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Book My Free Eval</a>
  </div>
  <p style="font-size:11px;color:#9ca3af">${B.name} · ${B.phone}</p>
</div></div>`;

  const EMAIL_LIST = [
    { key: 'day1_recap',
      name: `[${B.slug}] Day1 recap`,
      subject: `Your ${B.name} estimate — 3 options ready`,
      html: EMAIL_BASE },
    { key: 'day3_objection',
      name: `[${B.slug}] Day3 objection`,
      subject: `"Is it really worth it?" — honest answer`,
      html: `<div style="max-width:580px;margin:32px auto;font-family:Arial,sans-serif;color:#374151;line-height:1.7">
<h2 style="color:#0e2a47">The 3 questions we hear most</h2>
<p><strong>"Can I wait another year?"</strong><br>Every winter with drafty windows costs more in heating bills. Most say they wished they'd done it sooner.</p>
<p><strong>"Is the price firm?"</strong><br>The eval confirms measurements and locks your price — no surprises at install.</p>
<p><strong>"How long does it take?"</strong><br>Most whole-house jobs finish in a single day.</p>
<p>Your estimate is still saved. <a href="{{contact.estimate_url}}" style="color:#${B.accent};font-weight:700">View it here</a> or call ${B.phone}.</p>
</div>` },
    { key: 'day7_close',
      name: `[${B.slug}] Day7 close`,
      subject: `Last chance — estimate price expires Sunday`,
      html: `<div style="max-width:580px;margin:32px auto;font-family:Arial,sans-serif;color:#374151;line-height:1.7">
<h2 style="color:#0e2a47">We're holding your price through Sunday</h2>
<p>Book before Sunday and we'll add free upgraded screens on every window.</p>
<div style="text-align:center;margin:24px 0">
  <a href="{{contact.estimate_url}}" style="background:#${B.accent};color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Claim My Free Screens</a>
</div>
<p style="font-size:11px;color:#9ca3af">${B.name} · ${B.phone}</p>
</div>` },
  ];

  for (const t of EMAIL_LIST) {
    await step(`Email: ${t.key}`, async () => {
      const r = await ghl('POST', `/locations/${locationId}/templates`, {
        name: t.name, type: 'email', subject: t.subject, body: t.html,
      });
      result.log.push(`  · Response keys: ${Object.keys(r).join(', ')}`);
      result.email_templates[t.key] = r.template?.id || r.id || r._id || r.templateId || null;
      result.log.push(`  · ID: ${result.email_templates[t.key]}`);
    });
  }

  // ════════════════════════════════════════════════════════
  // STEP 7 — Calendar
  // ════════════════════════════════════════════════════════
  await step('Calendar', async () => {
    const r = await ghl('POST', `/calendars/`, {
      locationId,
      name:         `${B.name} — Free In-Home Eval`,
      description:  'Free 30-min evaluation. No obligation.',
      slotDuration: 30,
      slotInterval: 30,
      isActive:     true,
    });
    result.log.push(`  · Response keys: ${Object.keys(r).join(', ')}`);
    result.calendar_id    = r.calendar?.id || r.id || null;
    result.calendar_embed = result.calendar_id
      ? `https://api.leadconnectorhq.com/widget/booking/${result.calendar_id}`
      : null;
    result.log.push(`  · ID: ${result.calendar_id}`);
  });

  // ════════════════════════════════════════════════════════
  // STEP 8 — Webhook URL
  // ════════════════════════════════════════════════════════
  await step('Webhook URL', async () => {
    const r = await ghl('GET', `/locations/${locationId}`);
    result.webhook_url = r.location?.settings?.webhookUrl
      || `https://services.leadconnectorhq.com/hooks/${locationId}/webhook-trigger/`;
    result.log.push(`  · ${result.webhook_url}`);
  });

  // ════════════════════════════════════════════════════════
  // STEP 9 — Workflow
  // ════════════════════════════════════════════════════════
  await step('Workflow', async () => {
    const r = await ghl('POST', `/locations/${locationId}/workflows`, {
      name:   `[${B.slug}] Lead Nurture — Book In-Home Eval`,
      status: 'active',
      trigger: { type: 'TAG_ADDED', filter: { tag: TAG_NAME } },
      actions: [
        { type: 'SEND_SMS',   templateId: result.sms_templates.instant,        delayValue: 0,  delayType: 'minutes' },
        { type: 'WAIT',       delayValue: 1,  delayType: 'hours' },
        { type: 'IF_ELSE',    condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
          onTrue: [], onFalse: [{ type: 'SEND_SMS', templateId: result.sms_templates.nudge_1hr }] },
        { type: 'WAIT',       delayValue: 23, delayType: 'hours' },
        { type: 'SEND_EMAIL', templateId: result.email_templates.day1_recap },
        { type: 'WAIT',       delayValue: 2,  delayType: 'days' },
        { type: 'IF_ELSE',    condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
          onTrue: [], onFalse: [
            { type: 'SEND_EMAIL', templateId: result.email_templates.day3_objection },
            { type: 'SEND_SMS',   templateId: result.sms_templates.day2_fin },
          ]},
        { type: 'WAIT',       delayValue: 2,  delayType: 'days' },
        { type: 'IF_ELSE',    condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
          onTrue: [], onFalse: [
            { type: 'SEND_SMS',    templateId: result.sms_templates.day5_value },
            { type: 'CREATE_TASK', title: `Call {{contact.first_name}} — window estimate`,
              body:  `Estimate: {{contact.price_better}}. Hasn't booked eval.` },
          ]},
        { type: 'WAIT',       delayValue: 2,  delayType: 'days' },
        { type: 'IF_ELSE',    condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
          onTrue: [], onFalse: [
            { type: 'SEND_EMAIL', templateId: result.email_templates.day7_close },
            { type: 'SEND_SMS',   templateId: result.sms_templates.day7_close },
          ]},
        { type: 'REMOVE_TAG', tag: TAG_NAME },
      ],
    });
    result.log.push(`  · Response keys: ${Object.keys(r).join(', ')}`);
    result.workflow_id = r.workflow?.id || r.id || null;
    result.log.push(`  · ID: ${result.workflow_id}`);
  });

  // ════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════
  const failed  = result.steps_failed.length;
  const total   = result.log.filter(l => l.startsWith('── ')).length - 1; // subtract "── Complete"
  const success = Math.max(0, total - failed);
  result.log.push(`── Complete: ${success}/${total} steps succeeded`);
  if (failed > 0) result.log.push(`── Needs attention: ${result.steps_failed.join(', ')}`);

  return respond(result);
};
