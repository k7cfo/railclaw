
# Railway Deployment

**Only `/data` survives redeploys.** Everything else is wiped.

- `/data/.openclaw` — config, credentials, state
- `/data/workspace` — workspace files (this directory)
- `/data/npm`, `/data/pnpm` — global packages
- `apt-get install` does NOT persist

## Installing software
1. **Python**: use a venv under `/data`
2. **Node**: `npm install -g <pkg>` (targets `/data/npm` via NPM_CONFIG_PREFIX)
3. **pnpm**: `pnpm add -g <pkg>` (targets `/data/pnpm` via PNPM_HOME)
4. **Custom scripts**: save under `/data/workspace/`
5. **Bootstrap**: add commands to `/data/workspace/bootstrap.sh` (runs on startup)
