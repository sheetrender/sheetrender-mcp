// Bundles the MCP Apps view (src/widget/documents.ts) into one minified ES
// module and writes it to each directory given on the command line, e.g.
//
//   node scripts/build-widget.mjs dist/widget dist-test/src/widget
//
// The server reads <its own directory>/widget/documents.js at runtime and
// inlines it into the view's HTML, so the published dist/ and the unit-test
// build in dist-test/src/ each need a copy. Run by `deno task build`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDirs = process.argv.slice(2);
if (outDirs.length === 0) {
    console.error("usage: node scripts/build-widget.mjs <out-dir> [<out-dir> ...]");
    process.exit(2);
}

/**
 * zod re-exports every locale through `z.locales`, which nothing in the view
 * uses; only English messages (imported directly by zod) are kept. Cuts the
 * bundle by roughly half.
 */
const englishOnlyZodLocales = {
    name: "english-only-zod-locales",
    setup(build) {
        build.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, (args) => ({
            contents: 'export { default as en } from "./en.js";\n',
            resolveDir: dirname(args.path),
            loader: "js",
        }));
    },
};

const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/widget/documents.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    plugins: [englishOnlyZodLocales],
    write: false,
    logLevel: "warning",
});

const [output] = result.outputFiles;
for (const dir of outDirs) {
    const target = join(root, dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "documents.js"), output.text);
}
console.log(`widget: ${(output.text.length / 1024).toFixed(1)} KB -> ${outDirs.join(", ")}`);
