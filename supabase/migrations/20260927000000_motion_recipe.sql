-- Plán pohybu (motion recipe): co se má na dané fotce rozpohybovat.
--
-- Klíčová zásada: pl píše ten, kdo obrázek VIDÍ (agent s vision dostane
-- prompt uživatele), takže každá fotka dostane jiný pohyb. Neexistuje
-- žádná univerzální šablona efektů.

alter table agent_videos
  add column if not exists motion_recipe jsonb,
  add column if not exists motion_prompt text,
  add column if not exists recipe_source text,
  add column if not exists aspect text not null default '16:9';

-- agent_videos.type je omezený check constraintem - shorts potřebují typ short
-- (už existuje) a nové režimy jdou přes sloupec mode, ne přes type.
comment on column agent_videos.motion_recipe is
  'JSON plánu pohybu v2: {version,shot_seconds,push,elements:[{what,region,anchor,motion}]}';
comment on column agent_videos.motion_prompt is
  'Co uživatel napsal: "co na obrázku rozpohybovat"';
comment on column agent_videos.recipe_source is
  'agent_vision | user_json | fallback_template';

-- Recepty uchováváme i samostatně, aby šlo písni přerenderovat s jiným
-- plánem bez toho, aby agent znovu generoval (a aby byl auditovatelný,
-- co přesně se hýbalo).
create table if not exists motion_recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  song_id uuid references sc_songs(id) on delete set null,
  source_storage_path text,
  prompt text,
  recipe jsonb not null,
  source text not null default 'agent_vision',
  created_at timestamptz not null default now()
);

create index if not exists motion_recipes_user_created_idx
  on motion_recipes (user_id, created_at desc);

alter table motion_recipes enable row level security;

drop policy if exists motion_recipes_owner_all on motion_recipes;
create policy motion_recipes_owner_all on motion_recipes
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
