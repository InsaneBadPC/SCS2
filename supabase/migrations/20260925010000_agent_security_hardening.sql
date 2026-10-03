-- Bezpečnostní hardening tabulek Temney agenta (RLS, audit, serverové render sloupce, user-prefix cest).
--
-- Zásady:
--   * youtube_credentials = výhradně service role (klient nečte, neopravuje, nesmí přepsat token),
--   * agent_action_log    = append-only audit; klient si přečte jen vlastní řádky, zápis je server-only,
--   * agent_videos        = klient smí jen číst; render_status/storage_path/output_path jsou serverové,
--   * storage cesty       = každá nová nebo změněná cesta musí začínat prefixem user_id,
--   * ostatní agent tabulky = kanonické per-operation policy místo dosavadních FOR ALL.
--
-- Bezpečné pro opakované spuštění a nedestruktivní: žádný DELETE/TRUNCATE/DROP TABLE,
-- žádná změna dat. Existující legacy řádky nejsou proti novým invariantům validovány
-- (NOT VALID constrainty + triggery, které se ptají jen na INSERT a na změnu konkrétního sloupce).
--
-- Výsledná matice policy pro client role (anon/authenticated):
--   tabulka                | SELECT | INSERT | UPDATE | DELETE
--   agent_settings         | own    | own    | own    | own      (klient mění jen auto_publish)
--   agent_conversations    | own    | own    | own    | own
--   agent_messages         | own    | own    | own    | own
--   agent_recommendations  | own    | own    | own    | own      (klient mění stav doporučení)
--   agent_media_uploads    | own    | own    | own    | own
--   agent_channel_stats    | own    | -      | -      | -        server-only zápis
--   agent_content_calendar | own    | -      | -      | -        server-only zápis
--   agent_image_assets     | own    | -      | -      | -        server-only zápis
--   agent_videos           | own    | -      | -      | -        server-only zápis + guard trigger
--   youtube_publications   | own    | -      | -      | -        server-only zápis (publish potvrzuje server)
--   youtube_stats          | own    | -      | -      | -        server-only zápis
--   youtube_credentials    | -      | -      | -      | -        pouze service role
--   agent_action_log       | own    | -      | -      | -        append-only trigger (UPDATE/DELETE/TRUNCATE)
--
-- service_role má navíc explicitní `for all` policy jako pojistka pro případ, že by role
-- neobcházela RLS (BYPASSRLS). Bezpečnostní invarianty se na konci ověřují asserty, které
-- pozdější migrace nemůže tiše rozbít.

-- ---------------------------------------------------------------------------
-- 0) Pomocné funkce (idempotentní, fungují na Supabase i na čisté Postgres)
-- ---------------------------------------------------------------------------

begin;

-- Role, která aktuálně provádí SQL: auth.role(), jinak JWT claim, jinak current_user.
-- Když se role nepovede zjistit, vrací se nesmysl, takže ochrana funguje fail-closed.
create or replace function public.songcraft_actor_role() returns text
language plpgsql stable as $$
declare
  actor text;
begin
  begin
    if to_regclass('auth.users') is not null and to_regprocedure('auth.role()') is not null then
      actor := auth.role();
    end if;
  exception when others then
    actor := null;
  end;
  if actor is null or actor = '' then
    actor := nullif(current_setting('request.jwt.claim.role', true), '');
  end if;
  if actor is null or actor = '' then
    begin
      actor := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
    exception when others then
      actor := null;
    end;
  end if;
  if actor is null or actor = '' then
    actor := current_user;
  end if;
  return actor;
end $$;

comment on function public.songcraft_actor_role() is
  'Role aktuálně provádějící SQL (auth.role() / JWT claim / current_user) pro serverové guardy.';

-- Považuje storage cestu za přípustnou, pokud je NULL, nebo patří do prefixu ownera.
create or replace function public.songcraft_path_allowed(owner_id uuid, path_value text) returns boolean
language sql immutable as $$
  select path_value is null
     or (owner_id is not null
         and path_value like owner_id::text || '/%'
         and position('..' in path_value) = 0
         and length(path_value) between 1 and 1024
         and path_value !~ '[[:cntrl:]]');
$$;

comment on function public.songcraft_path_allowed(uuid, text) is
  'TRUE, když je storage cesta NULL, nebo začíná prefixem user_id a neobsahuje traversal/řídicí znaky.';

-- Slabší varianta pro sloupce, které mohou obsahovat i URL (např. thumbnail_path).
create or replace function public.songcraft_path_sane(path_value text) returns boolean
language sql immutable as $$
  select path_value is null
     or (path_value !~ '^/'
         and position('..' in path_value) = 0
         and length(path_value) between 1 and 1024
         and path_value !~ '[[:cntrl:]]');
$$;

comment on function public.songcraft_path_sane(text) is
  'TRUE, když je cesta NULL, nebo je relativní a neobsahuje traversal/řídicí znaky.';

-- Smaže všechny policy na tabulce, které nejsou určené pro service_role.
create or replace function public.songcraft_drop_client_policies(target text) returns void
language plpgsql as $$
declare
  rel regclass := to_regclass(target);
  service_oids oid[];
  pol record;
begin
  if rel is null then return; end if;
  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';
  for pol in select polname as policyname, polroles from pg_policy where polrelid = rel loop
    if pol.polroles && service_oids then continue; end if;
    execute format('drop policy if exists %I on %s', pol.policyname, rel);
  end loop;
end $$;

-- Kanonická per-operation policy s vlastnickou podmínkou; jméno se odvodí z tabulky.
-- USING patří jen SELECT/UPDATE/DELETE, WITH CHECK jen INSERT/UPDATE.
create or replace function public.songcraft_set_own_policy(target text, command_name text) returns void
language plpgsql as $$
declare
  rel regclass := to_regclass(target);
  role_clause text := case when exists (select 1 from pg_roles where rolname = 'authenticated') then ' to authenticated' else '' end;
  policy_name text;
begin
  if rel is null then return; end if;
  policy_name := rel::regclass::text || ' ' || command_name || ' own rows';
  execute format('drop policy if exists %I on %s', policy_name, rel);
  if command_name = 'insert' then
    execute format('create policy %I on %s for insert%s with check (auth.uid() = user_id)', policy_name, rel, role_clause);
  elsif command_name = 'update' then
    execute format('create policy %I on %s for update%s using (auth.uid() = user_id) with check (auth.uid() = user_id)', policy_name, rel, role_clause);
  else
    execute format('create policy %I on %s for %s%s using (auth.uid() = user_id)', policy_name, rel, command_name, role_clause);
  end if;
end $$;

-- Pojistka pro případ, že by service_role neobcházela RLS (BYPASSRLS).
create or replace function public.songcraft_set_service_policy(target text) returns void
language plpgsql as $$
declare
  rel regclass := to_regclass(target);
  policy_name text;
begin
  if rel is null or not exists (select 1 from pg_roles where rolname = 'service_role') then return; end if;
  policy_name := rel::regclass::text || ' service role';
  execute format('drop policy if exists %I on %s', policy_name, rel);
  execute format('create policy %I on %s for all to service_role using (true) with check (true)', policy_name, rel);
end $$;

-- Idempotentní přidání user-prefix CHECK constraintu bez validace existujících řádků.
create or replace function public.songcraft_add_path_constraint(target text, constraint_name text, column_name text) returns void
language plpgsql as $$
declare
  rel regclass := to_regclass(target);
begin
  if rel is null then return; end if;
  if exists (select 1 from pg_constraint where conname = constraint_name and conrelid = rel) then return; end if;
  execute format(
    'alter table %s add constraint %I check (public.songcraft_path_allowed(user_id, %I)) not valid',
    rel, constraint_name, column_name
  );
end $$;

-- ---------------------------------------------------------------------------
-- 1) RLS zapnuté všude (idempotentní) a service_role policy jako pojistka
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'agent_settings', 'agent_conversations', 'agent_messages', 'agent_recommendations',
    'agent_action_log', 'agent_image_assets', 'agent_videos', 'agent_media_uploads',
    'agent_channel_stats', 'agent_content_calendar', 'youtube_publications',
    'youtube_stats', 'youtube_credentials'
  ] loop
    if to_regclass('public.' || table_name) is null then continue; end if;
    execute format('alter table public.%I enable row level security', table_name);
    perform public.songcraft_set_service_policy('public.' || table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Kanonické per-operation policy (nahrazují FOR ALL se stejnou vlastnickou podmínkou)
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  -- Klient u těchto tabulek opravdu zapisuje (settings, stav doporučení, chat, uploady).
  foreach table_name in array array[
    'agent_settings', 'agent_conversations', 'agent_messages', 'agent_recommendations', 'agent_media_uploads'
  ] loop
    perform public.songcraft_drop_client_policies('public.' || table_name);
    perform public.songcraft_set_own_policy('public.' || table_name, 'select');
    perform public.songcraft_set_own_policy('public.' || table_name, 'insert');
    perform public.songcraft_set_own_policy('public.' || table_name, 'update');
    perform public.songcraft_set_own_policy('public.' || table_name, 'delete');
  end loop;

  -- Stav řízený serverem: klient jen čte.
  foreach table_name in array array[
    'agent_action_log', 'agent_image_assets', 'agent_videos', 'agent_channel_stats',
    'agent_content_calendar', 'youtube_publications', 'youtube_stats'
  ] loop
    perform public.songcraft_drop_client_policies('public.' || table_name);
    perform public.songcraft_set_own_policy('public.' || table_name, 'select');
  end loop;

  -- youtube_credentials: žádná client policy vůbec (service role obchází RLS).
  perform public.songcraft_drop_client_policies('public.youtube_credentials');
end $$;

-- ---------------------------------------------------------------------------
-- 3) Práva na tabulkách (defense in depth, kdyby RLS někdy nebylo zapnuté)
-- ---------------------------------------------------------------------------

do $$
declare
  role_name text;
begin
  if to_regclass('public.youtube_credentials') is not null and exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.youtube_credentials to service_role';
  end if;
  foreach role_name in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then continue; end if;
    if to_regclass('public.youtube_credentials') is not null then
      execute format('revoke all on public.youtube_credentials from %I', role_name);
    end if;
    if to_regclass('public.agent_action_log') is not null then
      execute format('revoke insert, update, delete, truncate on public.agent_action_log from %I', role_name);
    end if;
    if to_regclass('public.agent_videos') is not null then
      execute format('revoke insert, update, delete, truncate on public.agent_videos from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    if to_regclass('public.agent_action_log') is not null then
      execute 'grant insert, select on public.agent_action_log to service_role';
    end if;
    if to_regclass('public.agent_videos') is not null then
      execute 'grant select, insert, update, delete on public.agent_videos to service_role';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) agent_action_log: append-only audit
--    UPDATE/DELETE/TRUNCATE jsou zablokované pro všechny role. Výjimky:
--      a) kaskáda smazání účtu (auth.users -> agent_action_log on delete cascade),
--      b) explicitní údržba: SET LOCAL songcraft.allow_audit_mutation = 'on'.
-- ---------------------------------------------------------------------------

create or replace function public.agent_action_log_append_only() returns trigger
language plpgsql as $$
begin
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return null;
  end if;
  if coalesce(current_setting('songcraft.allow_audit_mutation', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return null;
  end if;
  raise exception 'agent_action_log je append-only (operace %). Pro údržbu použij SET LOCAL songcraft.allow_audit_mutation = ''on''.', tg_op
    using errcode = '42501';
end $$;

drop trigger if exists agent_action_log_append_only_trg on public.agent_action_log;
create trigger agent_action_log_append_only_trg
  before update or delete on public.agent_action_log
  for each row execute function public.agent_action_log_append_only();

drop trigger if exists agent_action_log_no_truncate_trg on public.agent_action_log;
create trigger agent_action_log_no_truncate_trg
  before truncate on public.agent_action_log
  for each statement execute function public.agent_action_log_append_only();

-- ---------------------------------------------------------------------------
-- 5) agent_videos: render_status a cesty jsou serverové
--    RLS klientovi zápis už nedá; trigger je druhá pojistka pro případ, že někdo
--    později přidá write policy nebo přijde přes jinou cestu.
-- ---------------------------------------------------------------------------

create or replace function public.agent_videos_server_columns() returns trigger
language plpgsql as $$
declare
  actor text := public.songcraft_actor_role();
begin
  if actor in ('service_role', 'supabase_service_role', 'postgres', 'supabase_admin', 'supabase_migrations_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.render_status := 'queued';
    new.storage_path := null;
    new.output_path := null;
    new.audio_storage_path := null;
    new.error_message := null;
    return new;
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'agent_videos.user_id nelze změnit' using errcode = '42501';
  end if;
  if new.render_status is distinct from old.render_status
     or new.storage_path is distinct from old.storage_path
     or new.output_path is distinct from old.output_path
     or new.audio_storage_path is distinct from old.audio_storage_path then
    raise exception 'agent_videos: render_status a storage cesty mění jen server (role %)', actor using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists agent_videos_server_columns_trg on public.agent_videos;
create trigger agent_videos_server_columns_trg
  before insert or update on public.agent_videos
  for each row execute function public.agent_videos_server_columns();

-- ---------------------------------------------------------------------------
-- 6) Storage cesty musí patřit vlastníkovi
--    Triggery se ptají jen na INSERT a na změnu konkrétního sloupce, takže legacy
--    řádek s nestandardní cestou lze dál aktualizovat v jiných sloupcích.
-- ---------------------------------------------------------------------------

create or replace function public.agent_videos_guard_paths() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'agent_videos.user_id nelze změnit' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if not public.songcraft_path_allowed(new.user_id, new.storage_path)
       or not public.songcraft_path_allowed(new.user_id, new.output_path)
       or not public.songcraft_path_allowed(new.user_id, new.audio_storage_path) then
      raise exception 'agent_videos: všechny storage cesty musí začínat prefixem ownera' using errcode = '42501';
    end if;
  else
    if new.storage_path is distinct from old.storage_path
       and not public.songcraft_path_allowed(new.user_id, new.storage_path) then
      raise exception 'agent_videos.storage_path musí začínat prefixem ownera: %', left(new.storage_path, 200) using errcode = '42501';
    end if;
    if new.output_path is distinct from old.output_path
       and not public.songcraft_path_allowed(new.user_id, new.output_path) then
      raise exception 'agent_videos.output_path musí začínat prefixem ownera: %', left(new.output_path, 200) using errcode = '42501';
    end if;
    if new.audio_storage_path is distinct from old.audio_storage_path
       and not public.songcraft_path_allowed(new.user_id, new.audio_storage_path) then
      raise exception 'agent_videos.audio_storage_path musí začínat prefixem ownera: %', left(new.audio_storage_path, 200) using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public.agent_image_assets_guard_paths() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not public.songcraft_path_allowed(new.user_id, new.base_image_path)
       or not public.songcraft_path_allowed(new.user_id, new.final_image_path) then
      raise exception 'agent_image_assets: storage cesty musí začínat prefixem ownera' using errcode = '42501';
    end if;
  else
    if new.base_image_path is distinct from old.base_image_path
       and not public.songcraft_path_allowed(new.user_id, new.base_image_path) then
      raise exception 'agent_image_assets.base_image_path musí začínat prefixem ownera: %', left(new.base_image_path, 200) using errcode = '42501';
    end if;
    if new.final_image_path is distinct from old.final_image_path
       and not public.songcraft_path_allowed(new.user_id, new.final_image_path) then
      raise exception 'agent_image_assets.final_image_path musí začínat prefixem ownera: %', left(new.final_image_path, 200) using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public.agent_media_uploads_guard_paths() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not public.songcraft_path_allowed(new.user_id, new.storage_path) then
      raise exception 'agent_media_uploads.storage_path musí začínat prefixem ownera: %', left(new.storage_path, 200) using errcode = '42501';
    end if;
  elsif new.storage_path is distinct from old.storage_path
        and not public.songcraft_path_allowed(new.user_id, new.storage_path) then
    raise exception 'agent_media_uploads.storage_path musí začínat prefixem ownera: %', left(new.storage_path, 200) using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.youtube_publications_guard_paths() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not public.songcraft_path_sane(new.thumbnail_path) then
      raise exception 'youtube_publications.thumbnail_path je neplatná cesta: %', left(new.thumbnail_path, 200) using errcode = '42501';
    end if;
  elsif new.thumbnail_path is distinct from old.thumbnail_path
        and not public.songcraft_path_sane(new.thumbnail_path) then
    raise exception 'youtube_publications.thumbnail_path je neplatná cesta: %', left(new.thumbnail_path, 200) using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists agent_videos_guard_paths_trg on public.agent_videos;
create trigger agent_videos_guard_paths_trg
  before insert or update on public.agent_videos
  for each row execute function public.agent_videos_guard_paths();

drop trigger if exists agent_image_assets_guard_paths_trg on public.agent_image_assets;
create trigger agent_image_assets_guard_paths_trg
  before insert or update on public.agent_image_assets
  for each row execute function public.agent_image_assets_guard_paths();

drop trigger if exists agent_media_uploads_guard_paths_trg on public.agent_media_uploads;
create trigger agent_media_uploads_guard_paths_trg
  before insert or update on public.agent_media_uploads
  for each row execute function public.agent_media_uploads_guard_paths();

drop trigger if exists youtube_publications_guard_paths_trg on public.youtube_publications;
create trigger youtube_publications_guard_paths_trg
  before insert or update on public.youtube_publications
  for each row execute function public.youtube_publications_guard_paths();

-- NOT VALID CHECK constraints se vyhodnocují při každém UPDATE, takže před jejich
-- založením fail-closed ověříme legacy řádky. Migrace se celá odroluje zpět,
-- pokud je nutné nejdříve přesunout/opravit starou cestu.
do $$
begin
  if exists (
    select 1 from public.agent_videos
     where (storage_path is not null and not public.songcraft_path_allowed(user_id, storage_path))
        or (output_path is not null and not public.songcraft_path_allowed(user_id, output_path))
        or (audio_storage_path is not null and not public.songcraft_path_allowed(user_id, audio_storage_path))
  ) then
    raise exception 'agent_videos obsahuje legacy storage cesty; nejdříve je přesuňte pod user_id prefix a teprve potom aplikujte hardening' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.agent_image_assets
     where (base_image_path is not null and not public.songcraft_path_allowed(user_id, base_image_path))
        or (final_image_path is not null and not public.songcraft_path_allowed(user_id, final_image_path))
  ) then
    raise exception 'agent_image_assets obsahuje legacy storage cesty; nejdříve je přesuňte pod user_id prefix' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.agent_media_uploads
     where storage_path is not null and not public.songcraft_path_allowed(user_id, storage_path)
  ) then
    raise exception 'agent_media_uploads obsahuje legacy storage cesty; nejdříve je přesuňte pod user_id prefix' using errcode = '42501';
  end if;
end $$;

-- Stejný invariant navíc jako NOT VALID CHECK constraint (budoucí DML se hlídá dvakrát,
-- existující legacy řádky validaci neblokují).
select public.songcraft_add_path_constraint('public.agent_videos', 'agent_videos_storage_path_user_prefix', 'storage_path');
select public.songcraft_add_path_constraint('public.agent_videos', 'agent_videos_output_path_user_prefix', 'output_path');
select public.songcraft_add_path_constraint('public.agent_videos', 'agent_videos_audio_storage_path_user_prefix', 'audio_storage_path');
select public.songcraft_add_path_constraint('public.agent_image_assets', 'agent_image_assets_base_path_user_prefix', 'base_image_path');
select public.songcraft_add_path_constraint('public.agent_image_assets', 'agent_image_assets_final_path_user_prefix', 'final_image_path');
select public.songcraft_add_path_constraint('public.agent_media_uploads', 'agent_media_uploads_storage_path_user_prefix', 'storage_path');

-- ---------------------------------------------------------------------------
-- 7) Pre-flight report: kolik existujících řádků nesplňuje nový invariant.
--    Pouze hlášení, žádná data se nemění.
-- ---------------------------------------------------------------------------

do $$
declare
  offenders bigint;
begin
  if to_regclass('public.agent_videos') is not null then
    select count(*) into offenders from public.agent_videos
     where storage_path is not null and not public.songcraft_path_allowed(user_id, storage_path);
    if offenders > 0 then
      raise warning 'agent_videos: % řádků má storage_path mimo prefix ownera; nový zápis takové cesty bude odmítnut', offenders;
    end if;
    select count(*) into offenders from public.agent_videos
     where output_path is not null and not public.songcraft_path_allowed(user_id, output_path);
    if offenders > 0 then
      raise warning 'agent_videos: % řádků má output_path mimo prefix ownera', offenders;
    end if;
    select count(*) into offenders from public.agent_videos
     where audio_storage_path is not null and not public.songcraft_path_allowed(user_id, audio_storage_path);
    if offenders > 0 then
      raise warning 'agent_videos: % řádků má audio_storage_path mimo prefix ownera', offenders;
    end if;
  end if;
  if to_regclass('public.agent_image_assets') is not null then
    select count(*) into offenders from public.agent_image_assets
     where (base_image_path is not null and not public.songcraft_path_allowed(user_id, base_image_path))
        or (final_image_path is not null and not public.songcraft_path_allowed(user_id, final_image_path));
    if offenders > 0 then
      raise warning 'agent_image_assets: % řádků má cestu mimo prefix ownera', offenders;
    end if;
  end if;
  if to_regclass('public.agent_media_uploads') is not null then
    select count(*) into offenders from public.agent_media_uploads
     where storage_path is not null and not public.songcraft_path_allowed(user_id, storage_path);
    if offenders > 0 then
      raise warning 'agent_media_uploads: % řádků má storage_path mimo prefix ownera', offenders;
    end if;
  end if;
  raise notice 'Pre-flight cest hotov. Legacy řádky se nemění, ale nový zápis cesty mimo prefix ownera bude odmítnut. Kontrola: select user_id, storage_path, output_path, audio_storage_path from public.agent_videos where storage_path is not null and not public.songcraft_path_allowed(user_id, storage_path) limit 20;';
end $$;

-- ---------------------------------------------------------------------------
-- 8) SQL assertions: bezpečnostní invarianty se po migraci ověří a při rozpadu selžou
-- ---------------------------------------------------------------------------

do $$
declare
  rel regclass;
  leaked text;
  service_oids oid[];
  guard record;
begin
  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';

  -- youtube_credentials nesmí mít žádnou policy pro client role
  rel := to_regclass('public.youtube_credentials');
  if rel is not null then
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      raise exception 'youtube_credentials: role service_role v databázi chybí';
    end if;
    select string_agg(pol.polname, ', ' order by pol.polname) into leaked
      from pg_policy pol
     where pol.polrelid = rel and not (pol.polroles && service_oids);
    if leaked is not null then
      raise exception 'youtube_credentials vystavuje client policy: %', leaked;
    end if;
  end if;

  -- server-only tabulky nesmí mít write policy pro client role
  foreach rel in array array[
    to_regclass('public.agent_action_log'), to_regclass('public.agent_videos'),
    to_regclass('public.youtube_publications'), to_regclass('public.youtube_stats'),
    to_regclass('public.agent_image_assets'), to_regclass('public.agent_channel_stats'),
    to_regclass('public.agent_content_calendar')
  ] loop
    if rel is null then continue; end if;
    select string_agg(pol.polname, ', ' order by pol.polname) into leaked
      from pg_policy pol
     where pol.polrelid = rel and pol.polcmd <> 'r' and not (pol.polroles && service_oids);
    if leaked is not null then
      raise exception '% vystavuje write policy pro client role: %', rel::text, leaked;
    end if;
  end loop;

  -- security triggery musí existovat na správné tabulce
  for guard in select * from (values
    ('public.agent_action_log'::regclass, 'agent_action_log_append_only_trg'::text),
    ('public.agent_action_log'::regclass, 'agent_action_log_no_truncate_trg'::text),
    ('public.agent_videos'::regclass, 'agent_videos_server_columns_trg'::text),
    ('public.agent_videos'::regclass, 'agent_videos_guard_paths_trg'::text),
    ('public.agent_image_assets'::regclass, 'agent_image_assets_guard_paths_trg'::text),
    ('public.agent_media_uploads'::regclass, 'agent_media_uploads_guard_paths_trg'::text),
    ('public.youtube_publications'::regclass, 'youtube_publications_guard_paths_trg'::text)
  ) as required_trigger(tbl, trg) loop
    if not exists (select 1 from pg_trigger where tgrelid = guard.tbl and tgname = guard.trg and not tgisinternal) then
      raise exception 'chybí security trigger % na %', guard.trg, guard.tbl::text;
    end if;
  end loop;

  -- kompatibilita: read cesty, které používá klient, musí zůstat otevřené
  foreach rel in array array[
    to_regclass('public.agent_recommendations'), to_regclass('public.youtube_publications'),
    to_regclass('public.agent_videos'), to_regclass('public.agent_settings'),
    to_regclass('public.agent_action_log')
  ] loop
    if rel is null then continue; end if;
    if not exists (select 1 from pg_policy where polrelid = rel and polcmd = 'r') then
      raise exception '%: chybí SELECT policy pro klienta', rel::text;
    end if;
  end loop;

  -- kompatibilita: klient musí dál umět zapsat to, co dnes zapisuje
  foreach rel in array array[
    to_regclass('public.agent_settings'), to_regclass('public.agent_recommendations'),
    to_regclass('public.agent_media_uploads'), to_regclass('public.agent_messages')
  ] loop
    if rel is null then continue; end if;
    if not exists (select 1 from pg_policy where polrelid = rel and polcmd = 'a')
       or not exists (select 1 from pg_policy where polrelid = rel and polcmd = 'w') then
      raise exception '%: chybí INSERT/UPDATE policy, kterou klient používá', rel::text;
    end if;
  end loop;

  -- RLS musí být zapnutá všude, kde jsou citlivá data
  foreach rel in array array[
    to_regclass('public.youtube_credentials'), to_regclass('public.agent_action_log'),
    to_regclass('public.agent_videos'), to_regclass('public.youtube_publications')
  ] loop
    if rel is null then continue; end if;
    if not exists (select 1 from pg_class where oid = rel and relrowsecurity) then
      raise exception '%: row level security není zapnutá', rel::text;
    end if;
  end loop;
end $$;

commit;
