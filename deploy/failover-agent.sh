#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - CROSS-NODE FAILOVER AGENT  (standby side)
#
# Runs on the SECOND VPS. Installed from cron every 2 minutes. Safe to run
# repeatedly; holds a flock so overlapping ticks cannot double-promote.
#
# WHAT THIS SCRIPT IS AND IS NOT FOR
#
# The frontend already survives a whole VPS going away and needs nothing from
# this file. deploy/Caddyfile publishes an internal `:8080` door bound to the
# WireGuard address, and each node's deploy/caddy-live/webpeer.caddy points the
# OTHER node's frontend into its own public pool:
#
#   primary:  to 10.77.0.2:8080
#   peer:     to 10.77.0.1:9103
#
# Both machines' web replicas are therefore live members of both pools at all
# times. Losing web-1 and web-2 on either node is not a failover event - Caddy
# simply keeps sending to the survivors. There is no promotion step to miss.
#
# The API is the part that needs this script. deploy/docker-compose.peer.yml
# points this node's api-a/api-b at the PRIMARY's postgres + redis over the
# tunnel (10.77.0.1:9101 / 10.77.0.1:9102). That is deliberate - the API
# re-reads the `sessions` table on every request (see
# apps/api/src/middleware/auth.ts), so two writable databases would make logins
# flap between machines. One writer is the whole design. But it also means that
# when the primary host stops existing, this node is holding a dead address, and
# must stop borrowing the primary's data and start serving its own.
#
# THREE STATES, tested in this order
#
#   0. PRIMARY SERVING        Nothing to do. Reset the strike counter, clear
#                             every alarm this script owns.
#
#   1. PRIMARY REACHABLE BUT  ALARM ONLY - NEVER PROMOTE. The primary's
#      NOT SERVING            postgres is still answering on the tunnel, so the
#                             host is alive and its worker is still writing to
#                             its own database. Promoting here would mint a
#                             second writer and fork the data - a split brain
#                             that is far worse than a short outage, and one
#                             that has to be repaired by hand. A human decides.
#
#   2. PRIMARY GONE           Count a strike. After DOWN_CHECKS_REQUIRED
#                             consecutive strikes, and only when the primary's
#                             PUBLIC IP is also unreachable (so a tunnel-only
#                             flap can never trigger a promotion), promote
#                             behind a replication-lag gate, then move traffic.
#
# Every probe is a one-way network check. This agent never SSHes to the primary:
# the primary->peer key exists, the reverse does not, and creating one would
# mean an unattended writer on this node could reach into a live primary.
#
# THE LAG GATE IS THE SAFETY CATCH
# Promotion is only ever as good as the standby's copy. If the standby is
# minutes behind, promoting silently discards the difference - invoices and
# EFRIS submissions that the primary accepted and answered OK. So the agent
# reads pg_last_xact_replay_timestamp() first and refuses to promote past
# MAX_REPLAY_LAG_SECONDS, waking a human instead. Refusing to promote is always
# the safe failure: users see an outage, but the data stays reconcileable.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
#   * It does not demote itself. If the marker exists and the primary comes
#     back, that is a split data set and only a human can decide how to merge
#     (pg_rewind or a re-seed). Auto-demoting would silently throw away
#     whichever side lost the race.
#   * It does not re-sync replication. Starting a replica over a promoted
#     master without a rewind is how you lose rows.
#
# Usage:
#   failover-agent.sh            # automatic: evaluate, maybe promote
#   failover-agent.sh status     # print state, change nothing
#   failover-agent.sh promote    # operator-forced promotion (drill / manual)
#   failover-agent.sh dry-run    # evaluate and report, never write
#
# Operator overrides live in deploy/failover.env (see failover.env.example),
# outside .env.production for the same reason deploy/alert.env is: that file is
# machine-generated and not a safe home for hand edits.
#############################################################
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
DEPLOY_DIR="$APP_DIR/deploy"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/failover.log"
STATE_DIR="$LOG_DIR/failover-state"
DNS_HOOK="$DEPLOY_DIR/dns-failover.sh"
ALERT_BIN="$DEPLOY_DIR/alert.sh"
FAILOVER_ENV_FILE="$DEPLOY_DIR/failover.env"

DATA_CONTAINER="hopedesign-erp-data-dr"
REDIS_CONTAINER="hopedesign-erp-redis-1"
PROMOTED_MARKER="$STATE_DIR/promoted"
DOWN_COUNT_FILE="$STATE_DIR/primary-down-count"

mkdir -p "$LOG_DIR" "$STATE_DIR"
now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[failover $(now)] $*" >> "$LOG_FILE"; }

# One tick at a time. A promotion takes ~30s and cron fires every 2 minutes, so
# an overlap is unlikely - but "unlikely" is not a property you want in the code
# path that decides which database is the writer.
LOCK_FILE="/run/lock/hopedesign-erp-failover.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then exit 0; fi

envget() { # $1 = KEY -> value from .env.production, quotes stripped
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1)"
  v="${v%\"}"; v="${v#\"}"
  v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# shellcheck disable=SC1090
[[ -f "$FAILOVER_ENV_FILE" ]] && . "$FAILOVER_ENV_FILE"

DOMAIN="${DOMAIN:-$(envget DOMAIN)}"
PRIMARY_PUBLIC_IP="${PRIMARY_PUBLIC_IP:-23.239.220.214}"
PRIMARY_WG_IP="${PRIMARY_WG_IP:-10.77.0.1}"
PRIMARY_PG_PORT="${PRIMARY_PG_PORT:-9101}"
DOWN_CHECKS_REQUIRED="${DOWN_CHECKS_REQUIRED:-3}"
MAX_REPLAY_LAG_SECONDS="${MAX_REPLAY_LAG_SECONDS:-300}"
AUTO_PROMOTE="${AUTO_PROMOTE:-1}"
AUTO_MOVE_DNS="${AUTO_MOVE_DNS:-1}"
START_WORKER_ON_FAILOVER="${START_WORKER_ON_FAILOVER:-1}"

DRY_RUN=0
[[ "${1:-auto}" == "dry-run" ]] && DRY_RUN=1
ACTION="${1:-auto}"

notify() { # $1 severity, $2 dedupe key, $3 subject, $4 body
  [[ -x "$ALERT_BIN" ]] || { log "no alert.sh - would have sent [$1] $3"; return 0; }
  "$ALERT_BIN" send "$1" "$2" "$3" "${4:-}" >> "$LOG_FILE" 2>&1 \
    || log "WARN: alert.sh send failed for key $2"
}
notify_clear() { # $1 dedupe key
  [[ -x "$ALERT_BIN" ]] || return 0
  "$ALERT_BIN" clear "$1" >> "$LOG_FILE" 2>&1 || true
}

#############################################################
# Probes
#############################################################

# Bash's /dev/tcp with a hard timeout. Used instead of nc/ss because neither is
# guaranteed present on a minimal image, while bash always is.
tcp_ok() { # $1 host, $2 port, $3 timeout seconds
  timeout "${3:-4}" bash -c "cat </dev/null >/dev/tcp/$1/$2" 2>/dev/null
}

# Assert the ERP's own health payload, not merely "something answered 200". A
# stale listener or a foreign app on the same port would satisfy a bare status
# check and mask a total outage. Same assertion deploy/stack-watchdog.sh uses.
API_SVC_RE='"service"[[:space:]]*:[[:space:]]*"hopedesign-erp-api"'
API_STATUS_RE='"status"[[:space:]]*:[[:space:]]*"ok"'
api_health() { # $1 url, $2 optional IP to pin SNI/connection to
  local url="$1" ip="${2:-}" body
  if [[ -n "$ip" ]]; then
    body="$(curl -fsS --max-time 10 --resolve "$DOMAIN:443:$ip" "$url" 2>/dev/null)"
  else
    body="$(curl -fsS --max-time 10 "$url" 2>/dev/null)"
  fi
  [[ $? -eq 0 ]] || return 1
  printf '%s' "$body" | grep -Eq "$API_SVC_RE" || return 1
  printf '%s' "$body" | grep -Eq "$API_STATUS_RE" || return 1
  return 0
}

# The public IP is pinned rather than the hostname re-resolved: the question is
# not "does the domain work" but "does the exact address users are being sent to
# still serve the ERP".
primary_ingress_ok() { api_health "https://$DOMAIN/api/health" "$PRIMARY_PUBLIC_IP"; }
primary_pg_ok() { tcp_ok "$PRIMARY_WG_IP" "$PRIMARY_PG_PORT" 4; }
primary_public_ok() { tcp_ok "$PRIMARY_PUBLIC_IP" 443 4; }
local_ingress_ok() { api_health "https://$DOMAIN/api/health" "127.0.0.1"; }

docker_ok() { [[ -n "$(docker inspect -f '{{.Id}}' "$1" 2>/dev/null)" ]]; }
container_state() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing
}

# Replay lag in seconds, or -1 for "never replayed" / unknown. Empty output
# means the probe itself failed, which is treated as "cannot verify" - and the
# gate refuses to promote on that, because promoting on an unverifiable standby
# is exactly how you discover the replica died three days ago.
replay_lag_seconds() {
  docker exec "$DATA_CONTAINER" psql -U hopedesign -tAc \
    "select coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp())::int, -1)" 2>/dev/null \
    | tr -d '[:space:]'
}
pg_in_recovery() {
  docker exec "$DATA_CONTAINER" psql -U hopedesign -tAc 'select pg_is_in_recovery()' 2>/dev/null \
    | tr -d '[:space:]'
}
redis_cli() {
  docker exec -e REDISCLI_AUTH="$(envget REDIS_PASSWORD)" "$REDIS_CONTAINER" redis-cli "$@" 2>/dev/null
}
redis_role() { redis_cli INFO replication | tr -d '\r' | sed -n 's/^role://p' | head -1; }

read_down_count() { local n; n="$(cat "$DOWN_COUNT_FILE" 2>/dev/null)"; [[ "$n" =~ ^[0-9]+$ ]] || n=0; printf '%s' "$n"; }
set_down_count() { printf '%s' "$1" > "$DOWN_COUNT_FILE" 2>/dev/null || true; }

are_promoted() { [[ -f "$PROMOTED_MARKER" ]]; }

#############################################################
# Compose invocation
#
# The `up` that puts the API colours onto LOCAL data. Note which file is NOT
# here: deploy/docker-compose.peer-replica.yml. That file re-asserts
# `redis --replicaof 10.77.0.1 9102`, so passing it would immediately demote the
# redis we just promoted back into a replica of a host that is down - rejecting
# every write. The promoted redis is simply left alone.
#
# deploy/docker-compose.peer-bridge.yml IS here, and it is not an oversight.
# It publishes this node's 10.77.0.2:8081 API door, which is the retry target
# the OTHER machine holds open inside its own active.caddy - if the promotion
# dropped it, a returning primary would have nothing to retry through while its
# own colour is down. Its socat bridges are safe in this set too: data-dr and
# redis are both running locally by the time this composes (data-dr was promoted
# in place at step 2), so they connect instead of restart-looping.
#############################################################
COMPOSE_BASE=(docker compose -f "$APP_DIR/docker-compose.prod.yml" -f "$DEPLOY_DIR/docker-compose.peer.yml" -f "$DEPLOY_DIR/docker-compose.peer-bridge.yml")
compose_failover() { "${COMPOSE_BASE[@]}" -f "$DEPLOY_DIR/docker-compose.peer-failover.yml" --env-file "$ENV_FILE" "$@"; }

#############################################################
# Promotion
#############################################################

promote() { # $1 = last verified replay lag in seconds (or "unknown")
  local lag="$1" state

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: would promote (lag=${lag}s)"
    return 0
  fi

  log "PROMOTE: starting (last verified replay lag ${lag}s)"

  # --- 1. The node we are promoting has to actually be here -----------------
  if ! docker_ok "$DATA_CONTAINER"; then
    log "PROMOTE: ABORT - $DATA_CONTAINER does not exist on this node"
    notify CRITICAL failover-promote-failed \
      "Peer cannot take over: standby database missing" \
      "failover-agent.sh wanted to promote but $DATA_CONTAINER is not present. The standby was never seeded, or was removed. Nothing can serve the ERP on this node."
    return 1
  fi

  # --- 2. Postgres out of recovery -----------------------------------------
  # pg_promote() is preferred over pg_ctl because it is a SQL call that cannot
  # drift from the running server's PGDATA, and it does not depend on knowing
  # where the binaries live. pg_ctl stays as the fallback for older images.
  if [[ "$(pg_in_recovery)" != "f" ]]; then
    state="$(docker exec "$DATA_CONTAINER" psql -U hopedesign -tAc 'select pg_promote()' 2>/dev/null | tr -d '[:space:]')"
    if [[ "$state" != "t" ]]; then
      log "PROMOTE: pg_promote() did not confirm; falling back to pg_ctl"
      docker exec -u postgres "$DATA_CONTAINER" sh -c 'pg_ctl promote -D "$PGDATA"' >> "$LOG_FILE" 2>&1 || true
      sleep 3
    fi
  fi
  if [[ "$(pg_in_recovery)" != "f" ]]; then
    log "PROMOTE: ABORT - $DATA_CONTAINER is still in recovery"
    notify CRITICAL failover-promote-failed \
      "Peer cannot take over: standby would not leave recovery" \
      "pg_promote() and pg_ctl promote were both attempted and pg_is_in_recovery() is still true. Check the container logs: docker logs $DATA_CONTAINER"
    return 1
  fi
  log "PROMOTE: $DATA_CONTAINER is now writable (pg_is_in_recovery=f)"

  # --- 3. Redis out of replica mode ----------------------------------------
  # The queue broker, not the source of truth - but a read-only redis means the
  # API cannot write rate-limit counters or session state, so it has to follow.
  redis_cli REPLICAOF NO ONE >/dev/null 2>&1 || true
  sleep 1
  if [[ "$(redis_role)" != "master" ]]; then
    log "PROMOTE: ABORT - redis role is '$(redis_role)', expected master"
    notify CRITICAL failover-promote-failed \
      "Peer cannot take over: redis is still a replica" \
      "REPLICAOF NO ONE did not take on $REDIS_CONTAINER (role=$(redis_role)). A replica of a dead master rejects every write, so the API would accept logins and then fail. Not switching traffic."
    return 1
  fi
  log "PROMOTE: redis is now master"

  # --- 4. Marker, before traffic moves -------------------------------------
  # Written before the compose up on purpose: if the next step fails the node is
  # still marked promoted, which keeps the agent in "this is a split data set,
  # get a human" mode instead of letting a later tick promote a second time or
  # quietly treat a half-switched node as normal.
  printf '%s\n' "$(now)" > "$PROMOTED_MARKER"

  # --- 5. Point the API colours at local, writable data --------------------
  if ! compose_failover up -d --no-deps api-a api-b >> "$LOG_FILE" 2>&1; then
    log "PROMOTE: WARNING - compose up for api-a/api-b returned non-zero"
  fi
  sleep 15

  # --- 6. Scheduled work ----------------------------------------------------
  # The worker is profile-gated cluster-wide so scheduled jobs run exactly once.
  # We only got here because the primary host is unreachable by two independent
  # paths, so its worker is gone; starting ours restores invoice runs, EFRIS
  # fiscalisation and notification delivery instead of leaving them stopped for
  # the whole outage.
  if [[ "$START_WORKER_ON_FAILOVER" == "1" ]]; then
    if "${COMPOSE_BASE[@]}" --profile data-primary-only -f "$DEPLOY_DIR/docker-compose.peer-failover.yml" --env-file "$ENV_FILE" up -d worker >> "$LOG_FILE" 2>&1; then
      log "PROMOTE: worker started on this node"
    else
      log "PROMOTE: WARNING - worker did not start; scheduled jobs are stopped"
    fi
  fi

  # --- 7. Prove it locally before claiming it ------------------------------
  local verified="no" i
  for i in 1 2 3 4 5 6; do
    if local_ingress_ok; then verified="yes"; break; fi
    sleep 5
  done
  log "PROMOTE: local ingress verification: $verified"

  # --- 8. Move the address users actually type -----------------------------
  # The API can be perfectly healthy on this node and users still reach nothing,
  # because the A record for $DOMAIN points at the primary's public IP. Until it
  # moves, this node's readiness is invisible to the public internet.
  local dns_result="not-attempted"
  if [[ "$AUTO_MOVE_DNS" == "1" ]]; then
    if [[ -x "$DNS_HOOK" ]]; then
      if "$DNS_HOOK" move-to-peer >> "$LOG_FILE" 2>&1; then
        dns_result="moved"
        log "PROMOTE: DNS hook moved $DOMAIN to this node"
      else
        dns_result="failed"
        log "PROMOTE: DNS hook failed - see $LOG_FILE"
      fi
    else
      dns_result="hook-missing"
      log "PROMOTE: no executable $DNS_HOOK"
    fi
  else
    dns_result="disabled"
  fi

  # --- 9. Tell someone ------------------------------------------------------
  notify CRITICAL failover-promoted \
    "ERP FAILOVER: this node is now the primary" \
    "failover-agent.sh promoted the standby at $(now).
Replay lag at promotion: ${lag}s (gate ${MAX_REPLAY_LAG_SECONDS}s).
postgres: $DATA_CONTAINER is writable. redis: master. worker: ${START_WORKER_ON_FAILOVER}.
API verified on this node: ${verified}. DNS move: ${dns_result}.
The old primary may still hold writes it accepted after ${lag}s before it died - do NOT re-attach it as a replica without pg_rewind or a re-seed."

  return 0
}

#############################################################
# State machine
#############################################################

state_report() {
  printf 'promoted=%s down_strikes=%s\n' \
    "$(are_promoted && echo yes || echo no)" "$(read_down_count)"
  printf 'primary_ingress=%s primary_pg=%s primary_public_443=%s local_ingress=%s\n' \
    "$(primary_ingress_ok && echo up || echo down)" \
    "$(primary_pg_ok && echo up || echo down)" \
    "$(primary_public_ok && echo up || echo down)" \
    "$(local_ingress_ok && echo up || echo down)"
  printf 'replay_lag=%ss pg_in_recovery=%s redis_role=%s\n' \
    "$(replay_lag_seconds)" "$(pg_in_recovery)" "$(redis_role)"
}

if [[ "$ACTION" == "status" ]]; then
  state_report
  exit 0
fi

if [[ "$ACTION" == "promote" ]]; then
  log "MANUAL promote requested by operator"
  promote "operator-forced" || exit 1
  exit 0
fi

# --- State 0: primary is serving -------------------------------------------
if primary_ingress_ok; then
  set_down_count 0
  notify_clear failover-primary-down
  notify_clear failover-primary-degraded
  if are_promoted; then
    # Both nodes believe they are the writer. Nothing here can merge that, and
    # guessing would destroy data. Raise it loudly and let a human drive.
    log "CRITICAL: primary is serving again but this node is still marked PROMOTED"
    notify CRITICAL failover-split-brain \
      "ERP SPLIT DATA SET: both nodes are primary" \
      "The old primary is answering again, but this node was promoted at $(cat "$PROMOTED_MARKER" 2>/dev/null) and never demoted. Two writable copies of the ERP now exist. Reconcile by hand (pg_rewind the loser, or re-seed it) and remove $PROMOTED_MARKER only after that is done - the agent will not do it for you."
  else
    log "primary serving; nothing to do"
  fi
  exit 0
fi

# --- State 1: host alive but the API is not serving ------------------------
# The tunnel still answers, or the public IP still answers, so this is a service
# failure on a living machine - a bad deploy, a wedged Caddy, a crashed API.
# Its worker is still writing to its own database. Promoting now would create
# two writers, so this is alarm-only, always.
if primary_pg_ok || primary_public_ok; then
  set_down_count 0
  notify_clear failover-primary-down
  log "primary reachable (pg=$(primary_pg_ok && echo up || echo down) public443=$(primary_public_ok && echo up || echo down)) but ingress is not serving"
  notify WARNING failover-primary-degraded \
    "ERP primary is up but not serving the API" \
    "The primary host is reachable but https://$DOMAIN/api/health does not return the ERP's health payload.
This agent will NOT promote on this state: the primary's database is alive and its worker is still writing, so a second writer would fork the data.
Local watchdog on the primary should already be trying to recover. If it does not, treat this as a deploy rollback, not a failover."
  exit 0
fi

# --- State 2: the primary is gone -----------------------------------------
strikes=$(( $(read_down_count) + 1 ))
set_down_count "$strikes"
log "primary unreachable (ingress=down pg=down public443=down) strike $strikes/$DOWN_CHECKS_REQUIRED"

if [[ "$AUTO_PROMOTE" != "1" ]]; then
  log "AUTO_PROMOTE=0 - not promoting"
  notify CRITICAL failover-primary-down \
    "ERP primary unreachable (auto-promotion disabled)" \
    "The primary is unreachable and AUTO_PROMOTE=0, so this node is NOT taking over. Run deploy/failover-agent.sh promote to switch by hand."
  exit 0
fi

if [[ "$strikes" -lt "$DOWN_CHECKS_REQUIRED" ]]; then
  log "waiting for $DOWN_CHECKS_REQUIRED consecutive strikes before promoting"
  exit 0
fi

if are_promoted; then
  log "already promoted; primary still down - nothing further to do"
  exit 0
fi

# Lag gate. Refusing here is the correct failure: users wait, data survives.
lag="$(replay_lag_seconds)"
if [[ ! "$lag" =~ ^-?[0-9]+$ ]]; then
  log "ABORT: could not read replication lag (probe returned '$lag')"
  notify CRITICAL failover-lag-unknown \
    "ERP failover blocked: standby lag unreadable" \
    "The primary is gone and failover-agent.sh is ready to promote, but it could not read pg_last_xact_replay_timestamp() from $DATA_CONTAINER, so it cannot tell how much data the standby is missing. Promoting blind risks discarding accepted invoices. Promote by hand if you have verified the standby another way: deploy/failover-agent.sh promote"
  exit 0
fi

if [[ "$lag" -lt 0 ]]; then
  log "ABORT: standby has never replayed anything (lag=$lag)"
  notify CRITICAL failover-lag-unknown \
    "ERP failover blocked: standby has never streamed" \
    "$DATA_CONTAINER reports no replay at all. This node does not hold a usable copy of the database. Do not promote it - recover the primary or re-seed from backup."
  exit 0
fi

if [[ "$lag" -gt "$MAX_REPLAY_LAG_SECONDS" ]]; then
  log "ABORT: standby lag ${lag}s exceeds gate ${MAX_REPLAY_LAG_SECONDS}s"
  notify CRITICAL failover-lag-exceeded \
    "ERP failover blocked: standby is ${lag}s behind" \
    "The primary is gone but this node's standby is ${lag}s behind (gate ${MAX_REPLAY_LAG_SECONDS}s), so promoting would silently discard roughly that much accepted work - typically invoices, payments and EFRIS submissions the old primary answered OK.
Decide by hand: wait for the primary to come back, restore it from backup, or accept the loss and run deploy/failover-agent.sh promote."
  exit 0
fi

log "primary gone for $strikes checks and standby lag ${lag}s is within the gate - promoting"
promote "$lag"
