import assert from "node:assert/strict";
import { test } from "node:test";
import { readDiscoverView, discoverSearch } from "../src/lib/discover-route.ts";
import { parseAddress, routeAddress, parsePath, pathFor } from "../src/lib/router.ts";
import { pageMeta } from "../src/lib/page-meta.ts";

test("Discover filters round-trip independently from canonical paths", () => {
  const browse = { view: "results", genre: "fantasy", band: "under800", collection: "series:Magic Tree House", detail: "list:tree-house" };
  const route = { kind: "discover", category: "novel", browse };
  assert.deepEqual(parseAddress(routeAddress(route)), route);
  assert.equal(pathFor(route), "/discover/novels/");
  assert.deepEqual(parsePath("/discover/novels/"), { kind: "discover", category: "novel" });
  assert.deepEqual(pageMeta(route), { titleKey: "seo.title.discoverNovels", canonical: "https://inputread.site/discover/novels/", index: false });
  assert.equal(pageMeta({ kind: "discover", category: "novel" }).index, true);
});

test("all books is an explicit result even without active filters", () => {
  assert.deepEqual(readDiscoverView("?view=results"), { view: "results" });
  assert.equal(discoverSearch({ view: "results", genre: undefined }), "?view=results");
  assert.deepEqual(readDiscoverView("?genre=fantasy"), { genre: "fantasy", view: "results" });
});

test("search addresses ignore stale genre, collection and advanced filters", () => {
  assert.deepEqual(readDiscoverView("?view=results&q=Wonder&genre=fantasy&collection=series:Magic&band=under800&author=A&series=Magic&sort=easy"), { view: "results", q: "Wonder" });
});

test("unknown query values do not create invalid scopes or book identities", () => {
  assert.deepEqual(readDiscoverView("?genre=unknown&sort=wrong&band=wrong&collection=bad&detail=alice"), {});
  assert.deepEqual(readDiscoverView("?detail=classic:alice"), { detail: "classic:alice" });
  assert.deepEqual(readDiscoverView("?detail=list:alice"), { detail: "list:alice" });
  assert.equal(readDiscoverView(`?q=${"a".repeat(300)}`).q.length, 160);
});
