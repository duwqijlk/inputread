import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/components/discover-genres.tsx", import.meta.url), "utf8");
const discover = readFileSync(new URL("../src/components/discover.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../src/components/discover-home.tsx", import.meta.url), "utf8");

test("genre navigation reuses existing text-and-underline tabs, not filled buttons", () => {
  assert.match(source, /border-b border-line/);
  assert.match(source, /subTabs\.tab/);
  assert.match(source, /selected \? subTabs\.on : subTabs\.off/);
  assert.doesNotMatch(source, /bg-accent-soft|rounded-lg|px-3/);
  assert.match(source, /role="group"/);
  assert.match(source, /aria-pressed=\{selected\}/);
  assert.match(source, /overflow-x-auto overflow-y-hidden/);
  assert.doesNotMatch(source, /flex-wrap/);
  assert.match(source, /disabled=\{!edges\.left\}/);
  assert.match(source, /disabled=\{!edges\.right\}/);
  assert.match(source, /data-genres-prev/);
  assert.match(source, /data-genres-next/);
  assert.match(source, /node\.scrollLeft/);
});

test("third-level genres remain above search in both discovery states", () => {
  const tabs = discover.indexOf("<DiscoverGenres");
  const search = discover.indexOf("data-discover-search", tabs);
  const results = discover.indexOf('id="discover-results"', tabs);
  assert.ok(tabs > 0 && tabs < search && search < results);
  assert.doesNotMatch(home, /data-genre-entry|allGenres|onGenre/);
  assert.match(discover, /else changeView\(\{ genre: undefined, collection: undefined, q: undefined/);
  assert.doesNotMatch(discover, /<FilterMenu|<DifficultyControls|<ListFilters/);
  assert.doesNotMatch(home, /onCollection\("all"\)|data-browse-all/);
  assert.doesNotMatch(discover, /const browsing|<DiscoverHome/);
  assert.match(discover, /\{ready && hasMore \? \(/);
});
