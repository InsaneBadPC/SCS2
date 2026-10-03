-- Temney Agent v3.0
-- Safe to re-run. All agent-owned tables carry user_id for direct RLS ownership checks.

create extension if not exists pgcrypto;

create table if not exists agent_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auto_publish boolean not null default false,
  preferred_publish_hour int check (preferred_publish_hour between 0 and 23),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','model','function')),
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists agent_recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('seo','thumbnail','schedule','content','engagement','strategy')),
  related_song_id uuid,
  recommendation text not null,
  reasoning text,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','applied')),
  created_at timestamptz not null default now()
);

create table if not exists agent_action_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  target_table text,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  result text not null check (result in ('success','error','pending')),
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists agent_image_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid,
  album_id uuid,
  asset_type text not null check (asset_type in ('album_cover','song_artwork')),
  aspect_ratio text not null check (aspect_ratio in ('1:1','16:9')),
  lyric_themes text[] not null default '{}',
  prompt_used text not null,
  seed text,
  base_image_path text,
  final_image_path text,
  status text not null default 'queued' check (status in ('queued','generating','overlay_pending','ready','failed')),
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists agent_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid,
  type text not null check (type in ('lyric_video','static_cover','short','teaser')),
  render_status text not null default 'queued' check (render_status in ('queued','rendering','ready','failed')),
  storage_path text,
  duration_seconds int,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists youtube_publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id uuid references agent_videos(id) on delete set null,
  song_id uuid,
  youtube_video_id text,
  status text not null default 'draft' check (status in ('draft','scheduled','published','failed','removed')),
  title text,
  description text,
  tags text[] not null default '{}',
  thumbnail_path text,
  playlist_ids text[] not null default '{}',
  scheduled_at timestamptz,
  published_at timestamptz,
  privacy_status text not null default 'private',
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists youtube_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  youtube_publication_id uuid not null references youtube_publications(id) on delete cascade,
  date date not null,
  views int not null default 0,
  watch_time_minutes numeric not null default 0,
  avg_view_duration_seconds numeric not null default 0,
  likes int not null default 0,
  comments int not null default 0,
  subscribers_gained int not null default 0,
  ctr numeric,
  traffic_source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (youtube_publication_id, date)
);

create table if not exists youtube_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  channel_id text,
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table agent_settings enable row level security;
alter table agent_conversations enable row level security;
alter table agent_messages enable row level security;
alter table agent_recommendations enable row level security;
alter table agent_action_log enable row level security;
alter table agent_image_assets enable row level security;
alter table agent_videos enable row level security;
alter table youtube_publications enable row level security;
alter table youtube_stats enable row level security;
alter table youtube_credentials enable row level security;

do $$
begin
  create policy "agent settings own rows" on agent_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent conversations own rows" on agent_conversations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent messages own rows" on agent_messages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent recommendations own rows" on agent_recommendations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent action log own rows" on agent_action_log for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent image assets own rows" on agent_image_assets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "agent videos own rows" on agent_videos for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "youtube publications own rows" on youtube_publications for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "youtube stats own rows" on youtube_stats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy "youtube credentials own rows" on youtube_credentials for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

create index if not exists agent_messages_conversation_idx on agent_messages(conversation_id, created_at);
create index if not exists agent_recommendations_status_idx on agent_recommendations(user_id, status, created_at desc);
create index if not exists youtube_publications_status_idx on youtube_publications(user_id, status, created_at desc);
create index if not exists agent_videos_queue_idx on agent_videos(render_status, created_at);

insert into storage.buckets (id, name, public) values ('songcraft', 'songcraft', false) on conflict (id) do nothing;
