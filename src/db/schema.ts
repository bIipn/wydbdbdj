import { JOBS_SCHEMA_SQL } from './schema-jobs.js';
import { PROMO_SCHEMA_SQL } from './schema-promo.js';
import { WORK_SCHEMA_SQL } from './schema-work.js';

/**
 * Plain Postgres. Runs as-is on embedded PGlite (local/dev/tests) and on Supabase.
 * Idempotent — safe to run on every startup.
 */
export const SCHEMA_SQL = /* sql */ `
create table if not exists bids (
  id             text primary key,            -- "<source>:<sourceId>"
  source         text not null,
  source_id      text not null,
  source_name    text not null,
  title          text not null,
  agency         text,
  description    text,
  category       text,
  city           text,
  county         text,
  state          text,
  zip            text,
  lat            double precision,
  lng            double precision,
  loc_precision  text not null default 'unknown',
  loc_label      text,
  posted_at      timestamptz,
  due_at         timestamptz,
  est_min        numeric,
  est_max        numeric,
  naics          text,
  set_aside      text,
  url            text not null,
  flags          jsonb not null default '[]'::jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index if not exists bids_due_idx on bids (due_at);

-- A contractor/business. Today: L&M. Later: every app user's business.
create table if not exists profiles (
  id          text primary key,
  name        text not null,
  prefs       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- How well a bid fits a profile. Re-scored every scan.
create table if not exists matches (
  profile_id   text not null references profiles(id) on delete cascade,
  bid_id       text not null references bids(id) on delete cascade,
  score        integer not null,
  verdict      text not null,
  reasons      jsonb not null,
  distance_mi  double precision,
  scored_at    timestamptz not null default now(),
  notified_at  timestamptz,
  primary key (profile_id, bid_id)
);
create index if not exists matches_feed_idx on matches (profile_id, score desc);

-- Swipe decisions: save (right), pass (left), bid (tapped "Bid on …").
create table if not exists swipes (
  profile_id  text not null references profiles(id) on delete cascade,
  bid_id      text not null references bids(id) on delete cascade,
  action      text not null check (action in ('save', 'pass', 'bid')),
  created_at  timestamptz not null default now(),
  primary key (profile_id, bid_id)
);

create table if not exists scans (
  id           bigserial primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  report       jsonb not null
);

-- ---------------------------------------------------------------- v1 --
-- Sign-in. One account owns one business profile (profiles.account_id).
create table if not exists accounts (
  id             text primary key,
  email          text not null unique,
  name           text,
  password_hash  text,                        -- null for OAuth-only accounts
  plan           text not null default 'free',
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- External sign-in identities (e.g. provider "supabase", subject = their user id).
create table if not exists identities (
  provider    text not null,
  subject     text not null,
  account_id  text not null references accounts(id) on delete cascade,
  primary key (provider, subject)
);

-- Cookie sessions. Only a hash of the token is stored.
create table if not exists sessions (
  token_hash  text primary key,
  account_id  text not null references accounts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- "Forgot password" links (src/auth/reset.ts). Only a SHA-256 of the token is stored, like a session's: a
-- copy of this table cannot be turned back into links. One live link per account (asking again replaces it),
-- good for an hour, used once: used_at is set by the same statement that stores the new password.
create table if not exists password_resets (
  token_hash  text primary key,
  account_id  text not null references accounts(id) on delete cascade,
  created_at  timestamptz not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists password_resets_account_idx on password_resets (account_id);

alter table profiles add column if not exists account_id text references accounts(id) on delete cascade;
create unique index if not exists profiles_account_idx on profiles (account_id) where account_id is not null;
alter table bids add column if not exists sol_number text;
alter table matches add column if not exists over_limit boolean not null default false;

create table if not exists push_subscriptions (
  endpoint     text primary key,
  account_id   text not null references accounts(id) on delete cascade,
  keys         jsonb not null,
  created_at   timestamptz not null default now(),
  last_ok_at   timestamptz,
  fail_count   int not null default 0
);

-- In-app inbox + de-duplication: nothing is ever alerted twice.
create table if not exists alerts (
  id          bigserial primary key,
  profile_id  text not null references profiles(id) on delete cascade,
  kind        text not null,
  bid_id      text,
  dedupe_key  text not null,
  title       text not null,
  body        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  pushed_at   timestamptz,
  read_at     timestamptz,
  unique (profile_id, kind, dedupe_key)
);

-- Real awarded prices, verbatim from the source.
create table if not exists awards (
  id           text primary key,
  source       text not null,
  award_id     text,
  sol_number   text,
  recipient    text,
  amount       numeric,
  action_date  date,
  naics        text,
  psc          text,
  agency       text,
  description  text,
  city         text,
  county       text,
  state        text,
  zip          text,
  lat          double precision,
  lng          double precision,
  url          text,
  fetched_at   timestamptz not null default now()
);
create index if not exists awards_naics_state_idx on awards (naics, state);

-- Published time series (BLS etc.), verbatim values.
create table if not exists market_series (
  series_id  text not null,
  period     text not null,
  value      numeric not null,
  primary key (series_id, period)
);
create table if not exists market_series_meta (
  series_id   text primary key,
  kind        text not null,
  title       text not null,
  area        text,
  unit        text,
  source      text not null,
  source_url  text,
  fetched_at  timestamptz not null default now()
);

create table if not exists estimates (
  id          bigserial primary key,
  profile_id  text not null references profiles(id) on delete cascade,
  bid_id      text,
  inputs      jsonb not null,
  result      jsonb not null,
  created_at  timestamptz not null default now()
);

-- Market data (v1). Federal award prices keep two amounts and never merge them:
--   current_amount  USAspending "Award Amount": net obligated to date, moves with every modification
--   price_at_award  the Mod 0 transaction amount: what the job was signed for
-- awards.id = 'usaspending:' || generated_internal_id, and awards.amount mirrors price_at_award.
alter table awards add column if not exists generated_internal_id text;
alter table awards add column if not exists sub_agency text;
alter table awards add column if not exists naics_description text;
alter table awards add column if not exists psc_description text;
alter table awards add column if not exists award_type text;
alter table awards add column if not exists county_fips text;
alter table awards add column if not exists current_amount numeric;
alter table awards add column if not exists price_at_award numeric;
alter table awards add column if not exists last_modified text;         -- "YYYY-MM-DD HH:MM:SS", no zone, verbatim
alter table awards add column if not exists offers_received integer;    -- detail endpoint, filled lazily
alter table awards add column if not exists date_signed date;           -- detail endpoint, filled lazily
alter table awards add column if not exists detail_fetched_at timestamptz;
alter table awards add column if not exists price_checked_at timestamptz;   -- when its own transaction history was asked for a Mod 0 row
create index if not exists awards_naics_date_idx on awards (naics, action_date);

-- What each complete award pull covered (scope = state code, or 'US' for the whole country), so a
-- price range is only ever labelled "nationwide" when the whole country was loaded.
create table if not exists award_coverage (
  scope         text not null,
  naics         text not null,
  from_date     date not null,
  to_date       date not null,
  refreshed_at  timestamptz not null default now(),
  primary key (scope, naics)
);

-- BLS marks the newest index values preliminary and revises them later.
alter table market_series add column if not exists preliminary boolean not null default false;
-- 'ok', or why the last refresh got nothing for the series: 'not_found' | 'no_data' (+ the publisher's message).
alter table market_series_meta add column if not exists status text not null default 'ok';
alter table market_series_meta add column if not exists note text;
${PROMO_SCHEMA_SQL}
${WORK_SCHEMA_SQL}
${JOBS_SCHEMA_SQL}
`;
