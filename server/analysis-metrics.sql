-- Migración para instalaciones existentes: métricas de duración de los análisis.
-- Ejecutar una vez en el SQL Editor de Supabase.

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
  http_status integer check (http_status between 100 and 599),
  people_count integer check (people_count >= 0),
  garment_count integer check (garment_count >= 0),
  model text,
  request_id text,
  created_at timestamptz not null default now()
);

-- Añade las métricas nuevas si la tabla ya existía.
alter table public.analysis_runs add column if not exists preparation_duration_ms integer check (preparation_duration_ms >= 0);
alter table public.analysis_runs add column if not exists request_duration_ms integer check (request_duration_ms >= 0);
alter table public.analysis_runs add column if not exists network_duration_ms integer check (network_duration_ms >= 0);
alter table public.analysis_runs add column if not exists postprocess_duration_ms integer check (postprocess_duration_ms >= 0);
alter table public.analysis_runs add column if not exists image_size_bytes bigint check (image_size_bytes >= 0);
alter table public.analysis_runs add column if not exists image_width integer check (image_width >= 0);
alter table public.analysis_runs add column if not exists image_height integer check (image_height >= 0);
alter table public.analysis_runs add column if not exists comparison_count integer check (comparison_count >= 0);
alter table public.analysis_runs add column if not exists comparison_failure_count integer check (comparison_failure_count >= 0);
alter table public.analysis_runs add column if not exists cache_hit_count integer check (cache_hit_count >= 0);
alter table public.analysis_runs add column if not exists provider_call_count integer check (provider_call_count >= 0);
alter table public.analysis_runs add column if not exists provider_attempt_count integer check (provider_attempt_count >= 0);

create index if not exists analysis_runs_user_created_idx
  on public.analysis_runs(user_id, created_at desc);

alter table public.analysis_runs enable row level security;

drop policy if exists "Users insert their analysis runs" on public.analysis_runs;
create policy "Users insert their analysis runs" on public.analysis_runs
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users read their analysis runs" on public.analysis_runs;
create policy "Users read their analysis runs" on public.analysis_runs
  for select using (auth.uid() = user_id);

-- Resumen útil para decidir si el análisis debería pasar a segundo plano.
-- percentil_disc muestra una duración observada real de la muestra.
select
  analysis_type,
  count(*) as analyses,
  round(avg(client_duration_ms)) as avg_ms,
  round(avg(preparation_duration_ms)) as avg_preparation_ms,
  round(avg(network_duration_ms)) as avg_network_ms,
  round(avg(provider_duration_ms)) as avg_gemini_ms,
  round(avg(postprocess_duration_ms)) as avg_postprocess_ms,
  percentile_disc(0.50) within group (order by client_duration_ms) as p50_ms,
  percentile_disc(0.90) within group (order by client_duration_ms) as p90_ms,
  max(client_duration_ms) as max_ms,
  sum(comparison_count) as comparisons,
  sum(comparison_failure_count) as comparison_failures,
  sum(cache_hit_count) as cache_hits,
  sum(provider_call_count) as gemini_calls,
  sum(provider_attempt_count) as gemini_attempts,
  round(100.0 * count(*) filter (where status = 'failed') / nullif(count(*), 0), 1) as failure_percent
from public.analysis_runs
where created_at >= now() - interval '30 days'
group by analysis_type
order by analysis_type;
