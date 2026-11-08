#!/usr/bin/env node
/**
 * LinkLocator Supabase Seeder
 * Loads demo data: 8 links, ~430 clicks, ~380 location pings
 * 
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node seed.js
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Set SUPABASE_URL and SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const LINKS = [
  { slug: "promo", destination: "https://example.com/spring-sale", label: "Spring Sale Promo", tracking_mode: "redirect", gps_interval: 30, max_pings: 100, active: true },
  { slug: "blog", destination: "https://example.com/blog/new-features", label: "Blog: New Features", tracking_mode: "redirect", gps_interval: 30, max_pings: 100, active: true },
  { slug: "track-me", destination: "https://example.com/live-map", label: "Live Tracker", tracking_mode: "embed", gps_interval: 10, max_pings: 500, active: true },
  { slug: "event", destination: "https://example.com/event-2026", label: "Event Registration", tracking_mode: "redirect", gps_interval: 30, max_pings: 100, active: true },
  { slug: "demo", destination: "https://example.com/demo", label: "Product Demo", tracking_mode: "redirect", gps_interval: 30, max_pings: 100, active: true },
  { slug: "partners", destination: "https://example.com/partners", label: "Partner Portal", tracking_mode: "redirect", gps_interval: 30, max_pings: 100, active: false },
  { slug: "fleet", destination: "https://example.com/fleet-dashboard", label: "Fleet Tracking", tracking_mode: "embed", gps_interval: 15, max_pings: 1000, active: true },
  { slug: "webinar", destination: "https://example.com/webinar", label: "Webinar Sign-up", tracking_mode: "redirect", gps_interval: 30, max_pings: 100, active: true },
];

const CITIES = [
  { city: "Phoenix", region: "Arizona", country: "United States", lat: 33.448, lon: -112.074, isp: "Cox Communications" },
  { city: "Los Angeles", region: "California", country: "United States", lat: 34.052, lon: -118.244, isp: "Spectrum" },
  { city: "New York", region: "New York", country: "United States", lat: 40.713, lon: -74.006, isp: "Verizon" },
  { city: "Chicago", region: "Illinois", country: "United States", lat: 41.878, lon: -87.630, isp: "AT&T" },
  { city: "Denver", region: "Colorado", country: "United States", lat: 39.739, lon: -104.990, isp: "Comcast" },
  { city: "Seattle", region: "Washington", country: "United States", lat: 47.606, lon: -122.332, isp: "CenturyLink" },
  { city: "Miami", region: "Florida", country: "United States", lat: 25.762, lon: -80.192, isp: "AT&T" },
  { city: "Dallas", region: "Texas", country: "United States", lat: 32.777, lon: -96.797, isp: "Spectrum" },
  { city: "London", region: "England", country: "United Kingdom", lat: 51.507, lon: -0.128, isp: "BT Group" },
  { city: "Toronto", region: "Ontario", country: "Canada", lat: 43.653, lon: -79.383, isp: "Bell Canada" },
  { city: "Berlin", region: "Berlin", country: "Germany", lat: 52.520, lon: 13.405, isp: "Deutsche Telekom" },
  { city: "Tokyo", region: "Tokyo", country: "Japan", lat: 35.676, lon: 139.650, isp: "NTT Communications" },
];

const AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];

const REFERRERS = [
  null, null, null, // 50% direct
  "https://twitter.com/", "https://facebook.com/", "https://google.com/",
  "https://linkedin.com/", "https://reddit.com/", "https://instagram.com/",
  "https://mail.google.com/",
];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randPick(arr) { return arr[randInt(0, arr.length - 1)]; }
function randIP() { return `${randInt(1,223)}.${randInt(0,255)}.${randInt(0,255)}.${randInt(1,254)}`; }
function randDate(daysAgo) {
  const now = Date.now();
  const past = now - daysAgo * 86400000;
  return new Date(past + Math.random() * (now - past)).toISOString();
}

async function seed() {
  console.log("🌱 Seeding LinkLocator demo data into Supabase...\n");

  // Clear existing data (in correct order due to FK)
  console.log("  Clearing existing data...");
  await supabase.from("location_pings").delete().neq("id", 0);
  await supabase.from("clicks").delete().neq("id", 0);
  await supabase.from("links").delete().neq("id", 0);

  // Insert links
  console.log("  Creating 8 links...");
  const { data: linkRows, error: linkErr } = await supabase.from("links").insert(LINKS).select();
  if (linkErr) { console.error("  ❌ Link insert error:", linkErr.message); process.exit(1); }
  console.log(`  ✅ ${linkRows.length} links created`);

  // Insert clicks
  console.log("  Creating ~430 clicks...");
  const clicks = [];
  const clicksWithGPS = []; // track which clicks get GPS for pings

  for (const link of linkRows) {
    const count = randInt(30, 80);
    for (let i = 0; i < count; i++) {
      const city = randPick(CITIES);
      const hasGPS = link.tracking_mode === "embed" && Math.random() < 0.6;
      const gpsAcc = hasGPS ? randInt(3, 50) : null;
      clicks.push({
        link_id: link.id,
        ip: randIP(),
        referrer: randPick(REFERRERS),
        user_agent: randPick(AGENTS),
        country: city.country,
        region: city.region,
        city: city.city,
        lat: city.lat + (Math.random() - 0.5) * 0.02,
        lon: city.lon + (Math.random() - 0.5) * 0.02,
        isp: city.isp,
        gps_accuracy: gpsAcc,
        clicked_at: randDate(30),
      });
      if (hasGPS) clicksWithGPS.push({ linkIndex: linkRows.indexOf(link), clickIndex: clicks.length - 1 });
    }
  }

  const { data: clickRows, error: clickErr } = await supabase.from("clicks").insert(clicks).select("id, link_id, gps_accuracy, clicked_at");
  if (clickErr) { console.error("  ❌ Click insert error:", clickErr.message); process.exit(1); }
  console.log(`  ✅ ${clickRows.length} clicks created`);

  // Insert location pings for embed-mode clicks with GPS
  console.log("  Creating ~380 location pings...");
  const pings = [];
  const gpsClicks = clickRows.filter(c => c.gps_accuracy != null);
  for (const click of gpsClicks) {
    const numPings = randInt(3, 15);
    const baseTime = new Date(click.clicked_at);
    for (let i = 0; i < numPings; i++) {
      const city = randPick(CITIES);
      const pingTime = new Date(baseTime.getTime() + i * randInt(5000, 60000));
      pings.push({
        click_id: click.id,
        lat: city.lat + (Math.random() - 0.5) * 0.01,
        lon: city.lon + (Math.random() - 0.5) * 0.01,
        accuracy: randInt(3, 50),
        pinged_at: pingTime.toISOString(),
      });
    }
  }

  if (pings.length > 0) {
    const { error: pingErr } = await supabase.from("location_pings").insert(pings);
    if (pingErr) { console.error("  ❌ Ping insert error:", pingErr.message); process.exit(1); }
    console.log(`  ✅ ${pings.length} location pings created`);
  }

  console.log("\n🎉 Seed complete!");
  console.log(`   Links: ${linkRows.length}`);
  console.log(`   Clicks: ${clickRows.length}`);
  console.log(`   Pings: ${pings.length}`);
}

seed().catch(err => { console.error("Seed error:", err); process.exit(1); });
