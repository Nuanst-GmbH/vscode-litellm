/**
 * Pure text for "LiteLLM Proxy: Report Issue".
 *
 * The command never uploads this itself. It opens a GitHub new-issue URL
 * with the diagnostics field filled in; GitHub receives it only if the user
 * submits. Keep this file free of vscode and http so the redaction rules
 * stay unit-tested.
 *
 * `BUG_REPORT_URL` must match `bugs.url` in package.json.
 */

export const REPO_WEB = 'https://github.com/Nuanst-GmbH/vscode-litellm';
export const BUG_REPORT_TEMPLATE = 'bug_report.yml';
export const BUG_REPORT_URL = `${REPO_WEB}/issues/new?template=${BUG_REPORT_TEMPLATE}`;

/** Newest-first cap. Matches the privacy statement. */
export const MAX_RECENT = 10;
export const MAX_MODEL_MAP = 50;
export const MAX_ERROR_CHARS = 180;
/** Stay under common browser / GitHub URL limits after encoding. */
export const MAX_ISSUE_URL_CHARS = 7500;

export type ApiKeySource = 'secret' | 'settings' | 'none';

export interface IssueReportRecent {
  time: string;
  method: string;
  path: string;
  model: string;
  status: number;
  latencyMs: number;
  ttfbMs: number;
  outcome: string;
  fallbackRetry: boolean;
  transportRetry: boolean;
  error?: string;
}

export interface IssueReportInput {
  extensionVersion: string;
  vscodeVersion: string;
  appName: string;
  /** 'desktop' or 'web' */
  uiKind: string;
  /** vscode.env.remoteName (`wsl`, `ssh-remote`, …) or '' when local */
  remoteName: string;
  platform: string;
  arch: string;
  copilotChatVersion: string;
  enabled: boolean;
  proxyBaseUrl: string;
  forwarderEnabled: boolean;
  forwarderPort: number;
  forwarderRunning: boolean;
  apiKeySource: ApiKeySource;
  fallbackModel: string;
  defaultDeployment: string;
  deploymentApiBase: string;
  modelMap: Record<string, string>;
  surfaces: { chat: boolean; agents: boolean; completions: boolean; nes: boolean };
  requestTimeoutMs: number;
  statusPollIntervalMs: number;
  logLevel: string;
  recent: IssueReportRecent[];
}

/** Drop credentials and fragments from a URL. Invalid URLs lose `user:pass@` only. */
export function redactUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    u.username = '';
    u.password = '';
    u.hash = '';
    let out = u.toString();
    if (!trimmed.endsWith('/') && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return trimmed.replace(/(\/\/)[^/@\s]+@/, '$1');
  }
}

/**
 * Path only. Query strings are dropped because they can carry tokens.
 * The caller still runs {@link redactSecrets} on the finished report.
 */
export function redactPath(path: string): string {
  const q = path.indexOf('?');
  if (q === -1) return path;
  return `${path.slice(0, q)}?[query redacted]`;
}

/** Bearer tokens, `sk-…` keys, and `api_key=` / `authorization=` assignments. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|authorization)\s*[:=]\s*["']?)[^\s"']+/gi, '$1[redacted]');
}

function onOff(v: boolean): string {
  return v ? 'on' : 'off';
}

function fmtMs(n: number): string {
  if (n < 0) return '-';
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function apiKeyLabel(source: ApiKeySource): string {
  if (source === 'secret') return 'set in SecretStorage';
  if (source === 'settings') return 'set in settings.json';
  return 'not set';
}

/**
 * Diagnostics block placed in the GitHub issue form.
 * Does not contain API key values, prompt bodies, or workspace paths.
 */
export function buildDiagnostics(input: IssueReportInput): string {
  const lines: string[] = [];
  const remote = input.remoteName ? `, remote ${input.remoteName}` : '';
  lines.push('LiteLLM Proxy diagnostics');
  lines.push(`extension: ${input.extensionVersion}`);
  lines.push(`vscode: ${input.vscodeVersion} (${input.appName}, ${input.uiKind}${remote})`);
  lines.push(`os: ${input.platform} ${input.arch}`);
  lines.push(`copilot chat: ${input.copilotChatVersion}`);
  lines.push(`routing: ${onOff(input.enabled)}`);
  lines.push(
    `surfaces: chat=${onOff(input.surfaces.chat)} agents=${onOff(input.surfaces.agents)} ` +
    `completions=${onOff(input.surfaces.completions)} nes=${onOff(input.surfaces.nes)}`,
  );
  lines.push(`proxy: ${redactUrl(input.proxyBaseUrl) || '(empty)'}`);
  lines.push(
    `forwarder: ${onOff(input.forwarderEnabled)} port ${input.forwarderPort} ` +
    `listening ${input.forwarderRunning ? 'yes' : 'no'}`,
  );
  lines.push(`api key: ${apiKeyLabel(input.apiKeySource)}`);
  lines.push(`fallback model: ${input.fallbackModel || '(empty)'}`);
  lines.push(`default deployment: ${input.defaultDeployment || '(empty)'}`);
  lines.push(`deployment api base: ${redactUrl(input.deploymentApiBase) || '(empty)'}`);
  lines.push(`request timeout ms: ${input.requestTimeoutMs}`);
  lines.push(`status poll ms: ${input.statusPollIntervalMs}`);
  lines.push(`log level: ${input.logLevel}`);

  const entries = Object.entries(input.modelMap);
  lines.push(`model map (${entries.length}):`);
  const shown = entries.slice(0, MAX_MODEL_MAP);
  if (shown.length === 0) lines.push('  (empty)');
  for (const [from, to] of shown) lines.push(`  ${from} -> ${to}`);
  if (entries.length > shown.length) lines.push(`  … ${entries.length - shown.length} more omitted`);

  const recent = input.recent.slice(0, MAX_RECENT);
  lines.push(`recent requests (${recent.length} of ${input.recent.length}, newest first, no bodies):`);
  if (recent.length === 0) lines.push('  (none)');
  for (const r of recent) {
    const err = r.error ? ` error ${clip(r.error, MAX_ERROR_CHARS)}` : '';
    lines.push(
      `  ${r.time} ${r.method} ${redactPath(r.path)} model ${r.model || '-'} ` +
      `status ${r.status < 0 ? '-' : r.status} latency ${fmtMs(r.latencyMs)} ` +
      `ttfb ${fmtMs(r.ttfbMs)} ${r.outcome}` +
      `${r.fallbackRetry ? ' fallback-retry' : ''}` +
      `${r.transportRetry ? ' transport-retry' : ''}` +
      err,
    );
  }
  return redactSecrets(lines.join('\n'));
}

function withDiagnostics(templateUrl: string, diagnostics: string): string {
  const u = new URL(templateUrl);
  u.searchParams.set('diagnostics', diagnostics);
  return u.toString();
}

/**
 * New-issue URL for `templateUrl` (normally {@link BUG_REPORT_URL}) with the
 * diagnostics field set. Shrinks the field until the URL fits {@link MAX_ISSUE_URL_CHARS}.
 */
export function reportIssueUrl(templateUrl: string, diagnostics: string): string {
  const note = '\n[truncated to fit the issue link]';
  let body = diagnostics;
  let url = withDiagnostics(templateUrl, body);
  let guard = 0;
  while (url.length > MAX_ISSUE_URL_CHARS && body.length > note.length && guard < 20) {
    guard++;
    const over = url.length - MAX_ISSUE_URL_CHARS;
    const nextLen = Math.max(0, body.length - Math.max(over, 64) - note.length);
    body = diagnostics.slice(0, nextLen) + note;
    url = withDiagnostics(templateUrl, body);
  }
  return url;
}
