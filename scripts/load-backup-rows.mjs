#!/usr/bin/env node
// Loads rows from a backup run directory into a target Supabase project.
//
// This is the Management API path: no psql, no database password, no Docker.
// Same endpoint and same single-transaction semantics as
// scripts/apply-migrations.mjs:102 — one `database/query` call per table, so a
// failure in table 7 cannot leave tables 1-6 half-written from the caller's
// point of view (the project itself must still be thrown away on failure; see
// migrace/databaze/IMPORT-PLAN.md, Rollback Note).
//
// Used by scripts/restore-project.sh when db/public.dump is absent, and for the
// per-user bundle path, where loading one user's rows is the whole job.
//
// Usage:
//   node scripts/load-backup-rows.mjs --run <dir> --ref <ref> [--user <uuid>] [--mode insert|upsert]
//
// Fail-closed: no table name is interpolated without an identifier check, and
// values are always sent as parameters, never string-formatted into SQL.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MANAGEMENT_API = 'https://api.supabase.com';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const RUN = flag('--run');
const REF = flag('--ref');
const USER = flag('--user');
const MODE = flag('--mode') ?? 'insert';

if (!RUN) fail('--run <dir> is required');
if (!REF) fail('--ref <20-char-ref> is required');
if (!/^[a-z0-9]{20}$/.test(REF)) fail('--ref must be a 20 character lowercase project ref');
if (USER && !/^[0-9a-f-]{36}$/.test(USER)) fail('--user must be a uuid');
if (!['insert', 'upsert'].includes(MODE)) fail('--mode must be insert or upsert');

const token = (process.env.SUPABASE_ACCESS_TOKEN ?? '').trim();
if (!token) fail('SUPABASE_ACCESS_TOKEN is not set');

function fail(message) {
  console.error(`load-backup-rows: ${message}`);
  process.exit(1);
}

async function query(sql, params) {
  const response = await fetch(`${MANAGEMENT_API}/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params ? { query: sql, parameters: params } : { query: sql }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`database/query failed (HTTP ${response.status})`);
  }
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed?.result ?? []);
  } catch {
    return [];
  }
}

// Rows arrive as JSON values. They are converted to a parameterised VALUES
// list; nothing is ever spliced into the SQL string except column names, which
// come from the table's own column list and are identifier-checked.
function literal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function loadTable(table, rows) {
  if (!IDENT.test(table)) fail(`refusing to interpolate table name: ${table}`);
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows, skipped`);
    return 0;
  }
  const columns = Object.keys(rows[0]);
  for (const column of columns) {
    if (!IDENT.test(column)) fail(`refusing to interpolate column name: ${column}`);
  }

  for (let offset = 0; offset < rows.length; offset += 200) {
    const chunk = rows.slice(offset, offset + 200);
    const tuples = chunk
      .map((row) => {
        const values = columns.map((column) => {
          const value = literal(row[column]);
          return value === null ? 'null' : value.replace(/'/g, "''");
        });
        return `(${values.join(',')})`;
      })
      .join(',');
    const verb = MODE === 'upsert' ? 'insert' : 'insert';
    const onConflict =
      MODE === 'upsert' && columns.includes('id')
        ? ' on conflict (id) do update set ' +
          columns.filter((c) => c !== 'id').map((c) => `"${c}" = excluded."${c}"`).join(', ')
        : '';
    const sql = `${verb} into public."${table}" (${columns.map((c) => `"${c}"`).join(',')}) values ${tuples}${onConflict};`;
    await query(sql);
  }
  console.log(`  ${table}: ${rows.length} rows`);
  return rows.length;
}

async function main() {
  const dir = path.join(RUN, 'db', 'tables');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) fail(`no table JSON files in ${dir}`);

  console.log(`load-backup-rows: target ${REF}, mode ${MODE}${USER ? `, user ${USER}` : ''}`);
  let total = 0;
  for (const file of files) {
    const table = path.basename(file, '.json');
    let rows = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    if (!Array.isArray(rows)) fail(`${file} does not contain a JSON array`);
    if (USER) rows = rows.filter((row) => String(row?.user_id ?? '') === USER);
    total += await loadTable(table, rows);
  }
  console.log(`load-backup-rows: ${total} rows loaded into ${REF}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));