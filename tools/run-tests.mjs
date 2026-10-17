/**
 * dsh-memory · 在全量回归测试里跑 `test/*.test.js`。
 *
 * 为什么需要这个包装：`node --test test/` 会**起子进程**跑每个测试文件；在受限环境里
 * （DSH 沙箱、某些 CI、某些 Windows 安全策略）子进程管道会被拒（`spawn EPERM`）。
 * 本脚本改成**同一个进程里按顺序 import 每个测试文件**，由 `node:test` 自己调度执行 ——
 * 不发子进程，任何能跑 Node 的地方都能跑，结果与 `node --test` 等价（357 个用例）。
 *
 * 用法：
 *   node tools/run-tests.mjs            # 跑全部
 *   node tools/run-tests.mjs --client   # 顺带跑客户端面板自检（tools/check-client.mjs）
 *
 * @module dsh-memory/tools/run-tests
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(HERE, '..', 'test');

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error(`✗ 没找到测试文件：${TEST_DIR}`);
  process.exit(2);
}

console.log(`▶ 依次加载 ${files.length} 个测试文件（同进程，无子进程）`);
for (const name of files) {
  // 每个文件的用例由 node:test 在加载后自动调度；这里不能 await 单文件完成
  // （await 会等它跑完才 import 下一个，结果一样但更慢）。
  await import(pathToFileURL(join(TEST_DIR, name)).href);
}

if (process.argv.includes('--client')) {
  console.log('\n▶ 客户端面板自检（tools/check-client.mjs）');
  await import(pathToFileURL(join(HERE, 'check-client.mjs')).href);
}
