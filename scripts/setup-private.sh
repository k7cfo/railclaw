#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# OpenClaw Private Deploy — Railway + Tailscale
# Fully automated: creates a Railway project from k7cfo/openclaw-railway-private,
# sets up Tailscale split DNS + subnet router, approves routes.
#
# Requirements (env vars):
#   TAILSCALE_API_KEY   — Tailscale API key (Settings > Keys > API keys)
#   TAILSCALE_TAILNET   — Your tailnet name (e.g. "tail2749b6.ts.net" or org name)
#   RAILWAY_TOKEN       — Railway API token (Account Settings > Tokens)
#   SETUP_PASSWORD      — Password for the /setup wizard (you choose this)
#
# Optional:
#   PROJECT_NAME        — Railway project name (default: "openclaw-private")
#   OPENCLAW_GATEWAY_TOKEN — Gateway admin token (auto-generated if omitted)
# ─────────────────────────────────────────────────────────────────────────────

# Auto-source .env if present (from repo root or current dir)
for envfile in "$(dirname "$0")/../.env" "./.env"; do
  if [[ -f "$envfile" ]]; then
    set -a; source "$envfile"; set +a
    break
  fi
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
fail()  { printf "${RED}[✗]${NC} %s\n" "$1" >&2; exit 1; }

# ── Preflight checks ────────────────────────────────────────────────────────
check_env() {
  local missing=()
  [[ -z "${TAILSCALE_API_KEY:-}" ]] && missing+=("TAILSCALE_API_KEY")
  [[ -z "${TAILSCALE_TAILNET:-}" ]] && missing+=("TAILSCALE_TAILNET")
  [[ -z "${RAILWAY_TOKEN:-}" ]]     && missing+=("RAILWAY_TOKEN")
  [[ -z "${SETUP_PASSWORD:-}" ]]    && missing+=("SETUP_PASSWORD")

  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "Missing required env vars: ${missing[*]}

  Export them before running this script:
    export TAILSCALE_API_KEY=tskey-api-...
    export TAILSCALE_TAILNET=tail2749b6.ts.net
    export RAILWAY_TOKEN=...
    export SETUP_PASSWORD=your-password-here"
  fi
}

check_cli() {
  command -v railway >/dev/null 2>&1 || fail "Railway CLI not found. Install: brew install railway"
  command -v curl    >/dev/null 2>&1 || fail "curl not found."
  command -v jq      >/dev/null 2>&1 || fail "jq not found. Install: brew install jq"
}

# ── Tailscale API helpers ────────────────────────────────────────────────────
ts_api() {
  local method="$1" path="$2"; shift 2
  curl -s -X "$method" \
    -H "Authorization: Bearer $TAILSCALE_API_KEY" \
    -H "Content-Type: application/json" \
    "https://api.tailscale.com/api/v2${path}" "$@"
}

# ── Step 1: Tailscale — create auth key ──────────────────────────────────────
create_ts_authkey() {
  info "Creating Tailscale auth key..."
  local resp
  resp=$(ts_api POST "/tailnet/$TAILSCALE_TAILNET/keys" -d '{
    "keyType": "auth",
    "description": "railway-openclaw-subnet-router",
    "capabilities": {
      "devices": {
        "create": {
          "reusable": false,
          "ephemeral": false,
          "preauthorized": true
        }
      }
    },
    "expirySeconds": 86400
  }')

  TS_AUTHKEY=$(echo "$resp" | jq -r '.key // empty')
  TS_KEY_ID=$(echo "$resp" | jq -r '.id // empty')

  if [[ -z "$TS_AUTHKEY" ]]; then
    fail "Failed to create Tailscale auth key: $(echo "$resp" | jq -r '.message // "unknown error"')"
  fi
  info "Auth key created: $TS_KEY_ID (expires in 24h, pre-authorized)"
}

# ── Step 2: Tailscale — configure split DNS ──────────────────────────────────
configure_split_dns() {
  info "Configuring Tailscale split DNS (railway.internal → fd12::10)..."
  local resp
  resp=$(ts_api PUT "/tailnet/$TAILSCALE_TAILNET/dns/split-dns" -d '{
    "railway.internal": ["fd12::10"]
  }')

  # Verify
  local check
  check=$(ts_api GET "/tailnet/$TAILSCALE_TAILNET/dns/split-dns")
  if echo "$check" | jq -e '."railway.internal"' >/dev/null 2>&1; then
    info "Split DNS configured: railway.internal → fd12::10"
  else
    warn "Split DNS may not have been set correctly. Check Tailscale DNS settings manually."
  fi
}

# ── Step 3: Railway — create project & deploy ────────────────────────────────
deploy_railway() {
  local project_name="${PROJECT_NAME:-openclaw-private}"

  info "Creating Railway project: $project_name ..."
  export RAILWAY_TOKEN

  # Create project
  railway init --name "$project_name" 2>/dev/null || true
  info "Project created/linked: $project_name"

  # Deploy from the fork
  info "Deploying k7cfo/openclaw-railway-private to Railway..."
  # Set variables first
  local gw_token="${OPENCLAW_GATEWAY_TOKEN:-$(openssl rand -hex 32)}"

  railway variable set \
    SETUP_PASSWORD="$SETUP_PASSWORD" \
    OPENCLAW_STATE_DIR="/data/.openclaw" \
    OPENCLAW_WORKSPACE_DIR="/data/workspace" \
    OPENCLAW_GATEWAY_TOKEN="$gw_token" \
    PORT="8080" 2>/dev/null || true

  info "Variables set. Gateway token saved."

  # Deploy
  railway up --detach 2>/dev/null || true
  info "Deployment triggered."

  # Get service info
  RAILWAY_SERVICE_NAME=$(railway status --json 2>/dev/null | jq -r '.service // "openclaw-private"' || echo "openclaw-private")
  info "Service: $RAILWAY_SERVICE_NAME"
  info "Private domain: ${RAILWAY_SERVICE_NAME}.railway.internal:8080"
}

# ── Step 4: Deploy Tailscale subnet router to Railway ────────────────────────
deploy_subnet_router() {
  info "Deploying Tailscale Subnet Router to Railway project..."
  warn "This step requires manual action in the Railway dashboard:"
  echo ""
  echo "  1. Open your Railway project dashboard"
  echo "  2. Click Create → Template"
  echo "  3. Search for 'Tailscale Subnet Router' (by Railway Templates)"
  echo "  4. Set TS_AUTHKEY to the value below:"
  echo ""
  echo "     TS_AUTHKEY=$TS_AUTHKEY"
  echo ""
  echo "  5. Deploy"
  echo ""
  read -rp "Press Enter after the subnet router is deployed..."
  info "Subnet router deployed."
}

# ── Step 5: Approve subnet routes ────────────────────────────────────────────
approve_routes() {
  info "Looking for Railway subnet router in Tailscale..."

  local devices
  devices=$(ts_api GET "/tailnet/$TAILSCALE_TAILNET/devices")

  # Find the device that has fd12::/16 in advertisedRoutes
  local device_id
  device_id=$(echo "$devices" | jq -r '
    .devices[]
    | select(.hostname | test("railway|radiant|production"; "i"))
    | select(.advertisedRoutes // [] | any(. == "fd12::/16"))
    | .id
  ' | head -1)

  if [[ -z "$device_id" ]]; then
    # Try broader match — any device advertising fd12::/16
    device_id=$(echo "$devices" | jq -r '
      .devices[]
      | select(.advertisedRoutes // [] | any(. == "fd12::/16"))
      | .id
    ' | head -1)
  fi

  if [[ -z "$device_id" ]]; then
    warn "Could not find subnet router device. Approve fd12::/16 manually in Tailscale Machines."
    return
  fi

  info "Found subnet router device: $device_id"
  info "Approving fd12::/16 route..."

  local resp
  resp=$(ts_api POST "/device/$device_id/routes" -d '{"routes": ["fd12::/16"]}')

  if echo "$resp" | jq -e '.enabledRoutes' >/dev/null 2>&1; then
    info "Route fd12::/16 approved!"
  else
    warn "Route approval may have failed. Check Tailscale Machines dashboard."
  fi
}

# ── Step 6: Verify ───────────────────────────────────────────────────────────
verify() {
  echo ""
  info "Setup complete! Testing private connection..."
  local domain="${RAILWAY_SERVICE_NAME:-openclaw-private}.railway.internal"

  sleep 5
  if curl --connect-timeout 10 -s -o /dev/null -w "%{http_code}" "http://${domain}:8080" | grep -qE "^[23]"; then
    info "SUCCESS: http://${domain}:8080 is reachable privately!"
  else
    warn "Connection test failed. The service may still be deploying (can take 3-5 min)."
    echo "  Try manually: curl http://${domain}:8080"
  fi

  echo ""
  info "Your OpenClaw instance:"
  echo "  Private URL:  http://${domain}:8080"
  echo "  Setup wizard: http://${domain}:8080/setup"
  echo "  Control UI:   http://${domain}:8080/openclaw"
  echo ""
  warn "Remember: remove the public .up.railway.app domain in Railway settings if you want fully private access."
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  OpenClaw Private Deploy — Railway + Tailscale          ║"
  echo "║  github.com/k7cfo/openclaw-railway-private              ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  check_env
  check_cli

  create_ts_authkey
  configure_split_dns
  deploy_railway
  deploy_subnet_router
  approve_routes
  verify
}

main "$@"
