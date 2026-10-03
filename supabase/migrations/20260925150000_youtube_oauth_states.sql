-- One-time YouTube OAuth PKCE state. Tokens and verifiers never enter the
-- client; only the service-role Edge Functions can read or consume this table.

begin;

create table if not exists public.youtube_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null unique,
  code_verifier text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists youtube_oauth_states_expiry_idx
  on public.youtube_oauth_states(expires_at, consumed_at);

alter table public.youtube_oauth_states enable row level security;
revoke all on public.youtube_oauth_states from anon, authenticated;
grant select, insert, update, delete on public.youtube_oauth_states to service_role;

do $$
begin
  drop policy if exists "youtube oauth states service only" on public.youtube_oauth_states;
  create policy "youtube oauth states service only" on public.youtube_oauth_states
    for all to service_role using (true) with check (true);
exception when others then
  raise warning 'youtube_oauth_states policy nebyla aplikována: %', sqlerrm;
end $$;

commit;
