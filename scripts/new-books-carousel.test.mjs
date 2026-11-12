import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/new-books-carousel.tsx", import.meta.url), "utf8");

test("carousel reuses the original banner and does not reannounce or mount hidden banners", () => {
  assert.match(source, /<FeaturedBook key=\{key\}/);
  assert.match(source, /animateCover=\{false\}/);
  assert.match(source, /carouselFooter \/>/);
  assert.match(source, /absolute bottom-0 left-1\/2/);
  assert.match(source, /size-1\.5 rounded-full/);
  assert.doesNotMatch(source, /data-carousel-all/);
  assert.doesNotMatch(source, /mt-2 flex min-h-11/);
  assert.doesNotMatch(source, /aria-live|\.focus\(|setInterval/);
  const featured = readFileSync(new URL("../src/components/discover-browse.tsx", import.meta.url), "utf8");
  assert.match(featured, /animateCover = true/);
  assert.match(featured, /animateCover && "cover-rise"/);
});

test("carousel banners reserve title, author, late blurb and optional facts space", () => {
  const featured = readFileSync(new URL("../src/components/discover-browse.tsx", import.meta.url), "utf8");
  assert.match(featured, /carouselFooter && "h-\[2\.1em\]"/);
  assert.match(featured, /carouselFooter && "h-6"/);
  assert.match(featured, /blurb \|\| carouselFooter/);
  assert.match(featured, /carouselFooter && "h-\[4\.95em\] sm:h-\[3\.3em\]"/);
  assert.match(featured, /facts\.length \|\| carouselFooter/);
  assert.match(featured, /h-11 content-start overflow-hidden leading-5/);
  assert.doesNotMatch(featured, /h-\[4\.25rem\]/, "mobile facts reserve two lines, not three");
});

test("carousel and Discover avoid horizontal card shift, scroll-anchor jumps, render-phase double renders, and unthrottled history IPC", () => {
  assert.match(source, /\[overflow-anchor:none\]/, "carousel disables CSS scroll anchoring across keyed banner swaps");
  assert.match(source, /preloadFeaturedBooks\?\.\(rows\)/, "carousel preloads tones, blurbs, and covers for upcoming slides");
  assert.doesNotMatch(source, /translateX\(/, "outer banner card perimeter stays stationary during slide transitions");
  const discover = readFileSync(new URL("../src/components/discover.tsx", import.meta.url), "utf8");
  assert.match(discover, /trackDiscoverScroll\(limit\)/, "scroll events update position in memory and debounce history.replaceState");
  assert.doesNotMatch(discover, /if \(windowState\.key !== filterKey\) setWindowState/, "category and genre switches do not trigger a synchronous double render");
});

test("real React carousel timers, pauses, catalog identities and dynamic motion preferences", async (t) => {
  const dom = new JSDOM('<!doctype html><html data-theme="light"><body><div id="root"></div></body></html>', { url: "https://test.invalid" });
  const originals = new Map();
  const set = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  for (const name of ["window", "document", "Element", "HTMLElement", "Node", "Event", "MouseEvent", "FocusEvent", "MutationObserver"]) set(name, dom.window[name]);
  set("IS_REACT_ACT_ENVIRONMENT", true);
  let hidden = false, reduced = false, clock = 0, serial = 0, mounted = 0, unmounted = 0;
  let preference;
  const timers = new Map(), animations = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  window.matchMedia = () => ({ get matches() { return reduced; }, addListener(fn) { preference = fn; }, removeListener(fn) { if (preference === fn) preference = undefined; } });
  window.setTimeout = (fn, delay) => { const id = ++serial; timers.set(id, { at: clock + delay, fn }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  Element.prototype.animate = (frames) => { const animation = { frames, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(animation); return animation; };
  const off = () => reduced || document.documentElement.dataset.theme === "eink";
  function FeaturedBook({ row, onOpen, animateCover }) {
    const [identity] = React.useState(row.key);
    React.useEffect(() => { mounted++; return () => { unmounted++; }; }, []);
    return React.createElement("button", { "data-banner": row.key, "data-owned": identity, "data-cover-animation": String(animateCover), onClick: () => onOpen(row) }, row.title);
  }
  const module = { exports: {} };
  const stubs = {
    "@/components/discover-browse": { FeaturedBook },
    "@/lib/i18n": { useT: () => ({ t: (key, args) => key + (args ? JSON.stringify(args) : "") }) },
    "@/lib/motion": { motionOff: off },
    "lucide-react": Object.fromEntries(["ChevronLeft", "ChevronRight", "Pause", "Play"].map((name) => [name, () => React.createElement("svg")])),
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("module", "exports", "require", js)(module, module.exports, (id) => stubs[id] ?? require(id));
  const { NewBooksCarousel } = module.exports;
  const container = document.querySelector("#root");
  const root = createRoot(container);
  const books = [{ key: "list:same", title: "First" }, { key: "classic:same", title: "Second" }, { key: "list:third", title: "Third" }];
  let props = { rows: books, detailOpen: false, onOpen: () => {}, onSeeAll: () => {} };
  const render = async (change = {}) => { props = { ...props, ...change }; await act(async () => root.render(React.createElement(NewBooksCarousel, props))); };
  const advance = async (ms) => {
    const end = clock + ms;
    while ([...timers.values()].some((timer) => timer.at <= end)) {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      clock = timer.at; timers.delete(id);
      await act(async () => timer.fn());
    }
    clock = end;
  };
  const click = async (selector) => act(async () => container.querySelector(selector).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const toggle = () => click("[data-carousel-play]");
  const banner = () => container.querySelector("[data-banner]")?.dataset.banner;
  const region = () => container.querySelector("[data-new-books-carousel]");
  const hover = async (value) => act(async () => region().dispatchEvent(new MouseEvent(value ? "mouseover" : "mouseout", { bubbles: true, relatedTarget: value ? null : document.body })));
  try {
    await t.test("0/1 items have no rotation controls or timers", async () => {
      await render({ rows: [] });
      assert.equal(container.children.length, 0);
      assert.equal(timers.size, 0);
      await render({ rows: [books[0]] });
      assert.equal(container.querySelector("[data-carousel-controls]"), null);
      assert.equal(timers.size, 0);
    });
    await t.test("6-second wrap mounts only one composite-keyed banner", async () => {
      await render({ rows: books });
      assert.equal(banner(), "list:same");
      assert.equal(container.querySelectorAll("[data-banner]").length, 1);
      assert.equal(container.querySelector("[data-banner]").dataset.coverAnimation, "false");
      await advance(3000);
      await render({ rows: books.map((book) => ({ ...book })) });
      await advance(2999); assert.equal(banner(), "list:same");
      await advance(1); assert.equal(banner(), "classic:same");
      assert.equal(container.querySelector("[data-banner]").dataset.owned, "classic:same");
      await advance(12000); assert.equal(banner(), "list:same");
      assert.ok(unmounted > 0 && mounted > 1);
    });
    await t.test("array refresh retains identity, deleted current item falls back safely", async () => {
      await render({ rows: [books[2], books[0], books[1]] });
      assert.equal(banner(), "list:same");
      await render({ rows: [books[2], books[1]] });
      assert.equal(banner(), "list:third");
      await render({ rows: books });
      assert.equal(banner(), "list:third");
    });
    await t.test("manual navigation and keyboard focus stay paused until explicit Play", async () => {
      await click('[data-carousel-position="0"]');
      assert.equal(banner(), "list:same"); assert.equal(timers.size, 0);
      await advance(12000); assert.equal(banner(), "list:same");
      await toggle(); assert.equal(timers.size, 1);
      const playback = container.querySelector("[data-carousel-play]");
      await act(async () => {
        playback.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        playback.focus();
        playback.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        playback.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      assert.equal(timers.size, 0, "pointer focus does not invert the Pause click");
      await toggle(); assert.equal(timers.size, 1);
      await act(async () => { playback.blur(); playback.focus(); });
      assert.equal(timers.size, 0, "keyboard focus on playback control also stops rotation");
      await toggle(); assert.equal(timers.size, 1, "Play can resume while its own button retains focus");
      await advance(6000); assert.equal(banner(), "classic:same");
      await toggle(); assert.equal(timers.size, 0);
      await toggle(); assert.equal(timers.size, 1);
    });
    await t.test("hover/visibility/detail temporarily stop and restart a full interval", async () => {
      await advance(3000);
      await hover(true); assert.equal(timers.size, 0);
      await advance(8000);
      await hover(false); assert.equal(timers.size, 1);
      const current = banner();
      await advance(5999); assert.equal(banner(), current);
      await advance(1); assert.notEqual(banner(), current);
      hidden = true; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      assert.equal(timers.size, 0);
      hidden = false; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      assert.equal(timers.size, 1);
      await render({ detailOpen: true }); assert.equal(timers.size, 0);
      await render({ detailOpen: false }); assert.equal(timers.size, 1);
    });
    await t.test("live reduced motion and e-ink disable timer/animation but not manual controls", async () => {
      reduced = true; await act(async () => preference());
      assert.equal(timers.size, 0);
      const count = animations.length;
      await click('[data-carousel-position="0"]');
      assert.equal(banner(), "list:same"); assert.equal(animations.length, count);
      reduced = false; await act(async () => preference());
      assert.equal(timers.size, 0, "manual pause survives a motion preference change");
      await toggle(); assert.equal(timers.size, 1);
      await act(async () => { document.documentElement.dataset.theme = "eink"; });
      assert.equal(timers.size, 0);
      await click('[data-carousel-position="1"]');
      assert.equal(banner(), "classic:same"); assert.equal(animations.length, count);
      await act(async () => { document.documentElement.dataset.theme = "light"; });
      assert.equal(timers.size, 0);
    });
  } finally {
    await act(async () => root.unmount());
    assert.equal(timers.size, 0);
    assert.equal(preference, undefined, "legacy media listener removed");
    assert.ok(animations.every((animation) => animation.cancelled), "animations cancelled on change/unmount");
    dom.window.close();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
