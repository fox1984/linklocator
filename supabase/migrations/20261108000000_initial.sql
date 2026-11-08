-- LinkLocator Supabase Migration
-- Run: supabase db push  or  supabase migration up

-- Links table
create table if not exists links (
  id bigint generated always as identity primary key,
  slug text unique not null,
  destination text not null,
  label text,
  tracking_mode text not null default 'redirect' check (tracking_mode in ('redirect', 'embed')),
  gps_interval integer not null default 30 check (gps_interval >= 5 and gps_interval <= 3600),
  max_pings integer not null default 100 check (max_pings >= 0 and max_pings <= 10000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Clicks table
create table if not exists clicks (
  id bigint generated always as identity primary key,
  link_id bigint not null references links(id) on delete cascade,
  ip text,
  referrer text,
  user_agent text,
  country text,
  region text,
  city text,
  lat double precision,
  lon double precision,
  isp text,
  gps_accuracy double precision,
  clicked_at timestamptz not null default now()
);

-- Location pings table (embed mode GPS trail)
create table if not exists location_pings (
  id bigint generated always as identity primary key,
  click_id bigint not null references clicks(id) on delete cascade,
  lat double precision not null check (lat >= -90 and lat <= 90),
  lon double precision not null check (lon >= -180 and lon <= 180),
  accuracy double precision,
  pinged_at timestamptz not null default now()
);

-- Indexes for analytics queries
create index if not exists idx_clicks_link on clicks(link_id);
create index if not exists idx_clicks_at on clicks(clicked_at);
create index if not exists idx_pings_click on location_pings(click_id);

-- ─── Row Level Security ──────────────────────────────────────────

alter table links enable row level security;
alter table clicks enable row level security;
alter table location_pings enable row level security;

-- Public: can read active links (needed for interstitial redirect/embed)
create policy "Public read active links"
  on links for select
  to anon
  using (active = true);

-- Public: can insert clicks (interstitial POSTs click data)
create policy "Public insert clicks"
  on clicks for insert
  to anon
  with check (true);

-- Public: can insert location pings
create policy "Public insert pings"
  on location_pings for insert
  to anon
  with check (true);

-- Authenticated: full access to all tables (dashboard admin)
create policy "Auth full links"
  on links for all
  to authenticated
  using (true)
  with check (true);

create policy "Auth full clicks"
  on clicks for all
  to authenticated
  using (true)
  with check (true);

create policy "Auth full pings"
  on location_pings for all
  to authenticated
  using (true)
  with check (true);

-- ─── Views for analytics ─────────────────────────────────────────

-- Link list with click counts (used by dashboard)
create or replace view links_with_counts as
  select
    l.*,
    (select count(*) from clicks c where c.link_id = l.id) as click_count
  from links l;

-- ─── Functions ────────────────────────────────────────────────────

-- Get click stats for a link
create or replace function link_stats(p_link_id bigint)
returns json as $$
  select coalesce(json_build_object(
    'total', count(*),
    'unique_ips', count(distinct ip),
    'first_click', min(clicked_at),
    'last_click', max(clicked_at)
  ), '{"total":0,"unique_ips":0,"first_click":null,"last_click":null}'::json)
  from clicks where link_id = p_link_id;
$$ language sql stable;

-- Clicks grouped by day
create or replace function clicks_by_day(p_link_id bigint)
returns table(day text, count bigint) as $$
  select to_char(clicked_at, 'YYYY-MM-DD')::text as day, count(*)::bigint as count
  from clicks where link_id = p_link_id
  group by day order by day desc limit 30;
$$ language sql stable;

-- Clicks grouped by country
create or replace function clicks_by_country(p_link_id bigint)
returns table(country text, count bigint) as $$
  select country, count(*)::bigint as count
  from clicks where link_id = p_link_id and country is not null
  group by country order by count desc limit 15;
$$ language sql stable;

-- Clicks grouped by city
create or replace function clicks_by_city(p_link_id bigint)
returns table(city text, region text, country text, count bigint) as $$
  select city, region, country, count(*)::bigint as count
  from clicks where link_id = p_link_id and city is not null
  group by city, region, country order by count desc limit 15;
$$ language sql stable;

-- Location pings for a link
create or replace function link_pings(p_link_id bigint)
returns table(id bigint, click_id bigint, lat double precision, lon double precision, accuracy double precision, pinged_at timestamptz) as $$
  select lp.id, lp.click_id, lp.lat, lp.lon, lp.accuracy, lp.pinged_at
  from location_pings lp
  join clicks c on lp.click_id = c.id
  where c.link_id = p_link_id
  order by lp.pinged_at asc;
$$ language sql stable;
