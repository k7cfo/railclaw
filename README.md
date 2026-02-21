<p align="center">
  <img src="assets/railclaw.png" alt="Railclaw — Deploy OpenClaw on Railway" width="200">
</p>

# Railclaw — Deploy OpenClaw on Railway

Railclaw is a turnkey deploy wrapper for [OpenClaw](https://github.com/openclaw/openclaw) — the open-source AI assistant platform. It automatically builds the latest stable release from source and deploys it on Railway with HTTPS out of the box.

- **One-click deploy** — click a link, set a password, done
- Automatically fetches the latest stable OpenClaw release from GitHub
- Railway provides free HTTPS — no tunnels, no Cloudflare, no DNS config
- Web-based setup wizard — paste your API keys in a browser
- Supports 12+ AI providers: OpenRouter, OpenAI, Anthropic, Google, and more
- Optional Telegram and Discord bot integration

---

## Deploy on Railway (the easy way)

This is the fastest way to get running. No terminal, no git, no scripts.

### What you'll need

- A **Railway account** ([railway.com](https://railway.com) — Hobby plan, $5/mo)
- An **OpenRouter API key** ([openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) — pay-per-use, add $5–10 to start)
- A **Brave Search API key** (optional, free — [brave.com/search/api](https://brave.com/search/api/))

### Step 1: Deploy

Click the button below (or visit [railway.com/deploy/railclaw](https://railway.com/deploy/railclaw)):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/railclaw)

Railway will ask you for a **setup password** — choose any password you'll remember. This protects the admin page. Click **Deploy** and wait for the build (~3–5 minutes).

### Step 2: Find your URL

After the deploy finishes:

1. Go to your [Railway dashboard](https://railway.com/dashboard)
2. Click your **railclaw** project
3. Click the **railclaw** service
4. Go to **Settings** → **Networking** → **Generate Domain** (if not already generated)
5. Your URL will look like `https://railclaw-xxxxx.up.railway.app`

### Step 3: Complete the setup wizard

1. Visit `https://your-url.up.railway.app/setup`
2. Log in: username **admin**, password = the setup password you chose
3. Select **OpenRouter** as your AI provider, paste your OpenRouter API key
4. Paste your Brave Search API key (optional)
5. Optionally add a Telegram or Discord bot token (see below)
6. Click **Run setup**

That's it — your AI assistant is live. After setup, you'll see a dashboard link with your auth token. Bookmark it.

### Step 4 (optional): Connect a chat bot

**Telegram:**
1. Open Telegram, message **@BotFather**, send `/newbot`
2. Copy the bot token (looks like `123456789:AAHk...`)
3. Paste it in `/setup` → **Section 3: Chat platform** → **Telegram bot token**
4. After setup completes:
   - Message your bot in Telegram (send `/start`)
   - Bot responds with a pairing code like `3EY4PUYS`
   - Go to `/setup` → **Section 5: Approve pairing**
   - Paste code and click **Approve**
   - Send another message — the bot will introduce itself

📖 **Full guide**: See [docs/TELEGRAM.md](docs/TELEGRAM.md) for detailed setup and troubleshooting

**Discord:**
1. Go to https://discord.com/developers/applications
2. **New Application** → **Bot** tab → **Add Bot**
3. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
4. **Reset Token** → copy the bot token
5. Invite to your server via **OAuth2 → URL Generator** (scopes: `bot`, `applications.commands`)
6. Paste the bot token in `/setup` → **Section 3: Chat platform** → **Discord bot token**

---

## Have a technical friend? (non-technical setup)

If someone offered to deploy this for you, here's what you need to do. You'll sign up for **3 free accounts**, get your API keys, and send them to your friend so they can deploy it for you.

> **⚠️ Never send API keys over plain text.** No email, no SMS, no Discord DMs, no Slack. Use a secure method: **1Password shared vault, Signal disappearing messages, or in person.** API keys are like passwords — anyone who has them can use your account and run up charges.

### 1. Create a Railway account and get an API token

1. Go to **https://railway.com** and click **Sign Up**
2. Sign up with **GitHub**, **Google**, or **email** — any method works
3. Pick the **Hobby** plan ($5/mo) — this is required for deployments
4. Once you're logged in, go to **https://railway.com/account/tokens**
5. Click **Create Token** → name it (e.g. `railclaw-deploy`) → copy the token
6. **Save this token** — you can't view it again after you leave the page

**Also invite your friend to your Railway workspace** so they can see the project and help troubleshoot:
1. In your Railway dashboard, click your workspace name (top-left)
2. Go to **People** → **Invite to workspace**
3. Enter your friend's email and send the invite

### 2. Get an OpenRouter API key

1. Go to **https://openrouter.ai** and sign up (Google or GitHub login works)
2. Add credits: go to https://openrouter.ai/settings/credits → add **$5–10** to start
3. Create an API key: go to https://openrouter.ai/settings/keys → **Create Key** → name it (e.g. `railclaw`) → copy it

### 3. Get a Brave Search API key

1. Go to **https://brave.com/search/api/** and click **Get Started**
2. Create an account and pick the **Free** plan (2,000 queries/month)
3. Copy your API key from https://api.search.brave.com/app/keys

### 4. Pick a setup password

Choose any password you'll remember. This protects the `/setup` admin page.

### 5. Send these to your friend — securely!

Send these **4 things** using a **secure method only**:

- Your **Railway API token** (from step 1)
- Your **OpenRouter API key** (from step 2)
- Your **Brave Search API key** (from step 3)
- Your **setup password** (from step 4)

**Good ways to share:**
- 🔒 1Password / Bitwarden shared vault
- 🔒 Signal (with disappearing messages on)
- 🔒 In person / on paper

**Never use:** email, SMS, Discord, Slack, or any unencrypted channel.

Your friend will deploy it and send you a URL like `https://railclaw-xxxxx.up.railway.app`. Visit `/setup` at that URL, log in with username **admin** and your password, paste your OpenRouter and Brave Search keys, and you're done.

> **After deployment:** You can revoke the Railway API token at https://railway.com/account/tokens if you don't want your friend to have deploy access anymore. Your API keys are saved on the server and are only visible to you through the `/setup` page.

---

## Technical deploy (for developers)

Two options: use the Railway template or run the scripts from the command line.

### Option A: Railway template (fastest)

1. Visit [railway.com/deploy/railclaw](https://railway.com/deploy/railclaw) — set your `SETUP_PASSWORD` and deploy
2. Find your URL in the Railway dashboard (service → Settings → Networking)
3. Complete the setup wizard at `/setup`

This is the same one-click deploy from the top of this README.

### Option B: Command-line scripts

There are **two scripts** — use whichever fits your situation:

| | `setup.sh` | `deploy.sh` |
|---|---|---|
| **Use when** | First time on this machine | You already have Railway CLI, `.env`, etc. |
| **What it does** | Installs Homebrew + Railway CLI, logs you in, creates `.env`, then calls `deploy.sh` | Creates a new Railway project and deploys directly |
| **Run with** | `bash scripts/setup.sh` | `bash scripts/deploy.sh` |

**If in doubt, run `setup.sh`** — it detects what's already installed and skips those steps.

```bash
git clone https://github.com/k7cfo/railclaw
cd railclaw
bash scripts/setup.sh
```

The script will ask how you want to log into Railway:
- **Browser** — opens a login page in your default browser
- **API token** — you paste your `RAILWAY_TOKEN` and it's saved to `.env`

If you already have a token, you can also set it before running:

```bash
export RAILWAY_TOKEN=your-token-here
bash scripts/setup.sh
```

### Deploying for a friend

If a friend gave you their Railway API token and setup password:

```bash
git clone https://github.com/k7cfo/railclaw
cd railclaw
cp .env.sample .env
# Edit .env: set SETUP_PASSWORD and RAILWAY_TOKEN
bash scripts/deploy.sh
```

The script creates a new Railway project, sets variables, attaches a volume, and deploys. After the build finishes, send your friend the URL.

### Redeploying from scratch

```bash
bash scripts/deploy.sh
```

The script automatically clears any stale project links before creating a new project. Each run creates a brand-new Railway project with a fresh volume, variables, and domain.

To change the project name:

```bash
PROJECT_NAME=mybot bash scripts/deploy.sh
```

### OpenClaw version

The deploy automatically fetches the latest stable release from GitHub. To pin a specific version:

```bash
# In .env:
OPENCLAW_GIT_REF=v2026.2.19
```

Or set `OPENCLAW_GIT_REF=v2026.x.xx` in Railway dashboard → Variables, then redeploy.

Available tags: https://github.com/openclaw/openclaw/tags

### Persistence

Only `/data` persists across redeploys. Everything else is wiped.

**Persists:** OpenClaw config, workspace, API keys (saved by wizard), npm/pnpm globals
**Does NOT persist:** `apt-get install`, files outside `/data`

Optional: create `/data/workspace/bootstrap.sh` to auto-install tools on startup.

---

## Security

### What's protected by default

- **HTTPS everywhere** — Railway provides TLS on all `.up.railway.app` domains. No plain HTTP.
- **Setup wizard is password-protected** — `/setup` requires HTTP Basic Auth (admin + `SETUP_PASSWORD`).
- **API keys stay on the server** — OpenRouter and Brave Search keys are saved to the persistent volume, never exposed in env vars or logs.
- **No inbound ports** — Railway routes traffic through its edge proxy. Your container is not directly reachable.

### Make your instance private (only visible to you)

By default, generating a Railway domain makes your instance publicly accessible (anyone with the URL can reach it). Here's how to lock it down:

**Option 1: Remove the public domain after setup (bot-only mode)**

If you only interact via Telegram/Discord, you don't need the web URL after initial setup:
1. Complete the `/setup` wizard and pair your chat bot
2. In Railway dashboard → your service → **Settings** → **Networking** → delete the public domain
3. Your bot still works (it connects outbound), but nobody can reach the web UI

**Option 2: Keep the URL but rely on the setup password**

The `/setup` wizard is the only sensitive page and is behind HTTP Basic Auth. The main OpenClaw gateway requires a paired device token to do anything useful. An unpaired visitor gets a "pairing required" page with no access to your data.

**Option 3: Use Railway's private networking**

Railway services can communicate internally via `*.railway.internal` without a public domain. If you need web access from your own machine, you can use `railway connect` to create a private tunnel to your service (requires the Railway CLI).

### Things to keep in mind

- **Never commit `.env`** — it's gitignored by default. Keep it that way.
- **Use a strong `SETUP_PASSWORD`** — this is the only thing guarding your admin page.
- **API keys in 1Password** — if you use 1Password, store your keys there. Don't paste them in chat, email, or any unencrypted channel.
- **Railway's `.up.railway.app` URLs are not secret** — they're randomly generated but guessable. Don't rely on URL obscurity alone; use one of the options above.

---

## Troubleshooting

### Common issues

**"pairing required" / dashboard offline**
Gateway is running but no device is approved. Go to `/setup` → approve the device.

**Telegram bot not responding**
See the comprehensive [Telegram troubleshooting guide](docs/TELEGRAM.md) for step-by-step fixes.

**"gateway token mismatch"**
Re-run the `/setup` wizard to sync tokens.

**502 Bad Gateway**
Check Railway logs (`railway logs`). Ensure the volume is mounted at `/data` and all variables are set.

**Build OOM (out of memory)**
The OpenClaw build needs ~2GB RAM. Upgrade to a Railway plan with more memory, or reduce concurrent builds.

**Can't reach the site after deploy**
Make sure you generated a domain: Railway dashboard → service → **Settings** → **Networking** → **Generate Domain**.

**Setup wizard won't load**
Wait for the build to finish (~3–5 min). Check `railway logs` for errors. The wrapper server must be listening on port 8080.

### Platform-specific guides

- **Telegram**: [docs/TELEGRAM.md](docs/TELEGRAM.md) — complete setup and troubleshooting
- More guides coming soon (Discord, Slack, etc.)

---

## Support

- GitHub Issues: https://github.com/k7cfo/railclaw/issues
- Upstream template: https://github.com/vignesh07/clawdbot-railway-template
