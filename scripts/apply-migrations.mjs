#!/usr/bin/env node
// Fail-closed migration runner for SongCraft Studio.
//
// Uses the Supabase Management API `database/query` endpoint, so it only needs a
// personal access token (`SUPABASE_ACCESS_TOKEN`) — no database password, no
// Docker, no local Postgres. Every migration runs in exactly one statement batch
// together with its ledger row, so a failure can never leave a half-applied
// version behind.
//
// The token is never printed, logged or written to disk by this script.
//
// Usage:
//   node scripts/apply-migrations.mjs --preflight
//   node scripts/apply-migrations.mjs --dry-run
//   node scripts/apply-migrations.mjs [--token-file <path>]
//
// Environment:
//   SUPABASE_ACCESS_TOKEN  management API token (required for --preflight/apply)
//   SUPABASE_PROJECT_REF   20 char project ref (also accepts SUPABASE_PROJECT_ID;
//                          default: parsed from lib/supabase.ts)

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MANAGEMENT_API = 'https://api.supabase.com';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const DRY_RUN = hasFlag('--dry-run');
const PREFLIGHT_ONLY = hasFlag('--preflight');
const APPLY_ALL = hasFlag('--apply-all');

function fail(message) {
  console.error(`apply-migrations: ${message}`);
  process.exit(1);
}

async function resolveToken() {
  const tokenFile = flagValue('--token-file');
  if (tokenFile) {
    if (!existsSync(tokenFile)) fail(`token file not found: ${tokenFile}`);
    const value = (await readFile(tokenFile, 'utf8')).trim();
    if (!value) fail(`token file is empty: ${tokenFile}`);
    return value;
  }
  const fromEnv = (process.env.SUPABASE_ACCESS_TOKEN ?? '').trim();
  if (!fromEnv) {
    fail(
      'SUPABASE_ACCESS_TOKEN is not set. Export it in your shell or pass --token-file <path>. ' +
        'The value is never printed or stored by this script.',
    );
  }
  return fromEnv;
}

async function resolveProjectRef() {
  const fromEnv = (process.env.SUPABASE_PROJECT_REF ?? process.env.SUPABASE_PROJECT_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const source = await readFile(path.join(ROOT, 'lib', 'supabase.ts'), 'utf8');
  const match = source.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!match) fail('could not determine project ref; set SUPABASE_PROJECT_REF');
  return match[1];
}

async function api(token, { method, endpoint, body }) {
  const response = await fetch(`${MANAGEMENT_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 401
        ? 'token is invalid or expired'
        : response.status === 403
          ? 'token is valid but has no access to this project'
          : `HTTP ${response.status}`;
    const detail = text.slice(0, 400).replace(/\s+/g, ' ');
    throw new Error(`${method} ${endpoint} failed: ${hint} — ${detail}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const query = (token, ref, sql) => api(token, { method: 'POST', endpoint: `/v1/projects/${ref}/database/query`, body: { query: sql } });

// Removes only top-level transaction control statements. Dollar-quoted bodies
// (DO $$ ... $$ / function bodies) are tracked so a `BEGIN` inside plpgsql is
// never touched — the Management API already runs the batch in one transaction.
export function stripTopLevelTransactions(sql) {
  const out = [];
  let inDollar = false;
  let tag = null;
  for (const line of sql.split('\n')) {
    const openers = [...line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$/g)];
    let skip = false;
    if (!inDollar) {
      const stripped = line.trim().toLowerCase();
      skip =
        /^(begin|start transaction|commit|end)\s*;\s*$/.test(stripped) ||
        /^(begin|start transaction)\s*;?\s*--/.test(stripped);
    }
    for (const match of openers) {
      if (!inDollar) {
        inDollar = true;
        tag = match[0];
      } else if (match[0] === tag) {
        inDollar = false;
        tag = null;
      }
    }
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

async function localMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) fail('no migration files found');
  return files.map((name) => {
    const version = name.split('_')[0];
    if (!/^\d{14}$/.test(version)) fail(`migration without 14 digit version prefix: ${name}`);
    return { file: name, version, label: name.slice(15).replace(/\.sql$/, '') };
  });
}

const LEDGER_DDL = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text not null,
  statements text[],
  inserted_at timestamptz not null default now()
);`;

async function appliedVersions(token, ref) {
  await query(token, ref, LEDGER_DDL);
  const result = await query(
    token,
    ref,
    'select version from supabase_migrations.schema_migrations order by version asc;',
  );
  const rows = Array.isArray(result) ? result : (result?.result ?? []);
  return new Set(rows.map((row) => String(row.version ?? row)));
}

const PATH_COLUMNS = {
  agent_videos: ['storage_path', 'output_path', 'audio_storage_path'],
  agent_image_assets: ['base_image_path', 'final_image_path', 'render_url'],
  agent_media_uploads: ['storage_path'],
  sc_cover_jobs: ['storage_path', 'output_path', 'cover_path'],
  sc_songs: ['cover_url', 'cover_path', 'audio_path'],
};

async function runPreflight(token, ref) {
  // 1) existující tabulky a sloupce (aby se nekonal dotaz na neexistující sloupec)
  const inventory = await query(
    token,
    ref,
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in (${Object.keys(PATH_COLUMNS).map((name) => `'${name}'`).join(', ')})`,
  );
  const rows = Array.isArray(inventory) ? inventory : (inventory?.result ?? []);
  const present = new Map();
  for (const row of rows) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name).add(row.column_name);
  }

  // 2) fail-closed kontrola legacy cest (prefix ${user_id}/)
  const parts = [];
  const checked = [];
  for (const [table, columns] of Object.entries(PATH_COLUMNS)) {
    if (!present.has(table)) {
      console.log(`preflight: table ${table} není v tomto projektu - přeskočeno`);
      continue;
    }
    for (const column of columns) {
      if (!present.get(table).has(column)) continue;
      parts.push(
        `select '${table}.${column}' as source, count(*)::int as legacy_paths
           from public."${table}"
          where "${column}" is not null
            and ("${column}" like '/%'
              or "${column}" like '..%'
              or "${column}" like '%/../%'
              or "${column}" like '%\\\\%')`,
      );
      checked.push(`${table}.${column}`);
    }
  }

  if (parts.length === 0) {
    console.log('preflight: žádné path sloupce k ověření');
    return;
  }

  let result;
  try {
    result = await query(token, ref, `${parts.join('\nunion all\n')};`);
  } catch (error) {
    fail(
      `preflight se nepodařilo provést (fail-closed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const resultRows = Array.isArray(result) ? result : (result?.result ?? []);
  const offenders = resultRows.filter((row) => Number(row.legacy_paths ?? 0) > 0);
  for (const row of resultRows) {
    console.log(`preflight: ${row.source} legacy paths = ${row.legacy_paths ?? 0}`);
  }
  if (offenders.length > 0) {
    fail(
      `legacy storage paths v: ${offenders.map((row) => row.source).join(', ')}. ` +
        'Přesuň nebo oprav objekty ručně - hardening migrace je fail-closed a nesmí se obejít.',
    );
  }
  console.log(`preflight: OK (${checked.length} sloupců: ${checked.join(', ')})`);
}

async function main() {
  const ref = await resolveProjectRef();
  const migrations = await localMigrations();
  console.log(`project ref: ${ref}`);
  console.log(`local migrations: ${migrations.length}`);

  if (DRY_RUN) {
    for (const migration of migrations) console.log(`  ${migration.version}  ${migration.label}`);
    console.log('dry run: nothing was executed');
    return;
  }

  const token = await resolveToken();
  await api(token, { method: 'GET', endpoint: `/v1/projects/${ref}` });
  console.log('token: accepted for this project');

  await runPreflight(token, ref);

  const applied = await appliedVersions(token, ref);
  const local = new Set(migrations.map((migration) => migration.version));
  const unknown = [...applied].filter((version) => !local.has(version));
  const pending = migrations.filter((migration) => !applied.has(migration.version));
  console.log(`applied: ${applied.size}, pending: ${pending.length}`);
  if (unknown.length > 0) console.log(`applied mimo lokální repo: ${unknown.join(', ')}`);

  if (pending.length === 0) {
    console.log('nothing to apply — ledger is up to date');
    return;
  }

  if (PREFLIGHT_ONLY) {
    console.log('preflight mode: no migrations applied');
    return;
  }

  if (!APPLY_ALL) {
    console.log('re-run with --apply-all to execute the pending migrations');
    return;
  }

  for (const migration of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, migration.file), 'utf8');
    const body = stripTopLevelTransactions(sql);
    // Dollar-quoted tag, který se v migracích nevyskytuje: `$$` těla plpgsql
    // zůstávají nedotčená a není potřeba žádné escapování.
    const ledger = [
      'insert into supabase_migrations.schema_migrations (version, name, statements)',
      `values ('${migration.version}', '${migration.label}', array[$songcraft_migration$${sql}$songcraft_migration$])`,
      'on conflict (version) do nothing;',
    ].join('\n');
    process.stdout.write(`applying ${migration.version} ${migration.label} ... `);
    await query(token, ref, `${body}\n\n${ledger}`);
    console.log('ok');
  }

  const finalApplied = await appliedVersions(token, ref);
  const missing = migrations.filter((migration) => !finalApplied.has(migration.version));
  if (missing.length > 0) fail(`ledger mismatch after apply: ${missing.map((m) => m.version).join(', ')}`);
  console.log(`all ${migrations.length} migrations are recorded in the ledger`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
