#!/usr/bin/env bash
# Orchestrator invoked by songcraft-backup.service. Do not run by hand in
# production; use systemd so the sandbox and the timeout apply.
#
#   node scripts/backup-project.mjs  -> newest run dir
#   node scripts/verify-backup.mjs    -> structural gate, must exit 0
#   age                               -> optional encryption of the tarball
#   aws s3 cp (R2)                   -> optional offsite copy
#   rclone sync (OCI Object Storage) -> optional second offsite copy
#   curl                              -> dead-man's-switch ping on success
#
# Steps after the export are individually skippable through
# /etc/songcraft-studio/backup.env so a partial failure can be retried without
# re-downloading 1 GiB.

set -Eeuo pipefail

BACKUP_ROOT="${SONGCRAFT_BACKUP_ROOT:-/var/lib/songcraft-studio/backups}"
STACK_ROOT="${SONGCRAFT_BACKUP_STACK_ROOT:-/var/lib/songcraft-studio/backups/.stack}"
NODE="${SONGCRAFT_BACKUP_NODE:-/usr/bin/node}"
REPO="${SONGCRAFT_BACKUP_REPO:-/opt/songcraft-studio}"
AGE_BIN="${SONGCRAFT_BACKUP_AGE_BIN:-age}"
CURL_BIN="${SONGCRAFT_BACKUP_CURL_BIN:-curl}"

log() { printf 'backup-run: %s\n' "$*" >&2; }
fail() { printf 'backup-run: %s\n' "$*" >&2; exit 1; }

command -v "$NODE" >/dev/null 2>&1 || fail "node not found at $NODE"

umask 077
mkdir -p "$BACKUP_ROOT" "$STACK_ROOT"

# ── 1. export ──────────────────────────────────────────────────────────────
# Full export every day. The cheap "Wednesday and Saturday are probably
# unchanged" optimisation is NOT implemented on purpose: it turns a storage
# quota into a correctness bet, and the whole point of this system is that a
# silent skip is indistinguishable from a healthy run. If the quota ever starts
# biting, the answer is a retention change or a paid tier, not a day of the week.
# See FEAT-ZALOHOVANI-SCS2.md § 6.3.
log "step 1: export (full)"
"$NODE" "$REPO/scripts/backup-project.mjs" --out "$BACKUP_ROOT"

RUN_DIR="$(ls -1d "$BACKUP_ROOT"/[0-9]*Z 2>/dev/null | sort | tail -n 1 || true)"
[[ -n "$RUN_DIR" && -d "$RUN_DIR" ]] || fail "no run directory found after export"
log "newest run: $RUN_DIR"

# ── 2. structural verification (hard gate) ─────────────────────────────────
# Verify the directory that was just produced, not a symlink target, so the
# verifier cannot be pointed at something else by a stale link.
log "step 2: verify"
"$NODE" "$REPO/scripts/verify-backup.mjs" "$RUN_DIR" \
  || fail "verification failed — the run stays on disk as evidence and is NOT uploaded"

# ── 3. encrypt ─────────────────────────────────────────────────────────────
ARCHIVE="$RUN_DIR.tar.age"
if [[ -n "${SONGCRAFT_BACKUP_AGE_RECIPIENT:-}" ]]; then
  log "step 3: encrypt with age"
  "$AGE_BIN" --recipient "$SONGCRAFT_BACKUP_AGE_RECIPIENT" \
    --output "$STACK_ROOT/$(basename "$RUN_DIR").tar.age.tmp" \
    "$RUN_DIR"
  mv "$STACK_ROOT/$(basename "$RUN_DIR").tar.age.tmp" "$ARCHIVE"
  "$AGE_BIN" --list "$ARCHIVE" >/dev/null || fail "age archive failed its own header check"
  chmod 0600 "$ARCHIVE"
  log "archive: $ARCHIVE ($(stat -c %s "$ARCHIVE") bytes)"
else
  log "step 3 skipped: SONGCRAFT_BACKUP_AGE_RECIPIENT not set — archive left unencrypted"
fi

# ── 4. upload ──────────────────────────────────────────────────────────────
if [[ -n "${SONGCRAFT_BACKUP_R2_BUCKET:-}" ]] && command -v aws >/dev/null 2>&1; then
  log "step 4a: copy to Cloudflare R2"
  aws --endpoint-url "${SONGCRAFT_BACKUP_R2_ENDPOINT:-https://${SONGCRAFT_BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com}" \
      s3 cp --only-show-errors \
      --exclude '*' --include 'MANIFEST.json' --include 'MANIFEST.csv' --include 'CHECKSUMS.sha256' \
      "$RUN_DIR/" "s3://${SONGCRAFT_BACKUP_R2_BUCKET}/$(basename "$RUN_DIR")/"
  if [[ -f "$ARCHIVE" ]]; then
    aws --endpoint-url "${SONGCRAFT_BACKUP_R2_ENDPOINT:-https://${SONGCRAFT_BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com}" \
        s3 cp --only-show-errors --storage-class STANDARD \
        "$ARCHIVE" "s3://${SONGCRAFT_BACKUP_R2_BUCKET}/archives/$(basename "$ARCHIVE")"
  fi
else
  log "step 4a skipped: R2 bucket not configured or aws CLI missing"
fi

if [[ -n "${SONGCRAFT_BACKUP_OCI_BUCKET:-}" ]] && command -v oci >/dev/null 2>&1; then
  log "step 4b: copy to Oracle Object Storage"
  oci os object put --namespace "$SONGCRAFT_BACKUP_OCI_NAMESPACE" \
     --bucket-name "$SONGCRAFT_BACKUP_OCI_BUCKET" \
     --name "$(basename "$ARCHIVE" 2>/dev/null || basename "$RUN_DIR")-manifest.json" \
     --file "$RUN_DIR/MANIFEST.json" --force --no-multipart 2>/dev/null \
    || log "  manifest copy failed (offline is acceptable; R2 copy already done)"
else
  log "step 4b skipped: OCI bucket not configured or oci CLI missing"
fi

# ── 5. retention ───────────────────────────────────────────────────────────
log "step 5: retention"
if [[ -x "$REPO/scripts/backup-retention.sh" ]]; then
  "$REPO/scripts/backup-retention.sh" --root "$BACKUP_ROOT" --dry-run="${SONGCRAFT_BACKUP_RETENTION_DRYRUN:-1}"
else
  log "  scripts/backup-retention.sh not installed — retention not applied"
fi

# ── 6. dead-man's switch ───────────────────────────────────────────────────
# Pinged LAST and only on success. Absence of the ping is the alert.
if [[ -n "${SONGCRAFT_BACKUP_HEALTHCHECKS_PING_URL:-}" ]]; then
  log "step 6: dead-man's switch"
  "$CURL_BIN" --fail --silent --show-error --max-time 20 \
    "${SONGCRAFT_BACKUP_HEALTHCHECKS_PING_URL}" \
    || log "  dead-man's switch ping failed — the monitor will alert, which is correct"
else
  log "step 6 skipped: SONGCRAFT_BACKUP_HEALTHCHECKS_PING_URL not set"
fi

log "done: $RUN_DIR"