// 顺序运行 tests/*.test.ts（每个文件经 run-ts-test.mjs 编译执行）；任一失败即以非 0 退出
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests').filter(f => f.endsWith('.test.ts')).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['scripts/run-ts-test.mjs', `tests/${f}`], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}
console.log(`\n${files.length - failed.length}/${files.length} 个套件通过${failed.length ? `；失败：${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
