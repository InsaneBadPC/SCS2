-- agent_ops: RLS policies for operation queue
-- 
-- The table was created with RLS enabled but 0 policies (fail-closed deny-all).
-- This migration adds the established pattern: owner-scoped SELECT for clients
-- so the app can display operation status, and service_role passthrough for
-- all operations (queueOp, check_op_status, agent-confirm all use service_role).
-- No client INSERT/UPDATE/DELETE — those are server-only via Edge Functions.

begin;

-- 1) Owner-scoped SELECT for authenticated users
-- Justification: The app may need to display operation status (pending/approved/running/done/failed)
-- to the user. The agent-orchestrator's check_op_status tool reads agent_ops but runs via
-- service_role; however a direct client read path follows the same pattern as agent_videos
-- and agent_action_log where clients read own rows.
create policy "agent_ops select own rows" on public.agent_ops
  for select to authenticated
  using (auth.uid() = user_id);

-- 2) Service role passthrough (defense in depth if BYPASSRLS ever changes)
-- Justification: agent-orchestrator (queueOp, check_op_status) and agent-confirm
-- both use service_role client for all agent_ops access (INSERT, SELECT, UPDATE).
create policy "agent_ops service role" on public.agent_ops
  for all to service_role
  using (true) with check (true);

-- 3) No client INSERT/UPDATE/DELETE policies — these remain server-only.
-- The migration 20260929010000 already revoked all from anon/authenticated.
-- This migration only adds the read policy; writes stay service_role only.

commit;