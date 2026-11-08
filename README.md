# 🔗 LinkLocator

Self-hosted link tracker and shortener with click analytics, geolocation, GPS tracking, SMS sending, and Street View.

## Features

- **Short links** — Create tracked short links with custom slugs
- **Click analytics** — Track IP, location, referrer, device for every click
- **IP geolocation** — ipgeolocation.io (primary) + ip-api.com (fallback), 1hr cache
- **GPS tracking** — Browser geolocation on click (Redirect mode) or continuous tracking (Embed mode)
- **Embed mode** — Destination loads in iframe while parent tracks GPS position continuously
- **Location pings** — Continuous GPS pings stored per click, viewable in dashboard
- **SMS sending** — Send links via SMS: SignalWire, Telnyx, Vonage, or custom webhook
- **Street View** — Click any location coordinate to see Google Street View
- **Analytics dashboard** — Clicks by day, country, city; recent clicks; GPS accuracy indicators
- **Supabase backend** — Postgres with RLS, RPC functions for analytics

## Quick Start

### 1. Set up Supabase

Create a project at [supabase.com](https://supabase.com) and run the migration:

```bash
supabase init
supabase link --project-ref your-project-ref
supabase db push
```

Or paste `supabase/migrations/20261108000000_initial.sql` into the SQL Editor.

### 2. Configure environment

```bash
cp .env.example .env
```

Required:
- `SUPABASE_URL` — Your Supabase project URL
- `SUPABASE_SERVICE_KEY` — Service role key (bypasses RLS for server-side)

Recommended:
- `GEO_API_KEY` — [ipgeolocation.io](https://ipgeolocation.io) API key for accurate IP geolocation

### 3. Run

```bash
npm install
node server.js
```

Open `http://localhost:3000` for the dashboard.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/links` | Create a short link |
| `GET` | `/api/links` | List all links with click counts |
| `GET` | `/api/links/:slug` | Get link detail + analytics |
| `PATCH` | `/api/links/:slug/toggle` | Toggle active/paused |
| `DELETE` | `/api/links/:slug` | Delete link + click data |
| `POST` | `/api/click` | Record a click (called by interstitial) |
| `POST` | `/api/ping` | Record GPS ping (embed mode) |
| `POST` | `/api/links/:slug/sms` | Send link via SMS |
| `GET` | `/api/sms/status` | Check SMS provider configuration |
| `GET` | `/api/whoami` | Debug: show your IP + geo |
| `GET` | `/api/health` | Health check |
| `GET` | `/:slug` | Interstitial page (redirects or embeds) |

## Tracking Modes

### Redirect (default)
Interstitial page tries browser GPS → records click → JavaScript redirect to destination.

### Embed + GPS
Destination loads in a full-screen iframe. Parent frame runs `watchPosition` and sends GPS pings every N seconds via `/api/ping`. Pings pause when tab is hidden and resume when visible.

> **Note:** Embed mode only works for destinations that allow iframing. Sites with `X-Frame-Options: DENY/SAMEORIGIN` or `CSP: frame-ancestors 'none'` will block the iframe. LinkLocator checks this at creation time and warns you.

## SMS Providers

Set `SMS_PROVIDER` to one of:

| Provider | Env Vars Required |
|----------|-------------------|
| `signalwire` (default) | `SIGNALWIRE_SPACE`, `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, `SMS_FROM` |
| `telnyx` | `TELNYX_API_KEY`, `SMS_FROM` |
| `vonage` | `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `SMS_FROM` |
| `webhook` | `SMS_WEBHOOK_URL` |

## Deploy to Railway

1. Push to GitHub
2. Connect repo in Railway
3. Set env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEO_API_KEY` (and SMS vars if needed)
4. Deploy — nixpacks auto-detects Node.js

## Database Schema

| Table | Columns |
|-------|---------|
| `links` | id, slug, destination, label, tracking_mode, gps_interval, max_pings, created_at, active |
| `clicks` | id, link_id, ip, referrer, user_agent, country, region, city, lat, lon, isp, gps_accuracy, clicked_at |
| `location_pings` | id, click_id, lat, lon, accuracy, pinged_at |

## Security

- Security headers (CSP, HSTS, X-Frame-Options, etc.)
- Slug validation: alphanumeric + hyphens/underscores only, max 64 chars
- Reserved slugs: `api`, `health`, `links`, `sms`, `whoami`, `click`, `favicon`, `robots`
- Link count cap: 1000
- SMS recipient cap: 50 per request
- E.164 phone validation
- Destination URL validation (http/https only, no self-referential)
- XSS prevention in interstitial HTML
- Supabase RLS policies (anon: read active links + insert clicks/pings)

## License

MIT
