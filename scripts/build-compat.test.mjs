import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { legacyWithEs5Polyfills } from "./legacy-polyfill-es5.mjs";

const root = new URL("../", import.meta.url);

test("build keeps the Chrome 69 module floor and an ES5 nomodule pipeline", async () => {
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, fileURLToPath(new URL("vite.config.ts", root)));
  assert.ok(loaded, "Vite config loads");
  const build = loaded.config.build;
  assert.equal(build.target, "chrome69");
  assert.equal(build.minify, "terser", "Oxc legacy compression targets ES2015, not ES5");
  assert.equal(build.terserOptions.ecma, 5);
  assert.equal(build.terserOptions.compress.arrows, false);
  assert.equal(build.terserOptions.format.ecma, 5);
  const source = readFileSync(new URL("vite.config.ts", root), "utf8");
  assert.match(source, /targets: \["ie >= 11",/);
  assert.match(source, /modernTargets: \["chrome >= 69",/);
  assert.match(source, /renderLegacyChunks: true/);
  assert.match(source, /legacyOnlyWithoutModules\(\)/);
  assert.doesNotMatch(readFileSync(new URL("index.html", root), "utf8"), /\n\s*(?:true|false),\s*\n\s*\);/);
});

test("polyfill adapter compiles before emission, rehashes bytes and updates only its HTML reference", async () => {
  const original = { type: "prebuilt-chunk", fileName: "assets/polyfills-legacy-original.js", code: "(()=>{var make=(v)=>()=>v;globalThis.fixtureResult=make('works')();globalThis.System={import:function(){return 'kept'}}})()", map: null };
  const unchanged = { type: "asset", fileName: "ordinary.txt", source: "keep" };
  const plugins = legacyWithEs5Polyfills([{ name: "vite:legacy-generate-polyfill-chunk", generateBundle() { this.emitFile(original); this.emitFile(unchanged); } }]);
  const emitted = [];
  await plugins[0].generateBundle.call({ emitFile(file) { emitted.push(file); return file.fileName; } });
  const polyfill = emitted.find((file) => file.type === "prebuilt-chunk");
  parse(polyfill.code, { ecmaVersion: 5 });
  const hash = createHash("sha256").update(polyfill.code).digest("hex").slice(0, 12);
  assert.equal(polyfill.fileName, `assets/polyfills-legacy-${hash}.js`);
  assert.equal(emitted.find((file) => file.type === "asset"), unchanged);
  const runtime = {};
  runInNewContext(polyfill.code, runtime);
  assert.equal(runtime.fixtureResult, "works");
  assert.equal(runtime.System.import(), "kept");
  const html = `<script nomodule src="/${original.fileName}"></script><script type="module" src="/assets/modern.js"></script>`;
  const rewritten = plugins.at(-1).transformIndexHtml.handler(html);
  assert.ok(rewritten.includes(`/${polyfill.fileName}`));
  assert.ok(rewritten.includes('/assets/modern.js'));
});
