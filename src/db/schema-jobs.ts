/**
 * Tables for the job marketplace (jobs people post, bids on them, messages, no-show fees).
 * Its own file so that work can add tables without touching schema.ts, which appends this to SCHEMA_SQL.
 * Plain Postgres, idempotent (create … if not exists): the same text runs on the embedded database and on
 * a real Postgres through node-postgres. All SQL that reads or writes these tables is in src/jobs/repo.ts.
 *
 * Money is integer cents (bigint), rates are parts per million (integer). Every row that belongs to a
 * person goes when their account goes (on delete cascade). Three things stay, on purpose:
 *   jobs.winner_id      set to null: when a winner deletes their account the poster keeps the job and its history.
 *   job_fees            the ledger outlives both the payer and the job. payer_id is set to null (payer_ref and
 *                       payer_name keep who it was) and job_id is a plain id with no foreign key, so a fee that
 *                       was recorded is never erased by somebody deleting an account.
 *   job_tombstones      one line for the people who were waiting on a job whose poster deleted their account.
 * The whole deletion is ONE statement: deleteAccount() in src/jobs/repo.ts.
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
  -- 'bidder_left': the winner deleted their account while the job was awarded or agreed (no fee for anyone)
  outcome              text check (outcome is null or outcome in
                       ('no_bids', 'bidder_no_show', 'bidder_backed_out', 'poster_no_show', 'no_agreement', 'poster_cancelled',
                        'bidder_left')),
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
-- PAYMENTS ARE OFF: status is 'recorded' (or 'waived'); nothing is ever collected.
-- A row is never deleted with an account. When the payer deletes theirs, payer_id becomes null and the row
-- keeps who it was: payer_ref (the account's id, written with the fee) and payer_name (the name on the account
-- at that moment, never the email), with payer_deleted_at. job_id has no foreign key: the row stays when the
-- job's poster deletes their account and the job goes.
create table if not exists job_fees (
  id                  bigserial primary key,
  job_id              text not null,
  kind                text not null check (kind in ('no_show', 'service')),
  payer_id            text references accounts(id) on delete set null,
  basis_cents         bigint not null,
  rate_ppm            integer not null,
  amount_cents        bigint not null,
  poster_share_ppm    integer not null,
  poster_share_cents  bigint not null,
  platform_cents      bigint not null,
  status              text not null default 'recorded' check (status in ('recorded', 'waived')),
  created_at          timestamptz not null,
  waived_at           timestamptz,
  payer_ref           text,
  payer_name          text,
  payer_deleted_at    timestamptz,
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

-- What is left of a job whose poster deleted their account, for each person who was waiting on it: the winner
-- of an awarded or agreed job, and everyone with a sealed bid on an open one. The job row itself is gone (it
-- cascades with the poster's account); this is the one line GET /api/jobs/:id answers them with (410).
-- amount_cents is that person's own bid. fee_waived_cents: a service fee that had been recorded for the
-- winner of an agreed job and was waived by the deletion (the one who stayed owes nothing).
create table if not exists job_tombstones (
  job_id            text not null,
  account_id        text not null references accounts(id) on delete cascade,
  role              text not null check (role in ('winner', 'bidder')),
  title             text not null,
  was               text not null check (was in ('open', 'awarded', 'agreed')),
  amount_cents      bigint,
  fee_waived_cents  bigint,
  ended_at          timestamptz not null,
  primary key (job_id, account_id)
);
create index if not exists job_tombstones_account_idx on job_tombstones (account_id, ended_at desc);

-- ------------------------------------------------- upgrades in place --
-- A database made before account deletion existed (2026-11-14) has job_fees rows that cascade with the payer
-- and with the job, and an outcome list without 'bidder_left'. Each step below changes such a database once
-- and finds nothing to do afterwards (and on a new database), so the schema stays safe to run at every start.
alter table job_fees add column if not exists payer_ref text;
alter table job_fees add column if not exists payer_name text;
alter table job_fees add column if not exists payer_deleted_at timestamptz;
alter table job_fees alter column payer_id drop not null;
do $upgrade$
declare c record;
begin
  -- job_fees: no foreign key may delete a ledger row. Drop every cascading one, then make sure the payer's
  -- (set null) is there.
  for c in select conname from pg_constraint
           where conrelid = 'job_fees'::regclass and contype = 'f' and confdeltype = 'c' loop
    execute format('alter table job_fees drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'job_fees'::regclass and contype = 'f' and confrelid = 'accounts'::regclass) then
    alter table job_fees add constraint job_fees_payer_id_fkey foreign key (payer_id) references accounts(id) on delete set null;
  end if;
  -- jobs.outcome: the list of endings gained 'bidder_left'. Drop the old list, then make sure the new one is there.
  for c in select conname from pg_constraint
           where conrelid = 'jobs'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%bidder_backed_out%' and pg_get_constraintdef(oid) not like '%bidder_left%' loop
    execute format('alter table jobs drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%bidder_left%') then
    alter table jobs add constraint jobs_outcome_check check (outcome is null or outcome in
      ('no_bids', 'bidder_no_show', 'bidder_backed_out', 'poster_no_show', 'no_agreement', 'poster_cancelled', 'bidder_left'));
  end if;
end
$upgrade$;
update job_fees set payer_ref = payer_id where payer_ref is null and payer_id is not null;
`;
