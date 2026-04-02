# Upfrog — GHL Brand Provisioner (Netlify)

Provisions a GHL location with everything needed for an Upfrog vertical:
custom fields, pipeline, tags, SMS/email templates, calendar, and the full
nurture workflow — in one click.

---

## Deploy to Netlify (5 minutes)

### 1. Push this folder to a GitHub repo

```bash
git init
git add .
git commit -m "Upfrog provisioner"
gh repo create upfrog-provisioner --private --push
```

### 2. Connect to Netlify

- Go to app.netlify.com → Add new site → Import from Git
- Select your repo
- Build command: (leave blank)
- Publish directory: `public`
- Functions directory: `netlify/functions`
- Click Deploy

### 3. Set environment variables

In Netlify → Site settings → Environment variables, add:

| Variable         | Value                        |
|------------------|------------------------------|
| `UPFROG_SECRET`  | Any strong random string you generate. This is your dashboard password — only share with people who should have access. |

That's it. No API keys in env vars — the dashboard collects them per-session and sends them directly to GHL. Nothing is stored on the server.

### 4. Visit your Netlify URL

You'll see the provisioner dashboard. Fill in:
- Dashboard secret (the UPFROG_SECRET you set)
- GHL private integration key (from GHL → Settings → Integrations → Private Apps)
- GHL Location ID
- Brand config

Click **Provision** and watch the log. At the end you get a full config JSON
to paste back to Claude to wire up the sizer + results pages.

---

## What gets created per brand

| Thing              | Details                                          |
|--------------------|--------------------------------------------------|
| 20 custom fields   | All pricing, property, and lead data fields      |
| 1 pipeline         | 6 stages: New → Viewed → Booked → Done → Won/Lost|
| 1 tag              | "Window Lead" (triggers the workflow)            |
| 5 SMS templates    | Instant, 1hr nudge, Day 2 financing, Day 5 value, Day 7 close |
| 3 email templates  | Day 1 recap, Day 3 objection handler, Day 7 final offer |
| 1 calendar         | Free In-Home Eval, 30-min slots                  |
| 1 workflow         | 7-day nurture sequence, stops when eval booked   |
| Webhook URL        | Retrieved and returned in config output          |

## Security notes

- The dashboard secret prevents unauthorized access
- API keys are never logged, stored, or persisted — they travel directly to GHL in memory
- The output JSON contains only GHL resource IDs, never credentials
- Deploy the site with Netlify's password protection for an extra layer if needed

## Adding a new vertical

The provisioner works for any vertical. Just change BRAND_VERTICAL in the form —
the templates, tags, and pipeline names adjust automatically.

## File structure

```
netlify-provisioner/
├── netlify.toml              — Netlify config
├── netlify/
│   └── functions/
│       └── provision.js      — Serverless function (runs GHL API calls)
└── public/
    └── index.html            — Dashboard UI
```
