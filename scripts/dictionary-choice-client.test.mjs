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
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test('choice hook never transmits on open; highlights optimistically in 0ms, sends single set, coalesces switches, persists hashed choices, and rolls back on failure', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://inputread.test/' });
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let account = { phase: 'in', emailVerified: true, email: 'test@example.invalid' };
  let transport;
  const calls = [];
  const loadHook = () => {
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) =>
      id === '@/lib/account-store'
        ? { useAccount: (selector) => selector(account) }
        : id === '@/lib/sync-engine'
          ? {
              accountRequest: async (_url, payload) => {
                calls.push(payload);
                return transport(payload);
              },
            }
          : require(id),
    );
    return mod.exports;
  };
  let hookMod = loadHook();
  let value;
  const target = {
    bookId: 'test-book',
    word: 'Bank',
    sentence: 'Bank near the secret river.',
    chapter: 0,
    chapters: 1,
    paragraph: 0,
    occurrence: 1,
  };
  const senses = [
    { id: 'bank-source-1', pos: 'noun', meaning: 'river bank', source: { lemma: 'bank', release: 'oewn-2025-test' } },
    { id: 'bank-source-2', pos: 'noun', meaning: 'money bank', source: { lemma: 'bank', release: 'oewn-2025-test' } },
  ];
  function Harness({ at = target }) {
    value = hookMod.useDictionaryChoices(at, senses);
    return null;
  }
  const root = createRoot(document.querySelector('#root'));
  const render = async (props) => act(async () => root.render(React.createElement(Harness, props)));
  let saved = null;
  transport = async (payload) => {
    assert.equal(payload.action, 'set', 'client never sends a preflight get before set');
    saved = payload.choice?.id ?? null;
    return { ok: true, selectedId: saved };
  };
  try {
    // 1. Opening a card transmits 0 API calls.
    await render();
    assert.equal(calls.length, 0);
    assert.equal(value.vote.eligibility, 'verified');
    assert.equal(value.vote.selectedId, null);

    // 2. Optimistic 0ms highlight BEFORE network resolves, and single-flight coalescing on rapid switch.
    let settleFirst;
    let firstSeen = false;
    transport = (payload) => {
      if (!firstSeen) {
        firstSeen = true;
        return new Promise((resolve) => {
          settleFirst = () => {
            saved = payload.choice?.id ?? null;
            resolve({ ok: true, selectedId: saved });
          };
        });
      }
      saved = payload.choice?.id ?? null;
      return Promise.resolve({ ok: true, selectedId: saved });
    };

    await act(async () => {
      value.onVote(senses[0].id);
    });
    assert.equal(calls.length, 1, 'exactly 1 POST started immediately');
    assert.equal(value.vote.selectedId, senses[0].id, 'thumb highlights immediately in 0ms while pending');
    assert.equal(value.vote.pending, true);
    assert.equal(value.vote.acknowledged, false);

    // Rapid switch while first request is still in flight: UI updates in 0ms without firing a concurrent POST!
    await act(async () => {
      value.onVote(senses[1].id);
    });
    assert.equal(calls.length, 1, 'second click coalesces behind in-flight request');
    assert.equal(value.vote.selectedId, senses[1].id, 'switched thumb highlights immediately in 0ms');

    await act(async () => {
      settleFirst();
    });
    assert.equal(calls.length, 2, 'coalesced drain sends one follow-up set for final choice');
    assert.equal(saved, senses[1].id);
    assert.equal(value.vote.selectedId, senses[1].id);
    assert.equal(value.vote.pending, false);
    assert.equal(value.vote.acknowledged, true);

    // 3. Hashed localStorage persistence across fresh module reload — zero plaintext book sentence stored!
    const rawStored = dom.window.localStorage.getItem('cibian-dict-choices-v1');
    assert.ok(rawStored, 'acknowledged choice persisted locally');
    assert.equal(rawStored.includes('secret river'), false, 'book sentence never stored in localStorage');
    assert.equal(rawStored.includes('test@example.invalid'), false, 'account email never stored in localStorage');

    hookMod = loadHook(); // fresh module clears in-memory Map, simulating page reload
    const countBeforeReload = calls.length;
    await render();
    assert.equal(calls.length, countBeforeReload, 'restoring thumb after reload makes 0 API calls');
    assert.equal(value.vote.selectedId, senses[1].id, 'thumb restored on frame 0 from hashed localStorage');
    assert.equal(value.vote.acknowledged, true);

    // 4. Failure rolls back optimistic selection to the last confirmed choice (`senses[1].id`).
    transport = async () => {
      throw Error('offline');
    };
    await act(async () => value.onVote(senses[0].id));
    assert.equal(value.vote.error, 'failed');
    assert.equal(value.vote.selectedId, senses[1].id, 'failed switch rolls back to last confirmed sense');

    // 5. Successful cancellation clears both UI and localStorage entry.
    transport = async (payload) => {
      saved = payload.choice?.id ?? null;
      return { ok: true, selectedId: saved };
    };
    await act(async () => value.onVote(null));
    assert.equal(saved, null);
    assert.equal(value.vote.selectedId, null);
    assert.equal(value.vote.acknowledged, true);
    assert.equal(dom.window.localStorage.getItem('cibian-dict-choices-v1'), null);

    // 6. Auth gating and abandoned-target race safety.
    account = { ...account, phase: 'out' };
    await render();
    await act(async () => value.onVote(senses[0].id));
    assert.equal(value.vote.eligibility, 'guest');
    account = { ...account, phase: 'in', emailVerified: false };
    await render();
    await act(async () => value.onVote(senses[0].id));
    assert.equal(value.vote.eligibility, 'unverified');
    account = { ...account, emailVerified: true };
    await render();

    let releaseAbandoned;
    transport = (payload) =>
      new Promise((resolve) => {
        releaseAbandoned = () => resolve({ ok: true, selectedId: payload.choice?.id ?? null });
      });
    await act(async () => {
      value.onVote(senses[0].id);
    });
    const beforeAbandon = calls.length;
    await render({ at: { ...target, occurrence: 2 } });
    assert.equal(value.vote.selectedId, null, 'new occurrence starts clean');
    await act(async () => {
      releaseAbandoned();
    });
    assert.equal(calls.length, beforeAbandon, 'abandoned target never triggers follow-up requests');
    assert.equal(value.vote.selectedId, null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, desc] of originals) {
      desc ? Object.defineProperty(globalThis, key, desc) : delete globalThis[key];
    }
  }
});
