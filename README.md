# Realtime Operator

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Node 22+](https://img.shields.io/badge/node-22%2B-blue.svg)]()
[![OpenAI Realtime](https://img.shields.io/badge/OpenAI-Realtime-green.svg)](https://platform.openai.com/docs/guides/realtime)
[![Local tools](https://img.shields.io/badge/local-tools-lightgrey.svg)]()

Realtime Operator is a local voice agent built on the OpenAI Realtime API.

You speak in the browser. The browser connects to a Realtime model over WebRTC. When the model needs to do something on your computer, it calls local function tools through the Node server: inspect the system, list files, search a project, read a safe text file, fetch a URL, run a bounded command, open a link, show a notification, or use the clipboard after confirmation.

The interesting part is the bridge.

Most voice demos stop at conversation. This one gives the Realtime model hands, but keeps those hands local, narrow, logged, and approval-gated. The standard OpenAI API key stays on the server. The browser only gets a short-lived Realtime client secret.

The default model is `gpt-realtime-2`, with `marin` as the default voice. If your account uses a different Realtime model alias, change `realtime.model` in `config.json`.

## Local Runtime

| Path | Where it runs |
|------|---------------|
| Browser microphone and audio playback | Your browser |
| Realtime voice conversation | OpenAI Realtime over WebRTC |
| API key and client-secret minting | Local Node server |
| Function tools | Local Node server |
| Commands, files, clipboard, notifications | Your own machine |
| Logs and transcripts | `~/.realtime-operator/` |

The server follows the OpenAI Realtime WebRTC pattern: the browser gets a short-lived client secret, opens a peer connection, and uses the `oai-events` data channel for conversation and function-call events.

## At A Glance

| Surface | What it does |
|---------|--------------|
| Voice UI | Starts a browser Realtime voice session, handles microphone setup, mute, disconnect, typed messages, and local status. |
| Realtime session | Uses audio output, semantic VAD, input transcription, reasoning, and function tools. |
| Local tools | System status, bounded commands, directory listing, file metadata, redacted file reads, file search, URL fetches, open URL/file, notifications, and clipboard. |
| Safety layer | Token-backed local API, allowed roots, sensitive-path detection, output redaction, risky-action confirmation, bounded command timeouts, and local logs. |
| Tests | Node syntax checks, API smoke test, Playwright UI smoke test, and a repository secret scan. |

## Quick Start

Requirements: Node.js 22+, an OpenAI API key, and a browser with microphone and WebRTC support.

```bash
git clone https://github.com/gabrimatic/realtime-operator.git
cd realtime-operator
npm install
cp config.example.json config.json
```

Put your API key in the environment:

```bash
export OPENAI_API_KEY="..."
```

Or store it in the default local file:

```bash
mkdir -p ~/.realtime-operator
printf '%s\n' "..." > ~/.realtime-operator/openai-api-key.secret.local
chmod 600 ~/.realtime-operator/openai-api-key.secret.local
```

Start the server:

```bash
./start.sh
```

Open:

```text
http://127.0.0.1:49376/
```

Then press `Start Talking`.

## Features

- **Realtime voice agent**: browser microphone to OpenAI Realtime, with audio responses back through WebRTC.
- **Local function tools**: the model can inspect and act through the local server when a spoken request needs real machine context.
- **Bounded command runner**: supports exact `argv`, shell `command`, or multiline `script`, with timeouts and risky-action gates.
- **File tools**: list directories, inspect metadata, read redacted text files, and search with ripgrep under configured allowed roots.
- **Network helper**: fetch a bounded URL response for local API checks or public GET requests.
- **Desktop actions**: open a URL/file, show macOS notifications, and read or set clipboard only after confirmation.
- **Approval gates**: destructive, publishing, credential-related, service-changing, payment, messaging, and sensitive commands return `approval_required`.
- **Redaction**: keys, bearer tokens, GitHub tokens, credentials, and sensitive output are redacted before logs or tool output.
- **Phone pairing path**: private-network access is off by default. If enabled, pair with a local code instead of putting the standard API key in the browser.

## Why Function Tools

OpenAI Realtime supports function calling during a live conversation. The model emits tool-call arguments, the client executes custom code, then sends tool output back into the conversation and asks the model to respond.

That fits this project well because the machine-control part should stay local. Remote MCP is useful when the tool server is reachable from OpenAI. Local shell, files, clipboard, and desktop actions are private machine boundaries, so this project exposes them as Realtime function tools behind a local server and approval layer.

Relevant OpenAI docs:

- [Realtime API overview](https://platform.openai.com/docs/guides/realtime)
- [Realtime API with WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc)
- [Realtime conversations and function calling](https://platform.openai.com/docs/guides/realtime-model-capabilities)
- [Realtime client secrets](https://platform.openai.com/docs/api-reference/realtime-sessions/create-realtime-client-secret)

## Configuration

Copy `config.example.json` to `config.json`. The default local data directory is:

```text
~/.realtime-operator/
```

Important settings:

| Setting | Default | Notes |
|---------|---------|-------|
| `realtime.model` | `gpt-realtime-2` | Change this if your account uses another Realtime model alias. |
| `realtime.voice` | `marin` | Any supported Realtime voice can be configured. |
| `system.allowedRoots` | `["~"]` | File and command working directories must stay inside these roots. |
| `network.trustPrivateClients` | `false` | Keep false unless you understand the LAN trust tradeoff. |
| `safety.requireConfirmationForRiskyTasks` | `true` | Keep true for real use. |
| `logging.includeToolPayloads` | `false` | Leave false unless you need deeper debugging. |

More detail is in [docs/configuration.md](docs/configuration.md).

## Safety Model

Realtime Operator is powerful because it can touch the local machine. The safety model is intentionally practical:

- The standard OpenAI API key never goes to the browser.
- The local API is token-backed.
- Private LAN clients are not trusted by default.
- Tools can only work under configured allowed roots.
- Sensitive-looking files require confirmation before reading.
- Risky commands require a confirmation challenge before they run.
- Command output and logs are redacted.
- Commands are bounded by timeout and output size.
- Clipboard tools require confirmation every time.

This is still a local system-control app. Read the code and configuration before pointing it at important directories.

## Development

```bash
npm install
npm test
```

Individual checks:

```bash
npm run check
npm run smoke
npm run ui:smoke
npm run secret:scan
```

`npm run ui:smoke` starts a throwaway local server with temp config and state, then runs Playwright against it. It does not use your real API key or local data directory.

## Project Status

This is an early open-source release. The core path is intentionally small: Realtime voice, local tools, safety gates, and documentation that explains the architecture. The next useful work is packaging, richer tool presets, and a cleaner install flow.

