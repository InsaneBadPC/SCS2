-- source_loop: hlavní renderovací větev agenta, nahrazuje image_animation a full_scenes.
--
-- Proč: dashboard větve image_animation/full_scenes na Oracle VM nebyly dostupné
-- (a jejich výstup byl vždy 16:9, i když záznam říkal 9:16). Nový loop engine
-- (workers/video-renderer/loop-engine.mjs) dělá celé video lokálním ffmpegem ze
-- zdrojového videa písně, nebo z obalu, když video není, a umí 16:9 i 9:16.
--
-- Zdroj pravdy pro DB je tento soubor, ne JSON snapshoty v root repozitáře.

alter table public.agent_videos
  drop constraint if exists agent_videos_type_check;
alter table public.agent_videos
  add constraint agent_videos_type_check
  check (type in ('static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop'));

do $$
declare
  old_mode_check record;
begin
  for old_mode_check in
    select c.conname as name
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.agent_videos'::regclass
      and c.contype = 'c'
      and a.attname = 'mode'
      and pg_get_expr(c.conbin, c.conrelid) ilike '%static_cover%'
  loop
    execute format('alter table public.agent_videos drop constraint %I', old_mode_check.name);
  end loop;
end
$$;

alter table public.agent_videos
  add constraint agent_videos_mode_check
  check (mode in ('static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop'));

update public.agent_videos
set mode = 'source_loop', type = 'source_loop'
where mode = 'living_motion' or type in ('short', 'lyric_video');

-- fail-closed: po migraci nesmí zůstat nic, co by nesplnilo hlídky
do $$
declare
  bad_type bigint;
  bad_mode bigint;
  bad_backend bigint;
begin
  select count(*) into bad_type from public.agent_videos
    where type not in ('static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop');
  select count(*) into bad_mode from public.agent_videos
    where mode is not null
      and mode not in ('static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop');
  select count(*) into bad_backend from public.agent_videos
    where backend not in ('ffmpeg', 'vm_image_animation', 'vm_full_scenes');
  if bad_type > 0 or bad_mode > 0 or bad_backend > 0 then
    raise exception 'agent_videos má neplatné hodnoty po migraci (type=%, mode=%, backend=%)',
      bad_type, bad_mode, bad_backend;
  end if;
end
$$;
