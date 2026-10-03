-- Core schema completion for the AI Manager branch.
-- The original project was deployed from JSON snapshots, so these objects were
-- missing from a clean Supabase migration history. This migration is additive
-- and does not delete or rewrite user data.

begin;

-- ---------------------------------------------------------------------------
-- Immutable original audio pointer. `storage_path` remains the legacy pointer
-- for old clients; new media code writes generated/tagged files to
-- `tagged_storage_path` and never overwrites the original upload.
-- ---------------------------------------------------------------------------
alter table if exists public.sc_audio_versions
  add column if not exists original_storage_path text;

do $$
begin
  if to_regclass('public.sc_audio_versions') is not null then
    update public.sc_audio_versions
       set original_storage_path = storage_path
     where original_storage_path is null
       and storage_path is not null;
  end if;
end $$;

create or replace function public.sc_audio_versions_guard_paths()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.original_storage_path is null then
      new.original_storage_path := new.storage_path;
    end if;
    if new.original_storage_path is not null
       and (new.user_id is null
         or split_part(new.original_storage_path, '/', 1) <> new.user_id::text
         or new.original_storage_path like '/%'
         or new.original_storage_path like '%..%'
         or new.original_storage_path like '%\\%') then
      raise exception 'sc_audio_versions.original_storage_path není vlastnictví uživatele' using errcode = '42501';
    end if;
    if new.tagged_storage_path is not null
       and (new.user_id is null
         or split_part(new.tagged_storage_path, '/', 1) <> new.user_id::text
         or new.tagged_storage_path like '/%'
         or new.tagged_storage_path like '%..%'
         or new.tagged_storage_path like '%\\%') then
      raise exception 'sc_audio_versions.tagged_storage_path není vlastnictví uživatele' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.original_storage_path is distinct from old.original_storage_path then
    raise exception 'sc_audio_versions.original_storage_path je immutable' using errcode = '42501';
  end if;
  if new.tagged_storage_path is distinct from old.tagged_storage_path
     and new.tagged_storage_path is not null
     and (new.user_id is null
       or split_part(new.tagged_storage_path, '/', 1) <> new.user_id::text
       or new.tagged_storage_path like '/%'
       or new.tagged_storage_path like '%..%'
       or new.tagged_storage_path like '%\\%') then
    raise exception 'sc_audio_versions.tagged_storage_path není vlastnictví uživatele' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists sc_audio_versions_guard_paths_trg on public.sc_audio_versions;
create trigger sc_audio_versions_guard_paths_trg
  before insert or update on public.sc_audio_versions
  for each row execute function public.sc_audio_versions_guard_paths();

do $$
begin
  if to_regclass('public.sc_audio_versions') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'sc_audio_versions_original_path_owner'
         and conrelid = 'public.sc_audio_versions'::regclass
     ) then
    alter table public.sc_audio_versions
      add constraint sc_audio_versions_original_path_owner
      check (
        original_storage_path is null
        or (
          split_part(original_storage_path, '/', 1) = user_id::text
          and original_storage_path !~ '(^/|\.\.|\\\\)'
        )
      ) not valid;
  end if;
  if to_regclass('public.sc_audio_versions') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'sc_audio_versions_tagged_path_owner'
         and conrelid = 'public.sc_audio_versions'::regclass
     ) then
    alter table public.sc_audio_versions
      add constraint sc_audio_versions_tagged_path_owner
      check (
        tagged_storage_path is null
        or (
          split_part(tagged_storage_path, '/', 1) = user_id::text
          and tagged_storage_path !~ '(^/|\.\.|\\\\)'
        )
      ) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Style prompts are part of the app's snapshot and were absent from the
-- original core migration.
-- ---------------------------------------------------------------------------
create table if not exists public.sc_style_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 10000),
  note text check (char_length(note) <= 2000),
  rating smallint not null default 0 check (rating between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sc_style_prompts_user_updated_idx
  on public.sc_style_prompts(user_id, updated_at desc);
alter table public.sc_style_prompts enable row level security;

do $$
begin
  drop policy if exists "sc style prompts select own" on public.sc_style_prompts;
  drop policy if exists "sc style prompts insert own" on public.sc_style_prompts;
  drop policy if exists "sc style prompts update own" on public.sc_style_prompts;
  drop policy if exists "sc style prompts delete own" on public.sc_style_prompts;
  create policy "sc style prompts select own" on public.sc_style_prompts
    for select to authenticated using ((select auth.uid()) = user_id);
  create policy "sc style prompts insert own" on public.sc_style_prompts
    for insert to authenticated with check ((select auth.uid()) = user_id);
  create policy "sc style prompts update own" on public.sc_style_prompts
    for update to authenticated using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);
  create policy "sc style prompts delete own" on public.sc_style_prompts
    for delete to authenticated using ((select auth.uid()) = user_id);
exception when others then
  raise warning 'sc_style_prompts policies nebyly aplikovány: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Cover jobs are written by the server-side cover function. The client may
-- read only its own jobs; it cannot create or mutate render state.
-- ---------------------------------------------------------------------------
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
create index if not exists sc_cover_jobs_user_updated_idx
  on public.sc_cover_jobs(user_id, updated_at desc);
alter table public.sc_cover_jobs enable row level security;

do $$
begin
  drop policy if exists "sc cover jobs select own" on public.sc_cover_jobs;
  create policy "sc cover jobs select own" on public.sc_cover_jobs
    for select to authenticated using ((select auth.uid()) = user_id);
exception when others then
  raise warning 'sc_cover_jobs policy nebyla aplikována: %', sqlerrm;
end $$;

create or replace function public.sc_cover_jobs_guard_path()
returns trigger
language plpgsql
as $$
begin
  if new.cover_path is not null
     and (new.user_id is null
       or split_part(new.cover_path, '/', 1) <> new.user_id::text
       or new.cover_path like '/%'
       or new.cover_path like '%..%'
       or new.cover_path like '%\\%') then
    raise exception 'sc_cover_jobs.cover_path není vlastnictví uživatele' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists sc_cover_jobs_guard_path_trg on public.sc_cover_jobs;
create trigger sc_cover_jobs_guard_path_trg
  before insert or update on public.sc_cover_jobs
  for each row execute function public.sc_cover_jobs_guard_path();

commit;
