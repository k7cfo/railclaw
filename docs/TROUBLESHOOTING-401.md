# Fixing 401 Authentication Error on Telegram

## Symptoms
- Telegram bot responds with "401 Missing Authentication header"
- Railway logs show "getUpdates conflict: terminated by other getUpdates request"
- Railway logs show "Port 18789 is already in use"
- Multiple gateway instances trying to start

## Root Cause

The gateway has multiple instances trying to run, causing:
1. **Port conflicts** - multiple processes trying to bind to port 18789
2. **Telegram polling conflicts** - multiple bot instances polling Telegram simultaneously
3. **Authentication failures** - Telegram plugin can't authenticate because gateway is in a bad state

This typically happens when:
- Railway restarts/redeploys but old gateway processes don't fully terminate
- Manual gateway restarts via `/setup` debug console leave orphaned processes
- Volume state has stale PID files or locks

## Quick Fix (via Railway Dashboard)

1. **Force restart the service**:
   - Go to Railway dashboard → hunstock4 project → hunstock4 service
   - Click **⋮** (three dots) → **Restart**
   - This kills ALL processes and starts fresh

2. **Verify it's working**:
   - Wait 30 seconds for startup
   - Visit `https://hunstock4.up.railway.app/setup` → check Status
   - Should show "Configured" and gateway running

3. **Test Telegram**:
   - Message your bot (send `/start`)
   - If you still get 401, continue to "Deep Fix" below

## Deep Fix (via SSH)

If the quick fix doesn't work, SSH in and manually clean up:

### Step 1: SSH into Railway

```bash
railway shell
```

### Step 2: Check for multiple gateway processes

```bash
ps aux | grep -i gateway
ps aux | grep -i openclaw
```

If you see multiple `node` processes or multiple gateway processes, continue.

### Step 3: Kill all gateway processes

```bash
pkill -f "openclaw.*gateway"
pkill -f "node.*gateway"
```

Or find PIDs and kill manually:
```bash
ps aux | grep gateway
kill <PID1> <PID2> <PID3>
```

### Step 4: Clean stale locks

```bash
# Navigate to state directory
cd /data/.openclaw

# Remove lock files
rm -f *.lock
rm -f .gateway.lock
rm -f gateway.pid

# Check for stale PID files
ls -la | grep -E '\.pid|\.lock'
```

### Step 5: Verify config has correct auth token

```bash
cat /data/.openclaw/openclaw.json | grep -A 5 '"auth"'
cat /data/.openclaw/openclaw.json | grep -A 5 '"telegram"'
```

You should see:
```json
"auth": {
  "mode": "token",
  "token": "<some_token>"
}
```

And Telegram should have `"enabled": true`.

### Step 6: Exit SSH and restart via Railway

```bash
exit  # Exit SSH shell
```

Then in your local terminal:
```bash
railway restart
```

### Step 7: Test again

Wait 30 seconds, then message your Telegram bot.

## Permanent Fix (Prevent Future Issues)

The issue is that the wrapper sometimes doesn't properly clean up old gateway processes on restart. Let's add better process management:

### Option 1: Add a cleanup script to bootstrap.sh

Create or edit `/data/workspace/bootstrap.sh`:

```bash
#!/bin/bash
# Clean up any stale gateway processes on startup
pkill -f "openclaw.*gateway" 2>/dev/null || true
rm -f /data/.openclaw/*.lock 2>/dev/null || true
rm -f /data/.openclaw/gateway.pid 2>/dev/null || true
echo "Startup cleanup complete"
```

Make it executable:
```bash
railway run bash -c "chmod +x /data/workspace/bootstrap.sh"
```

### Option 2: Set Railway restart policy

In Railway dashboard:
- Service settings → **Restart Policy** → set to "Always" or "On Failure"
- This ensures Railway kills ALL processes on restart

### Option 3: Add healthcheck to detect bad state

(This would require code changes - see "Code Improvements" below)

## Code Improvements to Prevent This

Add to `src/server.js` to detect and kill orphaned processes:

```javascript
// Before starting gateway, ensure no orphaned processes
async function cleanupOrphanedGateway() {
  try {
    const { execSync } = require('child_process');
    // Check if port is already in use
    const netstat = execSync('lsof -ti:18789 2>/dev/null || true').toString().trim();
    if (netstat) {
      console.warn(`[wrapper] Found process on port 18789 (PID ${netstat}), killing...`);
      execSync(`kill -9 ${netstat} 2>/dev/null || true`);
      await sleep(500);
    }
  } catch (err) {
    console.warn(`[wrapper] Cleanup check failed (non-fatal): ${err}`);
  }
}

// Call before startGateway()
async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  await cleanupOrphanedGateway(); // <-- Add this line

  fs.mkdirSync(STATE_DIR, { recursive: true });
  // ... rest of startGateway code
}
```

## Verification Steps

After applying fixes:

1. **Check logs for clean startup**:
   ```bash
   railway logs --tail 50
   ```
   Should see:
   - "Gateway listening on ws://*********:18789"
   - "Telegram configured, enabled automatically"
   - NO "Port already in use" errors
   - NO "getUpdates conflict" errors

2. **Check healthz endpoint**:
   ```bash
   curl https://hunstock4.up.railway.app/healthz | jq
   ```
   Should show:
   ```json
   {
     "ok": true,
     "gateway": {
       "reachable": true
     }
   }
   ```

3. **Test Telegram**:
   - Message bot: `/start`
   - Should get pairing code, NOT "401 Missing Authentication header"
   - Approve pairing in `/setup` → Section 5

## Still Not Working?

If you still get 401 after all of the above:

1. **Check gateway token in config**:
   ```bash
   railway run bash -c "cat /data/.openclaw/openclaw.json | jq '.gateway.auth'"
   ```
   
2. **Reset Telegram config**:
   - Go to `/setup` → Debug console
   - Run: `openclaw.config.get channels.telegram`
   - Verify `enabled: true` and `botToken` is present
   - If missing, re-add via: `➕ Add Telegram` in debug console

3. **Check Telegram plugin status**:
   ```bash
   railway run bash -c "node /openclaw/dist/entry.js plugins list --token \$(cat /data/.openclaw/gateway.token)"
   ```
   Should show telegram as "loaded" and "enabled"

4. **Last resort - Full reset**:
   - `/setup` → Section 4 → **Reset setup**
   - Re-run the wizard from scratch
   - Re-add Telegram token

## Prevention Checklist

- [ ] Add `bootstrap.sh` cleanup script
- [ ] Set Railway restart policy to "Always"
- [ ] Monitor logs after restarts for "Port already in use"
- [ ] Use Railway dashboard restart (not `/setup` debug console) for clean restarts
- [ ] If using debug console gateway restart, always check logs afterward
