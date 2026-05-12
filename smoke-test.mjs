#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config.example.json"), "utf8"));
const serializedExample = JSON.stringify(config);
for (const forbidden of ["Soroush", ".codex", "voice-" + "codex", "Open" + "Claw", "Mac " + "mini"]) {
  if (serializedExample.includes(forbidden)) {
    throw new Error(`config.example.json must not include private term: ${forbidden}`);
  }
}

const token = randomBytes(24).toString("base64url");
const smokePort = 49476 + (process.pid % 1000);
const tempRoot = join("/tmp", `realtime-operator-smoke-${process.pid}`);
const configPath = join(tempRoot, "config.json");
const statePath = join(tempRoot, "state.json");
const logPath = join(tempRoot, "operator.log");
const transcriptPath = join(tempRoot, "transcript.jsonl");
const eventLogPath = join(tempRoot, "events.jsonl");
const tokenPath = join(tempRoot, "access-token");
const phoneCodePath = join(tempRoot, "phone-code.secret.local");
const apiKeyPath = join(tempRoot, "openai-api-key.secret.local");
const dotEnvPath = join(tempRoot, ".env");
const symlinkEscapePath = join(tempRoot, "escaped-hosts");
const fakeGithubToken = "github_pat_" + "1234567890abcdefghijklmnopqrstuvwxyz_ABCDEF";

mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
writeFileSync(apiKeyPath, "test-openai-key-not-real\n", { mode: 0o600 });
writeFileSync(dotEnvPath, `GITHUB_TOKEN=${fakeGithubToken}\n`, { mode: 0o600 });
writeFileSync(join(tempRoot, "hello.txt"), "hello realtime operator\n", { mode: 0o600 });
try {
  if (existsSync(symlinkEscapePath)) unlinkSync(symlinkEscapePath);
  symlinkSync("/etc/hosts", symlinkEscapePath);
} catch {}

config.host = "127.0.0.1";
config.port = smokePort;
config.workspaceRoot = tempRoot;
config.statePath = statePath;
config.logPath = logPath;
config.transcriptPath = transcriptPath;
config.eventLogPath = eventLogPath;
config.accessTokenPath = tokenPath;
config.network.publicHost = "127.0.0.1";
config.network.trustPrivateClients = true;
config.network.trustTailnetClients = false;
config.network.phoneAccessCodePath = phoneCodePath;
config.openai.apiKeyFile = apiKeyPath;
config.system.allowedRoots = [root, tempRoot];
config.system.commandTimeoutMs = 30000;

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(configPath, 0o600);

const child = spawn(process.execPath, [join(root, "server.mjs")], {
  env: {
    ...process.env,
    REALTIME_OPERATOR_CONFIG: configPath,
    REALTIME_OPERATOR_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${smokePort}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-realtime-operator-token": token,
    },
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!response.ok || json.ok === false) throw new Error(json.error || text);
  return json;
}

try {
  await wait(900);
  const health = await request("/api/health");
  const discovery = await request("/api/discovery");
  const status = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "get_system_status", args: {} }),
  });
  const command = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "run_command", args: { argv: ["printf", "COMMAND_OK"], timeout_ms: 10000 } }),
  });
  const structured = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tool: "run_command",
      args: {
        argv: ["python3", "-c", "import sys,json; print(json.dumps({'got': sys.stdin.read(), 'quote': '\"'}))"],
        stdin: "weather [Berlin] 'quoted'",
        timeout_ms: 10000,
      },
    }),
  });
  const risky = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "run_command", args: { command: "printf SHOULD_NOT_RUN; true # delete", confirmed: true } }),
  });
  const challenge = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "run_command", args: { command: "printf CONFIRMED; true # delete" } }),
  });
  if (challenge.result.status !== "approval_required" || !challenge.result.confirmationId) {
    throw new Error("risky command did not return a confirmation challenge.");
  }
  const confirmed = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tool: "run_command",
      args: { command: "printf CONFIRMED; true # delete", confirmed: true, confirmation_id: challenge.result.confirmationId },
    }),
  });
  const directory = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "list_directory", args: { path: tempRoot, max_entries: 20 } }),
  });
  const fileInfo = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "get_file_info", args: { path: join(tempRoot, "hello.txt") } }),
  });
  const read = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "read_text_file", args: { path: join(tempRoot, "hello.txt") } }),
  });
  const secretReadGate = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "read_text_file", args: { path: apiKeyPath, max_chars: 50 } }),
  });
  const dotEnvGate = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "read_text_file", args: { path: dotEnvPath, max_chars: 50 } }),
  });
  const symlinkEscapeGate = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "read_text_file", args: { path: symlinkEscapePath, max_chars: 200 } }),
  });
  const search = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "search_files", args: { path: tempRoot, query: "realtime operator", glob: "*.txt", max_results: 5 } }),
  });
  const fetchHealth = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "fetch_url", args: { url: `http://127.0.0.1:${smokePort}/api/auth-check`, max_chars: 300 } }),
  });
  const clipboardGate = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "get_clipboard_text", args: {} }),
  });
  const redactedOutput = await request("/api/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "run_command", args: { argv: ["printf", fakeGithubToken], timeout_ms: 10000 } }),
  });
  const phoneAccess = await request("/api/phone-access");
  const localhostTrust = await request("/api/network-trust?remote=127.0.0.1");
  const privateLanTrust = await request("/api/network-trust?remote=192.168.1.42");
  const tailnetTrust = await request("/api/network-trust?remote=100.94.1.2");
  const mobilePreflight = await request("/api/mobile-preflight", {
    headers: { "x-realtime-operator-token": "stale-token-from-old-session" },
  });
  const phoneLogin = await fetch(`http://127.0.0.1:${smokePort}/api/phone-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: phoneAccess.code }),
  });
  if (!phoneLogin.ok) throw new Error(`phone login failed: ${await phoneLogin.text()}`);
  const cookie = phoneLogin.headers.get("set-cookie") || "";
  const cookieHealth = await fetch(`http://127.0.0.1:${smokePort}/api/health`, { headers: { cookie } });
  if (!cookieHealth.ok) throw new Error(`cookie auth failed: ${await cookieHealth.text()}`);

  if (!health.openaiKeyConfigured || health.model !== "gpt-realtime-2") throw new Error("health metadata failed.");
  const toolNames = new Set((discovery.discovery?.capabilities?.localTools || []).map((tool) => tool.name));
  for (const name of ["run_command", "read_text_file", "search_files", "get_clipboard_text"]) {
    if (!toolNames.has(name)) throw new Error(`missing tool discovery: ${name}`);
  }
  if (toolNames.has("take_screenshot")) throw new Error("image/screenshot tools must not be exposed.");
  if (status.result.status !== "ok") throw new Error("get_system_status failed.");
  if (command.result.result.stdout !== "COMMAND_OK") throw new Error("run_command failed.");
  if (!structured.result.result.stdout.includes("weather [Berlin]")) throw new Error("structured argv/stdin command failed.");
  if (risky.result.status !== "approval_required") throw new Error("confirmed=true without challenge must not run.");
  if (confirmed.result.result.stdout !== "CONFIRMED") throw new Error("confirmation flow failed.");
  if (!directory.result.entries.some((entry) => entry.name === "hello.txt")) throw new Error("list_directory failed.");
  if (fileInfo.result.file.type !== "file") throw new Error("get_file_info failed.");
  if (!read.result.text.includes("hello realtime operator")) throw new Error("read_text_file failed.");
  if (secretReadGate.result.status !== "approval_required") throw new Error("secret read gate failed.");
  if (dotEnvGate.result.status !== "approval_required") throw new Error("dot env read gate failed.");
  if (symlinkEscapeGate.result.status !== "error" || !/outside allowed roots/i.test(symlinkEscapeGate.result.error || "")) {
    throw new Error("symlink escape gate failed.");
  }
  if (search.result.status !== "ok" || !search.result.results.length) throw new Error("search_files failed.");
  if (fetchHealth.result.httpStatus !== 200) throw new Error("fetch_url failed.");
  if (clipboardGate.result.status !== "approval_required") throw new Error("clipboard gate failed.");
  if (redactedOutput.result.result.stdout.includes(fakeGithubToken) || !redactedOutput.result.result.stdout.includes("[redacted-github-token]")) {
    throw new Error("command output redaction failed.");
  }
  if (!phoneAccess.httpUrl.includes("127.0.0.1")) throw new Error("phone access failed.");
  if (!localhostTrust.decision.trusted || localhostTrust.decision.kind !== "localhost") throw new Error("localhost trust failed.");
  if (!privateLanTrust.decision.trusted || privateLanTrust.decision.kind !== "private-lan") throw new Error("private LAN trust failed.");
  if (tailnetTrust.decision.trusted || tailnetTrust.decision.kind !== "shared-100.64") throw new Error("tailnet trust failed.");
  if (!mobilePreflight.authenticated || mobilePreflight.staleTokenDetected) throw new Error("mobile preflight failed.");

  console.log(JSON.stringify({
    ok: true,
    health: health.status,
    discovery: "ok",
    commands: "ok",
    gates: "ok",
    files: "ok",
    network: "ok",
    redaction: "ok",
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  await wait(200);
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  if (/error/i.test(output)) process.stderr.write(output);
}
