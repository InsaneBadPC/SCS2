#!/usr/bin/env bash
# Production deployment helper for SongCraft Studio (Supabase).
#
# Fail-closed and secret-safe: no secret value is ever echoed, no secret is
# written into the repository. The Supabase personal access token is read from
# the environment (or from a file passed with --token-file) and used for the
# Management API only; database migrations are applied through the Management
# API `database/query` endpoint, so no database password is required.
#
#   1. legacy storage-path preflight (read-only)
#   2. pending migrations + migration ledger
#   3. Edge Function secrets from a local .env file
#   4. Edge Function deploys (server-side bundle, no Docker needed)
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=... scripts/deploy-production.sh --preflight
#   SUPABASE_ACCESS_TOKEN=... scripts/deploy-production.sh --migrations
#   SUPABASE_ACCESS_TOKEN=... SONGCRAFT_SECRETS_FILE=/path/to/secrets.env \
#       scripts/deploy-production.sh --secrets --functions
#   scripts/deploy-production.sh --all --secrets-file /path/to/secrets.env
#
# The secrets file is local only (never commit it); it must contain the names
# listed in docs/DEPLOYMENT_RUNBOOK.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_ONLY=0
SECRETS=0
FUNCTIONS=0
SECRETS_FILE=""
TOKEN_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --all) MIGRATIONS_ONLY=1; SECRETS=1; FUNCTIONS=1 ;;
    --preflight) MIGRATIONS_ONLY=1; SECRETS=0; FUNCTIONS=0 ;;
    --migrations) MIGRATIONS_ONLY=1; SECRETS=0; FUNCTIONS=0 ;;
    --secrets) SECRETS=1; FUNCTIONS=0 ;;
    --functions) SECRETS=0; FUNCTIONS=1 ;;
    --secrets-file) SECRETS_FILE="${2:-}"; SECRETS=1; shift ;;
    --token-file) TOKEN_FILE="${2:-}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MIGRATIONS_ONLY" = 0 ] && [ "$SECRETS" = 0 ] && [ "$FUNCTIONS" = 0 ]; then
  echo "nothing to do: pass --preflight, --migrations, --secrets, --functions or --all" >&2
  exit 2
fi

if [ -n "$TOKEN_FILE" ]; then
  SUPABASE_ACCESS_TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"
  export SUPABASE_ACCESS_TOKEN
fi

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [ -z "$PROJECT_REF" ]; then
  PROJECT_REF="$(grep -oE 'https://[a-z0-9]{20}\.supabase\.co' "$ROOT/lib/supabase.ts" | head -1 | sed -E 's#https://([a-z0-9]{20})\.supabase\.co#\1#')"
fi
if [ -z "$PROJECT_REF" ]; then
  echo "could not determine SUPABASE_PROJECT_REF" >&2
  exit 1
fi
export SUPABASE_PROJECT_REF="$PROJECT_REF"
echo "project ref: $PROJECT_REF"

if [ "$MIGRATIONS_ONLY" = 1 ]; then
  node "$ROOT/scripts/apply-migrations.mjs" --preflight
  if [ "${APPLY_MIGRATIONS:-0}" = "1" ]; then
    node "$ROOT/scripts/apply-migrations.mjs" --apply-all
  else
    node "$ROOT/scripts/apply-migrations.mjs" --dry-run
  fi
fi

if [ "$SECRETS" = 1 ]; then
  SECRETS_FILE="${SECRETS_FILE:-${SONGCRAFT_SECRETS_FILE:-}}"
  if [ -z "$SECRETS_FILE" ]; then
    echo "no secrets file given (--secrets-file / SONGCRAFT_SECRETS_FILE)" >&2
    exit 2
  fi
  if [ ! -f "$SECRETS_FILE" ]; then
    echo "secrets file not found: $SECRETS_FILE" >&2
    exit 1
  fi
  missing=0
  for name in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
    GOOGLE_AI_STUDIO_KEY YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET YOUTUBE_REDIRECT_URI \
    SONGCRAFT_ALLOWED_USER_IDS SONGCRAFT_ALLOWED_EMAILS SONGCRAFT_APP_REDIRECT_URL \
    SYNC_STATS_CRON_SECRET PUBLISH_SCHEDULER_SECRET; do
    if ! grep -qE "^${name}=" "$SECRETS_FILE"; then
      echo "missing required secret name: $name" >&2
      missing=1
    fi
  done
  if [ "$missing" = 1 ]; then
    echo "secrets file incomplete — refusing to deploy partial configuration" >&2
    exit 1
  fi
  supabase secrets set --project-ref "$PROJECT_REF" --env-file "$SECRETS_FILE"
  echo "secrets: set"
fi

if [ "$FUNCTIONS" = 1 ]; then
  # Only these functions are part of the production surface; the legacy
  # songcraft-studio-assistant / songcraft-youtube copies are intentionally
  # kept deployable only if explicitly requested.
  supabase functions deploy --project-ref "$PROJECT_REF" --use-api \
    agent-orchestrator agent-confirm songcraft-youtube video-renderer-dispatch \
    songcraft-media songcraft-cover-ai youtube-publish youtube-publish-scheduler \
    youtube-sync-stats youtube-oauth-start youtube-oauth-callback
  echo "functions: deployed"
fi

echo "deploy-production: done"
