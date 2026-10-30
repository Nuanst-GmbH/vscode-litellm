/**
 * Smoke tests for src/issueReport.ts — redaction and the GitHub issue URL.
 * Bundled by test/run.mjs (esbuild) and executed in plain Node.
 */
import assert from 'node:assert/strict';
import {
  BUG_REPORT_URL,
  MAX_ISSUE_URL_CHARS,
  MAX_MODEL_MAP,
  MAX_RECENT,
  buildDiagnostics,
  redactPath,
  redactSecrets,
  redactUrl,
  reportIssueUrl,
  type IssueReportInput,
} from '../src/issueReport';

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

function fixture(over: Partial<IssueReportInput> = {}): IssueReportInput {
  return {
    extensionVersion: '0.2.2',
    vscodeVersion: '1.110.0',
    appName: 'Visual Studio Code',
    uiKind: 'desktop',
    remoteName: '',
    platform: 'win32',
    arch: 'x64',
    copilotChatVersion: '0.68.0',
    enabled: true,
    proxyBaseUrl: 'http://localhost:4000',
    forwarderEnabled: true,
    forwarderPort: 4141,
    forwarderRunning: true,
    apiKeySource: 'secret',
    fallbackModel: 'gpt-4o',
    defaultDeployment: '',
    deploymentApiBase: '',
    modelMap: { 'gpt-4o': 'gpt-4o' },
    surfaces: { chat: true, agents: true, completions: false, nes: true },
    requestTimeoutMs: 30000,
    statusPollIntervalMs: 30000,
    logLevel: 'info',
    recent: [],
    ...over,
  };
}

test('redactUrl drops username, password, and fragment', () => {
  assert.equal(
    redactUrl('https://user:s3cret-key@proxy.internal:4000/v1#token'),
    'https://proxy.internal:4000/v1',
  );
});

test('redactUrl keeps a credential-free URL without adding a trailing slash', () => {
  assert.equal(redactUrl('http://localhost:4000'), 'http://localhost:4000');
});

test('redactUrl strips userinfo from a string that is not a URL', () => {
  assert.equal(redactUrl('http://user:s3cret-key@not a url'), 'http://not a url');
});

test('redactPath replaces the query string', () => {
  assert.equal(redactPath('/v1/chat/completions?token=abcdef'), '/v1/chat/completions?[query redacted]');
  assert.equal(redactPath('/v1/models'), '/v1/models');
});

test('redactSecrets replaces bearer tokens, sk- keys, and api_key assignments', () => {
  assert.equal(
    redactSecrets('upstream bearer sk-liveABCDEFGHIJ and api_key=s3cret-key'),
    'upstream bearer [redacted] and api_key=[redacted]',
  );
});

test('buildDiagnostics lists versions, settings, and key source without the key', () => {
  const text = buildDiagnostics(fixture());
  assert.ok(text.includes('extension: 0.2.2'));
  assert.ok(text.includes('vscode: 1.110.0 (Visual Studio Code, desktop)'));
  assert.ok(text.includes('os: win32 x64'));
  assert.ok(text.includes('copilot chat: 0.68.0'));
  assert.ok(text.includes('surfaces: chat=on agents=on completions=off nes=on'));
  assert.ok(text.includes('proxy: http://localhost:4000'));
  assert.ok(text.includes('api key: set in SecretStorage'));
  assert.ok(text.includes('  gpt-4o -> gpt-4o'));
  assert.ok(text.includes('recent requests (0 of 0, newest first, no bodies):'));
  assert.equal(text.includes('s3cret'), false);
});

test('buildDiagnostics names the remote window type when one is set', () => {
  const text = buildDiagnostics(fixture({ remoteName: 'wsl', uiKind: 'desktop' }));
  assert.ok(text.includes('vscode: 1.110.0 (Visual Studio Code, desktop, remote wsl)'));
});

test('buildDiagnostics removes proxy credentials, query strings, and tokens in errors', () => {
  const text = buildDiagnostics(fixture({
    proxyBaseUrl: 'https://user:s3cret-key@proxy.internal:4000/v1',
    deploymentApiBase: 'http://ops:s3cret-key@10.1.2.3:9000',
    apiKeySource: 'none',
    recent: [{
      time: '2026-10-30T06:00:00.000Z',
      method: 'POST',
      path: '/v1/chat/completions?token=abcdef',
      model: 'gpt-4o',
      status: 401,
      latencyMs: 1200,
      ttfbMs: 40,
      outcome: 'upstream-error',
      fallbackRetry: false,
      transportRetry: true,
      error: 'upstream bearer sk-liveABCDEFGHIJ failed',
    }],
  }));
  assert.ok(text.includes('proxy: https://proxy.internal:4000/v1'));
  assert.ok(text.includes('deployment api base: http://10.1.2.3:9000'));
  assert.ok(text.includes('api key: not set'));
  assert.ok(text.includes('/v1/chat/completions?[query redacted]'));
  assert.ok(text.includes('bearer [redacted]'));
  assert.ok(text.includes('latency 1.20s'));
  assert.ok(text.includes('transport-retry'));
  assert.equal(text.includes('s3cret-key'), false);
  assert.equal(text.includes('sk-liveABCDEFGHIJ'), false);
  assert.equal(text.includes('token=abcdef'), false);
});

test('buildDiagnostics keeps only the newest 10 requests', () => {
  const recent = Array.from({ length: 12 }, (_, i) => ({
    time: `t${i}`,
    method: 'GET',
    path: `/models/${i}`,
    model: '',
    status: 200,
    latencyMs: i,
    ttfbMs: -1,
    outcome: 'done',
    fallbackRetry: false,
    transportRetry: false,
  }));
  const text = buildDiagnostics(fixture({ recent }));
  assert.equal(MAX_RECENT, 10);
  assert.ok(text.includes('recent requests (10 of 12, newest first, no bodies):'));
  assert.ok(text.includes('/models/0'));
  assert.ok(text.includes('/models/9'));
  assert.equal(text.includes('/models/10'), false);
});

test('buildDiagnostics keeps 50 model-map entries and redacts an sk- name', () => {
  const modelMap: Record<string, string> = { leak: 'sk-liveABCDEFGHIJ' };
  for (let i = 0; i < 51; i++) modelMap[`m${i}`] = `d${i}`;
  const text = buildDiagnostics(fixture({ modelMap }));
  assert.equal(MAX_MODEL_MAP, 50);
  assert.ok(text.includes('model map (52):'));
  assert.ok(text.includes('  leak -> [redacted]'));
  assert.ok(text.includes('  m0 -> d0'));
  assert.equal(text.includes('  m50 -> d50'), false);
  assert.ok(text.includes('2 more omitted'));
  assert.equal(text.includes('sk-liveABCDEFGHIJ'), false);
});

test('buildDiagnostics labels a settings.json key without copying it', () => {
  const text = buildDiagnostics(fixture({ apiKeySource: 'settings' }));
  assert.ok(text.includes('api key: set in settings.json'));
});

test('reportIssueUrl targets the bug-report form and the diagnostics field', () => {
  const url = reportIssueUrl(BUG_REPORT_URL, 'extension: 0.2.2');
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/Nuanst-GmbH/vscode-litellm/issues/new');
  assert.equal(parsed.searchParams.get('template'), 'bug_report.yml');
  assert.equal(parsed.searchParams.get('diagnostics'), 'extension: 0.2.2');
});

test('reportIssueUrl shortens diagnostics so the link stays within the URL cap', () => {
  const url = reportIssueUrl(BUG_REPORT_URL, 'x'.repeat(20_000));
  assert.ok(url.length <= MAX_ISSUE_URL_CHARS);
  const diagnostics = new URL(url).searchParams.get('diagnostics') ?? '';
  assert.ok(diagnostics.endsWith('[truncated to fit the issue link]'));
  assert.ok(diagnostics.length < 20_000);
});

if (failed > 0) {
  console.error(`issueReport: FAIL — ${failed} of ${passed + failed} groups failed:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`issueReport: ${passed} groups passed`);
