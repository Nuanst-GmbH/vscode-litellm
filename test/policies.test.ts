/**
 * Smoke tests for src/policies.ts — pure functions, no vscode/http.
 * Bundled by test/run.mjs (esbuild) and executed in plain Node.
 */
import assert from 'node:assert/strict';
import {
  augmentModelsList,
  extractModel,
  extractModelIds,
  DEFAULT_RETRY_DELAY_MS,
  INLINE_EDIT_SERVICE_TYPES,
  looksLikeModelNotFound,
  MAX_RETRY_DELAY_MS,
  rewriteEnginePath,
  rewriteModel,
  sanitizeChatBody,
  synthesizeAutoDecision,
  synthesizeCopilotModels,
  transportRetryDelayMs,
} from '../src/policies';

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

function chatBody(messages: unknown): Buffer {
  return Buffer.from(JSON.stringify({ model: 'm', messages }), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. sanitizeChatBody
// ---------------------------------------------------------------------------

test('sanitizeChatBody: empty-string system message is dropped', () => {
  const r = sanitizeChatBody(chatBody([
    { role: 'system', content: '' },
    { role: 'user', content: 'hi' },
  ]));
  assert.ok(r, 'expected a result when a system message must be dropped');
  assert.equal(r.droppedSystem, 1);
  assert.equal(r.nulledAssistant, 0);
  const out = JSON.parse(r.out.toString('utf8'));
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
});

test('sanitizeChatBody: empty assistant tool-call message keeps tool_calls, content nulled', () => {
  const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }];
  const r = sanitizeChatBody(chatBody([
    { role: 'assistant', content: '', tool_calls: toolCalls },
    { role: 'user', content: 'ok' },
  ]));
  assert.ok(r, 'expected a result when an assistant message must be nulled');
  assert.equal(r.droppedSystem, 0);
  assert.equal(r.nulledAssistant, 1);
  const out = JSON.parse(r.out.toString('utf8'));
  assert.equal(out.messages[0].content, null);
  assert.deepEqual(out.messages[0].tool_calls, toolCalls);
  assert.deepEqual(out.messages[1], { role: 'user', content: 'ok' });
});

test('sanitizeChatBody: non-empty user message untouched (when something else changed)', () => {
  const user = { role: 'user', content: 'hello there' };
  const r = sanitizeChatBody(chatBody([
    { role: 'system', content: '' },
    user,
  ]));
  assert.ok(r);
  assert.deepEqual(JSON.parse(r.out.toString('utf8')).messages[0], user);
});

test('sanitizeChatBody: returns undefined when nothing changed', () => {
  assert.equal(
    sanitizeChatBody(chatBody([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ])),
    undefined,
  );
});

test('sanitizeChatBody: non-JSON body returns undefined', () => {
  assert.equal(sanitizeChatBody(Buffer.from('not json at all', 'utf8')), undefined);
  assert.equal(sanitizeChatBody(Buffer.alloc(0)), undefined);
});

test('sanitizeChatBody: whitespace-only content treated as empty', () => {
  const r = sanitizeChatBody(chatBody([
    { role: 'system', content: ' \t\n ' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'real' },
  ]));
  assert.ok(r);
  assert.equal(r.droppedSystem, 1);
  assert.equal(r.nulledAssistant, 1);
  assert.deepEqual(JSON.parse(r.out.toString('utf8')).messages, [
    { role: 'assistant', content: null },
    { role: 'user', content: 'real' },
  ]);
});

test('sanitizeChatBody: user message with empty content is KEPT (only system dropped, only assistant nulled)', () => {
  const r = sanitizeChatBody(chatBody([
    { role: 'system', content: '' },
    { role: 'user', content: '' },
  ]));
  assert.ok(r);
  assert.equal(r.droppedSystem, 1);
  assert.equal(r.nulledAssistant, 0);
  assert.deepEqual(JSON.parse(r.out.toString('utf8')).messages, [{ role: 'user', content: '' }]);
});

test('sanitizeChatBody: multiple empty system messages all dropped with correct counts', () => {
  const r = sanitizeChatBody(chatBody([
    { role: 'system', content: '' },
    { role: 'system', content: '   ' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'kept, non-empty' },
  ]));
  assert.ok(r);
  assert.equal(r.droppedSystem, 2);
  assert.equal(r.nulledAssistant, 0);
  assert.deepEqual(JSON.parse(r.out.toString('utf8')).messages, [
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'kept, non-empty' },
  ]);
});

// ---------------------------------------------------------------------------
// 2. looksLikeModelNotFound
// ---------------------------------------------------------------------------

test('looksLikeModelNotFound: true for model-rejection texts', () => {
  assert.equal(looksLikeModelNotFound(`{"error":"The model 'x' does not exist"}`), true);
  assert.equal(
    looksLikeModelNotFound('{"error":"Your team is not allowed to access model \'my-model\'. You can only access models=[\'gpt-4o\']"}'),
    true,
  );
  assert.equal(looksLikeModelNotFound('Access denied: you can only access models=[a, b]'), true);
});

test('looksLikeModelNotFound: false for quota/billing/auth/no-model texts', () => {
  assert.equal(looksLikeModelNotFound('You exceeded your current quota, please check your plan and billing details'), false);
  assert.equal(looksLikeModelNotFound('Invalid API key provided'), false);
  assert.equal(looksLikeModelNotFound('Internal server error, try again later'), false);
  // contains "model" but is not a model-rejection
  assert.equal(looksLikeModelNotFound('The model is currently busy, please retry'), false);
});

// ---------------------------------------------------------------------------
// 3. rewriteModel
// ---------------------------------------------------------------------------

test('rewriteModel: replaces model and preserves all other fields', () => {
  const body = Buffer.from(JSON.stringify({
    model: 'gone-model',
    messages: [{ role: 'user', content: 'x' }],
    temperature: 0.2,
    stream: true,
  }), 'utf8');
  const out = rewriteModel(body, 'fallback-model');
  assert.ok(out);
  const parsed = JSON.parse(out!.toString('utf8'));
  assert.equal(parsed.model, 'fallback-model');
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'x' }]);
  assert.equal(parsed.temperature, 0.2);
  assert.equal(parsed.stream, true);
});

test('rewriteModel: undefined when model already equals fallback', () => {
  assert.equal(rewriteModel(Buffer.from('{"model":"fb"}', 'utf8'), 'fb'), undefined);
});

test('rewriteModel: undefined for non-JSON and empty body', () => {
  assert.equal(rewriteModel(Buffer.from('nope', 'utf8'), 'fb'), undefined);
  assert.equal(rewriteModel(Buffer.alloc(0), 'fb'), undefined);
});

test('rewriteModel: undefined when body.model is not a string', () => {
  assert.equal(rewriteModel(Buffer.from('{"model":42}', 'utf8'), 'fb'), undefined);
  assert.equal(rewriteModel(Buffer.from('{"nope":"x"}', 'utf8'), 'fb'), undefined);
});

// ---------------------------------------------------------------------------
// 4. rewriteEnginePath
// ---------------------------------------------------------------------------

test('rewriteEnginePath: engine path rewritten, query preserved', () => {
  assert.equal(
    rewriteEnginePath('/v1/engines/old-model/completions?x=1', 'my-model'),
    '/v1/engines/my-model/completions?x=1',
  );
});

test('rewriteEnginePath: fallback containing a slash gets encodeURIComponent\'d', () => {
  assert.equal(
    rewriteEnginePath('/v1/engines/old/completions', 'openai/gpt-4o'),
    '/v1/engines/openai%2Fgpt-4o/completions',
  );
});

test('rewriteEnginePath: non-engine paths returned unchanged', () => {
  assert.equal(rewriteEnginePath('/v1/chat/completions', 'fb'), '/v1/chat/completions');
  assert.equal(rewriteEnginePath('/models', 'fb'), '/models');
});

// ---------------------------------------------------------------------------
// 5. augmentModelsList
// ---------------------------------------------------------------------------

test('augmentModelsList: missing advertised names appended as {id, object:"model"}', () => {
  const raw = Buffer.from(JSON.stringify({ data: [{ id: 'a', object: 'model' }] }), 'utf8');
  const { out, added } = augmentModelsList(raw, ['a', 'b', 'c']);
  assert.deepEqual(added, ['b', 'c']);
  const parsed = JSON.parse(out.toString('utf8'));
  assert.deepEqual(parsed.data, [
    { id: 'a', object: 'model' },
    { id: 'b', object: 'model' },
    { id: 'c', object: 'model' },
  ]);
});

test('augmentModelsList: existing ids not duplicated', () => {
  const raw = Buffer.from(JSON.stringify({ data: [{ id: 'a' }] }), 'utf8');
  const { out } = augmentModelsList(raw, ['a', 'a']);
  assert.deepEqual(JSON.parse(out.toString('utf8')).data.map((m: { id: string }) => m.id), ['a']);
});

test('augmentModelsList: non-JSON or missing data array returned as-is', () => {
  const notJson = Buffer.from('garbage', 'utf8');
  assert.equal(augmentModelsList(notJson, ['b']).out, notJson);
  const noData = Buffer.from('{"foo":1}', 'utf8');
  const r2 = augmentModelsList(noData, ['b']);
  assert.equal(r2.out, noData);
  assert.deepEqual(r2.added, []);
});

test('augmentModelsList: empty advertised list returns as-is', () => {
  const raw = Buffer.from(JSON.stringify({ data: [] }), 'utf8');
  const { out, added } = augmentModelsList(raw, []);
  assert.equal(out, raw);
  assert.deepEqual(added, []);
});

// ---------------------------------------------------------------------------
// 6. extractModelIds
// ---------------------------------------------------------------------------

test('extractModelIds: OpenAI {data:[{id}]} shape', () => {
  const raw = Buffer.from(JSON.stringify({ data: [{ id: 'x' }, { id: 'y' }] }), 'utf8');
  assert.deepEqual(extractModelIds(raw), ['x', 'y']);
});

test('extractModelIds: malformed JSON and null input → []', () => {
  assert.deepEqual(extractModelIds(Buffer.from('{bad', 'utf8')), []);
  assert.deepEqual(extractModelIds(null), []);
});

test('extractModelIds: non-string ids filtered out', () => {
  const raw = Buffer.from(JSON.stringify({ data: [{ id: 'a' }, { id: 123 }, { id: null }, {}] }), 'utf8');
  assert.deepEqual(extractModelIds(raw), ['a']);
});

// ---------------------------------------------------------------------------
// 7. synthesizeCopilotModels
// ---------------------------------------------------------------------------

test('synthesizeCopilotModels: one entry per name per INLINE_EDIT_SERVICE_TYPES', () => {
  const { out, names, chatNames } = synthesizeCopilotModels(['up1'], ['adv1'], 'fb1');
  assert.deepEqual(names, ['up1', 'fb1']);
  assert.deepEqual(chatNames, ['up1', 'fb1', 'adv1']);
  const body = JSON.parse(out.toString('utf8'));
  assert.equal(body.models.length, 2 * INLINE_EDIT_SERVICE_TYPES.length);
  for (const name of ['up1', 'fb1']) {
    for (const serviceType of INLINE_EDIT_SERVICE_TYPES) {
      const entry = body.models.find((m: Record<string, unknown>) => m.name === name && m.serviceType === serviceType);
      assert.ok(entry, `missing models entry for ${name}/${serviceType}`);
      assert.equal(entry.provider, 'copilot');
    }
  }
});

test('synthesizeCopilotModels: data = upstream + fallback + advertised; exactly ONE is_chat_fallback', () => {
  const { out } = synthesizeCopilotModels(['up1'], ['adv1'], 'fb1');
  const body = JSON.parse(out.toString('utf8'));
  assert.deepEqual(body.data.map((d: Record<string, unknown>) => d.id), ['up1', 'fb1', 'adv1']);
  const flagged = body.data.filter((d: Record<string, unknown>) => d.is_chat_fallback === true);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, 'fb1');
});

test('synthesizeCopilotModels: advertised-only names in data but NOT in models', () => {
  const { out } = synthesizeCopilotModels(['up1'], ['adv1'], 'fb1');
  const body = JSON.parse(out.toString('utf8'));
  assert.ok(body.data.some((d: Record<string, unknown>) => d.id === 'adv1'));
  assert.ok(body.models.every((m: Record<string, unknown>) => m.name !== 'adv1'));
});

test('synthesizeCopilotModels: every data entry has vendor and capabilities.type === "chat"', () => {
  const { out } = synthesizeCopilotModels(['up1'], ['adv1'], 'fb1');
  const body = JSON.parse(out.toString('utf8'));
  for (const d of body.data) {
    assert.equal(typeof d.vendor, 'string');
    assert.ok(d.vendor.length > 0);
    assert.equal(d.capabilities.type, 'chat');
  }
});

test('synthesizeCopilotModels: empty inputs → both arrays present but empty', () => {
  const { out, names, chatNames } = synthesizeCopilotModels([], undefined);
  const body = JSON.parse(out.toString('utf8'));
  assert.deepEqual(body.models, []);
  assert.deepEqual(body.data, []);
  assert.deepEqual(names, []);
  assert.deepEqual(chatNames, []);
});

test('synthesizeCopilotModels: duplicate inputs deduped', () => {
  const { out, names } = synthesizeCopilotModels(['a', 'a', 'b'], ['a'], 'a');
  assert.deepEqual(names, ['a', 'b']);
  const body = JSON.parse(out.toString('utf8'));
  assert.equal(body.models.length, 2 * INLINE_EDIT_SERVICE_TYPES.length);
  assert.deepEqual(body.data.map((d: Record<string, unknown>) => d.id), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 8. synthesizeAutoDecision
// ---------------------------------------------------------------------------

test('synthesizeAutoDecision: selected_model.id, expires_at in seconds in the future, valid JSON', () => {
  const before = Math.floor(Date.now() / 1000);
  const body = JSON.parse(synthesizeAutoDecision('my-model').toString('utf8'));
  assert.equal(body.selected_model.id, 'my-model');
  assert.equal(typeof body.expires_at, 'number');
  assert.ok(Number.isInteger(body.expires_at), 'expires_at must be whole seconds');
  assert.ok(body.expires_at >= before && body.expires_at < before + 301, 'expires_at should be ~300s in the future');
});

// ---------------------------------------------------------------------------
// 9. extractModel
// ---------------------------------------------------------------------------

test('extractModel: POST JSON body model wins over URL engine segment', () => {
  const body = Buffer.from(JSON.stringify({ model: 'body-model' }), 'utf8');
  assert.equal(extractModel('POST', '/v1/engines/url-model/completions', body), 'body-model');
});

test('extractModel: GET on /v1/engines/<model>/completions → model segment', () => {
  assert.equal(extractModel('GET', '/v1/engines/my-model/completions', Buffer.alloc(0)), 'my-model');
});

test('extractModel: URL-encoded engine segment is decoded', () => {
  assert.equal(
    extractModel('GET', `/v1/engines/${encodeURIComponent('my/model/x')}/completions`, Buffer.alloc(0)),
    'my/model/x',
  );
});

test('extractModel: nothing found → ""', () => {
  assert.equal(extractModel('GET', '/v1/chat/completions', Buffer.alloc(0)), '');
});

// ---------------------------------------------------------------------------
// 10. transportRetryDelayMs
// ---------------------------------------------------------------------------

test('transportRetryDelayMs: Retry-After seconds (number and string) → ms', () => {
  assert.equal(transportRetryDelayMs({ 'retry-after': 2 }, ''), 2000);
  assert.equal(transportRetryDelayMs({ 'retry-after': '2' }, ''), 2000);
});

test('transportRetryDelayMs: HTTP-date Retry-After — past → 0, far future → capped at MAX', () => {
  assert.equal(transportRetryDelayMs({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }, ''), 0);
  assert.equal(
    transportRetryDelayMs({ 'retry-after': new Date(Date.now() + 3_600_000).toUTCString() }, ''),
    MAX_RETRY_DELAY_MS,
  );
});

test('transportRetryDelayMs: body "try again in N" hints', () => {
  assert.equal(transportRetryDelayMs({}, 'try again in 2s'), 2000);
  assert.equal(transportRetryDelayMs({}, 'try again in 500ms'), 500);
});

test('transportRetryDelayMs: no hints → DEFAULT_RETRY_DELAY_MS', () => {
  assert.equal(transportRetryDelayMs({}, ''), DEFAULT_RETRY_DELAY_MS);
  assert.equal(transportRetryDelayMs({}, 'some unrelated error text'), DEFAULT_RETRY_DELAY_MS);
});

test('transportRetryDelayMs: huge values capped at MAX_RETRY_DELAY_MS', () => {
  assert.equal(transportRetryDelayMs({}, 'try again in 999s'), MAX_RETRY_DELAY_MS);
  assert.equal(transportRetryDelayMs({ 'retry-after': 999 }, ''), MAX_RETRY_DELAY_MS);
});

// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`policies: FAIL — ${failed} of ${passed + failed} groups failed:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`policies: ${passed} groups passed`);
