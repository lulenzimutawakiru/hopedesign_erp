#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP — AUTO-DEPLOY WATCHER (blue/green)
#
# Runs from cron (installed by deploy/install-auto-deploy.sh).
# Polls origin/main and, when a commit has been pushed that is not
# yet deployed, hands off to the canonical blue/green rollout
# (deploy/zero-downtime-deploy.sh). Idempotent and fail-safe:
#
#   - no-op when origin/main == HEAD (already deployed),
#   - no-op when the worktree is dirty (the rollout aborts on it anyway),
#   - no-op when a rollout is already mid-flight (the rollout's own
#     /run/lock/hopedesign-erp-deploy.lock makes a second handoff a no-op),
#   - paused entirely while deploy/auto-deploy.disabled exists.
#
# The watcher never mutates state itself — the rollout script is the single
# place that fast-forwards, backs up, builds, recreates the idle API colour,
# health-gates and flips Caddy. This file only detects "something new landed"
# and delegates, so the two can never drift on deploy policy.
#############################################################
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
LOG_DIR="$APP_DIR/logs"
DISABLED_FILE="$APP_DIR/deploy/auto-deploy.disabled"
BRANCH="main"

cd "$APP_DIR"
mkdir -p "$LOG_DIR"

log() { echo "[auto-deploy $(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_DIR/deploy.log"; }

# Manual kill-switch: touch deploy/auto-deploy.disabled on the VPS to pause.
if [[ -f "$DISABLED_FILE" ]]; then
  exit 0
fi

# Never deploy on top of uncommitted local edits. The VPS worktree is a
# deploy target and should always be clean, but this turns a surprise into a
# logged no-op rather than an aborted rollout.
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "SKIP: worktree has uncommitted changes"
  exit 0
fi

# Learn whether a new commit has landed on origin/main. A fetch failure is a
# no-op (the next tick retries), never a deploy of stale state.
if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_DIR/deploy.log"; then
  log "WARN: git fetch origin $BRANCH failed; skipping this tick"
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$LOCAL")"

# Already at the deployed commit — nothing to do.
if [[ "$LOCAL" == "$REMOTE" ]]; then
  exit 0
fi

log "new commit ${REMOTE:0:12} (was ${LOCAL:0:12}); starting blue/green rollout"

# Hand off. The rollout re-fetches, fast-forwards, backs up, builds, recreates
# only the idle API colour, health-gates and atomically flips Caddy — and its
# flock guard makes a concurrent tick's handoff an immediate no-op.
exec bash "$APP_DIR/deploy/zero-downtime-deploy.sh"
