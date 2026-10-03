#!/usr/bin/env node
// Ověření, že Edge Function secrets jsou na projektu skutečně nastavené.
// Používá Management API (deterministický JSON), nikoli textový výstup CLI.
// Token se nikdy nevypisuje; chybějící názvy se vypíší, hodnoty ne.
//
//   node scripts/verify-edge-secrets.mjs
//   SONGCRAFT_REQUIRED_SECRETS="A,B" node scripts/verify-edge-secrets.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED = (process.env.SONGCRAFT_REQUIRED_SECRETS ??
  [
    'SONGCRAFT_SUPABASE_URL',
    'SONGCRAFT_SUPABASE_ANON_KEY',
    'SONGCRAFT_SERVICE_ROLE_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GOOGLE_AI_STUDIO_KEY',
    'YOUTUBE_CLIENT_ID',
    'YOUTUBE_CLIENT_SECRET',
    'YOUTUBE_REDIRECT_URI',
    'SONGCRAFT_APP_REDIRECT_URL',
    'SONGCRAFT_ALLOWED_USER_IDS',
    'SONGCRAFT_ALLOWED_EMAILS',
    'SYNC_STATS_CRON_SECRET',
    'PUBLISH_SCHEDULER_SECRET',
  ].join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

function fail(message) {
  console.error(`verify-edge-secrets: ${message}`);
  process.exit(1);
}

async function resolveRef() {
  const fromEnv = (process.env.SUPABASE_PROJECT_REF ?? process.env.SUPABASE_PROJECT_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const source = await readFile(path.join(ROOT, 'lib', 'supabase.ts'), 'utf8');
  const match = source.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!match) fail('could not determine project ref; set SUPABASE_PROJECT_REF');
  return match[1];
}

async function main() {
  const token = (process.env.SUPABASE_ACCESS_TOKEN ?? '').trim();
  if (!token) fail('SUPABASE_ACCESS_TOKEN is not set');
  const ref = await resolveRef();

  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) fail(`cannot list secrets (HTTP ${response.status})`);
  const body = await response.json();
  const entries = Array.isArray(body) ? body : (body?.secrets ?? []);
  const names = new Set(entries.map((entry) => String(entry?.name ?? entry?.secret_name ?? '')).filter(Boolean));

  console.log(`project ${ref}: ${names.size} secret name(s) present`);
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (missing.length > 0) {
    console.error('missing secret names:');
    for (const name of missing) console.error(`  - ${name}`);
    fail(`${missing.length} required secret(s) missing`);
  }
  console.log(`all ${REQUIRED.length} required edge secret names present`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
