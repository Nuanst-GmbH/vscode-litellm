import { log } from './logger';

// config.yml rendering moved to configRender.ts (pure, unit-testable in plain
// Node) — re-exported here so existing import sites keep working
export { renderLiteLLMConfig } from './configRender';
export type { ExportOptions } from './configRender';

const lg = log('proxy');

export interface ProxyStatus {
  reachable: boolean;
  /** true when the proxy answered on a LiteLLM health endpoint */
  isLiteLLM: boolean;
  models: string[];
  message: string;
}

const TIMEOUT_MS = 5000;

/**
 * Marks requests the extension makes itself (status-bar poll, test
 * connection). The forwarder logs these at debug instead of info so the
 * output channel shows only real Copilot traffic.
 */
const SELF_POLL_HEADERS = { 'x-litellm-router': 'status-poll' };

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Check a proxy at `baseUrl`. A LiteLLM proxy answers /health/liveliness and
 * /v1/models. A generic OpenAI-compatible proxy may only answer /v1/models —
 * we still count it as reachable in that case (isLiteLLM=false).
 */
export async function checkProxy(baseUrl: string): Promise<ProxyStatus> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) {
    return { reachable: false, isLiteLLM: false, models: [], message: 'proxyBaseUrl is empty' };
  }

  let healthOk = false;
  try {
    const res = await fetch(`${base}/health/liveliness`, { signal: withTimeout(TIMEOUT_MS), headers: SELF_POLL_HEADERS });
    healthOk = res.ok;
    lg.debug(`${base}/health/liveliness → ${res.status}${healthOk ? '' : ' (not ok)'}`);
  } catch (err) {
    healthOk = false;
    lg.debug(`${base}/health/liveliness failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const models: string[] = [];
  try {
    const res = await fetch(`${base}/v1/models`, { signal: withTimeout(TIMEOUT_MS), headers: SELF_POLL_HEADERS });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      for (const m of body.data ?? []) {
        if (m.id) models.push(m.id);
      }
      lg.debug(`${base}/v1/models → ${res.status} (${models.length} models)`);
    } else {
      lg.debug(`${base}/v1/models → ${res.status}`);
    }
  } catch (err) {
    // fall through — health status is reported below
    lg.debug(`${base}/v1/models failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (healthOk) {
    return {
      reachable: true,
      isLiteLLM: true,
      models,
      message: models.length > 0
        ? `${models.length} model(s) available: ${models.slice(0, 5).join(', ')}${models.length > 5 ? ', …' : ''}`
        : 'LiteLLM is up but reported no models',
    };
  }
  if (models.length > 0) {
    return {
      reachable: true,
      isLiteLLM: false,
      models,
      message: `OpenAI-compatible proxy (no /health/liveliness). ${models.length} model(s)`,
    };
  }
  return {
    reachable: false,
    isLiteLLM: false,
    models: [],
    message: `nothing answering at ${base} (tried /health/liveliness and /v1/models)`,
  };
}

