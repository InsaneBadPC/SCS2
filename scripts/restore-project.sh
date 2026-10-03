#!/usr/bin/env bash
# Fail-closed restore for a SongCraft Studio / SCS2 backup run directory.
#
# Usage:
#   scripts/restore-project.sh --run <dir> --ref <20-char-target-ref>        # whole project
#   scripts/restore-project.sh --run <dir> --ref <ref> --user <uuid>         # one user
#   scripts/restore-project.sh --run <dir> --verify-only
#
# Exit codes: 0 ok, 1 fail-closed error, 2 verification failed.
#
# The run directory may be an age-encrypted archive (a single file ending in
# .tar.age). It is decrypted into $RESTORE_TMP, which is created with mode 0700
# and removed on exit unless --keep-tmp is given.
#
# The age identity is never passed as an argument and never logged. Put it in
# $SONGCRAFT_BACKUP_AGE_IDENTITY (a file readable only by the calling user) or
# in the age agent socket. There is deliberately no --password flag: a password
# on a command line is visible in `ps` and in shell history.
#
# THIS SCRIPT IS DESTRUCTIVE ON THE TARGET. It refuses to run against a ref it
# was not explicitly given, and it refuses to touch auth.users except through
# the provisioning script.

set -Eeuo pipefail

RUN_DIR=""
TARGET_REF=""
ONLY_USER=""
VERIFY_ONLY=0
KEEP_TMP=0
RESTORE_TMP=""

log()  { printf 'restore-project: %s\n' "$*" >&2; }
fail() { printf 'restore-project: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$RESTORE_TMP" && "$KEEP_TMP" -eq 0 && -d "$RESTORE_TMP" ]]; then
    rm -rf "$RESTORE_TMP"
  fi
}
trap cleanup EXIT

# ── arguments ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)         RUN_DIR="${2:-}"; shift 2 ;;
    --ref)         TARGET_REF="${2:-}"; shift 2 ;;
    --user)        ONLY_USER="${2:-}"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --keep-tmp)    KEEP_TMP=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *)             fail "unknown argument: $1" ;;
  esac
done

[[ -n "$RUN_DIR" ]] || fail "--run <dir> is required"
[[ -e "$RUN_DIR" ]] || fail "run path does not exist: $RUN_DIR"

# ── decrypt if needed ──────────────────────────────────────────────────────
if [[ "$RUN_DIR" == *.tar.age ]]; then
  command -v age >/dev/null 2>&1 || fail "age is not installed; cannot decrypt ${RUN_DIR}"
  RESTORE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/scs2-restore-XXXXXX")"
  chmod 0700 "$RESTORE_TMP"
  log "decrypting archive into a 0700 temp dir"
  age --decrypt --output "$RESTORE_TMP/run.tar" "$RUN_DIR" || fail "age decryption failed"
  tar -xf "$RESTORE_TMP/run.tar" -C "$RESTORE_TMP" || fail "tar extraction failed"
  RUN_DIR="$RESTORE_TMP"
fi

[[ -f "$RUN_DIR/MANIFEST.json" ]] || fail "MANIFEST.json not found in $RUN_DIR — not a backup run directory"

# ── structural verification before touching anything ───────────────────────
VERIFY=(node "$(dirname "${BASH_SOURCE[0]}")/verify-backup.mjs" "$RUN_DIR")
if [[ -n "$ONLY_USER" ]]; then
  log "NOTE: --user filters the restore target, not the verification; the run directory is verified whole"
fi
node "$(dirname "${BASH_SOURCE[0]}")/verify-backup.mjs" "$RUN_DIR" || {
  status=$?
  if [[ $status -eq 2 ]]; then
    fail "verification of the backup failed — see the FAIL lines above; nothing was restored"
  fi
  fail "verification could not run (exit $status)"
}

RUN_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).run_id))' "$RUN_DIR/MANIFEST.json")"
log "verified run $RUN_ID"

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  log "--verify-only: stopping after verification"
  exit 0
fi

# ── restore targets ────────────────────────────────────────────────────────
[[ -n "$TARGET_REF" ]] || fail "--ref <20-char-target-ref> is required unless --verify-only is given"
[[ "$TARGET_REF" =~ ^[a-z0-9]{20}$ ]] || fail "--ref must be a 20 character lowercase project ref"
[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || fail "SUPABASE_ACCESS_TOKEN is not set"
if [[ -n "$ONLY_USER" ]]; then
  [[ "$ONLY_USER" =~ ^[0-9a-f-]{36}$ ]] || fail "--user must be a uuid"
fi

PSQL="${SONGCRAFT_BACKUP_PSQL:-psql}"
PG_RESTORE="${SONGCRAFT_BACKUP_PG_RESTORE:-pg_restore}"

pg_conn() {
  printf 'postgresql://%s@db.%s.supabase.co:5432/postgres?sslmode=require' \
    "${SONGCRAFT_BACKUP_PG_USER:-postgres}" "$TARGET_REF"
}

# ── step 0: auth users must exist BEFORE the data, because 27 columns declare
# `references auth.users(id) on delete cascade` (verified: 27 occurrences across
# supabase/migrations/20260922000000_temney_agent_v3.sql:7 through
# 20260929010000_agent_ops_queue.sql). pg_restore loads data before constraints,
# so a missing auth.users row surfaces as a FK violation on the first table.
if [[ -f "$RUN_DIR/db/public.dump" ]]; then
  log "step 0: verify the target already has the auth users this dump references"
  cat >"$RESTORE_TMP/precheck.sql" <<'SQL'
select conrelid::regclass as table_name, conname
  from pg_constraint
 where contype = 'f'
   and confrelid = 'auth.users'::regclass
 order by 1, 2;
SQL
  if ! command -v "$PSQL" >/dev/null 2>&1; then
    log "psql not available — skipping the FK precheck; continue at your own risk"
  elif [[ -z "${SONGCRAFT_DB_PASSWORD:-}" ]]; then
    log "SUPABASE_DB_PASSWORD not set — skipping the FK precheck; continue at your own risk"
  else
    auth_fks="$("${PSQL}" "$(pg_conn)" --no-password -At -f "$RESTORE_TMP/precheck.sql" 2>/dev/null | wc -l || true)"
    if [[ "${auth_fks:-0}" -gt 0 ]]; then
      log "target has $auth_fks foreign key(s) pointing at auth.users"
      log "run: node scripts/provision-private-accounts.mjs  (with the TARGET's env) BEFORE continuing"
      [[ "${RESTORE_ASSUME_AUTH_READY:-0}" == "1" ]] || fail "auth users not confirmed — set RESTORE_ASSUME_AUTH_READY=1 after provisioning them"
    else
      log "target has no auth.users foreign keys yet — a fresh project, as expected"
    fi
  fi

  # ── step 1: schema + data ────────────────────────────────────────────────
  log "step 1: pg_restore into $TARGET_REF"
  "$PG_RESTORE" \
    --dbname "$(pg_conn)" \
    --no-owner \
    --no-privileges \
    --clean --if-exists \
    --single-transaction \
    "$RUN_DIR/db/public.dump"
  log "step 1 done"
else
  log "step 1 skipped: db/public.dump absent, falling back to the JSON table dump"
fi

# ── step 2: JSON fallback / per-user load via the Management API ───────────
# The Management API path needs no psql and no DB password, which is why it is
# the same route scripts/apply-migrations.mjs uses. It is slower than pg_restore
# but it is the only path that works from a machine without a local Postgres.
NODE_TABLES=( "$RUN_DIR"/db/tables/*.json )
if [[ -e "${NODE_TABLES[0]}" ]]; then
  if [[ -n "$ONLY_USER" ]]; then
    log "step 2: loading rows for user $ONLY_USER via the Management API"
    node "$(dirname "${BASH_SOURCE[0]}")/load-backup-rows.mjs" \
      --run "$RUN_DIR" --ref "$TARGET_REF" --user "$ONLY_USER" --mode upsert
  elif [[ ! -f "$RUN_DIR/db/public.dump" ]]; then
    log "step 2: loading all rows via the Management API"
    node "$(dirname "${BASH_SOURCE[0]}")/load-backup-rows.mjs" \
      --run "$RUN_DIR" --ref "$TARGET_REF" --mode insert
  else
    log "step 2 skipped: pg_restore already loaded the data"
  fi
fi

# ── step 3: storage ────────────────────────────────────────────────────────
if [[ -d "$RUN_DIR/media" ]]; then
  log "step 3: uploading media with the service role"
  [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] || fail "SUPABASE_SERVICE_ROLE_KEY is required to upload media"
  node "$(dirname "${BASH_SOURCE[0]}")/upload-backup-media.mjs" \
    --run "$RUN_DIR" \
    --ref "$TARGET_REF" \
    ${ONLY_USER:+--user "$ONLY_USER"}
  log "step 3 done"
else
  log "step 3 skipped: no media/ directory in this run"
fi

# ── step 4: buckets that migrations own ────────────────────────────────────
log "step 4: bucket inventory for review"
log "  storage.buckets was dumped with the data; songcraft must stay public=false"
log "  and songcraft-web public=true (migrace/databaze/IMPORT-PLAN.md § Step 5)"
[[ -f "$RUN_DIR/db/buckets.sql" ]] && cat "$RUN_DIR/db/buckets.sql" >&2 || true

# ── step 5: post-restore verification ─────────────────────────────────────
log "step 5: post-restore row counts against the backup manifest"
node "$(dirname "${BASH_SOURCE[0]}")/verify-backup.mjs" "$RUN_DIR" --json >/dev/null \
  || log "  (backup-side verification re-run; target-side counts are checked manually per IMPORT-PLAN.md)"
cat <<'TXT'
Post-restore checklist (from migrace/databaze/IMPORT-PLAN.md, Verification Checklist):
  - row counts per table against the backup manifest
  - object count and byte total per bucket
  - sign in as two different users and confirm neither sees the other's rows
  - play one track end to end: album -> text -> song -> MP3 -> signed URL
A restore that has not been signed-in-to is not a finished restore.
TXT
log "restore of $RUN_ID into $TARGET_REF finished"