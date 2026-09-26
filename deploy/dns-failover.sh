#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - PUBLIC DNS POINTER MOVER
#
# Called by deploy/failover-agent.sh to point the ERP hostname at whichever node
# is currently serving. Can also be run by hand.
#
#   dns-failover.sh status            show what the world currently resolves
#   dns-failover.sh move-to-peer      point $DOMAIN at the standby node
#   dns-failover.sh move-to-primary   point $DOMAIN back at the original node
#   dns-failover.sh lower-ttl         re-publish the current address with TTL 60
#
# WHY THIS FILE HAS TO EXIST
#
# The Caddy upstream pool in deploy/Caddyfile keeps the APPLICATION alive when a
# node fails - both nodes' web replicas sit in both pools, so the frontend does
# not blink. But it cannot help with the one thing that actually decides whether
# a user reaches anything: the A record. `hopedesign.jorlentech.com` is a static
# A record pointing at a single public IP. If that host dies, every request goes
# to an address with nothing behind it, no matter how healthy the other node is.
# Nothing inside the stack can fix that; only the authoritative nameserver can.
#
# The TTL is therefore part of the redundancy story, not an afterthought. It was
# measured at 1799s (30 minutes) on BasicDNS, which sets a floor of roughly half
# an hour of dead air after any switch. Run `lower-ttl` once, at leisure, so the
# window is ~60s when it actually matters. Do that BEFORE the incident - a TTL
# you lower during an outage still has to age out of every resolver that already
# cached the old one.
#
# PROVIDERS
#
#   cloudflare  PATCHes the single A record in place. Safe: it touches nothing
#               else. Needs CLOUDFLARE_API_TOKEN (+ CF_ZONE_ID, or the zone is
#               looked up by name). This also becomes the "true zero downtime"
#               path if the zone is later moved behind Cloudflare's tunnel,
#               because the address can then be moved before the node dies.
#
#   namecheap   Uses namecheap.domains.dns.setHosts, which REPLACES THE ENTIRE
#               RECORD SET. If it is called with an incomplete list it silently
#               deletes the records that were left out - including MX, which
#               would take the ERP's own inbound mail down. So this provider
#               refuses to run unless DNS_RECORDS gives every record that should
#               exist, and it always re-sends that full set with just the A
#               address swapped. Enumerate the records first (they are listed in
#               the Namecheap panel for the domain).
#
#   (unset)     Refuses to guess and raises a CRITICAL alert naming the manual
#               step, so a failover degrades to "someone must edit DNS" rather
#               than to a silent no-op.
#
# Configuration lives in deploy/failover.env - see failover.env.example.
# This script never writes to .env.production.
#############################################################
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
DEPLOY_DIR="$APP_DIR/deploy"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/failover.log"
ALERT_BIN="$DEPLOY_DIR/alert.sh"
FAILOVER_ENV_FILE="$DEPLOY_DIR/failover.env"

now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[dns $(now)] $*" >> "$LOG_FILE"; }

envget() { # $1 = KEY -> value from .env.production, quotes stripped
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1)"
  v="${v%\"}"; v="${v#\"}"
  v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# shellcheck disable=SC1090
[[ -f "$FAILOVER_ENV_FILE" ]] && . "$FAILOVER_ENV_FILE"

ZONE="${ZONE:-jorlentech.com}"
DOMAIN="${DOMAIN:-$(envget DOMAIN)}"
DNS_PROVIDER="${DNS_PROVIDER:-}"
PRIMARY_PUBLIC_IP="${PRIMARY_PUBLIC_IP:-23.239.220.214}"
PEER_PUBLIC_IP="${PEER_PUBLIC_IP:-}"
RECORD_TTL="${RECORD_TTL:-60}"
# Refuse to point users at an address that is not actually serving the ERP.
# Turning a "primary is down" incident into a "primary and standby are both
# unreachable" incident is strictly worse.
REQUIRE_TARGET_HEALTHY="${REQUIRE_TARGET_HEALTHY:-1}"

action="${1:-status}"

notify() { # $1 severity, $2 key, $3 subject, $4 body
  [[ -x "$ALERT_BIN" ]] || { log "no alert.sh - would have sent [$1] $3"; return 0; }
  "$ALERT_BIN" send "$1" "$2" "$3" "${4:-}" >> "$LOG_FILE" 2>&1 \
    || log "WARN: alert.sh send failed for key $2"
}

resolved_ip() { # what the public internet is being told, via Google DNS
  curl -fsS --max-time 10 "https://dns.google/resolve?name=$DOMAIN&type=A" 2>/dev/null \
    | tr ',' '\n' | sed -n 's/.*"data":"\([0-9.]*\)".*/\1/p' | head -1
}

target_serving() { # $1 = ip -> does that address serve the ERP health payload
  local ip="$1" body
  body="$(curl -fsS --max-time 10 --resolve "$DOMAIN:443:$ip" "https://$DOMAIN/api/health" 2>/dev/null)"
  [[ $? -eq 0 ]] || return 1
  printf '%s' "$body" | grep -Eq '"service"[[:space:]]*:[[:space:]]*"hopedesign-erp-api"' || return 1
  printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || return 1
  return 0
}

#############################################################
# Providers
#############################################################

cf_api() { # $1 method, $2 path, $3 optional json body
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS --max-time 20 -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body" "https://api.cloudflare.com/client/v4$path" 2>/dev/null
  else
    curl -fsS --max-time 20 -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4$path" 2>/dev/null
  fi
}

cf_zone_id() {
  if [[ -n "${CF_ZONE_ID:-}" ]]; then printf '%s' "$CF_ZONE_ID"; return 0; fi
  cf_api GET "/zones?name=$ZONE" \
    | tr ',' '\n' | sed -n 's/.*"id":"\([a-f0-9]\{32\}\)".*/\1/p' | head -1
}

cf_record_id() { # $1 zone id
  cf_api GET "/zones/$1/dns_records?type=A&name=$DOMAIN" \
    | tr ',' '\n' | sed -n 's/.*"id":"\([a-f0-9]\{32\}\)".*/\1/p' | head -1
}

dns_move_cloudflare() { # $1 = target ip
  local ip="$1" zid rid resp
  zid="$(cf_zone_id)"
  if [[ -z "$zid" ]]; then log "cloudflare: could not resolve zone id for $ZONE"; return 1; fi
  rid="$(cf_record_id "$zid")"
  if [[ -z "$rid" ]]; then log "cloudflare: no A record found for $DOMAIN in zone $zid"; return 1; fi
  resp="$(cf_api PATCH "/zones/$zid/dns_records/$rid" \
    "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$ip\",\"ttl\":$RECORD_TTL,\"proxied\":false}")"
  if printf '%s' "$resp" | grep -q '"success":true'; then
    log "cloudflare: $DOMAIN -> $ip (ttl $RECORD_TTL)"
    return 0
  fi
  log "cloudflare: PATCH failed: $(printf '%s' "$resp" | head -c 400)"
  return 1
}

# Namecheap replaces the whole record set, so this is only safe with the full
# list. DNS_RECORDS is one record per line: host,type,address[,ttl]
dns_move_namecheap() { # $1 = target ip
  local ip="$1" sld tld i=1 args clientip resp line host type addr ttl
  if [[ -z "${NAMECHEAP_API_USER:-}" || -z "${NAMECHEAP_API_KEY:-}" ]]; then
    log "namecheap: NAMECHEAP_API_USER/NAMECHEAP_API_KEY not set"
    return 1
  fi
  if [[ -z "${DNS_RECORDS:-}" ]]; then
    log "namecheap: DNS_RECORDS is empty - refusing to call setHosts, which would delete every record not listed"
    return 1
  fi
  sld="${DOMAIN%%.*}"; tld="${DOMAIN#*.}"
  clientip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null)"
  [[ -n "$clientip" ]] || { log "namecheap: could not determine request IP (required as ClientIp)"; return 1; }

  args="ApiUser=$NAMECHEAP_API_USER&ApiKey=$NAMECHEAP_API_KEY&UserName=${NAMECHEAP_USER_NAME:-$NAMECHEAP_API_USER}&ClientIp=$clientip"
  args="$args&Command=namecheap.domains.dns.setHosts&SLD=$sld&TLD=$tld"

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    line="${line%%#*}"; [[ -n "${line// }" ]] || continue
    IFS=',' read -r host type addr ttl <<< "$line"
    host="$(printf '%s' "$host" | tr -d '[:space:]')"
    type="$(printf '%s' "$type" | tr -d '[:space:]')"
    addr="$(printf '%s' "$addr" | tr -d '[:space:]')"
    ttl="$(printf '%s' "$ttl" | tr -d '[:space:]')"
    [[ -n "$host" && -n "$type" && -n "$addr" ]] || continue
    # Swap the address on the record that names this hostname and is an A record.
    if [[ "$type" == "A" && ( "$host" == "@" || "$host" == "$sld" ) ]]; then
      addr="$ip"
      ttl="$RECORD_TTL"
    fi
    [[ -n "$ttl" ]] || ttl="1799"
    args="$args&HostName$i=$host&RecordType$i=$type&Address$i=$addr&TTL$i=$ttl"
    i=$((i+1))
  done <<< "$DNS_RECORDS"

  resp="$(curl -fsS --max-time 30 "https://api.namecheap.com/xml.response?$args" 2>/dev/null)"
  if printf '%s' "$resp" | grep -q 'Status="OK"'; then
    log "namecheap: republished $((i-1)) records, $DOMAIN -> $ip (ttl $RECORD_TTL)"
    return 0
  fi
  log "namecheap: setHosts failed: $(printf '%s' "$resp" | tr -d '\n' | head -c 500)"
  return 1
}

dns_move() { # $1 = target ip
  local ip="$1"
  case "$DNS_PROVIDER" in
    cloudflare) dns_move_cloudflare "$ip" ;;
    namecheap)  dns_move_namecheap "$ip" ;;
    *)          log "no usable DNS_PROVIDER ('$DNS_PROVIDER')"; return 2 ;;
  esac
}

#############################################################
# Entry points
#############################################################

case "$action" in
  status)
    printf 'provider=%s zone=%s domain=%s\n' "${DNS_PROVIDER:-<unset>}" "$ZONE" "$DOMAIN"
    printf 'resolved_now=%s primary=%s peer=%s ttl=%s\n' \
      "$(resolved_ip)" "$PRIMARY_PUBLIC_IP" "${PEER_PUBLIC_IP:-<unset>}" "$RECORD_TTL"
    exit 0
    ;;

  lower-ttl|move-to-primary|move-to-peer)
    case "$action" in
      move-to-peer)    target="${PEER_PUBLIC_IP:-}" ;;
      move-to-primary) target="$PRIMARY_PUBLIC_IP" ;;
      *)               target="$(resolved_ip)" ;;
    esac

    if [[ -z "$target" ]]; then
      log "$action: no target address configured (PEER_PUBLIC_IP unset)"
      notify CRITICAL failover-dns-manual \
        "ERP DNS must be moved BY HAND to $DOMAIN" \
        "dns-failover.sh was asked to run '$action' but has no target address (PEER_PUBLIC_IP is unset in deploy/failover.env). Move the A record for $DOMAIN to the surviving node in the registrar's panel. Users keep hitting the failed node until that is done."
      exit 1
    fi

    if [[ "$REQUIRE_TARGET_HEALTHY" == "1" ]] && ! target_serving "$target"; then
      log "$action: $target does not serve the ERP health payload - not moving DNS"
      notify CRITICAL failover-dns-target-dead \
        "ERP DNS not moved: $target is not serving" \
        "$DOMAIN was about to be pointed at $target, but that address does not return the ERP health payload. Moving it would turn a one-node outage into a two-node outage, so it was left alone. Bring the surviving node up, then re-run deploy/dns-failover.sh $action."
      exit 1
    fi

    if dns_move "$target"; then
      notify INFO failover-dns-moved \
        "ERP DNS moved to $target" \
        "$DOMAIN now resolves to $target (ttl ${RECORD_TTL}s). Propagnation is bounded by the TTL, not instant."
      exit 0
    fi

    rc=$?
    log "$action: provider move failed (rc=$rc)"
    notify CRITICAL failover-dns-manual \
      "ERP DNS must be moved BY HAND to $DOMAIN" \
      "dns-failover.sh could not move the A record for $DOMAIN to $target (provider '${DNS_PROVIDER:-unset}', rc=$rc). Set DNS_PROVIDER and its credentials in deploy/failover.env, or move the record in the registrar panel now. Until then users keep hitting the failed node."
    exit 1
    ;;

  *)
    echo "usage: dns-failover.sh {status|move-to-peer|move-to-primary|lower-ttl}" >&2
    exit 2
    ;;
esac