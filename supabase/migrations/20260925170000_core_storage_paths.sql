-- User-prefixed storage paths for the core catalog. Existing legacy rows are
-- not rewritten; new inserts and path changes are checked immediately.

begin;

create or replace function public.sc_catalog_path_guard()
returns trigger
language plpgsql
as $$
declare
  new_path text;
  old_path text;
  owner_value uuid;
begin
  owner_value := nullif(to_jsonb(new)->>'user_id', '')::uuid;
  new_path := case
    when tg_table_name = 'sc_albums' then to_jsonb(new)->>'cover_path'
    when tg_table_name = 'sc_lyrics' then to_jsonb(new)->>'cover_path'
    when tg_table_name = 'sc_songs' then to_jsonb(new)->>'cover_path'
    when tg_table_name = 'sc_audio_versions' then to_jsonb(new)->>'storage_path'
    when tg_table_name = 'sc_video_jobs' then to_jsonb(new)->>'video_path'
    else null
  end;
  if tg_op = 'INSERT' then
    if new_path is not null and not public.songcraft_path_allowed(owner_value, new_path) then
      raise exception 'Storage path for % does not belong to its owner', tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;
  old_path := case
    when tg_table_name = 'sc_albums' then to_jsonb(old)->>'cover_path'
    when tg_table_name = 'sc_lyrics' then to_jsonb(old)->>'cover_path'
    when tg_table_name = 'sc_songs' then to_jsonb(old)->>'cover_path'
    when tg_table_name = 'sc_audio_versions' then to_jsonb(old)->>'storage_path'
    when tg_table_name = 'sc_video_jobs' then to_jsonb(old)->>'video_path'
    else null
  end;
  if new_path is distinct from old_path
     and new_path is not null
     and not public.songcraft_path_allowed(owner_value, new_path) then
    raise exception 'Storage path for % does not belong to its owner', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists sc_albums_path_guard_trg on public.sc_albums;
create trigger sc_albums_path_guard_trg before insert or update on public.sc_albums for each row execute function public.sc_catalog_path_guard();
drop trigger if exists sc_lyrics_path_guard_trg on public.sc_lyrics;
create trigger sc_lyrics_path_guard_trg before insert or update on public.sc_lyrics for each row execute function public.sc_catalog_path_guard();
drop trigger if exists sc_songs_path_guard_trg on public.sc_songs;
create trigger sc_songs_path_guard_trg before insert or update on public.sc_songs for each row execute function public.sc_catalog_path_guard();
drop trigger if exists sc_audio_versions_catalog_path_guard_trg on public.sc_audio_versions;
create trigger sc_audio_versions_catalog_path_guard_trg before insert or update on public.sc_audio_versions for each row execute function public.sc_catalog_path_guard();
drop trigger if exists sc_video_jobs_path_guard_trg on public.sc_video_jobs;
create trigger sc_video_jobs_path_guard_trg before insert or update on public.sc_video_jobs for each row execute function public.sc_catalog_path_guard();

commit;
