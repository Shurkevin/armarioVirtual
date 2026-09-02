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
  taken_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.outfit_garments (
  outfit_id uuid not null references public.outfits(id) on delete cascade,
  garment_id uuid not null references public.garments(id) on delete cascade,
  primary key (outfit_id, garment_id)
);

create table if not exists public.garment_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  garment_id uuid not null references public.garments(id) on delete cascade,
  outfit_id uuid references public.outfits(id) on delete set null,
  used_at timestamptz not null default now()
);

create index if not exists garments_user_id_idx on public.garments(user_id);
create index if not exists outfits_user_id_idx on public.outfits(user_id);
create index if not exists usage_garment_id_idx on public.garment_usage_events(garment_id);

alter table public.garments enable row level security;
alter table public.outfits enable row level security;
alter table public.outfit_garments enable row level security;
alter table public.garment_usage_events enable row level security;

create policy "Users manage their garments" on public.garments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their outfits" on public.outfits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage outfit garments" on public.outfit_garments
  for all using (exists (select 1 from public.outfits o where o.id = outfit_id and o.user_id = auth.uid()))
  with check (exists (select 1 from public.outfits o where o.id = outfit_id and o.user_id = auth.uid()));
create policy "Users manage their usage events" on public.garment_usage_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
