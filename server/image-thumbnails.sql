-- Ejecutar una vez en Supabase > SQL Editor antes de publicar esta versión.
-- Las filas antiguas mantienen thumbnail_path a null y usan la imagen principal.

alter table public.garments
  add column if not exists thumbnail_path text;

alter table public.outfits
  add column if not exists thumbnail_path text;
