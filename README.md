# LiteLLM Proxy for GitHub Copilot

![LiteLLM Proxy for GitHub Copilot, a Nuanst product](media/banner.png)

A [Nuanst](https://www.nuanst.com) extension. Route GitHub Copilot — chat, code completions, inline hints/NES, agents, and
skills — through **your** LiteLLM proxy or local models, and keep Copilot as
the UI. Useful when model traffic should stay on your own infrastructure,
including after Copilot credits are exhausted.

## Install

Search the Extensions view for **LiteLLM Proxy for GitHub Copilot**
(publisher `nuanst-one`), or install a packaged build:

```bash
code --install-extension vscode-litellm-0.2.0.vsix
```

Reload the window after installing. You need VS Code 1.110 or newer, GitHub
Copilot Chat, and a LiteLLM proxy (default `http://localhost:4000`).

## How it works

`github.copilot-chat` funnels all model traffic through two base URLs and
ships hidden settings that override them (verified against the 0.38 bundle):

| Base | Traffic | Override key |
|---|---|---|
| `api.githubcopilot.com` | chat, `/responses`, `/v1/messages`, `/models`, `/embeddings`, `/agents*`, `/skills` | `github.copilot.internal.capiUrl` (+ legacy `github.copilot.chat.advanced.debug.overrideCapiUrl`) |
| `copilot-proxy.githubusercontent.com` | code completions, NES/inline hints | `github.copilot.internal.completionsUrl` (+ legacy `...overrideProxyUrl`) |

This extension writes **all six key forms** for you (current + legacy
prefixes, see `OVERRIDES` in [src/copilotSettings.ts](src/copilotSettings.ts)),
manages the Copilot-model → LiteLLM-deployment mapping, health-checks the
proxy, and can export a ready `litellm/config.yml`. Auth token minting still goes to GitHub by design — see
[docs/spike.md](docs/spike.md) for the credits-exhaustion findings.

## Setup

1. Set `vscode-litellm.proxyBaseUrl` (default `http://localhost:4000`) and start your LiteLLM proxy.
2. If the proxy requires an API key, run **LiteLLM Proxy: Store API Key Securely** and turn on `vscode-litellm.forwarder.enabled`. Copilot sends its own token; the forwarder replaces it with yours.
3. The status bar shows **✓ LiteLLM** when the proxy is reachable, and **✗** when it is not. Click it for every command.
4. Commands:
   - **LiteLLM Proxy: Configure Model Map** — map Copilot model names → LiteLLM deployments
   - **LiteLLM Proxy: Test Connection**
   - **LiteLLM Proxy: Recent Requests** — last 200 forwarded requests with status, latency, time-to-first-byte, retries and errors (no more log-scrolling to find the failed call)
   - **LiteLLM Proxy: Store API Key Securely** / **Clear Stored API Key** — keep the proxy key in VS Code SecretStorage instead of settings.json (SecretStorage takes priority while set)
   - **LiteLLM Proxy: Export LiteLLM config.yml** — generates a config using the Copilot model names as `model_name`
   - **LiteLLM Proxy: Toggle Routing** — on: override keys written; off: those keys cleared and the real GitHub endpoints restored

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `vscode-litellm.enabled` | `true` | master switch |
| `vscode-litellm.proxyBaseUrl` | `http://localhost:4000` | LiteLLM base URL (no trailing slash) |
| `vscode-litellm.modelMap` | see `package.json` | Copilot model → LiteLLM deployment |
| `vscode-litellm.defaultDeployment` | `""` | fallback deployment for unmapped models (exported config) |
| `vscode-litellm.deployment.apiBase` / `.apiKey` | `""` | written into every exported deployment |
| `vscode-litellm.forwarder.enabled` / `.port` / `.apiKey` | `false` / `4141` / `""` | local auth-rewriting forwarder in front of the proxy. The key is also available in **SecretStorage** via *Store API Key Securely* — SecretStorage wins while non-empty |
| `vscode-litellm.forwarder.fallbackModel` | `""` | model the forwarder retries with when the requested model is unavailable; also merged into the exported config as LiteLLM `fallbacks` |
| `vscode-litellm.forwarder.requestTimeoutMs` | `30000` | max wait for the upstream's first response byte (0 disables). In-flight SSE streams are never cut off. On timeout the forwarder retries once, then answers 504 |
| `vscode-litellm.surfaces.{chat,agents,completions,nes}` | `true` | per-surface toggles (chat+agents = CAPI base; completions+nes = proxy base) |
| `vscode-litellm.statusPollIntervalMs` | `30000` | status-bar poll interval (min 5000) |
| `vscode-litellm.logLevel` | `trace` | minimum level for the "vscode-litellm" output channel (trace shows every request incl. the status poll; `info` is quieter) |

## Limitations

Turn on the forwarder when the proxy checks an API key. With it on, the
extension also covers two Copilot paths LiteLLM does not:

- `POST /v1/engines/<model>/completions` (inline completions) is rewritten to `/v1/completions`.
- `GET /models` is answered in Copilot's shape. `GET /v1/models` stays OpenAI-shaped, with your mapped names merged in.

`GET /agents` is answered with an empty list. Other Copilot-only routes
(`/skills`, `/search`, `/models/session`) are forwarded as-is and depend on
what your proxy implements.

## Troubleshooting

- **Copilot still hits GitHub** after toggling: reload the window; the
  overrides re-apply on config change and on every Copilot token refetch. Check
  that the override keys exist in global settings.json (command palette →
  *Preferences: Open User Settings (JSON)*).
- **After a Copilot update** routing stops: re-run *Toggle Routing* off→on
  (the hidden keys are undocumented and could change name or behavior in a
  future Copilot build — the extension writes both current and legacy forms).
- **`✗` in status bar**: run *Test Connection*; it reports which endpoints were
  tried. LiteLLM must be reachable over plain HTTP/HTTPS from the extension host.
- **Rate-limit/429 noise from Copilot**: the proxy may omit
  `x-ratelimit-*` / `x-github-request-id` headers; Copilot tolerates their
  absence.
- **"which Copilot call just failed?"**: *LiteLLM Proxy: Recent Requests*
  lists the last 200 forwarded requests with status, total latency, time to
  first byte, and whether a fallback/transport retry happened; pick one for
  the full detail. The forwarder also transparently retries **once** on
  connection errors and on 429/5xx (before any byte reaches the client), so a
  flaky proxy blip may not produce a visible error at all.
- **Copilot updated and routing silently stopped**: the doctor now compares
  the running VS Code / Copilot Chat build against the verified-build table
  (`src/copilotVersions.ts`). If it warns the build is unverified, re-run the
  spike and add the build to the table.
- **`Language model unavailable`** (log: *Could not find model 'X' in local
  cache after re-resolving models*): the selected model isn't in the proxy's
  model list, so Copilot rejects it before any request is sent. Fix: enable
  `forwarder.enabled`, set `forwarder.fallbackModel` to a model the proxy
  actually serves, and add the selected name (e.g. `copilot/auto`) to the
  model map — the forwarder then advertises that name in the model list and
  retries refused requests on the fallback model.
- **"I don't see any chat traffic in the log"**: at the default `trace` level
  the forwarder logs **every real client request** as
  `POST /chat/completions (…B) → <upstream>` + `← <status>`. The recurring
  `GET /v1/models` / `GET /models` lines are mostly the extension's own
  30-second status poll (tagged `x-litellm-router: status-poll`, logged at
  `debug`) and Copilot's model-list fetch — they are **not** a chat turn. A
  chat turn only exists once you actually submit a prompt. Run
  *Troubleshoot (doctor)* → it sends one 1-token `POST /chat/completions`
  through the forwarder and reports the upstream status, and it probes that a
  WebSocket upgrade is refused cleanly (501) rather than hanging — a silent
  WS hang looks exactly like "chat isn't routed".
- **"message filter" line in the log** (`dropped N empty system message(s),
  nulled M empty assistant content(s)`): the forwarder normalized Copilot's
  blank system prompt / empty tool-call assistant content before forwarding.
  Without it, LiteLLM's `modify_params` rewrites those empty strings into a
  visible "[System: Empty message content sanitised…]" placeholder that
  persists in the conversation history.

## Development

```bash
npm install
npm test
npm run compile          # type-check, then esbuild → dist/extension.js
```

Press F5 in this workspace to launch an Extension Development Host. Packaging
and Marketplace steps are in [PUBLISHING.md](PUBLISHING.md). The endpoint
checklist for a new Copilot build is [docs/spike.md](docs/spike.md).

## Repo layout

```
src/extension.ts        activation, commands, config validation + wiring
src/copilotSettings.ts  writes/clears the hidden override keys (API + settings.json fallback)
src/copilotVersions.ts  verified VS Code / Copilot Chat builds for the override keys (doctor check)
src/forwarder.ts        local auth-rewriting proxy: advertises modelMap names, fallback-model retry, transport retry (429/5xx/connect errors), first-byte timeout, empty-content normalization, recent-request ring buffer
src/policies.ts         pure forwarder decision logic (unit-tested, no vscode)
src/configRender.ts     LiteLLM config.yml rendering (pure, unit-tested)
src/proxy.ts            LiteLLM health/model checks
src/modelMap.ts         quickpick model-map editor
src/statusBar.ts        status bar + configurable polling
src/notify.ts           deduped warning toasts
test/                   standalone smoke tests (npm test, no framework)
spike/config.example.yml  minimal LiteLLM config for the spike
docs/spike.md           checklist for verifying override keys after a Copilot update
```

## License

[MIT](LICENSE) © 2026 Nuanst One GmbH.

GitHub Copilot is a trademark of GitHub, Inc. LiteLLM is a trademark of BerriAI. This extension is not affiliated with or endorsed by either organization.
