import * as vscode from 'vscode';
import { log } from './logger';

const lg = log('modelmap');

export const MODEL_MAP_KEY = 'vscode-litellm.modelMap';
export const DEFAULT_DEPLOYMENT_KEY = 'vscode-litellm.defaultDeployment';

export type ModelMap = Record<string, string>;

export function readModelMap(): ModelMap {
  const value = vscode.workspace.getConfiguration().get<unknown>(MODEL_MAP_KEY);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: ModelMap = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : String(v);
    }
    return out;
  }
  return {};
}

async function writeModelMap(map: ModelMap): Promise<void> {
  await vscode.workspace.getConfiguration().update(MODEL_MAP_KEY, map, vscode.ConfigurationTarget.Global);
}

/**
 * Quickpick-driven editor for the Copilot-model → LiteLLM-deployment map.
 * No webview needed for v1: pick an entry to edit/remove, or use the top
 * actions to add / set the default deployment.
 */
export async function configureModelMap(): Promise<void> {
  for (;;) {
    const map = readModelMap();
    const defaultDeployment =
      vscode.workspace.getConfiguration().get<string>(DEFAULT_DEPLOYMENT_KEY) ?? '';

    const items: vscode.QuickPickItem[] = [
      { label: '$(add) Add model', description: 'new Copilot model name → deployment' },
      {
        label: '$(settings-gear) Default deployment',
        description: defaultDeployment ? `current: ${defaultDeployment}` : 'current: (none)',
      },
    ];
    for (const [copilotName, deployment] of Object.entries(map)) {
      items.push({ label: copilotName, description: deployment || '(default)' });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'LiteLLM Proxy — model map (Copilot name → LiteLLM deployment)',
      placeHolder: 'Pick an entry to edit, or use the top actions',
    });
    if (!picked) return;

    if (picked.label.startsWith('$(add)')) {
      const name = await vscode.window.showInputBox({
        title: 'Copilot model name (as sent by the picker, e.g. gpt-4o)',
        prompt: 'Check docs/spike.md / LiteLLM logs for the exact names Copilot requests.',
        validateInput: (v) => (/^[A-Za-z0-9._\-/:]+$/.test(v) ? undefined : 'use letters, digits, . _ - / :'),
      });
      if (!name) continue;
      const deployment = await vscode.window.showInputBox({
        title: `LiteLLM deployment for "${name}"`,
        prompt: 'e.g. openai/gpt-4o, anthropic/claude-sonnet-4, or a model_name in your own config.yml',
      });
      if (deployment === undefined) continue;
      const next = { ...map, [name]: deployment };
      await writeModelMap(next);
      lg.info('modelMap updated', { [name]: deployment || '(default)' });
      void vscode.window.showInformationMessage(`modelMap updated: ${name} → ${deployment || '(default)'}`);
      continue;
    }

    if (picked.label.startsWith('$(settings-gear)')) {
      const v = await vscode.window.showInputBox({
        title: 'Default deployment for unmapped Copilot models',
        value: defaultDeployment,
        prompt: 'e.g. openai/gpt-4o. Leave empty for identity mapping.',
      });
      if (v === undefined) continue;
      await vscode.workspace.getConfiguration().update(DEFAULT_DEPLOYMENT_KEY, v, vscode.ConfigurationTarget.Global);
      lg.info('default deployment set to ' + (v || '(none)'));
      continue;
    }

    // edit/remove an existing entry
    const current = map[picked.label] ?? '';
    const action = await vscode.window.showQuickPick(
      [
        { label: `$(edit) Edit deployment — current: ${current || '(default)'}`, value: 'edit' },
        { label: '$(trash) Remove entry', value: 'remove' },
      ],
      { title: `What to do with "${picked.label}"?` },
    );
    if (!action) continue;

    if (action.value === 'remove') {
      const next = { ...map };
      delete next[picked.label];
      await writeModelMap(next);
      lg.info(`removed "${picked.label}" from modelMap`);
      void vscode.window.showInformationMessage(`Removed "${picked.label}" from modelMap`);
      continue;
    }

    const v = await vscode.window.showInputBox({
      title: `LiteLLM deployment for "${picked.label}"`,
      value: current,
    });
    if (v === undefined) continue;
    const next = { ...map, [picked.label]: v };
    await writeModelMap(next);
    lg.info(`modelMap updated: ${picked.label} → ${v || '(default)'}`);
    void vscode.window.showInformationMessage(`modelMap updated: ${picked.label} → ${v || '(default)'}`);
  }
}
