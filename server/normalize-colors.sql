-- Normaliza los colores históricos con el mismo vocabulario canónico que la app.
-- Ejecutar una vez en el SQL Editor de Supabase.

create or replace function pg_temp.canonical_garment_color(value text)
returns text
language plpgsql
immutable
as $$
declare
  result text := lower(trim(coalesce(value, '')));
begin
  result := regexp_replace(result, '\m(beis|beises|beiges)\M', 'beige', 'gi');
  result := regexp_replace(result, '\m(blanca|blancas|blancos)\M', 'blanco', 'gi');
  result := regexp_replace(result, '\m(negra|negras|negros)\M', 'negro', 'gi');
  result := regexp_replace(result, '\m(roja|rojas|rojos)\M', 'rojo', 'gi');
  result := regexp_replace(result, '\m(amarilla|amarillas|amarillos)\M', 'amarillo', 'gi');
  result := regexp_replace(result, '\m(morada|moradas|morados)\M', 'morado', 'gi');
  result := regexp_replace(result, '\m(dorada|doradas|dorados)\M', 'dorado', 'gi');
  result := regexp_replace(result, '\m(plateada|plateadas|plateados)\M', 'plateado', 'gi');
  result := regexp_replace(result, '\m(rosada|rosadas|rosado|rosados|rosas)\M', 'rosa', 'gi');
  result := regexp_replace(result, '\m(marron|marrones|cafe|cafes|café|cafés)\M', 'marrón', 'gi');
  result := regexp_replace(result, '\mazules\M', 'azul', 'gi');
  result := regexp_replace(result, '\mverdes\M', 'verde', 'gi');
  result := regexp_replace(result, '\mgrises\M', 'gris', 'gi');
  result := regexp_replace(result, '\mnaranjas\M', 'naranja', 'gi');
  result := regexp_replace(result, '\mvioletas\M', 'violeta', 'gi');
  result := regexp_replace(result, '\mlilas\M', 'lila', 'gi');
  result := regexp_replace(result, '\mturquesas\M', 'turquesa', 'gi');
  result := regexp_replace(result, '\mgranates\M', 'granate', 'gi');
  result := regexp_replace(result, '\mcremas\M', 'crema', 'gi');
  result := regexp_replace(result, '\mmarfiles\M', 'marfil', 'gi');
  result := regexp_replace(result, '\mocres\M', 'ocre', 'gi');
  result := regexp_replace(result, '\molivas\M', 'oliva', 'gi');
  result := regexp_replace(result, '\mcorales\M', 'coral', 'gi');
  result := regexp_replace(result, '\mmostazas\M', 'mostaza', 'gi');
  result := regexp_replace(result, '\mterracotas\M', 'terracota', 'gi');
  result := regexp_replace(result, '\m(salmon|salmones)\M', 'salmón', 'gi');
  result := regexp_replace(result, '\maguamarinas\M', 'aguamarina', 'gi');
  result := regexp_replace(result, '\m(cobriza|cobrizas|cobrizos)\M', 'cobrizo', 'gi');
  result := regexp_replace(result, '\m(purpura|purpuras|púrpura|púrpuras|purple)\M', 'morado', 'gi');
  result := regexp_replace(result, '\mcyan\M', 'cian', 'gi');
  result := regexp_replace(result, '\m(borgona|borgoña|burgundy)\M', 'burdeos', 'gi');
  result := regexp_replace(result, '\m(kaki|kakis|khaki|khakis|caquis)\M', 'caqui', 'gi');
  result := regexp_replace(result, '\m(fuchsia|fuchsias|fucsias)\M', 'fucsia', 'gi');
  result := regexp_replace(result, '\m(grey|gray)\M', 'gris', 'gi');
  result := regexp_replace(result, '\mnavy\M', 'azul marino', 'gi');
  return result;
end;
$$;

update public.garments
set
  primary_color = pg_temp.canonical_garment_color(primary_color),
  secondary_colors = coalesce((
    select jsonb_agg(pg_temp.canonical_garment_color(color))
    from jsonb_array_elements_text(secondary_colors) as colors(color)
  ), '[]'::jsonb),
  scan_fingerprint = case
    when scan_fingerprint ? 'primaryColor' then jsonb_set(
      scan_fingerprint,
      '{primaryColor}',
      to_jsonb(pg_temp.canonical_garment_color(scan_fingerprint->>'primaryColor'))
    )
    else scan_fingerprint
  end,
  updated_at = now()
where
  primary_color is distinct from pg_temp.canonical_garment_color(primary_color)
  or exists (
    select 1
    from jsonb_array_elements_text(secondary_colors) as colors(color)
    where color is distinct from pg_temp.canonical_garment_color(color)
  )
  or coalesce(scan_fingerprint->>'primaryColor', '') is distinct from
    pg_temp.canonical_garment_color(coalesce(scan_fingerprint->>'primaryColor', ''));
