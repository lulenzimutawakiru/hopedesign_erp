#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - TUNNEL INGRESS ROUTE RECONCILER
#
# Owns the Cloudflare tunnel's ingress routes - the hostname -> origin rules
# that decide what the tunnel actually serves - from the tracked table in
# deploy/tunnel-routes.txt.
#
# WHY THIS EXISTS
#   The tunnel is ONE remotely-managed tunnel with a connector on each node, so
#   the Cloudflare edge fails over between them and a dead node costs nothing.
#   Its ROUTES, though, lived only in the Zero Trust dashboard: no file, no
#   review, no diff, and no way to tell a fresh node what it was supposed to
#   serve. deploy/tunnel-routes.txt is now the tracked copy of that list and
#   this script is its owner - the same job deploy/mesh-routes.sh does for the
#   Caddy cross-node fragments.
#
#   That file is the source of truth, not the dashboard and not a hand-built
#   copy that may already sit on a host: a node configured by hand before this
#   existed gets reconciled onto the tracked table, and a host copy is never
#   mistaken for review. And a tracked list is still only a list - nothing
#   reaches the edge until a mode is set in deploy/tunnel-ingress.env, which is
#   why an unset mode is reported loudly below rather than passed over.
#
# THE ORIGIN RULE (get this wrong and the route breaks silently)
#   Every route targets https://172.17.0.1:443. Not localhost, not 127.0.0.1,
#   and not :80.
#     * cloudflared runs on the default docker bridge, so localhost/127.0.0.1
#       resolve inside its OWN container netns, where Caddy is not listening.
#       The route 502s and no host-side check ever sees why.
#     * 172.17.0.1 is the bridge gateway - the host - from inside that netns.
#       Caddy publishes 443 there, so that is the address that reaches it.
#     * :80 must not be used. Caddy answers plain HTTP there with a 308
#       redirect to https. Once the name is proxied through the tunnel, that
#       redirect is followed back through the edge into this same rule and
#       loops forever. Terminating TLS at the origin avoids the loop entirely.
#   originServerName is set per hostname so Caddy receives the SNI it needs to
#   select the right site block and certificate. Certificate verification is
#   deliberately LEFT ON: a name in the table that Caddy has no certificate for
#   then fails loudly instead of quietly serving a certificate error to users.
#   jorlentech.com is exactly that case today - the apex has no site block.
#
# WHAT IT CANNOT DO, AND SAYS SO RATHER THAN DOING NOTHING
#   A route only carries traffic if the hostname's DNS points at the tunnel, and
#   that requires the zone to be on Cloudflare. This script checks the zone's
#   nameservers and reports the answer; it never pretends a route is live when
#   the name still resolves straight to an origin IP.
#
#   It also cannot invent an API credential. Applying routes through the API
#   needs CLOUDFLARE_API_TOKEN with Account: Cloudflare Tunnel:Edit. When that is
#   absent the script refuses to guess and raises a CRITICAL alert naming the
#   exact dashboard step - the same loud-degrade shape deploy/dns-failover.sh
#   uses for a missing DNS_PROVIDER. A silent no-op would report success while
#   the tunnel served nothing.
#
#   When there is no way to apply the routes, it does not stop at describing the
#   problem: render_manual_block prints the exact dashboard rows to paste, built
#   from the same table this script would have applied - so the by-hand path
#   cannot drift from the automatic one, and nobody has to retype a hostname out
#   of a comment.
#
# MODES
#   TUNNEL_MODE is read from the environment, then deploy/tunnel-ingress.env:
#     api     PUT the rules to the Cloudflare API. Needs CLOUDFLARE_API_TOKEN
#             and CF_ACCOUNT_ID. This is the only mode that changes a
#             remotely-managed tunnel's routes programmatically.
#     local   Render deploy/cloudflared/config.yml (+ credentials.json, built
#             from the token, which is exactly those three fields base64'd) and
#             an additive compose overlay that passes --config. Run the printed
#             `up -d` to adopt it. Kept separate from the base compose file so
#             an ERP deploy still cannot touch the ingress container.
#     unset   Loud CRITICAL alert plus the rows to add by hand, printed ready to
#             paste. The safe default: an unset mode is a known state, not a
#             failure, so apply says its piece and exits 0.
#
# FLAGS
#   --only-if-configured is a flag, not a mode, and combines with any of the
#   above. It tells the script that this host may legitimately have never opted
#   in: when there is no deploy/tunnel-ingress.env AND no TUNNEL_MODE in the
#   environment, it exits 0 without logging and without alerting.
#
#   Frequent callers need it. The deploy hook checks for route drift on every
#   rollout, and on a node that never configured the tunnel the unset path
#   would raise a CRITICAL alert every time - and an alert that fires on a
#   healthy, unconfigured node is indistinguishable from one that fires on a
#   broken node, which is how real alerts get filtered into a folder nobody
#   reads. A mode exported into the environment still counts as configured, so
#   a hand-run is never silenced by this.
#
# Usage:
#   bash deploy/tunnel-ingress.sh              # reconcile
#   bash deploy/tunnel-ingress.sh --dry-run    # show drift, write nothing
#   bash deploy/tunnel-ingress.sh status       # report only
# Needs root.
#############################################################
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
DEPLOY_DIR="$APP_DIR/deploy"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/tunnel-ingress.log"
ALERT_BIN="$DEPLOY_DIR/alert.sh"
TUNNEL_ENV_FILE="$DEPLOY_DIR/cloudflared.env"
FAILOVER_ENV_FILE="$DEPLOY_DIR/failover.env"
INGRESS_ENV_FILE="$DEPLOY_DIR/tunnel-ingress.env"
ROUTES_FILE="$DEPLOY_DIR/tunnel-routes.txt"
OUT_DIR="$DEPLOY_DIR/cloudflared"
CONFIG_OUT="$OUT_DIR/config.yml"
CREDS_OUT="$OUT_DIR/credentials.json"
COMPOSE_BASE="$DEPLOY_DIR/docker-compose.cloudflared.yml"
COMPOSE_LOCAL="$DEPLOY_DIR/docker-compose.cloudflared.local.yml"
TUNNEL_CONTAINER="hopedesign-erp-cloudflared"
# The uid the connector process actually runs as inside the container. The
# cloudflare/cloudflared image drops to its own non-root user (65532), which is
# why a root-owned 0600 credentials.json is unreadable to it. Override in
# deploy/tunnel-ingress.env only if the image pin ever changes that user.
TUNNEL_CREDS_UID="${TUNNEL_CREDS_UID:-65532}"
CF_API="https://api.cloudflare.com/client/v4"

mkdir -p "$LOG_DIR" 2>/dev/null || true

now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[tunnel $(now)] $*" >> "$LOG_FILE"; }

envget() { # $1 = KEY -> value from .env.production, quotes stripped
  local v
  v="$(sed -n "s/^$1=//p" "$APP_DIR/.env.production" 2>/dev/null | tail -1)"
  v="${v%\"}"; v="${v#\"}"
  v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# Loud-degrade alerting, copied from deploy/dns-failover.sh so both scripts
# report a missing helper the same way instead of one of them going quiet.
notify() { # $1 severity, $2 key, $3 subject, $4 body
  [[ -x "$ALERT_BIN" ]] || { log "no alert.sh - would have sent [$1] $3"; return 0; }
  "$ALERT_BIN" send "$1" "$2" "$3" "${4:-}" >> "$LOG_FILE" 2>&1 \
    || log "WARN: alert.sh send failed for key $2"
}

# shellcheck disable=SC1090
[[ -f "$FAILOVER_ENV_FILE" ]] && . "$FAILOVER_ENV_FILE"

# Operator-supplied tunnel settings: TUNNEL_MODE, CLOUDFLARE_API_TOKEN,
# CF_ACCOUNT_ID, ZONE, TUNNEL_APPLY_LOCAL.
#
# WHY THIS IS SOURCED, AND SOURCED HERE
#   Without it the only way to set TUNNEL_MODE was to export it by hand into
#   the shell that runs this script - and the caller that matters is cron,
#   which inherits nothing. The mode then read as unset on every run and the
#   script fell through to its by-hand path forever, while the header, the
#   status output and the CRITICAL alert all told the operator to "set it in
#   deploy/tunnel-ingress.env" - a file nothing ever opened. This line is that
#   instruction finally being true.
#
#   It is sourced AFTER failover.env on purpose. Both files may set ZONE, and
#   the file named after this script is the more specific answer, so it has to
#   win the last write. TUNNEL_MODE and the API credential have no counterpart
#   in failover.env, so nothing else changes hands.
# shellcheck disable=SC1090
[[ -f "$INGRESS_ENV_FILE" ]] && . "$INGRESS_ENV_FILE"

ZONE="${ZONE:-jorlentech.com}"
TUNNEL_MODE="${TUNNEL_MODE:-}"

# ---- tunnel identity -------------------------------------------------------
TOKEN_FILE_STATE="absent"
FILE_TOKEN=""
if [[ -f "$TUNNEL_ENV_FILE" ]]; then
  TOKEN_FILE_STATE="present"
  FILE_TOKEN="$(sed -n 's/^TUNNEL_TOKEN=//p' "$TUNNEL_ENV_FILE" | tail -1)"
  FILE_TOKEN="${FILE_TOKEN%\"}"; FILE_TOKEN="${FILE_TOKEN#\"}"
fi
TUNNEL_TOKEN="${TUNNEL_TOKEN:-$FILE_TOKEN}"

# The bearer token is base64({"a":account,"t":tunnel-id,"s":secret}). Decoding it
# locally means the tunnel id never has to be hand-copied into a config file, so
# it cannot drift from the token that is actually running. Padding is added
# defensively: some tokens are not a multiple of four characters.
token_tunnel_id() { # $1 = token -> tunnel uuid, empty if undecodable
  local tok="$1" json pad p i
  [[ -n "$tok" ]] || return 1
  json="$(printf '%s' "$tok" | base64 -d 2>/dev/null)"
  if [[ -z "$json" ]]; then
    pad=$(( (4 - ${#tok} % 4) % 4 )); p=""; i=0
    while [[ "$i" -lt "$pad" ]]; do p="${p}="; i=$((i+1)); done
    json="$(printf '%s%s' "$tok" "$p" | base64 -d 2>/dev/null)"
  fi
  [[ -n "$json" ]] || return 1
  printf '%s' "$json" | sed -n 's/.*"t"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

TUNNEL_ID="${TUNNEL_ID:-$(token_tunnel_id "$TUNNEL_TOKEN")}"
ACCOUNT_ID_FROM_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | base64 -d 2>/dev/null | sed -n 's/.*"a"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

# ---- desired state ---------------------------------------------------------
routes_lines() { grep -Ev '^[[:space:]]*(#|$)' "$ROUTES_FILE" 2>/dev/null; }
route_count() { routes_lines | wc -l | tr -d ' '; }

routes_valid() { # every line must be "<hostname> <http(s)://...>" and nothing else
  local host svc
  [[ -s "$ROUTES_FILE" ]] || return 1
  while read -r host svc extra; do
    [[ -n "$host" && -n "$svc" && -z "${extra:-}" ]] || return 1
    [[ "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || return 1
    [[ "$svc" =~ ^https?://[^[:space:]]+$ ]] || return 1
  done < <(routes_lines)
  return 0
}

# The canonical, order-stable signature of the desired routes. Used both to
# render the config and to decide whether the live tunnel already matches.
routes_signature() {
  local host svc
  while read -r host svc _; do
    printf '%s %s\n' "$host" "$svc"
  done < <(routes_lines)
}

# ---- live state ------------------------------------------------------------
# Only the hostname/service pair is compared. originRequest and the trailing
# catch-all are derived from the table, so if the pairs match the rest does.
api_pairs() {
  curl -fsS --max-time 15 \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "$CF_API/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" 2>/dev/null \
    | tr -d '\n' \
    | sed -n 's/.*"ingress"[[:space:]]*:[[:space:]]*\[\(.*\)\].*/\1/p' \
    | grep -o '"hostname":"[^"]*"\|"service":"[^"]*"' \
    | sed 's/"hostname"://; s/"service"://; s/"//g' \
    | paste - - 2>/dev/null
}

local_pairs() {
  [[ -f "$CONFIG_OUT" ]] || return 0
  awk '/^[[:space:]]*-[[:space:]]*hostname:/ {h=$NF}
       /^[[:space:]]*service:/ {print h" "$NF}' "$CONFIG_OUT" 2>/dev/null
}

# ---- origin reachability ---------------------------------------------------
# Asks the host's own Caddy, with the public name as SNI, whether it serves that
# name at all. Certificate verification is on, so a name Caddy has no
# certificate for reports FAIL - which is the truth, and is the whole point.
#
# There are two kinds of origin in the table and they cannot be checked the same
# way. Only the ERP hostname answers with the API's health payload; the status
# page has its own backend, so demanding that payload of it would report FAIL
# for a route that works - a check that cries wolf is worse than no check.
ERP_HOST="hopedesign.jorlentech.com"

origin_ok() { # $1 = hostname
  local h="$1" body code rc
  if [[ "$h" == "$ERP_HOST" ]]; then
    body="$(curl -fsS --max-time 8 --resolve "$h:443:127.0.0.1" "https://$h/api/health" 2>/dev/null)"
    rc=$?
    [[ "$rc" -eq 0 ]] || return 1
    printf '%s' "$body" | grep -Eq '"service"[[:space:]]*:[[:space:]]*"hopedesign-erp-api"' || return 1
    printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || return 1
    return 0
  fi
  # Anything else: did Caddy accept the connection and hand back a real page?
  # Verification stays ON, so 000 means the handshake never completed - Caddy
  # has no site or certificate for this name, the same truth the ERP branch
  # reports. 404 means it answered but matched no site, and 5xx means the site
  # is there but its backend is down; both would be an error page for a user.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$h:443:127.0.0.1" "https://$h/" 2>/dev/null)"
  case "$code" in
    ""|000|404|5??) return 1 ;;
  esac
  return 0
}

# ---- DNS precondition ------------------------------------------------------
zone_ns() {
  curl -fsS --max-time 10 "https://dns.google/resolve?name=${ZONE}&type=NS" 2>/dev/null \
    | tr ',' '\n' | sed -n 's/.*"data":"\([^"]*\)".*/\1/p' | grep -i '\.$' | tr '\n' ' '
}
zone_on_cloudflare() { zone_ns | grep -qi 'ns\.cloudflare\.com'; }

# ---- is the connector actually connected? ----------------------------------
# Everything else in `status` describes the FILES this node rendered. None of it
# notices that the container cannot READ them. A credentials.json left
# root-owned is unreadable to the image's non-root user (65532), so cloudflared
# dies with "couldn't read tunnel credentials ... permission denied" and
# crash-loops - while `mode=local provider_ready=yes routes=in-sync` still reads
# as perfectly healthy. That combination took this node's ingress down on
# 2026-09-26, so report the container's own view of the tunnel as well.
connector_line() {
  local running restarts conns err
  if ! docker inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1; then
    printf 'connector=absent\n'
    return 0
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$TUNNEL_CONTAINER" 2>/dev/null)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$TUNNEL_CONTAINER" 2>/dev/null)"
  conns="$(docker logs --tail 400 "$TUNNEL_CONTAINER" 2>&1 \
            | sed -n 's/.*Registered tunnel connection.*connIndex=\([0-9][0-9]*\).*/\1/p' \
            | sort -u | wc -l | tr -d ' ')"
  if [[ "$running" == "true" && "${conns:-0}" -gt 0 ]]; then
    printf 'connector=running connections=%s restarts=%s\n' "$conns" "$restarts"
    return 0
  fi
  if [[ "$running" == "true" ]]; then
    printf 'connector=no-connections restarts=%s\n' "$restarts"
  else
    printf 'connector=down restarts=%s\n' "$restarts"
  fi
  # The last ERR is the whole diagnosis; strip the timestamp and anything that
  # looks like a tunnel token so `status` stays safe to paste into a ticket.
  err="$(docker logs --tail 60 "$TUNNEL_CONTAINER" 2>&1 \
          | grep -i 'ERR' | tail -1 \
          | sed -E 's#eyJ[A-Za-z0-9_-]{20,}#TOK#g; s/^[0-9T:.+-]+Z +//' \
          | cut -c1-160)"
  [[ -n "$err" ]] && printf 'connector_note=%s\n' "$err"
  return 0
}
dns_points_at_tunnel() { # $1 = hostname
  local h="$1" body
  body="$(curl -fsS --max-time 10 "https://dns.google/resolve?name=$h&type=CNAME" 2>/dev/null)"
  printf '%s' "$body" | grep -q 'cfargotunnel' || return 1
  return 0
}

# ---- the step that has to be done by hand ----------------------------------
# When this host cannot apply the routes, the only honest thing left is to say
# exactly what to do instead. That used to be one sentence inside an alert body,
# with the hostnames left for the reader to pick out of the routes file and
# retype; a hostname retyped by hand is a hostname that can be typed wrong.
#
# So the rows are generated from the same table the reconciler would have
# applied, which means the manual path cannot drift from the automatic one. Each
# row is annotated with whether THIS node's Caddy actually serves that name, so
# the person adding them can see which will work and which is deliberately
# listed while waiting on a site block.
#
# Never fails on purpose: no exit code, no alert, every command guarded. This is
# advice, and a script that dies while explaining itself is worse than one that
# says nothing. stdout is left alone - `status` prints machine-readable
# key=value lines there and this would corrupt them.
render_manual_block() { # $1 = why the routes cannot be applied from here
  local host svc note ns
  ns="$(zone_ns 2>/dev/null || true)"
  {
    printf '\n'
    printf 'TUNNEL INGRESS: MANUAL STEP REQUIRED\n'
    printf '====================================\n'
    printf 'tunnel : %s\n' "${TUNNEL_ID:-<undetermined>}"
    printf 'zone   : %s\n' "$ZONE"
    printf 'reason : %s\n' "${1:-TUNNEL_MODE is unset}"
    printf '\n'
    printf 'STEP 1 - put %s on Cloudflare nameservers.\n' "$ZONE"
    printf '         It answers on: %s\n' "${ns:-<none found>}"
    printf '         Until it does, no hostname below can resolve to the tunnel\n'
    printf '         and every route carries nothing.\n'
    printf '\n'
    printf 'STEP 2 - Zero Trust -> Networks -> Tunnels -> %s\n' "${TUNNEL_ID:-<tunnel>}"
    printf '         -> Public Hostnames. Add one row per line, then Save:\n'
    printf '\n'
    printf '   %-26s %-34s %s\n' HOSTNAME SERVICE 'ORIGIN SERVER NAME'
    while read -r host svc _; do
      if origin_ok "$host"; then
        note='served by this node now'
      else
        note='NO Caddy site/cert on this node yet - will fail until it is added'
      fi
      printf '   %-26s %-34s %s\n' "$host" "$svc" "$host"
      printf '   %-26s %-34s %s\n' '' '' "($note)"
    done < <(routes_lines)
    printf '\n'
    printf 'STEP 3 - Cloudflare -> %s -> DNS: make each hostname above a\n' "$ZONE"
    printf '         proxied (orange cloud) CNAME to:\n'
    printf '           %s.cfargotunnel.com\n' "${TUNNEL_ID:-<tunnel>}"
    printf '\n'
    printf 'Everything above is derived from %s,\n' "$ROUTES_FILE"
    printf 'so it matches what this script would have applied on its own.\n'
    printf '\n'
  } | tee -a "$LOG_FILE" >&2 || true
}

# ---- rendering -------------------------------------------------------------
render_config() {
  local host svc
  printf '# GENERATED by deploy/tunnel-ingress.sh - do not edit by hand.\n'
  printf '# Desired state lives in deploy/tunnel-routes.txt.\n'
  printf 'tunnel: %s\n' "${TUNNEL_ID:-<unset>}"
  if [[ "$TUNNEL_MODE" == "local" ]]; then
    printf 'credentials-file: /etc/cloudflared/credentials.json\n'
  fi
  printf 'ingress:\n'
  while read -r host svc _; do
    printf '  - hostname: %s\n' "$host"
    printf '    service: %s\n' "$svc"
    printf '    originRequest:\n'
    printf '      originServerName: %s\n' "$host"
  done < <(routes_lines)
  printf '  # Mandatory catch-all: a tunnel with no terminal rule refuses to start.\n'
  printf '  - service: http_status:404\n'
}

# The token IS the credentials file, base64'd: {"a":account,"t":tunnel,"s":secret}.
# Rebuilding it is what lets this run in local mode at all, because neither host
# has a cert.pem and neither can therefore mint one with `cloudflared tunnel
# token`/login.
render_credentials() {
  local json t a s
  json="$(printf '%s' "$TUNNEL_TOKEN" | base64 -d 2>/dev/null)"
  [[ -n "$json" ]] || return 1
  t="$(printf '%s' "$json" | sed -n 's/.*"t"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  a="$(printf '%s' "$json" | sed -n 's/.*"a"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  s="$(printf '%s' "$json" | sed -n 's/.*"s"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [[ -n "$t" && -n "$a" && -n "$s" ]] || return 1
  printf '{"AccountTag":"%s","TunnelID":"%s","TunnelSecret":"%s"}\n' "$a" "$t" "$s"
}

render_compose_overlay() {
  cat <<EOF
# GENERATED by deploy/tunnel-ingress.sh - do not edit by hand.
#
# Additive overlay: mount the rendered config and credentials and pass --config,
# WITHOUT changing one line of docker-compose.cloudflared.yml. Keeping it
# separate matters - the base file is what an ERP deploy reasons about, and the
# ingress container must stay outside that blast radius.
#
#   docker compose -f deploy/docker-compose.cloudflared.yml \\
#     -f deploy/docker-compose.cloudflared.local.yml \\
#     --env-file deploy/cloudflared.env up -d
services:
  cloudflared:
    volumes:
      - ./cloudflared/config.yml:/etc/cloudflared/config.yml:ro
      - ./cloudflared/credentials.json:/etc/cloudflared/credentials.json:ro
    # In local mode the credentials FILE replaces --token: a token-run connector
    # is remotely-managed and takes its routes from the dashboard, so passing
    # both would silently ignore the config mounted above.
    command:
      - tunnel
      - --no-autoupdate
      - --config
      - /etc/cloudflared/config.yml
      - run
      - ${TUNNEL_ID}
EOF
}

#############################################################
# Entry points
#############################################################

MODE="apply"
ONLY_IF_CONFIGURED=0
for arg in "$@"; do
  case "$arg" in
    ""|--apply) MODE="apply" ;;
    --dry-run)  MODE="dry-run" ;;
    status)     MODE="status" ;;
    --only-if-configured) ONLY_IF_CONFIGURED=1 ;;
    *) echo "usage: tunnel-ingress.sh {status|--dry-run} [--only-if-configured]" >&2; exit 2 ;;
  esac
done

# Fast guard for callers on a schedule. "No env file and no exported mode" is
# not a misconfiguration on a node that was never meant to apply tunnel routes:
# it is simply not this host job, so leave without a word instead of logging and
# emailing on every run. An exported TUNNEL_MODE still counts as configured, so
# a hand-run with the mode in the environment is never silenced.
if [[ "$ONLY_IF_CONFIGURED" == "1" && ! -f "$INGRESS_ENV_FILE" && -z "${TUNNEL_MODE:-}" ]]; then
  exit 0
fi

if [[ ! -f "$ROUTES_FILE" ]]; then
  log "FATAL: $ROUTES_FILE is missing - there is no desired route set to reconcile to"
  exit 1
fi
if ! routes_valid; then
  # An unparseable table must never be pushed to the edge: a malformed rule can
  # remove a live hostname, and a route that disappears takes the site with it.
  log "FATAL: $ROUTES_FILE is not a list of '<hostname> <http(s)://service>' lines - refusing to apply"
  exit 1
fi

WANT="$(routes_signature)"
NFIRST="$(route_count)"

if [[ "$MODE" == "status" ]]; then
  printf 'tunnel_id=%s\n' "${TUNNEL_ID:-<undetermined>}"
  printf 'token_file=%s routes_file=%s routes=%s\n' "$TOKEN_FILE_STATE" "$ROUTES_FILE" "$NFIRST"
  printf 'mode=%s\n' "${TUNNEL_MODE:-<unset>}"
  connector_line

  case "$TUNNEL_MODE" in
    api)
      if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CF_ACCOUNT_ID:-}" && -n "${TUNNEL_ID:-}" ]]; then
        printf 'provider_ready=yes\n'
        HAVE="$(api_pairs)"
        if [[ "$HAVE" == "$WANT" ]]; then printf 'routes=in-sync\n'; else printf 'routes=drift\n'; fi
      else
        printf 'provider_ready=no\n'
        printf 'provider_note=TUNNEL_MODE=api needs CLOUDFLARE_API_TOKEN (Account: Cloudflare Tunnel:Edit) and CF_ACCOUNT_ID\n'
        render_manual_block 'TUNNEL_MODE=api but no usable Cloudflare credential is configured'
      fi
      ;;
    local)
      printf 'provider_ready=yes\n'
      HAVE="$(local_pairs)"
      if [[ "$HAVE" == "$WANT" ]]; then printf 'routes=in-sync\n'; else printf 'routes=drift\n'; fi
      printf 'config=%s overlay=%s\n' \
        "$( [[ -f "$CONFIG_OUT" ]] && echo present || echo absent )" \
        "$( [[ -f "$COMPOSE_LOCAL" ]] && echo present || echo absent )"
      ;;
    *)
      printf 'provider_ready=no\n'
      printf 'provider_note=TUNNEL_MODE is unset - routes cannot be applied from this host; set it in deploy/tunnel-ingress.env\n'
      render_manual_block 'TUNNEL_MODE is unset - routes cannot be applied from this host'
      ;;
  esac

  if zone_on_cloudflare; then
    printf 'zone=%s nameservers=%s\n' "$ZONE" "$(zone_ns)"
    printf 'zone_ready=yes\n'
  else
    printf 'zone=%s nameservers=%s\n' "$ZONE" "$(zone_ns)"
    printf 'zone_ready=no\n'
    printf 'zone_note=%s is not on Cloudflare, so no hostname can resolve to the tunnel yet\n' "$ZONE"
  fi

  while read -r host _; do
    d="$(dns_points_at_tunnel "$host" && echo tunnel || echo origin-or-none)"
    if origin_ok "$host"; then o=ok; else o=FAIL; fi
    printf 'route=%s dns=%s origin=%s\n' "$host" "$d" "$o"
  done < <(routes_lines)

  exit 0
fi

# ---- drift check -----------------------------------------------------------
HAVE=""
case "$TUNNEL_MODE" in
  api)   HAVE="$(api_pairs)" ;;
  local) HAVE="$(local_pairs)" ;;
esac

if [[ "$TUNNEL_MODE" == "api" && -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CF_ACCOUNT_ID:-}" && "$HAVE" == "$WANT" ]]; then
  echo "  ok      ${NFIRST} routes  matches the live tunnel configuration"
  log "in sync; nothing to do"
  exit 0
fi

echo "  DRIFT   desired ${NFIRST} routes from $ROUTES_FILE"
routes_lines | sed 's/^/            /'

if [[ "$MODE" == "dry-run" ]]; then
  echo "  (dry-run: drift above, nothing written)"
  exit 0
fi

# ---- apply -----------------------------------------------------------------
case "$TUNNEL_MODE" in
  api)
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CF_ACCOUNT_ID:-}" ]]; then
      log "TUNNEL_MODE=api but CLOUDFLARE_API_TOKEN/CF_ACCOUNT_ID are unset - cannot apply"
      notify CRITICAL tunnel-ingress-manual \
        "Tunnel routes for $ZONE must be applied BY HAND" \
        "deploy/tunnel-ingress.sh is in api mode but has no usable credential (CLOUDFLARE_API_TOKEN with Account: Cloudflare Tunnel:Edit, plus CF_ACCOUNT_ID). Add them to deploy/tunnel-ingress.env, or set the routes in the dashboard: Zero Trust -> Networks -> Tunnels -> ${TUNNEL_ID:-<tunnel>} -> Public Hostnames. Until then the tunnel serves none of: $(routes_signature | awk '{printf "%s ", $1}')"
      exit 2
    fi
    if [[ -z "${TUNNEL_ID:-}" ]]; then
      log "FATAL: could not determine the tunnel id from $TUNNEL_ENV_FILE and TUNNEL_ID is unset"
      exit 1
    fi

    body="$(printf '{"config":{"ingress":[' ; \
      routes_lines | while read -r host svc _; do
        printf '{"hostname":"%s","service":"%s","originRequest":{"originServerName":"%s"}},' "$host" "$svc" "$host"
      done ; \
      printf '{"service":"http_status:404"}]}}')"

    resp="$(curl -fsS --max-time 20 -X PUT \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data "$body" \
      "$CF_API/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" 2>/dev/null)"
    rc=$?
    if [[ "$rc" != "0" ]] || ! printf '%s' "$resp" | grep -q '"success":true'; then
      log "API PUT failed (rc=$rc)"
      notify CRITICAL tunnel-ingress-api-failed \
        "Tunnel routes could not be applied to $ZONE" \
        "The Cloudflare API rejected the tunnel configuration update for ${TUNNEL_ID:-<tunnel>} (curl rc=$rc). The dashboard routes are unchanged. Check that the token still has Account: Cloudflare Tunnel:Edit, then re-run deploy/tunnel-ingress.sh."
      exit 1
    fi
    log "applied ${NFIRST} routes to tunnel ${TUNNEL_ID} via the API"
    ;;

  local)
    mkdir -p "$OUT_DIR" || { log "FATAL: cannot create $OUT_DIR"; exit 1; }

    tmp="$CONFIG_OUT.tmp.$$"
    render_config > "$tmp" || { log "FATAL: could not render $CONFIG_OUT"; rm -f "$tmp"; exit 1; }
    chmod 0644 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$CONFIG_OUT" 2>/dev/null || { log "FATAL: cannot write $CONFIG_OUT"; exit 1; }

    if ! render_credentials > "$CREDS_OUT.tmp.$$" 2>/dev/null; then
      rm -f "$CREDS_OUT.tmp.$$"
      log "FATAL: cannot rebuild credentials.json from the token in $TUNNEL_ENV_FILE"
      notify CRITICAL tunnel-ingress-no-creds \
        "Tunnel local config cannot be built on this node" \
        "deploy/cloudflared.env holds no decodable TUNNEL_TOKEN, so deploy/tunnel-ingress.sh cannot write the credentials file that local mode needs. Set TUNNEL_TOKEN (Zero Trust -> Networks -> Tunnels -> Install and run a connector -> Docker) and re-run."
      exit 1
    fi
    # The mounted credentials file is read by the CONTAINER process, not by
    # root on the host: cloudflared runs as the image user (65532:65532). A
    # root-owned 0600 file therefore fails with "couldn't read tunnel
    # credentials ... permission denied" and the connector crash-loops while
    # the host-side checks still look fine. Give the file to that user and
    # keep the mode at 0600; only a host that refuses the numeric uid falls
    # back to 0644, which is still no wider than the token it was built from.
    if chown "$TUNNEL_CREDS_UID:$TUNNEL_CREDS_UID" "$CREDS_OUT.tmp.$$" 2>/dev/null; then
      chmod 0600 "$CREDS_OUT.tmp.$$" 2>/dev/null || true
    else
      chmod 0644 "$CREDS_OUT.tmp.$$" 2>/dev/null || true
    fi
    mv -f "$CREDS_OUT.tmp.$$" "$CREDS_OUT" 2>/dev/null || { log "FATAL: cannot write $CREDS_OUT"; exit 1; }

    render_compose_overlay > "$COMPOSE_LOCAL.tmp.$$" || { log "FATAL: cannot render overlay"; rm -f "$COMPOSE_LOCAL.tmp.$$"; exit 1; }
    mv -f "$COMPOSE_LOCAL.tmp.$$" "$COMPOSE_LOCAL" 2>/dev/null || true

    log "rendered $CONFIG_OUT (${NFIRST} routes) and $COMPOSE_LOCAL"

    if [[ "${TUNNEL_APPLY_LOCAL:-0}" == "1" ]]; then
      if docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_LOCAL" --env-file "$TUNNEL_ENV_FILE" up -d >> "$LOG_FILE" 2>&1; then
        log "recreated $TUNNEL_CONTAINER with --config /etc/cloudflared/config.yml"
      else
        log "ERROR: docker compose up -d failed; the container is still running the old (token-only) command"
        exit 1
      fi
    else
      echo "  wrote $COMPOSE_LOCAL - adopt it with:"
      echo "    docker compose -f $COMPOSE_BASE -f $COMPOSE_LOCAL --env-file $TUNNEL_ENV_FILE up -d"
      log "overlay written but not applied (TUNNEL_APPLY_LOCAL is not 1)"
    fi
    ;;

  *)
    log "TUNNEL_MODE is unset - refusing to guess how to reach the tunnel"
    notify CRITICAL tunnel-ingress-manual \
      "Tunnel routes for $ZONE must be applied BY HAND" \
      "deploy/tunnel-ingress.sh has no TUNNEL_MODE (set it to api or local in deploy/tunnel-ingress.env). Until the routes exist, the tunnel serves none of: $(routes_signature | awk '{printf "%s ", $1}'). Set them in the dashboard: Zero Trust -> Networks -> Tunnels -> ${TUNNEL_ID:-<tunnel>} -> Public Hostnames, each pointing at https://172.17.0.1:443 with the hostname as the origin server name."
    render_manual_block 'TUNNEL_MODE is unset - set it in deploy/tunnel-ingress.env to apply automatically'
    # Not a failure. An unset mode is the known, expected state on a host whose
    # routes live in the dashboard: the alert above and the block it just
    # printed ARE the deliverable. A non-zero exit would make this look broken
    # to any caller that checks rc, when nothing is broken and nothing was
    # skipped. api mode with no credential still exits 2 - that one is a real
    # misconfiguration, because a credential was expected and is missing.
    exit 0
    ;;
esac

# ---- tell the truth about DNS ----------------------------------------------
# Routes are only half the path. Until the zone is on Cloudflare and the name
# resolves to the tunnel, users still reach the origin directly and the tunnel
# route carries nothing - so say so, once, loudly, rather than reporting a
# successful apply and leaving it at that.
if ! zone_on_cloudflare; then
  log "WARNING: $ZONE is not on Cloudflare (nameservers: $(zone_ns)) - the routes exist but no hostname can use them yet"
  notify CRITICAL tunnel-dns-cutover-pending \
    "Tunnel routes applied, but $ZONE still resolves to the origin" \
    "$ZONE uses $(zone_ns), so no record can point at the tunnel: a tunnel hostname must be a proxied CNAME to ${TUNNEL_ID:-<tunnel>}.cfargotunnel.com, which needs the zone in Cloudflare. Move the nameservers, then create that CNAME for: $(routes_signature | awk '{printf "%s, ", $1}'). Until then the tunnel is a standby path and users keep hitting the origin directly."
fi

while read -r host _; do
  origin_ok "$host" && continue
  log "WARNING: origin does not serve $host (Caddy has no site/certificate for it)"
done < <(routes_lines)

exit 0
