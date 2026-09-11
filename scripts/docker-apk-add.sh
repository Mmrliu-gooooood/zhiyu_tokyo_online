#!/bin/sh
set -eu

retry_apk_add() {
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if apk add --no-cache "$@"; then
      return 0
    fi
    if [ "$attempt" -eq 3 ]; then
      break
    fi
    if [ "$attempt" -eq 1 ]; then delay=2; else delay=5; fi
    echo "apk add failed on attempt $attempt; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  return 1
}

if retry_apk_add "$@"; then
  exit 0
fi

# A configured public mirror is an optimization, not a single point of
# failure. After its bounded retries are exhausted, restore Alpine's official
# host and make one more bounded series. Never rewrite the resolver itself.
if [ -n "${ALPINE_MIRROR:-}" ] && grep -Fq "$ALPINE_MIRROR" /etc/apk/repositories; then
  echo "configured Alpine mirror unavailable; falling back to dl-cdn.alpinelinux.org" >&2
  sed -i "s|$ALPINE_MIRROR|dl-cdn.alpinelinux.org|g" /etc/apk/repositories
  retry_apk_add "$@"
  exit $?
fi

exit 1
