-- Explicit confirmation hand-off for public YouTube mutations.
-- A nonce is created by the server-side agent, stored only as a SHA-256 hash,
-- and atomically consumed by the confirm endpoint. The client never gets a
-- reusable service credential or permission to mutate publication state.

begin;

create table if not exists public.agent_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('publish_to_youtube', 'update_existing_video', 'send_comment_reply', 'set_thumbnail')),
  target_id text,
  nonce_hash text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'consumed', 'expired', 'failed')),
  idempotency_key text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists agent_confirmations_idempotency_idx
  on public.agent_confirmations(user_id, action, idempotency_key)
  where idempotency_key is not null;
create index if not exists agent_confirmations_pending_idx
  on public.agent_confirmations(user_id, status, expires_at);

alter table public.agent_confirmations enable row level security;

do $$
begin
  drop policy if exists "agent confirmations service only" on public.agent_confirmations;
  create policy "agent confirmations service only" on public.agent_confirmations
    for all to service_role using (true) with check (true);
exception when others then
  raise warning 'agent_confirmations policy nebyla aplikována: %', sqlerrm;
end $$;

revoke all on public.agent_confirmations from anon, authenticated;
grant select, insert, update, delete on public.agent_confirmations to service_role;

commit;
