-- Ejecutar una sola vez en Supabase > SQL Editor.
-- Añade las coordenadas de cada prenda y el bucket privado de fotos completas.

alter table public.outfit_garments
  add column if not exists item_box jsonb not null default '{"xMin":0,"yMin":0,"xMax":1000,"yMax":1000}'::jsonb;

alter table public.outfit_garments
  add column if not exists display_rotation integer not null default 0;

alter table public.outfit_garments
  add column if not exists confidence numeric not null default 0;

alter table public.garments
  add column if not exists thumbnail_path text;

alter table public.outfits
  add column if not exists thumbnail_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('outfit-images', 'outfit-images', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 8388608,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Users upload their outfit images" on storage.objects;
create policy "Users upload their outfit images"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'outfit-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users read their outfit images" on storage.objects;
create policy "Users read their outfit images"
on storage.objects for select to authenticated
using (
  bucket_id = 'outfit-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users update their outfit images" on storage.objects;
create policy "Users update their outfit images"
on storage.objects for update to authenticated
using (
  bucket_id = 'outfit-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'outfit-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users delete their outfit images" on storage.objects;
create policy "Users delete their outfit images"
on storage.objects for delete to authenticated
using (
  bucket_id = 'outfit-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
