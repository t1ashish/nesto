-- Nesto engine migration 001: ingest columns + fuzzy-dedup review queue
-- Run ONCE in the Supabase SQL editor (Database > SQL), or via `supabase db push`.
-- Safe to re-run: every statement is IF NOT EXISTS.

begin;

-- 1. Ingest provenance columns on listings
alter table public.listings
  add column if not exists ingest_source      text,
  add column if not exists ingest_external_id text,
  add column if not exists public_visibility  boolean not null default false,
  add column if not exists claimed_at         timestamptz,
  add column if not exists ingest_raw         jsonb not null default '{}'::jsonb;

-- One source row maps to at most one listing (lets re-runs update instead of duplicate)
create unique index if not exists listings_ingest_dedup_idx
  on public.listings (ingest_source, ingest_external_id)
  where ingest_external_id is not null;

-- 2. Backfill: the existing 28 listings are hand-built seeds, already public
update public.listings
  set ingest_source = 'manual',
      public_visibility = true
  where ingest_source is null;

-- 3. Review queue for fuzzy name+town matches (admin-only: RLS on, no public policies;
--    service_role used by Edge Functions bypasses RLS)
create table if not exists public.ingest_review_queue (
  id                  uuid primary key default gen_random_uuid(),
  ingest_source       text not null,
  ingest_external_id  text,
  candidate_name      text not null,
  candidate_town      text,
  candidate_phone     text,
  possible_duplicate_id uuid references public.listings(id) on delete set null,
  match_reason        text,
  ingest_raw          jsonb not null default '{}'::jsonb,
  status              text not null default 'pending'
                      check (status in ('pending','approved','rejected','merged')),
  created_at          timestamptz not null default now(),
  decided_at          timestamptz
);

alter table public.ingest_review_queue enable row level security;

create index if not exists ingest_review_queue_status_idx
  on public.ingest_review_queue (status);

commit;
