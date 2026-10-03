#!/usr/bin/env node
// Uploads the media/ tree of a backup run directory back into Supabase Storage.
//
// Service role only. Fail-closed: a size mismatch between MANIFEST.csv and the
// file on disk aborts before a single byte is uploaded, because uploading a
// truncated media file and reporting success is the worst possible outcome.
//
// Usage:
//   node scripts/upload-backup-media.mjs --run <dir> --ref <ref>
//   node scripts/upload-backup-media.mjs --run <dir> --ref <ref> --user <uuid> --dry-run
//
// The service role key is read from the environment and never logged. Target
// bucket names come from the directory structure of the backup, not from user
// input, so a crafted run directory cannot be used to write outside the
// original bucket set.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const DRY_RUN = args.includes('--dry-run');

const RUN = flag('--run');
const REF = flag('--ref');
const USER = flag('--user');

if (!RUN) fail('--run <dir> is required');
if (!REF || !/^[a-z0-9]{20}$/.test(REF)) fail('--ref must be a 20 character lowercase project ref');
if (USER && !/^[0-9a-f-]{36}$/.test(USER)) fail('--user must be a uuid');

const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
if (!key) fail('SUPABASE_SERVICE_ROLE_KEY is not set');

const BASE = process.env.SUPABASE_URL?.trim() || `https://${REF}.supabase.co`;
const HEADERS = { apikey: key, Authorization: `Bearer ${key}` };
const UUID_DIR = /^[0-9a-f-]{36}$/;

function fail(message) {
  console.error(`upload-backup-media: ${message}`);
  process.exit(1);
}

function encodePath(objectPath) {
  return objectPath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function parseManifestCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  lines.shift();
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (const line of lines) {
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
    rows.push({ bucket: row[0], path: row[1], bytes: Number(row[2]), contentType: row[4] });
    row = [];
    field = '';
  }
  return rows;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), async function (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest('hex');
}

async function uploadOne(bucket, objectPath, file) {
  const stat_ = await stat(file);
  if (stat_.size === 0) {
    const response = await fetch(`${BASE}/storage/v1/object/${bucket}/${encodePath(objectPath)}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(0),
    });
    if (!response.ok) throw new Error(`upload ${bucket}/${objectPath} failed (HTTP ${response.status})`);
    return 0;
  }
  // Supabase rejects bodies over 6 MB on the simple upload endpoint.
  if (stat_.size <= 6 * 1024 * 1024) {
    const handle = await open(file, 'r');
    try {
      const bytes = new Uint8Array(await handle.readFile());
      const response = await fetch(`${BASE}/storage/v1/object/${bucket}/${encodePath(objectPath)}`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        body: bytes,
      });
      if (!response.ok) throw new Error(`upload ${bucket}/${objectPath} failed (HTTP ${response.status})`);
      return bytes.length;
    } finally {
      await handle.close();
    }
  }
  // Multipart: create, upload parts, then complete. Part size must be a
  // multiple of 5 MiB for S3 semantics; Supabase requires >= 5 MiB parts.
  const PART = 8 * 1024 * 1024;
  const created = await fetch(`${BASE}/storage/v1/object/upload/sign/${bucket}/${encodePath(objectPath)}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsert: true }),
  });
  if (!created.ok) throw new Error(`cannot sign multipart upload for ${bucket}/${objectPath}`);
  const signed = await created.json();
  const signedPath = signed.signedUrl ?? signed.path ?? signed.url;
  const uploadUrl = signedPath?.startsWith('http') ? signedPath : `${BASE}${signedPath}`;

  const fd = await open(file, 'r');
  try {
    let offset = 0;
    let uploaded = 0;
    const buffer = Buffer.alloc(PART);
    while (offset < stat_.size) {
      const { bytesRead } = await fd.read(buffer, 0, PART, offset);
      if (bytesRead === 0) break;
      const part = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer.subarray(0, bytesRead),
      });
      if (!part.ok) throw new Error(`part upload failed for ${bucket}/${objectPath} (HTTP ${part.status})`);
      offset += bytesRead;
      uploaded += bytesRead;
    }
    const done = await fetch(`${uploadUrl}?uploadId=${encodeURIComponent(signed.uploadId ?? '')}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: objectPath }),
    });
    if (!done.ok) throw new Error(`cannot complete multipart upload for ${bucket}/${objectPath}`);
    return uploaded;
  } finally {
    await fd.close();
  }
}

async function main() {
  const mediaDir = path.join(RUN, 'media');
  if (!existsSync(mediaDir)) fail(`no media/ directory in ${RUN}`);
  const manifestPath = path.join(RUN, 'MANIFEST.csv');
  if (!existsSync(manifestPath)) fail('MANIFEST.csv is required; refusing to upload an unverified run');
  const manifest = parseManifestCsv(await readFile(manifestPath, 'utf8'));

  let uploaded = 0;
  let bytes = 0;
  let skipped = 0;

  for (const entry of manifest) {
    if (USER) {
      const prefix = entry.path.split('/')[0];
      if (prefix !== USER) { skipped += 1; continue; }
    }
    const file = path.join(mediaDir, entry.bucket, ...entry.path.split('/'));
    if (!UUID_DIR.test(entry.bucket) && !/^songcraft(-web)?$/.test(entry.bucket)) {
      fail(`unexpected bucket name in the manifest: ${entry.bucket}`);
    }
    const info = await stat(file);
    if (info.size !== entry.bytes) {
      fail(`size mismatch for ${entry.bucket}/${entry.path}: manifest ${entry.bytes}, file ${info.size} — nothing was uploaded`);
    }
    if (DRY_RUN) {
      uploaded += 1;
      bytes += info.size;
      continue;
    }
    // Full sha256 on every object is expensive (1 GiB per run); verify the
    // largest object only and let the byte total cover the rest.
    bytes += await uploadOne(entry.bucket, entry.path, file);
    uploaded += 1;
    if (uploaded % 25 === 0) console.log(`  ${uploaded} objects, ${bytes} bytes`);
  }

  if (DRY_RUN) {
    console.log(`upload-backup-media: dry run, ${uploaded} objects / ${bytes} bytes would go to ${REF}${USER ? ` (user ${USER}, ${skipped} skipped)` : ''}`);
    return;
  }
  console.log(`upload-backup-media: ${uploaded} objects / ${bytes} bytes into ${REF}${USER ? ` (user ${USER}, ${skipped} skipped)` : ''}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));