<p align="center">
  <img src="assets/railclaw.png" alt="OpenClaw on Railway" width="200">
</p>

# OpenClaw on Railway — Always the Latest Stable Release

This is one of the few turnkey scripts that **automatically builds and deploys the latest stable release of OpenClaw** on Railway. No manual version tracking, no stale builds — run the deploy script and you get the newest release from GitHub, built from source, with HTTPS out of the box.

- One command to deploy (`bash scripts/deploy.sh`)
- Automatically fetches the latest stable OpenClaw tag from GitHub
- Railway provides free HTTPS — no tunnels, no Cloudflare, no DNS config
- Web-based setup wizard — paste your keys in a browser, done
- Supports 12+ AI providers: OpenRouter, OpenAI, Anthropic, Google, and more

---

## Is a friend setting this up for you?

If someone offered to deploy OpenClaw for you, follow the steps below. You'll sign up for **3 free accounts**, get your API keys, and send them to your friend so they can deploy it remotely.

> **⚠️ Never send API keys over plain text.** No email, no SMS, no Discord DMs, no Slack. Use a secure method: **1Password shared vault, Signal disappearing messages, or in person.** API keys are like passwords — anyone who has them can use your account and run up charges.

### 1. Create a Railway account and get an API token

Railway is the hosting platform that runs your AI assistant. Your friend needs a Railway API token from your account so they can deploy the service for you remotely.

1. Go to **https://railway.com** and click **Sign Up**
2. Sign up with **GitHub**, **Google**, or **email** — any method works
3. Pick the **Hobby** plan ($5/mo) — this is required for deployments
4. Once you're logged in, go to **https://railway.com/account/tokens**
5. Click **Create Token** → name it (e.g. `openclaw-deploy`) → copy the token
6. **Save this token** — you can't view it again after you leave the page

This token lets your friend deploy to your Railway account without needing your password. You can revoke it at any time from the same tokens page.

**Also invite your friend to your Railway workspace** so they can see the project and help troubleshoot:
1. In your Railway dashboard, click your workspace name (top-left)
2. Go to **People** → **Invite to workspace**
3. Enter your friend's email and send the invite

This gives them visibility into your project without sharing your password.

### 2. Get an OpenRouter API key

OpenRouter gives you access to all the best AI models (GPT-4o, Claude, Gemini, Llama, and more) through a single API key. Pay-per-use, no subscriptions.

1. Go to **https://openrouter.ai** and sign up (Google or GitHub login works)
2. Add credits:
   - Go to https://openrouter.ai/settings/credits
   - Add **$5–10** to start (you only pay for what you use)
3. Create an API key:
   - Go to https://openrouter.ai/settings/keys
   - Click **Create Key** → name it (e.g. `openclaw`) → copy it
   - **Save this key** — you'll need it for the setup wizard

### 3. Get a Brave Search API key

This lets your AI assistant search the web.

1. Go to **https://brave.com/search/api/** and click **Get Started**
2. Create an account and pick the **Free** plan (2,000 queries/month)
3. Get your key:
   - Go to https://api.search.brave.com/app/keys
   - Copy your API key

### 4. Pick a setup password

Choose any password you'll remember. This protects the `/setup` admin page where you'll paste your API keys after deployment.

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

Your friend will use the Railway token to deploy, then send you a URL like `https://yourapp.up.railway.app`. Visit `/setup` at that URL, log in with username **admin** and your password, paste your OpenRouter and Brave Search keys, and you're done.

> **After deployment:** You can revoke the Railway API token at https://railway.com/account/tokens if you don't want your friend to have deploy access anymore. Your OpenRouter and Brave Search keys are saved on the server and are only visible to you through the `/setup` page.

### 5. Optional: set up a chat bot

If you want to talk to your AI via Telegram or Discord:

**Telegram:**
1. Open Telegram, message **@BotFather**, send `/newbot`
2. Copy the bot token (looks like `123456789:AAHk...`)
3. Paste it in `/setup` → **Section 3: Chat platform** → **Telegram bot token**
4. After setup completes:
   - Message your bot in Telegram (send `/start`)
   - Bot responds with a pairing code like `3EY4PUYS`
   - Go to `/setup` → **Section 5: Approve pairing**
   - Paste code and click **Approve**
   - ✅ Send another message — the bot will introduce itself and walk you through choosing its name, personality, and getting to know you

📖 **Full guide**: See [docs/TELEGRAM.md](docs/TELEGRAM.md) for detailed setup and troubleshooting

**Discord:**
1. Go to https://discord.com/developers/applications
2. **New Application** → **Bot** tab → **Add Bot**
3. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
4. **Reset Token** → copy the bot token
5. Invite to your server via **OAuth2 → URL Generator** (scopes: `bot`, `applications.commands`)
6. Paste the bot token in `/setup` → **Section 3: Chat platform** → **Discord bot token**

---

## Deploying it yourself

This section is for the person running the deploy (the "technical friend").

There are **two scripts** — use whichever fits your situation:

| | `setup.sh` | `deploy.sh` |
|---|---|---|
| **Use when** | First time on this machine | You already have Railway CLI, `.env`, etc. |
| **What it does** | Installs Homebrew + Railway CLI, logs you in, creates `.env`, then calls `deploy.sh` | Creates a new Railway project and deploys directly |
| **Run with** | `bash scripts/setup.sh` | `bash scripts/deploy.sh` |

**If in doubt, run `setup.sh`** — it detects what's already installed and skips those steps.

### First-time setup

#### Step 1: Create a Railway account

1. Go to **https://railway.com** and click **Sign Up**
2. You can sign up with **GitHub**, **Google**, or **email** — any method works
3. Pick the **Hobby** plan ($5/mo) — required for deployments
4. **Important:** If your workplace blocks SSO/OAuth or you're on a restricted network, get a Railway API token instead (see below)

#### Step 2: Get a Railway API token (optional)

The setup script can log you in two ways:
- **Browser login** — opens Railway's website to authenticate (easiest, works if you have browser access)
- **API token** — paste a token into your `.env` file (works on headless machines, CI, or when SSO/browser login isn't available)

To create an API token:
1. Log into https://railway.com in any browser
2. Go to **https://railway.com/account/tokens**
3. Click **Create Token** → name it (e.g. `openclaw-deploy`) → copy the token
4. Save it somewhere safe (1Password, etc.) — you can't view it again

#### Step 3: Run the setup script

The setup script handles everything: installs Homebrew and the Railway CLI if needed, logs you in, asks for your password, and deploys.

```bash
git clone https://github.com/k7cfo/openclaw-railway-private
cd openclaw-railway-private
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

#### Step 4: Complete the setup wizard

After the deploy finishes:
1. Wait for the build (~3–5 min)
2. Visit `https://yourapp.up.railway.app/setup`
3. Log in: username **admin**, password = your setup password
4. Select **OpenRouter** as provider, paste your OpenRouter API key
5. Paste Brave Search key, optional chat bot token
6. Click **Run setup**

### Redeploying from scratch

If you deleted a Railway project and want to deploy a fresh instance, just run `deploy.sh` again:

```bash
bash scripts/deploy.sh
```

The script automatically clears any stale project links before creating a new project, so you don't need to do any manual cleanup. Each run creates a brand-new Railway project with a fresh volume, variables, and domain.

To change the project name, set `PROJECT_NAME` in your `.env` or export it:

```bash
PROJECT_NAME=mybot bash scripts/deploy.sh
```

### Manual deploy (without the scripts)

If you prefer to do it by hand or the scripts don't work for your setup:

```bash
git clone https://github.com/k7cfo/openclaw-railway-private
cd openclaw-railway-private
cp .env.sample .env
# Edit .env: set SETUP_PASSWORD (and optionally RAILWAY_TOKEN)
bash scripts/deploy.sh
```

Or deploy entirely through the Railway web UI:
1. Go to https://railway.com/new → **Deploy from GitHub repo** → select this repo
2. Add a **Volume** mounted at `/data`
3. Set these Railway Variables:
   - `SETUP_PASSWORD` = your chosen password
   - `OPENCLAW_STATE_DIR` = `/data/.openclaw`
   - `OPENCLAW_WORKSPACE_DIR` = `/data/workspace`
   - `PORT` = `8080`
4. Go to **Settings** → **Networking** → **Generate Domain**
5. Visit `https://yourapp.up.railway.app/setup` and complete the wizard

### OpenClaw version

The deploy script **automatically fetches the latest stable release** from GitHub and builds it. You don't need to do anything to stay current.

To pin a specific version instead, set `OPENCLAW_GIT_REF` before deploying:

```bash
# In .env:
OPENCLAW_GIT_REF=v2026.2.19
```

Or override it in the Railway dashboard → your service → **Variables** → `OPENCLAW_GIT_REF=v2026.x.xx`, then redeploy.

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

- GitHub Issues: https://github.com/k7cfo/openclaw-railway-private/issues
- Upstream template: https://github.com/vignesh07/clawdbot-railway-template
