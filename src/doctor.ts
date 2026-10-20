import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { OVERRIDES } from './copilotSettings';
import { checkProxy } from './proxy';
import { readModelMap } from './modelMap';
import { sanitizeChatBody } from './forwarder';
import { checkCopilotBuild, detectCopilotBuild } from './copilotVersions';
import { log } from './logger';

const execFileP = promisify(execFile);
const lg = log('doctor');

type Severity = 'ok' | 'warn' | 'error';

interface Finding {
  severity: Severity;
  label: string;
  detail?: string;
  fix?: string;
}

interface DoctorInput {
  context: vscode.ExtensionContext;
  /** whether this window's forwarder instance is currently listening */
  forwarderRunning: boolean;
  /** true when the forwarder key comes from SecretStorage (not settings.json) */
  keyFromSecret?: boolean;
}

const ICON: Record<Severity, string> = { ok: '✓', warn: '⚠', error: '✗' };

/**
 * Run every check that "why is fallback not working" needs and render a report
 * to the "LiteLLM Doctor" output channel, then surface a summary toast.
 */
export async function runDoctor(input: DoctorInput): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('vscode-litellm');
  const findings: Finding[] = [];

  const enabled = cfg.get<boolean>('enabled', true);
  const proxyBaseUrl = (cfg.get<string>('proxyBaseUrl', 'http://localhost:4000') ?? '').trim();
  const fwdEnabled = cfg.get<boolean>('forwarder.enabled', false);
  const port = cfg.get<number>('forwarder.port', 4141) || 4141;
  const apiKey = (cfg.get<string>('forwarder.apiKey', '') || cfg.get<string>('deployment.apiKey', '')).trim();
  const fallbackModel = (cfg.get<string>('forwarder.fallbackModel', '') ?? '').trim();
  const modelMap = readModelMap();
  const surfaces = {
    chat: cfg.get<boolean>('surfaces.chat', true),
    agents: cfg.get<boolean>('surfaces.agents', true),
    completions: cfg.get<boolean>('surfaces.completions', true),
    nes: cfg.get<boolean>('surfaces.nes', true),
  };
  const effectiveBase = fwdEnabled ? `http://127.0.0.1:${port}` : proxyBaseUrl;
  const requestTimeoutMs = cfg.get<number>('forwarder.requestTimeoutMs', 30000);
  const statusPollIntervalMs = cfg.get<number>('statusPollIntervalMs', 30000);

  findings.push(...checkVersion(input.context));
  findings.push(...checkCopilotBuildCheck());
  findings.push(...checkMessageFilter());
  findings.push(...checkSettings({
    enabled, proxyBaseUrl, fwdEnabled, apiKey, fallbackModel, modelMap,
    keyFromSecret: input.keyFromSecret ?? false, requestTimeoutMs, statusPollIntervalMs,
  }));
  findings.push(...checkOverrides({ enabled, effectiveBase, surfaces }));
  findings.push(...(await checkPort(fwdEnabled, port, input.forwarderRunning)));
  if (enabled && proxyBaseUrl) {
    findings.push(...(await checkProxyReachable(effectiveBase, proxyBaseUrl)));
  }
  if (enabled && fwdEnabled && surfaces.chat) {
    findings.push(...(await checkChatSurface(effectiveBase, fallbackModel, modelMap)));
    findings.push(...(await checkWsUpgrade(port, input.forwarderRunning)));
  }

  await render(findings, input.context);
  summarize(findings);
}

/** 1. Is this window running the newest installed build? */
function checkVersion(context: vscode.ExtensionContext): Finding[] {
  const running = __LITELLM_EXT_VERSION__;
  const out: Finding[] = [];
  const installed = listInstalledVersions(context);
  const latest = installed.length > 0 ? installed.reduce((a, b) => (cmpVer(a, b) >= 0 ? a : b)) : undefined;
  if (!latest) {
    out.push({ severity: 'warn', label: `could not enumerate installed builds (running v${running})` });
    return out;
  }
  if (cmpVer(latest, running) > 0) {
    out.push({
      severity: 'error',
      label: `this window is running an old build — v${running} in memory, but v${latest} is installed`,
      detail: 'You installed a newer vsix but did not reload, so the running code is stale (this is the usual cause of "fixes not taking effect").',
      fix: 'Run "LiteLLM Proxy: Reload (restart this window)" or Developer: Reload Window.',
    });
  } else if (cmpVer(latest, running) < 0) {
    out.push({ severity: 'ok', label: `running build v${running} is newer than the newest installed (v${latest}) — dev/unreleased build` });
  } else {
    out.push({ severity: 'ok', label: `running build is current (v${running})` });
  }
  return out;
}

/** 1b. Is the running Copilot build within the verified range for the override keys? */
function checkCopilotBuildCheck(): Finding[] {
  try {
    const { vscodeVersion, chatVersion } = detectCopilotBuild();
    const c = checkCopilotBuild(vscodeVersion, chatVersion);
    return [{
      severity: c.severity,
      label: c.label,
      detail: c.detail,
      fix: c.severity === 'warn' ? 'If routing is broken on this build, verify the keys per docs/spike.md and extend VERIFIED_BUILDS.' : undefined,
    }];
  } catch (err) {
    return [{ severity: 'warn', label: 'could not detect the Copilot build', detail: String(err) }];
  }
}

/**
 * Does the message filter normalize the two empty-content shapes
 * Copilot sends (blank system prompt, tool-call assistant turn with
 * content: "")? Runs the filter from the running build on a fixture —
 * a pass proves this window's bundle ships a working filter; a failure
 * means the filter is broken or was removed by a regression.
 */
function checkMessageFilter(): Finding[] {
  const fixture = Buffer.from(JSON.stringify({
    model: 'fixture',
    messages: [
      { role: 'system', content: '' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
      { role: 'user', content: 'ping' },
    ],
  }));
  try {
    const res = sanitizeChatBody(fixture);
    if (!res) {
      return [{
        severity: 'error',
        label: 'message filter not active: empty-content fixture was not rewritten',
        detail: 'The filter returned nothing to change for a body it must rewrite — it is broken in this build.',
        fix: 'Report the finding; a reload picks up the next published build.',
      }];
    }
    const msgs = (JSON.parse(res.out.toString('utf8')) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    const problems: string[] = [];
    if (msgs.some((m) => m.role === 'system')) problems.push('empty system message was not dropped');
    const asst = msgs.find((m) => m.role === 'assistant');
    if (!asst) problems.push('assistant (tool-call) message was dropped');
    else if (asst.content !== null) problems.push(`assistant content should be null, got ${JSON.stringify(asst.content)}`);
    if (!msgs.some((m) => m.role === 'user' && m.content === 'ping')) problems.push('untouched user message was modified');
    if (problems.length > 0) {
      return [{ severity: 'error', label: 'message filter misbehaving', detail: problems.join('; ') }];
    }
    return [{
      severity: 'ok',
      label: `message filter normalizes empty content (system dropped, assistant content → null: ${res.droppedSystem}/${res.nulledAssistant})`,
    }];
  } catch (err) {
    return [{ severity: 'error', label: 'message filter check failed', detail: String(err instanceof Error ? err.message : err) }];
  }
}

/** 2. Are the settings the fallback feature depends on actually present? */
function checkSettings(a: {
  enabled: boolean; proxyBaseUrl: string; fwdEnabled: boolean;
  apiKey: string; fallbackModel: string; modelMap: Record<string, string>;
  keyFromSecret: boolean; requestTimeoutMs: number; statusPollIntervalMs: number;
}): Finding[] {
  const out: Finding[] = [];
  out.push(a.enabled
    ? { severity: 'ok', label: 'routing enabled' }
    : { severity: 'error', label: 'routing is DISABLED', fix: 'Run "LiteLLM Proxy: Toggle Routing".' });

  out.push(a.proxyBaseUrl
    ? { severity: 'ok', label: `proxy base set: ${a.proxyBaseUrl}` }
    : { severity: 'error', label: 'proxyBaseUrl is empty', fix: 'Set vscode-litellm.proxyBaseUrl.' });

  out.push(a.fwdEnabled
    ? { severity: 'ok', label: 'forwarder enabled (required for fallback + model advertisement + key swap)' }
    : { severity: 'warn', label: 'forwarder is DISABLED', detail: 'without it there is no fallback retry and no model-name advertisement — Copilot talks straight to the proxy.', fix: 'Set vscode-litellm.forwarder.enabled = true.' });

  out.push(a.fallbackModel
    ? { severity: 'ok', label: `fallback model set: ${a.fallbackModel}` }
    : { severity: 'warn', label: 'forwarder.fallbackModel is empty', detail: 'unavailable models will not be retried on a substitute.', fix: 'Set vscode-litellm.forwarder.fallbackModel to a model your proxy serves (e.g. gpt-4o).' });

  if (a.keyFromSecret) {
    out.push({ severity: 'ok', label: 'forwarder API key stored in SecretStorage (secure)' });
  } else {
    out.push(a.apiKey
      ? { severity: 'ok', label: 'forwarder API key set (plain text in settings.json — consider "Store API key securely")' }
      : { severity: 'warn', label: 'no API key set', detail: 'fine only if the proxy does not enforce an API key.', fix: 'Set vscode-litellm.forwarder.apiKey (or deployment.apiKey), or run "LiteLLM Proxy: Store API key securely".' });
  }

  if (typeof a.requestTimeoutMs !== 'number' || !Number.isFinite(a.requestTimeoutMs) || a.requestTimeoutMs < 0) {
    out.push({ severity: 'error', label: `forwarder.requestTimeoutMs is invalid (${String(a.requestTimeoutMs)})`, fix: 'Set a non-negative integer (ms) or 0 to disable.' });
  } else {
    out.push({ severity: 'ok', label: a.requestTimeoutMs === 0 ? 'forwarder first-byte timeout disabled' : `forwarder first-byte timeout: ${a.requestTimeoutMs}ms` });
  }

  if (typeof a.statusPollIntervalMs !== 'number' || !Number.isFinite(a.statusPollIntervalMs) || a.statusPollIntervalMs < 5000) {
    out.push({ severity: 'warn', label: `statusPollIntervalMs is ${String(a.statusPollIntervalMs)} — values below 5000 are clamped`, fix: 'Set vscode-litellm.statusPollIntervalMs to ≥ 5000.' });
  } else {
    out.push({ severity: 'ok', label: `status-bar poll interval: ${a.statusPollIntervalMs}ms` });
  }

  out.push(Object.keys(a.modelMap).length > 0
    ? { severity: 'ok', label: `model map has ${Object.keys(a.modelMap).length} entr${Object.keys(a.modelMap).length === 1 ? 'y' : 'ies'}: ${Object.entries(a.modelMap).map(([k, v]) => `${k}→${v || '(default)'}`).join(', ')}` }
    : { severity: 'warn', label: 'model map is empty', detail: 'Copilot model names will not be advertised to the client.', fix: 'Run "LiteLLM Proxy: Configure Model Map".' });
  return out;
}

/** 3. Do the hidden Copilot override keys actually point at the forwarder? */
function checkOverrides(a: {
  enabled: boolean; effectiveBase: string;
  surfaces: { chat: boolean; agents: boolean; completions: boolean; nes: boolean };
}): Finding[] {
  const out: Finding[] = [];
  const base = a.enabled ? a.effectiveBase : '';
  const capi = a.enabled && (a.surfaces.chat || a.surfaces.agents) && base ? base : '';
  const proxy = a.enabled && (a.surfaces.completions || a.surfaces.nes) && base ? base : '';
  const wrong: string[] = [];
  let correct = 0;
  for (const o of OVERRIDES) {
    const expected = o.kind === 'capi' ? capi : proxy;
    const actual = vscode.workspace.getConfiguration().get<string>(o.key) ?? '';
    if (actual === expected) correct++;
    else wrong.push(`${o.key}\n        = "${actual}"   (expected "${expected || 'empty'}")`);
  }
  if (wrong.length === 0) {
    out.push({ severity: 'ok', label: `all ${OVERRIDES.length} Copilot override keys point at ${base || '(nothing — routing off)'}` });
  } else {
    out.push({
      severity: 'warn',
      label: `${correct}/${OVERRIDES.length} override keys correct — Copilot may not be routed`,
      detail: wrong.join('\n'),
      fix: 'Run "LiteLLM Proxy: Toggle Routing", then reload the window.',
    });
  }
  return out;
}

/** 4. Is the forwarder actually owning its port (or is a stale window holding it)? */
async function checkPort(fwdEnabled: boolean, port: number, running: boolean): Promise<Finding[]> {
  const out: Finding[] = [];
  if (!fwdEnabled) {
    out.push({ severity: 'ok', label: 'forwarder disabled — no local port expected' });
    return out;
  }
  if (running) {
    out.push({ severity: 'ok', label: `forwarder is listening on 127.0.0.1:${port}` });
    return out;
  }
  const open = await probePort('127.0.0.1', port);
  if (open) {
    const owner = await findPortOwner(port);
    out.push({
      severity: 'error',
      label: `port ${port} is already held — this window's forwarder is NOT the owner`,
      detail: owner ? `held by ${owner}` : undefined,
      fix: 'A stale VS Code window is usually the culprit. Close the other window (or kill that PID), then reload this window.',
    });
  } else {
    out.push({
      severity: 'error',
      label: `forwarder should be listening on 127.0.0.1:${port} but is not`,
      detail: 'nothing is bound to the port and this window reports no forwarder — it likely failed to start.',
      fix: 'Run "LiteLLM Proxy: Reload (restart this window)" and check the vscode-litellm output for a start error.',
    });
  }
  return out;
}

/** 5. Can we actually reach the endpoint Copilot will use? */
async function checkProxyReachable(effectiveBase: string, remote: string): Promise<Finding[]> {
  const label = effectiveBase === remote ? remote : `${effectiveBase} → ${remote}`;
  const status = await checkProxy(effectiveBase);
  return [status.reachable
    ? { severity: 'ok', label: `endpoint reachable: ${status.message}`, detail: `checked ${label}` }
    : { severity: 'error', label: `endpoint not reachable: ${status.message}`, detail: `checked ${label}` }];
}

/**
 * 6. Does a real chat-shaped request make it through the forwarder to the
 * upstream? Sends one tiny (1-token) completion so the cost is negligible;
 * the request shows up in the vscode-litellm output as a POST, which is also
 * proof that chat traffic is visible there.
 */
async function checkChatSurface(base: string, fallbackModel: string, modelMap: Record<string, string>): Promise<Finding[]> {
  const model = fallbackModel || Object.values(modelMap).find((v) => v) || 'gpt-4o';
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.ok) {
      return [{ severity: 'ok', label: `chat path works end-to-end: POST /chat/completions via ${base} → upstream 200 (model "${model}")` }];
    }
    return [{
      severity: 'warn',
      label: `chat path reached the upstream but got ${res.status} (model "${model}")`,
      detail: text || undefined,
      fix: 'The forwarder IS routing chat — the upstream rejected this request (key/model/quota). The same request from Copilot will get the same answer.',
    }];
  } catch (err) {
    return [{
      severity: 'error',
      label: `chat path broken: POST /chat/completions via ${base} did not answer`,
      detail: String(err instanceof Error ? err.message : err),
      fix: 'Check the forwarder and the remote proxy (LiteLLM Proxy: Test connection).',
    }];
  }
}

/**
 * 7. A WebSocket upgrade attempt against the forwarder must get a clean
 * refusal (501), not a silent hang — a hang here is indistinguishable from
 * "chat isn't routed" when Copilot uses the WS CAPI transport.
 */
async function checkWsUpgrade(port: number, running: boolean): Promise<Finding[]> {
  if (!running) return [];
  const reply = await new Promise<string>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 2000 });
    let buf = '';
    const done = (v: string): void => { try { s.destroy(); } catch { /* noop */ } resolve(v); };
    s.once('connect', () => s.write(
      'GET /chat/completions HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n',
    ));
    s.on('data', (c: Buffer) => { buf += c.toString(); if (buf.includes('\r\n\r\n')) done(buf.split('\r\n')[0]); });
    s.once('timeout', () => done('(no response — connection hung)'));
    s.once('error', () => done('(connection error)'));
  });
  if (/^HTTP\/1\.1 5\d\d/.test(reply)) {
    return [{ severity: 'ok', label: `WebSocket upgrades get a clean refusal (${reply})` }];
  }
  return [{
    severity: 'error',
    label: 'WebSocket upgrade attempts hang or fail silently',
    detail: `probe got: ${reply}`,
    fix: 'A stale build without the upgrade handler is running — reload the window.',
  }];
}

async function render(findings: Finding[], context: vscode.ExtensionContext): Promise<void> {
  const logLevel = vscode.workspace.getConfiguration('vscode-litellm').get<string>('logLevel', 'undefined');
  const lines: string[] = [
    '',
    `LiteLLM Proxy — doctor    (running build v${__LITELLM_EXT_VERSION__}, VS Code ${vscode.version})`,
    `    log level: ${logLevel}  (vscode-litellm.logLevel — only messages at/above this appear in the "vscode-litellm" output channel)`,
    '─'.repeat(64),
  ];
  for (const f of findings) {
    lines.push(`${ICON[f.severity]}  ${f.label}`);
    if (f.detail) for (const d of f.detail.split('\n')) lines.push(`        ${d}`);
    if (f.fix) lines.push(`        → ${f.fix}`);
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  lines.push('─'.repeat(64));
  lines.push(`${errors} error(s), ${warns} warning(s), ${findings.length - errors - warns} ok`);
  lg.info(`doctor finished: ${errors} error(s), ${warns} warning(s)`);

  const channel = vscode.window.createOutputChannel('LiteLLM Doctor');
  channel.clear();
  channel.appendLine(lines.join('\n'));
  channel.show();
  // Keep the channel for the user to scroll; don't dispose per run.
  context.subscriptions.push({ dispose: () => channel.dispose() });
}

function summarize(findings: Finding[]): void {
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (errors.length > 0) {
    void vscode.window.showErrorMessage(`LiteLLM Proxy doctor: ${errors.length} problem(s) — ${errors[0].label}`);
  } else if (warns.length > 0) {
    void vscode.window.showWarningMessage(`LiteLLM Proxy doctor: ${warns.length} warning(s) — ${warns[0].label}`);
  } else {
    void vscode.window.showInformationMessage('LiteLLM Proxy doctor: all checks passed ✓');
  }
}

/** Versions of every installed local.vscode-litellm-* build in the extensions dir. */
function listInstalledVersions(context: vscode.ExtensionContext): string[] {
  const out: string[] = [];
  try {
    const extDir = context.extension?.extensionUri?.fsPath;
    if (!extDir) return out;
    const parent = path.dirname(extDir);
    for (const name of fs.readdirSync(parent)) {
      if (!/^local\.vscode-litellm-/.test(name)) continue;
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(parent, name, 'package.json'), 'utf8')) as { version?: string };
        if (typeof pj.version === 'string') out.push(pj.version);
      } catch {
        // unreadable build dir — ignore
      }
    }
  } catch {
    // extensions dir not readable — caller treats as "no info"
  }
  return out;
}

function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Is anything listening on host:port? */
function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    const done = (v: boolean): void => { try { s.destroy(); } catch { /* noop */ } resolve(v); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** Best-effort "ImageName (PID)" for whatever is LISTENING on `port` (Windows). */
async function findPortOwner(port: number): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    const { stdout } = await execFileP('netstat', ['-ano']);
    const pids: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
      const parts = raw.trim().split(/\s+/);
      // TCP  LocalAddr  ForeignAddr  State  PID
      if (parts.length >= 5 && parts[3] === 'LISTENING' && parts[1].endsWith(`:${port}`) && !pids.includes(parts[4])) {
        pids.push(parts[4]);
      }
    }
    for (const pid of pids) {
      try {
        const t = await execFileP('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
        const img = t.stdout.match(/^"([^"]+)"/);
        if (img) return `${img[1]} (PID ${pid})`;
      } catch {
        // individual lookup failed — keep trying others
      }
    }
  } catch {
    // netstat/tasklist unavailable — no owner info
  }
  return undefined;
}
