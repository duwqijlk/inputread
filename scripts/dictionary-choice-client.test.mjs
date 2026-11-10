import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/lib/dictionary-choices.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('choice hook never transmits on open; acknowledges switch/cancel, failures, auth and target races', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const originals = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let account = { phase: 'in', emailVerified: true, email: 'test@example.invalid' };
  let transport; const calls = [];
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, id => id === '@/lib/account-store' ? { useAccount: selector => selector(account) } : id === '@/lib/sync-engine' ? { accountRequest: async (url, payload) => { calls.push(payload); return transport(payload); } } : require(id));
  let value;
  const target = { bookId: 'test-book', word: 'Bank', sentence: 'Bank near the river.', chapter: 0, chapters: 1, paragraph: 0, occurrence: 1 };
  const senses = [{ id: 'bank-source-1', pos: 'noun', meaning: 'river bank', source: { lemma: 'bank', release: 'oewn-2025-test' } }, { id: 'bank-source-2', pos: 'noun', meaning: 'money bank', source: { lemma: 'bank', release: 'oewn-2025-test' } }];
  function Harness({ at = target }) { value = mod.exports.useDictionaryChoices(at, senses); return null; }
  const root = createRoot(document.querySelector('#root'));
  const render = async props => act(async () => root.render(React.createElement(Harness, props)));
  let saved = null;
  transport = async payload => { if (payload.action === 'set') saved = payload.choice?.id ?? null; return { ok: true, selectedId: saved }; };
  try {
    await render(); assert.equal(calls.length, 0); assert.equal(value.vote.eligibility, 'verified');
    await act(async () => { value.onVote(senses[0].id); value.onVote(senses[1].id); });
    assert.equal(calls.length, 2, 'duplicate pending click guarded');
    assert.equal(saved, senses[0].id); assert.equal(value.vote.selectedId, saved); assert.equal(value.vote.acknowledged, true);
    await act(async () => value.onVote(senses[1].id)); assert.equal(saved, senses[1].id);
    await act(async () => value.onVote(null)); assert.equal(saved, null);
    assert.equal(value.vote.acknowledged, true);
    const count = calls.length; await render(); assert.equal(calls.length, count);
    transport = async () => { throw Error('offline'); };
    await act(async () => value.onVote(senses[0].id)); assert.equal(value.vote.error, 'failed'); assert.equal(value.vote.selectedId, null);
    account = { ...account, phase: 'out' }; await render(); await act(async () => value.onVote(senses[0].id)); assert.equal(value.vote.eligibility, 'guest');
    account = { ...account, phase: 'in', emailVerified: false }; await render(); assert.equal(value.vote.eligibility, 'unverified');
    account = { ...account, emailVerified: true }; await render();
    let release; transport = payload => payload.action === 'get' ? new Promise(resolve => { release = resolve; }) : { ok: true, selectedId: payload.choice?.id ?? null };
    await act(async () => value.onVote(senses[0].id));
    const before = calls.length;
    await render({ at: { ...target, occurrence: 2 } });
    await act(async () => release({ ok: true, selectedId: null }));
    assert.equal(calls.length, before, 'late get never writes a choice for an abandoned target');
    assert.equal(value.vote.selectedId, null);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, desc] of originals) desc ? Object.defineProperty(globalThis, key, desc) : delete globalThis[key];
  }
});
