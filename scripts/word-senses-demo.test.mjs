import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("src/dev/word-senses-model.ts");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", js)(module, module.exports);
const {
  initialDemoState,
  beginDemoVote,
  completeDemoVote,
  cancelDemoRequest,
  demoResolution,
  DEMO_SENSES,
  DEMO_LONG_SENSES,
} = module.exports;

test("demo votes are acknowledged once, can switch/cancel, and never reorder candidates", () => {
  let state = initialDemoState();
  const id = DEMO_SENSES[1].id;
  state = beginDemoVote(state, "river", id);
  assert.equal(state.places.river.selected, null, "pending is not success");
  assert.equal(state.places.river.acknowledged, false);
  assert.equal(
    beginDemoVote(state, "river", DEMO_SENSES[0].id),
    state,
    "in-flight duplicate rejected",
  );
  state = completeDemoVote(state, state.pending.ticket, "success");
  assert.equal(state.places.river.counts[id], 9);
  assert.equal(state.places.river.acknowledged, true);
  assert.equal(state.places.money.acknowledged, false);
  const same = completeDemoVote(state, 1, "success");
  assert.equal(same, state);
  state = beginDemoVote(state, "river", DEMO_SENSES[0].id);
  state = completeDemoVote(state, state.pending.ticket, "success");
  assert.equal(state.places.river.counts[id], 8);
  assert.equal(state.places.river.counts[DEMO_SENSES[0].id], 4);
  assert.deepEqual(
    demoResolution("unmapped", "river", state).senses.map((sense) => sense.id),
    DEMO_SENSES.map((sense) => sense.id),
  );
  state = beginDemoVote(state, "river", null);
  state = completeDemoVote(state, state.pending.ticket, "success");
  assert.equal(state.places.river.selected, null);
  assert.equal(state.places.river.counts[DEMO_SENSES[0].id], 3);
});

test("location changes, failures and fixed responses cannot leak stale votes", () => {
  let state = initialDemoState();
  state = beginDemoVote(state, "river", DEMO_SENSES[0].id);
  const oldTicket = state.pending.ticket;
  state = cancelDemoRequest(state);
  assert.equal(completeDemoVote(state, oldTicket, "success"), state);
  state = beginDemoVote(state, "money", DEMO_SENSES[0].id);
  state = completeDemoVote(state, state.pending.ticket, "failed");
  assert.equal(state.places.money.selected, null);
  assert.equal(state.places.money.acknowledged, false);
  assert.equal(state.error, "failed");
  state = beginDemoVote(state, "river", DEMO_SENSES[1].id);
  const ticket = state.pending.ticket;
  state = completeDemoVote(state, ticket, "fixed");
  assert.equal(demoResolution("unmapped", "river", state).kind, "mapped");
  assert.equal(demoResolution("unmapped", "money", state).kind, "unmapped");
  assert.equal(completeDemoVote(state, ticket, "failed"), state);
  assert.equal(beginDemoVote(state, "river", DEMO_SENSES[0].id), state);
});

test("all demo candidates are selectable, invalid IDs are not", () => {
  let state = initialDemoState();
  assert.equal(beginDemoVote(state, "river", "invalid"), state);
  state = beginDemoVote(state, "river", DEMO_LONG_SENSES.at(-1).id);
  assert.ok(state.pending);
  assert.equal(demoResolution("long", "river", state).senses.length, 8);
});

test("community-only and neither-fixed both return all standard candidates", () => {
  const state = initialDemoState();
  for (const scenario of ["communityOnly", "candidatesOnly"]) {
    const result = demoResolution(scenario, "river", state);
    assert.equal(result.kind, "unmapped");
    assert.deepEqual(result.senses.map(sense => sense.id), DEMO_SENSES.map(sense => sense.id));
  }
  assert.equal(demoResolution("standardOnly", "river", state).kind, "mapped");
  assert.equal(demoResolution("mapped", "river", state).kind, "mapped");
});

test("prototype entry is DEV-only and the normal WordMeaning path is preserved", () => {
  const main = read("src/main.tsx"),
    card = read("src/components/word-card.tsx"),
    demo = read("src/dev/word-senses-demo.tsx");
  assert.match(main, /import\.meta\.env\.DEV && window\.location\.pathname === "\/shelf\/"/);
  assert.match(main, /get\("demo"\) === "word-senses"/);
  assert.match(main, /void import\("\.\/dev\/word-senses-demo"\)/);
  assert.match(card, /sensePanel \?\s*\(\s*<WordSensePanel/);
  assert.match(card, /meaningContent \?\?/);
  assert.match(card, /<WordMeaning/);
  assert.match(card, /compactLookups = true/);
  assert.match(card, /<WordLookupMenu word=\{target\} open=\{lookupsOpen\} onOpenChange=\{setLookupsOpen\}/);
  assert.doesNotMatch(card, /hidden=\{!lookupsOpen\}/);
  assert.match(card, /!compactLookups \? \(/);
  assert.match(card, /compactLookups && "!mb-0 !pb-3"/, "reserve the inline feedback hit area so short content does not overflow");
  assert.doesNotMatch(
    demo + source,
    /fetch\(|\/api\/|localStorage|indexedDB|sendReason|sendMeaning/,
  );
  assert.match(demo, /meaningContent=\{scenario === "readerCommunity" \? undefined : panel\}/);
  assert.doesNotMatch(demo, /draftKept|Keep local draft/);
  const noMatch = demo.match(/onNoMatch=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(noMatch);
  assert.match(noMatch, /setWriting\(false\)/);
  assert.doesNotMatch(noMatch, /setWriting\(true\)|onWrite/);
  assert.match(demo, /communityEditor=\{writing/);
  const wrong = demo.match(/onStandardWrong=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(wrong);
  assert.match(wrong, /setWriting\(false\)/);
  assert.doesNotMatch(wrong, /setWriting\(true\)/);
  assert.match(demo, /setSaved\(true\)/);
  assert.doesNotMatch(demo, /setSaved\(.*selected/);
});
