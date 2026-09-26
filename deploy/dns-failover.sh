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
#               the Namecheap panel for the domain), and make sure that list
#               includes the record naming $DOMAIN itself: a subdomain is stored
#               under its own label ("hopedesign"), not "@". If no listed record
#               matches, the agent refuses to publish instead of reporting a
#               failover that moved nothing.
#
#               Only the record that names $DOMAIN is rewritten. When $DOMAIN is
#               a subdomain the apex record ("@") is a DIFFERENT hostname, so it
#               is re-sent unchanged and keeps its old address - name the apex in
#               DNS_MOVE_ALSO if it is served by the same node and should follow.
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
# Extra host labels a namecheap failover is allowed to rewrite ALONGSIDE the
# record naming $DOMAIN, comma separated (e.g. "@" for the apex). Empty - the
# default - moves only $DOMAIN's own record and leaves everything else alone.
DNS_MOVE_ALSO="${DNS_MOVE_ALSO:-}"
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

resolved_ttl() { # the TTL resolvers are actually honouring right now
  # RECORD_TTL is only what the agent WOULD publish. Reporting that as "ttl" made
  # status claim 60s while the live record was still 1799s - exactly the number
  # that decides how long an outage lasts, so read it from the wire.
  curl -fsS --max-time 10 "https://dns.google/resolve?name=$DOMAIN&type=A" 2>/dev/null \
    | tr ',' '\n' | sed -n 's/.*"TTL":\([0-9]*\).*/\1/p' | head -1
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

# A provider NAME in failover.env is a claim about the account, not evidence of
# it. `status` used to answer provider_ready=yes on the strength of the word
# "namecheap" alone, so a key that was mistyped or never enabled read as
# "failover is armed" right up until the incident - when setHosts was rejected
# and DNS stayed on the dead node. Ask the API instead. getHosts is a read: it
# republishes nothing, so this is safe to run at any time.
namecheap_client_ip() { # ClientIp must be the IP Namecheap has whitelisted
  curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 10 https://ifconfig.me/ip 2>/dev/null
}

namecheap_preflight() { # stdout: "ok <records>" | unset | noip | "err <code> <msg>"
  local clientip sld tld resp n
  if [[ -z "${NAMECHEAP_API_USER:-}" || -z "${NAMECHEAP_API_KEY:-}" ]]; then
    printf 'unset'; return 1
  fi
  clientip="$(namecheap_client_ip)"
  [[ -n "$clientip" ]] || { printf 'noip'; return 1; }
  sld="${ZONE%%.*}"; tld="${ZONE#*.}"
  resp="$(curl -fsS --max-time 25 "https://api.namecheap.com/xml.response?ApiUser=$NAMECHEAP_API_USER&ApiKey=$NAMECHEAP_API_KEY&UserName=${NAMECHEAP_USER_NAME:-$NAMECHEAP_API_USER}&ClientIp=$clientip&Command=namecheap.domains.dns.getHosts&SLD=$sld&TLD=$tld" 2>/dev/null)"
  if printf '%s' "$resp" | grep -q 'Status="OK"'; then
    n="$(printf '%s' "$resp" | grep -o 'HostName="' | wc -l | tr -d '[:space:]')"
    printf 'ok %s' "${n:-0}"; return 0
  fi
  printf 'err %s' "$(printf '%s' "$resp" | tr -d '\n' \
    | sed -n 's/.*<Error Number="\([0-9]*\)">\([^<]*\)<.*/\1 \2/p' | head -1)"
  return 1
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
  local ip="$1" sld tld host_label is_apex want extra i=1 args clientip resp line host type addr ttl
  local swapped=0 moved_names="" kept_apex="" n_records=0
  if [[ -z "${NAMECHEAP_API_USER:-}" || -z "${NAMECHEAP_API_KEY:-}" ]]; then
    log "namecheap: NAMECHEAP_API_USER/NAMECHEAP_API_KEY not set"
    return 1
  fi
  if [[ -z "${DNS_RECORDS:-}" ]]; then
    log "namecheap: DNS_RECORDS is empty - refusing to call setHosts, which would delete every record not listed"
    return 1
  fi
  # Namecheap's SLD/TLD identify the REGISTERED domain, which is ZONE - not the
  # hostname we publish. For hopedesign.jorlentech.com that is SLD=jorlentech,
  # TLD=com. Deriving them from $DOMAIN instead sends SLD=hopedesign to an API
  # that has never heard of it, so every failover would fail with a name error.
  sld="${ZONE%%.*}"; tld="${ZONE#*.}"
  # The record to rewrite is the one that names $DOMAIN: its first label,
  # "hopedesign". Namecheap spells the APEX "@" (or as the bare SLD), so those
  # two spellings only mean "$DOMAIN" when $DOMAIN is the apex itself.
  host_label="${DOMAIN%%.*}"
  if [[ "$DOMAIN" == "$ZONE" || "$host_label" == "$sld" ]]; then is_apex=1; else is_apex=0; fi
  extra=",$(printf '%s' "${DNS_MOVE_ALSO:-}" | tr -d '[:space:]'),"

  # setHosts rejects the ENTIRE set for a single bad TTL, and reports that as an
  # opaque API error, so validate the value this script is about to publish.
  if ! [[ "$RECORD_TTL" =~ ^[0-9]{1,6}$ ]] || (( 10#$RECORD_TTL < 60 || 10#$RECORD_TTL > 172800 )); then
    log "namecheap: RECORD_TTL='$RECORD_TTL' is outside the range Namecheap accepts (60-172800)"
    return 1
  fi

  clientip="$(namecheap_client_ip)"
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
    [[ -n "$ttl" ]] || ttl="1799"
    if ! [[ "$ttl" =~ ^[0-9]{1,6}$ ]] || (( 10#$ttl < 60 || 10#$ttl > 172800 )); then
      log "namecheap: DNS_RECORDS entry '$host,$type,$addr,$ttl' has a TTL outside 60-172800 - nothing published"
      return 1
    fi
    if [[ "$type" == "A" ]]; then
      # Only the record naming the hostname users type may be rewritten. When
      # $DOMAIN is a subdomain, the apex ("@" / bare SLD) is a DIFFERENT record:
      # matching it here would move a name nobody asked about and leave the real
      # one stale, while setHosts still returned OK and the log claimed success.
      want=0
      if [[ "$host" == "$host_label" || "$host" == "$DOMAIN" ]]; then want=1; fi
      if [[ "$want" == "0" && "$is_apex" == "1" && ( "$host" == "@" || "$host" == "$sld" ) ]]; then want=1; fi
      if [[ "$want" == "0" && "$extra" != ",," && "$extra" == *",$host,"* ]]; then want=1; fi
      if [[ "$want" == "1" ]]; then
        addr="$ip"; ttl="$RECORD_TTL"; swapped=1; moved_names="$moved_names $host"
      elif [[ "$is_apex" == "0" && ( "$host" == "@" || "$host" == "$sld" ) ]]; then
        # Still re-sent, so setHosts does not delete it - but it does not follow.
        kept_apex="$kept_apex $host"
      fi
    fi
    args="$args&HostName$i=$host&RecordType$i=$type&Address$i=$addr&TTL$i=$ttl"
    i=$((i+1)); n_records=$((n_records+1))
  done <<< "$DNS_RECORDS"

  # Nothing matched, so DNS_RECORDS does not describe $DOMAIN. Publishing it would
  # succeed while republishing an unchanged A record, so refuse instead of
  # reporting a failover that moved nothing.
  if [[ "$swapped" != "1" ]]; then
    if [[ "$is_apex" == "1" ]]; then
      log "namecheap: no A record in DNS_RECORDS names the apex $DOMAIN (looked for '@', '$sld' or '$DOMAIN') - refusing to republish an unchanged record set"
    else
      log "namecheap: no A record in DNS_RECORDS names $DOMAIN (looked for '$host_label' or '$DOMAIN') - refusing to republish, which would have reported a failover that moved nothing. Add '$host_label,A,<current address>' to DNS_RECORDS."
    fi
    return 1
  fi

  resp="$(curl -fsS --max-time 30 "https://api.namecheap.com/xml.response?$args" 2>/dev/null)"
  if printf '%s' "$resp" | grep -q 'Status="OK"'; then
    log "namecheap: republished $n_records records for $sld.$tld, $DOMAIN -> $ip (ttl $RECORD_TTL); moved:$moved_names"
    [[ -z "$kept_apex" ]] || log "namecheap: NOTE apex record(s)$kept_apex were re-sent unchanged - $DOMAIN is a subdomain, so they keep their old address. Set DNS_MOVE_ALSO=@ in failover.env to move them too."
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
    provider_note=""
    case "$DNS_PROVIDER" in
      cloudflare)
        if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
          provider_ready=yes
        else
          provider_ready=no
          provider_note="CLOUDFLARE_API_TOKEN is not set"
        fi
        ;;
      namecheap)
        nc_state="$(namecheap_preflight || true)"
        case "$nc_state" in
          ok*)    provider_ready=yes
                  provider_note="namecheap API accepted the credentials; ${nc_state#ok } records in zone $ZONE" ;;
          unset)  provider_ready=no
                  provider_note="NAMECHEAP_API_USER/NAMECHEAP_API_KEY are not set - the key is a 32-hex string from Profile > Tools > API Access" ;;
          noip)   provider_ready=no
                  provider_note="could not determine this host's public IP, which Namecheap requires as ClientIp" ;;
          *)      provider_ready=no
                  provider_note="namecheap API rejected the credentials (${nc_state#err })" ;;
        esac
        ;;
      *) provider_ready=no ;;
    esac
    printf 'provider=%s zone=%s domain=%s\n' "${DNS_PROVIDER:-<unset>}" "$ZONE" "$DOMAIN"
    printf 'resolved_now=%s primary=%s peer=%s\n' \
      "$(resolved_ip)" "$PRIMARY_PUBLIC_IP" "${PEER_PUBLIC_IP:-<unset>}"
    printf 'live_ttl=%s would_publish_ttl=%s\n' "$(resolved_ttl)" "$RECORD_TTL"
    printf 'provider_ready=%s\n' "$provider_ready"
    [[ -z "$provider_note" ]] || printf 'provider_note=%s\n' "$provider_note"
    if [[ "$provider_ready" == "no" ]]; then
      printf 'NOTE: failover cannot move DNS, so lower-ttl and move-to-* would change\n'
      printf '      nothing and a failover needs the record moved by hand in the\n'
      printf '      registrar panel. Fix the reason above, then re-run status.\n'
    fi
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

    # Capture the provider's own status. Reading $? after an `if` would always
    # yield 0, which made the "could not move the record" alert report rc=0 and
    # hide the real reason (no provider, bad creds, API rejection).
    dns_move "$target"
    rc=$?
    if [[ "$rc" == "0" ]]; then
      notify INFO failover-dns-moved \
        "ERP DNS moved to $target" \
        "$DOMAIN now resolves to $target (ttl ${RECORD_TTL}s). Propagation is bounded by the TTL, not instant."
      exit 0
    fi

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
