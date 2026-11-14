/**
 * Tables for the job marketplace (jobs people post, bids on them, messages, no-show fees).
 * Its own file so that work can add tables without touching schema.ts, which appends this to SCHEMA_SQL.
 * Plain Postgres, idempotent (create … if not exists): the same text runs on the embedded database and on
 * a real Postgres through node-postgres. All SQL that reads or writes these tables is in src/jobs/repo.ts.
 *
 * Money is integer cents (bigint), rates are parts per million (integer). Every row that belongs to a
 * person goes when their account goes (on delete cascade). The one exception is jobs.winner_id: when a
 * winner deletes their account the poster keeps the job and its history, so it is set to null instead.
 */
export const JOBS_SCHEMA_SQL = /* sql */ `
create table if not exists jobs (
  id                   text primary key,
  poster_id            text not null references accounts(id) on delete cascade,
  title                text not null,
  description          text not null,
  trades               text[] not null default '{}',
  -- the public place: from the ZIP table, never finer than the ZIP's centre
  zip                  text not null,
  city                 text not null,
  state                text not null,
  lat                  double precision,
  lng                  double precision,
  -- private: the poster always, the winner after the award (src/jobs/view.ts)
  address              text,
  phone                text,
  budget_max_cents     bigint,
  posted_at            timestamptz not null,
  closes_at            timestamptz not null,
  status               text not null default 'open'
                       check (status in ('open', 'awarded', 'agreed', 'completed', 'unfilled', 'cancelled')),
  outcome              text check (outcome is null or outcome in
                       ('no_bids', 'bidder_no_show', 'bidder_backed_out', 'poster_no_show', 'no_agreement', 'poster_cancelled')),
  -- the award (set once, at closing)
  winner_bid_id        bigint,
  winner_id            text references accounts(id) on delete set null,
  award_cents          bigint,
  awarded_at           timestamptz,
  contact_deadline     timestamptz,
  -- the contact window: first message from each side, the poster's "They contacted me", the two "We've agreed"
  bidder_messaged_at   timestamptz,
  poster_messaged_at   timestamptz,
  poster_tapped_at     timestamptz,
  bidder_confirmed_at  timestamptz,
  poster_confirmed_at  timestamptz,
  agreed_at            timestamptz,
  completed_at         timestamptz,
  ended_at             timestamptz,
  reposted_from        text references jobs(id) on delete set null,
  -- an operator took it down: it is gone for everyone (404), the rows stay for the record
  removed_at           timestamptz
);
create index if not exists jobs_poster_idx on jobs (poster_id, posted_at desc);
create index if not exists jobs_open_close_idx on jobs (closes_at) where status = 'open';
create index if not exists jobs_awarded_deadline_idx on jobs (contact_deadline) where status = 'awarded';
-- one live repost per job: two taps on "Post again" (or two requests at once) must not list the job twice
create unique index if not exists jobs_one_repost_idx on jobs (reposted_from) where reposted_from is not null and removed_at is null;

-- One bid per account per job: placing again replaces it (unique), so two taps at once leave one row.
create table if not exists job_bids (
  id            bigserial primary key,
  job_id        text not null references jobs(id) on delete cascade,
  bidder_id     text not null references accounts(id) on delete cascade,
  amount_cents  bigint not null check (amount_cents > 0),
  note          text,
  status        text not null default 'active' check (status in ('active', 'won', 'lost', 'withdrawn', 'defaulted')),
  -- when the current amount was placed: the tie-break ("the bid placed first"). A new amount resets it.
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  unique (job_id, bidder_id)
);
create index if not exists job_bids_bidder_idx on job_bids (bidder_id);

create table if not exists job_messages (
  id          bigserial primary key,
  job_id      text not null references jobs(id) on delete cascade,
  sender_id   text not null references accounts(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null
);
create index if not exists job_messages_job_idx on job_messages (job_id, id);

-- The fee ledger. One row per job and kind (unique): a settlement that runs twice writes one row.
-- Every figure that went into the amount is kept, so it can be worked out again from the row alone.
-- PAYMENTS ARE OFF: status is 'recorded' (or 'waived' by an operator); nothing is ever collected.
create table if not exists job_fees (
  id                  bigserial primary key,
  job_id              text not null references jobs(id) on delete cascade,
  kind                text not null check (kind in ('no_show', 'service')),
  payer_id            text not null references accounts(id) on delete cascade,
  basis_cents         bigint not null,
  rate_ppm            integer not null,
  amount_cents        bigint not null,
  poster_share_ppm    integer not null,
  poster_share_cents  bigint not null,
  platform_cents      bigint not null,
  status              text not null default 'recorded' check (status in ('recorded', 'waived')),
  created_at          timestamptz not null,
  waived_at           timestamptz,
  unique (job_id, kind)
);
create index if not exists job_fees_payer_idx on job_fees (payer_id);

-- "Report this job". One per person per job: reporting again replaces the reason.
create table if not exists job_reports (
  id           bigserial primary key,
  job_id       text not null references jobs(id) on delete cascade,
  reporter_id  text not null references accounts(id) on delete cascade,
  reason       text not null,
  created_at   timestamptz not null,
  unique (job_id, reporter_id)
);
`;
