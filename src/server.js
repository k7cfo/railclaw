import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Migrate deprecated CLAWDBOT_* env vars → OPENCLAW_* so existing Railway deployments
// keep working. Users should update their Railway Variables to use the new names.
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
    // Best-effort compatibility shim for old Railway templates.
    // Intentionally no warning: Railway templates can still set legacy keys and warnings are noisy.
  }
}

// Railway injects PORT at runtime and routes traffic to that port.
// Do not force a different public port in the container image, or the service may
// boot but the Railway domain will be routed to a different port.
//
// OPENCLAW_PUBLIC_PORT is kept as an escape hatch for non-Railway deployments.
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Persistent extra env vars (e.g. BRAVE_API_KEY) saved by the setup wizard.
// These live in STATE_DIR/extra-env.json and are loaded into process.env on startup
// so the gateway process inherits them.
const EXTRA_ENV_PATH = path.join(STATE_DIR, "extra-env.json");
function loadExtraEnv() {
  try {
    if (fs.existsSync(EXTRA_ENV_PATH)) {
      const vars = JSON.parse(fs.readFileSync(EXTRA_ENV_PATH, "utf8"));
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v === "string" && v) process.env[k] = v;
      }
    }
  } catch (err) {
    console.warn(`[wrapper] failed to load extra env: ${err}`);
  }
}
function saveExtraEnv(vars) {
  let existing = {};
  try {
    if (fs.existsSync(EXTRA_ENV_PATH)) {
      existing = JSON.parse(fs.readFileSync(EXTRA_ENV_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  const merged = { ...existing, ...vars };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(EXTRA_ENV_PATH, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
  // Also set in current process so the gateway picks them up on next (re)start.
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string" && v) process.env[k] = v;
  }
}
loadExtraEnv();

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

// Append Railway-specific persistence rules to AGENTS.md.
// We never pre-create workspace files — OpenClaw's gateway seeds the stock
// templates (BOOTSTRAP.md, AGENTS.md, SOUL.md, etc.) on first message, which
// triggers the first-run onboarding conversation. Pre-creating AGENTS.md would
// make OpenClaw think the workspace isn't new, skipping BOOTSTRAP.md entirely.
//
// Instead, we wait for AGENTS.md to appear (created by the gateway after the
// user's first message) and then append the Railway persistence section.
const PERSISTENCE_MARKER = "# Railway Deployment";
const PERSISTENCE_TEMPLATE_PATH = path.join("/app", "templates", "RAILWAY-PERSISTENCE.md");
let persistenceAppended = false;

function tryAppendRailwayPersistence() {
  if (persistenceAppended) return true;
  const agentsMdPath = path.join(WORKSPACE_DIR, "AGENTS.md");
  try {
    if (!fs.existsSync(agentsMdPath)) return false;
    const existing = fs.readFileSync(agentsMdPath, "utf8");
    if (existing.includes(PERSISTENCE_MARKER)) {
      persistenceAppended = true;
      seedWorkspaceTemplates();
      return true;
    }
    const template = fs.readFileSync(PERSISTENCE_TEMPLATE_PATH, "utf8");
    fs.appendFileSync(agentsMdPath, "\n\n" + template, "utf8");
    console.log(`[wrapper] appended Railway persistence rules to ${agentsMdPath}`);
    persistenceAppended = true;
    seedWorkspaceTemplates();
    return true;
  } catch (err) {
    console.warn(`[wrapper] persistence append failed (non-fatal): ${err}`);
    return false;
  }
}

const BOOTSTRAP_TEMPLATE_PATH = path.join("/app", "templates", "workspace", "BOOTSTRAP.md");
const HEARTBEAT_TEMPLATE_PATH = path.join("/app", "templates", "workspace", "HEARTBEAT.md");
const TOOLS_TEMPLATE_PATH = path.join("/app", "templates", "workspace", "TOOLS.md");

function seedWorkspaceTemplate(templatePath, filename) {
  const destPath = path.join(WORKSPACE_DIR, filename);
  try {
    if (fs.existsSync(destPath)) return; // already exists
    if (!fs.existsSync(templatePath)) return;
    const content = fs.readFileSync(templatePath, "utf8");
    fs.writeFileSync(destPath, content, { encoding: "utf8", flag: "wx" });
    console.log(`[wrapper] seeded ${filename} in workspace`);
  } catch (err) {
    if (err?.code !== "EEXIST") {
      console.warn(`[wrapper] ${filename} seed failed (non-fatal): ${err}`);
    }
  }
}

function seedCustomBootstrap() {
  seedWorkspaceTemplate(BOOTSTRAP_TEMPLATE_PATH, "BOOTSTRAP.md");
}

function seedWorkspaceTemplates() {
  seedWorkspaceTemplate(HEARTBEAT_TEMPLATE_PATH, "HEARTBEAT.md");
  seedWorkspaceTemplate(TOOLS_TEMPLATE_PATH, "TOOLS.md");
}

function appendRailwayPersistenceRules() {
  // Try immediately (covers existing workspaces / redeploys).
  if (tryAppendRailwayPersistence()) return;

  // Fresh deploy: workspace doesn't exist yet. Poll until OpenClaw creates it
  // after the user's first message triggers the bootstrap.
  let attempts = 0;
  const maxAttempts = 60; // ~10 minutes at 10s intervals
  const interval = setInterval(() => {
    attempts++;
    if (tryAppendRailwayPersistence() || attempts >= maxAttempts) {
      clearInterval(interval);
      if (attempts >= maxAttempts && !persistenceAppended) {
        console.warn("[wrapper] gave up waiting for AGENTS.md — persistence rules not appended");
      }
    }
  }, 10_000);
  interval.unref?.();
}

// One-time migration: rename legacy config files to openclaw.json so existing
// deployments that still have the old filename on their volume keep working.
(function migrateLegacyConfigFile() {
  // If the operator explicitly chose a config path, do not rename files in STATE_DIR.
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;

  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;

  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to root.
      const paths = ["/openclaw", "/"];
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

// Clean up any orphaned gateway processes that might block port 18789.
// This prevents "Port already in use" errors and Telegram 401 auth failures
// caused by multiple gateway instances trying to run simultaneously.
async function cleanupOrphanedGateway() {
  try {
    // Check if port 18789 is already in use
    const net = await import("node:net");
    const isPortInUse = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          resolve(true);
        } else {
          resolve(false);
        }
      });
      server.once("listening", () => {
        server.close();
        resolve(false);
      });
      server.listen(INTERNAL_GATEWAY_PORT, INTERNAL_GATEWAY_HOST);
    });

    if (isPortInUse) {
      console.warn(`[wrapper] Port ${INTERNAL_GATEWAY_PORT} is in use, attempting cleanup...`);
      try {
        // Try to find and kill the process using lsof (if available)
        const lsofResult = childProcess.spawnSync("lsof", ["-ti", `:${INTERNAL_GATEWAY_PORT}`], {
          encoding: "utf8",
          timeout: 2000,
        });
        const pid = (lsofResult.stdout || "").trim();
        if (pid && /^\d+$/.test(pid)) {
          console.warn(`[wrapper] Killing orphaned process on port ${INTERNAL_GATEWAY_PORT} (PID ${pid})`);
          childProcess.spawnSync("kill", ["-9", pid]);
          await sleep(500);
        }
      } catch (lsofErr) {
        // lsof might not be available; try pkill as fallback
        console.warn(`[wrapper] lsof failed, trying pkill fallback: ${String(lsofErr)}`);
        try {
          childProcess.spawnSync("pkill", ["-f", "openclaw.*gateway"]);
          await sleep(500);
        } catch (pkillErr) {
          console.warn(`[wrapper] pkill also failed: ${String(pkillErr)}`);
        }
      }
    }

    // Clean up any stale lock files
    try {
      const lockPatterns = ["*.lock", ".gateway.lock", "gateway.pid"];
      for (const pattern of lockPatterns) {
        const lockPath = path.join(STATE_DIR, pattern);
        if (fs.existsSync(lockPath)) {
          fs.rmSync(lockPath, { force: true });
          console.warn(`[wrapper] Removed stale lock file: ${pattern}`);
        }
      }
    } catch (lockErr) {
      console.warn(`[wrapper] Lock cleanup failed (non-fatal): ${String(lockErr)}`);
    }
  } catch (err) {
    console.warn(`[wrapper] Gateway cleanup check failed (non-fatal): ${String(err)}`);
  }
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  // Clean up any orphaned processes before starting
  await cleanupOrphanedGateway();

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--token", OPENCLAW_GATEWAY_TOKEN]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Public health endpoint (no auth) so Railway can probe without /setup.
// Keep this free of secrets.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try {
      gatewayReachable = await probeGateway();
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({
    ok: true,
    wrapper: {
      configured: isConfigured(),
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
    },
    gateway: {
      target: GATEWAY_TARGET,
      reachable: gatewayReachable,
      lastError: lastGatewayError,
      lastExit: lastGatewayExit,
      lastDoctorAt,
    },
  });
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Railclaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>Railclaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>
  <p><a href="#first-time-setup" style="font-weight:700; font-size:1.1rem">↓ Jump to First Time Setup</a></p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/?token=${OPENCLAW_GATEWAY_TOKEN}" target="_blank">Open OpenClaw Dashboard</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.version">openclaw --version</option>
        <option disabled>──────</option>
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option disabled>──────</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
        <option disabled>──────</option>
        <option value="channels.add.telegram">➕ Add Telegram (paste bot token in arg)</option>
        <option value="channels.add.discord">➕ Add Discord (paste bot token in arg)</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <h2 id="first-time-setup" style="font-size: 2rem; margin-top: 2.5rem; padding-top: 1rem; border-top: 3px solid #111">🚀 First Time Setup</h2>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>

    <div id="openrouterModelPresetBox" style="display:none; margin-top:1rem; padding:0.75rem; background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px">
      <label><strong>OpenRouter model preset</strong></label>
      <p class="muted" style="margin:0.25rem 0 0.5rem 0">Pick a starting model configuration. You can switch models anytime via <code>/model</code> in chat.</p>
      <select id="openrouterPreset">
        <option value="quality">Quality — Sonnet 4.5 + DeepSeek fallback ($3–15/MTok)</option>
        <option value="balanced" selected>Balanced — DeepSeek V3.2 + Haiku fallback ($0.26–5/MTok)</option>
        <option value="budget">Budget — DeepSeek V3.2 only ($0.26–0.38/MTok)</option>
      </select>
      <div class="muted" style="margin-top:0.25rem; font-size:0.85rem">
        All presets include 10 switchable models: Opus 4.6, Codex, Sonnet 4.5, Gemini 3 Flash, Kimi K2.5, GLM 5, MiniMax M2.5, DeepSeek V3.2, Haiku 4.5, Qwen Coder. Free image models included.
      </div>
    </div>
  </div>

  <div class="card">
    <h2>2) Brave Search API key (optional)</h2>
    <p class="muted">Gives OpenClaw the ability to search the web. Without this, web search tools won't work.</p>
    <label>Brave Search API key</label>
    <input id="braveApiKey" type="password" placeholder="BSA..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it free: <a href="https://brave.com/search/api/" target="_blank">brave.com/search/api</a> → Get Started → Free plan (2,000 queries/mo)
    </div>
  </div>

  <div class="card">
    <h2>3) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>4) Optional: Chat platform</h2>
    <p class="muted">You can also add channels later via the debug console above. Adding them here gets messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Telegram permissions preset</label>
    <select id="telegramPermissions">
      <option value="restrictive">Restrictive — sandbox exec, approval required</option>
      <option value="standard" selected>Standard (recommended for VPS) — gateway exec, auto-approve safe commands</option>
      <option value="full">Full Access (⚠️ trusted users only) — auto-approve all, full exec, all Telegram actions</option>
    </select>
    <div class="muted" style="margin-top: 0.25rem">
      <strong>Restrictive:</strong> Commands run in sandbox, approval needed for each. Telegram actions limited.<br/>
      <strong>Standard:</strong> Commands run on host, safe commands auto-approved, dangerous ones still ask. Telegram actions enabled.<br/>
      <strong>Full Access:</strong> All commands auto-approved, full security tier, elevated mode enabled, all Telegram actions (reactions, stickers, deletes). Only for fully trusted users.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>5) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <div id="dashboardLinkBox" style="display:none; margin-top:1rem; padding:1rem; background:#0d1117; border:2px solid #22c55e; border-radius:8px">
      <h3 style="margin:0 0 0.5rem 0; color:#22c55e">✅ Setup complete!</h3>
      <p style="margin:0 0 0.5rem 0"><strong>Your dashboard link (with auth token):</strong></p>
      <input id="dashboardLink" type="text" readonly style="width:100%; font-family:monospace; font-size:0.85rem; padding:0.5rem; background:#161b22; color:#58a6ff; border:1px solid #30363d; border-radius:4px; cursor:text" />
      <div style="margin-top:0.5rem; display:flex; gap:0.5rem">
        <button id="copyDashLink" style="background:#22c55e; color:#000">📋 Copy link</button>
        <a id="openDashLink" href="#" target="_blank" style="display:inline-block; padding:0.4rem 0.8rem; background:#1f6feb; color:#fff; border-radius:4px; text-decoration:none">↗ Open dashboard</a>
      </div>
      <p style="margin:0.75rem 0 0 0; color:#f0883e; font-size:0.85rem">⚠️ <strong>Bookmark this link and keep it private.</strong> It contains your auth token — anyone with this link has full access to your OpenClaw dashboard. Do not share it.</p>
    </div>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <div class="card">
    <h2>6) Approve pairing</h2>
    <p class="muted">After setup, message your bot (e.g. <code>/start</code> in Telegram). You'll get a pairing code — enter it here to grant access.</p>
    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
      <select id="pairingChannel" style="flex: 0 0 auto; width: auto">
        <option value="telegram">Telegram</option>
        <option value="discord">Discord</option>
      </select>
      <input id="pairingCode" placeholder="Pairing code (e.g. 3EY4PUYS)" style="flex: 1; min-width: 200px" />
      <button id="pairingApprove" style="background:#1f2937">Approve</button>
      <button id="pairingRefresh" style="background:#0f172a">Check pending</button>
    </div>
    <pre id="pairingOut" style="white-space:pre-wrap"></pre>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

// OpenRouter model presets — injected post-onboard when user selects OpenRouter.
const OPENROUTER_MODEL_CATALOG = {
  "openrouter/anthropic/claude-opus-4.6": { alias: "Opus" },
  "openrouter/openai/gpt-5.2-codex": { alias: "Codex" },
  "openrouter/anthropic/claude-sonnet-4.5": { alias: "Sonnet" },
  "openrouter/google/gemini-3-flash-preview": { alias: "Gemini Flash" },
  "openrouter/moonshotai/kimi-k2.5": { alias: "Kimi" },
  "openrouter/z-ai/glm-5": { alias: "GLM" },
  "openrouter/minimax/minimax-m2.5": { alias: "MiniMax" },
  "openrouter/deepseek/deepseek-v3.2": { alias: "DeepSeek" },
  "openrouter/anthropic/claude-haiku-4.5": { alias: "Haiku" },
  "openrouter/qwen/qwen3-coder-plus": { alias: "Qwen Coder" },
};

const OPENROUTER_PRESETS = {
  quality: {
    model: { primary: "openrouter/anthropic/claude-sonnet-4.5", fallbacks: ["openrouter/deepseek/deepseek-v3.2"] },
  },
  balanced: {
    model: { primary: "openrouter/deepseek/deepseek-v3.2", fallbacks: ["openrouter/anthropic/claude-haiku-4.5"] },
  },
  budget: {
    model: { primary: "openrouter/deepseek/deepseek-v3.2" },
  },
};

const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 5)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 5) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

// Returns the dashboard URL with the gateway token embedded for bookmarking.
app.get("/setup/api/dashboard-url", requireSetupAuth, (req, res) => {
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const token = OPENCLAW_GATEWAY_TOKEN;
  const url = token ? `${proto}://${host}/?token=${token}` : null;
  res.json({ ok: true, dashboardUrl: url, hasToken: Boolean(token) });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];

    // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
    // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
    // wizard "reverted" their selection.
    if (flag && !secret) {
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    }

    if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };
    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, {
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    // IMPORTANT: Set both gateway.auth.token (server-side) and gateway.remote.token (client-side)
    // to the same value so the Control UI can connect without "token mismatch" errors.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.host", INTERNAL_GATEWAY_HOST]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.port", String(INTERNAL_GATEWAY_PORT)]));
    // Flat gateway.token is read by some CLI subcommands for client-side auth.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Railway runs behind a reverse proxy. The wrapper proxies from loopback to the gateway,
    // forwarding X-Forwarded-* headers from Railway's edge. Trust all addresses since the
    // gateway only listens on loopback (--gateway-bind loopback) and is not externally reachable.
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["0.0.0.0/0", "::/0"]) ]),
    );

    // Allow Control UI over plain HTTP (Cloudflare Tunnel or internal access).
    // Without this, the browser's non-secure context blocks WebCrypto and the
    // gateway rejects the connection with "requires HTTPS or localhost".
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]),
    );

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        const token = payload.telegramToken.trim();
        // Stronger validation: require at least 5 digits before ':' and 10+ chars after
        if (!/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(token)) {
          extra += "\n[telegram] skipped: invalid bot token format (looks truncated). Expected like 123456789:AAHk...\n";
        } else {
          // Avoid `channels add` here (it has proven flaky across builds); write config directly.
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streaming: true,
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

          // Best-effort: enable the telegram plugin explicitly (some builds require this even when configured).
          const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));

          extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
          extra += `\n[telegram plugin enable] exit=${plug.code} (output ${plug.output.length} chars)\n${plug.output || "(no output)"}`;
        }
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply Telegram permissions preset (if provided).
    if (payload.telegramPermissions && payload.telegramPermissions !== "restrictive") {
      const preset = payload.telegramPermissions;
      extra += `\n[telegram-permissions] applying preset: ${preset}\n`;

      if (preset === "standard" || preset === "full") {
        // Run exec on gateway host (not sandbox — Railway doesn't have Docker-in-Docker).
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "tools.exec.host", "gateway"]));
        // Disable sandbox mode (no Docker available on Railway).
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "agents.defaults.sandbox.mode", "off"]));
        // Enable Telegram actions.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "channels.telegram.actions.reactions", "true"]));
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "channels.telegram.actions.sendMessage", "true"]));
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "channels.telegram.actions.deleteMessage", "true"]));
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "channels.telegram.actions.sticker", "true"]));
        extra += `[telegram-permissions] set exec host=gateway, sandbox=off, telegram actions=enabled\n`;
      }

      if (preset === "standard") {
        // Auto-approve safe commands; ask for dangerous ones.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "tools.exec.ask", "on-miss"]));
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "tools.exec.security", "allowlist"]));
        extra += `[telegram-permissions] set exec ask=on-miss, security=allowlist\n`;
      }

      if (preset === "full") {
        // Auto-approve everything, full security tier, elevated mode.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "tools.exec.ask", "off"]));
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "tools.exec.security", "full"]));
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "tools.elevated", JSON.stringify({ enabled: true })]));
        extra += `[telegram-permissions] set exec ask=off, security=full, elevated=enabled\n`;
      }
    }

    // --- OpenRouter model presets + memory/heartbeat config ---
    // Only apply when the user selected OpenRouter as their auth provider.
    const isOpenRouter = payload.authChoice === "openrouter-api-key";
    if (isOpenRouter) {
      const presetName = payload.openrouterPreset || "balanced";
      const preset = OPENROUTER_PRESETS[presetName] || OPENROUTER_PRESETS.balanced;
      extra += `\n[openrouter-models] applying preset: ${presetName}\n`;

      // Primary + fallback model.
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.model", JSON.stringify(preset.model)]));

      // Full model catalog (allowlist with aliases for /model command).
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.models", JSON.stringify(OPENROUTER_MODEL_CATALOG)]));

      // Free image models.
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.imageModel", JSON.stringify({
        primary: "openrouter/qwen/qwen2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-001:free"],
      })]));

      // Heartbeat with cheap model.
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.heartbeat", JSON.stringify({
        every: "30m",
        model: "openrouter/anthropic/claude-haiku-4.5",
        target: "last",
      })]));

      extra += `[openrouter-models] model=${preset.model.primary}, catalog=${Object.keys(OPENROUTER_MODEL_CATALOG).length} models, heartbeat=haiku\n`;
    }

    // --- Memory configuration (all providers) ---
    // Memory flush: triggers a silent turn before compaction to write durable memories.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.compaction", JSON.stringify({
      mode: "safeguard",
      reserveTokensFloor: 24000,
      memoryFlush: {
        enabled: true,
        softThresholdTokens: 6000,
        systemPrompt: "Session nearing compaction. Store durable memories now.",
        prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
      },
    })]));

    // Context pruning: prune stale tool results from context.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.contextPruning", JSON.stringify({
      mode: "cache-ttl",
      ttl: "2h",
      keepLastAssistants: 3,
    })]));

    // Hybrid memory search: BM25 + vectors with MMR dedup and temporal decay.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.memorySearch", JSON.stringify({
      sources: ["memory", "sessions"],
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          mmr: { enabled: true, lambda: 0.7 },
          temporalDecay: { enabled: true, halfLifeDays: 30 },
        },
      },
    })]));

    extra += `\n[memory] compaction safeguard + memoryFlush enabled, contextPruning 2h, hybrid search on\n`;

    // Persist Brave Search API key (if provided) so the gateway can use web search.
    if (payload.braveApiKey?.trim()) {
      const key = payload.braveApiKey.trim();
      saveExtraEnv({ BRAVE_API_KEY: key });
      extra += `\n[brave] API key saved and will be available to the gateway.\n`;
    }

    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--non-interactive"]));
    extra += `\n[doctor --fix] exit=${fix.code} (output ${fix.output.length} chars)\n${fix.output || "(no output)"}`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  }

  // Build the dashboard URL so the client can display it after setup.
  const dashHost = req.headers.host || "localhost";
  const dashProto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const dashboardUrl = OPENCLAW_GATEWAY_TOKEN
    ? `${dashProto}://${dashHost}/?token=${OPENCLAW_GATEWAY_TOKEN}`
    : null;

  return respondJson(ok ? 200 : 500, {
    ok,
    output: `${prefix}${onboard.output}${extra}`,
    dashboardUrl: ok ? dashboardUrl : null,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Channel config checks (redact secrets before returning to client)
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  const tgOut = redactSecrets(tg.output || "");
  const dcOut = redactSecrets(dc.output || "");

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output || "") || /enabled\s*[:=]\s*true/.test(tg.output || ""),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output || ""),
          output: tgOut,
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output || "") || /enabled\s*[:=]\s*true/.test(dc.output || ""),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output || "") || /token\s*[:=]\s*\S+/.test(dc.output || ""),
          output: dcOut,
        },
      },
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Telegram bot tokens look like: 123456:ABCDEF...
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
  "openclaw.config.set",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",

  // Add chat channels after initial setup (no reset needed)
  "channels.add.telegram",
  "channels.add.discord",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--non-interactive"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines), "--token", OPENCLAW_GATEWAY_TOKEN]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.set") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path=value" });
      // arg format: "path value" (space-separated)
      const spaceIdx = arg.indexOf(" ");
      if (spaceIdx === -1) return res.status(400).json({ ok: false, error: "Format: path value" });
      const cfgPath = arg.slice(0, spaceIdx);
      const cfgValue = arg.slice(spaceIdx + 1);
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", cfgPath, cfgValue]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list", "--token", OPENCLAW_GATEWAY_TOKEN]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", "--token", OPENCLAW_GATEWAY_TOKEN, requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Add Telegram channel (no reset required)
    if (cmd === "channels.add.telegram") {
      const botToken = String(arg || "").trim();
      if (!botToken) return res.status(400).json({ ok: false, error: "Paste your Telegram bot token in the arg field (e.g. 123456789:AAHk...)" });
      // Stronger validation: require at least 5 digits before ':' and 10+ chars after
      if (!/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(botToken)) {
        return res.status(400).json({ ok: false, error: "Invalid Telegram bot token format (looks truncated). Expected like 123456789:AAHk..." });
      }

      let out = "";
      const cfgObj = { enabled: true, dmPolicy: "pairing", botToken, groupPolicy: "allowlist", streamMode: "partial" };
      const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]));
      out += `[telegram config] exit=${set.code}\n${set.output || "(no output)"}\n`;

      const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
      out += `[telegram plugin] exit=${plug.code}\n${plug.output || "(no output)"}\n`;

      await restartGateway();
      out += "\n[gateway] restarted.\n";
      out += "\nTelegram added! Send a message to your bot, then use 'Refresh pending devices' below to approve the pairing.\n";

      return res.json({ ok: set.code === 0, output: out });
    }

    // Add Discord channel (no reset required)
    if (cmd === "channels.add.discord") {
      const botToken = String(arg || "").trim();
      if (!botToken) return res.status(400).json({ ok: false, error: "Paste your Discord bot token in the arg field" });

      let out = "";
      const cfgObj = { enabled: true, token: botToken, groupPolicy: "allowlist", dm: { policy: "pairing" } };
      const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]));
      out += `[discord config] exit=${set.code}\n${set.output || "(no output)"}\n`;

      const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "discord"]));
      out += `[discord plugin] exit=${plug.code}\n${plug.output || "(no output)"}\n`;

      await restartGateway();
      out += "\n[gateway] restarted.\n";
      out += "\nDiscord added! Send a DM to your bot, then use 'Refresh pending devices' below to approve the pairing.\n";

      return res.json({ ok: set.code === 0, output: out });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Channel pairing: list pending codes and approve them.
// The gateway requires auth. We try the CLI with --token first, then fall back
// to a direct HTTP request to the gateway as a last resort.
app.get("/setup/api/pairing/list/:channel", requireSetupAuth, async (req, res) => {
  const channel = String(req.params.channel || "").toLowerCase();
  if (!["telegram", "discord", "whatsapp", "slack", "signal"].includes(channel)) {
    return res.status(400).json({ ok: false, error: "Invalid channel" });
  }
  try { await ensureGatewayRunning(); } catch {}

  // Try with --token flag (gateway requires auth).
  const r1 = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", "--token", OPENCLAW_GATEWAY_TOKEN, channel]), { timeoutMs: 15_000 });
  if (r1.code === 0) return res.json({ ok: true, output: r1.output });

  // Fallback: try without --token (in case --token is unknown and config has the token).
  const r2 = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", channel]), { timeoutMs: 15_000 });
  return res.status(r2.code === 0 ? 200 : 500).json({ ok: r2.code === 0, output: r2.output || r1.output });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const ch = String(channel).toLowerCase();
  const c = String(code).trim().toUpperCase();

  try { await ensureGatewayRunning(); } catch {}

  // Approach 1: CLI with --token flag (most reliable for gateway-authenticated commands).
  const r1 = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", "--token", OPENCLAW_GATEWAY_TOKEN, ch, c]), { timeoutMs: 15_000 });
  if (r1.code === 0) return res.json({ ok: true, output: r1.output });

  // Approach 2: CLI without --token (relies on config gateway.remote.token / gateway.token).
  const r2 = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", ch, c]), { timeoutMs: 15_000 });
  if (r2.code === 0) return res.json({ ok: true, output: r2.output });

  // Approach 3: Direct HTTP to gateway API as last resort.
  for (const apiPath of ["/api/pairing/approve", "/api/admin/pairing/approve"]) {
    try {
      const apiRes = await fetch(`${GATEWAY_TARGET}${apiPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({ channel: ch, code: c }),
      });
      if (apiRes.ok) {
        const text = await apiRes.text();
        return res.json({ ok: true, output: text || "Pairing approved via gateway API." });
      }
    } catch {}
  }

  // All approaches failed. Return the most informative error.
  return res.status(500).json({
    ok: false,
    output: [r1.output, r2.output].filter(Boolean).join("\n") || "Pairing approval failed. Check gateway logs.",
  });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list", "--token", OPENCLAW_GATEWAY_TOKEN]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", "--token", OPENCLAW_GATEWAY_TOKEN, requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Reset: stop gateway (frees memory) + delete config file(s) so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
    } catch {
      // ignore
    }

    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }

    res.type("text/plain").send("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// When accessed over plain HTTP (e.g. Railway internal network), the OpenClaw control UI
// rejects WebSocket connections because X-Forwarded-Proto is "http" (not a secure context).
// Setting FORCE_HTTPS_PROTO=true tells the wrapper to advertise "https" to the gateway.
// Railway's .up.railway.app domains already have TLS, so this is only needed for internal access.
const FORCE_HTTPS_PROTO = /^(true|1|yes)$/i.test(process.env.FORCE_HTTPS_PROTO ?? "");

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

// When FORCE_HTTPS_PROTO is enabled, rewrite protocol-related headers so the
// OpenClaw gateway believes the connection is HTTPS. This is necessary because
// the gateway checks the Origin header on WebSocket upgrades and rejects non-
// secure origins. Railway provides TLS on .up.railway.app domains.
function rewriteHttpsHeaders(proxyReq) {
  proxyReq.setHeader("x-forwarded-proto", "https");
  const origin = proxyReq.getHeader("origin");
  if (origin && origin.startsWith("http://")) {
    proxyReq.setHeader("origin", origin.replace(/^http:\/\//, "https://"));
  }
}

if (FORCE_HTTPS_PROTO) {
  proxy.on("proxyReq", rewriteHttpsHeaders);
  proxy.on("proxyReqWs", rewriteHttpsHeaders);
}

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {
    // ignore
  }
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Bind to "::" (dual-stack) so Railway private networking (IPv6) works.
const BIND_HOST = process.env.BIND_HOST ?? "::";
const server = app.listen(PORT, BIND_HOST, async () => {
  console.log(`[wrapper] listening on ${BIND_HOST}:${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  // Always persist gateway token to disk so CLI tools that read the file can authenticate.
  // resolveGatewayToken() only writes the file when auto-generating; if the token comes
  // from an env var (e.g. Railway Variables), no file is created, breaking CLI auth.
  try {
    const tokenPath = path.join(STATE_DIR, "gateway.token");
    fs.writeFileSync(tokenPath, OPENCLAW_GATEWAY_TOKEN, { encoding: "utf8", mode: 0o600 });
  } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Workspace bootstrap strategy:
  // 1. We pre-seed ONLY BOOTSTRAP.md with our custom version (more assertive
  //    onboarding: name the bot first, then learn who the user is).
  //    This is safe because OpenClaw's isBrandNewWorkspace check does NOT
  //    look at BOOTSTRAP.md — it only checks AGENTS/SOUL/TOOLS/IDENTITY/USER/HEARTBEAT.
  // 2. We do NOT pre-create any other workspace files — OpenClaw seeds those
  //    from its own stock templates on first message.
  // 3. Railway persistence rules are appended to AGENTS.md after OpenClaw creates it.
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  seedCustomBootstrap();
  appendRailwayPersistenceRules();

  // Optional operator hook to install/persist extra tools under /data.
  // This is intentionally best-effort and should be used to set up persistent
  // prefixes (npm/pnpm/python venv), not to mutate the base image.
  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
    try {
      await runCmd("bash", [bootstrapPath], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 10 * 60 * 1000,
      });
      console.log("[wrapper] bootstrap complete");
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
    }
  }

  // Ensure allowInsecureAuth is set for HTTP access (idempotent).
  if (isConfigured()) {
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]));
      console.log("[wrapper] ensured gateway.controlUi.allowInsecureAuth=true");
    } catch {}
  }

  // Ensure gateway remote config is set so CLI subcommands (pairing, devices) can auth with the gateway.
  if (isConfigured()) {
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.host", INTERNAL_GATEWAY_HOST]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.port", String(INTERNAL_GATEWAY_PORT)]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.token", OPENCLAW_GATEWAY_TOKEN]));
      // Ensure the gateway auth mode and token are set in config so CLI tools
      // can authenticate even without the --token flag (belt-and-suspenders).
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      console.log("[wrapper] ensured gateway remote connection config");
    } catch {}
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured()) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  // Rewrite Origin and proto headers directly on the incoming request so the
  // gateway sees a secure origin. http-proxy forwards req.headers as-is for WS.
  if (FORCE_HTTPS_PROTO) {
    req.headers["x-forwarded-proto"] = "https";
    if (req.headers.origin && req.headers.origin.startsWith("http://")) {
      req.headers.origin = req.headers.origin.replace(/^http:\/\//, "https://");
    }
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }

  // Stop accepting new connections; allow in-flight requests to complete briefly.
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }

  setTimeout(() => process.exit(0), 5_000).unref?.();
});
