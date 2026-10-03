-- Potvrzovací akce pro operace na VM: shell, git push, nasazení workeru,
-- čtení souboru z repa a čtení skills dokumentace.
--
-- agent_confirmations.action má NOT VALID CHECK z 20260925130000, který tyto
-- hodnoty nepřipouští. Rozšíříme ho na stejný vzor, jako jsme rozšířili
-- agent_videos.type, a staré potvrzení k publikaci zůstanou nedotčená.

alter table public.agent_confirmations
  drop constraint if exists agent_confirmations_action_check;
alter table public.agent_confirmations
  add constraint agent_confirmations_action_check
  check (action in (
    'publish_to_youtube', 'update_existing_video', 'send_comment_reply', 'set_thumbnail',
    'run_vm_command', 'push_git_branch', 'deploy_worker', 'read_repo_file', 'read_skills'
  ));

-- fail-closed kontrola po změně
do $$
declare
  bad bigint;
begin
  select count(*) into bad from public.agent_confirmations
    where action not in (
      'publish_to_youtube', 'update_existing_video', 'send_comment_reply', 'set_thumbnail',
      'run_vm_command', 'push_git_branch', 'deploy_worker', 'read_repo_file', 'read_skills'
    );
  if bad > 0 then
    raise exception 'agent_confirmations má % neznámých akcí', bad;
  end if;
end
$$;
