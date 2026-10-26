#!/usr/bin/env bash
# Enable host NTP and refuse to continue when it is switched off.
# Pass --require-sync to also fail until the clock has synchronized.
set -euo pipefail

if ! command -v timedatectl >/dev/null 2>&1; then
  echo "timedatectl is not available; the host clock cannot be checked." >&2
  exit 1
fi

timedatectl set-ntp true

ntp="$(timedatectl show -p NTP --value 2>/dev/null || true)"
if [ "$ntp" != "yes" ]; then
  echo "NTP is not enabled on this host." >&2
  exit 1
fi

if [ "${1:-}" = "--require-sync" ]; then
  synced="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  if [ "$synced" != "yes" ]; then
    echo "NTP is enabled but the clock is not synchronized yet." >&2
    exit 1
  fi
fi

echo "NTP is enabled."
