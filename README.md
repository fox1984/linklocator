# 🔗 LinkLocator

Self-hosted link tracker & shortener with **IP geolocation**, **GPS fallback**, **SMS sending**, **Street View**, and analytics dashboard.

## Features

- **URL Shortening** — Custom slugs or auto-generated 8-char IDs
- **Click Tracking** — IP, referrer, user-agent on every redirect
- **🌍 Geolocation** — Country, region, city, lat/lon, ISP via ipgeolocation.io (primary) + ip-api.com (fallback, cached 1hr)
- **📍 GPS Fallback** — Browser geolocation with accuracy reporting (3s timeout)
- **📱 SMS Sending** — Send tracked links via text (SignalWire, Telnyx, Vonage, or webhook)
- **Street View** — Google Street View embed for click locations
- **Analytics Dashboard** — Dark-themed UI: by-day/country/city charts, click log
- **Dual Database** — Postgres (production) or SQLite (dev/standalone)
- **Auto BASE_URL** — Detects from request headers, no config needed behind proxies

## Quick Start (local)

```bash
npm install
npm start          # → http://localhost:3000  (SQLite)
```

## Deploy to Railway

### 1. Push to Git

```bash
cd linklocator
git init && git add . && git commit -m "init"
```

### 2. Create Railway project

```bash
# Install CLI
npm i -g @railway/cli

# Login & deploy
railway login
railway init      # Choose "Empty project", give it a name
railway up
```

### 3. Add Postgres

```bash
railway add       # Select "PostgreSQL"
```

Railway auto-sets `DATABASE_URL` — the app detects it and uses Postgres instead of SQLite.

### 4. Set environment variables

```bash
# Geolocation (ipgeolocation.io — more accurate than ip-api.com)
railway variables set GEO_API_KEY=your_ipgeolocation_api_key

# SMS via SignalWire (default provider)
railway variables set SIGNALWIRE_SPACE=your-space
railway variables set SIGNALWIRE_PROJECT_ID=your-project-id
railway variables set SIGNALWIRE_API_TOKEN=your-api-token
railway variables set SMS_FROM=+1XXXXXXXXXX

# Optional: custom domain
railway variables set BASE_URL=https://links.yourdomain.com
```

### 5. Open it

```bash
railway open
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Railway sets this automatically) |
| `DATABASE_URL` | — | Postgres connection string. If set → Postgres. If not → SQLite. |
| `BASE_URL` | auto-detected | Base URL for short links. If empty, auto-detects from `X-Forwarded-Proto` + `Host` headers. |
| `DATA_DIR` | `.` | Directory for SQLite file (only used with SQLite) |
| `GEO_API_KEY` | — | ipgeolocation.io API key (primary geo provider). Falls back to free ip-api.com if unset. |
| `SMS_PROVIDER` | `signalwire` | SMS provider: `signalwire`, `telnyx`, `vonage`, or `webhook` |
| `SMS_FROM` | — | Sender phone number (e.g. `+1XXXXXXXXXX`) |

### SignalWire (default)

| Variable | Description |
|----------|-------------|
| `SIGNALWIRE_SPACE` | Your SignalWire space name |
| `SIGNALWIRE_PROJECT_ID` | Project ID |
| `SIGNALWIRE_API_TOKEN` | API token |

### Telnyx

| Variable | Description |
|----------|-------------|
| `TELNYX_API_KEY` | API key |

### Vonage

| Variable | Description |
|----------|-------------|
| `VONAGE_API_KEY` | API key |
| `VONAGE_API_SECRET` | API secret |

### Webhook

| Variable | Description |
|----------|-------------|
| `SMS_WEBHOOK_URL` | URL to POST `{from, to, text}` to |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/links` | Create link: `{destination, slug?, label?}` |
| `GET` | `/api/links` | List all links with click counts |
| `GET` | `/api/links/:slug` | Detail + analytics (by_country, by_city, by_day, recent_clicks) |
| `PATCH` | `/api/links/:slug/toggle` | Pause / resume |
| `DELETE` | `/api/links/:slug` | Delete link + all click data |
| `POST` | `/api/links/:slug/sms` | Send link via SMS: `{numbers, message?}` |
| `GET` | `/api/sms/status` | SMS provider status |
| `GET` | `/api/whoami` | Debug: shows your IP + geo resolution |
| `GET` | `/api/health` | Health check: `{status, db, uptime}` |
| `GET` | `/:slug` | Redirect + record click (interstitial with GPS) |

## Architecture

```
Request → /:slug → interstitial HTML → try GPS (3s timeout)
                                       → sendBeacon /api/click
                                       → JS redirect to destination
                       ↓ (async, non-blocking)
                  geo lookup (ipgeolocation.io → ip-api.com fallback, cached 1hr)
                       ↓
                  INSERT click (ip, geo, ua, referrer, gps_accuracy)
```

Geo lookup and click recording happen **after** the redirect is sent — zero latency impact on the visitor.
