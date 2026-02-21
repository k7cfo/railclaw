# OpenClaw Railway — Project Context

## What this is
A simplified fork of `vignesh07/clawdbot-railway-template` that deploys OpenClaw on Railway using Railway's built-in HTTPS. No tunnels or sidecars needed.

## Repo
- **GitHub:** https://github.com/k7cfo/openclaw-railway-private
- **Upstream:** https://github.com/vignesh07/clawdbot-railway-template

## Key changes from upstream
- `src/server.js`: Added persistent extra env var system (`extra-env.json`) for saving Brave Search API key via setup wizard
- `src/server.js`: Brave Search API key input added to `/setup` wizard HTML
- `src/setup-app.js`: Sends `braveApiKey` in setup payload
- Added `scripts/deploy.sh` for one-command Railway deploy
- Added `templates/AGENTS.md` for AI agent deploy instructions
- Removed Tailscale and Cloudflare Tunnel (not needed — Railway provides HTTPS)

## Current deployment
- **Railway project:** `openclaw` (workspace K7)
- **Service:** `openclaw` (single service, no sidecar)
- **Public URL:** `https://<app>.up.railway.app` (Railway HTTPS)
- **Volume:** `/data` (5GB) for persistent state

## Architecture
- Wrapper server listens on port 8080, proxies to OpenClaw gateway on localhost:18789
- Railway provides HTTPS via `.up.railway.app` domain (TLS termination at Railway's edge)
- No tunnels, no sidecars, no extra DNS config

## Setup wizard
- URL: `/setup` — username `admin`, password = `SETUP_PASSWORD` env var
- Sections: (1) AI provider (OpenAI key), (2) Brave Search API key, (3) Chat platform token, (4) Run setup
- API keys are persisted to `/data/.openclaw/extra-env.json`

## "Deploy for friends" workflow
- Friend gets: OpenAI API key, Brave Search API key, picks a setup password
- Deployer runs `scripts/deploy.sh` with friend's SETUP_PASSWORD
- Friend visits `/setup` and pastes their keys

## Credentials
- `.env` has only `SETUP_PASSWORD` (and optional `RAILWAY_TOKEN`)
- API keys (OpenAI, Brave Search) go into the `/setup` wizard, not `.env`
- Check 1Password for keys
- `.env` is gitignored, never committed
