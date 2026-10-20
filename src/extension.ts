import * as vscode from 'vscode';
import * as dns from 'dns';
import { applyOverrides, OverrideState } from './copilotSettings';
import { checkProxy, renderLiteLLMConfig } from './proxy';
import { configureModelMap, readModelMap } from './modelMap';
import { StatusBar } from './statusBar';
import { Forwarder, ForwarderOptions } from './forwarder';
import { RequestRecord } from './policies';
import { runDoctor } from './doctor';
import { warnOnce } from './notify';
import { log, LogLevel } from './logger';

const CFG = 'vscode-litellm';
const extLog = log('extension');

/** SecretStorage key for the forwarder API key (preferred over settings.json). */
const SECRET_KEY = 'forwarderApiKey';

interface RouterState {
  enabled: boolean;
  /** remote proxy the user configured */
  remoteBase: string;
  forwarderEnabled: boolean;
  forwarderPort: number;
  /** effective key: SecretStorage > forwarder.apiKey > deployment.apiKey */
  apiKey: string;
  /** the key came from SecretStorage (doctor reports it as "secure") */
  keyFromSecret: boolean;
  /** model used when the requested model is unavailable upstream */
  fallbackModel: string;
  /** ms to wait for the upstream's first response byte (0 = no timeout) */
  requestTimeoutMs: number;
  /** what the Copilot override keys should point at */
  effectiveBase: string;
  capiEnabled: boolean;
  proxyEnabled: boolean;
}

function toOverrideState(state: RouterState): OverrideState {
  return {
    enabled: state.enabled,
    proxyBaseUrl: state.effectiveBase,
    capiEnabled: state.capiEnabled,
    proxyEnabled: state.proxyEnabled,
  };
}

/** Key the forwarder should send, from SecretStorage (may be empty). */
async function secretKey(context: vscode.ExtensionContext): Promise<string> {
  try {
    return (await context.secrets.get(SECRET_KEY)) ?? '';
  } catch (err) {
    extLog.warn('could not read SecretStorage', err);
    return '';
  }
}

function readState(effectiveApiKey?: string): RouterState {
  const cfg = vscode.workspace.getConfiguration(CFG);
  const remoteBase = cfg.get<string>('proxyBaseUrl', 'http://localhost:4000');
  const forwarderEnabled = cfg.get<boolean>('forwarder.enabled', false);
  const forwarderPort = cfg.get<number>('forwarder.port', 4141);
  const settingsKey = cfg.get<string>('forwarder.apiKey', '') || cfg.get<string>('deployment.apiKey', '');
  const fromSecret = !!effectiveApiKey;
  const timeoutRaw = cfg.get<number>('forwarder.requestTimeoutMs', 30000);
  return {
    enabled: cfg.get<boolean>('enabled', true),
    remoteBase,
    forwarderEnabled,
    forwarderPort,
    apiKey: effectiveApiKey || settingsKey,
    keyFromSecret: fromSecret,
    fallbackModel: cfg.get<string>('forwarder.fallbackModel', ''),
    requestTimeoutMs: typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 0 ? timeoutRaw : 30000,
    effectiveBase: forwarderEnabled ? `http://127.0.0.1:${forwarderPort}` : remoteBase,
    capiEnabled: cfg.get<boolean>('surfaces.chat', true) || cfg.get<boolean>('surfaces.agents', true),
    proxyEnabled: cfg.get<boolean>('surfaces.completions', true) || cfg.get<boolean>('surfaces.nes', true),
  };
}

/**
 * Validate the settings the routing depends on, up front. A malformed
 * proxyBaseUrl only surfaces today when a request fails — catch it at
 * edit time instead. Toasts are deduped (warnOnce) because settings.json
 * fires a change event per keystroke while the URL is being typed.
 */
function validateConfig(): void {
  const cfg = vscode.workspace.getConfiguration(CFG);
  const base = cfg.get<string>('proxyBaseUrl', '');
  let parsed: URL | undefined;
  try { parsed = new URL(base); } catch { /* reported below */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    extLog.warn('invalid proxyBaseUrl', base);
    warnOnce(`LiteLLM Router: vscode-litellm.proxyBaseUrl is not a valid http(s) URL ("${base}") — routing will not work until it is fixed`);
    return;
  }
  const port = cfg.get<number>('forwarder.port', 4141);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    extLog.warn('invalid forwarder.port', String(port));
    warnOnce(`LiteLLM Router: vscode-litellm.forwarder.port must be an integer 1–65535 (got ${String(port)})`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new StatusBar();
  let forwarder: Forwarder | undefined;
  let applyTimer: NodeJS.Timeout | undefined;

  extLog.info('activating', {
    extension: context.extension?.packageJSON?.version,
    vscode: vscode.version,
  });

  const syncForwarder = async (state: RouterState): Promise<void> => {
    extLog.debug('syncForwarder', {
      enabled: state.enabled,
      forwarder: state.forwarderEnabled,
      target: state.remoteBase,
      port: state.forwarderPort,
    });
    if (state.enabled && state.forwarderEnabled) {
      // The extension host routes node http/https traffic through the
      // `http.proxy` setting. Corporate proxies usually cannot reach an
      // internal LiteLLM host, so the forwarder's upstream must be exempted
      // from proxying. The exthost resolver (@vscode/proxy-agent) ignores the
      // NO_PROXY env var entirely whenever `http.noProxy` has any entries —
      // and it reads the env vars only once, at resolver creation, before
      // extensions activate — so the only reliable switch is adding the
      // target host to the `http.noProxy` setting. The resolver re-reads
      // that setting on every connection, so this applies immediately.
      const target = new URL(state.remoteBase.replace(/\/+$/, '') || 'http://127.0.0.1:4000');
      if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
        const exempt = new Set<string>([target.hostname]);
        try {
          const ips = await dns.promises.lookup(target.hostname, { all: true });
          for (const ip of ips) exempt.add(ip.address);
        } catch (err) {
          // DNS lookup failed — hostname-only exemption still works
          extLog.warn('DNS lookup of ' + target.hostname + ' failed — exempting hostname only', err);
        }
        const httpCfg = vscode.workspace.getConfiguration('http');
        const current = httpCfg.get<string[]>('noProxy', []);
        const additions = [...exempt].filter((h) => !current.includes(h));
        if (additions.length > 0) {
          await httpCfg.update('noProxy', [...current, ...additions], vscode.ConfigurationTarget.Global);
          extLog.debug('added to http.noProxy', additions);
        }
      }
      const opts: ForwarderOptions = {
        targetBase: state.remoteBase,
        apiKey: state.apiKey || undefined,
        port: state.forwarderPort,
        // advertise the Copilot names we expect to receive (modelMap keys) so
        // the client can resolve them even when the proxy doesn't list them
        advertisedModels: Object.keys(readModelMap()),
        fallbackModel: state.fallbackModel || undefined,
        firstByteTimeoutMs: state.requestTimeoutMs,
      };
      // (re)start only when options actually changed — a running forwarder
      // keeps its original options, so apiKey/fallback/modelMap edits need a
      // restart to take effect
      if (!forwarder || forwarder.optionsFingerprint !== JSON.stringify(opts)) {
        forwarder?.stop();
        forwarder = undefined;
        extLog.info('starting forwarder', { target: opts.targetBase, port: opts.port, fallback: opts.fallbackModel ?? null });
        const f = new Forwarder(opts);
        try {
          await f.start();
          forwarder = f;
          extLog.info('forwarder started on ' + f.baseUrl);
        } catch (err) {
          extLog.error('forwarder failed to start', err);
          warnOnce(`LiteLLM Router forwarder: ${String(err)}`);
        }
      }
    } else {
      forwarder?.stop();
      forwarder = undefined;
      extLog.debug('forwarder stopped');
    }
  };

  const applyNow = async (): Promise<void> => {
    try {
      validateConfig();
      const state = readState(await secretKey(context));
      extLog.debug('applying overrides', {
        enabled: state.enabled,
        effectiveBase: state.effectiveBase,
        capi: state.capiEnabled,
        proxy: state.proxyEnabled,
      });
      await syncForwarder(state);
      const result = await applyOverrides(toOverrideState(state));
      if (result.changed) {
        extLog.info(`overrides ${state.enabled ? 'written' : 'cleared'} via ${result.method}`);
      }
      if (result.details) {
        extLog.debug(result.details);
      }
      if (result.method === 'skipped') {
        extLog.warn('overrides skipped', result.details ?? 'unknown reason');
      }
      if (result.method === 'settings-file' && result.changed) {
        const choice = await vscode.window.showInformationMessage(
          'LiteLLM Router: Copilot endpoint overrides written to your user settings.json. Reload the window to activate them.',
          'Reload Window',
        );
        if (choice === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else if (result.details && result.method === 'skipped') {
        warnOnce(`LiteLLM Router: ${result.details}`);
      }
      // poll interval is a setting — re-arm the timer when it changes
      statusBar.schedule();
      void statusBar.refresh();
    } catch (err) {
      extLog.fatal('applyNow failed', err);
    }
  };

  const applyDebounced = (): void => {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      void applyNow();
    }, 750);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const relevant = e.affectsConfiguration(CFG) ||
        e.affectsConfiguration('github.copilot.internal') ||
        e.affectsConfiguration('github.copilot.advanced.debug') ||
        e.affectsConfiguration('github.copilot.chat.advanced.debug');
      if (relevant) {
        extLog.debug('configuration changed — reapplying (debounced)');
        applyDebounced();
      }
    }),

    vscode.commands.registerCommand('vscode-litellm.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration(CFG);
      const next = !cfg.get<boolean>('enabled', true);
      extLog.info('routing toggled → ' + (next ? 'enabled' : 'disabled'));
      await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
      try {
        const state = readState(await secretKey(context));
        await syncForwarder(state);
        const result = await applyOverrides(toOverrideState(state));
        if (result.method === 'settings-file' && result.changed) {
          const choice = await vscode.window.showInformationMessage(
            `LiteLLM Router ${next ? 'enabled' : 'disabled'} — overrides ${next ? 'written' : 'cleared'}. Reload the window to apply.`,
            'Reload Window',
          );
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        } else if (result.details && result.method === 'skipped') {
          warnOnce(`LiteLLM Router: ${result.details}`);
        }
        void statusBar.refresh();
      } catch (err) {
        extLog.fatal('toggle failed', err);
        void vscode.window.showErrorMessage(`LiteLLM Router toggle failed: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('vscode-litellm.configure', async () => {
      await configureModelMap();
    }),

    vscode.commands.registerCommand('vscode-litellm.testConnection', async () => {
      const state = readState(await secretKey(context));
      const where = state.forwarderEnabled
        ? `${state.effectiveBase} → ${state.remoteBase}`
        : state.effectiveBase;
      const status = await checkProxy(where);
      const msg = `${where}: ${status.message}`;
      // Call the method directly — `(c ? extLog.info : extLog.error)(...)`
      // detaches the receiver so `this` is undefined inside the method.
      if (status.reachable) {
        extLog.info('test connection', msg);
      } else {
        extLog.error('test connection', msg);
      }
      if (status.reachable) {
        void vscode.window.showInformationMessage(`LiteLLM Router: ${msg}`);
      } else {
        void vscode.window.showErrorMessage(`LiteLLM Router: ${msg}`);
      }
      void statusBar.refresh();
    }),

    vscode.commands.registerCommand('vscode-litellm.exportConfig', async () => {
      const cfg = vscode.workspace.getConfiguration(CFG);
      const yaml = renderLiteLLMConfig({
        modelMap: readModelMap(),
        defaultDeployment: cfg.get<string>('defaultDeployment', ''),
        apiBase: cfg.get<string>('deployment.apiBase', ''),
        apiKey: cfg.get<string>('deployment.apiKey', ''),
        fallbackModel: cfg.get<string>('forwarder.fallbackModel', ''),
      });
      extLog.info('exported config.yml', { models: Object.keys(readModelMap()) });
      const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: yaml });
      await vscode.window.showTextDocument(doc, { preview: false });
      void vscode.window.showInformationMessage(
        'LiteLLM config.yml generated (unsaved). Save it, then restart LiteLLM with: litellm --config <file>',
      );
    }),

    vscode.commands.registerCommand('vscode-litellm.doctor', async () => {
      extLog.info('running doctor');
      try {
        await runDoctor({
          context,
          forwarderRunning: forwarder?.running() ?? false,
          keyFromSecret: !!(await secretKey(context)),
        });
      } catch (err) {
        extLog.fatal('doctor failed', err);
        void vscode.window.showErrorMessage(`LiteLLM Router doctor failed: ${String(err)}`);
      }
    }),

    // Restart this window's extension host — the reliable way to make a
    // freshly-installed build (and any setting/override change) take effect in
    // just THIS window, without touching the other open windows.
    vscode.commands.registerCommand('vscode-litellm.reload', async () => {
      extLog.info('reloading window to restart the extension');
      forwarder?.stop();
      statusBar.stop();
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),

    vscode.commands.registerCommand('vscode-litellm.setLogLevel', async () => {
      const cfg = vscode.workspace.getConfiguration(CFG);
      const current = cfg.get<LogLevel>('logLevel', 'trace');
      const levels: Array<{ id: LogLevel; desc: string }> = [
        { id: 'trace', desc: 'every forwarded request/response, incl. the status poll (default)' },
        { id: 'debug', desc: 'forwarding details + model-list rewrites + polling' },
        { id: 'info', desc: 'start/stop, model merges, test results — quieter' },
        { id: 'warn', desc: 'warnings and above' },
        { id: 'error', desc: 'errors and above — quietest' },
      ];
      const picked = await vscode.window.showQuickPick(
        levels.map((l) => ({ label: l.id, description: l.desc, detail: l.id === current ? 'current' : undefined })),
        {
          title: 'LiteLLM Router — log level for the "vscode-litellm" output channel',
          placeHolder: `current: ${current} (applies immediately, new lines only)`,
        },
      );
      if (!picked) return;
      const id = levels.find((l) => l.id === picked.label)?.id;
      if (!id) return;
      await cfg.update('logLevel', id, vscode.ConfigurationTarget.Global);
      extLog.info('log level set to ' + id);
      void vscode.window.showInformationMessage(`LiteLLM Router: log level → ${id}`);
    }),

    // API key in SecretStorage (never in settings.json). Takes priority over
    // vscode-litellm.forwarder.apiKey / deployment.apiKey while non-empty.
    vscode.commands.registerCommand('vscode-litellm.storeApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'LiteLLM Router — API key for the forwarder (SecretStorage)',
        password: true,
        prompt: 'Sent to the proxy as Authorization: Bearer <key>. Takes priority over the settings.json key while non-empty.',
        placeHolder: 'e.g. sk-...',
      });
      if (key === undefined) return;
      if (key === '') {
        await context.secrets.delete(SECRET_KEY);
        extLog.info('stored API key cleared (empty input)');
        void vscode.window.showInformationMessage('LiteLLM Router: stored API key cleared');
      } else {
        await context.secrets.store(SECRET_KEY, key);
        extLog.info('API key stored in SecretStorage');
        void vscode.window.showInformationMessage('LiteLLM Router: API key stored securely');
      }
      applyDebounced();
    }),

    vscode.commands.registerCommand('vscode-litellm.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      extLog.info('stored API key cleared');
      void vscode.window.showInformationMessage('LiteLLM Router: stored API key cleared');
      applyDebounced();
    }),

    // Ring buffer of the last 200 forwarded requests (see ForwarderOptions) —
    // answers "which Copilot call just failed?" without scrolling the log.
    vscode.commands.registerCommand('vscode-litellm.recentRequests', async () => {
      const records = forwarder?.recentRequests() ?? [];
      if (!forwarder || records.length === 0) {
        void vscode.window.showInformationMessage(
          'LiteLLM Router: no recorded requests (forwarder not running, or nothing has been forwarded since the last restart)',
        );
        return;
      }
      const items: Array<vscode.QuickPickItem & { rec?: RequestRecord; clear?: boolean }> = [
        { label: '$(clear-all) Clear list', clear: true },
        ...records.map((rec) => ({
          label: `${rec.method} ${rec.path}`,
          description: `${rec.status < 0 ? '—' : rec.status} · ${fmtMs(rec.latencyMs)}${rec.ttfbMs >= 0 ? ` (ttfb ${fmtMs(rec.ttfbMs)})` : ''}`,
          detail: requestDetail(rec),
          rec,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `LiteLLM Router — recent requests (${records.length})`,
        placeHolder: 'newest first — pick one for details',
      });
      if (!picked) return;
      if (picked.clear) {
        forwarder?.clearRecentRequests();
        void vscode.window.showInformationMessage('LiteLLM Router: request list cleared');
        return;
      }
      if (picked.rec) {
        const r = picked.rec;
        const lines = [
          `LiteLLM Router — request detail`,
          '',
          `time            ${r.time}`,
          `request         ${r.method} ${r.path}`,
          `model           ${r.model || '(none)'}`,
          `status          ${r.status < 0 ? 'no response' : r.status}`,
          `latency         ${fmtMs(r.latencyMs)} (wall time incl. any retries)`,
          `time to 1st byte ${fmtMs(r.ttfbMs)}`,
          `outcome         ${r.outcome}`,
          `fallback retry  ${r.fallbackRetry ? 'yes' : 'no'}`,
          `transport retry ${r.transportRetry ? 'yes' : 'no'}`,
        ];
        if (r.error) lines.push(`error           ${r.error}`);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }),

    // Clicking the status-bar LiteLLM icon opens this QuickPick instead of a
    // single fixed action — a reliable, discoverable "menu" for the taskbar
    // item (VS Code has no package.json contribution point for a status-bar
    // item's right-click menu). Each entry just re-runs a real command.
    vscode.commands.registerCommand('vscode-litellm.statusBarMenu', async () => {
      const cfg = vscode.workspace.getConfiguration(CFG);
      const enabled = cfg.get<boolean>('enabled', true);
      const items = [
        { label: '$(search) Troubleshoot (doctor)', description: 'check settings, port, build version, reachability', cmd: 'vscode-litellm.doctor' },
        { label: '$(pass-filled) Test connection', description: 'ping the endpoint now', cmd: 'vscode-litellm.testConnection' },
        { label: '$(list-ordered) Recent requests', description: 'last 200 forwarded requests with latency and errors', cmd: 'vscode-litellm.recentRequests' },
        { label: '$(key) Store API key securely', description: 'SecretStorage (priority over settings.json)', cmd: 'vscode-litellm.storeApiKey' },
        { label: '$(key-edit) Clear stored API key', description: 'remove the SecretStorage key', cmd: 'vscode-litellm.clearApiKey' },
        { label: '$(reload) Reload this window', description: 'restart the extension host to apply a new build / settings', cmd: 'vscode-litellm.reload' },
        { label: `$(${enabled ? 'circle-slash' : 'pass-filled'}) Toggle routing ${enabled ? 'off' : 'on'}`, description: 'enable/disable the endpoint override', cmd: 'vscode-litellm.toggle' },
        { label: '$(settings-gear) Set log level', description: 'vscode-litellm.logLevel', cmd: 'vscode-litellm.setLogLevel' },
        { label: '$(key) Configure model map', description: 'Copilot model name → deployment', cmd: 'vscode-litellm.configure' },
        { label: '$(file-export) Export LiteLLM config.yml', description: 'generate a config for the proxy', cmd: 'vscode-litellm.exportConfig' },
      ];
      const picked = await vscode.window.showQuickPick(items, { title: 'LiteLLM Router', placeHolder: 'Pick an action' });
      if (picked) {
        extLog.debug('status-bar menu → ' + picked.cmd);
        await vscode.commands.executeCommand(picked.cmd);
      }
    }),
  );

  // Initial apply + status polling.
  void applyNow();
  statusBar.start();
  context.subscriptions.push({
    dispose: () => {
      forwarder?.stop();
      statusBar.stop();
      extLog.output.dispose();
    },
  });
}

function fmtMs(n: number): string {
  if (n < 0) return '—';
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`;
}

function requestDetail(r: RequestRecord): string {
  const bits: string[] = [
    r.model ? `model ${r.model}` : 'no model',
    r.fallbackRetry ? 'fallback retry' : '',
    r.transportRetry ? 'transport retry' : '',
    r.outcome !== 'done' ? r.outcome : '',
    r.time.slice(11, 19) + 'Z',
  ].filter(Boolean);
  return bits.join(' · ');
}

export function deactivate(): void {
  extLog.info('deactivated');
}
