-- Nahrávání obalů, klipů a MP3 nešlo: "Storage object MIME type is not allowed"
--
-- Nalezeno živým testem na produkci (testovací účet, skutečný JWT, nahraj
-- 1x1 JPEG): trigger songcraft_storage_object_guard_trg odmítl i image/jpeg a
-- image/png, přestože bucket songcraft tyhle typy v allowed_mime_types má a
-- klient posílá přesně contentType, který serverová validace v lib/storage-paths.ts
-- odfiltrovala jako JPG.
--
-- Příčina: soubor 20260925110000_core_schema_bootstrap.sql byl upraven až po
-- tom, co už byl v databázi aplikovaný. Řádek o aplikované migraci zůstal,
-- takže opravená definice se nikdy nespustila a v živé DB je starší verze
-- funkce s jiným povoleným seznamem.
--
-- Oprava: nová migrace, která funkci vytvoří znovu. Migrace nesmí být
-- editovaná po aplikaci; další změna musí přijít jako nový soubor.

create or replace function public.songcraft_storage_object_guard()
returns trigger
language plpgsql
as $$
declare
  actor text;
  object_mime text;
  object_size bigint;
  allowed_mime constant text[] := array[
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif',
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/wav', 'audio/ogg',
    'video/mp4', 'video/quicktime', 'video/webm',
    'application/zip', 'text/plain',
    'application/octet-stream'
  ];
begin
  if new.bucket_id <> 'songcraft' then return new; end if;

  actor := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), current_user);
  if actor in ('service_role', 'supabase_service_role', 'postgres', 'supabase_admin', 'supabase_migrations_admin') then
    return new;
  end if;

  -- Cesta musí začínat vlastním uid, jinak by šlo zapsat cizí složku.
  if (storage.foldername(new.name))[1] <> auth.uid()::text then
    raise exception 'Storage object path does not belong to the current user' using errcode = '42501';
  end if;

  object_mime := lower(split_part(
    coalesce(new.metadata->>'mimetype', new.metadata->>'content_type', ''), ';', 1));

  -- Prázdný typ se netrestí: povolení má bucket přes allowed_mime_types a
  -- klient navíc v lib/storage-paths.ts typ ověřuje podle bajtů. Když je typ
  -- vyplněný a neznámý, spadá sem.
  if object_mime <> '' and not (object_mime = any (allowed_mime)) then
    raise exception 'Storage object MIME type is not allowed: %', object_mime using errcode = '42501';
  end if;

  -- Bucket má limit 200 MiB, tady držíme rezervu na bezpečné zpracování.
  object_size := nullif(new.metadata->>'size', '')::bigint;
  if object_size is not null and object_size > 180 * 1024 * 1024 then
    raise exception 'Storage object exceeds the size limit' using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists songcraft_storage_object_guard_trg on storage.objects;
create trigger songcraft_storage_object_guard_trg
  before insert or update on storage.objects
  for each row execute function public.songcraft_storage_object_guard();

-- fail-closed kontrola: povolený typ se nesmí v seznamu ztratit
do $$
declare
  missing text;
begin
  select string_agg(t, ', ')
    into missing
    from unnest(array['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'video/mp4']) as t
   where not exists (
     select 1
       from pg_get_functiondef('public.songcraft_storage_object_guard()'::regprocedure) as def
      where def like '%' || quote_literal(t) || '%'
   );
  if missing is not null then
    raise exception 'songcraft_storage_object_guard neobsahuje typy: %', missing;
  end if;
end
$$;

-- Bucket a trigger musí souhlasit. Bucket kontroluje typ dřív (415) než trigger,
-- takže kdyby měl užší seznam, povolený by jen odmítl.
update storage.buckets
   set file_size_limit = 200 * 1024 * 1024,
       allowed_mime_types = array[
         'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif',
         'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/wav', 'audio/ogg',
         'video/mp4', 'video/quicktime', 'video/webm',
         'application/zip', 'text/plain', 'application/octet-stream'
       ]
 where id = 'songcraft';
