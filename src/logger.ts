import * as vscode from 'vscode';

/**
 * Logging for the extension. Everything goes to the `vscode-litellm` output
 * channel (View → Output → dropdown → "vscode-litellm").
 *
 * Levels: trace < debug < info < warn < error < fatal.
 *
 * `fatal` is reserved for unhandled/unexpected exceptions and is always
 * written, no matter the configured minimum level. The minimum level shown
 * is controlled by the `vscode-litellm.logLevel` setting (default: trace).
 *
 * Usage: `log('forwarder').debug('started on', url)` — the scope tag makes
 * it easy to tell which module a line came from.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const CHANNEL_NAME = 'vscode-litellm';
// Key RELATIVE to the 'vscode-litellm' configuration section (the full setting
// is vscode-litellm.logLevel). Do NOT prefix with the section name here —
// getConfiguration('vscode-litellm').get('vscode-litellm.logLevel') would
// double-namespace and always fall back to the default.
const LEVEL_KEY = 'logLevel';

class Logger {
  private static channel: vscode.OutputChannel | undefined;

  constructor(private readonly scope?: string) {}

  trace(message: string, ...args: unknown[]): void {
    this.write('trace', message, args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }
  /** Unhandled / unexpected exception — always logged, regardless of the configured level. */
  fatal(message: string, ...args: unknown[]): void {
    this.write('fatal', message, args);
  }

  /** The backing output channel (register it in subscriptions for disposal). */
  get output(): vscode.OutputChannel {
    return Logger.channelOr();
  }

  private minRank(): number {
    const level = vscode.workspace.getConfiguration('vscode-litellm').get<LogLevel>(LEVEL_KEY, 'trace');
    return RANK[level] ?? RANK.trace;
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (level !== 'fatal' && RANK[level] < this.minRank()) return;
    const scope = this.scope ? ` ${this.scope}` : '';
    const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const extra = args.map(formatExtra).filter((s) => s.length > 0).join(' | ');
    const line = `[${time}] [${level.toUpperCase()}]${scope} ${message}${extra ? ` | ${extra}` : ''}`;
    try {
      Logger.channelOr().appendLine(line);
    } catch {
      // The backing channel was disposed (e.g. mid window-reload teardown) while
      // the forwarder / a command was still logging. Drop it and recreate once so
      // the log stream resumes; a logging failure must never propagate into a
      // command handler or the forwarder.
      try {
        void Logger.channel?.dispose();
        Logger.channel = undefined;
        Logger.channelOr().appendLine(line);
      } catch {
        // window is going away — give up quietly
      }
    }
  }

  private static channelOr(): vscode.OutputChannel {
    if (!Logger.channel) {
      Logger.channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    }
    return Logger.channel;
  }
}

/** Render a trailing argument: Error → stack, object → JSON, string → as-is. */
function formatExtra(a: unknown): string {
  if (a instanceof Error) {
    return a.stack && a.stack !== a.message ? a.stack : `${a.name}: ${a.message}`;
  }
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

const defaultLogger = new Logger();

/** Get the shared logger, optionally tagged with a module scope. */
export function log(scope?: string): Logger {
  return scope ? new Logger(scope) : defaultLogger;
}
