import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { preparePositional } from "./lib/sqlite-positional.mjs";

test("preparePositional maps repeated, out-of-order and quoted numbered parameters", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE items (a TEXT, b TEXT, c INTEGER)");
    preparePositional(db, "INSERT INTO items VALUES (?1, ?2, ?3)").run("one", "two", 3);
    const row = preparePositional(
      db,
      "SELECT '?1' AS literal, a, b, c FROM items WHERE (a = ?1 OR b = ?1) AND c > ?3 AND b = ?2",
    ).get("one", "two", 0);
    assert.deepEqual({ ...row }, { literal: "?1", a: "one", b: "two", c: 3 });
  } finally {
    db.close();
  }
});
