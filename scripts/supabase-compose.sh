#!/usr/bin/env bash
# Linux launcher for the Tokyo production server. Mirrors
# scripts/supabase-compose.ps1 (tiers, two workers, write gates) but:
#   - always layers docker-compose.production.yml (formal origin, release
#     image tags, log rotation);
#   - never layers docker-compose.dns.local.yml (workstation-only resolvers);
#   - never enables the video-export profile (MP4 needs 8 GiB on its own);
#   - never builds Next.js on the server: start/apply use prebuilt images.
#
# Usage:
#   scripts/supabase-compose.sh <config|start|apply|readiness|status> \
#     [--tier 4|8|16] [--mode background|foreground] [--env-file PATH] \
#     [--accept-jobs --confirm-writes]
#
# Required in the environment or env files: ZHIYU_WEB_IMAGE, ZHIYU_WORKER_IMAGE
# (explicit release tags) plus the settings checked below.
set -euo pipefail

usage() {
  sed -n '10,14p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

action="${1:-config}"
[[ $# -gt 0 ]] && shift
tier=4
mode=background
env_file=.env.hosted.local
accept_jobs=0
confirm_writes=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier) tier="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --env-file) env_file="${2:-}"; shift 2 ;;
    --accept-jobs) accept_jobs=1; shift ;;
    --confirm-writes) confirm_writes=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

case "$action" in config|start|apply|readiness|status) ;; *) usage ;; esac
case "$mode" in background|foreground) ;; *) echo 'Mode must be background or foreground.' >&2; exit 2 ;; esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/docker-compose.supabase.yml"
production_file="$repo_root/docker-compose.production.yml"
base_env_path="$repo_root/.env.local"
if [[ "$env_file" = /* ]]; then env_path="$env_file"; else env_path="$repo_root/$env_file"; fi

[[ -f "$compose_file" ]] || { echo 'docker-compose.supabase.yml is missing.' >&2; exit 1; }
[[ -f "$production_file" ]] || { echo 'docker-compose.production.yml is missing.' >&2; exit 1; }
[[ -f "$env_path" ]] || {
  echo 'Private Supabase env file is missing. Copy .env.hosted.example to .env.hosted.local.' >&2
  exit 1
}

# Check names only; secret values stay inside Docker Compose and are never
# printed. Compose still passes only its explicit allowlist into containers.
env_paths=()
[[ -f "$base_env_path" ]] && env_paths+=("$base_env_path")
env_paths+=("$env_path")
declared_names="$(grep -hoE '^[[:space:]]*[A-Z][A-Z0-9_]*[[:space:]]*=' "${env_paths[@]}" | tr -d ' =\t' | sort -u)"
required_names=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  DATABASE_URL_APP_WEB
  DATABASE_LISTEN_URL_APP_WEB
  WORKER_DATABASE_URL
  DATABASE_LISTEN_URL
  SUPABASE_DB_SSL_ROOT_CERT_PATH
  MEDIA_CONFIG_ENCRYPTION_KEY
  GENERATION_MODEL_ENCRYPTION_KEY
  PRO_MODEL_ENCRYPTION_KEY
  GENERATION_SESSION_SECRET
  ASSET_S3_BUCKET
  ASSET_S3_ENDPOINT
  ASSET_S3_REGION
  ASSET_S3_ACCESS_KEY_ID
  ASSET_S3_SECRET_ACCESS_KEY
  MATERIAL_S3_BUCKET
  CLASSROOM_S3_BUCKET
  ZHIYU_WEB_IMAGE
  ZHIYU_WORKER_IMAGE
)
missing=()
for name in "${required_names[@]}"; do
  if ! grep -qx "$name" <<<"$declared_names" && [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Private env file is missing required setting names: ${missing[*]}" >&2
  exit 1
fi

if [[ $accept_jobs -eq 1 && $confirm_writes -ne 1 ]]; then
  echo 'Refusing to open the write gate. Re-run with both --accept-jobs and --confirm-writes after migration verification.' >&2
  exit 1
fi
if [[ "$action" =~ ^(start|apply)$ && "$mode" == foreground && ( $accept_jobs -ne 1 || $confirm_writes -ne 1 ) ]]; then
  echo 'Foreground generation writes require both --accept-jobs and --confirm-writes.' >&2
  exit 1
fi
if [[ "$action" =~ ^(start|apply)$ && $accept_jobs -ne 1 && "$mode" == background ]]; then
  echo 'WARNING: Starting with GENERATION_ACCEPTING_JOBS=0. Do not send user traffic during verification.' >&2
fi

case "$tier" in
  4) heavy=4; runtime=4; worker_concurrency=2; llm=4 ;;
  8) heavy=8; runtime=8; worker_concurrency=4; llm=8 ;;
  16) heavy=16; runtime=16; worker_concurrency=8; llm=16 ;;
  *) echo 'Tier must be 4, 8 or 16.' >&2; exit 2 ;;
esac

export COMPOSE_PARALLEL_LIMIT=1
export OPENMAIC_CAPACITY_TIER="$tier"
export GENERATION_ACCEPTING_JOBS="$accept_jobs"
if [[ "$mode" == foreground ]]; then export GENERATION_BACKGROUND_ENABLED=0; else export GENERATION_BACKGROUND_ENABLED=1; fi
export APP_HEAVY_TASK_LIMIT="$heavy"
export OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT="$runtime"
export GENERATION_WORKER_CONCURRENCY="$worker_concurrency"
export GENERATION_LLM_MAX_INFLIGHT="$llm"

docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 1; }

compose=(compose --project-name openmaic-supabase)
for path in "${env_paths[@]}"; do compose+=(--env-file "$path"); done
compose+=(-f "$compose_file" -f "$production_file")

services=(openmaic generation-worker)
case "$action" in
  config) docker "${compose[@]}" config --quiet ;;
  # Prebuilt release images only; compose recreates services whose config changed.
  start|apply) docker "${compose[@]}" up -d --no-build --scale generation-worker=2 "${services[@]}" ;;
  readiness) docker "${compose[@]}" run --rm --no-deps supabase-readiness ;;
  status) docker "${compose[@]}" ps ;;
esac
