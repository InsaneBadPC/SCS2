-- Published state is a server outcome, never a client checkbox. Only the
-- confirmation-aware YouTube Edge Function may set these columns.

begin;

create or replace function public.sc_songs_publication_guard()
returns trigger
language plpgsql
as $$
declare
  actor text;
begin
  actor := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), current_user);
  if actor in ('service_role', 'supabase_service_role', 'postgres', 'supabase_admin', 'supabase_migrations_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.is_published := false;
    new.published_at := null;
    new.published_video_id := null;
    return new;
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'sc_songs.user_id nelze změnit' using errcode = '42501';
  end if;
  if new.is_published is distinct from old.is_published
     or new.published_at is distinct from old.published_at
     or new.published_video_id is distinct from old.published_video_id then
    raise exception 'Publikovaný stav mění pouze potvrzený serverový publish flow' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists sc_songs_publication_guard_trg on public.sc_songs;
create trigger sc_songs_publication_guard_trg
  before insert or update on public.sc_songs
  for each row execute function public.sc_songs_publication_guard();

commit;
