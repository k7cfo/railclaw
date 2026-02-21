#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# OpenClaw Deploy — Railway
# Creates a Railway project, sets variables, attaches a volume, and deploys.
#
# Requirements (env vars):
#   SETUP_PASSWORD — Password for the /setup wizard (you choose this)
#
# Optional:
#   RAILWAY_TOKEN          — Railway API token (falls back to `railway login`)
#   PROJECT_NAME           — Railway project name (default: "openclaw")
#   OPENCLAW_GIT_REF       — Pin a specific OpenClaw version (default: latest stable release)
#   OPENCLAW_GATEWAY_TOKEN — Gateway admin token (auto-generated if not set)
# ─────────────────────────────────────────────────────────────────────────────

# All Railway CLI commands must run from the project root (where Dockerfile lives)
# so the project link is always created in the right place.
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# Auto-source .env if present
for envfile in "$PROJECT_ROOT/.env" "./.env"; do
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

# ── Preflight ────────────────────────────────────────────────────────────────
check_env() {
  [[ -z "${SETUP_PASSWORD:-}" ]] && fail "Missing SETUP_PASSWORD. Set it in .env or export it."

  if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    export RAILWAY_TOKEN
  else
    unset RAILWAY_TOKEN 2>/dev/null || true
    if ! railway whoami >/dev/null 2>&1; then
      fail "RAILWAY_TOKEN not set and Railway CLI not logged in.\n  Either set RAILWAY_TOKEN in .env or run: railway login"
    fi
    info "Using existing Railway CLI session"
  fi
}

check_cli() {
  command -v railway >/dev/null 2>&1 || fail "Railway CLI not found. Install: brew install railway"
}

# ── Resolve OpenClaw version ─────────────────────────────────────────────────
resolve_openclaw_version() {
  # If the user pinned a version, use it; otherwise fetch the latest stable release.
  if [[ -n "${OPENCLAW_GIT_REF:-}" ]]; then
    info "Using pinned OpenClaw version: $OPENCLAW_GIT_REF"
    return
  fi

  info "Fetching latest stable OpenClaw release from GitHub..."
  local tag
  tag=$(curl -fsSL https://api.github.com/repos/openclaw/openclaw/releases/latest | jq -r '.tag_name // empty')

  if [[ -z "$tag" ]]; then
    warn "Could not fetch latest release. Falling back to Dockerfile default."
    return
  fi

  export OPENCLAW_GIT_REF="$tag"
  info "Latest stable OpenClaw release: $OPENCLAW_GIT_REF"
}

# ── Deploy ───────────────────────────────────────────────────────────────────
deploy() {
  local project_name="${PROJECT_NAME:-openclaw}"

  resolve_openclaw_version

  # Clear any stale project link (e.g. from a previously deleted project).
  info "Unlinking any previous Railway project..."
  railway unlink --yes 2>/dev/null || true

  info "Creating Railway project: $project_name ..."
  if ! railway init --name "$project_name" 2>&1; then
    fail "Failed to create Railway project."
  fi
  info "Project created: $project_name"

  info "Adding service..."
  warn "If Railway asks 'Enter a variable' — just press Escape to skip. We set variables in the next step."
  if ! railway add --service "$project_name" 2>&1; then
    fail "Failed to add service."
  fi
  railway service "$project_name" 2>/dev/null || true
  info "Service created: $project_name"

  info "Setting variables..."
  local gw_token="${OPENCLAW_GATEWAY_TOKEN:-$(openssl rand -hex 32)}"

  # Build OPENCLAW_GIT_REF into the variable set so Railway overrides the Dockerfile ARG.
  local -a vars=(
    SETUP_PASSWORD="$SETUP_PASSWORD"
    OPENCLAW_STATE_DIR="/data/.openclaw"
    OPENCLAW_WORKSPACE_DIR="/data/workspace"
    OPENCLAW_GATEWAY_TOKEN="$gw_token"
    PORT="8080"
  )
  if [[ -n "${OPENCLAW_GIT_REF:-}" ]]; then
    vars+=(OPENCLAW_GIT_REF="$OPENCLAW_GIT_REF")
  fi

  if ! railway variable set "${vars[@]}" 2>&1; then
    fail "Failed to set variables."
  fi
  info "Variables set."

  info "Creating volume at /data..."
  if ! railway volume add --mount-path /data 2>&1; then
    warn "Volume creation failed (may already exist). Continuing..."
  fi
  info "Volume attached."

  info "Deploying from project root..."
  if ! railway up --detach 2>&1; then
    fail "Deploy failed. Check Railway logs."
  fi
  info "Deployment triggered. Build takes ~3-5 minutes."

  # Generate a public domain automatically.
  info "Generating public domain..."
  local domain_output
  domain_output=$(railway domain 2>&1) || true

  # Extract the URL from the output (looks like: "🚀 https://xxx.up.railway.app")
  local public_url
  public_url=$(echo "$domain_output" | grep -oE 'https://[^ ]+' | head -1)

  if [[ -n "$public_url" ]]; then
    info "Public URL: $public_url"
  else
    warn "Could not auto-generate domain. Go to Railway dashboard → Settings → Networking → Generate Domain."
    public_url="https://<your-domain>.up.railway.app"
  fi

  # ── Wait for build to finish ──────────────────────────────────────────────
  echo ""
  info "Waiting for build to complete (checking every 2.5 minutes)..."
  echo "  Press Ctrl+C to stop waiting — the build will continue on Railway."
  echo ""

  local max_checks=8   # 8 × 2.5 min = 20 min max
  local interval=150   # 2.5 minutes in seconds
  local check=0
  local build_done=false

  while [[ $check -lt $max_checks ]]; do
    check=$((check + 1))
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${public_url}/setup" 2>/dev/null || echo "000")

    if [[ "$http_code" == "200" || "$http_code" == "401" ]]; then
      build_done=true
      break
    fi

    local remaining=$(( (max_checks - check) * interval / 60 ))
    printf "  ⏳ Check %d/%d — not ready yet (HTTP %s). Next check in 2.5 min (~%d min remaining)...\n" \
      "$check" "$max_checks" "$http_code" "$remaining"

    sleep "$interval"
  done

  echo ""
  if $build_done; then
    info "🎉 Build complete! Service is live."
  else
    warn "Build didn't complete within 20 minutes. It may still be running."
    echo "  Check status at: https://railway.com"
  fi

  # ── Next steps ────────────────────────────────────────────────────────────
  echo ""
  info "Next steps:"
  echo ""
  echo "  1. Visit ${public_url}/setup"
  echo "  2. Log in: username 'admin', password = your SETUP_PASSWORD"
  echo "  3. Select OpenRouter as provider, paste your API key"
  echo "  4. Paste your Brave Search API key"
  echo "  5. Optionally add Telegram/Discord bot token"
  echo "  6. Click Run setup"
  echo ""
  echo "  After setup, your authenticated dashboard link will be:"
  echo ""
  echo "    ${public_url}/?token=${gw_token}"
  echo ""
  echo "  ⚠️  Bookmark this link and keep it private!"
  echo "  It contains your auth token — anyone with this link has full access."
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  OpenClaw Deploy — Railway                              ║"
  echo "║  github.com/k7cfo/openclaw-railway-private              ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  check_cli
  check_env
  deploy
}

main "$@"
