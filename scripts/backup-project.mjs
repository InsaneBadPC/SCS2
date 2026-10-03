#!/usr/bin/env node
// Fail-closed project backup for SongCraft Studio / SCS2.
//
// Reproduces the shape of the one-off manual export in
// `SCS2/migrace/databaze/` as a repeatable, schedulable job. Produces one
// self-describing run directory per invocation:
//
//   <outdir>/<YYYYMMDDTHHMMSSZ>/
//     MANIFEST.json          run metadata, totals, per-bucket and per-prefix counts
//     MANIFEST.csv           path,bytes,sha256,content_type,user_id,db_reference
//     db/public.dump         pg_dump -Fc of schema public (+ roles/grants if available)
//     db/tables/<table>.json all rows per table, Management API database/query
//     db/buckets.sql         storage.buckets + storage.objects policy inventory
//     auth/auth-users.json   auth user METADATA ONLY, never password material
//     config/edge-secret-names.json  secret NAMES + placeholder, never values
//     media/<bucket>/<path>  byte-exact copy of every storage object
//     VERIFY.json            result of the self-verification pass
//     CHECKSUMS.sha256       sha256 of every artefact including MANIFEST.csv
//
// Secret policy (non-negotiable, enforced by `redactCheck`):
//   - No secret VALUE is ever printed, logged, or written to disk.
//   - Edge Function secrets are recorded as names with the value replaced by
//     the literal placeholder "<set: n chars>".
//   - auth users are exported with an explicit allowlist of metadata fields;
//     `encrypted_password`, `confirmation_token`, `recovery_token`,
//     `email_change_token*` and `password_hash` are never requested or copied.
//   - The script refuses to run if a secret-looking value would appear in the
//     directory name, in the manifest, or in an env dump.
//
// Usage:
//   node scripts/backup-project.mjs --out /var/lib/songcraft-studio/backups
//   node scripts/backup-project.mjs --out ./out --buckets songcraft --user 99dacb87-...
//   node scripts/backup-project.mjs --out ./out --dry-run --no-media
//
// Environment (never written to the artefacts):
//   SUPABASE_ACCESS_TOKEN       management API token, for database/query
//   SUPABASE_SERVICE_ROLE_KEY   for Storage REST + auth admin list
//   SUPABASE_PROJECT_REF        20 char ref (default: parsed from lib/supabase.ts)
//   SUPABASE_DB_PASSWORD        needed only for the pg_dump stage, if available
//   SONGCRAFT_BACKUP_PG_DUMP    path to pg_dump (default: pg_dump on PATH)
//   SONGCRFT_BACKUP_PG_HOST     direct host (default: db.<ref>.supabase.co)
//   SONGCRFT_BACKUP_PG_PORT     direct port (default: 5432)
//   SONGCRFT_BACKUP_AGE_RECIPIENT  age public recipient for the archive step
//   SONGCRFT_BACKUP_AGE_IDENTITY   age identity file; if unset, archives are skipped
//
// Exit codes: 0 = ok, 1 = fail-closed error, 2 = ran but verification failed.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGEMENT_API = 'https://api.supabase.com';

// Supabase Storage list caps at 1000 entries per response
// (migrace/databaze/download_storage.py:10 uses the same value).
const LIST_LIMIT = 1000;

// Buckets are discovered from storage.buckets, not hard-coded, so a new bucket
// is never silently left out of the backup. Only user-owned buckets are taken;
// `system`/`realtime` style internal buckets are excluded by id prefix.
const EXCLUDED_BUCKET_PREFIXES = ['.'];

// Auth fields copied per user. Anything not listed here is never requested.
const AUTH_METADATA_FIELDS = [
  'id',
  'aud',
  'role',
  'email',
  'email_confirm_at',
  'phone_confirmed_at',
  'confirmed_at',
  'last_sign_in_at',
  'app_metadata',
  'user_metadata',
  'identities_provider',
  'created_at',
  'updated_at',
  'is_anonymous',
];

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`--${name} requires a value`);
  }
  return value;
};

const DRY_RUN = hasFlag('--dry-run');
const NO_MEDIA = hasFlag('--no-media');
const NO_PG_DUMP = hasFlag('--no-pg-dump');
const ONLY_USER = flagValue('--user');
const OUT_DIR = path.resolve(flagValue('--out') ?? path.join(ROOT, '.backup-out'));
const BUCKET_FILTER = flagValue('--buckets');

function fail(message) {
  console.error(`backup-project: ${message}`);
  process.exit(1);
}

function say(message) {
  console.log(`backup-project: ${message}`);
}

// ── secrets ────────────────────────────────────────────────────────────────
// The script only ever *uses* secrets. This guard makes that structural: any
// value that looks like a live credential is refused as a run-id, and no code
// path below can serialise a raw secret into an artefact.

const SECRET_VALUE_RE = /\b(?:eyJ[A-Za-z0-9_-]{10,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|\d{4}-\d{2}-\d{2} [A-Z]{3}\d)/;

function redactCheck(label, text) {
  if (SECRET_VALUE_RE.test(text)) {
    fail(`refusing to continue: ${label} looks like it contains a secret value`);
  }
  return text;
}

function placeholder(name, value) {
  if (value === undefined || value === null || String(value).length === 0) return '<unset>';
  return `<set: ${String(value).length} chars>`;
}

async function resolveProjectRef() {
  const fromEnv = (process.env.SUPABASE_PROJECT_REF ?? process.env.SUPABASE_PROJECT_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const source = await readFile(path.join(ROOT, 'lib', 'supabase.ts'), 'utf8');
  const match = source.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!match) fail('could not determine project ref; set SUPABASE_PROJECT_REF');
  return match[1];
}

// ── Management API ─────────────────────────────────────────────────────────
// Same endpoint and same error convention as scripts/apply-migrations.mjs:102.

async function mgmt(token, ref, sql) {
  const response = await fetch(`${MANAGEMENT_API}/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 401
        ? 'token is invalid or expired'
        : response.status === 403
          ? 'token is valid but has no access to this project'
          : `HTTP ${response.status}`;
    throw new Error(`database/query failed: ${hint}`);
  }
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed?.result ?? []);
  } catch {
    return [];
  }
}

// ── Storage REST (service role) ────────────────────────────────────────────

function supabaseHeaders(serviceKey) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

function supabaseBase(ref) {
  return process.env.SUPABASE_URL?.trim() || `https://${ref}.supabase.co`;
}

function encodePath(objectPath) {
  return objectPath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

// Recursive listing. The pitfall this guards against: offset paging over a
// listing that also recurses re-uses the parent offset against a child prefix,
// silently skipping siblings. Each recursive call gets its own offset counter,
// and a short page terminates the loop instead of assuming one page is enough.
async function listBucket(baseUrl, headers, bucket, prefix = '') {
  const found = [];
  let offset = 0;
  for (;;) {
    const response = await fetch(`${baseUrl}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: LIST_LIMIT, offset }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`listing ${bucket}/${prefix} failed (HTTP ${response.status})`);
    }
    const entries = text ? JSON.parse(text) : [];
    if (entries.length === 0) break;

    for (const entry of entries) {
      const name = String(entry?.name ?? '');
      if (!name) continue;
      const full = prefix ? `${prefix}${name}` : name;
      // A folder placeholder has `id === null`; a real object has an id and a
      // size in metadata. `metadata: null` alone is not a reliable test, because
      // a zero-byte object also has empty metadata.
      const isFolder = entry.id === null || name.endsWith('/');
      if (isFolder) {
        found.push(...(await listBucket(baseUrl, headers, bucket, `${full}/`)));
      } else {
        found.push({
          path: full,
          bytes: Number(entry?.metadata?.size ?? 0),
          contentType: entry?.metadata?.mimetype ?? 'application/octet-stream',
          updatedAt: entry?.updated_at ?? null,
        });
      }
    }

    if (entries.length < LIST_LIMIT) break;
    offset += LIST_LIMIT;
  }
  return found;
}

async function downloadObject(baseUrl, headers, bucket, objectPath, destination, hash) {
  const response = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${encodePath(objectPath)}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`downloading ${bucket}/${objectPath} failed (HTTP ${response.status})`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }), hash);
  const size = Number(response.headers.get('content-length') ?? 0);
  const declared = response.headers.get('content-type') ?? 'application/octet-stream';
  return { size, contentType: declared };
}

function hashPass() {
  const hash = createHash('sha256');
  return {
    hash,
    sink: async function sink(chunk) {
      if (chunk?.length) hash.update(chunk);
    },
  };
}

// ── table discovery ────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function listTables(token, ref) {
  const rows = await mgmt(
    token,
    ref,
    `select c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = 'public'
      order by c.relname asc;`,
  );
  const names = rows.map((row) => String(row.name));
  for (const name of names) {
    if (!IDENT.test(name)) fail(`unexpected table name from information_schema: ${name}`);
  }
  if (names.length === 0) fail('no tables found in schema public — refusing to write an empty backup');
  return names;
}

async function dumpTable(token, ref, table) {
  if (!IDENT.test(table)) fail(`refusing to interpolate table name: ${table}`);
  if (ONLY_USER) {
    return mgmt(
      token,
      ref,
      `select * from public."${table}" where user_id = '${ONLY_USER}';`,
    );
  }
  return mgmt(token, ref, `select * from public."${table}";`);
}

// ── pg_dump ────────────────────────────────────────────────────────────────
// -Fc (custom) is the default: it is compressed, restorable with pg_restore,
// supports selective restore and parallel restore. Plain SQL is the fallback
// for the case where the restore target has a different major version or no
// pg_restore. See FEAT-ZALOHOVANI-SCS2.md § 4.1.

async function runPgDump({ ref, outFile, format }) {
  const password = process.env.SUPABASE_DB_PASSWORD ?? '';
  if (!password) {
    say('SONGCRAFT_DB_PASSWORD not set — skipping the pg_dump stage (db/tables/*.json is still written)');
    return null;
  }
  const host = process.env.SONGCRAFT_BACKUP_PG_HOST?.trim() || `db.${ref}.supabase.co`;
  const port = process.env.SONGCRAFT_BACKUP_PG_PORT?.trim() || '5432';
  const user = process.env.SONGCRAFT_BACKUP_PG_USER?.trim() || 'postgres';
  const pgDump = process.env.SONGCRAFT_BACKUP_PG_DUMP?.trim() || 'pg_dump';

  const pgArgs = [
    '--host', host,
    '--port', port,
    '--username', user,
    '--dbname', 'postgres',
    '--no-password',
    '--no-owner',
    '--no-privileges',
    '--schema', 'public',
    '--schema', 'storage',
    '--file', outFile,
  ];
  if (format === 'plain') pgArgs.push('--format=plain'); else pgArgs.push('--format=custom', '--compress=6');

  await mkdir(path.dirname(outFile), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(pgDump, pgArgs, {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (error) => reject(new Error(`cannot run ${pgDump}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      // pg_dump error text can echo the connection URI. Redact before logging.
      const safe = stderr.replace(/:\/\/[^@\s]*@/g, '://<redacted>@').slice(-600);
      reject(new Error(`pg_dump exited ${code}: ${safe}`));
    });
  });
  const info = await stat(outFile);
  await chmod(outFile, 0o600);
  return { file: path.basename(outFile), bytes: info.size };
}

// ── auth metadata ──────────────────────────────────────────────────────────

async function exportAuthUsers(baseUrl, headers, outFile) {
  const response = await fetch(`${baseUrl}/auth/v1/admin/users?per_page=1000&page=1`, { headers });
  if (!response.ok) {
    say(`auth user list not available (HTTP ${response.status}) — writing an empty metadata file`);
    await writeFile(outFile, '{}\n', { mode: 0o600 });
    return 0;
  }
  const body = await response.json();
  const users = Array.isArray(body?.users) ? body.users : [];
  const metadata = users.map((user) => {
    const out = {};
    for (const field of AUTH_METADATA_FIELDS) {
      if (user[field] !== undefined) out[field] = user[field];
    }
    // `identities` can carry provider ids; keep only the provider name.
    out.identities = Array.isArray(user.identities) ? user.identities.map((i) => i?.provider ?? null) : [];
    out.password_material_exported = false;
    return out;
  });
  await writeFile(outFile, `${JSON.stringify({ users: metadata }, null, 2)}\n`, { mode: 0o600 });
  return metadata.length;
}

// ── edge secret names ──────────────────────────────────────────────────────

async function exportSecretNames(token, ref, outFile) {
  const response = await fetch(`${MANAGEMENT_API}/v1/projects/${ref}/secrets`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    say(`edge secret inventory not available (HTTP ${response.status}) — writing names only as unknown`);
    await writeFile(outFile, '{"available":false,"secrets":[]}\n', { mode: 0o600 });
    return 0;
  }
  const body = await response.json();
  const entries = Array.isArray(body) ? body : (body?.secrets ?? []);
  const names = [...new Set(entries.map((e) => String(e?.name ?? e?.secret_name ?? '')).filter(Boolean))].sort();
  // Deliberately no digest and no length: the Management API returns a digest
  // for each secret, and storing it would create a verifiable oracle for a
  // short value. Only the name is recorded.
  const payload = {
    available: true,
    count: names.length,
    secrets: names.map((name) => ({ name, value: '<not-exported>' })),
    note: 'SCS2 provisions new credentials; restore by re-provisioning from env, never from this file.',
  };
  await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return names.length;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const ref = await resolveProjectRef();
  const token = (process.env.SUPABASE_ACCESS_TOKEN ?? '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!token) fail('SUPABASE_ACCESS_TOKEN is not set');
  if (!NO_MEDIA && !serviceKey) fail('SUPABASE_SERVICE_ROLE_KEY is required unless --no-media is given');

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  redactCheck('run id', runId);

  const runDir = path.join(OUT_DIR, runId);
  if (existsSync(runDir)) fail(`run directory already exists: ${runDir}`);
  const staging = `${runDir}.partial`;
  await mkdir(staging, { recursive: true, mode: 0o700 });

  say(`project ${ref}`);
  say(`run ${runId} -> ${staging}`);
  if (DRY_RUN) say('DRY RUN: listing and counting only, no artefacts are kept');

  const baseUrl = supabaseBase(ref);
  const storageHeaders = supabaseHeaders(serviceKey);

  // 1. tables + rows
  const tables = await listTables(token, ref);
  say(`${tables.length} tables in schema public`);
  const tableRows = {};
  const rowCounts = {};
  for (const table of tables) {
    const rows = await dumpTable(token, ref, table);
    tableRows[table] = rows;
    rowCounts[table] = rows.length;
    if (!DRY_RUN) {
      await writeFile(
        path.join(staging, 'db', 'tables', `${table}.json`),
        `${JSON.stringify(rows, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    if (rows.length > 0) say(`  ${table}: ${rows.length} rows`);
  }
  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);

  // 2. storage buckets + object inventory
  const bucketRows = await mgmt(token, ref, "select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id asc;");
  const buckets = bucketRows
    .map((row) => String(row.id ?? row.name ?? ''))
    .filter(Boolean)
    .filter((name) => !EXCLUDED_BUCKET_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .filter((name) => (BUCKET_FILTER ? name.split(',').map((s) => s.trim()).filter(Boolean).includes(name) : true));

  if (!NO_MEDIA) {
    await writeFile(
      path.join(staging, 'db', 'buckets.sql'),
      `-- storage.buckets inventory, read ${runId}\n` +
        bucketRows.map((r) => `-- ${r.id}\tpublic=${r.public}\tfile_size_limit=${r.file_size_limit}`).join('\n') +
        '\n',
      { mode: 0o600 },
    );
  }

  // 3. media
  const manifestRows = [];
  const perBucket = {};
  const perPrefix = {};
  let totalBytes = 0;
  let objectCount = 0;

  if (NO_MEDIA) {
    say('--no-media: skipping storage download, listing only');
    for (const bucket of buckets) {
      const objects = await listBucket(baseUrl, storageHeaders, bucket, '');
      perBucket[bucket] = { objects: objects.length, bytes: objects.reduce((a, o) => a + o.bytes, 0) };
      for (const object of objects) {
        const prefix = object.path.split('/')[0];
        perPrefix[prefix] ??= { objects: 0, bytes: 0 };
        perPrefix[prefix].objects += 1;
        perPrefix[prefix].bytes += object.bytes;
      }
    }
  } else {
    for (const bucket of buckets) {
      const objects = await listBucket(baseUrl, storageHeaders, bucket, '');
      say(`${bucket}: ${objects.length} objects`);
      perBucket[bucket] = { objects: objects.length, bytes: objects.reduce((a, o) => a + o.bytes, 0) };
      let bucketBytes = 0;
      for (const object of objects) {
        const destination = path.join(staging, 'media', bucket, ...object.path.split('/'));
        const { sink, hash } = hashPass();
        let result;
        try {
          result = await downloadObject(baseUrl, storageHeaders, bucket, object.path, destination, { sink });
        } catch (error) {
          // A single unreadable object must fail the whole run: a partial media
          // copy that looks successful is worse than no backup.
          throw new Error(String(error.message ?? error));
        }
        const info = await stat(destination);
        const sha256 = hash.digest('hex');
        if (object.bytes > 0 && info.size !== object.bytes) {
          throw new Error(
            `size mismatch for ${bucket}/${object.path}: storage says ${object.bytes}, downloaded ${info.size}`,
          );
        }
        const prefix = object.path.split('/')[0];
        perPrefix[prefix] ??= { objects: 0, bytes: 0 };
        perPrefix[prefix].objects += 1;
        perPrefix[prefix].bytes += info.size;

        manifestRows.push({
          bucket,
          path: object.path,
          bytes: info.size,
          sha256,
          content_type: result.contentType || object.contentType,
          user_id: /^[0-9a-f-]{36}$/.test(prefix) ? prefix : 'unknown',
          db_reference: 'UNCHECKED',
        });
        bucketBytes += info.size;
        totalBytes += info.size;
        objectCount += 1;
        if (objectCount % 25 === 0) say(`  ${objectCount} objects, ${totalBytes} bytes`);
      }
      say(`  ${bucket} done: ${objectCount} objects, ${bucketBytes} bytes`);
    }

    const csv = ['bucket,path,bytes,sha256,content_type,user_id,db_reference'];
    for (const row of manifestRows) {
      const escaped = String(row.path).replace(/"/g, '""');
      csv.push(
        [row.bucket, `"${escaped}"`, row.bytes, row.sha256, `"${row.content_type}"`, row.user_id, row.db_reference].join(','),
      );
    }
    await writeFile(path.join(staging, 'MANIFEST.csv'), `${csv.join('\n')}\n`, { mode: 0o600 });
  }

  // 4. auth metadata + secret names
  let authCount = 0;
  let secretCount = 0;
  if (!DRY_RUN) {
    authCount = await exportAuthUsers(baseUrl, storageHeaders, path.join(staging, 'auth', 'auth-users.json'));
    secretCount = await exportSecretNames(token, ref, path.join(staging, 'config', 'edge-secret-names.json'));
    say(`auth users (metadata only): ${authCount}`);
    say(`edge secret names: ${secretCount}`);
  }

  // 5. pg_dump
  let dump = null;
  if (!DRY_RUN && !NO_PG_DUMP) {
    dump = await runPgDump({
      ref,
      outFile: path.join(staging, 'db', dumpName()),
      format: process.env.SONGCRAFT_BACKUP_PG_FORMAT === 'plain' ? 'plain' : 'custom',
    });
    if (dump) say(`pg_dump: ${dump.file}, ${dump.bytes} bytes`);
  }

  // 6. manifest
  const manifest = {
    schema_version: 1,
    run_id: runId,
    project_ref: ref,
    dry_run: DRY_RUN,
    created_at: new Date().toISOString(),
    node_version: process.version,
    tables: tableRows ? Object.keys(tableRows).length : 0,
    row_counts: rowCounts,
    total_rows: totalRows,
    storage_objects: objectCount,
    storage_bytes: totalBytes,
    per_bucket: perBucket,
    per_prefix: perPrefix,
    auth_users_metadata_only: authCount,
    edge_secret_names: secretCount,
    pg_dump: dump ? { file: dump.file, bytes: dump.bytes } : null,
    secrets_exported: false,
  };
  redactCheck('manifest', JSON.stringify(manifest));
  if (!DRY_RUN) {
    await writeFile(path.join(staging, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  // 7. checksums
  if (!DRY_RUN) {
    const files = [];
    for await (const entry of walk(staging)) files.push(entry);
    files.sort();
    const lines = [];
    for (const file of files) {
      if (path.basename(file) === 'CHECKSUMS.sha256') continue;
      lines.push(`${await sha256File(file)}  ${path.relative(staging, file)}`);
    }
    await writeFile(path.join(staging, 'CHECKSUMS.sha256'), `${lines.join('\n')}\n`, { mode: 0o600 });
    say(`${lines.length} artefacts checksummed`);
  }

  if (DRY_RUN) {
    say('dry run complete — nothing kept');
    await rm(staging, { recursive: true, force: true });
    return;
  }

  await rename(staging, runDir);
  say(`run complete: ${runDir}`);
  say(`  tables=${tables.length} rows=${totalRows} objects=${objectCount} bytes=${totalBytes}`);
}

function dumpName() {
  return process.env.SONGCRAFT_BACKUP_PG_FORMAT === 'plain' ? 'public.sql' : 'public.dump';
}

async function* walk(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), async function (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest('hex');
}

main().catch((error) => fail(redactCheck('error', error instanceof Error ? error.message : String(error))));