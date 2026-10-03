#!/usr/bin/env node

/**
 * Retired public-release renderer.
 *
 * Video rendering now runs exclusively in the private Oracle worker and writes
 * to the owner's Supabase Storage prefix. This stub remains so an old workflow
 * invocation fails closed instead of publishing a GitHub release asset.
 */
console.error("This renderer is retired. Use workers/video-renderer/worker.mjs and the agent_videos queue.");
process.exit(1);
