#!/usr/bin/env bash
# Compare installed packages with deploy/host-software-allowlist.txt.
# The default checks that every allow-listed package is installed.
# --strict also fails when something else is installed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
list="$here/host-software-allowlist.txt"
strict=0
[ "${1:-}" = "--strict" ] && strict=1

if ! command -v dpkg >/dev/null 2>&1; then
  echo "dpkg is not available; this check is for the Debian production host." >&2
  exit 1
fi

missing=0
while IFS= read -r pkg; do
  [ -z "$pkg" ] && continue
  case "$pkg" in \#*) continue ;; esac
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    echo "Missing allow-listed package: $pkg" >&2
    missing=1
  fi
done < "$list"
[ "$missing" -eq 0 ] || exit 1

if [ "$strict" -eq 1 ]; then
  extra=0
  while IFS= read -r pkg; do
    if ! grep -qx "$pkg" "$list"; then
      echo "Package is not on the allow-list: $pkg" >&2
      extra=1
    fi
  done < <(dpkg-query -W -f='${Package}\n')
  [ "$extra" -eq 0 ] || exit 1
fi

echo "Host software matches the allow-list."
