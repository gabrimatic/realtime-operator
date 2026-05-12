#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

process.umask(0o077);

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 49376,
  dataDir: "~/.realtime-operator",
  workspaceRoot: "~",
  statePath: "~/.realtime-operator/state.json",
  logPath: "~/.realtime-operator/operator.log",
  transcriptPath: "~/.realtime-operator/transcript.jsonl",
  eventLogPath: "~/.realtime-operator/realtime-events.jsonl",
  accessTokenPath: "~/.realtime-operator/access-token",
  network: {
    publicHost: "",
    trustPrivateClients: false,
    trustTailnetClients: false,
    phoneAccessCodePath: "~/.realtime-operator/phone-code.secret.local",
  },
  openai: {
    apiKeyFile: "~/.realtime-operator/openai-api-key.secret.local",
    apiKeyEnv: "OPENAI_API_KEY",
    safetyIdentifierSeed: "realtime-operator-local",
  },
  realtime: {
    model: "gpt-realtime-2",
    voice: "marin",
    voiceStyle: "calm_operator",
    outputModalities: ["audio"],
    maxOutputTokens: "inf",
    reasoning: { effort: "xhigh" },
    tracing: { enabled: true, workflowName: "realtime_operator" },
    inputTranscription: {
      model: "gpt-4o-transcribe",
      prompt: "Expect natural spoken requests about local files, apps, commands, browser URLs, and system state.",
    },
    inputNoiseReduction: { type: "near_field" },
    turnDetection: {
      type: "semantic_vad",
      eagerness: "low",
      create_response: false,
      interrupt_response: true,
    },
  },
  system: {
    commandTimeoutMs: 60_000,
    maxConcurrentCommands: 1,
    allowedRoots: ["~"],
    allowOpenUrl: true,
    allowNotifications: true,
    allowClipboard: true,
  },
  safety: {
    requireConfirmationForRiskyTasks: true,
    maxCommandChars: 12_000,
    maxReplyChars: 12_000,
  },
  logging: {
    fullTranscript: true,
    technicalEvents: true,
    includeToolPayloads: false,
  },
};

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return join(HOME, value.slice(2));
  return value;
}

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? merge(base[key] || {}, value)
        : value;
  }
  return out;
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeConfig(raw) {
  const cfg = structuredClone(raw);
  for (const key of ["dataDir", "workspaceRoot", "statePath", "logPath", "transcriptPath", "eventLogPath", "accessTokenPath"]) {
    cfg[key] = expandHome(cfg[key]);
  }
  cfg.network.phoneAccessCodePath = expandHome(cfg.network.phoneAccessCodePath);
  cfg.openai.apiKeyFile = expandHome(cfg.openai.apiKeyFile);
  cfg.system.allowedRoots = (cfg.system.allowedRoots || ["~"]).map(expandHome);
  return cfg;
}

const defaultConfigPath = join(HOME, ".realtime-operator", "config.json");
const configPath = process.env.REALTIME_OPERATOR_CONFIG || defaultConfigPath;
const config = normalizeConfig(merge(DEFAULT_CONFIG, loadJson(expandHome(configPath), {})));

for (const path of [
  config.statePath,
  config.logPath,
  config.transcriptPath,
  config.eventLogPath,
  config.accessTokenPath,
  config.network.phoneAccessCodePath,
]) {
  mkdirSync(dirname(path), { recursive: true });
}

let activeCommands = 0;
const pendingConfirmations = new Map();
const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function redact(text) {
  return String(text || "")
    .replace(/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, "[redacted-openai-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-openai-key]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-google-api-key]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, "$1[redacted]")
    .replace(/([A-Za-z0-9_.-]*(?:api[_-]?key|token|password|secret|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s"']+)/gi, "$1[redacted]");
}

function redactForLog(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactForLog);
  if (typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /api[_-]?key|authorization|token|secret|password|credential|client_secret|phone[_-]?code/i.test(key)
        ? "[redacted]"
        : redactForLog(inner);
    }
    return out;
  }
  return value;
}

function appendJsonl(path, payload) {
  appendFileSync(path, `${JSON.stringify(redactForLog(payload))}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function logEvent(kind, fields = {}) {
  appendJsonl(config.logPath, { ts: new Date().toISOString(), kind, ...fields });
}

function logTranscript(fields = {}) {
  if (!config.logging.fullTranscript) return;
  appendJsonl(config.transcriptPath, { ts: new Date().toISOString(), ...fields });
}

function logTechnicalEvent(fields = {}) {
  if (!config.logging.technicalEvents) return;
  appendJsonl(config.eventLogPath, { ts: new Date().toISOString(), ...fields });
}

function trimReply(text) {
  const limit = Number(config.safety.maxReplyChars || 12_000);
  const value = redact(String(text || "").trim());
  return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[truncated]`;
}

function readBody(req, maxBytes = 2_000_000) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function ok(res, data = {}, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: true, ...data }));
}

function fail(res, status, message, extra = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error: message, ...extra }));
}

function html(res, body) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function safeCompare(a, b) {
  const ah = createHash("sha256").update(String(a || "")).digest();
  const bh = createHash("sha256").update(String(b || "")).digest();
  return timingSafeEqual(ah, bh);
}

function getOrCreateAccessToken() {
  const envToken = process.env.REALTIME_OPERATOR_TOKEN || config.accessToken;
  if (envToken) return String(envToken).trim();
  if (existsSync(config.accessTokenPath)) return readFileSync(config.accessTokenPath, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(config.accessTokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(config.accessTokenPath, 0o600);
  return token;
}

const accessToken = getOrCreateAccessToken();

function getOrCreatePhoneAccessCode() {
  const path = config.network.phoneAccessCodePath;
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  const code = randomBytes(8).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase();
  writeFileSync(path, `${code}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return code;
}

const phoneAccessCode = getOrCreatePhoneAccessCode();

function cookieValue(req, name) {
  const cookie = String(req.headers.cookie || "");
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("=") || "");
  }
  return "";
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function requestTokens(req) {
  return [
    headerValue(req.headers["x-realtime-operator-token"]),
    headerValue(req.headers.authorization)?.replace(/^Bearer\s+/i, ""),
    cookieValue(req, "realtime_operator_token"),
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function isLocalRequest(req) {
  const host = String(req.headers.host || "").split(":")[0];
  const remote = String(req.socket.remoteAddress || "");
  return ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"].includes(host) &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
}

function remoteIpv4(req) {
  const remote = String(req.socket.remoteAddress || "");
  return remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
}

function ipv4Parts(ip) {
  const parts = String(ip || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function isPrivateIpv4(ip) {
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function isSharedAddressIpv4(ip) {
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

function networkAddressKind(ip) {
  const value = String(ip || "").toLowerCase();
  if (!value) return "unknown";
  if (value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1") return "localhost";
  if (isSharedAddressIpv4(value)) return "shared-100.64";
  if (isPrivateIpv4(value) || value.startsWith("fd") || value.startsWith("fc") || value.startsWith("fe80:")) return "private-lan";
  return "public";
}

function networkTrustDecision(remoteAddress) {
  const remote = String(remoteAddress || "");
  const ip = remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
  const kind = networkAddressKind(ip);
  const local = kind === "localhost";
  const lan = kind === "private-lan";
  const shared = kind === "shared-100.64";
  const privateTrustEnabled = config.network.trustPrivateClients === true;
  const tailnetTrustEnabled = config.network.trustTailnetClients === true;
  return {
    remote,
    ip,
    kind,
    trusted: local || (privateTrustEnabled && (lan || (shared && tailnetTrustEnabled))),
    local,
    privateLan: lan,
    shared10064: shared,
    trustPrivateClients: privateTrustEnabled,
    trustTailnetClients: tailnetTrustEnabled,
    requiresPairing: !(local || (privateTrustEnabled && (lan || (shared && tailnetTrustEnabled)))),
  };
}

function isTrustedNetworkRequest(req) {
  if (isLocalRequest(req)) return true;
  return networkTrustDecision(remoteIpv4(req)).trusted;
}

function requireToken(req) {
  if (isTrustedNetworkRequest(req)) return true;
  return requestTokens(req).some((token) => safeCompare(token, accessToken));
}

function localNetworkEntries() {
  const addresses = [];
  const seen = new Set();
  for (const [name, values] of Object.entries(networkInterfaces())) {
    for (const value of values || []) {
      if (value.family !== "IPv4" || value.internal || value.address.startsWith("169.254.")) continue;
      if (seen.has(value.address)) continue;
      seen.add(value.address);
      const trust = networkTrustDecision(value.address);
      addresses.push({ name, address: value.address, kind: trust.kind, trustedWithoutPairing: trust.trusted });
    }
  }
  return addresses;
}

function preferredLanAddress() {
  return localNetworkEntries()[0]?.address || "127.0.0.1";
}

function preferredLanHost() {
  const configured = String(config.network.publicHost || "").trim();
  return configured && configured !== "0.0.0.0" ? configured : preferredLanAddress();
}

function phoneUrls() {
  const host = preferredLanHost();
  return {
    httpUrl: `http://${host}:${config.port}/`,
    micCompatibleUrl: `http://${host}:${config.port}/`,
  };
}

function mobilePreflight(req) {
  const remoteTrust = networkTrustDecision(remoteIpv4(req));
  const authenticated = requireToken(req);
  return {
    status: "ok",
    authenticated,
    trustedNetwork: isTrustedNetworkRequest(req),
    remoteTrust,
    localAuth: isLocalRequest(req),
    remote: req.socket.remoteAddress || "",
    host: String(req.headers.host || ""),
    httpsReady: false,
    httpsEnabled: false,
    phonePairingRequired: !authenticated,
    staleTokenDetected: requestTokens(req).length > 0 && !authenticated,
    advice: authenticated ? "ready" : remoteTrust.shared10064 ? "pair over Tailscale" : "pair to continue",
    ...phoneUrls(),
  };
}

function confirmationFingerprint(kind, riskText) {
  return createHash("sha256").update(`${kind}\0${riskText}`).digest("hex");
}

function pruneConfirmations() {
  const now = Date.now();
  for (const [id, confirmation] of pendingConfirmations.entries()) {
    if (!confirmation || confirmation.expiresAt <= now) pendingConfirmations.delete(id);
  }
}

function takeConfirmation(args = {}, kind = "", riskText = "") {
  if (args.confirmed !== true) return false;
  pruneConfirmations();
  const id = String(args.confirmation_id || args.confirmationId || "").trim();
  const confirmation = id ? pendingConfirmations.get(id) : null;
  if (!confirmation) return false;
  if (confirmation.fingerprint !== confirmationFingerprint(kind, riskText)) return false;
  pendingConfirmations.delete(id);
  return true;
}

function confirmationRequired({ args = {}, kind = "", riskText = "", reason = "", prompt = "", extra = {} } = {}) {
  if (takeConfirmation(args, kind, riskText)) return null;
  pruneConfirmations();
  const confirmationId = randomUUID();
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  pendingConfirmations.set(confirmationId, {
    kind,
    fingerprint: confirmationFingerprint(kind, riskText),
    expiresAt,
  });
  return {
    status: "approval_required",
    reason,
    prompt,
    confirmationId,
    confirmationExpiresAt: new Date(expiresAt).toISOString(),
    ...extra,
  };
}

function classifyRisk(text) {
  const value = String(text || "").toLowerCase();
  const patterns = [
    /\brm\s+-rf\b/,
    /\b(rm|rmdir|unlink|trash|srm)\b/,
    /\bdelete\b|\bremove\b|\bwipe\b|\berase\b|\bdestroy\b/,
    /\bgit\s+(push|reset|clean|rebase|checkout|branch\s+-d|branch\s+-D)\b/,
    /\bcommit\b|\bmerge\b|\brelease\b|\bdeploy\b|\bpublish\b/,
    /\bsend\b.*\b(email|message|dm|sms|imessage|slack|telegram)\b/,
    /\bbuy\b|\bpurchase\b|\border\b|\bpay\b|\bpayment\b|\brefund\b/,
    /\bsecret\b|\btoken\b|\bapi key\b|\bpassword\b|\bcredential\b/,
    /\bsudo\b|\bchmod\b|\bchown\b|\blaunchctl\b|\bpfctl\b|\bsecurity\s+(delete|unlock|set|add|import)\b/,
    /\b(killall|pkill|kill\s+-9|shutdown|reboot|halt)\b/,
    /\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/,
  ];
  return patterns.some((pattern) => pattern.test(value))
    ? { risky: true, reason: "This may change files, publish something, send a message, affect money, expose credentials, or alter system state." }
    : { risky: false, reason: "" };
}

function resolveRealPath(path) {
  const candidate = resolve(path || config.workspaceRoot);
  if (existsSync(candidate)) return realpathSync(candidate);
  const missing = [];
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return candidate;
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

function isPathInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function validateRoot(path) {
  const candidate = resolve(expandHome(path || config.workspaceRoot));
  const realCandidate = resolveRealPath(candidate);
  const allowedRoots = (config.system.allowedRoots || [HOME]).map((root) => {
    const logical = resolve(expandHome(root));
    return { logical, real: resolveRealPath(logical) };
  });
  const allowed = allowedRoots.some((root) =>
    (isPathInside(candidate, root.logical) || isPathInside(candidate, root.real)) &&
      (isPathInside(realCandidate, root.real) || isPathInside(realCandidate, root.logical)),
  );
  if (!allowed) throw new Error(`Path is outside allowed roots: ${candidate}`);
  return candidate;
}

function isSensitiveLocalPath(path) {
  const value = String(path || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(secrets?|\.ssh|\.gnupg|keychains?|cookies?|passwords?)(\/|$)/.test(value) ||
    /(^|\/)(\.aws|\.azure|\.config\/gh|credentials?)(\/|$)/.test(value) ||
    /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|id_ecdsa)(\/|$)/.test(value) ||
    /\.(pem|key|p12|pfx|sqlite|db|kdbx)$/i.test(value) ||
    /(api[_-]?key|token|secret|password|credential|auth|private[_-]?key)/i.test(value);
}

function publicFileInfo(path) {
  const stat = statSync(path);
  return {
    path,
    type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
    size: stat.size,
    mode: stat.mode.toString(8).slice(-4),
    modifiedAt: stat.mtime.toISOString(),
    sensitivePath: isSensitiveLocalPath(path),
  };
}

function spawnPromise(file, args = [], options = {}) {
  return new Promise((resolveExec) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = Number(options.maxBuffer || 4 * 1024 * 1024);
    const timeoutMs = Number(options.timeout || 30_000);
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, timeoutMs);
    const collect = (target, chunk) => {
      const next = target + chunk.toString();
      return next.length > maxBuffer ? next.slice(-maxBuffer) : next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExec({ ok: false, code: error.code || 1, signal: "", stdout: trimReply(stdout), stderr: trimReply(stderr), message: trimReply(error.message), durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timedOut = signal === "SIGTERM" && Date.now() - started >= timeoutMs - 50;
      resolveExec({
        ok: code === 0 && !timedOut,
        code: code ?? 0,
        signal: signal || "",
        stdout: trimReply(stdout),
        stderr: trimReply(stderr),
        message: timedOut ? `Command timed out after ${timeoutMs}ms.` : "",
        durationMs: Date.now() - started,
      });
    });
    if (options.stdin !== undefined && options.stdin !== null) child.stdin.end(String(options.stdin));
    else child.stdin.end();
  });
}

function localShellSpec(command) {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  const name = basename(shell);
  return /^(zsh|bash)$/.test(name) ? { shell, args: ["-lc", command] } : { shell, args: ["-c", command] };
}

function normalizeArgv(argv) {
  return Array.isArray(argv) ? argv.map((part) => String(part)).filter(Boolean) : [];
}

function commandSpec(args = {}) {
  const argv = normalizeArgv(args.argv);
  const script = String(args.script || "");
  const command = String(args.command || "");
  const supplied = [argv.length ? "argv" : "", script.trim() ? "script" : "", command.trim() ? "command" : ""].filter(Boolean);
  if (supplied.length !== 1) throw new Error("Provide exactly one of argv, script, or command.");
  if (argv.length) {
    return { mode: "argv", riskText: argv.join(" "), preview: argv.join(" ").slice(0, 240), run: (options) => spawnPromise(argv[0], argv.slice(1), options) };
  }
  const spec = localShellSpec(script.trim() ? script : command);
  return {
    mode: script.trim() ? "script" : "command",
    riskText: script.trim() ? script : command,
    preview: (script.trim() ? script : command).replace(/\s+/g, " ").trim().slice(0, 240),
    run: (options) => spawnPromise(spec.shell, spec.args, options),
  };
}

async function runCommandTool(args = {}) {
  if (activeCommands >= Number(config.system.maxConcurrentCommands || 1)) {
    return { status: "busy", message: "A local command is already running." };
  }
  const cwd = validateRoot(args.working_directory || args.cwd || config.workspaceRoot);
  const timeout = Math.min(Math.max(Number(args.timeout_ms) || Number(config.system.commandTimeoutMs || 60_000), 1_000), 300_000);
  const spec = commandSpec(args);
  if (spec.riskText.length > Number(config.safety.maxCommandChars || 12_000)) throw new Error("Command is too long.");
  const risk = classifyRisk(spec.riskText);
  if (config.safety.requireConfirmationForRiskyTasks && risk.risky) {
    const challenge = confirmationRequired({
      args,
      kind: "run_command",
      riskText: spec.riskText,
      reason: risk.reason,
      prompt: "This command may change files, reveal sensitive information, or affect the machine. Please confirm before it runs.",
      extra: { cwd, preview: spec.preview },
    });
    if (challenge) return challenge;
  }
  activeCommands += 1;
  try {
    const result = await spec.run({ cwd, timeout, stdin: args.stdin, maxBuffer: args.max_buffer || 4 * 1024 * 1024 });
    logEvent("command_finished", { mode: spec.mode, cwd, preview: spec.preview, ok: result.ok, code: result.code });
    return { status: result.ok ? "ok" : "error", cwd, timeout, mode: spec.mode, preview: spec.preview, result };
  } finally {
    activeCommands -= 1;
  }
}

function listDirectoryTool(args = {}) {
  const root = validateRoot(args.path || args.directory || config.workspaceRoot);
  const maxEntries = Math.min(Math.max(Number(args.max_entries) || 80, 1), 300);
  const includeHidden = Boolean(args.include_hidden);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => includeHidden || !entry.name.startsWith("."))
    .slice(0, maxEntries)
    .map((entry) => {
      const path = join(root, entry.name);
      let stat = null;
      try { stat = statSync(path); } catch {}
      return {
        name: entry.name,
        path,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        size: stat?.size ?? null,
        modifiedAt: stat?.mtime ? stat.mtime.toISOString() : "",
        sensitivePath: isSensitiveLocalPath(path),
      };
    });
  return { status: "ok", path: root, entries, truncated: entries.length >= maxEntries };
}

function readTextFileTool(args = {}) {
  const path = validateRoot(args.path || args.file || "");
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 12_000, 100), 80_000);
  if (isSensitiveLocalPath(path)) {
    const challenge = confirmationRequired({
      args,
      kind: "read_text_file:sensitive",
      riskText: path,
      reason: "This path looks like it may contain secrets or credentials.",
      prompt: "Please confirm before reading this sensitive-looking file.",
      extra: { path },
    });
    if (challenge) return challenge;
  }
  const info = publicFileInfo(path);
  if (info.type !== "file") return { status: "error", error: "Path is not a regular file.", file: info };
  if (info.size > 5 * 1024 * 1024) {
    const challenge = confirmationRequired({
      args,
      kind: "read_text_file:large",
      riskText: `${path}:${info.size}`,
      reason: "The file is large.",
      prompt: "Please confirm before reading this large file.",
      extra: { file: info },
    });
    if (challenge) return challenge;
  }
  const text = readFileSync(path, "utf8");
  const redacted = redact(text);
  return { status: "ok", file: info, text: redacted.slice(0, maxChars), truncated: redacted.length > maxChars };
}

function simpleGlobMatches(path, glob) {
  const pattern = String(glob || "").trim();
  if (!pattern) return true;
  const name = basename(path);
  if (/^\*\.[A-Za-z0-9_.-]+$/.test(pattern)) return name.endsWith(pattern.slice(1));
  if (!pattern.includes("*")) return name === pattern || path.endsWith(`/${pattern}`);
  const escaped = pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name) || new RegExp(`${escaped}$`).test(path);
}

function searchFilesFallback(root, query, args = {}) {
  const maxResults = Math.min(Math.max(Number(args.max_results) || 80, 1), 300);
  const fixed = args.fixed_strings !== false;
  const matcher = fixed
    ? (line) => line.includes(query)
    : (line) => {
        try {
          return new RegExp(query).test(line);
        } catch {
          return line.includes(query);
        }
      };
  const results = [];
  const stack = [root];
  const ignoredDirs = new Set([".git", "node_modules", "test-results", "playwright-report"]);
  while (stack.length && results.length < maxResults) {
    const current = stack.pop();
    let stat;
    try { stat = statSync(current); } catch { continue; }
    if (isSensitiveLocalPath(current)) continue;
    if (stat.isDirectory()) {
      let entries = [];
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.reverse()) {
        if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
        stack.push(join(current, entry.name));
      }
      continue;
    }
    if (!stat.isFile() || stat.size > 1024 * 1024 || !simpleGlobMatches(current, args.glob)) continue;
    let text = "";
    try { text = readFileSync(current, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
      if (matcher(lines[index])) {
        results.push({ path: current, line: index + 1, text: redact(lines[index]).slice(0, 1000) });
      }
    }
  }
  return results;
}

async function searchFilesTool(args = {}) {
  const root = validateRoot(args.path || args.directory || config.workspaceRoot);
  const query = String(args.query || args.pattern || "").trim();
  if (!query) return { status: "error", error: "Missing search query." };
  const maxResults = Math.min(Math.max(Number(args.max_results) || 80, 1), 300);
  const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(maxResults)];
  if (args.fixed_strings !== false) rgArgs.push("--fixed-strings");
  if (args.glob) rgArgs.push("--glob", String(args.glob));
  rgArgs.push(query, root);
  const out = await spawnPromise("rg", rgArgs, { cwd: root, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  const fallbackResults = !out.ok && /ENOENT|not found|spawn rg/i.test(`${out.message} ${out.stderr}`)
    ? searchFilesFallback(root, query, args)
    : [];
  const lines = String(out.stdout || "")
    .split("\n")
    .filter(Boolean)
    .slice(0, maxResults)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      return match ? { path: match[1], line: Number(match[2]), text: redact(match[3]).slice(0, 1000) } : { path: "", line: 0, text: redact(line) };
    })
    .filter((entry) => entry.path && !isSensitiveLocalPath(entry.path) && simpleGlobMatches(entry.path, args.glob));
  const results = fallbackResults.length ? fallbackResults : lines;
  return {
    status: out.ok || results.length ? "ok" : "error",
    query,
    path: root,
    results,
    stderr: out.stderr,
    message: out.message,
    searchBackend: fallbackResults.length ? "node" : "rg",
    truncated: results.length >= maxResults,
  };
}

async function systemStatusTool() {
  const commands = [
    ["hostname", []],
    ["uptime", []],
    ["df", ["-h", "/"]],
    ["date", []],
  ];
  const results = {};
  await Promise.all(commands.map(async ([name, args]) => {
    results[name] = await spawnPromise(name, args, { timeout: 10_000, maxBuffer: 512 * 1024 });
  }));
  return {
    status: "ok",
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    date: results.date.stdout,
    hostname: results.hostname.stdout,
    uptime: results.uptime.stdout,
    disk: results.df.stdout,
    activeCommands,
  };
}

async function fetchUrlTool(args = {}) {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return { status: "error", error: "URL must start with http:// or https://." };
  const method = String(args.method || "GET").toUpperCase();
  const risky = !["GET", "HEAD"].includes(method) || JSON.stringify(args.headers || {}).match(/authorization|cookie|token|secret/i);
  if (risky) {
    const challenge = confirmationRequired({
      args,
      kind: "fetch_url",
      riskText: `${method}:${url}:${JSON.stringify(args.headers || {})}:${String(args.body || "")}`,
      reason: "This HTTP request may change state or include sensitive headers.",
      prompt: "Please confirm before sending this request.",
      extra: { method, url },
    });
    if (challenge) return challenge;
  }
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 15_000, 1_000), 60_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: args.headers && typeof args.headers === "object" ? args.headers : undefined,
      body: args.body !== undefined && !["GET", "HEAD"].includes(method) ? String(args.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const maxChars = Math.min(Math.max(Number(args.max_chars) || 12_000, 100), 80_000);
    return {
      status: "ok",
      url,
      method,
      httpStatus: response.status,
      responseOk: response.ok,
      headers: Object.fromEntries(Array.from(response.headers.entries()).filter(([key]) => !/set-cookie|authorization|token|secret/i.test(key))),
      body: redact(text).slice(0, maxChars),
      truncated: text.length > maxChars,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function openUrlTool(args = {}) {
  if (!config.system.allowOpenUrl) return { status: "error", error: "Opening URLs is disabled in config." };
  const target = String(args.url || args.path || "").trim();
  if (!target) return { status: "error", error: "Missing URL or path." };
  const value = /^https?:\/\//i.test(target) ? target : validateRoot(target);
  const out = await spawnPromise("open", [value], { timeout: 10_000, maxBuffer: 256 * 1024 });
  return { status: out.ok ? "ok" : "error", target: value, stderr: out.stderr };
}

async function showNotificationTool(args = {}) {
  if (!config.system.allowNotifications) return { status: "error", error: "Notifications are disabled in config." };
  if (platform() !== "darwin") return { status: "error", error: "Notifications are currently implemented for macOS." };
  const title = String(args.title || "Realtime Operator").replace(/"/g, "'").slice(0, 120);
  const message = String(args.message || args.body || "").replace(/"/g, "'").slice(0, 300);
  if (!message) return { status: "error", error: "Missing notification message." };
  const out = await spawnPromise("osascript", ["-e", `display notification "${message}" with title "${title}"`], { timeout: 10_000, maxBuffer: 256 * 1024 });
  return { status: out.ok ? "ok" : "error", title, message, stderr: out.stderr };
}

async function getClipboardTextTool(args = {}) {
  if (!config.system.allowClipboard) return { status: "error", error: "Clipboard tools are disabled in config." };
  const challenge = confirmationRequired({
    args,
    kind: "get_clipboard_text",
    riskText: "clipboard:read",
    reason: "Clipboard contents may contain private text or credentials.",
    prompt: "Please confirm before reading the clipboard.",
  });
  if (challenge) return challenge;
  const out = await spawnPromise("pbpaste", [], { timeout: 10_000, maxBuffer: 512 * 1024 });
  return { status: out.ok ? "ok" : "error", text: redact(out.stdout).slice(0, 12_000), truncated: out.stdout.length > 12_000 };
}

async function setClipboardTextTool(args = {}) {
  if (!config.system.allowClipboard) return { status: "error", error: "Clipboard tools are disabled in config." };
  const text = String(args.text || "");
  const challenge = confirmationRequired({
    args,
    kind: "set_clipboard_text",
    riskText: `clipboard:write:${createHash("sha256").update(text).digest("hex")}`,
    reason: "Setting the clipboard changes local user state.",
    prompt: "Please confirm before replacing the clipboard.",
  });
  if (challenge) return challenge;
  const out = await spawnPromise("pbcopy", [], { stdin: text, timeout: 10_000, maxBuffer: 256 * 1024 });
  return { status: out.ok ? "ok" : "error", length: text.length, stderr: out.stderr };
}

function operatorDiscovery() {
  return {
    generatedAt: new Date().toISOString(),
    product: "Realtime Operator",
    contract:
      "A browser microphone connects to OpenAI Realtime over WebRTC. The model can call this local server's function tools to inspect and control the user's own machine.",
    capabilities: {
      realtimeConversation: {
        model: config.realtime.model,
        voice: config.realtime.voice,
        voiceStyle: config.realtime.voiceStyle,
        outputModalities: config.realtime.outputModalities,
        reasoning: config.realtime.reasoning,
        transport: "webrtc",
      },
      localTools: toolSchemas().map((tool) => ({ name: tool.name, description: tool.description })),
      allowedRoots: config.system.allowedRoots,
      networkTrust: {
        trustPrivateClients: config.network.trustPrivateClients === true,
        trustTailnetClients: config.network.trustTailnetClients === true,
        localNetworks: localNetworkEntries(),
      },
      logging: {
        transcriptPath: config.transcriptPath,
        eventLogPath: config.eventLogPath,
        fullTranscript: Boolean(config.logging.fullTranscript),
        technicalEvents: Boolean(config.logging.technicalEvents),
      },
    },
  };
}

function toolSchemas() {
  return [
    {
      type: "function",
      name: "discover_operator_capabilities",
      description: "Refresh the live map of Realtime settings, local tools, allowed roots, logging, and network trust.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "get_system_status",
      description: "Inspect local system basics such as date, hostname, uptime, disk, platform, and active command count.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "run_command",
      description: "Run a bounded local command with argv, script, or shell command. Risky commands require explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          argv: { type: "array", items: { type: "string" }, description: "Exact command and arguments, preferred when possible." },
          script: { type: "string", description: "Multiline shell script." },
          command: { type: "string", description: "Single shell command string." },
          stdin: { type: "string", description: "Optional stdin." },
          working_directory: { type: "string", description: "Allowed local working directory." },
          timeout_ms: { type: "number", description: "Optional timeout in milliseconds." },
          confirmed: { type: "boolean", description: "Set true only after the user confirms a risky command." },
          confirmation_id: { type: "string", description: "Confirmation id returned by approval_required." },
        },
      },
    },
    {
      type: "function",
      name: "list_directory",
      description: "List files and folders under an allowed local root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_entries: { type: "number" },
          include_hidden: { type: "boolean" },
        },
      },
    },
    {
      type: "function",
      name: "get_file_info",
      description: "Return metadata for an allowed local file or directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      type: "function",
      name: "read_text_file",
      description: "Read a bounded local text file under an allowed root. Sensitive-looking paths require confirmation and output is redacted.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_chars: { type: "number" },
          confirmed: { type: "boolean" },
          confirmation_id: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      type: "function",
      name: "search_files",
      description: "Search allowed local files with ripgrep and bounded redacted output.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          query: { type: "string" },
          glob: { type: "string" },
          max_results: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "fetch_url",
      description: "Fetch a URL with a bounded response body. Non-GET requests and sensitive headers require confirmation.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string" },
          headers: { type: "object" },
          body: { type: "string" },
          max_chars: { type: "number" },
          confirmed: { type: "boolean" },
          confirmation_id: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      type: "function",
      name: "open_url",
      description: "Open a URL or allowed local file path on the user's machine.",
      parameters: { type: "object", properties: { url: { type: "string" }, path: { type: "string" } } },
    },
    {
      type: "function",
      name: "show_notification",
      description: "Show a local macOS notification.",
      parameters: { type: "object", properties: { title: { type: "string" }, message: { type: "string" } }, required: ["message"] },
    },
    {
      type: "function",
      name: "get_clipboard_text",
      description: "Read the clipboard after explicit confirmation, with secret redaction.",
      parameters: { type: "object", properties: { confirmed: { type: "boolean" }, confirmation_id: { type: "string" } } },
    },
    {
      type: "function",
      name: "set_clipboard_text",
      description: "Set the clipboard after explicit confirmation.",
      parameters: { type: "object", properties: { text: { type: "string" }, confirmed: { type: "boolean" }, confirmation_id: { type: "string" } }, required: ["text"] },
    },
  ];
}

async function handleToolCall(payload) {
  const tool = String(payload.tool || payload.name || "");
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  if (tool === "discover_operator_capabilities") return { status: "ok", discovery: operatorDiscovery() };
  if (tool === "get_system_status") return await systemStatusTool();
  if (tool === "run_command") return await runCommandTool(args);
  if (tool === "list_directory") return listDirectoryTool(args);
  if (tool === "get_file_info") return { status: "ok", file: publicFileInfo(validateRoot(args.path || "")) };
  if (tool === "read_text_file") return readTextFileTool(args);
  if (tool === "search_files") return await searchFilesTool(args);
  if (tool === "fetch_url") return await fetchUrlTool(args);
  if (tool === "open_url") return await openUrlTool(args);
  if (tool === "show_notification") return await showNotificationTool(args);
  if (tool === "get_clipboard_text") return await getClipboardTextTool(args);
  if (tool === "set_clipboard_text") return await setClipboardTextTool(args);
  return { status: "error", error: `Unknown tool: ${tool}` };
}

function normalizeVoice(value) {
  const voice = String(value || config.realtime.voice || "marin").trim().toLowerCase();
  const supported = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
  return supported.has(voice) ? voice : "marin";
}

function voiceStyleInstructions(style) {
  if (style === "fast_hands_free") return "Speak quickly and keep responses short. Prioritize action over explanation.";
  if (style === "focused_operator") return "Use a precise operator voice. Confirm actions, name blockers, and avoid chatter.";
  return "Use a calm, warm operator voice. Be brief, practical, and clear.";
}

function realtimeTracingConfig() {
  const tracing = config.realtime.tracing;
  if (tracing === "auto") return "auto";
  if (!tracing || tracing.enabled === false) return undefined;
  return {
    workflow_name: String(tracing.workflow_name || tracing.workflowName || "realtime_operator"),
    metadata: { app: "realtime-operator" },
  };
}

function readOpenAiApiKey() {
  const keyFromFile = config.openai.apiKeyFile && existsSync(config.openai.apiKeyFile)
    ? readFileSync(config.openai.apiKeyFile, "utf8").trim()
    : "";
  const keyFromEnv = process.env[config.openai.apiKeyEnv || "OPENAI_API_KEY"] || "";
  const key = keyFromFile || keyFromEnv.trim();
  if (!key) throw new Error("OpenAI API key is not configured. Set OPENAI_API_KEY or openai.apiKeyFile.");
  return key;
}

function safetyIdentifier() {
  return createHash("sha256").update(config.openai.safetyIdentifierSeed || "realtime-operator-local").digest("hex").slice(0, 48);
}

async function createRealtimeClientSecret(options = {}) {
  const apiKey = readOpenAiApiKey();
  const voice = normalizeVoice(options.voice);
  const voiceStyle = String(options.voiceStyle || config.realtime.voiceStyle || "calm_operator");
  const discovery = operatorDiscovery();
  const session = {
    type: "realtime",
    model: config.realtime.model,
    output_modalities: Array.isArray(config.realtime.outputModalities) ? config.realtime.outputModalities : ["audio"],
    max_output_tokens: config.realtime.maxOutputTokens || "inf",
    reasoning: config.realtime.reasoning,
    instructions: [
      "You are Realtime Operator, a local voice agent for the user's own computer.",
      `This conversation uses the OpenAI Realtime model ${config.realtime.model} over WebRTC.`,
      "Your job is to understand spoken requests, call local function tools when useful, and speak back clearly.",
      "The local tools are your hands. Use them for system status, bounded commands, file inspection, search, URL fetches, opening URLs or files, notifications, and clipboard operations.",
      "Do not claim access to tools that are not listed. Do not claim image, vision, or screenshot access.",
      "If a tool returns approval_required, ask the user for a clear yes before retrying with confirmed=true and the confirmation_id.",
      "Never read or speak secrets, tokens, credentials, or private data. Tool output is redacted, and sensitive paths require confirmation.",
      "Use argv for exact commands when possible. Use shell command strings only when shell syntax is actually needed.",
      "Long silence is normal. Answer only after meaningful committed speech, typed input, or a tool result.",
      voiceStyleInstructions(voiceStyle),
      `Discovery snapshot: ${JSON.stringify(redactForLog(discovery))}`,
    ].join(" "),
    audio: {
      input: {
        transcription: config.realtime.inputTranscription,
        noise_reduction: config.realtime.inputNoiseReduction,
      },
      output: { voice },
    },
    tools: toolSchemas(),
    tool_choice: "auto",
  };
  const tracing = realtimeTracingConfig();
  if (tracing !== undefined) session.tracing = tracing;
  if (config.realtime.turnDetection) session.audio.input.turn_detection = config.realtime.turnDetection;

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier(),
    },
    body: JSON.stringify({ session }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error?.message || text || `OpenAI Realtime token request failed (${response.status})`);
  return { data, voice, voiceStyle };
}

function indexPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Realtime Operator</title>
<style>
:root { color-scheme: dark; --bg:#0c0f14; --panel:#151a22; --panel2:#10151d; --text:#f3f6fb; --muted:#9da9b8; --line:#283241; --accent:#45c4b0; --warn:#ffce5c; --bad:#ff6b6b; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; background:radial-gradient(circle at top left, #193142, transparent 32rem), var(--bg); color:var(--text); font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
button, textarea, select { font:inherit; }
button { border:1px solid var(--line); background:#202938; color:var(--text); min-height:42px; padding:0 14px; border-radius:8px; cursor:pointer; }
button:hover { border-color:#4d5d71; }
button:disabled { opacity:.45; cursor:not-allowed; }
button.primary { background:var(--accent); color:#061210; border-color:transparent; font-weight:700; }
button.danger { background:#341b22; color:#ffd5dd; }
textarea { width:100%; min-height:84px; resize:vertical; border:1px solid var(--line); background:#0b1017; color:var(--text); border-radius:8px; padding:12px; }
select { border:1px solid var(--line); background:#0b1017; color:var(--text); border-radius:8px; min-height:42px; padding:0 10px; }
.shell { display:grid; grid-template-columns:280px minmax(0,1fr); min-height:100vh; }
.rail { border-right:1px solid var(--line); background:rgba(12,15,20,.86); padding:20px; }
.main { padding:32px; display:grid; grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr); gap:24px; align-content:start; }
.brand { display:flex; align-items:center; gap:10px; margin-bottom:28px; }
.mark { width:34px; height:34px; border-radius:8px; background:linear-gradient(135deg,#45c4b0,#7aa2ff); }
.eyebrow { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
h1 { font-size:48px; line-height:1.02; margin:8px 0 14px; letter-spacing:0; max-width:720px; }
h2 { font-size:18px; margin:0 0 12px; }
p { color:var(--muted); margin:0; max-width:740px; }
.panel { background:rgba(21,26,34,.88); border:1px solid var(--line); border-radius:8px; padding:18px; }
.hero { grid-column:1 / -1; padding:8px 0 0; }
.controls { display:flex; flex-wrap:wrap; gap:10px; margin-top:20px; }
.statusbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:18px 0; color:var(--muted); }
.live { color:var(--accent); font-weight:700; }
.grid { display:grid; gap:14px; }
.button-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.log { height:360px; overflow:auto; white-space:pre-wrap; background:#070b10; border:1px solid var(--line); border-radius:8px; padding:12px; color:#d8e3ee; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.muted { color:var(--muted); }
.mobile-menu, .close-menu { display:none; }
@media (max-width: 860px) {
  .shell { display:block; }
  .mobile-menu { display:inline-flex; position:fixed; z-index:4; top:12px; right:12px; }
  .rail { display:none; position:fixed; z-index:5; inset:0 auto 0 0; width:min(84vw,320px); }
  body.dock-open .rail { display:block; }
  .close-menu { display:inline-flex; width:100%; margin-bottom:16px; }
  .main { padding:64px 16px 24px; grid-template-columns:1fr; }
  h1 { font-size:36px; }
  .button-grid { grid-template-columns:1fr; }
}
</style>
</head>
<body>
<button class="mobile-menu" id="toggleMenu" type="button">Menu</button>
<div class="shell">
  <aside class="rail" id="rail">
    <button class="close-menu" id="closeMenu" type="button" aria-label="Close menu">Close</button>
    <div class="brand"><div class="mark"></div><div><strong>Realtime Operator</strong><div class="muted">OpenAI Realtime + local tools</div></div></div>
    <div class="grid">
      <button id="toolStatus" type="button">System Status</button>
      <button id="toolList" type="button">List Workspace</button>
      <button id="phonePanel" type="button">Phone</button>
      <button id="clearLog" type="button">Clear Log</button>
    </div>
  </aside>
  <main class="main">
    <section class="hero">
      <div class="eyebrow">OpenAI Realtime API</div>
      <h1>Talk. The operator acts.</h1>
      <p>Speak to a live Realtime model, then let it call local function tools for the pieces that need your own machine.</p>
      <div class="controls">
        <button class="primary" id="connect" type="button">Start Talking</button>
        <button id="muteMic" type="button" disabled aria-pressed="false">Mute</button>
        <button class="danger" id="disconnect" type="button" disabled>Stop</button>
        <select id="voiceStyle" aria-label="Voice style">
          <option value="calm_operator">Calm operator</option>
          <option value="focused_operator">Focused operator</option>
          <option value="fast_hands_free">Fast hands-free</option>
        </select>
      </div>
      <div class="statusbar"><span id="status">Ready.</span><span id="liveLabel">Idle</span></div>
    </section>
    <section class="panel grid">
      <h2>Typed request</h2>
      <textarea id="manualText" placeholder="Ask the same Realtime session to check a file, run a safe command, fetch a local URL, or explain the current system status."></textarea>
      <div class="button-grid">
        <button class="primary" id="sendText" type="button">Send</button>
        <button id="discover" type="button">Discover Tools</button>
      </div>
      <div id="phoneInfo" class="muted"></div>
    </section>
    <section class="panel grid">
      <h2>Live log</h2>
      <div class="log" id="log"></div>
    </section>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
let token = "";
let pc = null;
let dc = null;
let localStream = null;
let micMuted = false;
let callSessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

function log(line) {
  const target = $("log");
  target.textContent += (target.textContent ? "\\n" : "") + line;
  target.scrollTop = target.scrollHeight;
}

function status(text, state = "") {
  $("status").textContent = text;
  if (state) $("liveLabel").textContent = state;
}

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) headers["x-realtime-operator-token"] = token;
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: apiHeaders(options.headers || {}) });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!response.ok || json.ok === false) throw new Error(json.error || text || response.statusText);
  return json;
}

async function refreshPhoneInfo() {
  try {
    const info = await api("/api/mobile-preflight");
    const pieces = [];
    if (!window.isSecureContext && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
      pieces.push("Phone microphone usually needs HTTPS.");
    }
    pieces.push(info.authenticated ? "Access ready." : "Pairing may be required.");
    pieces.push(info.micCompatibleUrl || info.httpUrl || "");
    $("phoneInfo").textContent = pieces.filter(Boolean).join(" ");
  } catch (error) {
    $("phoneInfo").textContent = error.message;
  }
}

function isMeaningfulTranscript(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/^(um+|uh+|hmm+|okay|ok|thanks?|yeah|yes|no)$/i.test(value)) return false;
  return value.length > 2;
}

function sendEvent(event) {
  if (!dc || dc.readyState !== "open") throw new Error("Realtime data channel is not open.");
  dc.send(JSON.stringify(event));
}

async function handleRealtimeEvent(event) {
  const type = event.type || "";
  if (type === "conversation.item.input_audio_transcription.completed") {
    log("you: " + (event.transcript || ""));
    await api("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "input_audio_transcription_completed", role: "user", text: event.transcript || "", callSessionId }),
    }).catch(() => {});
    if (isMeaningfulTranscript(event.transcript)) {
      sendEvent({ type: "response.create" });
    }
    return;
  }
  if (type === "response.audio_transcript.done" || type === "response.output_text.done") {
    const text = event.transcript || event.text || "";
    if (text) log("operator: " + text);
    return;
  }
  if (type === "response.function_call_arguments.done") {
    const args = event.arguments ? JSON.parse(event.arguments) : {};
    log("tool: " + event.name);
    const result = await api("/api/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: event.name, args, callSessionId }),
    });
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify(result.result || result),
      },
    });
    sendEvent({ type: "response.create" });
  }
}

async function requestMicrophoneStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Microphone API is unavailable. Use localhost or HTTPS.");
  }
  if (!window.RTCPeerConnection) throw new Error("WebRTC is not available in this browser.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!stream.getAudioTracks().length) throw new Error("No microphone audio track was returned.");
    return stream;
  } catch (error) {
    if (error.name === "NotAllowedError") throw new Error("Microphone permission was blocked.");
    throw error;
  }
}

async function connect() {
  try {
    $("connect").disabled = true;
    status("Requesting microphone...", "Starting");
    localStream = await requestMicrophoneStream();
    const sessionResponse = await api("/api/realtime-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voiceStyle: $("voiceStyle").value }),
    });
    const secret = sessionResponse.session?.value || sessionResponse.session?.client_secret?.value;
    if (!secret) throw new Error("Realtime client secret response did not include a value.");
    pc = new RTCPeerConnection();
    pc.onconnectionstatechange = () => status(pc.connectionState === "connected" ? "Listening. Long pauses are fine." : "Realtime " + pc.connectionState + ".", pc.connectionState === "connected" ? "Live" : "Starting");
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => {
      $("muteMic").disabled = false;
      $("disconnect").disabled = false;
      status("Listening. Long pauses are fine.", "Live");
      log("connected: " + sessionResponse.model + " / " + sessionResponse.voice);
    };
    dc.onmessage = (message) => {
      try { handleRealtimeEvent(JSON.parse(message.data)).catch((error) => log("tool error: " + error.message)); }
      catch (error) { log("event error: " + error.message); }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!sdpResponse.ok) throw new Error(await sdpResponse.text());
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
  } catch (error) {
    disconnect();
    status("Connection failed.", "Idle");
    log(error.message || String(error));
    $("connect").disabled = false;
  }
}

function disconnect() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  if (dc) dc.close();
  if (pc) pc.close();
  dc = null;
  pc = null;
  micMuted = false;
  $("muteMic").textContent = "Mute";
  $("muteMic").setAttribute("aria-pressed", "false");
  $("muteMic").disabled = true;
  $("disconnect").disabled = true;
  $("connect").disabled = false;
  status("Ready.", "Idle");
}

async function sendText() {
  const text = $("manualText").value.trim();
  if (!text) return;
  log("you typed: " + text);
  if (dc && dc.readyState === "open") {
    sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    sendEvent({ type: "response.create" });
    $("manualText").value = "";
    return;
  }
  log("Connect first to send typed text into Realtime.");
}

function toggleMute() {
  if (!localStream) return;
  micMuted = !micMuted;
  for (const track of localStream.getAudioTracks()) track.enabled = !micMuted;
  $("muteMic").textContent = micMuted ? "Unmute" : "Mute";
  $("muteMic").setAttribute("aria-pressed", String(micMuted));
  status(micMuted ? "Microphone muted." : "Listening. Long pauses are fine.", micMuted ? "Muted" : "Live");
}

async function runTool(tool, args = {}) {
  const result = await api("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  log(tool + ": " + JSON.stringify(result.result || result, null, 2));
}

$("connect").onclick = connect;
$("disconnect").onclick = disconnect;
$("muteMic").onclick = toggleMute;
$("sendText").onclick = sendText;
$("discover").onclick = () => runTool("discover_operator_capabilities");
$("toolStatus").onclick = () => runTool("get_system_status");
$("toolList").onclick = () => runTool("list_directory", { path: "~", max_entries: 20 });
$("phonePanel").onclick = refreshPhoneInfo;
$("clearLog").onclick = () => { $("log").textContent = ""; };
$("toggleMenu").onclick = () => { document.body.classList.add("dock-open"); $("toggleMenu").textContent = "Open"; };
$("closeMenu").onclick = () => { document.body.classList.remove("dock-open"); $("toggleMenu").textContent = "Menu"; };

refreshPhoneInfo();
</script>
</body>
</html>`;
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return html(res, indexPage());
    if (req.method === "GET" && url.pathname === "/api/auth-check") return ok(res, { authenticated: requireToken(req), localAuth: isLocalRequest(req) });
    if (req.method === "GET" && url.pathname === "/api/network-trust") return ok(res, { decision: networkTrustDecision(url.searchParams.get("remote") || remoteIpv4(req)) });
    if (req.method === "GET" && url.pathname === "/api/mobile-preflight") return ok(res, mobilePreflight(req));
    if (req.method === "POST" && url.pathname === "/api/phone-login") {
      const body = JSON.parse((await readBody(req, 10_000)) || "{}");
      if (!safeCompare(body.code || "", phoneAccessCode)) return fail(res, 403, "bad phone code");
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `realtime_operator_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (!requireToken(req) && !["/", "/api/auth-check", "/api/mobile-preflight"].includes(url.pathname)) {
      return fail(res, 401, "missing or bad token");
    }
    if (req.method === "GET" && url.pathname === "/api/phone-access") return ok(res, { code: phoneAccessCode, ...phoneUrls(), pairingRequired: true });
    if (req.method === "GET" && url.pathname === "/api/health") {
      return ok(res, {
        status: "ok",
        model: config.realtime.model,
        voice: config.realtime.voice,
        openaiKeyConfigured: Boolean((config.openai.apiKeyFile && existsSync(config.openai.apiKeyFile)) || process.env[config.openai.apiKeyEnv || "OPENAI_API_KEY"]),
        activeCommands,
        network: { ...phoneUrls(), entries: localNetworkEntries() },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/discovery") return ok(res, { discovery: operatorDiscovery() });
    if (req.method === "POST" && url.pathname === "/api/realtime-session") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const created = await createRealtimeClientSecret(body);
      logEvent("realtime_client_secret_created", { model: config.realtime.model, voice: created.voice, voiceStyle: created.voiceStyle });
      return ok(res, { session: created.data, model: config.realtime.model, voice: created.voice, voiceStyle: created.voiceStyle });
    }
    if (req.method === "POST" && url.pathname === "/api/tool") {
      const body = JSON.parse((await readBody(req)) || "{}");
      let result;
      try {
        result = await handleToolCall(body);
      } catch (error) {
        result = { status: "error", error: trimReply(error.message || String(error)) };
      }
      logTechnicalEvent({
        kind: "tool_call",
        tool: body.tool || body.name || "",
        args: config.logging.includeToolPayloads ? body.args : undefined,
        result: config.logging.includeToolPayloads ? result : { status: result.status },
      });
      return ok(res, { result });
    }
    if (req.method === "POST" && url.pathname === "/api/log") {
      const body = JSON.parse((await readBody(req, 256_000)) || "{}");
      logTranscript(body);
      return ok(res, { status: "ok" });
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const kind = String(url.searchParams.get("kind") || "events");
      const path = kind === "transcript" ? config.transcriptPath : kind === "metadata" ? config.logPath : config.eventLogPath;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 80, 1), 400);
      const text = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-limit).join("\n") : "";
      return ok(res, { kind, text: redact(text), path });
    }
    return fail(res, 404, "not found");
  } catch (error) {
    logEvent("request_failed", { path: url.pathname, error: error.message });
    return fail(res, 500, trimReply(error.message || String(error)));
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => fail(res, 500, trimReply(error.message || String(error))));
});

server.listen(config.port, config.host, () => {
  console.log(`realtime-operator listening on http://${config.host}:${config.port}`);
  console.log(`token file: ${config.accessTokenPath}`);
});

if (process.argv.includes("--print-token-path")) {
  console.log(config.accessTokenPath);
}
