# Telegram Setup & Troubleshooting

Complete guide for setting up and pairing Telegram with OpenClaw on Railway.

## Quick Start

### 1. Create your Telegram bot
1. Open Telegram and message **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy your bot token (looks like `123456789:AAHdqTvikkRxGrL5CACpcEBPObbVI_ghkt0`)
4. **Important**: Don't share this token — it's like a password

### 2. Add bot token to OpenClaw

**During initial setup:**
- In the `/setup` wizard, scroll to **Section 3: Chat platform**
- Paste your bot token in the **Telegram bot token** field
- Click **Run setup**

**After initial setup (if you missed it):**
1. Go to `/setup` → **Debug console**
2. Select `➕ Add Telegram` from the dropdown
3. Paste your bot token in the **arg** field
4. Click **Run**

### 3. Pair your device

After adding the bot:

1. **Message your bot in Telegram**
   - Open Telegram and search for your bot by username
   - Send `/start` or any message

2. **Get your pairing code**
   - The bot will respond with a pairing code like `3EY4PUYS`
   - Copy this code

3. **Approve pairing in the setup wizard**
   - Go to `/setup` → scroll to **Section 5: Approve pairing**
   - Select **Telegram** from the channel dropdown
   - Paste your pairing code
   - Click **Approve**

✅ Done! You should now be able to chat with OpenClaw via Telegram.

---

## Troubleshooting

### Bot doesn't respond to messages

**Symptom**: You message your bot but get no response.

**Causes & fixes**:

1. **Gateway not running**
   - Go to `/setup` → check **Status** at the top
   - If not configured, run the setup wizard
   - If configured but gateway is down, use **Debug console** → `gateway.restart`

2. **Telegram plugin not enabled**
   - Go to `/setup` → **Debug console**
   - Run `openclaw.plugins.list`
   - If Telegram shows as "disabled" or "not loaded":
     ```
     Select: openclaw.plugins.enable
     Arg: telegram
     Click Run
     ```
   - Then restart gateway: `gateway.restart`

3. **Channel not configured**
   - Go to `/setup` → **Config editor**
   - Click **Reload** to view current config
   - Search for `"telegram"` — should see:
     ```json
     "channels": {
       "telegram": {
         "enabled": true,
         "botToken": "123456789:AAH...",
         "dmPolicy": "pairing",
         "groupPolicy": "allowlist",
         "streamMode": "partial"
       }
     }
     ```
   - If missing or `enabled: false`, use Debug console → `➕ Add Telegram` to re-add

4. **Bot token is wrong**
   - Double-check you copied the full token from BotFather
   - Tokens look like: `123456789:AAHdqTvikkRxGrL5CACpcEBPObbVI_ghkt0`
   - Re-add the bot with the correct token via Debug console

### "disconnected (1008): pairing required"

**Symptom**: Bot responds but says you need to pair.

**Fix**:
1. Message your bot — it will give you a pairing code
2. Go to `/setup` → **Section 5: Approve pairing**
3. Select **Telegram**, paste code, click **Approve**

**Alternative (if above doesn't work)**:
1. Go to `/setup` → scroll to **Section 4: Run onboarding**
2. Expand **Pairing helper** (click the details arrow)
3. Click **Refresh pending devices**
4. Approve any pending requests

### Bot was working, now it's not

**Likely cause**: Gateway restarted and plugin disabled itself.

**Fix**:
1. Go to `/setup` → **Debug console**
2. Run `openclaw.doctor` — shows issues
3. If it mentions Telegram is disabled:
   ```
   Select: openclaw.plugins.enable
   Arg: telegram
   Click Run
   ```
4. Restart gateway: `gateway.restart`

### Can't find pairing code

**Where to look**:
1. **In Telegram**: Message your bot — it responds with the code
2. **In setup wizard**: `/setup` → **Section 5** → click **Check pending**
3. **Via debug console**: 
   ```
   Select: openclaw.devices.list
   Click Run
   ```
   Look for `requestId` in the output

### "Invalid bot token" or "401 Unauthorized"

**Cause**: Bot token is incorrect or was revoked.

**Fix**:
1. Go to Telegram → message @BotFather
2. Send `/mybots` → select your bot → **API Token** → copy new token
3. Re-add to OpenClaw via Debug console → `➕ Add Telegram`

### Bot responds but messages are delayed

**Cause**: Railway free tier has resource limits; gateway might be sleeping or slow.

**Fixes**:
- Upgrade Railway plan for more resources
- Use `streamMode: "incremental"` in config for faster partial responses
- Check Railway logs for performance issues: `railway logs`

### Multiple people want to use the bot

**Scenario**: Friends/family want access.

**Fix**: Each person needs device pairing approval.
1. They message the bot → get a pairing code
2. You approve each one via `/setup` → **Section 5**
3. Or enable allowlist policy in config:
   ```json
   "telegram": {
     "dmPolicy": "allowlist",
     "dmAllowlist": ["telegram_user_id_1", "telegram_user_id_2"]
   }
   ```

To find Telegram user IDs:
1. User messages the bot
2. Check `/setup` → Debug console → `openclaw.logs.tail`
3. Look for messages like `"userId": "123456789"`

---

## Advanced: Config tweaks

### Change response mode

Edit config via `/setup` → **Config editor** → find `channels.telegram.streamMode`:

- `"partial"` — sends message as it's being generated (default, good UX)
- `"incremental"` — sends word-by-word (fastest feedback)
- `"buffered"` — waits until complete (cleanest output)

### Enable group chats

By default, bot only works in DMs. To enable group chats:

1. Add your bot to a group
2. Edit config → `channels.telegram.groupPolicy`:
   ```json
   "groupPolicy": "allowlist",
   "groupAllowlist": ["-100123456789"]
   ```
3. Get group ID from logs after sending a message in the group

### Disable pairing (open access)

**⚠️ Not recommended** — anyone with your bot username can use it.

```json
"telegram": {
  "dmPolicy": "open"
}
```

---

## Debugging checklist

If Telegram still isn't working after trying the above:

1. **Check Railway logs**:
   ```bash
   railway logs
   ```
   Look for errors mentioning "telegram" or "polling"

2. **Verify gateway is running**:
   - Visit `/healthz` — should show `"gateway": { "reachable": true }`

3. **Run doctor**:
   - `/setup` → Debug console → `openclaw.doctor`

4. **Check config file**:
   - `/setup` → Config editor → Reload
   - Verify `channels.telegram.enabled: true`
   - Verify `channels.telegram.botToken` is present

5. **Export and inspect backup**:
   - `/setup` → **Download backup (.tar.gz)**
   - Extract and check `.openclaw/openclaw.json` manually

6. **Reset and re-run setup** (last resort):
   - `/setup` → Section 4 → **Reset setup** button
   - Re-run the wizard from scratch

---

## Support

- GitHub Issues: https://github.com/k7cfo/openclaw-railway-private/issues
- OpenClaw Discord: https://discord.gg/openclaw (community support)
