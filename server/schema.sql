-- Esquema inicial para Supabase/PostgreSQL.
-- Ejecutar en el SQL Editor de Supabase cuando creemos el proyecto.

create table if not exists public.garments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  custom_name text,
  category text not null,
  subcategory text not null,
  primary_color text not null default '',
  secondary_colors jsonb not null default '[]'::jsonb,
  styles jsonb not null default '[]'::jsonb,
  pattern text not null default '',
  brand text not null default '',
  material_estimate text not null default '',
  fabric_type text not null default '',
  texture text not null default '',
  material_confidence numeric not null default 0,
  confidence numeric not null default 0,
  image_path text not null,
  wear_count integer not null default 1 check (wear_count >= 0),
  scan_fingerprint jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outfits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null,
  evaluation jsonb,
  style_goal text,
  taken_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.outfit_garments (
  outfit_id uuid not null references public.outfits(id) on delete cascade,
  garment_id uuid not null references public.garments(id) on delete cascade,
  item_box jsonb not null default '{"xMin":0,"yMin":0,"xMax":1000,"yMax":1000}'::jsonb,
  display_rotation integer not null default 0,
  confidence numeric not null default 0,
  primary key (outfit_id, garment_id)
);

-- Compatible con instalaciones que ya tenían la tabla creada.
alter table public.outfits add column if not exists style_goal text;
alter table public.outfit_garments add column if not exists item_box jsonb not null default '{"xMin":0,"yMin":0,"xMax":1000,"yMax":1000}'::jsonb;
alter table public.outfit_garments add column if not exists display_rotation integer not null default 0;
alter table public.outfit_garments add column if not exists confidence numeric not null default 0;

create table if not exists public.garment_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  garment_id uuid not null references public.garments(id) on delete cascade,
  outfit_id uuid references public.outfits(id) on delete set null,
  used_at timestamptz not null default now()
);

create table if not exists public.analysis_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  analysis_type text not null default 'outfit',
  status text not null check (status in ('completed', 'failed')),
  client_duration_ms integer not null check (client_duration_ms >= 0),
  preparation_duration_ms integer check (preparation_duration_ms >= 0),
  request_duration_ms integer check (request_duration_ms >= 0),
  network_duration_ms integer check (network_duration_ms >= 0),
  server_duration_ms integer check (server_duration_ms >= 0),
  provider_duration_ms integer check (provider_duration_ms >= 0),
  postprocess_duration_ms integer check (postprocess_duration_ms >= 0),
  image_size_bytes bigint check (image_size_bytes >= 0),
  image_width integer check (image_width >= 0),
  image_height integer check (image_height >= 0),
  comparison_count integer check (comparison_count >= 0),
  comparison_failure_count integer check (comparison_failure_count >= 0),
  cache_hit_count integer check (cache_hit_count >= 0),
  provider_call_count integer check (provider_call_count >= 0),
  provider_attempt_count integer check (provider_attempt_count >= 0),
  fallback_used boolean not null default false,
  http_status integer check (http_status between 100 and 599),
  people_count integer check (people_count >= 0),
  garment_count integer check (garment_count >= 0),
  style_goal text,
  model text,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists garments_user_id_idx on public.garments(user_id);
create index if not exists outfits_user_id_idx on public.outfits(user_id);
create index if not exists usage_garment_id_idx on public.garment_usage_events(garment_id);
create index if not exists analysis_runs_user_created_idx on public.analysis_runs(user_id, created_at desc);

alter table public.garments enable row level security;
alter table public.outfits enable row level security;
alter table public.outfit_garments enable row level security;
alter table public.garment_usage_events enable row level security;
alter table public.analysis_runs enable row level security;

drop policy if exists "Users manage their garments" on public.garments;
create policy "Users manage their garments" on public.garments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage their outfits" on public.outfits;
create policy "Users manage their outfits" on public.outfits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage outfit garments" on public.outfit_garments;
create policy "Users manage outfit garments" on public.outfit_garments
  for all using (exists (select 1 from public.outfits o where o.id = outfit_id and o.user_id = auth.uid()))
  with check (exists (select 1 from public.outfits o where o.id = outfit_id and o.user_id = auth.uid()));
drop policy if exists "Users manage their usage events" on public.garment_usage_events;
create policy "Users manage their usage events" on public.garment_usage_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users insert their analysis runs" on public.analysis_runs;
create policy "Users insert their analysis runs" on public.analysis_runs
  for insert with check (auth.uid() = user_id);
drop policy if exists "Users read their analysis runs" on public.analysis_runs;
create policy "Users read their analysis runs" on public.analysis_runs
  for select using (auth.uid() = user_id);
