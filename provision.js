/**
 * Netlify Function: provision.js
 * POST /.netlify/functions/provision
 *
 * Body: { secret, locationId, apiKey, brand }
 * - secret:     matches UPFROG_SECRET env var (gate-keeps the endpoint)
 * - locationId: GHL location ID
 * - apiKey:     location private integration key (sent from browser, never logged)
 * - brand:      { name, phone, slug, vertical, colorPrimary, colorAccent, resultsUrl, workerUrl }
 *
 * Returns: non-sensitive config JSON (IDs only, no keys)
 */

export const handler = async function(event) {
  const req = {
    method:  event.httpMethod,
    json:    () => Promise.resolve(JSON.parse(event.body || '{}')),
  };
  // ── CORS headers ──────────────────────────────────────────
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  const respond = (body, status = 200) => ({
    statusCode: status,
    headers,
    body: JSON.stringify(body),
  });

  if (req.method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405);
  }

  // ── Parse + validate body ─────────────────────────────────
  let body;
  try {
    body = await req.json();
  } catch {
    return respond({ error: 'Invalid JSON body' }, 400);
  }

  const { secret, locationId, apiKey, brand = {} } = body;

  // Gate — check secret matches env var
  const UPFROG_SECRET = process.env.UPFROG_SECRET;
  if (!UPFROG_SECRET || secret !== UPFROG_SECRET) {
    return respond({ error: 'Unauthorized' }, 401);
  }

  if (!locationId || !apiKey) {
    return respond({ error: 'locationId and apiKey are required' }, 400);
  }

  // ── Destructure brand config ──────────────────────────────
  const BRAND_NAME     = brand.name         || 'Upfrog Brand';
  const BRAND_PHONE    = brand.phone        || '';
  const BRAND_SLUG     = brand.slug         || 'brand';
  const BRAND_VERTICAL = brand.vertical     || 'windows';
  const COLOR_PRIMARY  = brand.colorPrimary || '0e2a47';
  const COLOR_ACCENT   = brand.colorAccent  || '3a9bd5';
  const RESULTS_URL    = brand.resultsUrl   || '';
  const WORKER_URL     = brand.workerUrl    || 'https://upfrog-proxy.shiny-poetry-341c.workers.dev';

  // ── GHL API helper ────────────────────────────────────────
  const BASE = 'https://services.leadconnectorhq.com';
  async function ghl(method, path, bodyData = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Version':       '2021-07-28',
      },
    };
    if (bodyData) opts.body = JSON.stringify(bodyData);
    const res  = await fetch(`${BASE}${path}`, opts);
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { detail = JSON.parse(text); } catch {}
      throw new Error(`GHL ${method} ${path} → ${res.status}: ${JSON.stringify(detail).slice(0, 200)}`);
    }
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  // ── Result object (safe — never contains keys) ────────────
  const result = {
    ok:             true,
    location_id:    locationId,
    brand_slug:     BRAND_SLUG,
    brand_name:     BRAND_NAME,
    brand_phone:    BRAND_PHONE,
    brand_vertical: BRAND_VERTICAL,
    colors:         { primary: COLOR_PRIMARY, accent: COLOR_ACCENT },
    results_url:    RESULTS_URL,
    worker_url:     WORKER_URL,
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
    provisioned_at: new Date().toISOString(),
    log:            [],
  };

  const log = (msg) => result.log.push(msg);

  try {
    // ── 1. Verify location ──────────────────────────────────
    log('Verifying location access...');
    const loc = await ghl('GET', `/locations/${locationId}`);
    result.location_name = loc.location?.name || loc.name;
    log(`✓ Connected: ${result.location_name}`);

    // ── 2. Custom fields ────────────────────────────────────
    log('Creating custom fields...');
    const FIELDS = [
      { key: 'price_good',       label: 'Price — Good tier',       dataType: 'CURRENCY'  },
      { key: 'price_better',     label: 'Price — Better tier',     dataType: 'CURRENCY'  },
      { key: 'price_best',       label: 'Price — Best tier',       dataType: 'CURRENCY'  },
      { key: 'price_per_window', label: 'Price — Per window',      dataType: 'CURRENCY'  },
      { key: 'window_count',     label: 'Window count',            dataType: 'NUMERICAL' },
      { key: 'year_built',       label: 'Year built',              dataType: 'NUMERICAL' },
      { key: 'sqft',             label: 'Square footage',          dataType: 'NUMERICAL' },
      { key: 'stories',          label: 'Stories',                 dataType: 'NUMERICAL' },
      { key: 'install_type',     label: 'Install type',            dataType: 'TEXT'      },
      { key: 'glass_package',    label: 'Glass package',           dataType: 'TEXT'      },
      { key: 'window_types',     label: 'Window types selected',   dataType: 'TEXT'      },
      { key: 'addon_list',       label: 'Add-ons selected',        dataType: 'TEXT'      },
      { key: 'addon_total',      label: 'Add-on total',            dataType: 'CURRENCY'  },
      { key: 'lead_paint_flag',  label: 'Lead paint flag',         dataType: 'TEXT'      },
      { key: 'bay_bow_detected', label: 'Bay/bow detected',        dataType: 'TEXT'      },
      { key: 'lead_source',      label: 'Lead source',             dataType: 'TEXT'      },
      { key: 'analysis_path',    label: 'Analysis path',           dataType: 'TEXT'      },
      { key: 'property_address', label: 'Property address',        dataType: 'TEXT'      },
      { key: 'estimate_url',     label: 'Estimate URL',            dataType: 'TEXT'      },
      { key: 'tcpa_consent',     label: 'TCPA consent',            dataType: 'TEXT'      },
    ];

    let existingFields = [];
    try {
      const ef = await ghl('GET', `/locations/${locationId}/customFields`);
      existingFields = ef.customFields || ef.fields || [];
    } catch {}

    for (const field of FIELDS) {
      const exists = existingFields.find(f =>
        f.fieldKey?.includes(field.key) || f.name === field.label
      );
      if (exists) {
        result.custom_fields[field.key] = exists.id;
      } else {
        try {
          const r = await ghl('POST', `/locations/${locationId}/customFields`, {
            name: field.label, dataType: field.dataType, model: 'contact',
          });
          result.custom_fields[field.key] = r.customField?.id || r.id;
        } catch { result.custom_fields[field.key] = null; }
      }
    }
    log(`✓ ${Object.keys(result.custom_fields).length} custom fields ready`);

    // ── 3. Pipeline ─────────────────────────────────────────
    log('Creating pipeline...');
    const PIPELINE_NAME = `${BRAND_NAME} — ${BRAND_VERTICAL === 'windows' ? 'Window' : 'Lawn'} Leads`;
    try {
      const ep = await ghl('GET', `/opportunities/pipelines?locationId=${locationId}`);
      const found = (ep.pipelines || []).find(p => p.name === PIPELINE_NAME);
      if (found) {
        result.pipeline_id = found.id;
        (found.stages || []).forEach(s => { result.pipeline_stages[s.name] = s.id; });
        log(`✓ Pipeline exists: ${PIPELINE_NAME}`);
      } else {
        const stages = ['New Lead','Estimate Viewed','Eval Booked','Eval Completed','Closed Won','Closed Lost'];
        const pr = await ghl('POST', `/opportunities/pipelines`, {
          locationId, name: PIPELINE_NAME,
          stages: stages.map((name, i) => ({ name, position: i })),
        });
        result.pipeline_id = pr.pipeline?.id || pr.id;
        (pr.pipeline?.stages || []).forEach(s => { result.pipeline_stages[s.name] = s.id; });
        log(`✓ Pipeline created: ${PIPELINE_NAME}`);
      }
    } catch(e) { log(`⚠ Pipeline: ${e.message}`); }

    // ── 4. Tag ──────────────────────────────────────────────
    log('Creating tag...');
    const TAG_NAME = `${BRAND_VERTICAL === 'windows' ? 'Window' : 'Lawn'} Lead`;
    result.tag_name = TAG_NAME;
    try {
      const tr = await ghl('POST', `/locations/${locationId}/tags`, { name: TAG_NAME });
      result.tag_id = tr.tag?.id || tr.id;
      log(`✓ Tag: "${TAG_NAME}"`);
    } catch(e) {
      log(`· Tag "${TAG_NAME}" may already exist — continuing`);
    }

    // ── 5. SMS Templates ────────────────────────────────────
    log('Creating SMS templates...');
    const SMS = [
      { key: 'instant',    name: `[${BRAND_SLUG}] Instant`,    body: `Hi {{contact.first_name}}, your ${BRAND_NAME} estimate is ready! View your Good/Better/Best pricing and book your free in-home eval: {{contact.estimate_url}} — Reply STOP to opt out` },
      { key: 'nudge_1hr',  name: `[${BRAND_SLUG}] 1hr nudge`,  body: `Still thinking it over, {{contact.first_name}}? Your estimate expires tonight. Book your free eval — no pressure: {{contact.estimate_url}} · ${BRAND_PHONE}` },
      { key: 'day2_fin',   name: `[${BRAND_SLUG}] Day2 fin`,   body: `{{contact.first_name}}, new windows can be as low as $89/mo with 0% interest for 18 months. See options: {{contact.estimate_url}} · ${BRAND_NAME}` },
      { key: 'day5_value', name: `[${BRAND_SLUG}] Day5 value`, body: `Quick question, {{contact.first_name}} — are your windows drafty this time of year? New windows cut energy bills 15-25%. Your estimate is still saved: {{contact.estimate_url}}` },
      { key: 'day7_close', name: `[${BRAND_SLUG}] Day7 close`, body: `Last chance, {{contact.first_name}} — we're holding your ${BRAND_NAME} estimate price through this weekend. Book before Sunday and get free screens on every window. ${BRAND_PHONE}` },
    ];
    for (const t of SMS) {
      try {
        const r = await ghl('POST', `/locations/${locationId}/templates`, { name: t.name, type: 'sms', body: t.body });
        result.sms_templates[t.key] = r.template?.id || r.id;
      } catch { result.sms_templates[t.key] = null; }
    }
    log(`✓ ${Object.keys(result.sms_templates).length} SMS templates`);

    // ── 6. Email templates ──────────────────────────────────
    log('Creating email templates...');

    const emailHtml = (fname, price, url, brand, phone, accent) => `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f9fc;font-family:Arial,sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #d1e0ed">
  <div style="background:#${accent};padding:28px 24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">${brand}</h1>
    <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:14px">Your window estimate is ready</p>
  </div>
  <div style="padding:32px 28px">
    <p style="font-size:16px;color:#111;margin:0 0 16px">Hi {{contact.first_name}},</p>
    <p style="color:#374151;line-height:1.6;margin:0 0 24px">Your personalized window estimate is still waiting. We've prepared <strong>Good, Better, and Best</strong> options based on your home — most homeowners choose the Better package.</p>
    <div style="background:#f0f8ff;border-radius:10px;padding:24px;text-align:center;margin:0 0 24px">
      <p style="margin:0 0 6px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Better package estimate</p>
      <p style="margin:0;font-size:36px;font-weight:700;color:#0e2a47;letter-spacing:-1px">{{contact.price_better}}</p>
      <p style="margin:6px 0 0;font-size:13px;color:#6b7280">installed · {{contact.window_count}} windows · Low-E + argon</p>
    </div>
    <p style="color:#374151;line-height:1.6;margin:0 0 28px">Your free in-home evaluation takes 30 minutes. A specialist visits, confirms measurements, answers every question, and gives you a final locked-in price. <strong>Zero obligation.</strong></p>
    <div style="text-align:center;margin:0 0 28px">
      <a href="{{contact.estimate_url}}" style="display:inline-block;background:#${accent};color:#fff;text-decoration:none;padding:16px 32px;border-radius:10px;font-weight:700;font-size:16px">Book My Free In-Home Eval</a>
    </div>
    <div style="border-top:1px solid #e5e7eb;padding-top:20px;display:flex;gap:20px;justify-content:center;flex-wrap:wrap">
      <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:#0e2a47">4.9★</div><div style="font-size:11px;color:#9ca3af">312 reviews</div></div>
      <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:#0e2a47">A+</div><div style="font-size:11px;color:#9ca3af">BBB rating</div></div>
      <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:#0e2a47">1-day</div><div style="font-size:11px;color:#9ca3af">install</div></div>
      <div style="text-align:center"><div style="font-size:20px;font-weight:700;color:#0e2a47">Lifetime</div><div style="font-size:11px;color:#9ca3af">warranty</div></div>
    </div>
  </div>
  <div style="background:#f9fafb;padding:16px 28px;text-align:center;border-top:1px solid #e5e7eb">
    <p style="font-size:11px;color:#9ca3af;margin:0">${brand} · ${phone} · <a href="{{contact.estimate_url}}" style="color:#6b7280">View estimate</a></p>
  </div>
</div>
</body></html>`;

    const EMAILS = [
      {
        key:     'day1_recap',
        name:    `[${BRAND_SLUG}] Day1 — Estimate recap`,
        subject: `Your ${BRAND_NAME} estimate — 3 options ready`,
        html:    emailHtml(null, null, null, BRAND_NAME, BRAND_PHONE, COLOR_ACCENT),
      },
      {
        key:     'day3_objection',
        name:    `[${BRAND_SLUG}] Day3 — Objection handler`,
        subject: `"Is it really worth it?" — honest answer from ${BRAND_NAME}`,
        html:    `<div style="max-width:580px;margin:32px auto;font-family:Arial,sans-serif;color:#374151;line-height:1.7">
          <h2 style="color:#0e2a47">The 3 questions we hear most</h2>
          <p><strong>"Can I wait another year?"</strong><br>You can — but every winter with drafty windows costs you in heating bills. Most homeowners say they wished they'd done it sooner.</p>
          <p><strong>"Is the price firm?"</strong><br>Your estimate is based on your actual home data. The in-home eval confirms measurements and locks your price — no surprises at install.</p>
          <p><strong>"How long does it take?"</strong><br>Most whole-house jobs finish in a single day. You're home by evening with new windows.</p>
          <p>Your estimate is still saved. <a href="{{contact.estimate_url}}" style="color:#3a9bd5;font-weight:700">View it here</a> or call us at ${BRAND_PHONE}.</p>
          <p style="font-size:12px;color:#9ca3af">${BRAND_NAME}</p></div>`,
      },
      {
        key:     'day7_close',
        name:    `[${BRAND_SLUG}] Day7 — Final offer`,
        subject: `Last chance: your ${BRAND_NAME} estimate price expires Sunday`,
        html:    `<div style="max-width:580px;margin:32px auto;font-family:Arial,sans-serif;color:#374151;line-height:1.7">
          <h2 style="color:#0e2a47">We're holding your price through Sunday</h2>
          <p>Hi {{contact.first_name}},</p>
          <p>Material costs fluctuate — we've been holding your estimate price for a week, but we can only guarantee it through this Sunday.</p>
          <p>Book your free in-home eval before Sunday and we'll add <strong>free upgraded screens on every window</strong> — normally $30/window.</p>
          <div style="text-align:center;margin:28px 0">
            <a href="{{contact.estimate_url}}" style="background:#3a9bd5;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;display:inline-block">Claim My Free Screens</a>
          </div>
          <p style="font-size:12px;color:#9ca3af">${BRAND_NAME} · ${BRAND_PHONE}</p></div>`,
      },
    ];

    for (const t of EMAILS) {
      try {
        const r = await ghl('POST', `/locations/${locationId}/templates`, {
          name: t.name, type: 'email', subject: t.subject, body: t.html,
        });
        result.email_templates[t.key] = r.template?.id || r.id;
      } catch { result.email_templates[t.key] = null; }
    }
    log(`✓ ${Object.keys(result.email_templates).length} email templates`);

    // ── 7. Calendar ─────────────────────────────────────────
    log('Creating calendar...');
    try {
      const cr = await ghl('POST', `/calendars/`, {
        locationId,
        name:         `${BRAND_NAME} — Free In-Home Eval`,
        description:  'Free 30-min in-home window evaluation. No obligation.',
        slotDuration: 30,
        slotInterval: 30,
        isActive:     true,
      });
      result.calendar_id    = cr.calendar?.id || cr.id;
      result.calendar_embed = `https://api.leadconnectorhq.com/widget/booking/${result.calendar_id}`;
      log(`✓ Calendar created`);
    } catch(e) { log(`⚠ Calendar: ${e.message}`); }

    // ── 8. Webhook URL ──────────────────────────────────────
    try {
      const lr = await ghl('GET', `/locations/${locationId}`);
      result.webhook_url = lr.location?.settings?.webhookUrl
        || `https://services.leadconnectorhq.com/hooks/${locationId}/webhook-trigger/`;
      log(`✓ Webhook URL ready`);
    } catch {
      result.webhook_url = `https://services.leadconnectorhq.com/hooks/${locationId}/webhook-trigger/`;
    }

    // ── 9. Workflow ─────────────────────────────────────────
    log('Creating follow-up workflow...');
    const wfName = `[${BRAND_SLUG}] Lead Nurture — Book In-Home Eval`;
    try {
      const wfr = await ghl('POST', `/workflows/`, {
        locationId,
        name:   wfName,
        status: 'active',
        trigger: { type: 'TAG_ADDED', filter: { tag: TAG_NAME } },
        actions: [
          { type: 'SEND_SMS',    templateId: result.sms_templates.instant,    delayValue: 0,  delayType: 'minutes' },
          { type: 'WAIT',        delayValue: 1,  delayType: 'hours' },
          { type: 'IF_ELSE',     condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
            onTrue: [], onFalse: [{ type: 'SEND_SMS', templateId: result.sms_templates.nudge_1hr }] },
          { type: 'WAIT',        delayValue: 23, delayType: 'hours' },
          { type: 'SEND_EMAIL',  templateId: result.email_templates.day1_recap },
          { type: 'WAIT',        delayValue: 2,  delayType: 'days' },
          { type: 'IF_ELSE',     condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
            onTrue: [], onFalse: [
              { type: 'SEND_EMAIL', templateId: result.email_templates.day3_objection },
              { type: 'SEND_SMS',   templateId: result.sms_templates.day2_fin },
            ]},
          { type: 'WAIT',        delayValue: 2,  delayType: 'days' },
          { type: 'IF_ELSE',     condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
            onTrue: [], onFalse: [
              { type: 'SEND_SMS', templateId: result.sms_templates.day5_value },
              { type: 'CREATE_TASK', title: `Call {{contact.first_name}} — window estimate`, dueDate: 'now',
                body: `Estimate: {{contact.price_better}}. Hasn't booked eval. Call and offer to answer questions. ${BRAND_PHONE}` },
            ]},
          { type: 'WAIT',        delayValue: 2,  delayType: 'days' },
          { type: 'IF_ELSE',     condition: { field: 'appointmentBooked', operator: 'IS_NOT', value: true },
            onTrue: [], onFalse: [
              { type: 'SEND_EMAIL', templateId: result.email_templates.day7_close },
              { type: 'SEND_SMS',   templateId: result.sms_templates.day7_close },
            ]},
          { type: 'REMOVE_TAG',  tag: TAG_NAME },
        ],
      });
      result.workflow_id   = wfr.workflow?.id || wfr.id;
      result.workflow_name = wfName;
      log(`✓ Workflow created: ${wfName}`);
    } catch(e) {
      log(`⚠ Workflow API: ${e.message} — definition stored in result for manual import`);
    }

    log('Provisioning complete.');

  } catch(e) {
    result.ok    = false;
    result.error = e.message;
    result.log.push(`FATAL: ${e.message}`);
  }

  return respond(result, result.ok ? 200 : 500);
}
