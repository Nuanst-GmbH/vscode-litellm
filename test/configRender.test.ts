/**
 * Smoke tests for src/configRender.ts — pure string logic, no vscode/http.
 * Bundled by test/run.mjs (esbuild) and executed in plain Node.
 */
import assert from 'node:assert/strict';
import { quoteYaml, renderLiteLLMConfig, type ExportOptions } from '../src/configRender';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}\n    ${(e as Error).message}`);
  }
}

function render(opts: Partial<ExportOptions>): string {
  return renderLiteLLMConfig({
    modelMap: {},
    defaultDeployment: '',
    apiBase: '',
    apiKey: '',
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// 11. renderLiteLLMConfig
// ---------------------------------------------------------------------------

test('renderLiteLLMConfig: model_name = Copilot name, litellm_params.model = mapped deployment', () => {
  const text = render({
    modelMap: { 'gpt-4o': 'openai/gpt-4o', 'claude-sonnet': 'anthropic/claude-sonnet-latest' },
  });
  assert.ok(text.includes('  - model_name: gpt-4o'));
  assert.ok(text.includes('      model: openai/gpt-4o'));
  assert.ok(text.includes('  - model_name: claude-sonnet'));
  assert.ok(text.includes('      model: anthropic/claude-sonnet-latest'));
});

test('renderLiteLLMConfig: empty mapping value falls back to defaultDeployment, then identity', () => {
  const withDefault = render({ modelMap: { 'gpt-4o': '' }, defaultDeployment: 'openai/gpt-4o' });
  assert.ok(withDefault.includes('      model: openai/gpt-4o'));
  const identity = render({ modelMap: { 'gpt-4o': '' } });
  assert.ok(identity.includes('      model: gpt-4o'));
});

test('renderLiteLLMConfig: api_base/api_key lines only when set', () => {
  const bare = render({ modelMap: { 'gpt-4o': 'openai/gpt-4o' } });
  assert.ok(!bare.includes('api_base'));
  assert.ok(!bare.includes('api_key'));
  const full = render({
    modelMap: { 'gpt-4o': 'openai/gpt-4o' },
    apiBase: 'https://api.example.com',
    apiKey: 'sk-abc123',
  });
  assert.ok(full.includes('      api_base: https://api.example.com'));
  assert.ok(full.includes('      api_key: sk-abc123'));
});

test('renderLiteLLMConfig: fallbacks block when fallbackModel set, no self-fallback line', () => {
  const text = render({
    modelMap: { 'a': 'dep-a', 'b': 'dep-b' },
    fallbackModel: 'dep-b',
  });
  assert.ok(text.includes('  fallbacks:'), 'expected a fallbacks: block');
  assert.ok(text.includes('    - a: [dep-b]'), 'expected fallback line for deployment dep-a');
  assert.ok(!/- b: \[/.test(text), 'self-fallback line (deployment === fallback) must be skipped');
});

test('renderLiteLLMConfig: no fallbacks block when fallbackModel empty', () => {
  const text = render({ modelMap: { 'gpt-4o': 'openai/gpt-4o' }, fallbackModel: '' });
  assert.ok(!text.includes('fallbacks:'));
});

test('renderLiteLLMConfig: empty map → comment line', () => {
  const text = render({});
  assert.ok(text.includes('  # no modelMap entries'));
});

test('renderLiteLLMConfig: drop_params: true always present', () => {
  assert.ok(render({}).includes('drop_params: true'));
  assert.ok(
    render({ modelMap: { 'gpt-4o': 'openai/gpt-4o' }, fallbackModel: 'openai/gpt-4o' }).includes('drop_params: true'),
  );
});

test('quoteYaml: safe names unquoted, names needing quotes get quoted', () => {
  assert.equal(quoteYaml('openai/gpt-4o'), 'openai/gpt-4o');
  assert.equal(quoteYaml('has space'), JSON.stringify('has space'));
  const text = render({ modelMap: { 'my model': 'openai/gpt-4o' } });
  assert.ok(text.includes(`  - model_name: ${JSON.stringify('my model')}`));
});

// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`configRender: FAIL — ${failed} of ${passed + failed} groups failed:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`configRender: ${passed} groups passed`);
