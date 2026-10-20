/**
 * Pure decision logic of the forwarder — no vscode, no http, so it can be
 * unit-tested in plain Node (see test/). The Forwarder in forwarder.ts is the
 * I/O shell around these functions.
 */

/**
 * body text that indicates the upstream rejected the *model*, not the
 * quota/auth/etc. Covers OpenAI-style "model does not exist" and LiteLLM's
 * team-scoped "not allowed to access model … can only access models=[…]"
 * (returned as a 403).
 */
export const MODEL_NOT_FOUND_RE = /does not exist|not found|no such model|unknown model|invalid model|unrecognized model|unavailable|not allowed to access model|can only access models|model access denied/i;

/** /v1/engines/<model>/... — model segment is URL-encoded or raw */
export const ENGINE_PATH_RE = /^\/v1\/engines\/[^/?]+/;

/** /v1/engines/<model>/completions — Copilot inline completions engine path */
export const ENGINES_COMPLETIONS_RE = /^\/v1\/engines\/[^/?]+\/completions/;

// ---------------------------------------------------------------------------
// model-not-found → fallback retry
// ---------------------------------------------------------------------------

/** true when the error text says the *model* was rejected (not quota/auth/…) */
export function looksLikeModelNotFound(text: string): boolean {
  return /model/i.test(text) && MODEL_NOT_FOUND_RE.test(text);
}

/**
 * Replace the `model` field of a JSON request body with `fallback`.
 * undefined when the body is not JSON with a string `model`, or already equal.
 */
export function rewriteModel(body: Buffer, fallback: string): Buffer | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    if (typeof parsed.model !== 'string' || parsed.model === fallback) return undefined;
    parsed.model = fallback;
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return undefined;
  }
}

/** /v1/engines/<model>/… → /v1/engines/<fallback>/… (model segment re-encoded) */
export function rewriteEnginePath(url: string, fallback: string): string {
  if (!ENGINE_PATH_RE.test(url)) return url;
  return url.replace(ENGINE_PATH_RE, `/v1/engines/${encodeURIComponent(fallback)}`);
}

// ---------------------------------------------------------------------------
// transport-level retry (connection errors, 429/5xx before any byte to client)
// ---------------------------------------------------------------------------

/** Status codes the forwarder transparently retries once (before streaming starts). */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Socket error codes the forwarder transparently retries once. */
export const RETRYABLE_ERR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ECONNABORTED',
]);

/** Cap on the delay parsed from Retry-After / "try again in N" hints. */
export const MAX_RETRY_DELAY_MS = 10_000;
/** Default delay when the upstream gives no hint. */
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Pick the delay before a transport retry from upstream response headers and
 * body: `Retry-After` (seconds or HTTP-date) wins, then a "try again in N s"
 * style hint in the body text; otherwise DEFAULT_RETRY_DELAY_MS. Always ≤
 * MAX_RETRY_DELAY_MS (a proxy that says "retry in 3600s" would stall a chat
 * turn for an hour).
 */
export function transportRetryDelayMs(
  headers: { 'retry-after'?: string | number },
  bodyText: string,
): number {
  const raw = headers['retry-after'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.min(raw * 1000, MAX_RETRY_DELAY_MS);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }
  }
  const m = /try again in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)/i.exec(bodyText);
  if (m) {
    const n = parseFloat(m[1]);
    const ms = /m/i.test(m[2]) ? n : n * 1000;
    if (Number.isFinite(ms)) return Math.min(ms, MAX_RETRY_DELAY_MS);
  }
  return DEFAULT_RETRY_DELAY_MS;
}

// ---------------------------------------------------------------------------
// request records (latency + recent-requests ring buffer)
// ---------------------------------------------------------------------------

export interface RequestRecord {
  /** ISO timestamp of when the client request hit the forwarder */
  time: string;
  method: string;
  /** original path+query as received (before any engine-path rewrite) */
  path: string;
  /** model the client asked for (body `model` or engine path segment), or '' */
  model: string;
  /** final HTTP status sent back to the client, or -1 when never answered */
  status: number;
  /** wall time from request receipt to response completion, or -1 */
  latencyMs: number;
  /** time to first upstream response byte (headers), or -1 */
  ttfbMs: number;
  /** the model-fallback retry (unavailable model) happened for this request */
  fallbackRetry: boolean;
  /** a transparent transport retry (connection error / 429 / 5xx) happened */
  transportRetry: boolean;
  /** 'done' | 'client-aborted' | 'upstream-error' | 'timeout' */
  outcome: string;
  /** short human-readable error (transport failure, timeout, …) */
  error?: string;
}

/**
 * The model a request is asking for: the `model` field of a JSON body, else
 * the URL-encoded segment of /v1/engines/<model>/…, else ''.
 */
export function extractModel(method: string, url: string, body: Buffer): string {
  if (method !== 'GET' && method !== 'HEAD' && body.length > 0) {
    try {
      const m = (JSON.parse(body.toString('utf8')) as { model?: unknown }).model;
      if (typeof m === 'string' && m.length > 0) return m;
    } catch {
      // not JSON — fall through to the path
    }
  }
  const seg = /^\/v1\/engines\/([^/?]+)/.exec(url.split('?', 1)[0]);
  if (seg) {
    try { return decodeURIComponent(seg[1]); } catch { return seg[1]; }
  }
  return '';
}

// ---------------------------------------------------------------------------
// model-list synthesis
// ---------------------------------------------------------------------------

/**
 * Add missing `{ id: name, object: "model" }` entries to an OpenAI-style
 * `{ data: [{ id }] }` list. Non-JSON / unexpected shapes are returned as-is.
 * `added` lists which names were merged in (for logging).
 */
export function augmentModelsList(raw: Buffer, advertised: string[]): { out: Buffer; added: string[] } {
  const added: string[] = [];
  if (advertised.length === 0) return { out: raw, added };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as { data?: Array<{ id?: string; object?: string }> };
    if (!parsed || !Array.isArray(parsed.data)) return { out: raw, added };
    const ids = new Set<string>(parsed.data.map((m) => m.id ?? ''));
    for (const name of advertised) {
      if (name && !ids.has(name)) {
        parsed.data.push({ id: name, object: 'model' });
        ids.add(name);
        added.push(name);
      }
    }
    return { out: added.length > 0 ? Buffer.from(JSON.stringify(parsed), 'utf8') : raw, added };
  } catch {
    return { out: raw, added };
  }
}

/** Model ids from an OpenAI-shaped `{ data: [{ id }] }` body; [] if not parseable. */
export function extractModelIds(raw: Buffer | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as { data?: Array<{ id?: string }> };
    if (!parsed || !Array.isArray(parsed.data)) return [];
    return parsed.data.map((m) => m.id ?? '').filter((id): id is string => id.length > 0);
  } catch {
    return [];
  }
}

// Service types the inline-edit services filter for (nesModels → NESChat,
// cursorJumpModels → CursorJumpChat, instantApplyModels → InstantApplyChat).
export const INLINE_EDIT_SERVICE_TYPES = ['NESChat', 'CursorJumpChat', 'InstantApplyChat'];

/**
 * Build the Copilot-native model list served at GET /models:
 *   - `models`: inline-edit entries `{ serviceType, name, provider,
 *     capabilities }` (NES / CursorJump / InstantApply filter on serviceType)
 *   - `data`: chat entries `{ id, vendor, version, capabilities: { type:
 *     "chat", family, tokenizer } }`; the fallback model is flagged
 *     `is_chat_fallback` (the chat extension refuses to boot without exactly
 *     such a marker).
 * `vendor` is required: the endpoint constructor copies it as
 * `this.modelProvider = e.vendor`, and prompt-resolver matchers call
 * `modelProvider.toLowerCase()` unconditionally — a missing `vendor` throws in
 * `buildPrompt` and kills the turn (`a8e(model)` can also override family).
 * Always valid lists (possibly empty) so the client's getters never crash.
 */
export function synthesizeCopilotModels(
  upstreamIds: string[],
  advertised: string[] | undefined,
  fallback?: string,
): { out: Buffer; names: string[]; chatNames: string[] } {
  // inline-edit list: only what upstream can actually serve (the advertised
  // names have no /v1/engines/<model>/completions route upstream)
  const names = Array.from(new Set([...upstreamIds, ...(fallback ? [fallback] : [])]));
  // chat picker: everything, advertised included
  const chatNames = Array.from(new Set([...names, ...(advertised ?? [])]));
  const models: Array<Record<string, unknown>> = [];
  const data: Array<Record<string, unknown>> = [];
  for (const name of names) {
    for (const serviceType of INLINE_EDIT_SERVICE_TYPES) {
      models.push({
        serviceType,
        name,
        provider: 'copilot',
        capabilities: { promptStrategy: 'default' },
      });
    }
  }
  for (const name of chatNames) {
    data.push({
      id: name,
      name,
      provider: 'copilot',
      modelProvider: 'copilot',
      vendor: 'copilot',
      version: 'unknown',
      is_chat_fallback: name === fallback,
      model_picker_enabled: true,
      capabilities: {
        type: 'chat',
        family: name,
        tokenizer: 'cl100k_base',
        supports: { streaming: true, tool_calls: false, vision: false, thinking: false },
      },
    });
  }
  return { out: Buffer.from(JSON.stringify({ models, data }), 'utf8'), names, chatNames };
}

/**
 * POST /auto — Copilot's "auto mode" router asks which model to use for a
 * prompt. We have no router: always pick the fallback model. The id must
 * match an entry in the /models list (known endpoint); the embedded
 * capabilities are only a fallback if it does not. `expires_at` is in
 * seconds (the client multiplies by 1000).
 */
export function synthesizeAutoDecision(model: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      selected_model: {
        id: model,
        name: model,
        version: 'unknown',
        vendor: 'copilot',
        model_picker_enabled: true,
        capabilities: {
          type: 'chat',
          family: model,
          tokenizer: 'cl100k_base',
          supports: { streaming: true, tool_calls: false, vision: false, thinking: false },
        },
      },
      session_token: 'litellm-router',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// chat-body normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a chat-completions body for the two empty-content shapes Copilot
 * sends, before the upstream LiteLLM mangles them. With modify_params=True
 * (the default), LiteLLM's `_sanitize_empty_text_content()` rewrites every
 * empty *string* content on user/assistant messages to the placeholder
 * "[System: Empty message content sanitised to satisfy protocol]" before the
 * OpenAI→Anthropic hop — and that placeholder is what gets stored in the
 * conversation history and shown in the UI.
 *   - system message with empty/whitespace-only content → dropped
 *   - assistant message with empty/whitespace-only content (tool-call turns
 *     carry content: "") → content becomes null, which the sanitizer leaves
 *     alone and the Anthropic adapter omits as an empty text block
 * Returns undefined when nothing needed changing, or the body is not a JSON
 * chat-completions body.
 */
export function sanitizeChatBody(body: Buffer): { out: Buffer; droppedSystem: number; nulledAssistant: number } | undefined {
  if (body.length === 0) return undefined;
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || !Array.isArray(parsed.messages)) return undefined;
  const kept: Array<Record<string, unknown>> = [];
  let droppedSystem = 0;
  let nulledAssistant = 0;
  for (const raw of parsed.messages as unknown[]) {
    const msg = raw as Record<string, unknown>;
    if (msg && typeof msg === 'object' && typeof msg.content === 'string' && msg.content.trim() === '') {
      const role = typeof msg.role === 'string' ? msg.role : '';
      if (role === 'system') { droppedSystem++; continue; }
      if (role === 'assistant') { msg.content = null; nulledAssistant++; }
    }
    kept.push(msg);
  }
  if (droppedSystem === 0 && nulledAssistant === 0) return undefined;
  parsed.messages = kept;
  return { out: Buffer.from(JSON.stringify(parsed), 'utf8'), droppedSystem, nulledAssistant };
}
