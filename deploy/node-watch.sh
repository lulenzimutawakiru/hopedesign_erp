#!/usr/bin/env bash
# Cross-node watchdog for the two-node ERP cluster.
#
# Why this exists: on 2026-09-19 the primary node was down for ~34 hours and
# nobody was told. Uptime Kuma runs ON the primary, so it died with the box it
# was supposed to be watching - a monitor that shares fate with its target can
# never report the outage it exists to catch. Nothing else on either host
# looked at the other one either.
#
# This script is the fix: each node watches the OTHER one and the shared
# service, and mails through deploy/alert.sh (Resend, host-level - it works
# even when every container on the box is dead).
#
# Roles are read from the node's own WireGuard address, so the identical file
# is correct on both hosts:
#   10.77.0.1 = primary - ingress + data primary. Watches the peer's compute
#               health and the peer's own watchdog heartbeat.
#   10.77.0.2 = peer    - compute only. Watches the primary's data ports,
#               because this node's API cannot serve a single request without
#               them.
#
# Residual risk, stated plainly: if BOTH nodes are down at once, nothing here
# can fire. Only a monitor hosted off both machines (a third-party pinger or a
# box you control elsewhere) closes that gap.
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/node-watch.log"
HEARTBEAT="$LOG_DIR/node-watch.heartbeat"
PEER_HB_LOCAL="$LOG_DIR/peer-node-watch.heartbeat"
ALERT="$APP_DIR/deploy/alert.sh"
ENV_FILE="$APP_DIR/.env.production"
PEER_SSH_KEY="/root/.ssh/id_ed25519"

# The peer-run interval is 3 minutes; 15 gives five missed runs before we shout.
PEER_WATCH_MAX_MINUTES="${PEER_WATCH_MAX_MINUTES:-15}"
DISK_MAX_PERCENT="${DISK_MAX_PERCENT:-85}"

mkdir -p "$LOG_DIR"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }
notify() { "$ALERT" send "$1" "$2" "$3" "$4" >/dev/null 2>&1 || log "alert.sh failed key=$2"; }
resolve() { "$ALERT" clear "$1" >/dev/null 2>&1 || true; }
envget() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r'; }

DOMAIN="$(envget DOMAIN)"
[ -n "$DOMAIN" ] || DOMAIN="hopedesign.jorlentech.com"

# ---------- role ----------
SELF_WG="$(ip -4 -o addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
case "$SELF_WG" in
  10.77.0.1) ROLE="primary"; PEER_WG="10.77.0.2" ;;
  10.77.0.2) ROLE="peer";    PEER_WG="10.77.0.1" ;;
  *)         ROLE="unknown"; PEER_WG="" ;;
esac

log "cycle start role=$ROLE self_wg=${SELF_WG:-none}"

if [ "$ROLE" = "unknown" ]; then
  notify CRITICAL node-watch-role-unknown "cannot determine this node's cluster role" \
"node-watch.sh could not read an address from wg0, so it does not know whether
this host is the primary or the peer. Every peer and data check below is being
skipped, which means this node is currently watching nothing.

Expected 10.77.0.1 (primary) or 10.77.0.2 (peer) on wg0; got '${SELF_WG:-nothing}'.

Bring WireGuard up: systemctl status wg-quick@wg0"
  log "cycle end role=unknown skipped_all_checks"
  exit 1
fi
resolve node-watch-role-unknown

problems=0

# ---------- 1. this node: local service ----------
# --resolve pins the name to the loopback Caddy while keeping SNI and Host
# correct, so this is a real TLS request through the real vhost. Plain
# http://127.0.0.1 returns a 308 that curl cannot follow here (the redirect
# target fails certificate validation against a bare IP).
local_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null || echo 000)"
if [ "$local_code" = "200" ]; then
  resolve local-api-down
else
  notify CRITICAL local-api-down "local API not serving on $(hostname) (HTTP $local_code)" \
"https://$DOMAIN/api/health answered HTTP ${local_code} when requested from this
host against its own Caddy on 127.0.0.1.

This host is failing its own health check, so whatever it is contributing to the
cluster right now, it is not a working API. Check the active API colour and
Caddy:
  docker compose -f $APP_DIR/docker-compose.prod.yml ps
  cat $APP_DIR/deploy/caddy-live/active.caddy
  docker logs --tail 50 hopedesign-erp-caddy-1"
  problems=$((problems + 1))
fi

# ---------- 2. the service users actually see ----------
# Deliberately hardcoded to the public name with normal DNS: this is the one
# check that does not care which node answers.
public_code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
  "https://$DOMAIN/api/health" 2>/dev/null || echo 000)"
public_ip="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | tr '\n' ',' | sed 's/,$//')"
if [ "$public_code" = "200" ]; then
  resolve public-site-down
else
  notify CRITICAL public-site-down "the public site is not serving (HTTP $public_code)" \
"https://$DOMAIN/api/health answered HTTP ${public_code} from $(hostname).

DNS currently resolves $DOMAIN to: ${public_ip:-unresolved}

This is the check that measures what customers can reach, independently of
whether this particular node is healthy. If this host is fine but the other one
is not, the load balancer may still be sending traffic into the dead node."
  problems=$((problems + 1))
fi

# ---------- 3. containers declared unhealthy ----------
unhealthy="$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
if [ -z "$unhealthy" ]; then
  resolve container-unhealthy
else
  notify CRITICAL container-unhealthy "unhealthy container(s) on $(hostname)" \
"docker reports these containers as health=unhealthy on $(hostname):

$unhealthy

An unhealthy container is normally restarted automatically once it clears its
retries, but a container stuck in this state is not being load balanced to.
Inspect it with:
  docker inspect --format '{{.State.Health.Log}}' <name>"
  problems=$((problems + 1))
fi

# ---------- 4. disk ----------
# The primary died with I/O errors against vda on 2026-09-19; a full disk on
# either node is the cheapest single cause of the next outage.
disk_pct="$(df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}' || echo 0)"
case "$disk_pct" in ''|*[!0-9]*) disk_pct=0 ;; esac
if [ "$disk_pct" -le "$DISK_MAX_PERCENT" ]; then
  resolve disk-space
else
  notify WARN disk-space "root filesystem ${disk_pct}% full on $(hostname)" \
"Root filesystem on $(hostname) is ${disk_pct}% full (warn threshold ${DISK_MAX_PERCENT}%).

Postgres will refuse writes once the volume fills, which takes the whole
cluster down, not just this node. Check what grew:
  du -xh --max-depth=1 /opt /var | sort -h | tail -20
  docker system df"
  problems=$((problems + 1))
fi

# ---------- 4b. data-plane role ----------
# Which database is this node's API ACTUALLY pointed at?
#
# On 2026-09-19 the peer node needed TWO compose files to be correct:
# docker-compose.prod.yml hardcodes POSTGRES_HOST=postgres in the shared *api
# anchor, and deploy/docker-compose.peer.yml is what repoints the colours at the
# primary over WireGuard. Bring the peer up without the overlay - a typo, a
# stray hook, a future script - and its API silently returns on the peer's own
# local database: two nodes, two copies of the same data, each authenticating
# half the logins against rows the other cannot see. Nothing in the cluster
# looked at this, so nothing saw it.
#
# This reads the configuration each API container was CREATED with - inspect,
# not exec, so it still reports while the container is down - and refuses to
# accept the wrong data plane whatever the cause.
if [ "$ROLE" = "primary" ]; then
  expected_db_host="postgres"
else
  expected_db_host="$PEER_WG"
fi
db_wrong=""
for c in hopedesign-erp-api-a hopedesign-erp-api-b; do
  dbh="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null \
    | sed -n 's/^POSTGRES_HOST=//p' | tail -n 1)"
  # No POSTGRES_HOST at all means the container does not exist yet; check 3
  # already owns missing containers, so do not report it twice here.
  [ -n "$dbh" ] || continue
  [ "$dbh" = "$expected_db_host" ] || db_wrong="$db_wrong ${c#hopedesign-erp-}=$dbh"
done
if [ -z "$db_wrong" ]; then
  resolve data-plane-wrong-host
else
  if [ "$ROLE" = "peer" ]; then
    db_why="This node holds no data of its own, so the address above is its own
local database: an idle, stale copy of the cluster's data. While the API runs
against it, this node authenticates logins against rows that stopped changing,
and every write it accepts is invisible to the primary. That is a split brain -
which copy of the truth you get then depends on which node answered."
    db_fix="cd $APP_DIR && docker compose -f docker-compose.prod.yml -f deploy/docker-compose.peer.yml --env-file .env.production up -d --no-deps api-a api-b"
  else
    db_why="This node is the data primary, so its colours must use the local
postgres service. A colour pointed anywhere else is reading and writing a
database that is not the cluster's; treat every row it touched as suspect."
    db_fix="cd $APP_DIR && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps api-a api-b"
  fi
  notify CRITICAL data-plane-wrong-host \
    "API on $(hostname) is pointed at the wrong database" \
"node-watch.sh read the POSTGRES_HOST that each API container on $(hostname)
was created with, and it is wrong for a node whose role is $ROLE:

$(for c in $db_wrong; do printf '  %s\n' "$c"; done)

$db_why

The usual cause is a compose invocation on this node that used the wrong -f
list. Put this node's colours back on the right data plane with:

  $db_fix

Neither node sets COMPOSE_FILE and neither has a project .env, so no overlay is
ever added implicitly - the explicit -f list above is the only supported
invocation. A bare docker compose up -d in $APP_DIR does not load
docker-compose.prod.yml at all, and if a stray docker-compose.yml is left in
that directory then Compose loads that file instead: a dev postgres with a
well-known password and no connection to the cluster."
  problems=$((problems + 1))
fi

# ---------- 5. the other node ----------
if [ -n "$PEER_WG" ]; then
  if ping -c 3 -W 2 "$PEER_WG" >/dev/null 2>&1; then
    resolve peer-node-down
    log "peer $PEER_WG reachable over wireguard"
  else
    if [ "$ROLE" = "peer" ]; then
      notify CRITICAL peer-node-down "primary node $PEER_WG is unreachable" \
"The peer at $PEER_WG does not answer ping from $(hostname).

This node holds no database of its own: api-a and api-b here point at
$PEER_WG:9101 for Postgres and $PEER_WG:9102 for Redis. While the primary is
unreachable this node cannot authenticate a single request, and because DNS
points the public name at the primary, the site is down for everyone."
    else
      notify WARN peer-node-down "peer node $PEER_WG is unreachable" \
"The peer at $PEER_WG does not answer ping from $(hostname).

Requests are load balanced across both nodes, so the cluster is now running on
this host alone. The site should still be serving - it will just have no spare
capacity, and the offsite backup copy is no longer being refreshed."
    fi
    problems=$((problems + 1))
  fi
fi

if [ "$ROLE" = "primary" ]; then
  # The peer's Caddy publishes 8080 on the tunnel for exactly this.
  peer_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
    "http://$PEER_WG:8080/api/health" 2>/dev/null || echo 000)"
  if [ "$peer_code" = "200" ]; then
    resolve peer-api-down
  else
    notify WARN peer-api-down "peer API not answering (HTTP $peer_code)" \
"The peer node's Caddy at $PEER_WG:8080 answered HTTP ${peer_code} instead of 200.

Caddy on this host health-checks that same URL every 5s and will eject the peer
from the API and web pools after a single failure, so traffic should already be
flowing to the local colour only. Expect reduced capacity, not an outage."
    problems=$((problems + 1))
  fi
fi

if [ "$ROLE" = "peer" ]; then
  # The dependency that actually matters here: without the primary's Postgres
  # and Redis this node serves errors, no matter how healthy its own containers
  # look. Ping alone would happily pass while both are dead.
  for spec in "postgres:9101" "redis:9102"; do
    svc="${spec%%:*}"; port="${spec##*:}"
    if timeout 8 bash -c "cat < /dev/null > /dev/tcp/$PEER_WG/$port" 2>/dev/null; then
      resolve "peer-data-$svc"
    else
      notify CRITICAL "peer-data-$svc" "primary $svc unreachable at $PEER_WG:$port" \
"This node cannot open a TCP connection to the primary's $svc at
$PEER_WG:$port, which is what api-a and api-b here use for every request.

The primary may be up (it answers ping) while $svc alone is down - for example
its container restarted, or filesystem I/O errors stopped Postgres accepting
connections. Treat it as a full outage: no logins, no writes.

  ssh root@$PEER_WG 'docker ps --filter name=$svc; docker logs --tail 50 hopedesign-erp-$svc-1'"
      problems=$((problems + 1))
    fi
  done
fi

# ---------- 6. the peer's own watchdog heartbeat ----------
# This script is the thing that reports a dead node, so it needs a watcher too.
# The primary holds an SSH key for the peer (deploy/offsite-backup-sync.sh), so
# it can read the peer's heartbeat over the tunnel; the reverse key does not
# exist, so the peer checks the primary by reachability instead (checks 5/6).
if [ "$ROLE" = "primary" ]; then
  if ssh -i "$PEER_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no \
       -o ConnectTimeout=10 "root@$PEER_WG" \
       "cat $HEARTBEAT 2>/dev/null" > "$PEER_HB_LOCAL.tmp" 2>/dev/null \
     && [ -s "$PEER_HB_LOCAL.tmp" ]; then
    mv "$PEER_HB_LOCAL.tmp" "$PEER_HB_LOCAL"
    peer_hb="$(sed -n 's/^\([^ ]*\) .*/\1/p' "$PEER_HB_LOCAL" | head -n 1)"
    peer_hb_epoch="$(date -u -d "$peer_hb" +%s 2>/dev/null || echo 0)"
    if [ "$peer_hb_epoch" -gt 0 ]; then
      peer_hb_age=$(( ( $(date +%s) - peer_hb_epoch ) / 60 ))
      if [ "$peer_hb_age" -le "$PEER_WATCH_MAX_MINUTES" ]; then
        resolve peer-node-watch-stale
        log "peer node-watch heartbeat age ${peer_hb_age}m (ok)"
      else
        notify WARN peer-node-watch-stale "peer watchdog has not run in ${peer_hb_age}m" \
"The peer node's node-watch.sh writes a heartbeat every 3 minutes and the one on
$PEER_WG is ${peer_hb_age} minutes old (limit ${PEER_WATCH_MAX_MINUTES}m).

That watchdog is what tells you when THIS node dies. While it is not running,
either node can fail without anyone being emailed. Check it on the peer:

  ssh root@$PEER_WG 'tail -20 /opt/hopedesign_erp/logs/node-watch.log'
  ssh root@$PEER_WG 'crontab -l | grep node-watch'"
        problems=$((problems + 1))
      fi
    fi
  else
    rm -f "$PEER_HB_LOCAL.tmp"
    notify WARN peer-node-watch-unreachable "cannot read peer watchdog heartbeat" \
"SSH from $(hostname) to root@$PEER_WG failed, so the peer's node-watch.sh
heartbeat could not be read.

This is the same key deploy/offsite-backup-sync.sh uses to ship backups off this
host. If it has stopped working, offsite backups are ALSO silently no longer
being copied - check that first:

  ssh -i $PEER_SSH_KEY -o BatchMode=yes root@$PEER_WG true
  tail -20 $LOG_DIR/offsite-sync.log"
    problems=$((problems + 1))
  fi
fi

# ---------- 7. this host's own watchdog heartbeat ----------
printf '%s role=%s host=%s problems=%s\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$ROLE" "$(hostname)" "$problems" > "$HEARTBEAT"

log "cycle end role=$ROLE problems=$problems local=$local_code public=$public_code disk=${disk_pct}%"

if [ "$problems" -eq 0 ]; then
  resolve node-multiple-problems
else
  # Complements the per-check alerts above: one mail when a host is degrading
  # on several fronts at once, which usually means one root cause.
  if [ "$problems" -ge 3 ]; then
    notify CRITICAL node-multiple-problems "$problems simultaneous problems on $(hostname)" \
"node-watch.sh found $problems failing checks on $(hostname) in a single cycle
(local=$local_code public=$public_code disk=${disk_pct}%). Several independent
checks failing together normally means one shared cause - disk, network or
memory - rather than $problems separate faults.

  tail -40 $LOG_FILE"
  fi
fi

exit 0
