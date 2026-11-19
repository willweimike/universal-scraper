// Bundles the CLI and the daemon into self-contained files for the plugin (no node_modules at install time).
// Usage: node scripts/build-plugin.mjs [outDir]   (default: plugin/dist)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? 'plugin/dist');

// jsdom looks up a worker file for synchronous XMLHttpRequest at load time; that file cannot exist in a bundle.
// The scraper never runs page scripts in jsdom, so synchronous XHR is unreachable and the lookup is stubbed.
const stubJsdomSyncXhr = {
  name: 'stub-jsdom-sync-xhr',
  setup(b) {
    b.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      const stubbed = src.replace('require.resolve("./xhr-sync-worker.js")', 'null');
      if (stubbed === src) throw new Error('jsdom changed: sync XHR worker lookup not found; update scripts/build-plugin.mjs');
      return { contents: stubbed, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};
fs.rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: { cli: 'src/frontends/cli.ts', main: 'src/daemon/main.ts' },
  outdir: out,
  bundle: true,
  plugins: [stubJsdomSyncXhr],
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // jsdom and puppeteer are CommonJS/ESM mixes that call require() on node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Optional native add-ons that jsdom/ws probe for and fall back from.
  external: ['canvas', 'bufferutil', 'utf-8-validate'],
  // Smaller files without mangling names, so stack traces stay readable.
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'none',
  logLevel: 'warning',
});
