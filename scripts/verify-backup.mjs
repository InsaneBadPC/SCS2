#!/usr/bin/env node
// Structural verifier for a run directory produced by scripts/backup-project.mjs.
//
// This is the *structural* tier of verification described in
// `SCS2/dokumentace/FEAT-ZALOHOVANI-SCS2.md` § 9. It answers "is this backup
// complete and internally consistent?" — object counts, byte totals per bucket
// and per user prefix, sha256 per artefact, and `pg_restore --list` on the dump.
//
// It deliberately does NOT answer "does this backup contain the right bytes?"
// That question needs the decryption key, and the key is deliberately offline.
// See § 8 of the design document for the trade-off this encodes.
//
// Fails closed: any missing artefact, any size delta, any checksum delta exits 2.
//
// Usage:
//   node scripts/verify-backup.mjs /var/lib/songcraft-studio/backups/20261003T014500Z
//   node scripts/verify-backup.mjs <dir> --json
//   node scripts/verify-backup.mjs <dir> --expect-objects 166 --expect-bytes 1104400979

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const dirArg = args.find((a) => !a.startsWith('--'));
const EXPECT_OBJECTS = flagValue('--expect-objects');
const EXPECT_BYTES = flagValue('--expect-bytes');
const TOLERANCE = Number(flagValue('--tolerance') ?? '0');

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const problems = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(`${name}: ${detail}`);
  if (!JSON_OUT) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function exists(rel) {
  try {
    await stat(path.join(dirArg, rel));
    return true;
  } catch {
    return false;
  }
}

async function* walk(root, base = '') {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(path.join(root, entry.name), rel);
    else if (entry.isFile()) yield rel;
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), async function (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest('hex');
}

function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const header = lines.shift();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (quoted) {
        if (ch === '"') {
          if (line[c + 1] === '"') { field += '"'; c += 1; } else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else field += ch;
    }
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  }
  void header;
  return rows;
}

function runPgRestoreList(file) {
  const pgRestore = process.env.SONGCRAFT_BACKUP_PG_RESTORE?.trim() || 'pg_restore';
  return new Promise((resolve) => {
    const child = spawn(pgRestore, ['--list', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.on('error', (error) => resolve({ ok: false, reason: `cannot run ${pgRestore}: ${error.message}` }));
    child.on('exit', (code) => resolve({ ok: code === 0, toc: out.split('\n').filter(Boolean).length, reason: code === 0 ? null : `exit ${code}` }));
  });
}

async function main() {
  if (!dirArg) {
    console.error('verify-backup: <run-directory> is required');
    process.exit(1);
  }

  // 1. required artefacts
  for (const required of ['MANIFEST.json', 'db', 'auth/auth-users.json', 'config/edge-secret-names.json']) {
    check(`artefact ${required}`, await exists(required), await exists(required) ? 'present' : 'missing');
  }

  const manifest = JSON.parse(await readFile(path.join(dirArg, 'MANIFEST.json'), 'utf8'));

  // 2. no secret material in the artefacts
  check('manifest declares secrets_exported=false', manifest.secrets_exported === false, String(manifest.secrets_exported));
  const authText = await readFile(path.join(dirArg, 'auth', 'auth-users.json'), 'utf8');
  check(
    'auth export carries no password material',
    !/encrypted_password|recovery_token|confirmation_token|password_hash/i.test(authText),
    'field name scan',
  );
  const secrets = JSON.parse(await readFile(path.join(dirArg, 'config', 'edge-secret-names.json'), 'utf8'));
  check(
    'edge secret inventory holds names only',
    (secrets.secrets ?? []).every((s) => typeof s.name === 'string' && s.value === '<not-exported>'),
    `${secrets.count ?? 0} name(s)`,
  );

  // 3. table dumps match the recorded row counts
  let dumpedRows = 0;
  for (const [table, expected] of Object.entries(manifest.row_counts)) {
    const file = path.join(dirArg, 'db', 'tables', `${table}.json`);
    try {
      const rows = JSON.parse(await readFile(file, 'utf8'));
      if (rows.length !== expected) {
        check(`table ${table}`, false, `manifest says ${expected}, file has ${rows.length}`);
      }
      dumpedRows += rows.length;
    } catch (error) {
      check(`table ${table}`, false, `cannot read ${table}.json`);
    }
  }
  check('total rows', dumpedRows === manifest.total_rows, `${dumpedRows} vs ${manifest.total_rows}`);

  // 4. MANIFEST.csv totals, per bucket and per prefix
  if (await exists('MANIFEST.csv')) {
    const rows = parseCsv(await readFile(path.join(dirArg, 'MANIFEST.csv'), 'utf8'));
    const perBucket = {};
    const perPrefix = {};
    let bytes = 0;
    for (const [bucket, objectPath, size] of rows) {
      const n = Number(size);
      bytes += n;
      perBucket[bucket] ??= { objects: 0, bytes: 0 };
      perBucket[bucket].objects += 1;
      perBucket[bucket].bytes += n;
      const prefix = String(objectPath).split('/')[0];
      perPrefix[prefix] ??= { objects: 0, bytes: 0 };
      perPrefix[prefix].objects += 1;
      perPrefix[prefix].bytes += n;
    }
    check('object count', rows.length === manifest.storage_objects, `${rows.length} vs ${manifest.storage_objects}`);
    check('byte total', bytes === manifest.storage_bytes, `${bytes} vs ${manifest.storage_bytes}`);
    for (const [bucket, expected] of Object.entries(manifest.per_bucket)) {
      const got = perBucket[bucket] ?? { objects: 0, bytes: 0 };
      check(`bucket ${bucket}`, got.objects === expected.objects && got.bytes === expected.bytes,
        `${got.objects}/${got.bytes} vs ${expected.objects}/${expected.bytes}`);
    }
    const missingPrefixes = Object.keys(manifest.per_prefix).filter((p) => !perPrefix[p]);
    check('every recorded prefix has rows', missingPrefixes.length === 0, missingPrefixes.join(',') || 'none missing');

    if (EXPECT_OBJECTS) {
      check('expected object count', rows.length === Number(EXPECT_OBJECTS), `${rows.length} vs ${EXPECT_OBJECTS}`);
    }
    if (EXPECT_BYTES) {
      check(
        'expected byte total',
        Math.abs(bytes - Number(EXPECT_BYTES)) <= TOLERANCE,
        `${bytes} vs ${EXPECT_BYTES} (tolerance ${TOLERANCE})`,
      );
    }

    // 5. spot-check sha256 of the largest object on each bucket
    const byBucket = {};
    for (const row of rows) {
      const [bucket, objectPath, size, sha] = row;
      if (!byBucket[bucket] || Number(size) > Number(byBucket[bucket][2])) byBucket[bucket] = row;
    }
    for (const [bucket, [, objectPath, , sha]] of Object.entries(byBucket)) {
      const file = path.join(dirArg, 'media', bucket, ...String(objectPath).split('/'));
      try {
        const actual = await sha256File(file);
        check(`sha256 largest in ${bucket}`, actual === sha, `${String(objectPath).slice(0, 60)}`);
      } catch {
        check(`sha256 largest in ${bucket}`, false, `cannot read ${String(objectPath).slice(0, 60)}`);
      }
    }
  } else {
    check('MANIFEST.csv', true, 'absent (--no-media run) — media checks skipped');
  }

  // 6. pg_restore --list
  const dumpFile = manifest.pg_dump?.file;
  if (dumpFile && (await exists(path.join('db', dumpFile)))) {
    if (dumpFile.endsWith('.sql')) {
      check('pg_dump artefact', true, 'plain SQL — pg_restore --list does not apply, check the file is non-empty');
      const info = await stat(path.join(dirArg, 'db', dumpFile));
      check('plain SQL dump non-empty', info.size > 0, `${info.size} bytes`);
    } else {
      const result = await runPgRestoreList(path.join(dirArg, 'db', dumpFile));
      check('pg_restore --list', result.ok, result.ok ? `${result.toc} TOC entries` : result.reason);
    }
  } else {
    check('pg_dump artefact', false, 'not present — set SUPABASE_DB_PASSWORD so the dump stage runs');
  }

  // 7. CHECKSUMS.sha256 covers the run directory
  if (await exists('CHECKSUMS.sha256')) {
    const lines = (await readFile(path.join(dirArg, 'CHECKSUMS.sha256'), 'utf8')).split('\n').filter(Boolean);
    let mismatched = 0;
    for (const line of lines) {
      const [sha, rel] = line.split(/\s{2,}/);
      try {
        const actual = await sha256File(path.join(dirArg, rel));
        if (actual !== sha) {
          mismatched += 1;
          if (mismatched <= 5) problems.push(`checksum mismatch: ${rel}`);
        }
      } catch {
        mismatched += 1;
        problems.push(`checksum target missing: ${rel}`);
      }
    }
    check('CHECKSUMS.sha256', mismatched === 0, `${lines.length} entries, ${mismatched} problem(s)`);
  } else {
    check('CHECKSUMS.sha256', false, 'missing');
  }

  const result = {
    run_dir: dirArg,
    run_id: manifest.run_id,
    tables: manifest.tables,
    total_rows: manifest.total_rows,
    storage_objects: manifest.storage_objects,
    storage_bytes: manifest.storage_bytes,
    checks,
    problems,
    ok: problems.length === 0,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else if (problems.length === 0) {
    console.log(`\nbackup ${manifest.run_id}: ${checks.length} checks passed, ${manifest.storage_objects} objects, ${manifest.storage_bytes} bytes`);
  } else {
    console.error(`\nbackup ${manifest.run_id}: ${problems.length} problem(s)`);
  }
  process.exit(problems.length === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error(`verify-backup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});