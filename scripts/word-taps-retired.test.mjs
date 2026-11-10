import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handleWordTapsPost } from '../functions/api/analytics/word-taps.ts';
import { extractAnchorContext } from '../src/lib/word-taps-collector.ts';

test('old queued word taps never read their body or access storage', async () => {
  const request = { get body() { assert.fail('retired handler read body'); } };
  const env = new Proxy({}, { get() { assert.fail('retired handler touched storage'); } });
  const result = await handleWordTapsPost(request, env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, saved: 0, retired: true });
});
test('opening a word has no telemetry transport, timer or flush left', () => {
  const collector = readFileSync(new URL('../src/lib/word-taps-collector.ts', import.meta.url), 'utf8');
  const reader = readFileSync(new URL('../src/components/reader.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(collector, /fetch\s*\(|setTimeout|recordWordTap|flushWordTaps/);
  assert.doesNotMatch(reader, /recordWordTap|flushWordTaps/);
  const text = 'They waited beside the corner of the street.';
  assert.ok(extractAnchorContext(text, 'corner', text.indexOf('corner')).includes('corner'));
});
