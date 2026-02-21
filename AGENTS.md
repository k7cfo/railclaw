# Agent Instructions — OpenClaw Deploy

This file instructs AI coding agents (Warp/Oz, Claude Code, Anti-Gravity, Cursor, etc.)
how to deploy OpenClaw on Railway with Cloudflare Tunnel.

## What this does

Deploys an OpenClaw AI assistant on Railway, securely exposed via a Cloudflare
Tunnel on a custom domain (e.g. `openclaw.example.com`). Cloudflare handles
TLS termination — no public ports or firewall holes needed.

## Required credentials

Before starting, the user MUST provide these as environment variables.
**Do not hardcode or echo secrets. Store them as env vars only.**

- `CLOUDFLARE_API_TOKEN` — [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token. Needs: Cloudflare Tunnel:Edit, DNS:Edit, Account Settings:Read.
- `CLOUDFLARE_ACCOUNT_ID` — [Cloudflare Dashboard](https://dash.cloudflare.com) → right sidebar on account home.
- `CLOUDFLARE_HOSTNAME` — Public hostname (e.g. `openclaw.example.com`). Must be on a Cloudflare-managed domain.
- `RAILWAY_TOKEN` — [Railway Account > Tokens](https://railway.com/account/tokens) → Create Token. Optional if `railway login` already done.
- `SETUP_PASSWORD` — Password to protect the `/setup` wizard. Any string.

Optional:
- `PROJECT_NAME` — Railway project name (default: `openclaw`)
- `CLOUDFLARE_ZONE_ID` — Auto-detected from hostname if omitted.
- `OPENCLAW_GATEWAY_TOKEN` — Gateway admin token (auto-generated if not set)

## Prerequisites (install if missing)

- **Railway CLI** — `brew install railway`
- **jq** — `brew install jq`

## Quick start

```bash
cp .env.sample .env
# Edit .env with your values (see "Required credentials" above)
bash scripts/setup-cloudflare.sh
```

The script auto-sources `.env`, so no need to export manually.
It automates: creating the Cloudflare Tunnel, configuring DNS, deploying
OpenClaw to Railway, and outputting the tunnel token for the cloudflared sidecar.
The cloudflared sidecar deployment requires one manual action in the Railway dashboard.

IMPORTANT: `.env` is in `.gitignore` — it will never be committed.

## Manual step-by-step (if the script fails or agent prefers API calls)

### Step 1: Create Cloudflare Tunnel

```bash
# Generate tunnel secret
TUNNEL_SECRET=$(openssl rand -base64 32)

# Create tunnel
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"openclaw\", \"tunnel_secret\": \"$TUNNEL_SECRET\", \"config_src\": \"cloudflare\"}"
```

Save `result.id` as `TUNNEL_ID`.

### Step 2: Configure tunnel ingress

```bash
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"config": {"ingress": [{"hostname": "'"$CLOUDFLARE_HOSTNAME"'", "service": "http://openclaw.railway.internal:8080"}, {"service": "http_status:404"}]}}'
```

### Step 3: Create DNS CNAME

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "CNAME", "name": "'"$CLOUDFLARE_HOSTNAME"'", "content": "'"$TUNNEL_ID"'.cfargotunnel.com", "proxied": true}'
```

### Step 4: Get tunnel token

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

Save `result` as `TUNNEL_TOKEN`.

### Step 5: Deploy OpenClaw to Railway

```bash
export RAILWAY_TOKEN
railway init --name "${PROJECT_NAME:-openclaw}"
railway variable set \
  SETUP_PASSWORD="$SETUP_PASSWORD" \
  OPENCLAW_STATE_DIR="/data/.openclaw" \
  OPENCLAW_WORKSPACE_DIR="/data/workspace" \
  PORT="8080"
railway up --detach
```

Important: The service source must be `k7cfo/openclaw-railway-private` (this fork),
NOT the upstream `vignesh07/clawdbot-railway-template`. The upstream binds to
`*******` (IPv4 only) which breaks Railway private networking (IPv6).

### Step 6: Deploy cloudflared sidecar

In the Railway dashboard:
1. Open the project
2. Click **Create → New Service → Docker Image**
3. Use image: `cloudflare/cloudflared:latest`
4. Set start command: `tunnel --no-autoupdate run`
5. Add variable: `TUNNEL_TOKEN=<token-from-step-4>`

### Step 7: Verify

```bash
curl https://$CLOUDFLARE_HOSTNAME/setup
```

## Key technical details

- This fork binds the wrapper to `::` (dual-stack) instead of `*******`
- Railway private networking uses IPv6 (`fd12::/16` range)
- The wrapper listens on port 8080, proxying to the gateway on `*********:18789`
- Cloudflare terminates TLS and proxies to the cloudflared sidecar, which connects to OpenClaw via Railway internal network
- Optional: Cloudflare Access policies for zero-trust authentication

## Troubleshooting

- **Tunnel not connected**: Check that the cloudflared sidecar is running in Railway and has the correct `TUNNEL_TOKEN`
- **DNS not resolving**: Verify the CNAME record exists in Cloudflare DNS for your hostname
- **502 Bad Gateway**: OpenClaw service may still be building (takes 3-5 min), or port mismatch
- **Connection refused on IPv6**: Service isn't using this fork (binding to `*******`)
