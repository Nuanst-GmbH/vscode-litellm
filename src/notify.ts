import * as vscode from 'vscode';

/**
 * Warning toasts deduped by message. The extension re-applies its state on
 * every configuration change (debounced 750ms), so a persistent problem
 * (bad URL, forwarder port held by a stale window) would otherwise re-toast
 * on every keystroke in settings.json. The first toast per distinct message
 * always goes out; repeats within the window are dropped.
 */
const DEFAULT_WINDOW_MS = 120_000;
const lastShown = new Map<string, number>();

export function warnOnce(message: string, windowMs: number = DEFAULT_WINDOW_MS): void {
  const last = lastShown.get(message) ?? 0;
  const now = Date.now();
  if (now - last < windowMs) return;
  lastShown.set(message, now);
  void vscode.window.showWarningMessage(message);
}
