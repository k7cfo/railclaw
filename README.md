# OpenClaw on Railway

Your own private AI assistant on Railway. HTTPS included, no tunnels needed.

---

## Is a friend setting this up for you?

If someone offered to deploy OpenClaw for you, you just need to get **2 API keys** and pick a **password**. Follow the steps below, then send all 3 things to your friend (use a secure method — not plain text over email).

### 1. Get an OpenAI API key

1. Go to **https://platform.openai.com/signup** and create an account
2. Add billing credits ($5–10 is plenty to start):
   - https://platform.openai.com/settings/organization/billing
3. Create an API key:
   - Go to https://platform.openai.com/api-keys
   - Click **Create new secret key** → copy it
   - **Save this key** — you can't view it again

### 2. Get a Brave Search API key

1. Go to **https://brave.com/search/api/** and click **Get Started**
2. Create an account and pick the **Free** plan (2,000 queries/month)
3. Get your key:
   - Go to https://api.search.brave.com/app/keys
   - Copy your API key

### 3. Pick a setup password

Choose any password you'll remember. This protects the `/setup` admin page where you'll paste your keys.

### 4. Send these to your friend

Send these **3 things** securely (e.g. 1Password, Signal, in person):

- Your **OpenAI API key**
- Your **Brave Search API key**
- Your **setup password**

Your friend will deploy it and send you a URL like `https://yourapp.up.railway.app`. Visit `/setup` at that URL, log in with username **admin** and your password, paste your keys, and you're done.

### 5. Optional: set up a chat bot

If you want to talk to your AI via Telegram or Discord:

**Telegram:**
1. Open Telegram, message **@BotFather**, send `/newbot`
2. Copy the bot token (looks like `123456789:AAHk...`)

**Discord:**
1. Go to https://discord.com/developers/applications
2. **New Application** → **Bot** tab → **Add Bot**
3. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
4. **Reset Token** → copy the bot token
5. Invite to your server via **OAuth2 → URL Generator** (scopes: `bot`, `applications.commands`)

Paste the bot token in the `/setup` wizard under **Chat platform**.

---

## Deploying it yourself

This section is for the person running the deploy (the "technical friend").

### Prerequisites

- **Railway account** — https://railway.com (Hobby plan, $5/mo)
- **Railway CLI** — `brew install railway` then `railway login`
- A `SETUP_PASSWORD` (yours or your friend's)

### Quick deploy

```bash
git clone https://github.com/k7cfo/openclaw-railway-private
cd openclaw-railway-private
cp .env.sample .env
```

Edit `.env`:

```
SETUP_PASSWORD=pick-any-password
```

Deploy:

```bash
bash scripts/deploy.sh
```

After it finishes:
1. Open your **Railway dashboard** → your service → **Settings** → **Networking** → **Generate Domain**
2. Wait for the build (~3–5 min)
3. Visit `https://yourapp.up.railway.app/setup`
4. Log in: username **admin**, password = `SETUP_PASSWORD`
5. Paste OpenAI key, Brave Search key, optional chat bot token
6. Click **Run setup**

### Manual deploy (without the script)

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
- **API keys stay on the server** — OpenAI and Brave Search keys are saved to the persistent volume, never exposed in env vars or logs.
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

**"pairing required" / dashboard offline**
Gateway is running but no device is approved. Go to `/setup` → approve the device.

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

---

## Support

- GitHub Issues: https://github.com/k7cfo/openclaw-railway-private/issues
- Upstream template: https://github.com/vignesh07/clawdbot-railway-template
