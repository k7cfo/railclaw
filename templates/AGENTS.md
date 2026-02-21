# OpenClaw Railway — Agent Deploy Instructions

Deploy OpenClaw on Railway. No tunnels, no sidecars — Railway provides HTTPS.

## Prerequisites
- Railway CLI installed (`brew install railway`)
- `railway login` completed
- `.env` file with `SETUP_PASSWORD` set

## Deploy steps
1. `bash scripts/deploy.sh` — creates project, volume, sets env vars, deploys
2. In Railway dashboard: **Settings → Networking → Generate Domain** to get HTTPS URL
3. Visit `https://yourapp.up.railway.app/setup` (admin / SETUP_PASSWORD)
4. Paste OpenAI API key, Brave Search API key, optional chat bot token
5. Click **Run setup** → approve device pairing if using a chat bot

## Architecture
- Wrapper server on port 8080, proxies to OpenClaw gateway on localhost:18789
- Railway provides HTTPS via `.up.railway.app` domain
- Volume at `/data` persists config, workspace, and API keys across redeploys

## Persistence rules
**Only `/data` survives redeploys.** Everything else is wiped.

- `/data/.openclaw` — config, credentials, state
- `/data/workspace` — workspace files
- `/data/npm`, `/data/pnpm` — global packages
- `apt-get install` does NOT persist

## Installing software
1. **Python**: use a venv under `/data`
2. **Node**: `npm install -g <pkg>` (targets `/data/npm` via NPM_CONFIG_PREFIX)
3. **pnpm**: `pnpm add -g <pkg>` (targets `/data/pnpm` via PNPM_HOME)
4. **Custom scripts**: save under `/data/workspace/`
5. **Bootstrap**: add commands to `/data/workspace/bootstrap.sh` (runs on startup)

## Env vars (set by deploy script)
- `SETUP_PASSWORD` — admin password for `/setup` wizard
- `OPENCLAW_STATE_DIR` = `/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR` = `/data/workspace`
- `PORT` = `8080`
