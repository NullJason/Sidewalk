create extension if not exists pgcrypto;

create table if not exists public.sidewalk_plans (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sidewalk_events (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.sidewalk_plans(id) on delete cascade,
  title text not null,
  location text not null,
  description text not null,
  time text not null default 'Flexible',
  fit text not null default '',
  lat double precision,
  lon double precision,
  source text not null default 'gemini' check (source in ('gemini','db','csv'))
);

create table if not exists public.sidewalk_quests (
  id uuid primary key default gen_random_uuid(),
  prompt text,
  title text not null,
  location text not null,
  description text not null,
  time text not null default 'Flexible',
  fit text not null default '',
  lat double precision,
  lon double precision
);

create index if not exists sidewalk_plans_created_at_idx
  on public.sidewalk_plans(created_at desc);

create index if not exists sidewalk_events_plan_id_idx
  on public.sidewalk_events(plan_id);

alter table public.sidewalk_plans enable row level security;
alter table public.sidewalk_events enable row level security;
alter table public.sidewalk_quests enable row level security;

-- Public read/write is intentionally NOT granted here.
-- Add narrow RLS policies matching your application's auth model.
-- For a public demo, a server-side endpoint is safer for writes.
