# Phase 0 — validation spike

Goal: prove that pointing GitHub Copilot straight at a LiteLLM proxy works, and
record exactly which paths/models Copilot hits. Results drive Phase 1 scope and
decide whether the Phase 2 shim is needed.

**Fill in the results table as you go — this document is the source of truth
for what the extension must support.**

---

## 1. Start LiteLLM

```bash
pip install "litellm[proxy]"
litellm --config spike/config.example.yml     # http://localhost:4000
```

Sanity check: `curl http://localhost:4000/health/liveliness` and
`curl http://localhost:4000/v1/models`.

## 2. Point Copilot at it

In the VS Code product that has `github.copilot-chat` (here: **Insiders**),
open *settings.json* (global) and add all four keys — both the current
`internal.*` names and the legacy aliases, so it works whichever the installed
Copilot build reads:

```jsonc
"github.copilot.internal.capiUrl": "http://localhost:4000",
"github.copilot.internal.completionsUrl": "http://localhost:4000",
"github.copilot.chat.advanced.debug.overrideCapiUrl": "http://localhost:4000",
"github.copilot.chat.advanced.debug.overrideProxyUrl": "http://localhost:4000"
```

Reload the window. Stay signed in to GitHub.

## 3. Test each surface

| Surface | How to trigger | Expected request | Result | Notes (model names, 404s) |
|---|---|---|---|---|
| Chat panel | ask Copilot a question | `POST /chat/completions` (SSE) | works / broken | |
| Inline hints / NES | `editor.action.triggerSuggestion` while editing | `POST /chat/completions` on proxy base | works / broken | |
| Code completions | type in a file, wait for ghost text | `POST /v1/engines/gpt-4o-copilot/completions` | **404 expected** | mitigation: |
| Model picker | open picker | `GET /models` | 404 → built-in fallback ok? | |
| Agents / skills | trigger agent mode / @-mention skills | `/agents*`, `/skills`, `/search` | unknown | |

**Mitigations to try if code completions 404:**
1. LiteLLM custom route / callback aliasing `POST /v1/engines/*/completions` → its `/completions`.
2. A 20-line path-rewrite in front of LiteLLM (Node/Python, ~`http-proxy` + regex).
3. Accept the Phase 2 shim (extension-spawned, speaks Copilot's full API).

Record the exact `model` field values Copilot sends in LiteLLM logs — those
become the `vscode-litellm.modelMap` defaults and the exported config.

## 4. Credits-exhaustion scenario

With the overrides active, observe what happens when the GitHub Copilot quota
is hit (or test with a free/NL account):

- Does `POST api.github.com/copilot_internal/v2/token` still return a JWT? **YES** (observed 2026-09-24, Copilot Chat 0.65.0, VS Code 1.137.0, paid org seat with quota exhausted: the token endpoint kept returning valid tokens — `Got Copilot token for <user>`, `copilot token sku: copilot_for_business_seat_quota` — while model calls returned `402 {"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}`. The 402 is a *server-side, per-request* rejection, not a token failure.)
- Does the extension refuse client-side (check Copilot output channel)? NOT YET OBSERVED — pending routed-traffic test. The extension re-mints the token after each 402 (`Logged in as …` / `Got Copilot token` cycles right after the quota errors) and retries rather than hard-stopping; no client-side refusal seen.
- Does chat/completions keep working via the proxy regardless? PENDING — this is the current test (forwarder → org LiteLLM deployment).

**Decision:**
- [x] Token still mints after quota → **no token stub needed**, Phase 1 is settings-only.
- [ ] GitHub hard-refuses → token stub required (scope it into Phase 1 or 2).

## 5. Results summary

- Model names observed:
- Paths that 404'd and their blast radius:
- Mitigation chosen for completions:
- Token stub needed? why/why not:
- Anything else Copilot does that surprised us:
