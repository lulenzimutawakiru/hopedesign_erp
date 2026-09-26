#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - MESH ROUTE RECONCILER
#
# Installs this node's two cross-node Caddy upstream fragments into the live
# overlay directory, from the tracked copies under deploy/mesh-routes/<role>/.
#
# WHY THIS EXISTS
#   deploy/caddy-live is gitignored: it is runtime state, so `git merge` can
#   never deliver it. That is fine for active.caddy, which two scripts
#   (zero-downtime-deploy.sh, stack-watchdog.sh) own and rewrite on every
#   deploy and every heal. It is NOT fine for the two fragments that tell Caddy
#   where the OTHER node lives:
#
#     webpeer.caddy  the peer's web replicas in the public SPA pool
#     peer.caddy     the peer's :8081 API door, the retry target active.caddy
#                    falls through to when the local colour is dead
#
#   Nothing owned those files. They were written by hand once, and then drift:
#   an upstream added on one node and not the other, a rebuild that restored
#   the wrong role's copy, a `git clean` of the untracked directory. Every one
#   of those leaves a node that passes its health checks while silently not
#   holding its peer - and the pool loses a member without ever going red. This
#   script is the missing owner.
#
#   The mesh has two halves: the fragments above, and the kernel route that
#   carries traffic to the peer. The mesh route guard further down owns the
#   route half, because a route that disappears is invisible from inside this
#   box - every door still answers 200 while nothing reaches the peer.
#
# WHY IT IS SAFE TO RUN ON A TIMER
#   It rewrites a fragment ONLY when its bytes differ, and it reloads Caddy
#   ONLY when it actually wrote something. On a node already in sync (the
#   normal case) it is a stat + sha256 plus the mesh route guard's read-only
#   probes, and nothing else: no write, no reload, no service touched. That is
#   what makes it safe to call from the watchdog every two minutes - a no-op
#   must stay a no-op.
#
#   One deliberate exception lives in the mesh route guard below: it deletes a
#   blackhole that is swallowing mesh traffic. That delete can only fire on an
#   already-broken node, so it does not weaken the no-op contract above.
#
# ROLE COMES FROM THIS NODE'S OWN WIREGUARD ADDRESS, NEVER FROM WHICH FILES
# EXIST. The data primary is a git checkout, so it holds a copy of the
# peer-only overlays as well; an `[[ -f ... ]]` test therefore reports the
# PRIMARY as the peer, and reconciling from that guess writes the peer's
# fragment set onto the primary and strips a live upstream. This exact failure
# is documented at length in stack-watchdog.sh (see its "ROLE COMES FROM THIS
# NODE'S OWN WIREGUARD ADDRESS" comment). wg0 is the one thing that genuinely
# differs between the two machines at runtime, and it is up before Caddy is, so
# the role is read from it the same way the watchdog reads it.
#
# Usage:
#   bash deploy/mesh-routes.sh             # reconcile; reload Caddy if changed
#   bash deploy/mesh-routes.sh --dry-run   # report drift, write nothing
#   bash deploy/mesh-routes.sh status      # report desired vs live, write nothing
#
# Needs root: deploy/caddy-live is root:root.
#############################################################
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
LIVE_DIR="$APP_DIR/deploy/caddy-live"
SRC_DIR="$APP_DIR/deploy/mesh-routes"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/mesh-routes.log"
CADDY_CONTAINER="hopedesign-erp-caddy-1"
# The alert helper is shared with the other deploy scripts (dns-failover.sh,
# stack-watchdog.sh); the mesh guard reports through the same channel.
DEPLOY_DIR="$APP_DIR/deploy"
ALERT_BIN="$DEPLOY_DIR/alert.sh"

# Overridable so the same script can be exercised on a bench that uses a
# different WireGuard subnet.
PRIMARY_WG_IP="${PRIMARY_WG_IP:-10.77.0.1}"
PEER_WG_IP="${PEER_WG_IP:-10.77.0.2}"

# The two fragments this node owns. Deliberately an explicit list of exact
# filenames, not a glob: the live directory also holds peer.caddy.off and
# options.caddy.bak.pre-glob, and a `peer*.caddy` glob is one careless edit
# away from resurrecting a parked copy of an upstream that was turned off on
# purpose. Never widen this to a glob.
FRAGMENTS=(webpeer.caddy peer.caddy)

mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { echo "[mesh-routes $(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }

# ---- role, from wg0 --------------------------------------------------------
# Mirrors deploy/stack-watchdog.sh; keep the two in step.
WG_ADDR="$(ip -4 -o addr show dev wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
case "$WG_ADDR" in
  "$PRIMARY_WG_IP") NODE_ROLE="primary" ;;
  "$PEER_WG_IP")    NODE_ROLE="peer" ;;
  *)                NODE_ROLE="unknown" ;;
esac

if [[ "$NODE_ROLE" == "unknown" ]]; then
  # Same refusal as the watchdog, and for the same reason: with no trustworthy
  # role, choosing a fragment set is a coin flip and the wrong choice removes a
  # live upstream. Exit 0 - an unconfigured wg0 is not an error worth flapping
  # cron about, it just means this node is not part of the mesh yet.
  log "FATAL: wg0 address '$WG_ADDR' is neither $PRIMARY_WG_IP nor $PEER_WG_IP - refusing to reconcile"
  exit 0
fi

SRC_ROLE_DIR="$SRC_DIR/$NODE_ROLE"

MODE="apply"
case "${1:-}" in
  ""|--apply) MODE="apply" ;;
  --dry-run)  MODE="dry-run" ;;
  status)     MODE="status" ;;
  *) log "FATAL: unknown argument '$1' (expected --dry-run or status)"; exit 2 ;;
esac

log "role=$NODE_ROLE (wg0=$WG_ADDR) mode=$MODE src=$SRC_ROLE_DIR"

if [[ ! -d "$SRC_ROLE_DIR" ]]; then
  log "FATAL: $SRC_ROLE_DIR is missing - the tracked fragment set is not in the checkout; nothing to reconcile from"
  exit 1
fi

# ---- mesh route guard -------------------------------------------------------
# WHY THIS EXISTS
#   The two fragments this script installs are only half of the mesh it owns.
#   The other half is the kernel's route to the peer, and until now nothing
#   owned that at all. Two things can silently sever it:
#
#     1. The connected route. wg0 comes up with `10.77.0.0/24 dev wg0 proto
#        kernel scope link`, and that one route is the only thing that makes the
#        peer reachable. If it disappears the fragments are still byte-perfect
#        on disk, Caddy still reloads cleanly, and both doors still answer 200
#        on loopback - while every request Caddy proxies to the peer fails. The
#        pool never goes red, because the address the health checks watch is not
#        the address that stopped routing. A swallowed route is invisible from
#        inside the box.
#
#     2. The Cloudflare WARP client running beside the mesh on this host. WARP
#        installs `not from all fwmark 0x100cf lookup 65743` plus table 65743,
#        and a WARP restart can leave a blackhole route behind. A blackhole
#        covering the mesh subnet errors nothing and logs nothing on the data
#        path: it just drops every mesh packet at this host.
#
# WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
#   - Asserts the `dev wg0 proto kernel` connected route is present. Missing
#     means this node cannot reach its peer; that is an alert, never something a
#     script should try to re-add, because a wrong re-add is worse than the
#     outage it is meant to fix.
#   - Deletes a blackhole ONLY when the kernel prints its owning table and the
#     blackhole sits inside this mesh's own /24. `ip route show table all type
#     blackhole` prints the table on every line, so the delete can name it
#     exactly; a blackhole anywhere else is left alone, and nothing is ever
#     flushed wholesale.
#   - REPORTS the WARP fwmark rule and whether table 65743 has grown a mesh
#     route, and deletes neither: they belong to the WARP client, which
#     reinstalls them on connect, so a delete here is a fight the client wins.
#     The operator needs to see them; nothing here can safely own them.
#
# WHY IT IS NOT FOLDED INTO $changed / $failed
#   Routing and Caddy fragments fail independently. A node with a good route and
#   drifted fragments still deserves its reload; a node with correct fragments
#   and no route still has to be told. Sharing either flag would let one failure
#   suppress the fix for the other.
#
# WHY THE SUBNET IS READ, NOT HARDCODED
#   The bench moves the mesh to another subnet via PRIMARY_WG_IP/PEER_WG_IP, so
#   the /24 to guard is taken from the live connected route. A guard pinned to
#   10.77.0.0/24 would silently stop guarding the moment the tunnel moved.
#
#   The two field offsets below were established by running the commands on the
#   live node, not by reading iproute2 docs. Both were wrong on the first
#   attempt and both fail SILENTLY - an empty parse reads as "no route", a wrong
#   table reads as "route not found" - so neither would have looked broken in
#   review. Do not "tidy" them:
#     - `ip -4 route show dev wg0` OMITS the `dev wg0` token, so the device
#       filter is implied and every field shifts left. Parsed from the
#       unfiltered table instead, where `dev wg0` is printed and matched
#       explicitly.
#     - a kernel blackhole line is `blackhole <cidr> table <n>`, only 4 fields,
#       so a scan starting at field 4 never executes and silently reports the
#       table as `main`. The scan starts at field 3.
MESH_CIDR="$(ip -4 route show 2>/dev/null \
  | awk '$1 ~ /\// && $2 == "dev" && $3 == "wg0" && $4 == "proto" && $5 == "kernel" { print $1; exit }')"
MESH_NET3="$(printf '%s' "$MESH_CIDR" | awk -F'[./]' 'NF >= 4 { print $1"."$2"."$3; exit }')"
MESH_ALERT_KEY="mesh-routes-guard"
MESH_HEALED_KEY="mesh-routes-blackhole"

# Loud-degrade alerting, same contract as deploy/dns-failover.sh, so a missing
# alert.sh reports "would have sent" here exactly as it does there.
notify() { # $1 severity, $2 key, $3 subject, $4 body
  [[ -x "$ALERT_BIN" ]] || { log "no alert.sh - would have sent [$1] $3"; return 0; }
  "$ALERT_BIN" send "$1" "$2" "$3" "${4:-}" >> "$LOG_FILE" 2>&1 \
    || log "WARN: alert.sh send failed for key $2"
}

notify_clear() { # $1 key
  [[ -x "$ALERT_BIN" ]] || return 0
  "$ALERT_BIN" clear "$1" >> "$LOG_FILE" 2>&1 || true
}

ROUTE_BAD=0      # 1 = the peer is unreachable from this node right now
ROUTE_HEALED=""  # non-empty = a blackhole was found and removed this pass
ROUTE_DETAIL=""

mesh_route_guard() {
  # (1) the connected route itself
  if [[ -z "$MESH_CIDR" ]]; then
    echo "  BAD     mesh route: no 'dev wg0 proto kernel' route - this node cannot reach the peer at all"
    ROUTE_BAD=1
    ROUTE_DETAIL="${ROUTE_DETAIL}no connected route on wg0. "
  else
    echo "  ok      mesh route: $MESH_CIDR dev wg0"
  fi

  # (2) any blackhole sitting inside this mesh's /24
  #
  # Compared on the first three octets, which is exactly "inside this mesh" for
  # the /24 the tunnel actually uses, and also catches a /32 on the peer's own
  # address. A blackhole outside the mesh is not this script's business even if
  # it is broken. If the mesh is ever widened past a /24 this under-matches
  # rather than over-matches, which is the safe direction: the cost of being
  # wrong is a missed hijack, never a deleted route.
  local cidr tbl net3
  while read -r cidr tbl; do
    [[ -n "$cidr" ]] || continue
    net3="$(printf '%s' "$cidr" | awk -F'[./]' 'NF >= 4 { print $1"."$2"."$3; exit }')"
    [[ -n "$MESH_NET3" && "$net3" == "$MESH_NET3" ]] || continue
    if [[ "$MODE" == "apply" ]]; then
      if ip -4 route del blackhole "$cidr" table "$tbl" 2>/dev/null; then
        echo "  fixed   removed blackhole $cidr (table $tbl) that was swallowing mesh traffic"
        log "removed hijacking blackhole $cidr table $tbl"
        ROUTE_HEALED="${ROUTE_HEALED}${cidr} table ${tbl}. "
        continue
      fi
      echo "  BAD     blackhole $cidr (table $tbl) over the mesh, and it could not be removed"
      ROUTE_DETAIL="${ROUTE_DETAIL}blackhole ${cidr} table ${tbl} survived deletion. "
    else
      echo "  BAD     blackhole $cidr (table $tbl) is swallowing mesh traffic (${MODE}: not removing)"
      ROUTE_DETAIL="${ROUTE_DETAIL}blackhole ${cidr} table ${tbl}. "
    fi
    ROUTE_BAD=1
  done < <(ip -4 route show table all type blackhole 2>/dev/null \
             | awk '$1 == "blackhole" { t = "main"; for (i = 3; i < NF; i++) if ($i == "table") t = $(i + 1); print $2, t }')

  # (3) the WARP routing rule - reported, never touched
  local fwrule
  fwrule="$(ip -4 rule show 2>/dev/null | awk '/fwmark 0x100cf/ { print; exit }')"
  if [[ -z "$fwrule" ]]; then
    echo "  ok      no WARP fwmark rule"
  elif [[ -n "$MESH_NET3" ]] \
    && ip -4 route show table 65743 2>/dev/null | grep -qE "(^|[[:space:]])${MESH_NET3//./\\.}\\."; then
    echo "  BAD     WARP fwmark rule sends marked traffic to table 65743, which now holds a mesh route"
    ROUTE_BAD=1
    ROUTE_DETAIL="${ROUTE_DETAIL}table 65743 ($fwrule) matches the mesh subnet. "
  else
    echo "  note    WARP fwmark rule present (table 65743); it holds no mesh route"
  fi

  return 0
}

mesh_route_guard

# Only an apply run raises mail. `status` and `--dry-run` are operator commands
# typed at a terminal, where printing the result IS the report - an interactive
# check must never page anyone. The guard runs in every mode; only the alerting
# is gated.
if [[ "$MODE" == "apply" ]]; then
  if [[ "$ROUTE_BAD" == "1" ]]; then
    notify ERROR "$MESH_ALERT_KEY" "mesh route guard: this node cannot reach its peer" "$ROUTE_DETAIL"
  else
    notify_clear "$MESH_ALERT_KEY"
  fi
  [[ -n "$ROUTE_HEALED" ]] \
    && notify WARN "$MESH_HEALED_KEY" "mesh route guard: removed a blackhole over the mesh" "$ROUTE_HEALED"
fi

# ---- fragment sanity -------------------------------------------------------
# A fragment is exactly one `to <ip>:<port>` target line. Anything else -
# empty, truncated, a whole reverse_proxy block copied by mistake - is refused.
# This matters more than it looks: an empty or malformed file dropped into the
# live overlay does not error, it silently REMOVES an upstream from the pool,
# which is strictly worse than leaving the stale-but-working one in place.
# NOTE ON ORDERING
#   The mesh route guard above runs before changed/failed exist; they are
#   initialised just below, at the top of the reconcile loop. The guard keeps
#   its own ROUTE_BAD / ROUTE_HEALED flags so it never has to touch either one:
#   its failures must not be able to suppress a fragment reload, and a fragment
#   failure must not be able to hide a route that has gone missing.
fragment_ok() { # $1 = path
  [[ -s "$1" ]] || return 1
  [[ "$(grep -c '^to[[:space:]]' "$1" 2>/dev/null)" == "1" ]] || return 1
  grep -Eq '^to[[:space:]]+[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}[[:space:]]*$' "$1" || return 1
  return 0
}

live_sha() { [[ -f "$1" ]] && sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || echo "-"; }

changed=0
failed=0

for frag in "${FRAGMENTS[@]}"; do
  src="$SRC_ROLE_DIR/$frag"
  dst="$LIVE_DIR/$frag"

  if [[ ! -f "$src" ]]; then
    log "ERROR: tracked fragment $src is missing - skipping $frag"
    failed=1
    continue
  fi

  if ! fragment_ok "$src"; then
    log "ERROR: $src is not a single valid 'to <ip>:<port>' line - refusing to install $frag (an invalid overlay would drop a live upstream)"
    failed=1
    continue
  fi

  src_sha="$(sha256sum "$src" | cut -d' ' -f1)"
  dst_sha="$(live_sha "$dst")"
  src_bytes="$(stat -c%s "$src" 2>/dev/null || echo '?')"
  dst_bytes="$( [[ -f "$dst" ]] && stat -c%s "$dst" 2>/dev/null || echo '-' )"

  if [[ "$src_sha" == "$dst_sha" ]]; then
    echo "  ok      $frag  ${src_bytes}B  ${src_sha:0:16}  matches live"
    continue
  fi

  changed=1
  echo "  DRIFT   $frag  desired ${src_bytes}B ${src_sha:0:16}  live ${dst_bytes}B ${dst_sha:0:16}"

  [[ "$MODE" == "apply" ]] || continue

  # Stage in the same directory the file lives in, so the final `mv` is a
  # rename within one filesystem and therefore atomic: Caddy can never open a
  # half-written fragment.
  tmp="$LIVE_DIR/.${frag}.mesh.$$"
  if ! cp -f "$src" "$tmp" 2>/dev/null; then
    log "ERROR: cannot stage $frag into $LIVE_DIR (needs root?)"
    failed=1
    continue
  fi
  # Keep whatever mode the file being replaced had; only a first-install uses
  # the 0644 default. Ownership follows the writer (root), which is what the
  # directory and the rest of the overlay already are.
  if [[ -f "$dst" ]]; then
    chmod --reference="$dst" "$tmp" 2>/dev/null || chmod 0644 "$tmp" 2>/dev/null
  else
    chmod 0644 "$tmp" 2>/dev/null
  fi
  if ! mv -f "$tmp" "$dst" 2>/dev/null; then
    log "ERROR: cannot move $frag into place"
    rm -f "$tmp" 2>/dev/null
    failed=1
    continue
  fi
  log "wrote $dst (${src_bytes}B, ${src_sha:0:16})"
done

if [[ "$MODE" == "status" ]]; then
  exit 0
fi

if [[ "$MODE" == "dry-run" ]]; then
  [[ "$changed" == "1" ]] && echo "  (dry-run: drift above, nothing written)" || echo "  (dry-run: already in sync)"
  exit 0
fi

if [[ "$changed" != "1" ]]; then
  log "in sync; nothing to do"
  exit 0
fi

if [[ "$failed" == "1" ]]; then
  # A partial write is not a state worth reloading into: one fragment would be
  # the new target and the other the old one, and which upstream a request
  # lands on would depend on which file we happened to get right. Leave Caddy
  # exactly as it is and say so.
  log "ERROR: at least one fragment could not be installed; NOT reloading Caddy onto a half-reconciled overlay"
  exit 1
fi

# ---- make Caddy actually hold it -------------------------------------------
# Rewriting the file is not enough: everything in $LIVE_DIR is imported by
# deploy/Caddyfile, but Caddy parsed that config when it booted, so a fragment
# replaced afterwards is on disk and not in the running config - the pool
# silently loses (or silently gains) an upstream while Caddy stays perfectly
# healthy. The drift guard in stack-watchdog.sh also catches that, but this
# script has to stand on its own when it is run by hand.
if [[ -z "$(docker inspect -f '{{.Id}}' "$CADDY_CONTAINER" 2>/dev/null)" ]]; then
  log "WARN: $CADDY_CONTAINER is not running; fragments are correct on disk and will be parsed when it starts"
  exit 0
fi

log "reloading $CADDY_CONTAINER to pick up the reconciled fragments"
if docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >> "$LOG_FILE" 2>&1; then
  log "reloaded $CADDY_CONTAINER; mesh routes are live"
  exit 0
fi

# Deliberately NOT force-recreating here. A recreate has to be done with the
# same compose layering the node was built with (base file plus the role's
# overlays, or Caddy comes back without its published ports), and
# stack-watchdog.sh already does exactly that with the correct layering, every
# two minutes, in its live-overlay drift guard. Duplicating that layering in a
# second file is how the two drift apart; if this script was invoked by the
# watchdog, the recreate happens seconds later in the same pass.
log "ERROR: caddy reload failed; fragments are correct on disk but not serving. stack-watchdog.sh's live-overlay guard will force-recreate $CADDY_CONTAINER; run it now if you are not waiting for the 2-minute cron"
exit 1
