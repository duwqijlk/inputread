import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("lookup menu is a non-modal, collision-aware portal rather than inline body content", () => {
  const menu = read("src/components/word-lookup-menu.tsx");
  assert.match(menu, /@radix-ui\/react-dropdown-menu/);
  assert.match(menu, /modal=\{false\}/);
  assert.match(menu, /<Menu\.Portal>/);
  assert.match(menu, /align="end"/);
  assert.match(menu, /collisionPadding=\{8\}/);
  assert.match(menu, /<Ellipsis/);
  assert.match(menu, /w-\[220px\]/);
  assert.match(menu, /min-h-11/);
  assert.match(menu, /<Menu\.Item key=\{site\} asChild>/);
  assert.match(menu, /target="_blank"/);
  assert.match(menu, /rel="noopener noreferrer"/);
  assert.match(menu, /<ArrowUpRight/);
  assert.match(menu, /onEscapeKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(menu, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(menu, /onTouchMove=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.doesNotMatch(menu, /fetch\(|localStorage|indexedDB/);
  const card = read("src/components/word-card.tsx");
  assert.ok(!card.slice(card.indexOf("data-word-body")).includes("data-word-lookup-menu"));
});
