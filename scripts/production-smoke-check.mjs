#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const required = [
  "docs/TODO_PRODUCTION_AI_AGENT.md",
  "docs/DEPLOYMENT_RUNBOOK.md",
  "docs/VERIFICATION_STATUS.md",
  "supabase/config.toml",
  "supabase/functions/deno.json",
  "supabase/functions/agent-orchestrator/index.ts",
  "supabase/functions/agent-confirm/index.ts",
  "supabase/functions/songcraft-media/index.ts",
  "supabase/functions/youtube-oauth-start/index.ts",
  "supabase/functions/youtube-oauth-callback/index.ts",
  "supabase/functions/youtube-publish-scheduler/index.ts",
  "workers/video-renderer/worker.mjs",
  "workers/video-renderer/loop-engine.mjs",
];
const migrations = [
  "20260925000000_agent_video_render_types.sql",
  "20260925010000_agent_security_hardening.sql",
  "20260925110000_core_schema_bootstrap.sql",
  "20260925120000_core_schema_completion.sql",
  "20260925130000_agent_confirmations.sql",
  "20260925140000_video_worker_leases.sql",
  "20260925150000_youtube_oauth_states.sql",
  "20260925160000_publication_server_only.sql",
  "20260925170000_core_storage_paths.sql",
  "20260928120000_agent_video_loop_mode.sql",
  "20260929000000_agent_video_source_loop.sql",
];

for (const relative of [...required, ...migrations.map((name) => `supabase/migrations/${name}`)]) {
  await access(path.join(root, relative));
}

const activeVideoSources = [
  "supabase/functions/songcraft-youtube/index.ts",
  "supabase/functions/video-renderer-dispatch/index.ts",
  "workers/video-renderer/worker.mjs",
  "supabase_songcraft_cover_ai_function.json",
  "supabase_songcraft_youtube_function.json",
];
for (const relative of activeVideoSources) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (/github\.com\/[^\s]+\/releases|api\.github\.com\/repos\/[^\s]+\/releases/i.test(source)) {
    throw new Error(`Public release boundary remains in ${relative}`);
  }
}

console.log(`production smoke structure: OK (${migrations.length} migrations, ${required.length} required files)`);
