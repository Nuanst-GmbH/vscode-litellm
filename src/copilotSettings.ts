import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from './logger';

const lg = log('settings');

/**
 * The hidden endpoint-override settings shipped inside github.copilot-chat.
 * Verified against the 0.38.2026021301 bundle, the 1.138 built-in build, and
 * the upstream microsoft/vscode main source (copilot-chat 0.68.0):
 * `internal.*` are the current keys, `advanced.debug.*` the legacy aliases.
 * We write BOTH forms so the override survives Copilot versions that read
 * either one.
 *
 *   capi   -> chat (incl. the new WebSocket CAPI transport), /responses,
 *             /v1/messages, /models, /embeddings, /agents*, /skills
 *   proxy  -> code completions, NES/inline hints, proxy-side /models
 *
 * NOTE on key names: current builds (VS Code 1.137+, Copilot Chat 0.65+)
 * use the prefix `github.copilot` and the DomainService reads the CAPI/proxy
 * base ONLY from `advanced.debug.overrideCapiUrl` / `overrideProxyUrl` under
 * that prefix; older builds used the `github.copilot.chat.` prefix. We write
 * every form so the override survives across Copilot versions.
 *
 * IMPORTANT: these keys are NOT declared in any extension's package.json, and
 * the workspace configuration API silently drops updates for them — so the
 * reliable mechanism is a direct, marker-block write to the user's
 * settings.json (the same place VS Code shows them and Copilot reads them).
 */
export const OVERRIDES: Array<{ key: string; kind: 'capi' | 'proxy' }> = [
  // completions-core subsystem (code completions / NES) reads the internal.* names
  { key: 'github.copilot.internal.capiUrl', kind: 'capi' },
  { key: 'github.copilot.internal.completionsUrl', kind: 'proxy' },
  // current builds (VS Code 1.137+, Copilot Chat 0.65+): config prefix is
  // `github.copilot` (no `.chat` segment) and the CAPI/proxy base overrides
  // are read ONLY from these advanced.debug.* names
  { key: 'github.copilot.advanced.debug.overrideCapiUrl', kind: 'capi' },
  { key: 'github.copilot.advanced.debug.overrideProxyUrl', kind: 'proxy' },
  // older builds used the `github.copilot.chat.` prefix
  { key: 'github.copilot.chat.advanced.debug.overrideCapiUrl', kind: 'capi' },
  { key: 'github.copilot.chat.advanced.debug.overrideProxyUrl', kind: 'proxy' },
];

const MARKER_BEGIN = '// ===== BEGIN vscode-litellm (managed block, do not edit) =====';
const MARKER_END = '// ===== END vscode-litellm =====';

export interface OverrideState {
  enabled: boolean;
  proxyBaseUrl: string;
  /** any of the CAPI-side surfaces (chat, agents) is on */
  capiEnabled: boolean;
  /** any of the proxy-side surfaces (completions, nes) is on */
  proxyEnabled: boolean;
}

export interface ApplyResult {
  method: 'settings-file' | 'api' | 'skipped';
  written: string[];
  cleared: string[];
  /** true when settings.json content actually changed */
  changed: boolean;
  details?: string;
}

/**
 * Write (or clear) the four hidden Copilot override keys into the user's
 * settings.json, keeping a managed marker block. Everything else in the file
 * (including comments) is left untouched.
 */
export async function applyOverrides(state: OverrideState): Promise<ApplyResult> {
  const settingsPath = findUserSettingsFile();
  if (!settingsPath) {
    // Last-ditch fallback: configuration API (works for some products/versions)
    lg.warn('no user settings.json found — falling back to the configuration API');
    return applyOverridesViaApi(state);
  }
  lg.debug('user settings file: ' + settingsPath);

  const base = stripTrailingSlash(state.proxyBaseUrl);
  const capi = state.enabled && state.capiEnabled && base ? base : '';
  const proxy = state.enabled && state.proxyEnabled && base ? base : '';

  let content = '';
  try {
    content = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    lg.warn('cannot read ' + settingsPath, err);
    return { method: 'skipped', written: [], cleared: [], changed: false, details: `cannot read ${settingsPath}: ${String(err)}` };
  }

  const block = [
    MARKER_BEGIN,
    ...OVERRIDES.map(o => `  "${o.key}": ${JSON.stringify(o.kind === 'capi' ? capi : proxy)},`),
    MARKER_END,
  ].join('\n');

  const re = new RegExp(`${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`, 'm');
  let next: string;
  if (re.test(content)) {
    next = content.replace(re, block);
  } else {
    const idx = content.lastIndexOf('}');
    if (idx === -1) {
      return { method: 'skipped', written: [], cleared: [], changed: false, details: `settings.json at ${settingsPath} is not a JSON object` };
    }
    next = content.slice(0, idx) + block + ',\n' + content.slice(idx);
  }

  if (next === content) {
    lg.debug('managed block unchanged — nothing written');
    return { method: 'settings-file', written: [], cleared: [], changed: false };
  }

  try {
    fs.writeFileSync(settingsPath, next, 'utf8');
  } catch (err) {
    lg.error('failed writing ' + settingsPath, err);
    return { method: 'skipped', written: [], cleared: [], changed: false, details: `failed writing ${settingsPath}: ${String(err)}` };
  }
  const active = capi !== '' || proxy !== '';
  lg.info(`managed block ${active ? 'written' : 'cleared'} in ` + settingsPath);
  return {
    method: 'settings-file',
    changed: true,
    written: active ? OVERRIDES.filter(o => (o.kind === 'capi' ? capi : proxy) !== '').map(o => o.key) : [],
    cleared: active ? [] : OVERRIDES.map(o => o.key),
    details: `wrote managed block into ${settingsPath} — a window reload is required for Copilot to pick it up.`,
  };
}

function applyOverridesViaApi(state: OverrideState): Promise<ApplyResult> {
  const base = stripTrailingSlash(state.proxyBaseUrl);
  const written: string[] = [];
  return (async () => {
    for (const ov of OVERRIDES) {
      const value = (ov.kind === 'capi' ? state.capiEnabled : state.proxyEnabled) && state.enabled && base
        ? base
        : undefined;
      try {
        await vscode.workspace.getConfiguration().update(ov.key, value, vscode.ConfigurationTarget.Global);
        written.push(ov.key);
      } catch (err) {
        lg.warn('configuration API update failed on ' + ov.key, err);
        return { method: 'skipped', written, cleared: [], changed: false, details: `API update failed on ${ov.key}: ${String(err)}` };
      }
    }
    lg.info('overrides written via configuration API', written);
    return { method: 'api', written, cleared: [], changed: true };
  })();
}

/**
 * Robustly locate the global user settings.json for this VS Code product.
 * `env.appName` is NOT the data-folder name (it's "Visual Studio Code"), so we
 * scan the platform's data root for subfolders containing User/settings.json,
 * preferring any file that already contains vscode-litellm keys, then the
 * most recently modified one.
 */
export function findUserSettingsFile(): string | undefined {
  const roots: string[] = [];
  switch (process.platform) {
    case 'win32':
      if (process.env.APPDATA) roots.push(process.env.APPDATA);
      break;
    case 'darwin':
      roots.push(path.join(os.homedir(), 'Library', 'Application Support'));
      break;
    default:
      roots.push(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  }

  const candidates: Array<{ file: string; mtime: number; ours: boolean }> = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/code/i.test(name)) continue; // only VS Code product folders
      const file = path.join(root, name, 'User', 'settings.json');
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      let ours = false;
      try {
        ours = fs.readFileSync(file, 'utf8').includes('vscode-litellm');
      } catch {
        // unreadable — keep candidate, ours=false
      }
      candidates.push({ file, mtime: stat.mtimeMs, ours });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => Number(b.ours) - Number(a.ours) || b.mtime - a.mtime);
  return candidates[0].file;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
