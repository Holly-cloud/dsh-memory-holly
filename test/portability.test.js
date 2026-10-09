/**
 * portability.js 测试：导出包四件套、读包、往返、判重、dryRun、坏行、onAdded、人可读导出。
 *
 * 全部用 `:memory:` 库 + `test/.tmp/portability/` 下的临时包目录，**不联网**。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/host/db.js';
import { MemoryStore, hashText } from '../src/host/store.js';
import { exportPack, exportReadable, importPack, readPack } from '../src/host/portability.js';
import { cleanupTmpDir, freshTmpDir, makeClock } from './util.js';

const TMP = freshTmpDir('portability');

/** 固定时钟：让 manifest.exportedAt 可断言。 */
const FIXED_NOW = () => new Date('2026-10-06T00:00:00.000Z');

after(() => cleanupTmpDir(TMP));

/**
 * 造一个内存库 + 固定时钟的 store。
 *
 * @returns {{ store: MemoryStore, db: import('node:sqlite').DatabaseSync }} 组合
 */
function makeStore() {
  const db = openDatabase(':memory:');
  return { store: new MemoryStore(db, { now: makeClock() }), db };
}

/**
 * 绕过 `addMemory`（它拒绝空正文）直接插一行，用来验证「空正文不出现在包里」。
 *
 * @param {import('node:sqlite').DatabaseSync} db 库句柄
 * @param {{ id: string, text: string, scope?: string, source?: string | null }} input 行
 * @returns {void}
 */
function insertRaw(db, { id, text, scope = 'default', source = null }) {
  db.prepare(
    `INSERT INTO memories(id, text, scope, source, section, kind, meta, hash, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, NULL, NULL, '{}', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 1)`,
  ).run(id, text, scope, source, hashText(text));
}

/**
 * 手写一个包目录（用来精确控制 jsonl 的每一行，包括坏行）。
 *
 * @param {string} label 子目录名
 * @param {(object | string)[]} lines 行内容；字符串原样写入（用来造坏行）
 * @param {{ manifest?: object | null }} [options] 是否附带 manifest.json
 * @returns {string} 包目录绝对路径
 */
function writePack(label, lines, { manifest = null } = {}) {
  const dir = join(TMP, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'memories.jsonl'),
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
    'utf8',
  );
  if (manifest !== null) writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

/**
 * 读 jsonl 并解析成对象数组。
 *
 * @param {string} dir 包目录
 * @returns {Record<string, unknown>[]} 行对象
 */
function readJsonl(dir) {
  return readFileSync(join(dir, 'memories.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ─────────────────────────────────────────────────────────── 导出

test('exportPack：四类文件齐全、manifest 与实际条数一致、空正文不写出', () => {
  const { store, db } = makeStore();
  const a = store.addMemory({
    text: '宝宝喜欢喝冰美式咖啡',
    source: '手动写入',
    section: '偏好 > 咖啡',
    kind: 'manual',
    meta: { mood: 'happy' },
  });
  const b = store.addMemory({ text: '宝宝养了一只叫团子的猫', source: '流水账/2026-10.md', kind: 'palace' });
  store.setActiveSpace({ model: 'qwen3.7-text-embedding', dims: 1024 });
  // 两行「空正文」：一条真空串、一条全空白——都不该进包。
  insertRaw(db, { id: 'legacy-empty', text: '' });
  insertRaw(db, { id: 'legacy-blank', text: '   \n  ' });

  const dir = join(TMP, 'pack-basic');
  const result = exportPack({ store, dir, now: FIXED_NOW });

  assert.equal(result.ok, true);
  assert.equal(result.dir, dir);
  assert.equal(result.count, 2);
  assert.deepEqual(result.files, ['RESTORE.md', 'manifest.json', 'memories.jsonl', 'readable.md']);
  for (const name of result.files) assert.equal(existsSync(join(dir, name)), true, `${name} 应该存在`);

  const expectedBytes = result.files.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  assert.equal(result.bytes, expectedBytes);
  assert.ok(result.bytes > 0);

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'local-memory-export');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.exportedAt, '2026-10-06T00:00:00.000Z');
  assert.equal(manifest.count, 2);
  assert.equal(manifest.scope, 'default');
  assert.equal(manifest.principle, '文本是本体，向量是派生物');
  // 没给 embedding 参数 → 从库里的活动向量空间推（v2 起空间记录里带 provider）。
  assert.deepEqual(manifest.embedding, { provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024 });

  const rows = readJsonl(dir);
  assert.equal(rows.length, 2, '空正文的行不能被写进 jsonl');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'metadata', 'text']);

  const rowA = rows.find((row) => row.id === a.id);
  assert.equal(rowA.text, '宝宝喜欢喝冰美式咖啡');
  assert.equal(rowA.metadata.source, '手动写入');
  assert.equal(rowA.metadata.section, '偏好 > 咖啡');
  assert.equal(rowA.metadata.kind, 'manual');
  assert.equal(rowA.metadata.scope, 'default');
  assert.equal(rowA.metadata.mood, 'happy');
  assert.equal(rowA.metadata.revision, 1);
  assert.equal(typeof rowA.metadata.created_at, 'string');
  assert.equal(typeof rowA.metadata.updated_at, 'string');
  assert.equal(rows.some((row) => row.id === b.id), true);

  const readable = readFileSync(join(dir, 'readable.md'), 'utf8');
  assert.match(readable, /^# 记忆库导出（2 条 · 2 个来源）/);
  assert.match(readable, /\n## 手动写入\n/);
  assert.match(readable, /\n## 流水账\/2026-10\.md\n/);
  assert.match(readable, /- 宝宝喜欢喝冰美式咖啡/);
  assert.ok(!readable.includes('legacy-empty'));

  const restore = readFileSync(join(dir, 'RESTORE.md'), 'utf8');
  assert.match(restore, /memory_import/);
  assert.match(restore, /按全文判重/);
  assert.match(restore, /重算/);

  // 读回：拿到的就是刚才写出去的东西。
  const pack = readPack(dir);
  assert.equal(pack.ok, true);
  assert.equal(pack.error, null);
  assert.equal(pack.manifest.count, 2);
  assert.equal(pack.rows.length, 2);
  assert.deepEqual(pack.badLines, []);
  assert.equal(pack.rows.find((row) => row.id === a.id).metadata.section, '偏好 > 咖啡');

  // 导出是只读操作：库里的 4 条一条没动。
  assert.equal(store.countMemories(), 4);
});

test('exportPack：默认只导 default scope；scope:null 导全部；embedding 可显式给', () => {
  const { store } = makeStore();
  store.addMemory({ text: '默认作用域的一条' });
  store.addMemory({ text: '工作作用域的一条', scope: 'work' });

  const onlyDefault = exportPack({ store, dir: join(TMP, 'pack-scope-default'), now: FIXED_NOW });
  assert.equal(onlyDefault.count, 1);
  const manifestDefault = JSON.parse(readFileSync(join(onlyDefault.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifestDefault.scope, 'default');
  assert.equal(readJsonl(onlyDefault.dir)[0].metadata.scope, 'default');

  const all = exportPack({
    store,
    dir: join(TMP, 'pack-scope-all'),
    now: FIXED_NOW,
    scope: null,
    embedding: { provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024 },
  });
  assert.equal(all.count, 2);
  const manifestAll = JSON.parse(readFileSync(join(all.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifestAll.scope, null);
  assert.deepEqual(manifestAll.embedding, { provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024 });
  assert.equal(readJsonl(all.dir).length, 2);
});

// ─────────────────────────────────────────────────────────── 往返与判重

test('往返：全新的空库导入后，条数 / 文本 / source / kind / meta 一致，且写进 originalId', async () => {
  const source = makeStore();
  const spec = [
    { text: '宝宝喜欢喝冰美式咖啡', source: '手动写入', section: '偏好 > 咖啡', kind: 'manual', meta: { mood: 'happy' } },
    { text: '宝宝养了一只叫团子的猫\n团子怕生', source: '流水账/2026-10.md', section: '宠物', kind: 'palace', meta: {} },
    { text: '项目代号是「夜航」', source: null, section: null, kind: null, meta: { tag: 'project' } },
  ];
  const originIds = spec.map((item) => source.store.addMemory(item).id);

  const dir = join(TMP, 'pack-roundtrip');
  const packed = exportPack({ store: source.store, dir, now: FIXED_NOW, scope: null });
  assert.equal(packed.count, 3);

  const target = makeStore();
  const result = await importPack({ store: target.store, dir });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.dir, dir);
  assert.equal(result.inPack, 3);
  assert.equal(result.added, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(target.store.countMemories(), 3);

  const items = target.store.listMemories({ limit: 50 }).items;
  spec.forEach((item, index) => {
    const row = items.find((entry) => entry.text === item.text);
    assert.ok(row, `导入后应该能找到「${item.text.slice(0, 8)}…」`);
    assert.notEqual(row.id, originIds[index], '导入应该生成新 id（原 id 记在 meta 里）');
    assert.equal(row.source, item.source);
    assert.equal(row.kind, item.kind);
    assert.equal(row.section, item.section);
    assert.equal(row.scope, 'default');
    assert.equal(row.revision, 1);
    assert.equal(row.meta.importedFrom, 'pack-roundtrip');
    assert.equal(row.meta.originalId, originIds[index]);
    if (item.meta.mood) assert.equal(row.meta.mood, item.meta.mood);
    if (item.meta.tag) assert.equal(row.meta.tag, item.meta.tag);
  });

  // 包里的向量空间信息不会凭空变成「新库已建索引」：向量本来就重算，这里一条都没有。
  assert.equal(target.store.vectorStats().count, 0);
});

test('重复导入：同一个包再导一次 → added=0，全部 skipped', async () => {
  const source = makeStore();
  source.store.addMemory({ text: '重复导入也不会长出第二条' });
  source.store.addMemory({ text: '第二条', source: '手动写入', kind: 'manual' });

  const dir = join(TMP, 'pack-twice');
  exportPack({ store: source.store, dir, now: FIXED_NOW, scope: null });

  const target = makeStore();
  const first = await importPack({ store: target.store, dir });
  assert.equal(first.added, 2);

  const second = await importPack({ store: target.store, dir });
  assert.equal(second.ok, true);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.failed, 0);
  assert.deepEqual(second.errors, []);
  assert.equal(target.store.countMemories(), 2, '全文判重：第二次导入不该新增任何一条');
});

// ─────────────────────────────────────────────────────────── dryRun

test('dryRun：不写库、onAdded 不触发，但统计与真导入逐项一致（含包内重复行）', async () => {
  const dir = writePack(
    'pack-dry',
    [
      { id: 'p1', text: '甲的事实', metadata: { source: '手动写入' } },
      { id: 'p2', text: '乙的事实', metadata: { source: '手动写入' } },
      { id: 'p3', text: '甲的事实', metadata: { source: '手动写入' } }, // 同一包内重复 → 只算一次
      { id: 'p4', text: '   ', metadata: {} }, // 空正文 → skipped
      '{"id":"p5","text":"截断的 JSON"', // 坏 JSON → failed
      '123', // 非对象 → failed
    ],
    { manifest: { format: 'local-memory-export', formatVersion: 1, count: 4 } },
  );

  const probe = makeStore();
  let dryCalls = 0;
  const dry = await importPack({
    store: probe.store,
    dir,
    dryRun: true,
    onAdded: () => {
      dryCalls += 1;
    },
  });

  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.inPack, 4);
  assert.equal(dry.added, 2, '甲、乙各一条；包内重复的甲只算一次');
  assert.equal(dry.skipped, 2, '包内重复的甲 1 条 + 空正文 1 条');
  assert.equal(dry.failed, 2);
  assert.equal(dry.errors.length, 2);
  assert.equal(probe.store.countMemories(), 0, 'dryRun 一个字节都不能写');
  assert.equal(dryCalls, 0, 'dryRun 没有新 id，onAdded 不该被调用');

  const real = makeStore();
  const applied = await importPack({ store: real.store, dir });
  assert.deepEqual(
    { added: applied.added, skipped: applied.skipped, failed: applied.failed },
    { added: dry.added, skipped: dry.skipped, failed: dry.failed },
  );
  assert.equal(real.store.countMemories(), 2);
});

test('坏行只影响自己：好行照常入库，errors 最多留 5 条', async () => {
  const lines = [
    { id: 'g1', text: '好行一', metadata: { source: '手动写入', kind: 'manual' } },
    ...Array.from({ length: 7 }, (_, index) => `{"id":"bad-${index}","text":"没闭合`),
    'null',
    { id: 'g2', text: '好行二', metadata: {} },
  ];
  const dir = writePack('pack-badlines', lines);

  // 读包时就已经把坏行归类好了（带行号），导入只是把它们计进 failed。
  const pack = readPack(dir);
  assert.equal(pack.ok, true);
  assert.equal(pack.rows.length, 2);
  assert.equal(pack.badLines.length, 8, '7 个截断 JSON + 1 个 null');
  assert.deepEqual(
    pack.badLines.map((bad) => bad.line),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.match(pack.badLines[7].error, /不是一个 JSON 对象/);

  const target = makeStore();
  const result = await importPack({ store: target.store, dir });

  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 8);
  assert.equal(result.errors.length, 5, 'errors 最多 5 条');
  assert.match(result.errors[0], /^第 2 行：JSON 解析失败/);

  const texts = target.store.listMemories({ limit: 10 }).items.map((row) => row.text);
  assert.deepEqual(texts.sort(), ['好行一', '好行二'].sort());
});

// ─────────────────────────────────────────────────────────── 不是包

test('缺 memories.jsonl 的目录 → ok:false，且说明「这不像一个导出包」', async () => {
  const notAPack = join(TMP, 'not-a-pack');
  mkdirSync(notAPack, { recursive: true });
  writeFileSync(join(notAPack, 'README.md'), '这里不是导出包\n', 'utf8');

  const pack = readPack(notAPack);
  assert.equal(pack.ok, false);
  assert.equal(pack.manifest, null);
  assert.deepEqual(pack.rows, []);
  assert.match(pack.error, /这不像一个导出包/);

  const target = makeStore();
  const result = await importPack({ store: target.store, dir: notAPack });
  assert.equal(result.ok, false);
  assert.match(result.error, /这不像一个导出包/);
  assert.deepEqual(result.errors, [result.error]);
  assert.equal(result.added, 0);
  assert.equal(target.store.countMemories(), 0);

  // 目录根本不存在时同理。
  const missing = await importPack({ store: target.store, dir: join(TMP, '根本没有这个目录') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /这不像一个导出包/);
});

test('readPack：坏 manifest 不致命（manifest:null），坏行走 badLines 且带行号', () => {
  const dir = writePack(
    'pack-bad-manifest',
    [{ id: 'k1', text: '正文' }, '{"id":"k2",'],
    { manifest: null },
  );
  writeFileSync(join(dir, 'manifest.json'), '{ 这不是 JSON', 'utf8');

  const pack = readPack(dir);
  assert.equal(pack.ok, true);
  assert.equal(pack.manifest, null);
  assert.equal(pack.rows.length, 1);
  assert.equal(pack.rows[0].id, 'k1');
  assert.equal(pack.badLines.length, 1);
  assert.equal(pack.badLines[0].line, 2);

  // 坏 manifest 时 inPack 只能是 null，但导入本身照常。
  const target = makeStore();
  return importPack({ store: target.store, dir }).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(result.inPack, null);
    assert.equal(result.added, 1);
    assert.equal(target.store.countMemories(), 1);
  });
});

// ─────────────────────────────────────────────────────────── onAdded

test('onAdded：只对真正新增的 id 触发，且回调被 await（返回时已全部跑完）', async () => {
  const source = makeStore();
  const texts = ['第一条会撞库', '第二条是新的', '第三条也是新的'];
  for (const text of texts) source.store.addMemory({ text, source: '手动写入', kind: 'manual' });

  const dir = join(TMP, 'pack-onadded');
  exportPack({ store: source.store, dir, now: FIXED_NOW, scope: null });

  const target = makeStore();
  const existing = target.store.addMemory({ text: '第一条会撞库' }); // 预先存在 → 应该 skipped

  /** @type {string[]} */
  const seen = [];
  const result = await importPack({
    store: target.store,
    dir,
    onAdded: async (id) => {
      await new Promise((resolve) => setImmediate(resolve)); // 真异步：不 await 就会少记
      seen.push(id);
    },
  });

  assert.equal(result.added, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(seen.length, 2, 'onAdded 必须被 await，否则这里会看到 0 条');
  assert.equal(seen.includes(existing.id), false, '撞库的那条不该触发 onAdded');
  for (const id of seen) {
    const row = target.store.getMemory(id);
    assert.ok(row, `onAdded 给的新 id 必须真的在库里：${id}`);
    assert.notEqual(row.text, '第一条会撞库');
  }
});

// ─────────────────────────────────────────────────────────── 人可读导出

test('exportReadable：按 source 分组、正文单行化、父目录递归创建、sources 清单', () => {
  const { store, db } = makeStore();
  store.addMemory({ text: '第一行\n第二行', source: '手动写入' });
  store.addMemory({ text: '咖啡因摄入要克制', source: '手动写入' });
  store.addMemory({ text: '没有来源的一条' });
  insertRaw(db, { id: 'readable-empty', text: '   ' }); // 空正文不进 readable.md

  const file = join(TMP, 'readable-out', 'nested', 'readable.md');
  const result = exportReadable({ store, file, now: FIXED_NOW });

  assert.equal(result.ok, true);
  assert.equal(result.file, file);
  assert.equal(result.count, 3);
  assert.ok(result.bytes > 0);
  assert.equal(result.bytes, statSync(file).size);
  assert.deepEqual(result.sources, [
    { source: '(无来源)', count: 1 },
    { source: '手动写入', count: 2 },
  ]);

  const markdown = readFileSync(file, 'utf8');
  assert.match(markdown, /^# 记忆库导出（3 条 · 2 个来源）\n/);
  assert.match(markdown, /> 导出时间：2026-10-06T00:00:00\.000Z/);
  assert.match(markdown, /\n## \(无来源\)\n\n- 没有来源的一条\n/);
  assert.match(markdown, /\n## 手动写入\n\n/);
  assert.match(markdown, /- 第一行 第二行\n/);
  assert.match(markdown, /- 咖啡因摄入要克制\n/);
  assert.equal(markdown.includes('readable-empty'), false);
  assert.equal(markdown.includes('第一行\n第二行'), false, '正文必须单行化');
});
