-- Ejecutar una vez en Supabase > SQL Editor.
-- Las fotos son privadas: cada usuario solo puede acceder a su propia carpeta.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('garment-images', 'garment-images', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 8388608,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Users upload their garment images" on storage.objects;
create policy "Users upload their garment images"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'garment-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users read their garment images" on storage.objects;
create policy "Users read their garment images"
on storage.objects for select to authenticated
using (
  bucket_id = 'garment-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users update their garment images" on storage.objects;
create policy "Users update their garment images"
on storage.objects for update to authenticated
using (
  bucket_id = 'garment-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'garment-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Users delete their garment images" on storage.objects;
create policy "Users delete their garment images"
on storage.objects for delete to authenticated
using (
  bucket_id = 'garment-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
