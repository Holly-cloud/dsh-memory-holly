/**
 * 生成「可迁移包」—— 换机器/重置系统前用它，确保记忆无损。
 *
 * ## 为什么不能直接用 exportPack
 * 曾经做过一次性清洗：剥掉正文开头重复的分节标题。副作用是 **6 条来自不同分区的
 * `索引.md` 记录**（正文是同一句 29 字模版话，原本靠分节标题区分）在剥掉标题后
 * **正文完全撞车**。而导入是按全文 hash 判重的 —— 直接导会把 6 条合成 1 条，
 * 丢掉它们的 `source` / `section`。
 *
 * 本脚本对这 6 条（更准确地说：**所有正文重复的行**）从 `history.prev_text`
 * 取回清洗前的原文，恢复唯一性，于是「库里 1087 条 → 包内 1087 条不同正文」。
 *
 * ## 用法
 *   node tools/make-migration-pack.mjs [--db <路径>] [--out <目录>]
 * 默认：库 `$DSH_HOME/dsh-memory/memory.db`，输出 `<包目录>/memory-pack`。
 *
 * ## 它自己会证明无损
 * 生成后把包**导入一个全新的内存库**，断言 `added === 库里条数`、`skipped === 0`、
 * `failed === 0`。数字对不上就非零退出。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDatabase, openDatabase } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import { exportPack, importPack, readPack } from '../src/host/portability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const DB = resolve(argOf('--db', join(DSH_HOME, 'dsh-memory', 'memory.db')));
const OUT = resolve(argOf('--out', join(HERE, '..', '.migration')));
const PACK = join(OUT, 'memory-pack');

if (!existsSync(DB)) {
  console.error(`找不到库：${DB}\n（用 --db 指定，或先在新系统里跑一次插件让它建库）`);
  process.exit(2);
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
mkdirSync(OUT, { recursive: true });

const db = openDatabase(DB, { readOnly: true });
const store = new MemoryStore(db, {});

// ── 1. 找出「正文撞车」的行，为它们准备清洗前的原文 ────────────────────────────
const rows = db
  .prepare('SELECT id, text, source, section FROM memories WHERE deleted_at IS NULL ORDER BY created_at, id')
  .all();
const byHash = new Map();
for (const r of rows) {
  const h = sha(r.text);
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(r);
}
const dupGroups = [...byHash.values()].filter((g) => g.length > 1);

/** id → 清洗前原文（只在能从 history 取回时才替换） */
const restore = new Map();
for (const group of dupGroups) {
  for (const row of group) {
    const hist = db
      .prepare(
        "SELECT prev_text FROM history WHERE memory_id = ? AND op = 'supersede' AND note LIKE 'clean:%' ORDER BY id DESC LIMIT 1",
      )
      .get(row.id);
    if (hist?.prev_text && hist.prev_text !== row.text) restore.set(row.id, hist.prev_text);
  }
}

console.log('=== 库 ===');
console.log(`  ${DB}`);
console.log(`  未删除记录 ${rows.length} · 不同正文 ${byHash.size} · 撞车组 ${dupGroups.length}`);
console.log(`  需从 history 取回原文的行：${restore.size}`);

// ── 2. 用插件自己的 exportPack 生成包（已测试代码路径）────────────────────────
const space = store.getActiveSpace();
const exported = exportPack({
  store,
  dir: PACK,
  scope: null,
  embedding: { provider: null, model: space?.model ?? null, dims: space?.dims ?? null },
});
if (!exported.ok) {
  console.error('exportPack 失败');
  process.exit(1);
}

// ── 3. 只改 memories.jsonl（导入的真源），把这 6 条换成清洗前原文 ──────────────
const jsonlPath = join(PACK, 'memories.jsonl');
const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
let patched = 0;
const corrected = lines.map((line) => {
  const rec = JSON.parse(line);
  const before = restore.get(rec.id);
  if (before !== undefined) {
    patched += 1;
    return JSON.stringify({ ...rec, text: before });
  }
  return line;
});
writeFileSync(jsonlPath, corrected.join('\n') + '\n', 'utf8');
console.log(`\n=== 迁移包 ===\n  ${PACK}`);
console.log(`  memories.jsonl 行数 ${corrected.length}，其中替换回原文 ${patched} 条`);

// ── 4. 让 readable.md 与 jsonl 一致（按 source 分组，正文单行化）──────────────
const records = corrected.map((l) => JSON.parse(l));
const bySource = new Map();
for (const rec of records) {
  const src = rec.metadata?.source ?? '(未知来源)';
  if (!bySource.has(src)) bySource.set(src, []);
  bySource.get(src).push(rec.text.replace(/\s+/g, ' ').trim());
}
const md = [`# 记忆库导出（${records.length} 条 · ${bySource.size} 个来源）`, ''];
for (const src of [...bySource.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
  md.push(`## ${src}`, '');
  for (const text of bySource.get(src)) md.push(`- ${text}`);
  md.push('');
}
writeFileSync(join(PACK, 'readable.md'), md.join('\n'), 'utf8');

// ── 5. 自证无损：把包导进一个全新的空库，数字必须对得上 ───────────────────────
const fresh = openDatabase(':memory:');
const freshStore = new MemoryStore(fresh, {});
const imported = await importPack({ store: freshStore, dir: PACK, dryRun: false, scope: 'default' });
const freshTotal = freshStore.countMemories({ includeDeleted: false });
const freshHashes = new Set(
  fresh.prepare('SELECT text FROM memories WHERE deleted_at IS NULL').all().map((r) => sha(r.text)),
);

console.log('\n=== 无损自证（导入全新空库）===');
console.log(`  库内未删除        : ${rows.length}`);
console.log(`  导入 added        : ${imported.added}`);
console.log(`  导入 skipped      : ${imported.skipped}   ← 必须 0（>0 说明包内仍有撞车）`);
console.log(`  导入 failed       : ${imported.failed}   ← 必须 0`);
console.log(`  新库条数          : ${freshTotal}`);
console.log(`  新库不同正文      : ${freshHashes.size}   ← 必须等于条数`);
if (imported.errors?.length) console.log('  errors:', imported.errors);

const ok =
  imported.added === rows.length &&
  imported.skipped === 0 &&
  imported.failed === 0 &&
  freshTotal === rows.length &&
  freshHashes.size === rows.length;

// ── 6. 冷备份原库（含向量；向量可重算，但留着省一次全量嵌入）──────────────────
const dbCopy = join(OUT, 'memory.db');
copyFileSync(DB, dbCopy);
console.log(`\n=== 冷备份 ===\n  ${dbCopy}  ${(statSync(dbCopy).size / 1024 / 1024).toFixed(2)} MB`);

closeDatabase(fresh);
closeDatabase(db);

if (!ok) {
  console.error('\n❌ 无损自证未通过 —— 不要用这个包迁移。');
  process.exit(1);
}
console.log('\n✅ 无损自证通过：包里每一条都能原样导回。');
