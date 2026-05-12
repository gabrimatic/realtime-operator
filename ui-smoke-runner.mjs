#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config.example.json"), "utf8"));
const token = randomBytes(24).toString("base64url");
const smokePort = Number(process.env.REALTIME_OPERATOR_TEST_PORT || 49576 + (process.pid % 1000));
const tempRoot = join("/tmp", `realtime-operator-ui-${process.pid}`);
const configPath = join(tempRoot, "config.json");

mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(tempRoot, "openai-api-key.secret.local"), "test-openai-key-not-real\n", { mode: 0o600 });

config.host = "127.0.0.1";
config.port = smokePort;
config.workspaceRoot = tempRoot;
config.statePath = join(tempRoot, "state.json");
config.logPath = join(tempRoot, "operator.log");
config.transcriptPath = join(tempRoot, "transcript.jsonl");
config.eventLogPath = join(tempRoot, "events.jsonl");
config.accessTokenPath = join(tempRoot, "access-token");
config.network.publicHost = "127.0.0.1";
config.network.trustPrivateClients = true;
config.network.phoneAccessCodePath = join(tempRoot, "phone-code.secret.local");
config.openai.apiKeyFile = join(tempRoot, "openai-api-key.secret.local");
config.system.allowedRoots = [root, tempRoot];

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const server = spawn(process.execPath, [join(root, "server.mjs")], {
  env: {
    ...process.env,
    REALTIME_OPERATOR_CONFIG: configPath,
    REALTIME_OPERATOR_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${smokePort}/api/health`, {
        headers: { "x-realtime-operator-token": token },
      });
      if (response.ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error(`Realtime Operator UI smoke server did not become ready.\n${serverOutput}`);
}

function runPlaywright() {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", "ui-smoke.spec.mjs", "--reporter=list"],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          REALTIME_OPERATOR_URL: `http://127.0.0.1:${smokePort}/`,
          REALTIME_OPERATOR_TOKEN: token,
        },
      },
    );
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

try {
  await waitForServer();
  process.exitCode = await runPlaywright();
} finally {
  server.kill("SIGTERM");
  await wait(200);
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
}

