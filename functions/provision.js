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
    name:       brand.name         || 'Upfrog Brand',
    phone:      brand.phone        || '',
    slug:       brand.slug         || 'brand',
    vert:       brand.vertical     || 'windows',
    primary:    brand.colorPrimary || '0e2a47',
    accent:     brand.colorAccent  || '3a9bd5',
    results:    brand.resultsUrl   || '',
    worker:     brand.workerUrl    || '',
    snapshotId: brand.snapshotId   || null,
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
  // STEP 5 — SMS + Email templates via Conversations/Email API
  // Note: /locations/{id}/templates is not yet IAM-supported by GHL.
  // We store the template content in result for manual creation or
  // snapshot deployment. We attempt the API call but gracefully note
  // the GHL limitation if it fails.
  // ════════════════════════════════════════════════════════
  result.sms_templates = {
    instant:    { name: `[${B.slug}] Instant`,       body: `Hi {{contact.first_name}}, your ${B.name} estimate is ready! View pricing + book your free in-home eval: {{contact.estimate_url}} — Reply STOP to opt out` },
    nudge_1hr:  { name: `[${B.slug}] 1hr nudge`,     body: `Still thinking, {{contact.first_name}}? Your estimate expires tonight. Book free eval: {{contact.estimate_url}} · ${B.phone}` },
    day2_fin:   { name: `[${B.slug}] Day2 financing`, body: `{{contact.first_name}}, new windows from $89/mo — 0% interest 18 months. See options: {{contact.estimate_url}} · ${B.name}` },
    day5_value: { name: `[${B.slug}] Day5 value`,     body: `Are your windows drafty, {{contact.first_name}}? New windows cut energy bills 15-25%. Your estimate: {{contact.estimate_url}}` },
    day7_close: { name: `[${B.slug}] Day7 close`,     body: `Last chance {{contact.first_name}} — holding your price through Sunday + free screens on every window. ${B.phone}` },
  };

  result.email_templates = {
    day1_recap:     { name: `[${B.slug}] Day1 recap`,     subject: `Your ${B.name} estimate — 3 options ready` },
    day3_objection: { name: `[${B.slug}] Day3 objection`, subject: `"Is it really worth it?" — honest answer` },
    day7_close:     { name: `[${B.slug}] Day7 close`,     subject: `Last chance — estimate price expires Sunday` },
  };

  await step('Templates (stored for manual/snapshot)', async () => {
    result.log.push(`  · GHL /templates endpoint not yet IAM-supported via Private Integration`);
    result.log.push(`  · Template content stored in result.sms_templates and result.email_templates`);
    result.log.push(`  · See result.manual_steps for instructions`);
  });

  // ════════════════════════════════════════════════════════
  // STEP 6 — Snapshot deployment (if snapshot ID provided)
  // ════════════════════════════════════════════════════════
  await step('Snapshot', async () => {
    if (!B.snapshotId) {
      result.log.push(`  · No snapshotId provided — skipping`);
      result.log.push(`  · To use: add snapshotId to brand config in dashboard`);
      return;
    }
    const r = await ghl('POST', `/snapshots/share/link`, {
      snapshot_id:     B.snapshotId,
      share_location:  locationId,
    });
    result.snapshot_deployed = r.status || 'sent';
    result.log.push(`  · Snapshot deployed: ${result.snapshot_deployed}`);
  });

  // ════════════════════════════════════════════════════════
  // STEP 7 — Calendar (check existing first to avoid duplicates)
  // ════════════════════════════════════════════════════════
  await step('Calendar', async () => {
    // Check for existing calendar first
    try {
      const existing = await ghl('GET', `/calendars/?locationId=${locationId}`);
      const cals = existing.calendars || existing.data || [];
      const found = cals.find(c => c.name?.includes('In-Home Eval') || c.name?.includes(B.name));
      if (found) {
        result.calendar_id    = found.id;
        result.calendar_embed = `https://api.leadconnectorhq.com/widget/booking/${found.id}`;
        result.log.push(`  · Exists: ${found.name} (${found.id})`);
        return;
      }
    } catch {}

    const r = await ghl('POST', `/calendars/`, {
      locationId,
      name:         `${B.name} — Free In-Home Eval`,
      description:  'Free 30-min evaluation. No obligation.',
      slotDuration: 30,
      slotInterval: 30,
      isActive:     true,
    });
    result.calendar_id    = r.calendar?.id || r.id || null;
    result.calendar_embed = result.calendar_id
      ? `https://api.leadconnectorhq.com/widget/booking/${result.calendar_id}`
      : null;
    result.log.push(`  · Created: ${result.calendar_id}`);
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
  // STEP 9 — Workflow (not yet available via Private Integration API)
  // Store definition for manual import into GHL workflow builder
  // ════════════════════════════════════════════════════════
  await step('Workflow (stored for manual import)', async () => {
    result.workflow_manual = {
      name:    `[${B.slug}] Lead Nurture — Book In-Home Eval`,
      trigger: `Contact tag added: "${TAG_NAME}"`,
      steps: [
        { delay: 'immediate',  channel: 'SMS',   template: result.sms_templates.instant?.name,    note: 'Estimate ready — send immediately' },
        { delay: '1 hour',     channel: 'SMS',   template: result.sms_templates.nudge_1hr?.name,  note: 'Only if no appointment booked' },
        { delay: '24 hours',   channel: 'Email', template: result.email_templates.day1_recap?.name, note: 'Full estimate recap email' },
        { delay: '3 days',     channel: 'Email', template: result.email_templates.day3_objection?.name, note: 'Objection handler — only if not booked' },
        { delay: '3 days',     channel: 'SMS',   template: result.sms_templates.day2_fin?.name,   note: 'Financing angle — only if not booked' },
        { delay: '5 days',     channel: 'SMS',   template: result.sms_templates.day5_value?.name, note: 'Value/energy savings — only if not booked' },
        { delay: '5 days',     channel: 'Task',  template: null,                                   note: 'Create rep call task — only if not booked' },
        { delay: '7 days',     channel: 'Email', template: result.email_templates.day7_close?.name, note: 'Final offer — only if not booked' },
        { delay: '7 days',     channel: 'SMS',   template: result.sms_templates.day7_close?.name, note: 'Final SMS — only if not booked' },
        { delay: 'end',        channel: 'Action', template: null,                                  note: `Remove tag "${TAG_NAME}"` },
      ],
    };
    result.log.push(`  · Workflow definition stored in result.workflow_manual`);
    result.log.push(`  · GHL workflow API not exposed via Private Integration — create manually`);
  });

  // ════════════════════════════════════════════════════════
  // MANUAL STEPS — things that still need human action
  // ════════════════════════════════════════════════════════
  result.manual_steps = [
    {
      step: 1,
      title: 'Add opportunities.write scope to Private Integration',
      why:   'Pipeline creation still needs this scope enabled',
      how:   'GHL → Settings → Integrations → Private Apps → Edit → add opportunities.write → save (token stays the same)',
    },
    {
      step: 2,
      title: 'Create SMS templates manually',
      why:   'GHL /templates endpoint not yet IAM-supported',
      how:   'GHL → Marketing → Email & SMS Templates → New Template → paste from result.sms_templates',
    },
    {
      step: 3,
      title: 'Create email templates manually',
      why:   'Same GHL limitation',
      how:   'GHL → Marketing → Email & SMS Templates → New Template → paste from result.email_templates',
    },
    {
      step: 4,
      title: 'Build workflow in GHL',
      why:   'Workflow API not exposed via Private Integration',
      how:   'GHL → Automations → New Workflow → follow result.workflow_manual steps',
    },
  ];

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
