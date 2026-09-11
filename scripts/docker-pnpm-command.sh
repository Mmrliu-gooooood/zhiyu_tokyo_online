#!/bin/sh
set -eu

mode="${1:-}"
if [ "$mode" != prepare ] && [ "$mode" != install ]; then
  echo 'usage: docker-pnpm-command {prepare|install}' >&2
  exit 2
fi

trim_registry() {
  value="$1"
  while [ "${value%/}" != "$value" ]; do value="${value%/}"; done
  printf '%s' "$value"
}

run_for_registry() {
  registry="$1"
  if [ "$mode" = prepare ]; then
    if [ -n "$registry" ]; then
      COREPACK_NPM_REGISTRY="$registry" corepack prepare pnpm@10.28.0 --activate
    else
      corepack prepare pnpm@10.28.0 --activate
    fi
    return
  fi
  if [ -n "$registry" ]; then pnpm config set registry "$registry"; fi
  pnpm install --frozen-lockfile
}

retry_for_registry() {
  registry="$1"
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if run_for_registry "$registry"; then return 0; fi
    if [ "$attempt" -eq 3 ]; then break; fi
    if [ "$attempt" -eq 1 ]; then delay=2; else delay=5; fi
    echo "pnpm $mode failed on attempt $attempt; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  return 1
}

configured_registry="$(trim_registry "${NPM_REGISTRY:-}")"
if retry_for_registry "$configured_registry"; then exit 0; fi

official_registry='https://registry.npmjs.org'
if [ -n "$configured_registry" ] && [ "$configured_registry" != "$official_registry" ]; then
  echo "configured npm registry unavailable; falling back to registry.npmjs.org" >&2
  retry_for_registry "$official_registry"
  exit $?
fi

exit 1
