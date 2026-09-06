-- Migración para instalaciones existentes: métricas de duración de los análisis.
-- Ejecutar una vez en el SQL Editor de Supabase.

create table if not exists public.analysis_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  analysis_type text not null default 'outfit',
  status text not null check (status in ('completed', 'failed')),
  client_duration_ms integer not null check (client_duration_ms >= 0),
  server_duration_ms integer check (server_duration_ms >= 0),
  provider_duration_ms integer check (provider_duration_ms >= 0),
  http_status integer check (http_status between 100 and 599),
  people_count integer check (people_count >= 0),
  garment_count integer check (garment_count >= 0),
  model text,
  request_id text,
  created_at timestamptz not null default now()
);

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
  count(*) as analyses,
  round(avg(client_duration_ms)) as avg_ms,
  percentile_disc(0.50) within group (order by client_duration_ms) as p50_ms,
  percentile_disc(0.90) within group (order by client_duration_ms) as p90_ms,
  max(client_duration_ms) as max_ms,
  round(100.0 * count(*) filter (where status = 'failed') / nullif(count(*), 0), 1) as failure_percent
from public.analysis_runs
where created_at >= now() - interval '30 days';
