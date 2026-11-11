#!/usr/bin/env node
// Parse the shipped legacy chunks and inline boot scripts. Modern module chunks are intentionally excluded.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "acorn";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const assets = join(dist, "assets");
const legacy = readdirSync(assets).filter((name) => /-legacy-[^/]+\.js$/.test(name));
assert.ok(legacy.length > 0, "production build must emit legacy chunks");
assert.ok(legacy.some((name) => name.startsWith("polyfills-legacy-")), "legacy polyfills must be emitted");
function check(code, label) {
  try { parse(code, { ecmaVersion: 5, sourceType: "script" }); }
  catch (error) { throw new Error(`${label}: ${error.message}`, { cause: error }); }
}
for (const name of legacy) {
  check(readFileSync(join(assets, name), "utf8"), name);
}
const html = readFileSync(join(dist, "index.html"), "utf8");
let inline = 0;
for (const [, attrs, code] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/i.test(attrs) || /\btype\s*=\s*["'](?:module|application\/ld\+json)["']/i.test(attrs)) continue;
  if (!code.trim()) continue;
  check(code, `index.html inline script ${inline + 1}`);
  inline += 1;
}
assert.ok(inline > 0, "production HTML must include its inline boot loader");
// The source index is deliberately the contract for this inline ES5 boot path; check both the
// generated HTML and source so a template change cannot reintroduce trailing-call commas.
const sourceIndex = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
assert.doesNotMatch(sourceIndex, /\n\s*(?:true|false),\s*\n\s*\);/, "ES5 boot calls have no trailing arguments");
console.log(`ES5 syntax OK: ${legacy.length} legacy chunks and ${inline} inline boot scripts`);
