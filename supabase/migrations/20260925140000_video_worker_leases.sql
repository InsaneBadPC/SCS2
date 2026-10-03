-- Lease/retry metadata for the single Oracle video worker.
-- The worker is idempotent: stale rendering rows are requeued, attempts are
-- bounded, and a successful render clears the lease.

begin;

alter table public.agent_videos
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists lease_expires_at timestamptz;

do $$
begin
  if to_regclass('public.agent_videos') is not null then
    if not exists (select 1 from pg_constraint where conname = 'agent_videos_attempts_check' and conrelid = 'public.agent_videos'::regclass) then
      alter table public.agent_videos add constraint agent_videos_attempts_check check (attempt_count >= 0 and max_attempts between 1 and 10);
    end if;
  end if;
end $$;

create index if not exists agent_videos_lease_idx
  on public.agent_videos(render_status, lease_expires_at, created_at);

commit;
