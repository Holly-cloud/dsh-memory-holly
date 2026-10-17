/**
 * 便携包相关测试：安装器块编辑、还原模式判定、zip 往返，以及**端到端**
 * （造一个假库 → 打包 → 快照还原 → 合并还原 → 幂等重跑）。
 *
 * 端到端用真打包器 + 真还原脚本，不 mock：这条链是交付物本身，只测函数形状没有意义。
 *
 * @module dsh-memory/test/portable
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeDatabase, openDatabase } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import {
  applyInstall,
  applyUninstall,
  hasManagedBlock,
  readManagedBlock,
  removeManagedBlock,
  renderManagedBlock,
  toSpecPath,
} from '../tools/install-lib.mjs';
import {
  decideMode,
  inspectTarget,
  isEmptyTarget,
  loadCounts,
  parsePatchDataDir,
  restorePersonalData,
  RestoreError,
  verifyPackage,
  verifySnapshotCounts,
} from '../tools/portable/restore-core.mjs';
import { readZip, writeZip } from '../tools/portable/zip.mjs';
import { buildPackage } from '../tools/make-portable-pack.mjs';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('portable');

/**
 * 打包输出必须落在**仓库外**（打包器会拒绝输出到仓库内：插件目录整棵拷贝会自己拷自己）。
 * 这里放到仓库的上一级（工作区里的一个临时目录），测完删掉。
 */
const BUILD_ROOT = resolve(TMP, '..', '..', '..', '..', '.portable-e2e');
rmSync(BUILD_ROOT, { recursive: true, force: true });
mkdirSync(BUILD_ROOT, { recursive: true });

after(() => {
  rmSync(BUILD_ROOT, { recursive: true, force: true });
  cleanupTmpDir(TMP);
});

// ───────────────────────────────────────────────────────── 安装器：块编辑

test('install-lib：空 patch 写入块，再装一次完全不变（幂等）', () => {
  const spec = { entrySpec: 'D:/pkg/dsh-memory/lib/index.js', dataDirSpec: 'D:/data/mem' };
  const once = applyInstall('', spec);
  assert.equal(hasManagedBlock(once), true);
  assert.match(once, /- insert:\n {4}- id: memory\n {6}name: 'D:\/pkg\/dsh-memory\/lib\/index\.js'\n {6}config:\n {8}dataDir: 'D:\/data\/mem'\n/);
  assert.equal(applyInstall(once, spec), once);
});

test('install-lib：保留块前后的其它 patch 条目（块式删除，不吞邻居）', () => {
  const before = [
    '# 别人的注释',
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '  config:',
    '    transcriptView: standard',
    '',
  ].join('\n');
  const other = ['# 后面还有一条', '- id: hmr', '  config:', "    base: 'file:///x/'", ''].join('\n');
  const spec = { entrySpec: 'C:/pkg/lib/index.js', dataDirSpec: 'C:/data' };
  const installed = applyInstall(`${before}${other}`, spec);
  assert.match(installed, /transcriptView: standard/);
  assert.match(installed, /# 后面还有一条/);
  assert.match(installed, /- id: hmr/);
  assert.match(installed, /- id: memory/);
  // 卸载后回到「原文（行尾归一 LF）」
  assert.equal(applyUninstall(installed), `${before}${other}`);
});

test('install-lib：认得最早手写的中文 marker（宽松匹配），不会留下第二块', () => {
  const legacy = [
    '# dsh-memory —— 本地记忆插件（手写版）',
    '- insert:',
    '    - id: memory',
    "      name: 'C:/old/lib/index.js'",
    '      config:',
    "        dataDir: 'C:/old-data'",
  ].join('\n');
  const installed = applyInstall(legacy, { entrySpec: 'C:/new/lib/index.js', dataDirSpec: 'C:/new-data' });
  assert.equal((installed.match(/- id: memory/g) ?? []).length, 1);
  assert.match(installed, /C:\/new\/lib\/index\.js/);
  assert.doesNotMatch(installed, /C:\/old/);
});

test('install-lib：diagnostics 开关写进块，readManagedBlock 能读回 dataDir 与开关', () => {
  const text = applyInstall('', { entrySpec: 'C:/p/lib/index.js', dataDirSpec: 'C:/p/data', diagnostics: true });
  assert.match(text, /diagnostics: true/);
  const block = readManagedBlock(text);
  assert.equal(block.found, true);
  assert.equal(block.entrySpec, 'C:/p/lib/index.js');
  assert.equal(block.dataDir, 'C:/p/data');
  assert.equal(block.diagnostics, true);
  // 再装一次（不给 diagnostics）应关掉它
  const off = applyInstall(text, { entrySpec: 'C:/p/lib/index.js', dataDirSpec: 'C:/p/data' });
  assert.doesNotMatch(off, /diagnostics: true/);
});

test('install-lib：CRLF 输入不炸，输出归一 LF；toSpecPath 反斜杠转正斜杠', () => {
  const crlf = '- id: a\r\n  name: "x"\r\n';
  const installed = applyInstall(crlf, { entrySpec: toSpecPath('C:\\p\\lib\\index.js'), dataDirSpec: 'C:/d' });
  assert.doesNotMatch(installed, /\r/);
  assert.match(installed, /name: 'C:\/p\/lib\/index\.js'/);
  assert.equal(applyUninstall(installed), '- id: a\n  name: "x"\n');
});

test('install-lib：marker 被改坏（后面不是 insert）时只删 marker 上方注释，保留坏行', () => {
  const text = ['# dsh-memory -- managed block', 'not-an-insert: true', '- id: keep', ''].join('\n');
  const removed = removeManagedBlock(text);
  assert.match(removed, /not-an-insert: true/);
  assert.match(removed, /- id: keep/);
});

test('renderManagedBlock：路径带单引号会破坏 YAML —— 调用方必须保证没有单引号（记录约定）', () => {
  const block = renderManagedBlock({ entrySpec: 'C:/a b/lib/index.js', dataDirSpec: 'C:/d' });
  assert.match(block, /name: 'C:\/a b\/lib\/index\.js'/); // 空格没问题
  assert.doesNotMatch(block, /\n\n/); // 块内不留空行
});

// ───────────────────────────────────────────────────────── 还原：模式判定与校验

test('decideMode：auto 的四条分支', () => {
  assert.equal(decideMode({ dbExists: false, empty: true, walPresent: false }).mode, 'snapshot');
  assert.equal(decideMode({ dbExists: true, empty: true, walPresent: false }).mode, 'snapshot');
  assert.equal(decideMode({ dbExists: true, empty: true, walPresent: true }).mode, 'merge');
  assert.equal(decideMode({ dbExists: true, empty: false, walPresent: false }).mode, 'merge');
  assert.equal(decideMode({ requested: 'snapshot', dbExists: true, empty: false, walPresent: false }).mode, 'snapshot');
  assert.throws(() => decideMode({ requested: 'bogus', dbExists: false, empty: true, walPresent: false }), /未知模式/);
});

test('isEmptyTarget：记忆/批次/变更单/副审阅区任一非零都不算空', () => {
  const base = {
    memories: 0,
    batchesOpen: 0,
    plansActionable: 0,
    handoffsOpen: 0,
    batchItemsPending: 0,
  };
  assert.equal(isEmptyTarget(base), true);
  assert.equal(isEmptyTarget({ ...base, memories: 1 }), false);
  assert.equal(isEmptyTarget({ ...base, batchesOpen: 1 }), false);
  assert.equal(isEmptyTarget({ ...base, plansActionable: 1 }), false);
  assert.equal(isEmptyTarget({ ...base, handoffsOpen: 1 }), false);
  assert.equal(isEmptyTarget({ ...base, batchItemsPending: 1 }), false);
});

test('parsePatchDataDir：只认 dataDir 那一行，反例返回 null', () => {
  assert.equal(parsePatchDataDir("x:\n  config:\n    dataDir: 'C:/mem'\n"), 'C:/mem');
  assert.equal(parsePatchDataDir('dataDir: "C:/mem"'), null); // 要求单引号
  assert.equal(parsePatchDataDir(''), null);
});

test('verifySnapshotCounts：数字不符抛 VERIFY_FAILED，并点名差在哪一项', () => {
  const afterState = {
    memories: 5,
    memoriesTotal: 6,
    vectors: 0,
    batchesOpen: 1,
    batchItemsPending: 2,
    plansActionable: 1,
    handoffsOpen: 1,
    settings: 3,
  };
  const counts = {
    expected: {
      snapshot: {
        memoriesActive: 5,
        memoriesTotal: 6,
        vectors: 0,
        batchesOpen: 1,
        batchItemsPending: 2,
        plansActionable: 1,
        handoffsOpen: 1,
        settings: 3,
      },
    },
  };
  assert.doesNotThrow(() => verifySnapshotCounts(afterState, counts));
  assert.throws(() => verifySnapshotCounts({ ...afterState, vectors: 7 }, counts), (error) => {
    assert.equal(error.code, 'VERIFY_FAILED');
    assert.match(error.message, /向量：期望 0，实际 7/);
    return true;
  });
});

// ───────────────────────────────────────────────────────── zip 往返

test('zip：UTF-8 条目名往返一致，deflate 与 store 两种路径都覆盖', () => {
  const file = join(TMP, 'roundtrip.zip');
  const entries = [
    { name: '包/README.md', data: Buffer.from('# 中文内容\n'.repeat(200), 'utf8') },
    { name: 'a.txt', data: Buffer.from('x', 'utf8') }, // 太短 → store（不压缩）
    { name: 'empty.bin', data: Buffer.alloc(0) },
  ];
  const info = writeZip(file, entries);
  assert.equal(info.entries, 3);
  const back = readZip(readFileSync(file));
  assert.deepEqual(back.map((entry) => entry.name).sort(), entries.map((entry) => entry.name).sort());
  const byName = new Map(back.map((entry) => [entry.name, entry.data]));
  for (const entry of entries) assert.deepEqual(byName.get(entry.name), entry.data);
});

// ───────────────────────────────────────────────────────── 端到端

/**
 * 造一个带「记忆 + 待审批次 + 变更单 + 副审阅区 + 设置 + 活动空间」的库。
 *
 * @param {string} dir 目录
 * @returns {{ dbPath: string, memoryIds: string[], batchId: string, planId: string, handoffId: string }} 结果
 */
function makeFixtureDb(dir) {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'memory.db');
  const db = openDatabase(dbPath);
  const store = new MemoryStore(db, {});
  /** @type {string[]} */
  const memoryIds = [];
  for (let i = 1; i <= 5; i += 1) {
    const result = store.addMemory({ text: `便携包夹具记忆 ${i} —— 用来验证打包与还原`, source: 'test-fixture', kind: 'note' });
    memoryIds.push(result.id);
  }
  const batch = store.createBatch({
    model: 'test-model',
    sourceText: '这是一段抽取原文，用来验证待审批次能不能原样搬过去。',
    focused: true,
    items: ['待审条目 A：用户偏好中文回答', '待审条目 B：项目已上传 GitHub'],
  });
  const plan = store.createKeeperPlan({
    seedId: memoryIds[0],
    memberIds: [memoryIds[0], memoryIds[1]],
    ops: [{ idx: 0, type: 'replace', targets: [memoryIds[0]], before: [{ id: memoryIds[0], text: '旧' }], after: '改后', reason: '测试' }],
    model: 'test-keeper',
  });
  db.prepare("UPDATE keeper_plans SET state = 'handed' WHERE id = ?").run(plan.id);
  const handoff = store.createHandoff({ runId: 'run-1', seedId: memoryIds[2], memberIds: [memoryIds[2], memoryIds[3]], error: '测试失败' });
  store.setSetting('embedding.profiles', JSON.stringify([{ name: '测试档', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-embed', dimensions: 8, apiKeyRef: 'TEST_KEY' }]));
  store.setSetting('embedding.active', '测试档');
  store.setSetting('keeper.active', '测试档');
  store.setActiveSpace({ provider: 'openai', model: 'test-embed', dims: 8 });
  closeDatabase(db);
  return { dbPath, memoryIds, batchId: batch.id, planId: plan.id, handoffId: handoff.id };
}

test('端到端：打包 → 快照还原 → 合并还原 → 幂等重跑', async () => {
  const fixture = makeFixtureDb(join(TMP, 'fixture'));
  const out = join(BUILD_ROOT, 'pkg');
  const built = await buildPackage({ out, db: fixture.dbPath, label: 'test-pack', withGit: true, withZip: true, force: true });
  const packageDir = join(out, '2-personal-data');

  // 清单覆盖除 .git 以外的全部文件（.git/index 会被任何一次 git 命令改写，列进去只会造成假警报）
  assert.equal(built.manifest.files.some((entry) => entry.path.startsWith('.git/') || entry.path.includes('/.git/')), false);
  assert.equal(existsSync(join(out, '1-plugin', 'dsh-memory', '.git')), true);

  // 目录形状
  for (const rel of ['README.md', 'INSTALL.md', 'AGENT-HANDOFF.md', 'MANIFEST.json', 'VERIFY.mjs', '1-plugin/dsh-memory/lib/index.js', '2-personal-data/data/counts.json', '2-personal-data/tools/restore.mjs']) {
    assert.equal(existsSync(join(out, rel)), true, `缺文件：${rel}`);
  }
  assert.equal(existsSync(built.zip), true);

  // 快照必须「自包含」：旁边不许有派生出来的 -wal / -shm（否则只拷主库的还原路径可能丢数据）
  assert.equal(existsSync(join(packageDir, 'data', 'memory.db-wal')), false, '包里混进了 memory.db-wal');
  assert.equal(existsSync(join(packageDir, 'data', 'memory.db-shm')), false, '包里混进了 memory.db-shm');
  const snapshotRaw = new DatabaseSync(join(packageDir, 'data', 'memory.db'), { readOnly: true });
  try {
    assert.equal(String(snapshotRaw.prepare('PRAGMA journal_mode').get().journal_mode), 'delete');
    assert.equal(String(Object.values(snapshotRaw.prepare('PRAGMA integrity_check').get())[0]), 'ok');
  } finally {
    snapshotRaw.close();
  }

  // 文档模板已全部渲染（不留占位符）
  for (const rel of ['README.md', 'INSTALL.md', 'AGENT-HANDOFF.md', '2-personal-data/README.md']) {
    const text = readFileSync(join(out, rel), 'utf8');
    assert.doesNotMatch(text, /\{\{[A-Z0-9_]+\}\}/, `${rel} 还有没替换的占位符`);
  }
  assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /记忆 \*\*5\*\* 条/);

  // counts.json 数字与夹具一致
  const counts = loadCounts(packageDir);
  assert.equal(counts.counts.memoriesActive, 5);
  assert.equal(counts.counts.memoriesTotal, 5);
  assert.equal(counts.counts.batchesOpen, 1);
  assert.equal(counts.counts.batchItemsPending, 2);
  assert.equal(counts.counts.plansActionable, 1);
  assert.equal(counts.counts.handoffsOpen, 1);
  assert.equal(counts.files['data/memory.db'].sha256.length, 64);

  // 完整性校验：原包 OK；改一个字节（保持大小不变）就报 sha256 不符
  assert.equal(verifyPackage(packageDir, counts).ok, true);
  const tampered = join(TMP, 'tampered');
  cpSync(packageDir, tampered, { recursive: true });
  const tamperedFile = join(tampered, 'data', 'pack', 'memories.jsonl');
  const bytes = readFileSync(tamperedFile);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  writeFileSync(tamperedFile, bytes);
  const tamperedResult = verifyPackage(tampered, counts);
  assert.equal(tamperedResult.ok, false);
  assert.match(tamperedResult.errors.join('\n'), /sha256 不符/);

  // ── 快照还原：落到全新目录，数字全等 ────────────────────────────────────────
  const freshTarget = join(TMP, 'target-fresh');
  const snapshotResult = await restorePersonalData({ packageDir, dataDir: freshTarget, mode: 'auto' });
  assert.equal(snapshotResult.mode, 'snapshot');
  assert.deepEqual(
    {
      memories: snapshotResult.after.memories,
      memoriesTotal: snapshotResult.after.memoriesTotal,
      batchesOpen: snapshotResult.after.batchesOpen,
      pending: snapshotResult.after.batchItemsPending,
      plans: snapshotResult.after.plansActionable,
      handoffs: snapshotResult.after.handoffsOpen,
      settings: snapshotResult.after.settings,
    },
    { memories: 5, memoriesTotal: 5, batchesOpen: 1, pending: 2, plans: 1, handoffs: 1, settings: 3 },
  );
  // 旧 id 保真（快照模式的核心承诺）
  const freshDb = openDatabase(join(freshTarget, 'memory.db'), { readOnly: true });
  try {
    const ids = freshDb.prepare('SELECT id FROM memories ORDER BY created_at').all().map((row) => String(row.id));
    assert.deepEqual(ids, fixture.memoryIds);
  } finally {
    closeDatabase(freshDb);
  }

  // ── 合并还原：目标已有 1 条别的记忆，只增不改 ─────────────────────────────────
  const mergeTarget = join(TMP, 'target-merge');
  mkdirSync(mergeTarget, { recursive: true });
  const mergeDb = openDatabase(join(mergeTarget, 'memory.db'));
  const mergeStore = new MemoryStore(mergeDb, {});
  mergeStore.addMemory({ text: '目标机器自己已经有一条记忆（不能被覆盖）', source: 'existing' });
  closeDatabase(mergeDb);

  const mergeResult = await restorePersonalData({ packageDir, dataDir: mergeTarget, mode: 'merge' });
  assert.equal(mergeResult.mode, 'merge');
  assert.equal(mergeResult.stats.memoriesAdded, 5);
  assert.equal(mergeResult.stats.memoriesSkipped, 0);
  assert.equal(mergeResult.after.memories, 6);
  assert.equal(mergeResult.after.batchesOpen, 1);
  assert.equal(mergeResult.after.batchItemsPending, 2);
  assert.equal(mergeResult.after.plansActionable, 1);
  assert.equal(mergeResult.after.handoffsOpen, 1);

  // 变更单里的记忆 id 已映射到新库的 id（不是原 id）
  const mappedDb = openDatabase(join(mergeTarget, 'memory.db'), { readOnly: true });
  try {
    const plan = mappedDb.prepare("SELECT * FROM keeper_plans WHERE state = 'handed'").get();
    assert.notEqual(plan, undefined);
    const memberIds = JSON.parse(String(plan.member_ids));
    const existing = new Set(mappedDb.prepare('SELECT id FROM memories').all().map((row) => String(row.id)));
    for (const id of memberIds) assert.equal(existing.has(String(id)), true, `变更单指向了不存在的记忆：${id}`);
  } finally {
    closeDatabase(mappedDb);
  }

  // ── 幂等：再合并一次，全是「已存在跳过」 ─────────────────────────────────────
  const again = await restorePersonalData({ packageDir, dataDir: mergeTarget, mode: 'merge' });
  assert.equal(again.stats.memoriesAdded, 0);
  assert.equal(again.stats.memoriesSkipped, 5);
  assert.equal(again.stats.batchesRestored, 0);
  assert.equal(again.stats.batchesSkipped, 1);
  assert.equal(again.stats.plansRestored, 0);
  assert.equal(again.stats.handoffsRestored, 0);
  assert.equal(again.after.memories, 6);
});

test('端到端：快照模式对非空目标要 --force；DSH 开着（-wal）时拒绝替换', async () => {
  const fixture = makeFixtureDb(join(TMP, 'fixture2'));
  const out = join(BUILD_ROOT, 'pkg2');
  await buildPackage({ out, db: fixture.dbPath, label: 'test-pack-2', withGit: false, withZip: false, force: true });
  const packageDir = join(out, '2-personal-data');

  const populated = join(TMP, 'populated');
  const first = await restorePersonalData({ packageDir, dataDir: populated, mode: 'auto' });
  assert.equal(first.mode, 'snapshot');

  await assert.rejects(
    () => restorePersonalData({ packageDir, dataDir: populated, mode: 'snapshot' }),
    (error) => error instanceof RestoreError && error.code === 'TARGET_NOT_EMPTY',
  );

  // 模拟 DSH 正开着库：真开一个连接并写一笔（-wal 存在且有效）
  const openTarget = join(TMP, 'open-target');
  mkdirSync(openTarget, { recursive: true });
  copyFileSync(join(packageDir, 'data', 'memory.db'), join(openTarget, 'memory.db'));
  const holder = openDatabase(join(openTarget, 'memory.db'));
  try {
    holder.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('test.hold', '1');
    assert.equal(existsSync(join(openTarget, 'memory.db-wal')), true);
    await assert.rejects(
      () => restorePersonalData({ packageDir, dataDir: openTarget, mode: 'snapshot', force: true }),
      (error) => error instanceof RestoreError && error.code === 'DB_OPEN',
    );
    // auto 模式在「库非空且正被打开」时自动改走 merge，不会去替换文件
    const auto = await restorePersonalData({ packageDir, dataDir: openTarget, mode: 'auto' });
    assert.equal(auto.mode, 'merge');
  } finally {
    closeDatabase(holder);
  }
});

test('inspectTarget：不是 dsh-memory 的库会如实报错而不是数出 0 就当空库', () => {
  const dir = join(TMP, 'not-memory');
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, 'memory.db'));
  db.exec('DROP TABLE memories');
  closeDatabase(db);
  const state = inspectTarget(dir);
  assert.equal(state.dbExists, true);
  assert.match(state.error ?? '', /没有 memories 表/);
});
