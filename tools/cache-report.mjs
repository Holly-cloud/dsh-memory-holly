// 缓存命中率基线（只读）—— 做"读取侧注入"之前/之后各跑一次，用来证伪"注入把前缀缓存打坏了"。
//
// 为什么用它（2026-10-08，外部评审的实验 D）：宿主每轮都变的那块（时间戳等）如果落在**前缀**里，
// 命中率会掉到接近 0；落在**尾部**则只花它自己那点 token。命中价与未命中价差一个数量级，
// 而 `input_tokens` 总数**不变**（miss 只是把 token 从"命中"挪到"未命中"）—— 所以要看命中数，
// 不是看总输入。DSH 的会话投影里正好记着 `tokenUsage.cacheReadTokens` / `uncachedInputTokens`。
//
// 用法：node tools/cache-report.mjs [--sessions 8] [--dir <会话投影目录>]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const limit = Number(argOf('--sessions', '10'));
const dir = argOf('--dir', join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'));

/** 从一条会话投影里读 token 用量与轮数（拿不到就返回 null）。 */
function readSession(file) {
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8'))?.record?.rows ?? {};
    const totals = rows.tokenUsage?.val?.totals ?? {};
    const turns = rows.turnOutline?.val?.turns ?? [];
    const uncached = Number(totals.uncachedInputTokens ?? 0);
    const cached = Number(totals.cacheReadTokens ?? 0);
    if (uncached + cached === 0) return null;
    return { id: file.slice(-41, -5), turns: turns.length, uncached, cached };
  } catch {
    return null;
  }
}

let files = [];
try {
  files = readdirSync(dir).map((name) => join(dir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
} catch (error) {
  console.error(`读不到会话投影目录：${dir}\n${error.message}`);
  process.exitCode = 1;
}

const rows = files.map(readSession).filter(Boolean);
const recent = rows.slice(0, Math.max(1, limit));
const total = recent.reduce(
  (acc, row) => ({ uncached: acc.uncached + row.uncached, cached: acc.cached + row.cached, turns: acc.turns + row.turns }),
  { uncached: 0, cached: 0, turns: 0 },
);
const share = total.cached + total.uncached === 0 ? 0 : (total.cached / (total.cached + total.uncached)) * 100;

console.log(`会话投影目录：${dir}`);
console.log(`统计范围：最近 ${recent.length} 个会话（共 ${rows.length} 个有用量记录的会话）\n`);
console.log('会话      轮数   未命中 token      命中 token     命中率');
for (const row of recent) {
  const pct = ((row.cached / (row.cached + row.uncached)) * 100).toFixed(1);
  console.log(`${row.id.slice(0, 8)}  ${String(row.turns).padStart(4)}  ${String(row.uncached).padStart(12)}  ${String(row.cached).padStart(14)}  ${pct.padStart(6)}%`);
}
console.log(`\n合计：未命中 ${total.uncached} / 命中 ${total.cached} → **缓存命中率 ${share.toFixed(2)}%**`);
console.log('判读红线：读取侧注入上线后，这个数**不该掉出 95%**（本机注入前的基线在 README 的「读取侧注入」节里）。');
