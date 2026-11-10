import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/word-feedback.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const icon = () => React.createElement('svg');
const stubs = {
  'lucide-react': { Check: icon, HelpCircle: icon, PenLine: icon },
  '@/lib/i18n': { useT: () => ({ t: key => key }) }, '@/lib/limits': { SUGGESTION_MAX: 500 },
  '@/components/credit-line': { CreditLine: () => null }, '@/components/ui': { cn: (...x) => x.filter(Boolean).join(' ') },
};
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, id => stubs[id] ?? require(id));

test('dictionary community composer stays collapsed and preserves text on failed submissions', async () => {
  const dom = new JSDOM('<div id="root"></div>'); const old = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: f => f() })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React was imported before JSDOM; supply its legacy input-event hooks in this test only.
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  const fetchBefore = globalThis.fetch; let status = 503; let sends = 0;
  globalThis.fetch = async () => { sends++; return { ok: status === 200 }; };
  const root = createRoot(document.querySelector('#root'));
  const click = el => act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  try {
    await act(async () => root.render(React.createElement(mod.exports.WordMeaning, { meaning: '', missing: true, compactMissing: true, part: 'word-meaning', target: { bookId: 'test', word: 'corner' } })));
    assert.equal(document.querySelector('textarea'), null);
    assert.equal(document.querySelector('[data-part="no-meaning"]'), null);
    assert.equal(document.querySelector('[data-feedback-missing]'), null);
    assert.equal(sends, 0);
    await click(document.querySelector('[data-feedback-add-meaning]'));
    const textarea = document.querySelector('textarea'); assert.ok(textarea);
    const propsKey = Object.keys(textarea).find(k => k.startsWith('__reactProps$'));
    await act(async () => textarea[propsKey].onChange({ target: { value: 'Where two sides meet.' } }));
    await click(document.querySelector('[data-feedback-suggestion-send]'));
    assert.equal(sends, 1); assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(document.querySelector('textarea').value, 'Where two sides meet.');
    assert.equal(document.querySelector('[data-feedback-submitted]'), null);
    status = 200; await click(document.querySelector('[data-feedback-suggestion-send]'));
    assert.ok(document.querySelector('[data-feedback-submitted]'));
    assert.equal(document.querySelector('textarea'), null);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = fetchBefore;
    for (const [key, desc] of old) desc ? Object.defineProperty(globalThis, key, desc) : delete globalThis[key];
  }
});
