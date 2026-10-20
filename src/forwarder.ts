import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { log } from './logger';
import {
  ENGINES_COMPLETIONS_RE,
  RequestRecord,
  RETRYABLE_ERR_CODES,
  RETRYABLE_STATUS,
  DEFAULT_RETRY_DELAY_MS,
  augmentModelsList,
  extractModel,
  extractModelIds,
  looksLikeModelNotFound,
  rewriteEnginePath,
  rewriteModel,
  sanitizeChatBody,
  synthesizeAutoDecision,
  synthesizeCopilotModels,
  transportRetryDelayMs,
} from './policies';

// re-exported for the existing import sites (doctor's fixture check)
export { sanitizeChatBody } from './policies';

export interface ForwarderOptions {
  /** remote proxy to forward to (e.g. https://litellm.example.com) */
  targetBase: string;
  /** if set, replaces the Authorization header on every forwarded request */
  apiKey?: string;
  port: number;
  /** Copilot model names merged into /v1/models & /models responses so the client can resolve and pick them (modelMap keys) */
  advertisedModels?: string[];
  /** model ID substituted for an unavailable model — a refused request is retried once with this model */
  fallbackModel?: string;
  /** ms to wait for the upstream's first response byte; 0 disables the timeout */
  firstByteTimeoutMs?: number;
}

/**
 * Per-client-request mutable state threaded through forward() and its
 * retries. The record lands in the ring buffer exactly once (on socket
 * close), so latency spans any transparent retries.
 */
interface ForwardState {
  rec: RequestRecord;
  /** the model-fallback retry (unavailable model) happened for this request */
  fallbackRetried: boolean;
  /** a transparent transport retry (connection error / 429 / 5xx) happened */
  transportRetried: boolean;
  /** wall-clock time the client request was received (spans all retries) */
  t0: number;
  /** first-byte timeout of the CURRENT upstream attempt, cleared on response */
  timer: NodeJS.Timeout | undefined;
}

/** ring-buffer capacity for the Recent Requests view */
const RECENT_CAP = 200;

export class Forwarder {
  private server: http.Server | undefined;
  private readonly target: URL;
  private readonly lg = log('forwarder');
  /** newest last; capped at RECENT_CAP; reset when the forwarder restarts */
  private readonly recent: RequestRecord[] = [];

  constructor(private readonly opts: ForwarderOptions) {
    this.target = new URL(opts.targetBase.replace(/\/+$/, '') || 'http://127.0.0.1:4000');
  }

  /** stable serialization of the options, for change detection by the extension */
  get optionsFingerprint(): string {
    return JSON.stringify(this.opts);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  running(): boolean {
    return !!this.server?.listening;
  }

  /** recent forwarded requests, newest first */
  recentRequests(): RequestRecord[] {
    return [...this.recent].reverse();
  }

  clearRecentRequests(): void {
    this.recent.length = 0;
  }

  start(): Promise<void> {
    if (this.running()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('error', () => res.destroy());
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const st: ForwardState = {
            rec: {
              time: new Date().toISOString(),
              method: req.method ?? 'GET',
              path: req.url ?? '/',
              model: extractModel(req.method ?? 'GET', req.url ?? '/', body),
              status: -1,
              latencyMs: -1,
              ttfbMs: -1,
              fallbackRetry: false,
              transportRetry: false,
              outcome: 'client-aborted',
            },
            fallbackRetried: false,
            transportRetried: false,
            t0: Date.now(),
            timer: undefined,
          };
          // The record is finalized exactly once, when the client socket
          // closes (normal end OR early abort), so it covers local answers,
          // piped streams, and every retry in between.
          res.once('close', () => {
            st.rec.latencyMs = Date.now() - st.t0;
            st.rec.outcome = res.writableFinished ? 'done' : (st.rec.error ? 'upstream-error' : 'client-aborted');
            this.recent.push(st.rec);
            if (this.recent.length > RECENT_CAP) this.recent.shift();
          });
          void this.forward(req.method ?? 'GET', req.url ?? '/', req.headers, body, res, st, false);
        });
      });

      // Copilot's experimental WS CAPI transport opens a WebSocket against the
      // CAPI base. We cannot carry WS to the upstream — a bare http server with
      // no 'upgrade' listener would just drop the socket, which looks exactly
      // like "chat isn't routed". Log it loudly and refuse with 501 instead.
      server.on('upgrade', (req, socket) => {
        this.lg.info(
          `WebSocket upgrade refused (forwarder is HTTP-only): ${req.method} ${req.url} — UA ${String(req.headers['user-agent'] ?? '').slice(0, 80)}`,
        );
        try {
          socket.write('HTTP/1.1 501 Unsupported Protocol\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        } catch {
          // socket already gone
        }
        socket.destroy();
      });

      server.on('error', (e: NodeJS.ErrnoException) => {
        this.lg.error('server error', e);
        if (e.code === 'EADDRINUSE') {
          reject(new Error(`port ${this.opts.port} already in use — another VS Code window may be running the forwarder`));
        } else {
          reject(e);
        }
      });
      server.listen(this.opts.port, '127.0.0.1', () => {
        this.server = server;
        this.lg.info(`listening on ${this.baseUrl} → ${this.target.host}`, {
          apiKey: this.opts.apiKey ? 'set' : 'none',
          fallback: this.opts.fallbackModel ?? null,
          firstByteTimeoutMs: this.opts.firstByteTimeoutMs ?? 0,
          advertised: this.opts.advertisedModels ?? [],
        });
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.lg.debug('stopped');
    }
  }

  /** Requests the extension makes itself (status-bar poll) — kept quiet. */
  private static isSelfPoll(headers: http.IncomingHttpHeaders): boolean {
    return headers['x-litellm-router'] === 'status-poll';
  }

  /**
   * Forward one request to the upstream. `st` carries the request record and
   * the two retry flags; each kind of retry may happen at most once per
   * client request (a fallback retry may itself take one transport retry).
   */
  private forward(
    method: string,
    url: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer,
    res: http.ServerResponse,
    st: ForwardState,
    retried: boolean,
  ): void {
    // client went away (e.g. during a retry delay) — nothing left to answer
    if (res.destroyed) return;
    const t = this.target;
    const rec = st.rec;

    // CAPI endpoints LiteLLM does not implement — answered locally, they would
    // otherwise 404 upstream and spam the client.
    const path = url.split('?', 1)[0];
    if (method === 'POST' && path === '/auto') {
      const model = this.opts.fallbackModel ?? this.opts.advertisedModels?.[0];
      if (model) {
        const out = synthesizeAutoDecision(model);
        this.lg.info(`POST /auto → local auto-decision (selected_model=${model})`);
        rec.status = 200;
        rec.ttfbMs = 0;
        res.writeHead(200, fullBodyHeaders({ 'content-type': 'application/json' }, out.length));
        res.end(out);
        return;
      }
    }
    if (method === 'GET' && path === '/agents') {
      const out = Buffer.from('{"agents":[]}', 'utf8');
      this.lg.info('GET /agents → local empty agent list (upstream has no agent routes)');
      rec.status = 200;
      rec.ttfbMs = 0;
      res.writeHead(200, fullBodyHeaders({ 'content-type': 'application/json' }, out.length));
      res.end(out);
      return;
    }

    // Copilot inline completions hit /v1/engines/<model>/completions, which the
    // upstream has no route for. The body ({prompt, max_tokens}) is identical
    // to OpenAI's legacy /v1/completions — rewrite and let the normal
    // model-fallback retry handle the model segment.
    if (ENGINES_COMPLETIONS_RE.test(path)) {
      this.lg.info(`${method} ${url}: engine path — rewriting to /v1/completions`);
      url = '/v1/completions' + url.slice(path.length);
    }

    // Copilot sends assistant tool-call turns with content: "" and an
    // occasionally-blank system prompt. Forwarded as-is, the upstream
    // LiteLLM's modify_params rewrites those empty strings into a visible
    // placeholder ("[System: Empty message content sanitised…]") that then
    // persists in the conversation history — normalize them here instead.
    if (method === 'POST' && path.endsWith('/chat/completions') && body.length > 0) {
      const fixed = sanitizeChatBody(body);
      if (fixed) {
        this.lg.info(
          `POST ${url}: message filter — dropped ${fixed.droppedSystem} empty system message(s), nulled ${fixed.nulledAssistant} empty assistant content(s)`,
        );
        body = fixed.out;
      }
    }

    // Every real client request is logged at info — at the default level the
    // output channel must show evidence of exactly what Copilot sent.
    // NB: call the method directly (this.lg.debug(...)) — a detached reference
    // like `(c ? this.lg.debug : this.lg.info)(...)` loses `this` and throws.
    if (Forwarder.isSelfPoll(headers)) {
      this.lg.debug(`${method} ${url} (${body.length}B) → ${t.host}${retried ? ' [fallback retry]' : ''}`);
    } else {
      this.lg.info(`${method} ${url} (${body.length}B) → ${t.host}${retried ? ' [fallback retry]' : ''}`);
    }
    const client = t.protocol === 'http:' ? http : https;
    const out: http.OutgoingHttpHeaders = { ...headers, host: t.host };
    if (this.opts.apiKey) {
      out.authorization = `Bearer ${this.opts.apiKey}`;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      out['content-length'] = body.length;
    }
    try {
      const fwd = client.request(
        {
          protocol: t.protocol,
          hostname: t.hostname,
          port: t.port || (t.protocol === 'https:' ? 443 : 80),
          path: url,
          method,
          headers: out,
        },
        (up) => {
          void this.handleUpstream(method, url, headers, body, up, res, st);
        },
      );

      // First-byte timeout: no upstream response headers within the budget
      // means the client's turn hangs for no visible reason — kill the socket
      // so the error handler converts it into a retry or a 504.
      const timeoutMs = this.opts.firstByteTimeoutMs ?? 0;
      if (timeoutMs > 0) {
        st.timer = setTimeout(() => {
          this.lg.warn(`${method} ${url}: no response headers from ${t.host} within ${timeoutMs}ms`);
          fwd.destroy(new Error(`first-byte timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        // don't keep the process alive for a long chat stream
        st.timer.unref?.();
      }

      fwd.on('error', (e) => {
        const isTimeout = /first-byte timeout/i.test(String(e));
        const code = (e as NodeJS.ErrnoException).code ?? '';
        this.lg.error(`${method} ${url}: upstream request failed${isTimeout ? ' (timeout)' : ''}`, e);
        // transparent retry only while NOTHING has been sent to the client —
        // once headers are out mid-stream, a half-open drop is handled by the
        // pipe path in handleUpstream instead
        const retryable = !res.headersSent && (isTimeout || RETRYABLE_ERR_CODES.has(code));
        if (retryable && !st.transportRetried && !res.destroyed) {
          if (st.timer) {
            clearTimeout(st.timer);
            st.timer = undefined;
          }
          const delay = DEFAULT_RETRY_DELAY_MS;
          st.transportRetried = true;
          rec.transportRetry = true;
          this.lg.warn(`${method} ${url}: retrying once in ${delay}ms (transport error: ${isTimeout ? 'timeout' : code || String(e)})`);
          setTimeout(() => this.forward(method, url, headers, body, res, st, false), delay);
          return;
        }
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) {
          rec.status = isTimeout ? 504 : 502;
          rec.error = isTimeout
            ? `upstream first-byte timeout (${timeoutMs}ms)`
            : `upstream request failed: ${code || String(e)}`;
          res.writeHead(rec.status, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { message: `forwarder: ${String(e)}` } }));
      });
      if (body.length > 0) fwd.write(body);
      fwd.end();
    } catch (e) {
      if (!res.headersSent) {
        rec.status = 502;
        rec.error = `upstream request failed: ${String(e)}`;
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: `forwarder: ${String(e)}` } }));
    }
  }

  private async handleUpstream(
    method: string,
    url: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer,
    up: http.IncomingMessage,
    res: http.ServerResponse,
    st: ForwardState,
  ): Promise<void> {
    const rec = st.rec;
    if (res.destroyed) {
      // client left before the upstream answered — drop the upstream stream
      up.destroy();
      return;
    }
    // response headers arrived — cancel this attempt's first-byte timeout
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
    const status = up.statusCode ?? 502;
    // direct method calls only — see the note in forward() about detached `this`
    if (Forwarder.isSelfPoll(headers)) {
      this.lg.debug(`${method} ${url} ← ${status}`);
    } else {
      this.lg.info(`${method} ${url} ← ${status}`);
    }
    if (rec.ttfbMs < 0) rec.ttfbMs = Date.now() - st.t0;
    const contentType = String(up.headers['content-type'] ?? '');
    const isJson = contentType.includes('application/json');
    const isEncoded = !!up.headers['content-encoding'];

    // Transparent transport retry: the upstream answered 429/5xx (or the
    // client is still waiting on nothing) before we sent a single byte, so we
    // may retry the whole request once. Delay comes from Retry-After /
    // "try again in N" hints. The model-fallback retry below covers
    // 400/403/404 — the sets are disjoint.
    if (!st.transportRetried && RETRYABLE_STATUS.has(status) && !isEncoded && !res.destroyed) {
      const errBody = await this.bufferUpstream(up, 64 * 1024);
      if (errBody === null) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forwarder: error response too large to retry' } }));
        return;
      }
      const delay = transportRetryDelayMs(up.headers, errBody.toString('utf8').slice(0, 2000));
      st.transportRetried = true;
      rec.transportRetry = true;
      this.lg.warn(`${method} ${url}: upstream ${status} — retrying once in ${delay}ms`);
      setTimeout(() => this.forward(method, url, headers, body, res, st, false), delay);
      return;
    }

    // OpenAI-shaped list (chat picker / language-model resolution). Merge
    // advertised Copilot model names in so the client's model cache contains
    // them ("Could not find model X in local cache" → Language model
    // unavailable). Everything else stays raw.
    if (method === 'GET' && isV1ModelsPath(url)) {
      const raw = await this.bufferUpstream(up, 1024 * 1024);
      if (raw === null) {
        this.lg.warn('GET /v1/models: upstream response too large to buffer — returning 502');
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forwarder: model list too large to process' } }));
        return;
      }
      const advertised = this.opts.advertisedModels ?? [];
      const { out, added } = status === 200 && isJson && !isEncoded
        ? augmentModelsList(raw, advertised)
        : { out: raw, added: [] as string[] };
      // The 30s status-bar poll hits this path too — it must not masquerade
      // as Copilot model-picker traffic.
      if (added.length > 0) {
        const mergedMsg = `GET /v1/models: merged ${added.length} advertised model(s) into upstream list — ${added.join(', ')}`;
        if (Forwarder.isSelfPoll(headers)) {
          this.lg.debug(mergedMsg);
        } else {
          this.lg.info(mergedMsg);
        }
      } else {
        this.lg.debug(`GET /v1/models: passed through unchanged (status ${status}, ${advertised.length} advertised already present or n/a)`);
      }
      rec.status = status;
      res.writeHead(status, isEncoded ? up.headers : fullBodyHeaders(up.headers, out.length));
      res.end(out);
      return;
    }

    // Copilot-native model list. Two consumers hit this same path:
    //   - inline-edit services read `{ models: [{ serviceType, name, … }] }`
    //     (LiteLLM's OpenAI shape crashes their `this._models?.models.filter`)
    //   - the chat picker (VS Code ≥ 1.139) reads `{ data: […] }` where each
    //     entry needs `capabilities.type === "chat"`, and exactly one chat
    //     entry must carry `is_chat_fallback: true` or utility-model
    //     resolution throws "server did not mark a chat fallback model".
    // Serve both keys from whatever the upstream reports.
    if (method === 'GET' && isCopilotModelsPath(url)) {
      const raw = await this.bufferUpstream(up, 1024 * 1024);
      const { out, names, chatNames } = synthesizeCopilotModels(extractModelIds(raw), this.opts.advertisedModels, this.opts.fallbackModel);
      this.lg.info(
        `GET /models: synthesized list — chat: ${chatNames.length} (${chatNames.join(', ') || 'none'}), inline-edit: ${names.length} (${names.join(', ') || 'none'})`,
      );
      rec.status = 200;
      res.writeHead(200, fullBodyHeaders({ 'content-type': 'application/json' }, out.length));
      res.end(out);
      return;
    }

    // The upstream refused the requested model (404/400 "model not found",
    // or LiteLLM's 403 team-scoped "not allowed to access model"): retry once
    // with the configured fallback model. Only JSON error bodies qualify —
    // SSE streams, quota/auth errors and anything already retried pass
    // through untouched. (A 403 that is *not* about the model — e.g. a bad
    // key — fails looksLikeModelNotFound below and is passed through.)
    if (
      !st.fallbackRetried &&
      method !== 'GET' &&
      isJson &&
      !isEncoded &&
      (status === 400 || status === 403 || status === 404) &&
      this.opts.fallbackModel
    ) {
      const errBody = await this.bufferUpstream(up, 64 * 1024);
      if (errBody === null) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forwarder: error response too large to process' } }));
        return;
      }
      const next = looksLikeModelNotFound(errBody.toString('utf8'))
        ? rewriteModel(body, this.opts.fallbackModel)
        : undefined;
      if (next) {
        this.lg.warn(
          `${method} ${url}: upstream ${status} — model unavailable, retrying with fallback "${this.opts.fallbackModel}"`,
          errBody.toString('utf8').slice(0, 300),
        );
        st.fallbackRetried = true;
        rec.fallbackRetry = true;
        this.forward(method, rewriteEnginePath(url, this.opts.fallbackModel), headers, next, res, st, true);
        return;
      }
      this.lg.debug(`${method} ${url}: upstream ${status} passed through (not a model-not-found error)`);
      rec.status = status;
      res.writeHead(status, fullBodyHeaders(up.headers, errBody.length));
      res.end(errBody);
      return;
    }

    // Default: pipe through untouched — SSE and JSON alike.
    rec.status = status;
    res.writeHead(status, up.headers);
    // mid-stream upstream drop: pipe() does not forward 'error' — without
    // this the client socket hangs on a half-open SSE stream
    up.on('error', (e) => {
      this.lg.error(`${method} ${url}: upstream stream error mid-response`, e);
      rec.error = String(e);
      if (!res.writableFinished) res.destroy();
    });
    up.pipe(res);
  }

  /** Read the whole upstream response body; null if it exceeds `cap`. */
  private bufferUpstream(up: http.IncomingMessage, cap: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (b: Buffer | null): void => {
        if (!done) {
          done = true;
          resolve(b);
        }
      };
      up.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > cap) {
          up.destroy();
          finish(null);
          return;
        }
        chunks.push(c);
      });
      up.on('end', () => finish(Buffer.concat(chunks)));
      up.on('error', () => finish(Buffer.concat(chunks)));
    });
  }
}

function isV1ModelsPath(url: string): boolean {
  return url.split('?', 1)[0] === '/v1/models';
}

function isCopilotModelsPath(url: string): boolean {
  return url.split('?', 1)[0] === '/models';
}

/** Headers for a response sent as one full body (no chunked framing). */
function fullBodyHeaders(h: http.IncomingHttpHeaders, length: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...h };
  delete out['transfer-encoding'];
  out['content-length'] = length;
  return out;
}
