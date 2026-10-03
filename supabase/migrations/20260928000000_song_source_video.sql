-- Nahrane MP4 jako zdroj videa pro skladbu.
--
-- Uživatel může místo statického obrázku nahrát krátké video (typicky 5-10 s).
-- Render z něj udělá smyčku přes celou délku skladby, takže výsledek není
-- slideshow a není v něm slideshow náhrada — je to opakující se skutečný pohyb.

alter table sc_songs
  add column if not exists source_video_path text,
  add column if not exists source_video_uploaded_at timestamptz;

comment on column sc_songs.source_video_path is
  'Cesta k nahranému MP4 (userId/videos/...). Kdyz je, render udela smycku misto parallaxu z obrazku.';

-- Bucket drzel 50 MB (limit zalozeny jen na obrazky a zvuk). Video na skladbu
-- potrebuje vetsi limit, jinak by appce dovolila 200 MB a storage by odmohl.
update storage.buckets
   set file_size_limit = 200 * 1024 * 1024
 where id = 'songcraft';

-- Render si pamatuje, z ceho byl udelan (pro audit a pro prihlaseni stavu).
alter table agent_videos
  add column if not exists source_video_path text;

comment on column agent_videos.source_video_path is
  'Zdroj: nahrane MP4 uzivatelem (mode loop_video) nebo cesta z bucketu.';

-- Vlastnictvi a bezpecnost: cesta musi patrit vlastnikovi, ne smit napiste
-- ven a nesmi obsahovat presmykovani.
do $$
declare
  policy_row record;
begin
  if to_regclass('storage.objects') is null then return; end if;
  for policy_row in
    select polname, pg_get_expr(polqual, polrelid) as qual
      from pg_policy where polrelid = 'storage.objects'::regclass
  loop
    if policy_row.qual like '%video%' then
      execute format('drop policy %I on storage.objects', policy_row.polname);
    end if;
  end loop;
end $$;

-- Cesty pod /videos/ ridi vlastnik stejne jako ostatni slozky jeho prefixu.
alter table sc_songs enable row level security;

-- Stejne vlastnictvi jako u ostatnich uctovych cest: dalsi cesty nepovolime.
-- Parametr se NESMI jmenovat 'user': to je rezervovane slovo v PostgreSQL a
-- migrace s 'user uuid' spadla na 42601, takze se nikdy neaplikovala.
create or replace function sc_owned_storage_path(p_user uuid, p text)
returns boolean language sql stable as $$
  select p is not null
    and p <> ''
    and p not like '%..%'
    and p not like '\\%'
    and p not like '/%'
    and (p = p_user::text or p like p_user::text || '/%');
$$;

comment on function sc_owned_storage_path(uuid, text) is
  'Cesta pod prefixem ownera. Pouzivaji ji sloupce cover_path a source_video_path.';
