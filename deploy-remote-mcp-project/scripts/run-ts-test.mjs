// 用 esbuild 打包 TypeScript 测试后在 Node 中运行（保持 "@/..." 别名）
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/run-ts-test.mjs <tests/xxx.test.ts>');
  process.exit(2);
}
await mkdir('.verification', { recursive: true });
const outfile = path.join('.verification', path.basename(file).replace(/\.ts$/, '.mjs'));
await build({
  entryPoints: [file],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@': path.resolve('src') },
  logLevel: 'warning',
});
await import(pathToFileURL(path.resolve(outfile)).href);
