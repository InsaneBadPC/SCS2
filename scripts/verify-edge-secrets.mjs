#!/usr/bin/env node
// Ověření, že Edge Function secrets jsou na projektu skutečně nastavené.
// Používá Management API (deterministický JSON), nikoli textový výstup CLI.
// Token se nikdy nevypisuje; chybějící názvy se vypíší, hodnoty ne.
//
// Požadavky jsou profilové, ne jeden tvrdý seznam:
//   base (výchozí) – bez těchto tajných hodnot nefunguje žádná nasazená funkce
//   youtube        – YouTube OAuth (odloženo záměrně, postponed by design)
//   ai             – Gemini/AI klíče (odloženo záměrně, postponed by design)
//   cron           – cron tajné hodnoty plánovaných funkcí (odloženo záměrně)
//
//   node scripts/verify-edge-secrets.mjs                          (jen base)
//   node scripts/verify-edge-secrets.mjs --profile youtube        (base + youtube)
//   node scripts/verify-edge-secrets.mjs --profile youtube,ai,cron
//   SONGCRAFT_PROFILES="youtube,ai" node scripts/verify-edge-secrets.mjs
//   node scripts/verify-edge-secrets.mjs --all                    (všechny profily)
//   SONGCRAFT_REQUIRED_SECRETS="A,B" node scripts/verify-edge-secrets.mjs
//     (přepisuje profily; zachováno pro zpětnou kompatibilitu)
//
// Exit code: 0 = vše v pořádku, 1 = chybějící tajná hodnota, 2 = chybné použití.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE_REQUIRED = [
  'SONGCRAFT_SUPABASE_URL',
  'SONGCRAFT_SUPABASE_ANON_KEY',
  'SONGCRAFT_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SONGCRAFT_ALLOWED_USER_IDS',
  'SONGCRAFT_ALLOWED_EMAILS',
];

const OPTIONAL_BY_PROFILE = {
  youtube: [
    'YOUTUBE_CLIENT_ID',
    'YOUTUBE_CLIENT_SECRET',
    'YOUTUBE_REDIRECT_URI',
    'SONGCRAFT_APP_REDIRECT_URL',
  ],
  ai: ['GOOGLE_AI_STUDIO_KEY'],
  cron: ['SYNC_STATS_CRON_SECRET', 'PUBLISH_SCHEDULER_SECRET'],
};

// Co se bez které tajné hodnoty rozpadne (pro filtrované hlášení chyb).
const IMPACT = {
  SONGCRAFT_SUPABASE_URL:
    'bez ní žádná Edge funkce nepostaví klienta Supabase (agent-orchestrator, songcraft-media, songcraft-imports, video-renderer-dispatch… končí 503 "Chybí konfigurace serveru")',
  SONGCRAFT_SUPABASE_ANON_KEY:
    'bez něj selže ověření uživatelů (auth.getUser) a každý autentifikovaný endpoint vrací 401',
  SONGCRAFT_SERVICE_ROLE_KEY:
    'bez něj nejdou provést servisní operace (upload media, importy, potvrzení agenta, youtube-oauth-callback)',
  SUPABASE_URL:
    'fallback URL projektu pro funkce čtoucí SUPABASE_* — bez něj končí 503 "Chybí konfigurace serveru"',
  SUPABASE_ANON_KEY:
    'fallback veřejný klíč pro funkce čtoucí SUPABASE_* — bez něj selže ověření uživatelů (401)',
  SUPABASE_SERVICE_ROLE_KEY:
    'fallback servisní klíč pro funkce čtoucí SUPABASE_* — bez něj nejdou servisní operace',
  SONGCRAFT_ALLOWED_USER_IDS:
    'allowlist uživatelských ID — bez něj isAllowedPrivateUser zamítne všechny soukromé požadavky (fail-closed, 403)',
  SONGCRAFT_ALLOWED_EMAILS:
    'allowlist e-mailů — bez něj isAllowedPrivateUser zamítne všechny soukromé požadavky (fail-closed, 403)',
  YOUTUBE_CLIENT_ID:
    'YouTube OAuth client ID — bez něj ji nedostanou 5 z 18 funkcí: youtube-oauth-start (nevytvoří authorize URL), youtube-oauth-callback, youtube-publish, youtube-sync-stats, youtube-status (nerefreshuje token). Zbývajících 13 funkcí je na tom nezávislých. Postup doplnění: docs/YOUTUBE_OAUTH_RUNBOOK.md',
  YOUTUBE_CLIENT_SECRET:
    'YouTube OAuth client secret — bez něj ji nedostanou 4 z 18 funkcí: youtube-oauth-callback (token se nevymění), youtube-publish, youtube-sync-stats, youtube-status. Zbývajících 14 funkcí je na tom nezávislých. Postup doplnění: docs/YOUTUBE_OAUTH_RUNBOOK.md',
  YOUTUBE_REDIRECT_URI:
    'YouTube OAuth redirect URI — bez něj youtube-oauth-start nevygeneruje platnou autorizační URL',
  SONGCRAFT_APP_REDIRECT_URL:
    'deep-link aplikace pro návrat z YouTube OAuth — bez ní youtube-oauth-callback použije výchozí songcraftstudio://settings',
  GOOGLE_AI_STUDIO_KEY:
    'Gemini API klíč — bez něj songcraft-copywriter, songcraft-rhymes a songcraft-studio-assistant vrací 503 a agent-orchestrator vypne gemini providera; AI cesta je postponed, ostatní funkce deployují bez něj',
  SYNC_STATS_CRON_SECRET:
    'cron tajná hodnota pro youtube-sync-stats — bez ní autorizace plánovače přes hlavičku x-cron-secret nefunguje (_shared/scheduler-auth.ts), syncy musí volat se service-role bearer tokenem',
  PUBLISH_SCHEDULER_SECRET:
    'cron tajná hodnota pro youtube-publish-scheduler — bez ní autorizace plánovače přes hlavičku x-cron-secret nefunguje (_shared/scheduler-auth.ts), publikace musí volat se service-role bearer tokenem',
};

function fail(message, code = 1) {
  console.error(`verify-edge-secrets: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = { profiles: [], all: false };
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all') {
      flags.all = true;
      continue;
    }
    if (arg === '--profile' || arg === '-p') {
      const value = args[index + 1];
      if (!value) fail('přepínač --profile vyžaduje hodnotu, např. --profile youtube,ai', 2);
      flags.profiles.push(...value.split(','));
      index += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      flags.profiles.push(...arg.slice('--profile='.length).split(','));
      continue;
    }
    fail(`neznámý přepínač ${arg}; použij --profile <seznam> nebo --all`, 2);
  }
  return flags;
}

function selectRequirement(flags) {
  const explicit = (process.env.SONGCRAFT_REQUIRED_SECRETS ?? '').trim();
  if (explicit) {
    return {
      required: explicit.split(',').map((name) => name.trim()).filter(Boolean),
      profiles: ['explicit(SONGCRAFT_REQUIRED_SECRETS)'],
    };
  }

  const requested = new Set(flags.profiles);
  for (const profile of (process.env.SONGCRAFT_PROFILES ?? '').split(',')) {
    if (profile.trim()) requested.add(profile.trim());
  }
  if (flags.all) {
    for (const profile of Object.keys(OPTIONAL_BY_PROFILE)) requested.add(profile);
  }

  const known = Object.keys(OPTIONAL_BY_PROFILE);
  const unknown = [...requested].filter((profile) => !known.includes(profile));
  if (unknown.length > 0) {
    fail(`neznámý profil: ${unknown.join(', ')}; známé profily: ${known.join(', ')}`, 2);
  }

  const active = [...requested].sort((left, right) => known.indexOf(left) - known.indexOf(right));
  const required = [...BASE_REQUIRED];
  for (const profile of active) required.push(...OPTIONAL_BY_PROFILE[profile]);
  return { required, profiles: ['base', ...active] };
}

function profilesFor(name) {
  const owners = [];
  if (BASE_REQUIRED.includes(name)) owners.push('base');
  for (const [profile, names] of Object.entries(OPTIONAL_BY_PROFILE)) {
    if (names.includes(name)) owners.push(profile);
  }
  return owners;
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
  const { required, profiles } = selectRequirement(parseArgs(process.argv));

  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) fail(`cannot list secrets (HTTP ${response.status})`);
  const body = await response.json();
  const entries = Array.isArray(body) ? body : (body?.secrets ?? []);
  const names = new Set(entries.map((entry) => String(entry?.name ?? entry?.secret_name ?? '')).filter(Boolean));

  console.log(`project ${ref}: ${names.size} secret name(s) present`);
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    console.error(`missing secret names (profiles: ${profiles.join(', ')}):`);
    for (const name of missing) {
      const owners = profilesFor(name).map((profile) => `"${profile}"`).join('+');
      console.error(`  - ${name} — profil ${owners}: ${IMPACT[name] ?? 'důsledek není popsaný'}`);
    }
    fail(`${missing.length} required secret(s) missing`);
  }
  console.log(`all ${required.length} required edge secret names present (profiles: ${profiles.join(', ')})`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
