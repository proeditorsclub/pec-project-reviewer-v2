-- PEC Project Reviewer v2 — database setup.
-- Run this ONCE in your Supabase project: SQL Editor → New query → paste → Run.

create table if not exists candidates (
  key           text primary key,          -- stable id: submission id + file id
  submission_id text,
  name          text not null,
  week          text not null,
  video_url     text not null,             -- refreshed on every re-import
  file_name     text,
  is_video      boolean not null default true,
  submitted_at  timestamptz,
  email         text,
  squad         text,

  -- review state (never touched by imports)
  reviewed      boolean not null default false,
  shortlisted   boolean not null default false,
  notes         text not null default '',
  rank          int check (rank between 1 and 3),
  reason        text not null default ''
);

create index if not exists candidates_week_idx on candidates (week);

-- The app uses the public "anon" key, so allow it to read and write.
-- (This tool is for a small trusted team; there is no login step.)
alter table candidates enable row level security;

drop policy if exists "team can read" on candidates;
create policy "team can read" on candidates for select using (true);

drop policy if exists "team can insert" on candidates;
create policy "team can insert" on candidates for insert with check (true);

drop policy if exists "team can update" on candidates;
create policy "team can update" on candidates for update using (true);
