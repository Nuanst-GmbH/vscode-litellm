import * as vscode from 'vscode';
import { log } from './logger';

/**
 * Known-good Copilot builds for the hidden override keys written by
 * copilotSettings.ts. The keys are UNDOCUMENTED and have already changed
 * prefix once (github.copilot.chat.* → github.copilot.*, VS Code 1.137 /
 * Copilot Chat 0.65) — so the one failure mode to watch is "Copilot updated
 * and routing silently stopped". This table is the doctor's reference for
 * that; extend it as new builds get verified (and note the verification in
 * the OVERRIDES comment in copilotSettings.ts).
 */
export interface VerifiedBuild {
  /** inclusive lower bound, VS Code version */
  vscodeMin: string;
  /** inclusive upper bound; undefined = no known upper bound */
  vscodeMax?: string;
  /** Copilot Chat extension version this row was verified against (or 'builtin') */
  chatVersion: string;
  notes: string;
}

export const VERIFIED_BUILDS: VerifiedBuild[] = [
  // verified 2026-09: 0.38.2026021301 bundle + 1.138 built-in + upstream
  // microsoft/vscode main (copilot-chat 0.68.0); we write current AND legacy
  // key forms, so both prefixes are covered
  {
    vscodeMin: '1.110.0',
    vscodeMax: '1.139.0',
    chatVersion: '0.68.0',
    notes: 'overrideCapiUrl/overrideProxyUrl under github.copilot + legacy github.copilot.chat forms',
  },
];

export interface CopilotBuildCheck {
  severity: 'ok' | 'warn' | 'error';
  label: string;
  detail?: string;
}

/**
 * Classify the running VS Code / Copilot Chat build against VERIFIED_BUILDS.
 * `chatVersion` is the marketplace extension version, 'builtin' when Copilot
 * is built into VS Code (no separate extension), or undefined when unknown.
 */
export function checkCopilotBuild(vscodeVersion: string, chatVersion: string | undefined): CopilotBuildCheck {
  const rows = VERIFIED_BUILDS;
  const maxVscode = rows.reduce<string | undefined>((m, r) => {
    if (!r.vscodeMax) return undefined;
    return !m || cmpVer(r.vscodeMax, m) > 0 ? r.vscodeMax : m;
  }, undefined);
  const maxChat = rows.reduce<string | undefined>((m, r) => {
    if (r.chatVersion === 'builtin') return m;
    return !m || cmpVer(r.chatVersion, m) > 0 ? r.chatVersion : m;
  }, undefined);
  const minVscode = rows.reduce<string>((m, r) => (cmpVer(r.vscodeMin, m) > 0 ? r.vscodeMin : m), '0.0.0');

  if (cmpVer(vscodeVersion, minVscode) < 0) {
    return {
      severity: 'error',
      label: `VS Code ${vscodeVersion} is older than the minimum supported (${minVscode})`,
      detail: 'The override keys this extension writes may not exist in this build.',
    };
  }
  if (maxVscode && cmpVer(vscodeVersion, maxVscode) > 0) {
    return {
      severity: 'warn',
      label: `VS Code ${vscodeVersion} is NEWER than the newest verified build (${maxVscode})`,
      detail:
        'The override keys are undocumented and can change without notice. If routing appears broken, ' +
        'run the spike (docs/spike.md) against this build and add it to VERIFIED_BUILDS in src/copilotVersions.ts.',
    };
  }
  if (maxChat && chatVersion && chatVersion !== 'builtin' && cmpVer(chatVersion, maxChat) > 0) {
    return {
      severity: 'warn',
      label: `Copilot Chat ${chatVersion} is newer than the newest verified (${maxChat})`,
      detail: 'Verify the override keys still work on this build (docs/spike.md) and extend VERIFIED_BUILDS.',
    };
  }
  return {
    severity: 'ok',
    label: `Copilot build in the verified range (VS Code ${vscodeVersion}, chat: ${chatVersion ?? 'unknown/built-in'})`,
    detail: VERIFIED_BUILDS.map((r) => `verified: VS Code ≤ ${r.vscodeMax ?? '∞'}, chat ${r.chatVersion} — ${r.notes}`).join('; '),
  };
}

/**
 * Best-effort detection of which Copilot the user has: the marketplace
 * extension (with a version) or the built-in Copilot (VS Code ≥ 1.138 ships
 * it without a separately visible extension).
 */
export function detectCopilotBuild(): { vscodeVersion: string; chatVersion: string | 'builtin' | undefined } {
  const vscodeVersion = vscode.version;
  const ext = vscode.extensions.getExtension('github.copilot-chat');
  if (ext?.packageJSON?.version) {
    return { vscodeVersion, chatVersion: String(ext.packageJSON.version) };
  }
  // no marketplace extension — built-in Copilot (no separate version string)
  log('settings').debug('no github.copilot-chat extension found — assuming built-in Copilot');
  return { vscodeVersion, chatVersion: 'builtin' };
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
