-- Mimicry — database schema
--
-- Run this once: Supabase → SQL Editor → New query → paste → Run.
-- It is safe to run again; nothing here drops data.
--
-- Until now the runner kept everything in JSON files on its own disk, which is
-- fine on one machine and impossible anywhere else. Vercel's filesystem is
-- read-only and its functions are ephemeral, so a deployed site had nowhere to
-- remember an automation, a subscription or a receipt. This is that somewhere,
-- reachable by both halves.
--
-- Accounts are untouched: Supabase's own `auth.users` remains the source of
-- truth for who people are. This is only the things they own.

-- ── one table, holding documents ────────────────────────────────────────────
--
-- Not eight typed tables, deliberately.
--
-- The records stored here are the same objects the file-backed store writes,
-- and the schema that defines them is already Zod, in `packages/schema`.
-- Mirroring every field into columns would mean two definitions of each record
-- kept in step by hand — and the first time they drift is the first time a
-- receipt reaches a screen with a field missing. One JSON document per record
-- keeps a single definition and makes the two storage backends incapable of
-- disagreeing about what a record is.
--
-- `owner_id` is lifted out of the document because row-level security needs a
-- column to compare against. It stays inside the document as well: the document
-- is the record, and a copy with a field removed is a different object.

create table if not exists public.records (
  collection  text        not null,
  id          text        not null,
  owner_id    uuid        references auth.users on delete cascade,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists records_collection_idx on public.records (collection);
create index if not exists records_owner_idx      on public.records (owner_id);

-- Marketplace listings and published automations are read on a page anyone can
-- open, so they are looked up by more than their id.
create index if not exists records_visibility_idx
  on public.records ((data ->> 'visibility'))
  where collection = 'automations';

-- ── row-level security ──────────────────────────────────────────────────────
--
-- Enabled with no permissive policy, which means: nothing reaches this table
-- with the anon key that ships in the browser. Every read and write goes
-- through the server — the runner, or the site's own API routes — using the
-- service role, which bypasses RLS and is never sent to a browser.
--
-- This is deliberately stricter than granting the signed-in user access to
-- their own rows. The data here includes payment records, and the server is
-- already the only thing that writes them; letting the browser read the table
-- directly would widen the surface for no feature anyone asked for.

alter table public.records enable row level security;

-- Belt and braces: revoke the API roles' table grants as well, so the table is
-- closed even if a permissive policy is ever added by accident.
revoke all on public.records from anon, authenticated;
