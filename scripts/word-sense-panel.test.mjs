import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL("../src/components/word-sense-panel.tsx", import.meta.url),
  "utf8",
);
const messages = {
  "card.senses.views": "Meaning views",
  "card.senses.recommended": "Recommended",
  "card.senses.dictionary": "Dictionary",
  "card.feedbackPrompt": "Meaning feedback",
  "card.feedbackQuestion": "What is wrong?",
  "card.feedbackTooHard": "Too hard",
  "card.feedbackWrong": "Wrong meaning",
  "card.senses.candidates": "Which meaning fits this sentence?",
  "card.senses.voteHelp": "Use thumbs-up to choose the meaning here.",
  "card.senses.fitsHere": "Fits here",
  "card.senses.removeChoice": "Remove my choice",
  "card.senses.choiceSaved": "Choice saved. Pending review.",
  "card.senses.choiceRemoved": "Choice removed.",
  "card.senses.noMatch": "None of these meanings fit here",
  "card.senses.standardWrong": "This meaning is not accurate",
  "card.senses.communityInvite": "You can add a community explanation for this sentence.",
  "card.senses.writeCommunity": "Write a community explanation",
  "card.senses.standard": "Standard meanings",
  "card.senses.community": "Community explanation",
  "card.senses.loading": "Loading standard meanings...",
  "card.senses.error": "Standard meanings could not load.",
  "card.senses.missing": "No standard meaning found.",
  "card.senses.empty": "No candidates at this location.",
  "card.senses.vote": "This meaning fits here: {meaning}",
  "card.senses.cancelVote": "Remove my choice: {meaning}",
  "card.senses.guest": "Sign in to vote.",
  "card.senses.unverified": "Verify your email to vote.",
  "card.senses.authLoading": "Checking voting eligibility...",
  "card.senses.pending": "Saving vote...",
  "card.senses.voteFailed": "Vote not saved. Try again.",
  "card.senses.voteFixed": "This location now has a fixed meaning.",
  "card.senses.retry": "Try again",
  "card.senses.report": "Report a meaning problem",
  "card.senses.from": "From {name}",
  "card.feedbackAddMeaning": "Write my own",
};
const t = (key, args = {}) => {
  assert.ok(Object.hasOwn(messages, key), `Unrecognized translation key: ${key}`);
  return messages[key].replace(/\{(\w+)\}/g, (_, name) => {
    assert.ok(Object.hasOwn(args, name), `Missing translation argument: ${name}`);
    return args[name];
  });
};
const module = { exports: {} };
const stubs = {
  "@/components/ui": { cn: (...parts) => parts.filter(Boolean).join(" "), subTabs: { row: "tabs", tab: "tab", on: "on", off: "off" } },
  "@/lib/i18n": { useT: () => ({ t }) },
  "lucide-react": {
    HelpCircle: (props) => React.createElement("svg", props),
    ThumbsUp: (props) => React.createElement("svg", { ...props, "data-icon": "thumbs-up" }),
  },
};
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
new Function("module", "exports", "require", js)(module, module.exports, (id) => {
  if (Object.hasOwn(stubs, id)) return stubs[id];
  assert.ok(["react", "react/jsx-runtime"].includes(id), `Unexpected production dependency: ${id}`);
  return require(id);
});
const { WordSensePanel } = module.exports;
const senses = [
  { id: "demo:bank:river", pos: "noun", meaning: "the land beside a river", votes: 4 },
  { id: "demo:bank:money", pos: "noun", meaning: "a place that keeps money", votes: 25 },
  { id: "demo:bank:turn", pos: "verb", meaning: "to lean while turning" },
];
const verified = { eligibility: "verified", selectedId: null, pending: false };

test("panel remains presentation-only and does not invent sense identities or transport", () => {
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|CreditLine|localStorage|indexedDB|setTimeout|useEffect/,
  );
  assert.doesNotMatch(source, /\/api\/|animate-|transition-|\.sort\(/);
  assert.match(source, /divide-y divide-line/);
  assert.match(source, /font-display/);
});

test("actual React sense panel: resolution, controlled votes and attribution", async (suite) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://test.invalid",
  });
  const originals = new Map();
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.querySelector("#root");
  const root = createRoot(container);
  const calls = { votes: [], write: 0, retry: 0, report: 0 };
  const defaults = {
    resolution: { kind: "unmapped", senses },
    vote: verified,
    onVote: (id) => calls.votes.push(id),
    onWrite: () => calls.write++,
    onRetry: () => calls.retry++,
    onReport: () => calls.report++,
  };
  const render = async (change = {}) => {
    calls.votes = [];
    calls.write = 0;
    calls.retry = 0;
    calls.report = 0;
    await act(async () =>
      root.render(React.createElement(WordSensePanel, { ...defaults, ...change })),
    );
  };
  const buttons = () => [...container.querySelectorAll("[data-sense-vote]")];
  const click = async (button) =>
    act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  // Exercise the real callback as well as native disabled behavior: the handler must guard eligibility/busy itself.
  const invokeHandler = async (button) => {
    const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
    assert.ok(propsKey, "React attached the actual button handler");
    await act(async () => button[propsKey].onClick());
  };
  try {
    await suite.test(
      "all unresolved candidates retain parent order without public counts",
      async () => {
        await render();
        assert.deepEqual(
          [...container.querySelectorAll("[data-sense-id]")].map((item) => item.dataset.senseId),
          senses.map((sense) => sense.id),
        );
        assert.equal(buttons().length, 3);
        assert.deepEqual(
          buttons().map((button) => button.textContent),
          ["", "", ""],
        );
        for (const [index, button] of buttons().entries()) {
          assert.equal(button.getAttribute("aria-pressed"), "false");
          assert.equal(button.getAttribute("aria-label"), `This meaning fits here: ${senses[index].meaning}`);
          assert.equal(button.title, "Fits here");
          assert.match(button.className, /min-h-(?:9|11) min-w-(?:9|11)/);
          assert.equal(button.querySelector("svg").getAttribute("fill"), "none");
        }
        await click(container.querySelector("[data-sense-id] p"));
        assert.deepEqual(calls.votes, [], "the row and meaning are inert");
        await click(buttons()[1]);
        assert.deepEqual(calls.votes, [senses[1].id]);
        assert.equal(
          buttons()[1].getAttribute("aria-pressed"),
          "false",
          "selection waits for parent",
        );
        assert.equal(buttons()[1].textContent, "", "public counts stay hidden");
        assert.equal(container.querySelector("[data-sense-choice-saved]"), null, "no success before acknowledgement");
      },
    );
    await suite.test(
      "one controlled selection can change or cancel without reordering",
      async () => {
        await render({ vote: { ...verified, selectedId: senses[1].id } });
        assert.deepEqual(
          buttons().map((button) => button.getAttribute("aria-pressed")),
          ["false", "true", "false"],
        );
        assert.match(buttons()[1].className, /text-accent/);
        assert.equal(
          buttons()[1].getAttribute("aria-label"),
          `Remove my choice: ${senses[1].meaning}`,
        );
        await click(buttons()[1]);
        await click(buttons()[0]);
        assert.deepEqual(calls.votes, [null, senses[0].id]);
        assert.deepEqual(
          buttons().map((button) => button.textContent),
          ["", "", ""],
        );
      },
    );
    await suite.test("acknowledged selection is pending review, cancellation is distinct", async () => {
      await render({ vote: { ...verified, selectedId: senses[1].id, acknowledged: true } });
      assert.equal(container.querySelector("[data-sense-choice-saved]").textContent, messages["card.senses.choiceSaved"]);
      assert.equal(buttons()[1].title, "Remove my choice");
      await render({ vote: { ...verified, acknowledged: true } });
      assert.equal(container.querySelector('[aria-live="polite"]').textContent, messages["card.senses.choiceRemoved"]);
      await render();
      assert.equal(container.querySelector('[aria-live="polite"]').textContent, "");
    });
    await suite.test("no-match delegates separately without voting, even with community", async () => {
      let noMatch = 0;
      await render({ community: { kind: "community", meaning: "A river side." }, onNoMatch: () => noMatch++ });
      await click(container.querySelector('[data-sense-tab="dictionary"]'));
      await click(container.querySelector('[data-sense-no-match]'));
      assert.equal(noMatch, 1);
      assert.deepEqual(calls.votes, []);
      let wrong = 0;
      await render({ resolution: { kind: "mapped", sense: senses[0] }, onNoMatch: () => noMatch++, onStandardWrong: () => wrong++ });
      assert.equal(container.querySelector("[data-sense-no-match]"), null);
      assert.ok(container.querySelector("[data-write-community]"));
      assert.equal(container.querySelector('[role="tablist"]'), null);
      assert.equal(container.querySelector("[data-community-explanation]"), null);
      assert.equal(buttons().length, 0);
      assert.equal(container.querySelectorAll("[data-sense-id]").length, 1);
      assert.ok(!container.textContent.includes("Write my own"));
      assert.equal(container.querySelector('[aria-label="Report a meaning problem"]'), null);
      await click(container.querySelector("[data-standard-wrong]"));
      assert.equal(wrong, 1);
      assert.equal(noMatch, 1);
      assert.equal(container.querySelector("textarea"), null, "wrong report never asks for text");
      await click(container.querySelector("[data-write-community]"));
      assert.equal(calls.write, 1, "community submission is a separate action");
    });
    await suite.test("four content states show only their matching content and actions", async () => {
      const community = { kind: "community", meaning: "A river side.", author: "Reader" };
      for (const hasStandard of [false, true]) {
        for (const hasCommunity of [false, true]) {
          await render({
            resolution: hasStandard ? { kind: "mapped", sense: senses[0] } : { kind: "unmapped", senses },
            community: hasCommunity ? community : undefined,
            communityEditor: React.createElement("textarea"),
            onStandardWrong: () => {},
          });
          assert.equal(Boolean(container.querySelector("[data-community-explanation]")), hasCommunity);
          assert.equal(Boolean(container.querySelector("[data-fixed-standard]")), hasStandard);
          assert.equal(buttons().length, hasStandard ? 0 : senses.length);
          assert.equal(Boolean(container.querySelector('[role="tablist"]')), hasCommunity && !hasStandard);
          assert.equal(Boolean(container.querySelector("[data-community-invitation]")), hasStandard && !hasCommunity);
          assert.equal(Boolean(container.querySelector("[data-standard-wrong]")), hasStandard);
          if (hasStandard && !hasCommunity) assert.ok(container.querySelector("[data-community-invitation] textarea"));
          if (hasStandard && hasCommunity) assert.equal(container.querySelector("[data-write-community]"), null);
        }
      }
    });
    await suite.test(
      "guests, unverified and loading accounts cannot trigger voting or auth",
      async () => {
        for (const [eligibility, message] of [
          ["guest", messages["card.senses.guest"]],
          ["unverified", messages["card.senses.unverified"]],
          ["loading", messages["card.senses.authLoading"]],
        ]) {
          await render({ vote: { ...verified, eligibility } });
          assert.ok(buttons().every((button) => button.disabled));
          assert.ok(container.textContent.includes(message));
          const reasonIds = buttons()[0].getAttribute("aria-describedby").split(" ");
          assert.ok(reasonIds.some((id) => document.getElementById(id)?.textContent === message));
          await click(buttons()[0]);
          await invokeHandler(buttons()[0]);
          assert.deepEqual(calls, { votes: [], write: 0, retry: 0, report: 0 });
        }
      },
    );
    await suite.test(
      "pending is busy, announced and guarded; failure leaves controlled rollback usable",
      async () => {
        await render({ vote: { ...verified, selectedId: senses[0].id, pending: true } });
        assert.equal(container.querySelector("ul").getAttribute("aria-busy"), "true");
        assert.equal(
          container.querySelector('[aria-live="polite"]').textContent,
          messages["card.senses.pending"],
        );
        assert.ok(buttons().every((button) => button.disabled));
        await invokeHandler(buttons()[1]);
        assert.deepEqual(calls.votes, []);
        await render({ vote: { ...verified, selectedId: senses[0].id, error: "failed" } });
        assert.equal(
          container.querySelector('[aria-live="polite"]').textContent,
          messages["card.senses.voteFailed"],
        );
        assert.equal(buttons()[0].getAttribute("aria-pressed"), "true");
        assert.equal(buttons()[0].textContent, "");
        assert.equal(container.querySelector("[data-sense-choice-saved]"), null);
        await click(buttons()[1]);
        assert.deepEqual(calls.votes, [senses[1].id]);
      },
    );
    await suite.test(
      "mapped shows exactly its one standard sense and ignores stale vote state",
      async () => {
        for (const error of ["failed", "fixed"]) {
          await render({
            resolution: { kind: "mapped", sense: senses[1] },
            vote: { eligibility: "guest", selectedId: senses[0].id, pending: true, error },
          });
          assert.equal(container.querySelectorAll("[data-sense-id]").length, 1);
          assert.equal(container.querySelector("[data-sense-id]").dataset.senseId, senses[1].id);
          assert.equal(buttons().length, 0);
          assert.equal(container.querySelector('[aria-busy="true"]'), null);
          assert.equal(container.querySelector('[aria-live="polite"]'), null);
          assert.ok(!container.textContent.includes(messages["card.senses.guest"]));
          assert.ok(!container.textContent.includes(messages["card.senses.voteFailed"]));
          assert.ok(!container.textContent.includes(messages["card.senses.voteFixed"]));
          assert.deepEqual(calls.votes, []);
        }
      },
    );
    await suite.test(
      "a stale fixed response blocks further requests until parent maps",
      async () => {
        await render({ vote: { ...verified, error: "fixed" } });
        assert.ok(container.textContent.includes(messages["card.senses.voteFixed"]));
        assert.ok(buttons().every((button) => button.disabled));
        await invokeHandler(buttons()[0]);
        assert.deepEqual(calls.votes, []);
      },
    );
    await suite.test(
      "recommended and dictionary tabs separate community from candidates",
      async () => {
        for (const kind of ["community"]) {
          await render({
            community: { kind, meaning: "The side of a river.", author: "Sample Reader" },
          });
          await click(container.querySelector('[data-sense-tab="recommended"]'));
          assert.equal(container.querySelector("[data-recommended-meanings]").hidden, false);
          assert.equal(container.querySelector("[data-dictionary-meanings]").hidden, true);
          const section = container.querySelector("[data-community-explanation]");
          assert.equal(section.firstElementChild.textContent, messages[`card.senses.${kind}`]);
          assert.ok(!section.className.includes("border-l"));
          assert.ok(section.textContent.includes("From Sample Reader"));
          assert.ok(
            section.querySelector("p button[data-community-feedback]"),
            "question mark follows explanation",
          );
          assert.equal(container.querySelector("[data-community-feedback-options]"), null);
          await click(container.querySelector("[data-community-feedback]"));
          assert.ok(container.querySelector("[data-community-feedback-options]"));
          await click(container.querySelector("[data-community-feedback]"));
          await click(container.querySelector('[data-sense-tab="dictionary"]'));
          assert.equal(container.querySelector("[data-dictionary-meanings]").hidden, false);
          assert.equal(buttons().length, senses.length);
        }
        await render({
          resolution: { kind: "mapped", sense: senses[0] },
          community: { kind: "community", meaning: "Old explanation" },
        });
        assert.equal(container.querySelector('[role="tablist"]'), null);
        assert.equal(buttons().length, 0);
        assert.ok(container.querySelector("[data-fixed-standard]"));
        assert.ok(container.querySelector("[data-community-explanation]"));
        assert.ok(!container.querySelector("[data-community-explanation]").textContent.includes("From "), "unsigned content has no invented contributor");
        await render({ community: { kind: "community", meaning: "   " } });
        assert.equal(container.querySelector("[data-community-explanation]"), null);
      },
    );
    await suite.test(
      "loading, error, missing and empty candidates are distinct read-only states",
      async () => {
        for (const [resolution, key] of [
          [{ kind: "loading" }, "loading"],
          [{ kind: "error" }, "error"],
          [{ kind: "missing" }, "missing"],
          [{ kind: "unmapped", senses: [] }, "empty"],
        ]) {
          await render({
            resolution,
          });
          assert.ok(container.textContent.includes(messages[`card.senses.${key}`]));
          assert.equal(container.querySelectorAll("[data-sense-id]").length, 0);
          assert.equal(buttons().length, 0);
          assert.equal(container.querySelectorAll("[data-community-explanation]").length, 0);
          if (key === "error") {
            assert.equal(
              container.querySelector('[role="alert"]').textContent,
              messages["card.senses.error"],
            );
            await click(
              [...container.querySelectorAll("button")].find(
                (button) => button.textContent === "Try again",
              ),
            );
            assert.equal(calls.retry, 1);
          }
        }
        await render({ resolution: { kind: "error" }, onRetry: undefined });
        assert.ok(!container.textContent.includes("Try again"));
      },
    );
    await suite.test("production credit slot, word class and community reason stay distinct", async () => {
      const reasons = [];
      await render({
        resolution: { kind: "mapped", sense: senses[0] },
        community: { kind: "community", meaning: "A river side.", pos: "noun", author: "Fallback name" },
        communityCredit: React.createElement("p", { "data-test-credit": true }, "Resolved contributor"),
        onReport: (reason) => reasons.push(reason),
      });
      assert.ok(container.querySelector("[data-community-explanation]").textContent.includes("noun"));
      assert.ok(container.querySelector("[data-test-credit]"));
      assert.ok(!container.textContent.includes("Fallback name"));
      await click(container.querySelector("[data-community-feedback]"));
      await click([...container.querySelectorAll("button")].find(button => button.textContent === "Too hard"));
      await click([...container.querySelectorAll("button")].find(button => button.textContent === "Wrong meaning"));
      assert.deepEqual(reasons, ["too_hard", "wrong_meaning"]);
      await click(container.querySelector("[data-community-feedback]"));
    });
    await suite.test("content feedback is community-only and never leaks to dictionary", async () => {
      await render({
        community: { kind: "community", meaning: "A river side." },
        communityEditor: React.createElement("textarea", { "data-test-community-editor": true }),
        vote: { ...verified, eligibility: "guest", pending: true },
      });
      await click(container.querySelector('[data-sense-tab="recommended"]'));
      await click(container.querySelector("[data-community-feedback]"));
      await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Write my own"));
      await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Wrong meaning"));
      assert.deepEqual(calls, { votes: [], write: 1, retry: 0, report: 1 });
      assert.ok(container.querySelector("[data-community-explanation] textarea"));
      await click(container.querySelector('[data-sense-tab="dictionary"]'));
      assert.equal(container.querySelector("[data-recommended-meanings]").hidden, true);
      assert.equal(container.querySelector("[data-dictionary-meanings] textarea"), null);
      assert.ok(!container.querySelector("[data-dictionary-meanings]").textContent.includes("Write my own"));
      await render();
      assert.ok(!container.textContent.includes("Write my own"));
      assert.equal(container.querySelector("textarea"), null);
      assert.equal(container.querySelector('[aria-label="Report a meaning problem"]'), null);
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
