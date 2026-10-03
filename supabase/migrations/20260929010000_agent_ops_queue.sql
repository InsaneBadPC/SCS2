-- agent_ops: fronta operací, které si agent může nechat provést na Oracle VM.
--
-- Proč fronta a ne HTTP endpoint na VM: neotevíráme žádný nový port do VM a
-- necpou se tam žádné dlouhodobé přihlašovací údaje. Agent jen zapíše řádek,
-- proces ops-runner na VM ho vezme a výsledek dopíše zpět. Stejný vzor jako
-- agent_videos, jen místo vykreslení videa běží příkaz.
--
-- Bezpečnostní pravidla, která tohle zavádí:
--   1) Řádek vzniká ve stavu pending_confirmation a NESMÍ se spustit, dokud
--      uživatel výslovně nepotvrdí přes agent-confirm. Bez potvrzení se ve
--      VM nespustí nic.
--   2) Tabulka je jen pro service_role. Klient (a tedy klientská relace
--      agenta) má nulové policy, stejně jako u youtube_credentials.
--   3) Každý řádek má nonce_hash, jednoznačný, jako agent_confirmations.
--   4) Zápis do agent_action_log je append-only trigger, takže i operace
--      agenta jde do auditu, který se nedá přepsat.

create table if not exists public.agent_ops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in (
    'shell',           -- libovolný příkaz na VM
    'git_push',        -- push větve do repa
    'deploy_worker',   -- nasadit worker.mjs + loop-engine.mjs a restartovat službu
    'read_file',       -- čtení souboru z repa (přes GitHub API, bez VM)
    'read_skills'      -- čtení skills dokumentace
  )),
  command text,
  args jsonb,
  summary text not null,
  status text not null default 'pending_confirmation'
    check (status in ('pending_confirmation','approved','running','done','failed','rejected','expired')),
  nonce_hash text not null unique,
  requires_confirmation boolean not null default true,
  output text,
  exit_code integer,
  error_message text,
  expires_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_ops_command_present check (kind in ('git_push','deploy_worker','read_file','read_skills') or command is not null),
  constraint agent_ops_shell_not_blank check (kind <> 'shell' or (command is not null and length(trim(command)) > 0))
);

create index if not exists agent_ops_queue_idx on public.agent_ops (status, created_at)
  where status in ('pending_confirmation', 'approved');
create index if not exists agent_ops_user_idx on public.agent_ops (user_id, created_at desc);
create index if not exists agent_ops_expiry_idx on public.agent_ops (expires_at)
  where status = 'pending_confirmation';

-- expirace: schválení má stejný časový limit jako potvrzení k publikaci
create or replace function public.agent_ops_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists agent_ops_touch_trg on public.agent_ops;
create trigger agent_ops_touch_trg
  before update on public.agent_ops
  for each row execute function public.agent_ops_touch_updated_at();

-- fail-closed na úrovni oprávnění: klient nesmí do tabulky vůbec
alter table public.agent_ops enable row level security;
revoke all on public.agent_ops from anon, authenticated;
grant all on public.agent_ops to service_role;

comment on table public.agent_ops is
  'Fronta operací pro agenta. Bez potvrzeni uzivatelem se nic nespusti. Service role only.';
