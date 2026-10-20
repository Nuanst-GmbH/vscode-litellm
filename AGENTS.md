# Agent instructions — vscode-litellm

VS Code extension that routes GitHub Copilot (chat, completions, NES/inline hints,
agents) through a local forwarder (`127.0.0.1:<forwarder.port>`) to the user's
own LiteLLM proxy, with a fallback model for unavailable deployments.

## MANDATORY: keep the self-diagnosis surface in sync

The extension ships its own troubleshooting tooling:

- **Doctor** — `src/doctor.ts`, command "LiteLLM Proxy: Troubleshoot (doctor)"
  (report goes to the "LiteLLM Doctor" output channel).
- **Status-bar menu** — clicking the LiteLLM status item runs
  `vscode-litellm.statusBarMenu` (QuickPick of all actions, in `extension.ts`).
- **Log level** — `vscode-litellm.logLevel` + "LiteLLM Proxy: Set Log Level".
- **README** settings table and Troubleshooting section.

**Whenever you change functionality, update all of these in the same change:**

- New/renamed setting → add a check in `doctor.ts` `checkSettings()` (use the
  same default as `readState()` in `extension.ts`), add a row to the README
  settings table.
- New Copilot override key → add to `OVERRIDES` in `copilotSettings.ts`
  (doctor validates it automatically) and make sure `applyOverrides` writes it.
- New forwarder behavior (retry rules, model-list synthesis, new endpoints) →
  add a doctor check that proves it works (probe the endpoint, assert the shape).
- New command or user action → add it to the `statusBarMenu` QuickPick and to
  `contributes.commands` in `package.json`.
- New runtime requirement (port, file, external service) → doctor check.

**Per release:** bump `package.json` `version`. The doctor's
"stale build running" check exists because esbuild bakes `package.json` version
into the bundle (`__LITELLM_EXT_VERSION__` define in `esbuild.mjs`) — without a
bump, the check can't detect that a window is running old code. Keep that
`define` in place.

## Where logic lives

- `src/policies.ts` = **all pure forwarder decision logic** — model-not-found
  matching and model rewriting, retryable status/error codes and retry-delay
  parsing, model-list synthesis, chat-body sanitizing, request-record
  extraction. No `vscode` import (and no http) — that is what makes it
  unit-testable in plain Node. If you find yourself wanting to import vscode in
  this file, the logic belongs elsewhere.
- `src/configRender.ts` = LiteLLM `config.yml` rendering — same rule, pure.
  `proxy.ts` re-exports it for the existing import sites.
- `src/copilotVersions.ts` = `VERIFIED_BUILDS` table: known-good VS Code /
  Copilot Chat version ranges for the hidden override keys. When routing stops
  working after a Copilot update: verify the keys per `docs/spike.md`, add a
  row to `VERIFIED_BUILDS`, and update the `OVERRIDES` comment in
  `copilotSettings.ts`. The doctor checks the running build against this table.
- `src/notify.ts` = `warnOnce`: warning toasts deduped per message for 120s.
  settings.json fires a change event per keystroke; without the dedup, every
  keystroke in a bad URL would re-toast.

## Forwarder invariants

- **First-byte timeout:** `forwarder.requestTimeoutMs` (default 30000, `0`
  disables) bounds only the wait for the upstream's FIRST response byte. An
  in-flight SSE stream is NEVER cut off by it.
- **Two independent one-shot retries per client request:**
  - *Model-fallback retry* — upstream 400/403/404 with a model-not-found JSON
    body → retry once with `forwarder.fallbackModel`.
  - *Transport retry* — socket error (ECONNRESET/ECONNREFUSED/EPIPE/ETIMEDOUT/…),
    a first-byte timeout, or an upstream 429/5xx → retry once, ONLY while
    nothing has been sent to the client yet. Delay comes from `Retry-After` or
    a "try again in N" hint in the body, capped at 10s; default 1s.
  - A fallback retry may itself take one transport retry. The two status sets
    are disjoint (400/403/404 vs 429/5xx).
  - The rules live in `src/policies.ts` (`RETRYABLE_STATUS`,
    `RETRYABLE_ERR_CODES`, `transportRetryDelayMs`) and are applied in
    `src/forwarder.ts`.
- **Request records:** every forwarded request lands in a 200-entry ring
  buffer, finalized exactly once on the client response's `close` (so latency
  spans any transparent retries), surfaced by the "LiteLLM Proxy: Recent
  Requests" command. The buffer resets when the forwarder restarts (options
  change → new `Forwarder` instance).
- The `res.once('close', …)` handler in the server callback is the **single
  place** records are finalized — don't add a second push site.
- **API key precedence:** SecretStorage key `forwarderApiKey` (set via
  "LiteLLM Proxy: Store API Key Securely", cleared via "LiteLLM Proxy: Clear
  Stored API Key" — empty input in the store command also clears) >
  `forwarder.apiKey` > `deployment.apiKey`. The doctor reports which source is
  active.

## Status bar & config validation

- Poll interval is `statusPollIntervalMs` (default 30000, clamped to a minimum
  of 5000). A poll already in flight makes the next tick a no-op (checking
  flag) — don't queue.
- `validateConfig()` in `extension.ts` runs on every apply: `proxyBaseUrl`
  must parse as an http(s) URL with a hostname, `forwarder.port` must be an
  integer 1–65535. Violations toast via `warnOnce`.

## Build & deploy pipeline

The workspace source is **never** what VS Code runs. After any `src/` change:

1. `npm run compile` — runs `npm run check` (`tsc --noEmit`) first, then
   esbuild → `dist/extension.js` (minified)
2. `npm run package` — `vsce package` (repository links come from `package.json`)
3. `code --install-extension ./vscode-litellm-<v>.vsix --force`
4. Ask the user to **reload the window** — the extension host keeps the old
   code in memory until then. With multiple windows open, only ONE can own the
   forwarder port; a stale window holds it with old code (this is the classic
   "fix not taking effect" trap, and exactly what the doctor's port check
   exists to catch).

CI: `.github/workflows/ci.yml` runs `check`, `compile`, and `test` — keep all
three green.

## Testing

- `npm test` runs `test/run.mjs`, which esbuild-bundles each
  `test/*.test.ts` (vscode external) and runs it in plain Node — no test
  framework.
- New pure logic goes in `src/policies.ts` or `src/configRender.ts` and gets a
  test file. Anything that needs vscode APIs is integration-tested via the
  doctor instead (add a doctor check).
- Never kill the user's running forwarder during testing — when you need a
  live forwarder for a manual probe, bind a spare port (e.g. 4998/4999), never
  4141.

## Commands

Contributed in `package.json` `contributes.commands`, implemented in
`extension.ts`:

- `vscode-litellm.toggle` — Toggle Routing
- `vscode-litellm.configure` — Configure Model Map
- `vscode-litellm.testConnection` — Test Connection
- `vscode-litellm.exportConfig` — Export LiteLLM config.yml
- `vscode-litellm.doctor` — Troubleshoot (doctor)
- `vscode-litellm.reload` — Reload (restart this window)
- `vscode-litellm.setLogLevel` — Set Log Level
- `vscode-litellm.recentRequests` — Recent Requests
- `vscode-litellm.storeApiKey` — Store API Key Securely
- `vscode-litellm.clearApiKey` — Clear Stored API Key
- `vscode-litellm.statusBarMenu` — Menu (hidden from the command palette)

All user actions — including the three newest (Recent Requests, Store API Key
Securely, Clear Stored API Key) — are also in the status-bar menu QuickPick
(`vscode-litellm.statusBarMenu`, opened by clicking the status item).

## Gotchas (learned the hard way)

- Logger config keys are **relative** to the section:
  `getConfiguration('vscode-litellm').get('logLevel')`. Fully-qualifying the
  key here double-namespaces it and silently falls back to the default
  (bug fixed in v0.1.8).
- There is **no** package.json menu contribution point for a status-bar item's
  right-click menu — `"menus": { "statusBar": [...] }` is silently ignored.
  The status item uses click → QuickPick instead.
- The Output view id is `workbench.panel.output` (used by the Set Log Level
  `view/title` gear `when` clause).
- Copilot consumes **two** model-list endpoints with different shapes:
  `GET /v1/models` (OpenAI `{ data: [{ id }] }` — chat picker) and
  `GET /models` (Copilot-native
  `{ models: [{ serviceType, name, provider, capabilities: { promptStrategy } }] }`
  — NES/inline edits; `serviceType` ∈ `NESChat`, `CursorJumpChat`,
  `InstantApplyChat`). LiteLLM answers *both* with the OpenAI shape, which
  crashes Copilot's `nesModels` getter (`.models.filter` on undefined) — so the
  forwarder synthesizes the Copilot shape for `/models` while keeping
  `/v1/models` OpenAI-shaped.
- LiteLLM rejects team-inaccessible models with **403**
  (`team_model_access_denied`), not 404 — the forwarder's fallback-retry
  matcher (`MODEL_NOT_FOUND_RE`) must keep covering both.
- Never kill the user's running forwarder during testing — use spare ports
  (e.g. 4998/4999) for standalone forwarder tests (pattern: bundle with esbuild
  `--alias:vscode=<stub>` since `logger.ts` needs a vscode stub).
- **Never detach a Logger method from its receiver.**
  `(cond ? lg.debug : lg.info)(msg)` evaluates `lg.debug` to a bare function
  and calls it — in strict mode `this` is `undefined` inside the method and
  `this.write(...)` throws `Cannot read properties of undefined (reading 'write')`.
  The 0.1.9/0.1.10 forwarder request-log line did exactly this as its FIRST
  statement, so the forwarder silently swallowed EVERY request (the "no impact
  at all" incident; the throw only shows in the Extension Host log, not in the
  vscode-litellm output channel). Always `if (cond) lg.debug(msg) else lg.info(msg)`.
  Same trap hit `testConnection` in `extension.ts` (`? extLog.info : extLog.error`).
