# Configuration

Realtime Operator reads `config.json` from the project directory when `REALTIME_OPERATOR_CONFIG` is set, otherwise it looks at:

```text
~/.realtime-operator/config.json
```

For local development, copy the example:

```bash
cp config.example.json config.json
```

Then run:

```bash
REALTIME_OPERATOR_CONFIG=./config.json ./start.sh
```

## OpenAI Key

The browser never receives the standard OpenAI API key. The local server uses it to mint a short-lived Realtime client secret.

Use the environment:

```bash
export OPENAI_API_KEY="..."
```

Or use the default local key file:

```text
~/.realtime-operator/openai-api-key.secret.local
```

Keep key files ignored by git and locked down with `chmod 600`.

## Realtime

```json
{
  "realtime": {
    "model": "gpt-realtime-2",
    "voice": "marin",
    "voiceStyle": "calm_operator",
    "outputModalities": ["audio"],
    "reasoning": {
      "effort": "xhigh"
    }
  }
}
```

`voiceStyle` changes the instruction style sent to the Realtime session. The built-in values are:

| Style | Behavior |
|-------|----------|
| `calm_operator` | Warm, brief, practical. |
| `focused_operator` | More precise and status-oriented. |
| `fast_hands_free` | Shorter answers for hands-free work. |

## Allowed Roots

Local file tools and command working directories are restricted to `system.allowedRoots`.

```json
{
  "system": {
    "allowedRoots": ["~", "~/Developer/Projects"]
  }
}
```

Keep this narrow. If you only want project control, point it at that project folder instead of your whole home directory.

## Network

Private-network trust is disabled by default:

```json
{
  "network": {
    "trustPrivateClients": false,
    "trustTailnetClients": false
  }
}
```

Localhost works without pairing. Phones and other machines should pair with the phone code unless you deliberately enable private-network trust.

## Logging

Default logs live under:

```text
~/.realtime-operator/
```

| File | Purpose |
|------|---------|
| `operator.log` | Metadata and request failures. |
| `transcript.jsonl` | Completed user transcripts and typed input. |
| `realtime-events.jsonl` | Tool-call metadata and technical events. |

Tool payload logging is off by default because local tool arguments can contain private paths or text.

