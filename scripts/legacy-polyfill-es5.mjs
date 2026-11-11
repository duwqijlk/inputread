import { createHash } from "node:crypto";
import ts from "typescript";
import { minify } from "terser";

/** Vite 8's nested polyfill build emits unlowered Rolldown helpers. Compile before emitFile,
 * then give the result its own content hash and let the existing loader reference that name.
 * No application chunks, module chunks, or loader code are rewritten here.
 */
export function legacyWithEs5Polyfills(plugins) {
  const generate = plugins.find((plugin) => plugin.name === "vite:legacy-generate-polyfill-chunk");
  if (!generate || typeof generate.generateBundle !== "function") throw new Error("Unsupported legacy plugin polyfill hook");
  const original = generate.generateBundle;
  const renamed = new Map();
  generate.generateBundle = async function (...args) {
    const pending = [];
    const context = new Proxy(this, {
      get: (target, key) => key === "emitFile" ? (file) => {
        if (file.type !== "prebuilt-chunk" || !/^polyfills-legacy-.*\.js$/.test(file.fileName.split("/").pop())) return target.emitFile(file);
        pending.push((async () => {
          if (file.map) throw new Error("ES5 polyfill compiler requires build.sourcemap=false");
          const lowered = ts.transpileModule(file.code, {
            compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.None, removeComments: true },
          }).outputText;
          const result = await minify(lowered, { ecma: 5, compress: { arrows: false }, format: { ecma: 5 } });
          if (!result.code) throw new Error("Empty ES5 polyfill output");
          const hash = createHash("sha256").update(result.code).digest("hex").slice(0, 12);
          const fileName = file.fileName.replace(/-[^-\/]+\.js$/, `-${hash}.js`);
          renamed.set(file.fileName, fileName);
          target.emitFile({ ...file, code: result.code, fileName });
        })());
        return "es5-polyfill-pending";
      } : typeof target[key] === "function" ? target[key].bind(target) : target[key],
    });
    await original.apply(context, args);
    await Promise.all(pending);
  };
  return [...plugins, {
    name: "inputread:es5-polyfill-reference",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        for (const [before, after] of renamed) html = html.replaceAll(before, after);
        return html;
      },
    },
  }];
}
