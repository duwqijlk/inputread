// Protected L1 position mappings endpoint: aligned with weekly 7-book glossary_reads gate + ETag 304 streaming.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleGlossary } from "../functions/api/glossary/[id].ts";
import { handlePositionMappings } from "../functions/api/dictionary/positions/[catalog]/[id].ts";
import { sha256Hex } from "../functions/lib/password.ts";
import { setPruneRoll } from "../functions/lib/rate-limit.ts";
import { preparePositional } from "./lib/sqlite-positional.mjs";

setPruneRoll(() => 1);
const NOW = 1_800_000_000_000;
const SAMPLE_V2 = JSON.stringify({
  schema: "oewn-position-mappings-v2",
  catalogId: "word-lists:hp1",
  release: "oewn-2025-test",
  reviewedAt: 1_794_355_200,
  senses: [["bank", "bank%1:17:01::"]],
  chapters: {
    ["a".repeat(64)]: {
      p: { "0": "b".repeat(64) },
      r: [[0, 4, "bank", 0]],
    },
  },
});

async function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const addUser = async (id, role = "user", verified = NOW - 1) => {
    raw
      .prepare(
        "INSERT INTO users (id,email,password_hash,password_salt,password_iters,created_at,role,email_verified_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, `${id}@example.test`, "unused", "unused", 10000, NOW - 100, role, verified);
    raw
      .prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)")
      .run(await sha256Hex(`tok-${id}`), id, NOW - 100, NOW + 86_400_000);
  };
  await addUser("plain", "user", NOW - 1);
  await addUser("unverified", "user", null);
  await addUser("trusted", "trusted", NOW - 1);

  const DB = {
    prepare(sql) {
      const stmt = preparePositional(raw, sql);
      let args = [];
      const api = {
        bind(...values) {
          args = values;
          return api;
        },
        async first() {
          return stmt.get(...args) ?? null;
        },
        async all() {
          return { results: stmt.all(...args) };
        },
        async run() {
          stmt.run(...args);
          return { success: true };
        },
      };
      return api;
    },
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const res = [];
        for (const s of statements) res.push(await s.all());
        raw.exec("COMMIT");
        return res;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };

  const files = new Map([
    ["word-lists/hp1/glossary.json", { body: '{"version":2,"glossary":{}}', etag: '"g-1"' }],
    ["dictionary/positions/word-lists/hp1/mappings.json", { body: SAMPLE_V2, etag: '"m-v2-1"' }],
  ]);

  const BOOKS = {
    async get(key) {
      const hit = files.get(key);
      if (!hit) return null;
      const bytes = new TextEncoder().encode(hit.body);
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        size: bytes.byteLength,
        httpEtag: hit.etag,
      };
    },
    async put() {},
  };

  const env = { DB, BOOKS };
  const callPos = (catalog, id, userId, extraHeaders = {}) =>
    handlePositionMappings(
      new Request(`https://inputread.test/api/dictionary/positions/${catalog}/${id}`, {
        headers: {
          ...(userId ? { cookie: `mw_session=tok-${userId}` } : {}),
          ...extraHeaders,
        },
      }),
      env,
      catalog,
      id,
      { now: NOW },
    );

  const unlockViaGlossary = (id, userId) =>
    handleGlossary(
      new Request(`https://inputread.test/api/glossary/${id}?catalog=word-lists`, {
        headers: { cookie: `mw_session=tok-${userId}` },
      }),
      env,
      id,
      { now: NOW },
    );

  return { raw, env, files, callPos, unlockViaGlossary };
}

test("protected positions endpoint enforces login, email verification, and glossary_reads book unlock without minting quota", async () => {
  const f = await fixture();

  // Guest -> 401
  assert.equal((await f.callPos("word-lists", "hp1", null)).status, 401);

  // Unverified plain user -> 403 email-unverified
  const unv = await f.callPos("word-lists", "hp1", "unverified");
  assert.equal(unv.status, 403);
  assert.equal((await unv.json()).error, "email-unverified");

  // Verified plain user who has NOT unlocked hp1 -> 403 book-not-unlocked, and zero quota rows written
  const locked = await f.callPos("word-lists", "hp1", "plain");
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).error, "book-not-unlocked");
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM glossary_reads").get().n, 0);

  // Bad catalog or bad id -> 400
  assert.equal((await f.callPos("other", "hp1", "trusted")).status, 400);
  assert.equal((await f.callPos("word-lists", "../hp1", "trusted")).status, 400);

  // Trusted user can read directly -> 200 + ETag + private Cache-Control + Vary: Cookie
  const trustedRes = await f.callPos("word-lists", "hp1", "trusted");
  assert.equal(trustedRes.status, 200);
  assert.equal(trustedRes.headers.get("etag"), '"m-v2-1"');
  assert.equal(trustedRes.headers.get("cache-control"), "private, max-age=300");
  assert.equal(trustedRes.headers.get("vary"), "Cookie");
  assert.equal(await trustedRes.text(), SAMPLE_V2);

  // Plain user unlocks hp1 via /api/glossary/hp1 -> now positions returns 200
  assert.equal((await f.unlockViaGlossary("hp1", "plain")).status, 200);
  const okRes = await f.callPos("word-lists", "hp1", "plain");
  assert.equal(okRes.status, 200);
  assert.equal(await okRes.text(), SAMPLE_V2);

  // ETag If-None-Match -> 304 Not Modified with empty body
  const notMod = await f.callPos("word-lists", "hp1", "plain", { "if-none-match": '"m-v2-1"' });
  assert.equal(notMod.status, 304);
  assert.equal(await notMod.text(), "");

  // Missing mappings file for unlocked/trusted user -> 404
  const missing = await f.callPos("word-lists", "nonexistent", "trusted");
  assert.equal(missing.status, 404);
});
