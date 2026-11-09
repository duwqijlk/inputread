import assert from "node:assert/strict";
import { test } from "node:test";
import { filterDiscover, interleaveDiscoverSeries, searchDiscover } from "../src/lib/discover-filter.ts";
import { readFileSync } from "node:fs";

const base = { query: "", band: "all", author: "all", series: "all", sort: "listed" };
const rows = [
  { key: "list:one", title: "Journey Two", author: "A", lexile: "790L", series: "Journey", seriesNumber: 2, genres: ["fantasy", "adventure"] },
  { key: "list:two", title: "Journey One", author: "A", lexile: "910L", series: "Journey", seriesNumber: 1, genres: ["adventure"] },
  { key: "classic:one", title: "An unclassified book", author: "B", lexile: "700L", series: "", seriesNumber: 0, genres: [] },
];

test("multi-genre rows match each genre once without collapsing cross-catalog identity", () => {
  assert.equal(filterDiscover(rows, { ...base, genre: "fantasy" }).length, 1);
  assert.equal(filterDiscover([...rows, rows[0]], { ...base, genre: "adventure" }).length, 2);
  assert.equal(filterDiscover(rows, base).length, 3);
  assert.equal(filterDiscover(rows, { ...base, query: "unclassified" })[0].key, "classic:one");
});

test("genre, text, level, author and series are intersected", () => {
  assert.deepEqual(filterDiscover(rows, { ...base, genre: "adventure", query: "journey", band: "under800", author: "A", series: "Journey" }).map((row) => row.key), ["list:one"]);
  assert.equal(filterDiscover(rows, { ...base, genre: "fantasy", author: "B" }).length, 0);
  assert.deepEqual(filterDiscover(rows, { ...base, series: "none" }).map((row) => row.key), ["classic:one"]);
});

test("genre browsing interleaves series volumes and ungrouped books without hiding rows", () => {
  const a = (key, series = "", seriesNumber = 0) => ({ ...rows[0], key, title: key, author: "Z", series, seriesNumber });
  const catalog = [a("a3", "A", 3), a("a1", "A", 1), a("single1"), a("b2", "B", 2), a("a2", "A", 2), a("b1", "B", 1), a("single2")];
  const ordered = interleaveDiscoverSeries(catalog);
  assert.deepEqual(ordered.map((row) => row.key), ["a1", "single1", "b1", "single2", "a2", "b2", "a3"]);
  assert.equal(new Set(ordered.map((row) => row.key)).size, catalog.length);
  assert.equal(catalog[0].key, "a3", "catalog order is not mutated");
  assert.deepEqual(filterDiscover(catalog, { ...base, interleave: true }), ordered);
  assert.deepEqual(filterDiscover(catalog, { ...base, query: "a", interleave: true }).map((row) => row.key), ["a3", "a1", "a2"], "search does not interleave");
  assert.deepEqual(filterDiscover(catalog, { ...base, series: "A", interleave: true }).map((row) => row.key), ["a1", "a2", "a3"]);
});

test("global Discover search covers books and speeches in both catalogs", () => {
  const catalog = [
    { ...rows[0], key: "list:shared", title: "River Journey", category: "novel" },
    { ...rows[1], key: "list:speech", title: "River Speech", category: "speech" },
    { ...rows[2], key: "classic:shared", title: "River Classic", category: "novel" },
    { ...rows[2], key: "classic:speech", title: "An address", author: "River Speaker", category: "speech" },
  ];
  const result = searchDiscover([...catalog, catalog[0]], " RIVER ");
  assert.deepEqual(result.map(row => row.key), catalog.map(row => row.key));
  assert.deepEqual(searchDiscover(catalog, "speech").map(row => row.key), ["list:speech"]);
  assert.deepEqual(searchDiscover(catalog, "journey").map(row => row.key), ["list:shared"]);
  assert.deepEqual(searchDiscover(catalog, "missing"), []);
  assert.deepEqual(catalog.map(row => row.key), ["list:shared", "list:speech", "classic:shared", "classic:speech"]);
});

test("Discover uses all rows for search and leaves the input visible on an empty category", () => {
  const source = readFileSync(new URL("../src/components/discover.tsx", import.meta.url), "utf8");
  assert.match(source, /query\.trim\(\) \? searchDiscover\(rows, query\) : filterDiscover\(scoped,/);
  assert.match(source, /!ready \|\| rows\.length > 0/);
  assert.match(source, /query\.trim\(\) \? t\("discover.searchResults"\)/);
  assert.match(source, /<p>\{query\.trim\(\)/, "search no-match takes priority over empty speech category");
});

test("named series defaults to volume order while explicit difficulty sorting wins", () => {
  assert.deepEqual(filterDiscover(rows, { ...base, series: "Journey" }).map((row) => row.seriesNumber), [1, 2]);
  assert.deepEqual(filterDiscover(rows, { ...base, series: "Journey", sort: "easy" }).map((row) => row.seriesNumber), [2, 1]);
  assert.deepEqual(rows.map((row) => row.key), ["list:one", "list:two", "classic:one"], "filtering never mutates catalog order");
});
