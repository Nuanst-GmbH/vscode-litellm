# Privacy

LiteLLM Proxy for GitHub Copilot does not phone home. It does not send
telemetry, prompts, completions, or API keys to Nuanst or to GitHub on its own.

Traffic you route through the extension goes to the LiteLLM proxy URL you
configured (`vscode-litellm.proxyBaseUrl`), and to `127.0.0.1` on the forwarder
port when the forwarder is enabled. Copilot's own token requests still go to
GitHub, because the extension does not intercept them.

## Report Issue

**LiteLLM Proxy: Report Issue** (also in the status-bar menu) builds a text
draft and opens a GitHub new-issue page with that draft in the Diagnostics
field:

<https://github.com/Nuanst-GmbH/vscode-litellm/issues/new?template=bug_report.yml>

Nothing in the draft is uploaded until you submit the issue. The page is a
normal GitHub form: edit or delete the text first. The form asks you to
confirm you reviewed it. The command can also copy the draft to the clipboard
instead of opening GitHub.

The draft includes:

- This extension's version
- VS Code version and product name, and whether the window is desktop or web
- The remote window type when you are in one (`wsl`, `ssh-remote`, and similar). This is the kind of remote, not the machine's hostname
- Operating system platform and CPU architecture (`win32` / `darwin` / `linux`, and `x64` / `arm64`). Not your username, home directory, or hostname
- GitHub Copilot Chat version when that extension is installed, or `builtin` when Copilot is built into VS Code
- Routing on or off, and the chat, agents, completions, and NES surface toggles
- Forwarder on or off, its port, and whether it is listening in this window
- First-byte timeout, status-poll interval, and log level
- Fallback model, default deployment, and the model map (up to 50 entries)
- Proxy base URL and deployment API base, with any username, password, or URL fragment removed
- Whether an API key is configured, and where: SecretStorage, settings.json, or not set. The key itself is never included
- Up to 10 newest forwarded requests since the forwarder last started: time, HTTP method, path, model id, status code, latency, time to first byte, outcome, and whether a fallback or transport retry happened. A short error string is included when one was recorded

The draft does not include:

- API keys, bearer tokens, or `sk-…` secrets. Those strings are replaced with `[redacted]` if they appear in a model name or error
- Query strings on request paths (replaced with `[query redacted]`), because a query can carry a token
- Prompt text, message bodies, tool arguments, or model output
- File contents, workspace folders, or document paths
- The doctor does not run as part of this command, so it does not send a test chat completion

If the draft is too long for a browser URL, the command shortens it and adds a line saying it was truncated.
