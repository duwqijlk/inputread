import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import postcss from "postcss";
import { build, resolveConfig } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaults = "--tw-translate-x:0;--tw-translate-y:0;--tw-rotate:0;--tw-skew-x:0;--tw-skew-y:0;--tw-scale-x:1;--tw-scale-y:1";
const fixture = `*,::before,::after{${defaults}}::backdrop{${defaults}}
.center{--tw-translate-x:-50%;--tw-translate-y:-50%;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}`;

function universalDefaults(css) {
  const rules = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.includes("*") && rule.nodes.some((node) => node.prop === "--tw-rotate")) rules.push(rule);
  });
  return rules;
}

async function minify(cssTarget, cssMinify) {
  const dir = mkdtempSync(join(tmpdir(), "inputread-css-compat-"));
  try {
    writeFileSync(join(dir, "index.html"), '<link rel="stylesheet" href="/fixture.css">');
    writeFileSync(join(dir, "fixture.css"), fixture);
    const result = await build({
      configFile: false, root: dir, logLevel: "silent",
      build: { write: false, cssTarget, cssMinify },
    });
    return [result].flat().flatMap((bundle) => bundle.output)
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) => String(item.source)).join("\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("production CSS keeps Tailwind defaults usable when Safari rejects ::backdrop", async () => {
  // Resolve the real project plugins too: plugin-legacy otherwise supplies Chrome-only CSS targets.
  const config = await resolveConfig({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent" }, "build");
  assert.deepEqual(config.build.cssTarget, ["chrome49", "safari10", "ios10", "firefox52", "edge15"]);
  const css = await minify(config.build.cssTarget, config.build.cssMinify);
  const rules = universalDefaults(css);
  assert.equal(rules.length, 1);
  assert.ok(!rules[0].selector.includes("::backdrop"), "unsupported selector must not invalidate universal defaults");
  for (const prop of ["--tw-rotate", "--tw-skew-x", "--tw-skew-y", "--tw-scale-x", "--tw-scale-y"])
    assert.ok(rules[0].nodes.some((node) => node.prop === prop), prop);
  assert.match(css, /transform:/);
  const unsafe = await minify("chrome61", config.build.cssMinify);
  assert.ok(universalDefaults(unsafe)[0].selector.includes("::backdrop"), "negative control reproduces the old build defect");
});
