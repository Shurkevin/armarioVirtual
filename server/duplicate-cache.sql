-- Ejecutar una vez en Supabase > SQL Editor.
-- Caché persistente de comparaciones visuales de prendas, aislada por usuario.

create table if not exists public.garment_comparison_cache (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  saved_garment_id uuid references public.garments(id) on delete cascade,
  candidate_hash text not null,
  saved_hash text not null,
  candidate_digest text not null,
  saved_digest text not null,
  model text not null,
  retry_model text not null default '',
  thinking_level text not null,
  prompt_version text not null,
  result jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, candidate_digest, saved_digest, model, retry_model, thinking_level, prompt_version)
);

create index if not exists garment_comparison_cache_lookup_idx
  on public.garment_comparison_cache(user_id, candidate_digest, saved_digest, expires_at desc);

alter table public.garment_comparison_cache enable row level security;

drop policy if exists "Users manage their comparison cache" on public.garment_comparison_cache;
create policy "Users manage their comparison cache"
on public.garment_comparison_cache for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
