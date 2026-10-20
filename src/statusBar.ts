import * as vscode from 'vscode';
import { checkProxy, ProxyStatus } from './proxy';
import { log } from './logger';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const lg = log('statusbar');

/** Current poll interval from settings (clamped to a sane minimum). */
export function pollIntervalMs(): number {
  const v = vscode.workspace.getConfiguration('vscode-litellm').get<number>('statusPollIntervalMs', DEFAULT_POLL_INTERVAL_MS);
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(Math.floor(v), MIN_POLL_INTERVAL_MS);
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  /** a poll is in flight — overlapping polls are dropped, not queued */
  private checking = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'vscode-litellm.statusBarMenu';
    this.item.name = 'LiteLLM Router';
    this.renderIdle();
  }

  start(): void {
    this.schedule();
    void this.refresh();
  }

  /** (Re)arm the polling timer with the interval from current settings. */
  schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), pollIntervalMs());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.item.dispose();
  }

  /** Re-evaluate against current settings; used after config changes. */
  async refresh(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const cfg = vscode.workspace.getConfiguration('vscode-litellm');
      const enabled = cfg.get<boolean>('enabled', true);
      if (!enabled) {
        this.renderDisabled();
        return;
      }
      const remoteBase = cfg.get<string>('proxyBaseUrl', 'http://localhost:4000');
      const forwarderEnabled = cfg.get<boolean>('forwarder.enabled', false);
      const forwarderPort = cfg.get<number>('forwarder.port', 4141);
      const base = forwarderEnabled ? `http://127.0.0.1:${forwarderPort}` : remoteBase;
      await this.setBusy(base);
      let status: ProxyStatus;
      try {
        status = await checkProxy(base);
      } catch (err) {
        lg.error('status poll threw', err);
        status = { reachable: false, isLiteLLM: false, models: [], message: String(err) };
      }
      // trace: the poll runs every statusPollIntervalMs — only visible at logLevel=trace
      lg.trace(`poll ${base} → ${status.reachable ? 'up' : 'down'}: ${status.message}`);
      this.render(status, base);
    } finally {
      this.checking = false;
    }
  }

  private async setBusy(base: string): Promise<void> {
    this.item.text = '$(sync~spin) LiteLLM';
    this.item.tooltip = `checking ${base}…`;
    this.item.show();
  }

  private render(status: ProxyStatus, base: string): void {
    if (status.reachable) {
      this.item.text = '$(pass-filled) LiteLLM';
      this.item.backgroundColor = undefined;
      this.item.tooltip = `LiteLLM Router — ${base}\n${status.message}\nClick for the LiteLLM Router menu (troubleshoot, reload, …).`;
    } else {
      this.item.text = '$(error) LiteLLM';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.tooltip = `LiteLLM Router — ${base}\n${status.message}\nClick for the LiteLLM Router menu (troubleshoot, reload, …).`;
    }
    this.item.show();
  }

  private renderIdle(): void {
    this.item.text = '$(server-process) LiteLLM';
    this.item.tooltip = 'LiteLLM Router';
  }

  private renderDisabled(): void {
    this.item.text = '$(circle-slash) LiteLLM';
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'LiteLLM Router is disabled — Copilot uses the real GitHub endpoints.\nRun "LiteLLM Router: Toggle Routing" to re-enable.';
    this.item.show();
  }
}
