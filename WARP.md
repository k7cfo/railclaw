# OpenClaw Railway Private — Project Context

## What this is
A fork of `vignesh07/clawdbot-railway-template` that deploys OpenClaw on Railway with fully private Tailscale networking (no public internet exposure).

## Repo
- **GitHub:** https://github.com/k7cfo/openclaw-railway-private
- **Upstream:** https://github.com/vignesh07/clawdbot-railway-template

## Key changes from upstream
- `src/server.js` line ~1355: bind changed from `"0.0.0.0"` (IPv4 only) to `"::"` (dual-stack) via `BIND_HOST` env var — required for Railway private networking (IPv6 `fd12::/16`)
- Added `AGENTS.md` for AI coding agents to automate the full deploy
- Added `scripts/setup-private.sh` for automated Tailscale + Railway setup
- Added `.env.sample` with credential instructions

## Current deployment
- **Railway project:** `openclaw-private` (workspace K7, project ID `522433ca-10f3-44ae-bec0-21915f7e5fbe`)
- **Services:** `openclaw-private` (the app) + `Tailscale` (subnet router)
- **Private URL:** `http://openclaw-private.railway.internal:8080`
- **Public domain:** removed (private-only access via Tailscale)
- **Volume:** `/data` (5GB) for persistent state

## Architecture
- Wrapper server listens on port 8080, proxies to OpenClaw gateway on `127.0.0.1:18789`
- Tailscale subnet router advertises `fd12::/16` so tailnet devices can reach Railway's private network
- Split DNS routes `*.railway.internal` queries through the Tailscale tunnel

## Setup wizard
- URL: `/setup` — username `admin`, password = `SETUP_PASSWORD` env var
- Requires: AI provider API key, chat platform token (Telegram/Discord), then device pairing

## FORCE_HTTPS_PROTO
- The OpenClaw control UI requires HTTPS or localhost (secure context) for WebSocket
- Accessing via plain HTTP through Tailscale triggers "disconnected (1008): control ui requires HTTPS or localhost"
- Fix: `FORCE_HTTPS_PROTO=true` env var makes the wrapper set `X-Forwarded-Proto: https` when proxying to the gateway
- Safe because Tailscale encrypts all traffic end-to-end
- The setup script sets this automatically; manual users must add it to Railway Variables

## Known improvements needed
- Streamline onboarding: allow pre-configuring AI provider keys and chat tokens via `.env` so the `/setup` wizard isn't required
- The setup wizard flow requires manual steps (choose provider, enter tokens, pair device)
- Consider adding Tailscale HTTPS (`tailscale serve`) for real TLS certs instead of `FORCE_HTTPS_PROTO`

## Credentials
- Stored in `.env` (gitignored, never committed)
- Check 1Password for API keys
- Required: `TAILSCALE_API_KEY`, `TAILSCALE_TAILNET`, `RAILWAY_TOKEN`, `SETUP_PASSWORD`
