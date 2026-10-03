-- Reproducible core schema bootstrap.
-- The first production deployment was created from JSON query snapshots, so a
-- clean Supabase project did not contain all tables used by the application.
-- Everything here is additive/idempotent; it never deletes application data.

begin;

create extension if not exists pgcrypto;

create table if not exists public.sc_albums (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 255),
  description text,
  release_year integer check (release_year between 1900 and 2200),
  cover_path text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_lyrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  album_id uuid references public.sc_albums(id) on delete set null,
  title text not null check (char_length(title) between 1 and 255),
  style_prompt text,
  lyrics text,
  notes text,
  cover_path text,
  status text not null default 'draft' check (status in ('draft', 'complete')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  album_id uuid references public.sc_albums(id) on delete set null,
  source_lyric_id uuid references public.sc_lyrics(id) on delete set null,
  title text not null check (char_length(title) between 1 and 255),
  style_prompt text,
  style_prompts text[] not null default '{}',
  lyrics text,
  notes text,
  cover_path text,
  youtube_description text,
  youtube_tags text,
  is_published boolean not null default false,
  published_at timestamptz,
  published_video_id text,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_audio_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid not null references public.sc_songs(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 255),
  original_file_name text not null,
  storage_path text not null,
  original_storage_path text,
  tagged_storage_path text,
  mime_type text not null default 'audio/mpeg',
  byte_size bigint not null default 0 check (byte_size >= 0),
  rating smallint not null default 0 check (rating between 0 and 5),
  is_primary boolean not null default false,
  is_final boolean not null default false,
  id3_title text,
  id3_artist text default 'Temney',
  id3_album text,
  id3_track_number text,
  id3_year text,
  id3_genre text,
  id3_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_rhyme_words (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word text not null check (char_length(word) between 2 and 100),
  created_at timestamptz not null default now(),
  unique (user_id, word)
);

create table if not exists public.sc_style_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 10000),
  note text check (char_length(note) <= 2000),
  rating smallint not null default 0 check (rating between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_cover_jobs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('song', 'lyric', 'album')),
  entity_id uuid not null,
  title text,
  album_name text,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  cover_path text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_video_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid not null references public.sc_songs(id) on delete cascade,
  version_id uuid not null references public.sc_audio_versions(id) on delete cascade,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  video_path text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add fields introduced after the original JSON snapshot when a legacy table
-- already exists. These statements are safe on a fresh schema too.
alter table public.sc_songs add column if not exists style_prompts text[] not null default '{}';
alter table public.sc_songs add column if not exists youtube_description text;
alter table public.sc_songs add column if not exists youtube_tags text;
alter table public.sc_songs add column if not exists is_published boolean not null default false;
alter table public.sc_songs add column if not exists published_at timestamptz;
alter table public.sc_songs add column if not exists published_video_id text;
alter table public.sc_audio_versions add column if not exists original_storage_path text;
alter table public.sc_audio_versions add column if not exists tagged_storage_path text;

create index if not exists sc_albums_user_idx on public.sc_albums(user_id);
create index if not exists sc_lyrics_user_idx on public.sc_lyrics(user_id);
create index if not exists sc_songs_user_idx on public.sc_songs(user_id);
create index if not exists sc_versions_user_song_idx on public.sc_audio_versions(user_id, song_id);
create index if not exists sc_style_prompts_user_idx on public.sc_style_prompts(user_id, updated_at desc);
create index if not exists sc_cover_jobs_user_idx on public.sc_cover_jobs(user_id, updated_at desc);
create index if not exists sc_video_jobs_user_idx on public.sc_video_jobs(user_id, created_at desc);

-- Remove legacy client policies before installing the canonical owner matrix.
-- Service-role policies are intentionally preserved.
create or replace function public.songcraft_bootstrap_drop_client_policies(target text)
returns void
language plpgsql
as $$
declare
  rel regclass := to_regclass(target);
  service_oids oid[];
  policy_row record;
begin
  if rel is null then return; end if;
  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids
    from pg_roles where rolname = 'service_role';
  for policy_row in select polname as policyname, polroles from pg_policy where polrelid = rel loop
    if policy_row.polroles is null or not (policy_row.polroles && service_oids) then
      execute format('drop policy if exists %I on %s', policy_row.policyname, rel);
    end if;
  end loop;
end $$;

create or replace function public.songcraft_bootstrap_owner_policy(target text, operation_name text)
returns void
language plpgsql
as $$
declare
  rel regclass := to_regclass(target);
  policy_name text;
begin
  if rel is null then return; end if;
  policy_name := rel::regclass::text || ' ' || operation_name || ' own rows';
  execute format('drop policy if exists %I on %s', policy_name, rel);
  if operation_name = 'insert' then
    execute format('create policy %I on %s for insert to authenticated with check (auth.uid() = user_id)', policy_name, rel);
  elsif operation_name = 'update' then
    execute format('create policy %I on %s for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', policy_name, rel);
  else
    execute format('create policy %I on %s for %s to authenticated using (auth.uid() = user_id)', policy_name, rel, operation_name);
  end if;
end $$;

create or replace function public.songcraft_bootstrap_service_policy(target text)
returns void
language plpgsql
as $$
declare
  rel regclass := to_regclass(target);
  policy_name text;
begin
  if rel is null or not exists (select 1 from pg_roles where rolname = 'service_role') then return; end if;
  policy_name := rel::regclass::text || ' service role';
  execute format('drop policy if exists %I on %s', policy_name, rel);
  execute format('create policy %I on %s for all to service_role using (true) with check (true)', policy_name, rel);
end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'sc_albums', 'sc_lyrics', 'sc_songs', 'sc_audio_versions', 'sc_rhyme_words', 'sc_style_prompts'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    perform public.songcraft_bootstrap_drop_client_policies('public.' || table_name);
    perform public.songcraft_bootstrap_service_policy('public.' || table_name);
    perform public.songcraft_bootstrap_owner_policy('public.' || table_name, 'select');
    perform public.songcraft_bootstrap_owner_policy('public.' || table_name, 'insert');
    perform public.songcraft_bootstrap_owner_policy('public.' || table_name, 'update');
    perform public.songcraft_bootstrap_owner_policy('public.' || table_name, 'delete');
  end loop;

  -- Job state is written by service-role functions; the app may only observe it.
  foreach table_name in array array['sc_cover_jobs', 'sc_video_jobs'] loop
    execute format('alter table public.%I enable row level security', table_name);
    perform public.songcraft_bootstrap_drop_client_policies('public.' || table_name);
    perform public.songcraft_bootstrap_service_policy('public.' || table_name);
    perform public.songcraft_bootstrap_owner_policy('public.' || table_name, 'select');
  end loop;
end $$;

-- Make the media bucket private and replace the known legacy storage policies
-- with owner-prefix-only access. A path must start with auth.uid().
insert into storage.buckets (id, name, public)
values ('songcraft', 'songcraft', false)
on conflict (id) do update set public = false;

update storage.buckets
   set file_size_limit = 50 * 1024 * 1024,
       allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp',
         'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/x-m4a',
         'application/zip', 'text/plain', 'video/mp4'
       ]
 where id = 'songcraft';

do $$
declare
  policy_row record;
  service_oids oid[];
  policy_text text;
begin
  if to_regclass('storage.objects') is null then return; end if;
  select coalesce(array_agg(oid), '{}'::oid[]) into service_oids from pg_roles where rolname = 'service_role';
  for policy_row in
    select polname as policyname, polroles, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
    from pg_policy where polrelid = 'storage.objects'::regclass
  loop
    policy_text := coalesce(policy_row.qual, '') || ' ' || coalesce(policy_row.with_check, '');
    if (policy_text ilike '%bucket_id%''songcraft''%'
        or policy_text ilike '%bucket_id = ''songcraft''%')
       and (policy_row.polroles is null or not (policy_row.polroles && service_oids)) then
      execute format('drop policy if exists %I on storage.objects', policy_row.policyname);
    end if;
  end loop;

  drop policy if exists "songcraft storage select own" on storage.objects;
  drop policy if exists "songcraft storage insert own" on storage.objects;
  drop policy if exists "songcraft storage update own" on storage.objects;
  drop policy if exists "songcraft storage delete own" on storage.objects;
  create policy "songcraft storage select own" on storage.objects
    for select to authenticated using (bucket_id = 'songcraft' and (storage.foldername(name))[1] = auth.uid()::text);
  create policy "songcraft storage insert own" on storage.objects
    for insert to authenticated with check (bucket_id = 'songcraft' and (storage.foldername(name))[1] = auth.uid()::text);
  create policy "songcraft storage update own" on storage.objects
    for update to authenticated using (bucket_id = 'songcraft' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'songcraft' and (storage.foldername(name))[1] = auth.uid()::text);
  create policy "songcraft storage delete own" on storage.objects
    for delete to authenticated using (bucket_id = 'songcraft' and (storage.foldername(name))[1] = auth.uid()::text);
  drop policy if exists "songcraft storage service role" on storage.objects;
  create policy "songcraft storage service role" on storage.objects
    for all to service_role using (bucket_id = 'songcraft') with check (bucket_id = 'songcraft');
end $$;

create or replace function public.songcraft_storage_object_guard()
returns trigger
language plpgsql
as $$
declare
  actor text;
  object_mime text;
  object_size bigint;
begin
  if new.bucket_id <> 'songcraft' then return new; end if;
  actor := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), current_user);
  if actor in ('service_role', 'supabase_service_role', 'postgres', 'supabase_admin', 'supabase_migrations_admin') then
    return new;
  end if;
  if (storage.foldername(new.name))[1] <> auth.uid()::text then
    raise exception 'Storage object path does not belong to the current user' using errcode = '42501';
  end if;
  object_mime := lower(split_part(coalesce(new.metadata->>'mimetype', new.metadata->>'content_type', ''), ';', 1));
  object_size := nullif(new.metadata->>'size', '')::bigint;
  if object_size is not null and object_size > 50 * 1024 * 1024 then
    raise exception 'Storage object exceeds the 50 MiB limit' using errcode = '42501';
  end if;
  if object_mime <> '' and object_mime <> any (array['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'application/zip', 'text/plain', 'video/mp4']) then
    raise exception 'Storage object MIME type is not allowed' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists songcraft_storage_object_guard_trg on storage.objects;
create trigger songcraft_storage_object_guard_trg
  before insert or update on storage.objects
  for each row execute function public.songcraft_storage_object_guard();

commit;
