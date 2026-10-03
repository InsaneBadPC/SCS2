-- AI Manager Studio Phase 0 — rozšíření schématu o manažerskou vrstvu.
-- Bezpečné pro opakované spuštění (if not exists / add column if not exists).

-- agent_videos: 3 režimy renderu (mode) + backend (ffmpeg | VM)
alter table agent_videos add column if not exists mode text check (mode in ('lyric_video','static_cover','short_teaser','image_animation','full_scenes'));
alter table agent_videos add column if not exists backend text not null default 'ffmpeg' check (backend in ('ffmpeg','vm_image_animation','vm_full_scenes'));
alter table agent_videos add column if not exists audio_storage_path text;
alter table agent_videos add column if not exists prompt_used text;
alter table agent_videos add column if not exists output_path text;

-- agent_image_assets: albové artworky + A/B thumbnail varianty
alter table agent_image_assets add column if not exists for_album boolean not null default false;
alter table agent_image_assets add column if not exists render_url text;
alter table agent_image_assets add column if not exists variant_label text;

-- agent_recommendations: měřitelný dopad + learning loop
alter table agent_recommendations add column if not exists expected_impact text;
alter table agent_recommendations add column if not exists metric text check (metric in ('ctr','retention','long_watch_time','subs','engagement'));
alter table agent_recommendations add column if not exists deadline_at timestamptz;
alter table agent_recommendations add column if not exists linked_publication_id uuid;
alter table agent_recommendations add column if not exists outcome text;

-- agent_media_uploads: soubory vložené v chatu (image | audio | video)
create table if not exists agent_media_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('image','audio','video')),
  storage_path text not null,
  mime_type text,
  byte_size bigint,
  label text,
  conversation_id uuid references agent_conversations(id) on delete set null,
  song_id uuid,
  created_at timestamptz not null default now()
);

-- agent_channel_stats: denní agregát kanálu pro diagnostiku manažera
create table if not exists agent_channel_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  views int not null default 0,
  watch_time_minutes numeric not null default 0,
  subs_gained int not null default 0,
  ctr numeric,
  avg_view_duration_seconds numeric not null default 0,
  traffic_source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- agent_content_calendar: agentem navržená kadence (long | short | community | release)
create table if not exists agent_content_calendar (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  planned_date date not null,
  format text not null check (format in ('long','short','community','release')),
  song_id uuid,
  publication_id uuid,
  title text,
  status text not null default 'idea' check (status in ('idea','scheduled','done','skipped')),
  note text,
  created_at timestamptz not null default now()
);

alter table agent_media_uploads enable row level security;
alter table agent_channel_stats enable row level security;
alter table agent_content_calendar enable row level security;

do $$
begin
  create policy "agent media uploads own rows" on agent_media_uploads for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent channel stats own rows" on agent_channel_stats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent content calendar own rows" on agent_content_calendar for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

create index if not exists agent_media_uploads_conv_idx on agent_media_uploads(user_id, conversation_id, created_at desc);
create index if not exists agent_channel_stats_date_idx on agent_channel_stats(user_id, date desc);
create index if not exists agent_content_calendar_date_idx on agent_content_calendar(user_id, planned_date);