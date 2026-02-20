# Agent Instructions — OpenClaw Private Deploy

This file instructs AI coding agents (Warp/Oz, Claude Code, Anti-Gravity, Cursor, etc.)
how to deploy OpenClaw on Railway with fully private Tailscale networking.

## What this does

Deploys a private OpenClaw AI assistant on Railway, accessible only through
a Tailscale VPN — **no public internet exposure**.

## Required credentials

Before starting, the user MUST provide these as environment variables.
**Do not hardcode or echo secrets. Store them as env vars only.**

| Variable | Where to get it | Description |
|---|---|---|
| `TAILSCALE_API_KEY` | [Tailscale Settings > Keys > API keys](https://login.tailscale.com/admin/settings/keys) | API access token (not an auth key). Click "Generate API key". |
| `TAILSCALE_TAILNET` | [Tailscale General Settings](https://login.tailscale.com/admin/settings/general) | Your tailnet name, e.g. `tail2749b6.ts.net` or your org name. |
| `RAILWAY_TOKEN` | [Railway Account > Tokens](https://railway.com/account/tokens) | Account-level API token. Click "Create Token". |
| `SETUP_PASSWORD` | User chooses | Password to protect the `/setup` wizard. Any string. |

Optional:
- `PROJECT_NAME` — Railway project name (default: `openclaw-private`)
- `OPENCLAW_GATEWAY_TOKEN` — Gateway admin token (auto-generated if not set)

## Prerequisites (install if missing)

- **Tailscale app** — `brew install --cask tailscale` (macOS) — user must be logged in
- **Railway CLI** — `brew install railway`
- **jq** — `brew install jq`

## Quick start

```bash
cp .env.sample .env
# Edit .env with your values (see "Required credentials" above)
bash scripts/setup-private.sh
```

The script auto-sources `.env`, so no need to export manually.
It automates steps 1-5 below. Step 4 (deploying the Tailscale subnet
router template) requires one manual action in the Railway dashboard because
Railway's CLI cannot deploy third-party templates.

IMPORTANT: `.env` is in `.gitignore` — it will never be committed.

## Manual step-by-step (if the script fails or agent prefers API calls)

### Step 1: Create Tailscale auth key

```bash
curl -s -X POST "https://api.tailscale.com/api/v2/tailnet/$TAILSCALE_TAILNET/keys" \
  -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

Save the `key` field from the response as `TS_AUTHKEY`.

### Step 2: Configure split DNS

```bash
curl -s -X PUT "https://api.tailscale.com/api/v2/tailnet/$TAILSCALE_TAILNET/dns/split-dns" \
  -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"railway.internal": ["fd12::10"]}'
```

### Step 3: Deploy OpenClaw to Railway

```bash
export RAILWAY_TOKEN
railway init --name "${PROJECT_NAME:-openclaw-private}"
railway variable set \
  SETUP_PASSWORD="$SETUP_PASSWORD" \
  OPENCLAW_STATE_DIR="/data/.openclaw" \
  OPENCLAW_WORKSPACE_DIR="/data/workspace" \
  PORT="8080"
railway up --detach
```

Important: The service source must be `k7cfo/openclaw-railway-private` (this fork),
NOT the upstream `vignesh07/clawdbot-railway-template`. The upstream binds to
`0.0.0.0` (IPv4 only) which breaks Railway private networking (IPv6).

### Step 4: Deploy Tailscale Subnet Router (manual)

In the Railway dashboard:
1. Open the project
2. Click **Create → Template**
3. Search **Tailscale Subnet Router** (by Railway Templates)
4. Set `TS_AUTHKEY` to the auth key from Step 1
5. Deploy

This cannot be automated via CLI because Railway doesn't support deploying
third-party templates programmatically.

### Step 5: Approve subnet routes

Find the subnet router device and approve `fd12::/16`:

```bash
# List devices
DEVICES=$(curl -s "https://api.tailscale.com/api/v2/tailnet/$TAILSCALE_TAILNET/devices" \
  -H "Authorization: Bearer $TAILSCALE_API_KEY")

# Find device advertising fd12::/16
DEVICE_ID=$(echo "$DEVICES" | jq -r '
  .devices[]
  | select(.advertisedRoutes // [] | any(. == "fd12::/16"))
  | .id
' | head -1)

# Approve route
curl -s -X POST "https://api.tailscale.com/api/v2/device/$DEVICE_ID/routes" \
  -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"routes": ["fd12::/16"]}'
```

### Step 6: Verify

```bash
curl --connect-timeout 10 http://<service-name>.railway.internal:8080
```

### Step 7: Remove public domain (optional)

In Railway dashboard → service → Settings → Networking → delete the `.up.railway.app` domain.

## Key technical details

- This fork binds the wrapper to `::` (dual-stack) instead of `0.0.0.0`
- Railway private networking uses IPv6 (`fd12::/16` range)
- The wrapper listens on port 8080, proxying to the gateway on `127.0.0.1:18789`
- Split DNS routes only `*.railway.internal` queries through the Tailscale tunnel
- All other DNS on the user's devices works normally

## Troubleshooting

- **DNS doesn't resolve**: Check that Tailscale app is running and connected
- **Connection refused on IPv6**: Service isn't using this fork (binding to `0.0.0.0`)
- **Connection timeout on IPv4**: Subnet route not approved, or Tailscale subnets not enabled in client
- **502 from public URL**: Port mismatch — public domain must target port 8080
