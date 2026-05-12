# Security

Realtime Operator is a local system-control app. Treat configuration as part of the product.

## Defaults

- The standard OpenAI API key stays server-side.
- The browser receives only a short-lived Realtime client secret.
- Private LAN clients are not trusted by default.
- File and command access is restricted to `system.allowedRoots`.
- Sensitive-looking files require confirmation.
- Risky commands require a confirmation challenge.
- Clipboard tools require confirmation.
- Logs and tool output are redacted.

## Do Not Commit

Never commit:

- `config.json`
- `.env` files
- `~/.realtime-operator/*`
- API keys or token files
- local logs or transcripts
- generated certificates

The repository secret scan checks for common key patterns and private local paths before release.

## Reporting

Please open a GitHub issue with a minimal reproduction and avoid posting secrets, logs, transcripts, or local paths that identify your machine.

