#!/usr/bin/env bash
#############################################################
# DEPRECATED (blue/green topology)
#
# This script targeted the previous API-replica topology
# (hopedesign-erp-api-1 / api-2 replicas and the legacy
# hopedesign_erp database). The live stack now runs two
# always-on API colors (api-a, api-b) behind Caddy with an
# atomic `caddy reload` flip, so this script was disabled to
# prevent it from breaking the production topology.
#
# Canonical replacements:
#   zero-downtime rollout ... sh deploy/zero-downtime-deploy.sh
#   database backup ......... sh deploy/postgres-backup.sh
#   storage backup .......... sh deploy/storage-backup.sh
#   health check ............ sh deploy/health-check.sh
#   watchdog install ........ sh deploy/install-watchdog.sh
#############################################################
echo "DEPRECATED: $0 targets the old API replica / legacy-DB topology and was intentionally disabled." >&2
echo "Use the canonical zero-downtime rollout instead:  sh deploy/zero-downtime-deploy.sh" >&2
exit 1