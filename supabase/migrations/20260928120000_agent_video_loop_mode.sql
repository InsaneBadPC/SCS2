-- video_loop: plynulá smyčka z nahráného MP4 přes celou skladbu.
--
-- Proč migrace: 20260925000000 zúžil agent_videos.type na tři kanonické typy
-- renderu, které umí worker (static_cover | image_animation | full_scenes).
-- Orchestrátor ale vkládal "short"/"lyric_video" do type a "loop_video" do mode,
-- což porušovalo CHECK; job navíc neměl renderer. Tady se přidává čtvrtý
-- kanonický typ video_loop, který renderuje lokální ffmpeg ve workeru
-- (workers/video-renderer/worker.mjs, větev D). backend zůstává 'ffmpeg',
-- protože smyčka běží lokálně a nepotřebuje dashboard.
--
-- Zdroj pravdy pro DB je tento soubor, ne JSON snapshoty v root repozitáře.

alter table public.agent_videos
  drop constraint if exists agent_videos_type_check;
alter table public.agent_videos
  add constraint agent_videos_type_check
  check (type in ('static_cover', 'image_animation', 'full_scenes', 'video_loop'));

-- mode má původní CHECK z 20260924000000; nahrazujeme ho stejným vzorem jako type,
-- aby se obě hlídky shodovaly a zbytečné staré hodnoty zůstaly čitelné.
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
  check (mode in ('static_cover', 'image_animation', 'full_scenes', 'video_loop'));

-- Starý režim loop_video se už nepoužívá; přemapujeme na kanonický video_loop,
-- aby v tabulce nezůstaly řádky, které by neprošly novou hlídkou.
update public.agent_videos
set mode = 'video_loop', type = 'video_loop'
where mode = 'loop_video' or type in ('short', 'lyric_video');

-- 'vm_loop' nebylo nikdy platné (backend CHECK zná jen ffmpeg | vm_image_animation
-- | vm_full_scenes) a renderer pro něj neexistuje. Přesměrujeme na lokální ffmpeg.
update public.agent_videos
set backend = 'ffmpeg'
where backend = 'vm_loop';

-- fail-closed kontrola: po migraci nesmí zůstat nic, co by nesplnilo hlídky.
do $$
declare
  bad_type bigint;
  bad_mode bigint;
  bad_backend bigint;
begin
  select count(*) into bad_type from public.agent_videos
    where type not in ('static_cover', 'image_animation', 'full_scenes', 'video_loop');
  select count(*) into bad_mode from public.agent_videos
    where mode is not null
      and mode not in ('static_cover', 'image_animation', 'full_scenes', 'video_loop');
  select count(*) into bad_backend from public.agent_videos
    where backend not in ('ffmpeg', 'vm_image_animation', 'vm_full_scenes');
  if bad_type > 0 or bad_mode > 0 or bad_backend > 0 then
    raise exception 'agent_videos má neplatné hodnoty po migraci (type=%, mode=%, backend=%)',
      bad_type, bad_mode, bad_backend;
  end if;
end
$$;
