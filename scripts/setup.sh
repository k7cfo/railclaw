#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# OpenClaw — Full Interactive Setup
#
# This script handles everything:
#   1. Installs Homebrew (if missing)
#   2. Installs Railway CLI + jq (if missing)
#   3. Logs you into Railway
#   4. Asks for your setup password
#   5. Creates .env
#   6. Deploys to Railway
#
# Usage:  bash scripts/setup.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
fail()  { printf "${RED}[✗]${NC} %s\n" "$1" >&2; exit 1; }
ask()   { printf "${CYAN}[?]${NC} %s" "$1"; }

# ── Banner ───────────────────────────────────────────────────────────────────
banner() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  OpenClaw — Full Interactive Setup                      ║"
  echo "║  github.com/k7cfo/openclaw-railway-private              ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "  This will install prerequisites, configure your keys,"
  echo "  and deploy OpenClaw to Railway."
  echo ""
}

# ── Step 1: Homebrew ─────────────────────────────────────────────────────────
ensure_brew() {
  if command -v brew >/dev/null 2>&1; then
    info "Homebrew is installed"
    return
  fi

  warn "Homebrew is not installed."
  ask "Install Homebrew now? [Y/n] "
  read -r yn
  case "$yn" in
    [Nn]*) fail "Homebrew is required. Install it from https://brew.sh and rerun this script." ;;
  esac

  echo ""
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Add brew to PATH for Apple Silicon Macs (default install location)
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi

  command -v brew >/dev/null 2>&1 || fail "Homebrew install failed. Install manually from https://brew.sh"
  info "Homebrew installed"
}

# ── Step 2: Railway CLI + jq ────────────────────────────────────────────────
ensure_cli_tools() {
  local need_install=()

  if command -v railway >/dev/null 2>&1; then
    info "Railway CLI is installed"
  else
    warn "Railway CLI is not installed."
    need_install+=(railway)
  fi

  if command -v jq >/dev/null 2>&1; then
    info "jq is installed"
  else
    warn "jq is not installed."
    need_install+=(jq)
  fi

  if [[ ${#need_install[@]} -gt 0 ]]; then
    ask "Install ${need_install[*]} via Homebrew? [Y/n] "
    read -r yn
    case "$yn" in
      [Nn]*) fail "Required tools missing: ${need_install[*]}. Install them and rerun." ;;
    esac

    for tool in "${need_install[@]}"; do
      info "Installing $tool..."
      brew install "$tool"
    done
    info "All CLI tools installed"
  fi
}

# ── Step 3: Railway login ───────────────────────────────────────────────────
ensure_railway_login() {
  if railway whoami >/dev/null 2>&1; then
    local user
    user=$(railway whoami 2>/dev/null || echo "unknown")
    info "Logged into Railway as: $user"
    return
  fi

  warn "Not logged into Railway."
  echo ""
  echo "  You need a Railway account (Hobby plan, \$5/mo)."
  echo "  Sign up at: https://railway.com"
  echo ""
  ask "Press Enter to open Railway login in your browser..."
  read -r

  railway login

  railway whoami >/dev/null 2>&1 || fail "Railway login failed. Try again with: railway login"
  info "Railway login successful"
}

# ── Step 4: Collect configuration ────────────────────────────────────────────
collect_config() {
  echo ""
  printf "${BOLD}── Configuration ──${NC}\n"
  echo ""

  # Setup password
  if [[ -n "${SETUP_PASSWORD:-}" ]]; then
    info "SETUP_PASSWORD already set"
  else
    ask "Choose a password for the /setup admin page: "
    read -r SETUP_PASSWORD
    [[ -z "$SETUP_PASSWORD" ]] && fail "Setup password cannot be empty."
    info "Setup password set"
  fi

  # Project name
  ask "Railway project name [openclaw]: "
  read -r input_project_name
  PROJECT_NAME="${input_project_name:-openclaw}"
  info "Project name: $PROJECT_NAME"

  echo ""
  printf "${BOLD}── API Keys ──${NC}\n"
  echo ""
  echo "  You'll paste your API keys into the web-based /setup wizard"
  echo "  AFTER the deploy finishes. You don't need them right now."
  echo ""
  echo "  If you don't have them yet, get them from:"
  echo "    • OpenRouter: https://openrouter.ai/settings/keys"
  echo "    • Brave Search: https://api.search.brave.com/app/keys"
  echo ""
}

# ── Step 5: Write .env ──────────────────────────────────────────────────────
write_env() {
  local env_file="$PROJECT_DIR/.env"

  if [[ -f "$env_file" ]]; then
    warn ".env already exists."
    ask "Overwrite it? [y/N] "
    read -r yn
    case "$yn" in
      [Yy]*) ;;
      *) info "Keeping existing .env"; return ;;
    esac
  fi

  cat > "$env_file" <<EOF
# Generated by setup.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# NEVER commit this file to git.

SETUP_PASSWORD=$SETUP_PASSWORD
PROJECT_NAME=$PROJECT_NAME
EOF

  info ".env written to $env_file"
}

# ── Step 6: Deploy ──────────────────────────────────────────────────────────
run_deploy() {
  echo ""
  printf "${BOLD}── Deploy ──${NC}\n"
  echo ""
  ask "Deploy OpenClaw to Railway now? [Y/n] "
  read -r yn
  case "$yn" in
    [Nn]*) 
      echo ""
      info "Skipped deploy. When you're ready, run:"
      echo "    bash scripts/deploy.sh"
      return
      ;;
  esac

  echo ""
  # Source the .env we just wrote so deploy.sh picks it up
  set -a; source "$PROJECT_DIR/.env"; set +a
  bash "$SCRIPT_DIR/deploy.sh"
}

# ── Post-deploy summary ────────────────────────────────────────────────────
post_deploy() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  What to do next                                        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "  1. Open your Railway dashboard: https://railway.com/dashboard"
  echo "  2. Click your project → your service → Settings → Networking"
  echo "  3. Click 'Generate Domain' to get your HTTPS URL"
  echo "  4. Wait for the build to finish (~3-5 min)"
  echo "  5. Visit https://<your-domain>.up.railway.app/setup"
  echo "  6. Log in: username 'admin', password = your setup password"
  echo "  7. Select OpenRouter as provider → paste your API key"
  echo "  8. Paste your Brave Search API key"
  echo "  9. Optionally add a Telegram/Discord bot token"
  echo " 10. Click 'Run setup'"
  echo ""
  echo "  ⚠️  Remember: never share API keys over plain text!"
  echo "     Use 1Password, Signal, or share them in person."
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  banner
  ensure_brew
  ensure_cli_tools
  ensure_railway_login
  collect_config
  write_env
  run_deploy
  post_deploy
}

main "$@"
