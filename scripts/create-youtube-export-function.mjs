#!/usr/bin/env node

/**
 * Retired legacy export deployer.
 *
 * The old generator embedded a third-party renderer API key and deployed a
 * public-URL video flow. Active rendering is now the private Oracle worker and
 * the agent_videos queue. This stub fails closed so the legacy credential
 * cannot be redeployed accidentally.
 */
console.error("This legacy YouTube export deployer is retired. Use the private Oracle worker and supabase/functions/songcraft-youtube.");
process.exit(1);
