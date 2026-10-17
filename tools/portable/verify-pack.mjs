/**
 * dsh-memory 便携包 · 收包方自查（核对 MANIFEST 与包内文件、快照库数字）。
 *
 * 用途：拿到包之后，先跑这一条，确认「文件没在传输中损坏、快照库内部自洽、文档没有留占位符」。
 * 它**只读**，不写任何文件；全部通过才 exit 0。
 *
 * 用法：
 *   node VERIFY.mjs                 # 包根目录下跑（默认核对脚本所在目录）
 *   node VERIFY.mjs <包根目录>
 *
 * @module dsh-memory/tools/portable/verify-pack
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {string[]} */
const problems = [];

/**
 * 记一条检查结果。
 *
 * @param {boolean} condition 是否通过
 * @param {string} message 描述
 * @returns {void}
 */
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) problems.push(message);
}

/**
 * 递归列出目录下所有文件（相对路径，正斜杠）。
 *
 * @param {string} root 根目录
 * @returns {string[]} 相对路径
 */
function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 文件 sha256。
 *
 * @param {string} file 文件
 * @returns {string} 摘要
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 主流程。
 *
 * @returns {void}
 */
function main() {
  const root = resolve(process.argv[2] ?? HERE);
  console.log(`包目录：${root}\n`);

  const manifestFile = join(root, 'MANIFEST.json');
  const countsFile = join(root, '2-personal-data', 'data', 'counts.json');
  if (!existsSync(manifestFile) || !existsSync(countsFile)) {
    console.error('✗ 这不像一个 dsh-memory 便携包：缺 MANIFEST.json 或 2-personal-data/data/counts.json');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const counts = JSON.parse(readFileSync(countsFile, 'utf8'));

  // ── 1. MANIFEST 与实际文件 ────────────────────────────────────────────────────
  const actual = listFiles(root).filter((rel) => rel !== 'MANIFEST.json');
  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const missingFromManifest = actual.filter((rel) => !listed.has(rel));
  const staleInManifest = [...listed.keys()].filter((rel) => !actual.includes(rel));
  check(missingFromManifest.length === 0, `MANIFEST 覆盖全部 ${actual.length} 个文件（缺 ${missingFromManifest.length} 个）`);
  check(staleInManifest.length === 0, `MANIFEST 没有多余条目（多 ${staleInManifest.length} 个）`);

  let badHash = 0;
  for (const [rel, meta] of listed) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    if (statSync(file).size !== meta.bytes || sha256(file) !== meta.sha256) badHash += 1;
  }
  check(badHash === 0, `清单里 ${listed.size} 个文件的 bytes + sha256 全部一致（坏 ${badHash} 个）`);

  // ── 2. 快照库 ─────────────────────────────────────────────────────────────────
  const dbFile = join(root, '2-personal-data', 'data', 'memory.db');
  check(existsSync(dbFile), '快照库 data/memory.db 存在');
  check(!existsSync(`${dbFile}-wal`) && !existsSync(`${dbFile}-shm`), '快照库旁边没有残留 -wal / -shm');
  if (existsSync(dbFile)) {
    check(counts.files?.['data/memory.db']?.sha256 === sha256(dbFile), 'counts.json 里的 memory.db sha256 与实际一致');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
      check(integrity === 'ok', `快照库 integrity_check = ${integrity}`);
      const one = (sql) => Number(db.prepare(sql).get().n);
      const c = counts.counts;
      check(one('SELECT COUNT(*) n FROM memories WHERE deleted_at IS NULL') === c.memoriesActive, `记忆 ${c.memoriesActive} 条`);
      check(one('SELECT COUNT(*) n FROM memories') === c.memoriesTotal, `含已删共 ${c.memoriesTotal} 条`);
      check(one('SELECT COUNT(*) n FROM vectors') === c.vectors, `向量 ${c.vectors} 条`);
      check(one("SELECT COUNT(*) n FROM batches WHERE state='open'") === c.batchesOpen, `待审批次 ${c.batchesOpen} 个`);
      check(one("SELECT COUNT(*) n FROM batch_items WHERE state='pending'") === c.batchItemsPending, `待审条目 ${c.batchItemsPending} 条`);
      check(
        one("SELECT COUNT(*) n FROM keeper_plans WHERE state IN ('open','handed')") === c.plansActionable,
        `待处理变更单 ${c.plansActionable} 张`,
      );
      check(one("SELECT COUNT(*) n FROM keeper_handoffs WHERE state='open'") === c.handoffsOpen, `副审阅区 ${c.handoffsOpen} 组`);
      check(one('SELECT COUNT(*) n FROM settings') === c.settings, `设置 ${c.settings} 项`);
    } finally {
      db.close();
    }
  }

  // ── 3. 文档没留占位符 ─────────────────────────────────────────────────────────
  const docs = ['README.md', 'INSTALL.md', 'AGENT-HANDOFF.md', '2-personal-data/README.md'];
  const leftover = [];
  for (const rel of docs) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      leftover.push(`${rel} 缺失`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\{\{[A-Z0-9_]+\}\}/g)) leftover.push(`${rel}: ${match[0]}`);
  }
  check(leftover.length === 0, `四份文档没有未替换的占位符${leftover.length > 0 ? `（${leftover.join('、')}）` : ''}`);

  console.log('');
  if (problems.length === 0) {
    console.log('全部通过：这个包是完整的，可以放心部署。');
    process.exitCode = 0;
  } else {
    console.log(`有 ${problems.length} 处问题 —— 包可能损坏，请让对方重发，不要自行修补。`);
    process.exitCode = 1;
  }
}

main();
