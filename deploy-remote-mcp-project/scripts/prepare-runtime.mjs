import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('@electric-sql/pglite'));
const destination = path.join(root, 'public', 'runtime');
await mkdir(destination, { recursive: true });

// Keep PostgreSQL's binary resources local instead of depending on a CDN.
await Promise.all(['pglite.wasm', 'initdb.wasm', 'pglite.data'].map(name =>
  copyFile(path.join(source, name), path.join(destination, name)),
));
await build({
  stdin: {
    contents: 'export { PGlite } from "@electric-sql/pglite"; export { drizzle } from "drizzle-orm/pglite";',
    resolveDir: root,
    sourcefile: 'local-database-runtime.ts',
  },
  outfile: path.join(destination, 'pglite.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  plugins: [{
    name: 'browser-only-database',
    setup(bundler) {
      // PGlite includes an unused Node filesystem adapter in its browser graph.
      bundler.onResolve({ filter: /^(node:.*|fs(?:\/promises)?|path|url)$/ }, args => ({
        path: args.path,
        namespace: 'unused-node-runtime',
      }));
      bundler.onLoad({ filter: /.*/, namespace: 'unused-node-runtime' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));
    },
  }],
  logLevel: 'info',
});
console.log('Local PostgreSQL runtime is ready.');