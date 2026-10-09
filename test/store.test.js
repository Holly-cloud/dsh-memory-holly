/**
 * store.js 测试：记忆 CRUD / 判重 / 软删硬删 / FTS 同步 / 向量 BLOB / 批次 / 任务 / 设置 / 来源。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase } from '../src/host/db.js';
import { MemoryStore, hashText } from '../src/host/store.js';
import { keywordSearch } from '../src/host/search.js';
import { cleanupTmpDir, freshTmpDir, makeClock } from './util.js';

const TMP = freshTmpDir('store');

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

test('addMemory：同文本判重命中既有记录（created:false），meta 往返为对象', () => {
  const { store } = makeStore();

  const first = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡', scope: 'default', source: 'chat', meta: { mood: 'happy' } });
  assert.equal(first.created, true);

  const again = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  assert.equal(again.created, false);
  assert.equal(again.id, first.id, '同 hash 应返回既有 id');
  assert.equal(store.countMemories(), 1);

  const row = store.getMemory(first.id);
  assert.equal(row.text, '宝宝喜欢喝冰美式咖啡');
  assert.equal(row.scope, 'default');
  assert.equal(row.source, 'chat');
  assert.equal(row.revision, 1);
  assert.deepEqual(row.meta, { mood: 'happy' });
  assert.equal(row.hash, hashText('宝宝喜欢喝冰美式咖啡'));
  assert.equal(row.deleted_at, null);
  assert.equal(store.hashText('x'), hashText('x'));
  assert.equal(MemoryStore.hashText('x'), hashText('x'));
  assert.equal(hashText('x').length, 64);
});

test('行为计分：初始分 / 批量 bump / 全体同乘衰减 / 聚合 Top-N', () => {
  const { store } = makeStore();
  const a = store.addMemory({ text: '甲', readScore: 3, tidyScore: 1 });
  const b = store.addMemory({ text: '乙' });
  const c = store.addMemory({ text: '丙', readScore: 'x', tidyScore: Number.NaN });

  assert.equal(store.getMemory(a.id).readScore, 3);
  assert.equal(store.getMemory(a.id).tidyScore, 1);
  assert.equal(store.getMemory(a.id).read_score, 3, '原始列也要在返回值里');
  assert.equal(store.getMemory(b.id).readScore, 0);
  assert.equal(store.getMemory(c.id).readScore, 0, '坏初始值按 0 兜底');
  assert.equal(store.getMemory(c.id).tidyScore, 0);

  // 批量 +1：一条 SQL 更新多行；重复 id 只算一次；空 / 非数组不发 SQL。
  assert.equal(store.bumpReadScores([a.id, b.id, b.id]), 2, '重复 id 只更新一行');
  assert.equal(store.getMemory(a.id).readScore, 4);
  assert.equal(store.getMemory(b.id).readScore, 1);
  assert.equal(store.getMemory(c.id).readScore, 0, '没点名的条一分不动');
  assert.equal(store.bumpReadScores([]), 0);
  assert.equal(store.bumpReadScores(null), 0);
  assert.equal(store.bumpReadScores([null, '', undefined]), 0);
  assert.equal(store.bumpTidyScores([a.id]), 1);
  assert.equal(store.getMemory(a.id).tidyScore, 2);
  assert.equal(store.bumpReadScores(['不存在的 id']), 0, '不存在的 id 不改任何行');

  // 列表里也能看到两个分值。
  const rowA = store.listMemories({ limit: 10 }).items.find((row) => row.id === a.id);
  assert.equal(rowA.readScore, 4);
  assert.equal(rowA.tidyScore, 2);

  // 衰减：全体同乘，**比例不变**。
  store.decayScores(0.5);
  assert.equal(store.getMemory(a.id).readScore, 2);
  assert.equal(store.getMemory(b.id).readScore, 0.5);
  assert.equal(store.getMemory(a.id).tidyScore, 1);
  assert.throws(() => store.decayScores(0), /factor/);
  assert.throws(() => store.decayScores('x'), /factor/);

  // 聚合：总分 / 均值 / Top-N（preview 截 40 字）。
  const d = store.addMemory({ text: '丁'.repeat(60), readScore: 9 });
  const stats = store.scoreStats({ top: 2 });
  assert.equal(stats.count, 4);
  assert.equal(stats.totalRead, 11.5);
  assert.equal(stats.totalTidy, 1);
  assert.equal(stats.avgRead, 11.5 / 4);
  assert.equal(stats.avgTidy, 0.25);
  assert.deepEqual(stats.topRead.map((row) => row.id), [d.id, a.id]);
  assert.deepEqual(stats.topRead.map((row) => row.readScore), [9, 2]);
  assert.equal(stats.topRead[0].preview.length, 41, '40 字 + 省略号');
  assert.equal(stats.topTidy.length, 2, 'Top-N 取前 N 条（同分按创建时间兜底）');
  assert.equal(stats.topTidy[0].id, a.id);
  assert.equal(stats.topTidy[0].tidyScore, 1);

  // 软删的条不进聚合。
  store.softDeleteMemory(c.id);
  const after = store.scoreStats();
  assert.equal(after.count, 3);
  assert.equal(after.totalRead, 11.5);
  assert.deepEqual(store.scoreStats({ top: 0 }).topRead, [], 'top=0 = 只要聚合、不要 Top');
});

test('getMemory/listMemories/countMemories：scope 过滤、分页、includeDeleted', () => {
  const { store } = makeStore();
  const a = store.addMemory({ text: '甲', scope: 'work' });
  const b = store.addMemory({ text: '乙', scope: 'work' });
  const c = store.addMemory({ text: '丙', scope: 'life' });

  assert.equal(store.countMemories(), 3);
  assert.equal(store.countMemories({ scope: 'work' }), 2);

  const page1 = store.listMemories({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2);
  const page2 = store.listMemories({ limit: 2, offset: 2, scope: 'work' });
  assert.equal(page2.total, 2);
  assert.equal(page2.items.length, 0);

  assert.equal(store.getMemory('不存在'), null);

  store.softDeleteMemory(c.id);
  assert.equal(store.countMemories(), 2);
  assert.equal(store.countMemories({ includeDeleted: true }), 3);
  assert.equal(store.getMemory(c.id), null);
  assert.equal(store.getMemory(c.id, { includeDeleted: true }).id, c.id);

  assert.notEqual(a.id, b.id);
});

test('listTexts：生成器按 rowid 流式遍历，排除软删，batchSize 生效', () => {
  const { store } = makeStore();
  for (let i = 0; i < 5; i++) store.addMemory({ text: `文本 ${i}` });
  store.softDeleteMemory(store.listMemories({ limit: 1 }).items[0].id);

  const texts = [...store.listTexts({ batchSize: 2 })];
  assert.equal(texts.length, 4, '5 条里软删 1 条，剩 4 条');
  for (const item of texts) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.text, 'string');
  }
  const single = [...store.listTexts({ batchSize: 1 })];
  assert.equal(single.length, 4);
});

test('软删：不出现在 list / count / 关键词检索里', () => {
  const { store } = makeStore();
  const target = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  store.addMemory({ text: '宝宝喜欢喝热拿铁' });

  assert.equal(keywordSearch(store, { query: '冰美式' }).length, 1);

  assert.equal(store.softDeleteMemory(target.id), true);
  assert.equal(store.softDeleteMemory(target.id), false, '重复软删返回 false');

  assert.equal(store.listMemories().total, 1);
  assert.equal(store.countMemories(), 1);
  assert.deepEqual(keywordSearch(store, { query: '冰美式' }), []);
  assert.equal(store.getMemory(target.id, { includeDeleted: true }).deleted_at.length > 0, true);
});

test('hardDelete：真删行、FTS 索引同步删掉、向量级联删除、历史保留', () => {
  const { store, db } = makeStore();
  const memory = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  store.putVector({ memoryId: memory.id, space: 'test:m:2', model: 'm', dims: 2, vector: new Float32Array([1, 0]) });

  const ftsCount = () => Number(
    db.prepare('SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH ?').get('"冰美式"').c,
  );
  assert.equal(ftsCount(), 1);

  assert.equal(store.hardDeleteMemory(memory.id), true);
  assert.equal(store.hardDeleteMemory(memory.id), false, '再删返回 false');

  assert.equal(store.getMemory(memory.id, { includeDeleted: true }), null);
  assert.equal(ftsCount(), 0, 'FTS 索引必须同步删掉');
  assert.deepEqual(keywordSearch(store, { query: '冰美式' }), []);
  assert.equal(store.getVector(memory.id, 'test:m:2'), null, '向量应被外键级联删除');

  const history = store.listHistory(memory.id);
  assert.equal(history[0].op, 'hard_delete', '硬删前先留一条历史，硬删后历史仍在');
  assert.equal(history[0].prev_text, '宝宝喜欢喝冰美式咖啡');
});

test('updateMemoryText：revision 递增、写 supersede 历史、更新 hash 与 updated_at', () => {
  const { store } = makeStore();
  const memory = store.addMemory({ text: '旧文本' });
  const before = store.getMemory(memory.id);

  const updated = store.updateMemoryText(memory.id, '新文本', { note: '用户更正', meta: { tag: 'k' } });
  assert.equal(updated.text, '新文本');
  assert.equal(updated.revision, before.revision + 1);
  assert.equal(updated.hash, hashText('新文本'));
  assert.deepEqual(updated.meta, { tag: 'k' });
  assert.ok(updated.updated_at >= before.updated_at);

  const history = store.listHistory(memory.id, { limit: 10 });
  assert.equal(history.length, 2, 'add + supersede');
  assert.equal(history[0].op, 'supersede');
  assert.equal(history[0].prev_text, '旧文本');
  assert.equal(history[0].next_text, '新文本');
  assert.equal(history[0].note, '用户更正');
  assert.equal(history[1].op, 'add');

  assert.equal(keywordSearch(store, { query: '新文本' }).length, 1);
  assert.equal(keywordSearch(store, { query: '旧文本' }).length, 0, 'FTS 应随 UPDATE 触发器更新');

  assert.throws(() => store.updateMemoryText('不存在', 'x'), /记忆不存在/);
  store.softDeleteMemory(memory.id);
  assert.throws(() => store.updateMemoryText(memory.id, 'x'), /已软删/);
});

test('向量：按空间写入、BLOB 往返、listVectors 分批生成器、过滤、统计、删除', () => {
  const { store } = makeStore();
  const SPACE_A = 'test:model-a:3';
  const SPACE_B = 'test:model-b:3';
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const memory = store.addMemory({ text: `向量文本 ${i}` });
    ids.push(memory.id);
    store.putVector({
      memoryId: memory.id,
      space: i < 3 ? SPACE_A : SPACE_B,
      provider: 'test',
      model: i < 3 ? 'model-a' : 'model-b',
      dims: 3,
      vector: new Float32Array([i + 0.5, -1, 0.25]),
    });
  }

  const one = store.getVector(ids[0], SPACE_A);
  assert.ok(one.vector instanceof Float32Array);
  assert.equal(one.vector.length, 3);
  assert.equal(one.model, 'model-a');
  assert.equal(one.dims, 3);
  assert.equal(one.space, SPACE_A);
  assert.equal(one.provider, 'test');
  assert.deepEqual([...one.vector], [0.5, -1, 0.25]);
  assert.equal(store.getVector(ids[0], SPACE_B), null, '同一个 id 在别的空间里没有向量');

  const batched = [...store.listVectors({ batchSize: 2 })];
  assert.equal(batched.length, 5);
  assert.equal(new Set(batched.map((item) => item.memoryId)).size, 5);
  for (const item of batched) assert.ok(item.vector instanceof Float32Array);

  const onlyA = [...store.listVectors({ space: SPACE_A, batchSize: 10 })];
  assert.equal(onlyA.length, 3);
  assert.equal([...store.listVectors({ model: 'model-a', dims: 3, batchSize: 10 })].length, 3);
  assert.equal([...store.listVectors({ dims: 99 })].length, 0);

  assert.deepEqual(store.vectorStats(), {
    count: 5,
    spaces: [
      { key: SPACE_A, provider: 'test', model: 'model-a', dims: 3, count: 3 },
      { key: SPACE_B, provider: 'test', model: 'model-b', dims: 3, count: 2 },
    ],
  });
  assert.equal(store.countVectors(SPACE_A), 3);
  assert.equal(store.countVectors(), 5);

  store.deleteVector(ids[0]);
  assert.equal(store.getVector(ids[0], SPACE_A), null);
  assert.equal(store.vectorStats().count, 4);

  store.deleteVectorsOfSpace(SPACE_B);
  assert.deepEqual(store.vectorStats().spaces.map((item) => item.key), [SPACE_A]);

  store.deleteAllVectors();
  assert.deepEqual(store.vectorStats(), { count: 0, spaces: [] });

  assert.throws(() => store.putVector({ memoryId: ids[1], model: 'm', dims: 4, vector: new Float32Array([1, 2]) }), /space/);
  assert.throws(
    () => store.putVector({ memoryId: ids[1], space: 'x:m:4', model: 'm', dims: 4, vector: new Float32Array([1, 2]) }),
    /不一致/,
  );
});

test('向量：多空间共存 —— 同一条记忆可以同时保留两套向量，互不覆盖', () => {
  const { store } = makeStore();
  const memory = store.addMemory({ text: '同一条记忆' });
  store.putVector({ memoryId: memory.id, space: 'openai:m1:2', model: 'm1', dims: 2, vector: new Float32Array([1, 0]) });
  store.putVector({ memoryId: memory.id, space: 'ollama:m2:3', model: 'm2', dims: 3, vector: new Float32Array([0, 1, 0]) });

  assert.deepEqual([...store.getVector(memory.id, 'openai:m1:2').vector], [1, 0]);
  assert.deepEqual([...store.getVector(memory.id, 'ollama:m2:3').vector], [0, 1, 0]);
  assert.equal(store.countVectors(), 2);

  // 只删一个空间，另一个必须还在。
  store.deleteVector(memory.id, { space: 'openai:m1:2' });
  assert.equal(store.getVector(memory.id, 'openai:m1:2'), null);
  assert.deepEqual([...store.getVector(memory.id, 'ollama:m2:3').vector], [0, 1, 0]);
});

test('向量：countMissingVectors / listTextsMissingVector 只认「当前空间」', () => {
  const { store } = makeStore();
  const a = store.addMemory({ text: '甲' });
  const b = store.addMemory({ text: '乙' });
  store.putVector({ memoryId: a.id, space: 's1:m:2', model: 'm', dims: 2, vector: new Float32Array([1, 0]) });

  assert.equal(store.countMissingVectors('s1:m:2'), 1, 's1 里缺「乙」');
  assert.equal(store.countMissingVectors('s2:m:2'), 2, 's2 里两条都缺');
  assert.deepEqual([...store.listTextsMissingVector('s1:m:2')].map((row) => row.id), [b.id]);
  assert.equal([...store.listTextsMissingVector('s1:m:2')][0].text, '乙');

  // 软删的不算「缺」：它不需要向量。
  store.softDeleteMemory(b.id);
  assert.equal(store.countMissingVectors('s1:m:2'), 0);
});

test('updateMemoryText：正文一改，该条在**所有空间**里的向量立刻作废', () => {
  const { store } = makeStore();
  const memory = store.addMemory({ text: '服务端口是 8080' });
  store.putVector({ memoryId: memory.id, space: 's1:m:2', model: 'm', dims: 2, vector: new Float32Array([1, 0]) });
  store.putVector({ memoryId: memory.id, space: 's2:m:2', model: 'm', dims: 2, vector: new Float32Array([0, 1]) });
  assert.equal(store.countMissingVectors('s1:m:2'), 0);

  const updated = store.updateMemoryText(memory.id, '服务端口是 11434', { note: '测试改写' });

  assert.equal(updated.vectorsDeleted, 2, '返回值要告诉调用方删了几条向量');
  assert.equal(store.getVector(memory.id, 's1:m:2'), null);
  assert.equal(store.getVector(memory.id, 's2:m:2'), null);
  assert.equal(store.vectorStats().count, 0);
  // 关键：改完必须回到「缺向量」，否则增量补齐永远看不见它，语义路会一直用旧向量。
  assert.equal(store.countMissingVectors('s1:m:2'), 1);
  assert.equal(store.countMissingVectors('s2:m:2'), 1);
});

test('向量空间指纹：getActiveSpace / setActiveSpace（含 provider 与空间键）', () => {
  const { store } = makeStore();
  assert.equal(store.getActiveSpace(), null);

  store.setActiveSpace({ provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024 });
  assert.deepEqual(store.getActiveSpace(), {
    key: 'openai:qwen3.7-text-embedding:1024',
    provider: 'openai',
    model: 'qwen3.7-text-embedding',
    dims: 1024,
  });

  // 显式给 key 时以 key 为准（面板/迁移可以带自己的键）。
  const written = store.setActiveSpace({ key: 'custom:key:8', provider: 'ollama', model: 'other', dims: 8 });
  assert.equal(written, 'custom:key:8');
  assert.deepEqual(store.getActiveSpace(), { key: 'custom:key:8', provider: 'ollama', model: 'other', dims: 8 });

  assert.throws(() => store.setActiveSpace({ model: 'x', dims: 0 }), /dims/);
  assert.throws(() => store.setActiveSpace({ model: '', dims: 8 }), /model/);
});

test('meta 坏值容错：解析失败给 {}', () => {
  const { store, db } = makeStore();
  const memory = store.addMemory({ text: '坏 meta' });
  db.prepare('UPDATE memories SET meta = ? WHERE id = ?').run('{不是 JSON', memory.id);
  assert.deepEqual(store.getMemory(memory.id).meta, {});

  db.prepare('UPDATE memories SET meta = ? WHERE id = ?').run('[1,2]', memory.id);
  assert.deepEqual(store.getMemory(memory.id).meta, {}, '数组不是对象，也应给 {}');
});

test('批次与条目状态机：createBatch / listBatches / getBatch / setItemDecision / closeBatch', () => {
  const { store } = makeStore();
  const batch = store.createBatch({
    model: 'qwen3.7-text-embedding',
    sourceText: '今天聊了很多：宝宝喜欢喝冰美式咖啡，周末想去露营。',
    focused: true,
    items: ['宝宝喜欢喝冰美式咖啡', { text: '周末想去露营' }],
  });

  assert.equal(batch.items.length, 2);
  assert.deepEqual(batch.items.map((item) => item.idx), [0, 1]);
  assert.deepEqual(batch.items.map((item) => item.text), ['宝宝喜欢喝冰美式咖啡', '周末想去露营']);
  for (const item of batch.items) assert.equal(typeof item.id, 'number');

  const summaries = store.listBatches();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, batch.id);
  assert.equal(summaries[0].state, 'open');
  assert.equal(summaries[0].focused, true);
  assert.equal(summaries[0].count, 2);
  assert.ok(summaries[0].sourcePreview.includes('冰美式'));
  assert.deepEqual(store.listBatches({ state: 'approved' }), []);

  const full = store.getBatch(batch.id);
  assert.equal(full.sourceText.includes('露营'), true);
  assert.equal(full.items[0].state, 'pending');
  assert.equal(full.items[0].decidedAt, null);
  assert.equal(store.getBatch('不存在'), null);

  store.setItemDecision({ itemId: batch.items[0].id, state: 'approved' });
  store.setItemDecision({
    itemId: batch.items[1].id,
    state: 'edited',
    editedText: '周末想去露营（已改写）',
    relation: 'supersede',
    reason: '与旧记忆冲突',
    targetId: 'old-1',
    memoryId: 'mem-1',
  });

  const after = store.getBatch(batch.id);
  assert.equal(after.items[0].state, 'approved');
  assert.ok(after.items[0].decidedAt.length > 0);
  assert.equal(after.items[1].editedText, '周末想去露营（已改写）');
  assert.equal(after.items[1].relation, 'supersede');
  assert.equal(after.items[1].reason, '与旧记忆冲突');
  assert.equal(after.items[1].targetId, 'old-1');
  assert.equal(after.items[1].memoryId, 'mem-1');

  // 局部更新不应把其它字段清空。
  store.setItemDecision({ itemId: batch.items[1].id, state: 'approved' });
  assert.equal(store.getBatch(batch.id).items[1].editedText, '周末想去露营（已改写）');
  assert.equal(store.getBatch(batch.id).items[1].state, 'approved');

  assert.throws(() => store.setItemDecision({ itemId: 999999, state: 'approved' }), /条目不存在/);
  assert.throws(() => store.closeBatch(batch.id, '乱写'), /approved/);

  assert.equal(store.closeBatch(batch.id, 'approved'), true);
  assert.equal(store.closeBatch(batch.id, 'approved'), false, '已关闭返回 false');
  assert.equal(store.closeBatch('不存在', 'rejected'), false);
  const closed = store.getBatch(batch.id);
  assert.equal(closed.state, 'approved');
  assert.ok(closed.decidedAt.length > 0);
  assert.equal(store.listBatches({ state: 'approved' }).length, 1);
  assert.equal(store.listBatches({ state: 'open' }).length, 0);
});

test('jobs：创建、更新（含 finishedAt 别名与 detail 序列化）、latestJob', () => {
  const { store } = makeStore();
  const id = store.createJob({ kind: 'embed', total: 10 });

  const created = store.getJob(id);
  assert.equal(created.kind, 'embed');
  assert.equal(created.state, 'running');
  assert.equal(created.total, 10);
  assert.equal(created.done, 0);
  assert.equal(created.failed, 0);
  assert.ok(created.started_at.length > 0);
  assert.equal(created.finished_at, null);

  const updated = store.updateJob(id, {
    state: 'done',
    done: 10,
    failed: 1,
    error: null,
    detail: { model: 'm' },
    finishedAt: '2026-02-02T00:00:00.000Z',
  });
  assert.equal(updated.state, 'done');
  assert.equal(updated.done, 10);
  assert.equal(updated.failed, 1);
  assert.equal(updated.finished_at, '2026-02-02T00:00:00.000Z');
  assert.equal(updated.detail, '{"model":"m"}');
  assert.equal(updated.started_at, created.started_at, '未传的字段保持原值');

  assert.equal(store.latestJob().id, id);
  assert.equal(store.latestJob({ kind: 'embed' }).id, id);
  assert.equal(store.latestJob({ kind: '没这个 kind' }), null);
  assert.equal(store.getJob('不存在'), null);
  assert.throws(() => store.updateJob('不存在', { state: 'done' }), /任务不存在/);
  assert.throws(() => store.createJob({ kind: '' }), /kind/);
});

test('keeper_plans：建单 / 取单 / 列表（可按状态过滤）/ 更新审阅结果', () => {
  const { store } = makeStore();
  assert.deepEqual(store.listKeeperPlans(), []);
  assert.equal(store.getKeeperPlan('nope'), null);

  const ops = [
    { idx: 0, type: 'replace', targets: ['a'], before: [{ id: 'a', text: '旧' }], after: '新', reason: '删旧录新', warnings: [] },
  ];
  const created = store.createKeeperPlan({ runId: 'run-1', seedId: 'a', memberIds: ['a', 'b'], ops });
  assert.ok(created.id.length > 0);
  assert.equal(created.runId, 'run-1');
  assert.equal(created.state, 'open');
  assert.equal(created.seedId, 'a');
  assert.deepEqual(created.memberIds, ['a', 'b'], 'JSON 列要解析回数组');
  assert.deepEqual(created.ops, ops, 'ops 往返不丢结构');
  assert.equal(created.reviewedAt, null);
  assert.equal(created.review, null);
  assert.equal(created.model, null, '没给 model = null（不知道是谁产的，不假装）');
  assert.ok(created.createdAt.length > 0);

  // 显式 id + 排序：新的在前
  const second = store.createKeeperPlan({ id: 'p2', runId: 'run-2', seedId: 'b', memberIds: ['b'], ops: [] });
  assert.equal(second.id, 'p2');
  assert.deepEqual(store.listKeeperPlans().map((plan) => plan.id), ['p2', created.id]);
  assert.deepEqual(store.listKeeperPlans({ state: 'open' }).map((plan) => plan.id), ['p2', created.id]);
  assert.deepEqual(store.listKeeperPlans({ state: 'approved' }), []);
  assert.equal(store.listKeeperPlans({ limit: 1 }).length, 1);

  // 更新：只给 state 时补当前时间；review 可以是对象（自动 JSON 化）；null = 保持原值
  const reviewed = store.updateKeeperPlan(created.id, { state: 'approved', review: { keep: [0], applied: { replace: 1 } }, reviewedAt: '2026-03-03T00:00:00.000Z' });
  assert.equal(reviewed.state, 'approved');
  assert.deepEqual(reviewed.review, { keep: [0], applied: { replace: 1 } });
  assert.equal(reviewed.reviewedAt, '2026-03-03T00:00:00.000Z');
  assert.deepEqual(reviewed.ops, ops, '审阅不该动 ops');

  // ops 也是可选补丁：`replace` 落库后要把新记忆 id 写回 op（面板显示「新记忆 id」）
  const withNewId = store.updateKeeperPlan(created.id, { ops: [{ ...ops[0], newId: 'new-1' }] });
  assert.equal(withNewId.ops[0].newId, 'new-1');
  assert.equal(withNewId.state, 'approved', '只给 ops 时 state / review 保持原值');
  assert.deepEqual(withNewId.review, { keep: [0], applied: { replace: 1 } });
  assert.deepEqual(store.updateKeeperPlan(created.id, { ops }).ops, ops, 'ops=null / 不给时保持原值');

  const partial = store.updateKeeperPlan(created.id, { state: 'partial' });
  assert.equal(partial.state, 'partial');
  assert.notEqual(partial.reviewedAt, null, '没给时间时补当前时间');
  assert.deepEqual(store.getKeeperPlan(created.id), partial, '取单与更新结果同形');

  assert.throws(() => store.updateKeeperPlan('不存在', { state: 'approved' }), /变更单不存在/);
  assert.throws(() => store.createKeeperPlan({ memberIds: 'x' }), /memberIds/);
  assert.throws(() => store.createKeeperPlan({ ops: 'x' }), /ops/);

  // `model` = 「产出这张单的模型」：主仓管那一轮署 client.model，副仓管接手署 taker 的 model。
  // （放在列表断言之后：这两张新单会进 `listKeeperPlans()`。）
  const bySide = store.createKeeperPlan({ seedId: 'c', memberIds: ['c'], ops: [], model: 'taker-9' });
  assert.equal(bySide.model, 'taker-9', '谁产的谁署名（往返不丢）');
  assert.equal(store.getKeeperPlan(bySide.id).model, 'taker-9');
  assert.equal(store.createKeeperPlan({ seedId: 'd', memberIds: ['d'], ops: [], model: '   ' }).model, null, '空白当没给');
});

test('keeper_handoffs（待接手记忆）：建行 / 同一组失败累加不插新行 / 状态更新 / 计数', () => {
  const { store } = makeStore();
  assert.deepEqual(store.listHandoffs(), []);
  assert.equal(store.countOpenHandoffs(), 0);
  assert.equal(store.getHandoff('nope'), null);

  const first = store.createHandoff({ runId: 'run-1', seedId: 'seed-a', memberIds: ['a', 'b'], error: 'TimeoutError: 超时' });
  assert.ok(first.id.length > 0);
  assert.equal(first.state, 'open');
  assert.equal(first.seedId, 'seed-a');
  assert.deepEqual(first.memberIds, ['a', 'b'], 'JSON 列解析回数组');
  assert.equal(first.error, 'TimeoutError: 超时');
  assert.equal(first.attempts, 1, '第一行就算试过 1 次');
  assert.equal(first.taker, null);
  assert.equal(first.planId, null);
  assert.ok(first.createdAt.length > 0 && first.updatedAt.length > 0);
  assert.equal(store.countOpenHandoffs(), 1);

  // 同一组（同 seed）再失败：就地累加 attempts、刷新 error，绝不插第二行（否则这张表无界增长）。
  const again = store.createHandoff({ runId: 'run-2', seedId: 'seed-a', memberIds: ['a', 'b', 'c'], error: 'Error: 又是它' });
  assert.equal(again.id, first.id, '同一个种子复用那一行');
  assert.equal(again.attempts, 2);
  assert.equal(again.error, 'Error: 又是它');
  assert.deepEqual(again.memberIds, ['a', 'b', 'c'], '成员按最新一次刷新');
  assert.equal(store.listHandoffs().length, 1);

  // 已经处理过（taken / dropped）的行**不再复用**：下次再失败会重新挂一行。
  store.updateHandoff(first.id, { state: 'taken', taker: '本机-ollama / qwen3:8b', planId: 'plan-9' });
  const reopened = store.createHandoff({ seedId: 'seed-a', memberIds: ['a'], error: '再失败一次' });
  assert.notEqual(reopened.id, first.id, '终态行不参与复用');
  assert.equal(reopened.attempts, 1);
  assert.deepEqual(store.listHandoffs({ state: 'open' }).map((row) => row.id), [reopened.id]);
  assert.deepEqual(store.listHandoffs({ state: 'taken' }).map((row) => row.id), [first.id]);
  assert.equal(store.countOpenHandoffs(), 1);

  // bumpHandoffAttempts / updateHandoff：null = 保持原值（与 updateKeeperPlan 同一套语义）。
  const bumped = store.bumpHandoffAttempts(reopened.id);
  assert.equal(bumped.attempts, 2);
  const kept = store.updateHandoff(reopened.id, { error: '接手也失败：HTTP 500' });
  assert.equal(kept.error, '接手也失败：HTTP 500');
  assert.equal(kept.state, 'open', '只给 error 不该动 state');
  assert.equal(kept.attempts, 2, '只给 error 不该动 attempts');
  assert.equal(kept.taker, null);
  // memberIds 也是可选补丁：重头整理之后这一行的成员要换成"真正整理的那一组"。
  const remem = store.updateHandoff(reopened.id, { memberIds: ['a', 'b', 'c'] });
  assert.deepEqual(remem.memberIds, ['a', 'b', 'c']);
  assert.equal(remem.error, '接手也失败：HTTP 500', '只给 memberIds 时 error 保持');
  assert.equal(kept.attempts, 2, '只给 memberIds 时 attempts 保持');
  assert.throws(() => store.updateHandoff(reopened.id, { memberIds: 'x' }), /memberIds/);
  const dropped = store.updateHandoff(reopened.id, { state: 'dropped' });
  assert.equal(dropped.state, 'dropped');
  assert.equal(dropped.error, '接手也失败：HTTP 500', '只给 state 时 error 保持');
  assert.equal(store.countOpenHandoffs(), 0);
  assert.equal(store.listHandoffs({ limit: 1 }).length, 1, 'limit 生效');

  assert.throws(() => store.createHandoff({ memberIds: 'x' }), /memberIds/);
  assert.throws(() => store.updateHandoff('不存在', { state: 'taken' }), /副整理区项不存在/);
  assert.throws(() => store.bumpHandoffAttempts('不存在'), /副整理区项不存在/);
});

test('keeper_handoffs 认领：同一组只能被接一次（原子比较并交换）+ 认领失败放回队列 + 僵住的认领会被放回', () => {
  // 用户 2026-10-08：「主副仓管独立，各自的运行不能互相产生干扰」——
  // 主仓管某组失败后是「挂队列 + 当场接手」，而面板在同一窗口里也看得到那一行，
  // 不做原子认领就会**同一组被接两次、出两张单**。
  const { store } = makeStore();
  const row = store.createHandoff({ seedId: 'seed-x', memberIds: ['a'], error: '第一次失败' });

  assert.equal(store.claimHandoff(row.id), true, '第一次认领成功');
  assert.equal(store.getHandoff(row.id).state, 'taking');
  assert.equal(store.claimHandoff(row.id), false, '第二次认领失败（已经被人拿走了）');
  assert.equal(store.countOpenHandoffs(), 0, '被认领的条不算"待接手"');

  // 认领期间同一个种子再挂一次：**不插新行**（否则同一组会并排两条，一条卡在 taking）
  const duringClaim = store.createHandoff({ seedId: 'seed-x', memberIds: ['a', 'b'], error: '又失败' });
  assert.equal(duringClaim.id, row.id, 'taking 的行同样参与复用');
  assert.equal(store.listHandoffs().length, 1);

  // 失败 → 放回队列（不然面板看不到、也接手不了 = 悄悄丢了）
  assert.equal(store.releaseHandoff(row.id, { error: '接手失败：HTTP 500' }), true);
  const back = store.getHandoff(row.id);
  assert.equal(back.state, 'open');
  assert.equal(back.error, '接手失败：HTTP 500');
  assert.equal(store.releaseHandoff(row.id), false, '不是 taking 就不该被放回（别把终态踩回去）');
  assert.equal(store.claimHandoff(row.id), true);

  // 进程被杀留下的 taking：超过阈值由 listHandoffs 之前的一道清扫放回来
  const reclaimed = store.reclaimStaleHandoffs({ olderThanMs: -1 });
  assert.equal(reclaimed, 1, '更新的时间戳也算"够旧"（这里用负阈值模拟）');
  assert.equal(store.getHandoff(row.id).state, 'open');
  assert.equal(store.claimHandoff(row.id), true);
  assert.equal(store.reclaimStaleHandoffs({ olderThanMs: 600000 }), 0, '刚认领的不该被放回');
  assert.equal(store.getHandoff(row.id).state, 'taking');
});

test('palace_sources：upsert / getSource / listSources', () => {
  const { store } = makeStore();
  assert.equal(store.getSource('nope'), null);
  assert.deepEqual(store.listSources(), []);

  store.upsertSource({ path: '/a.md', kind: 'markdown', mtimeMs: 100, size: 10, contentHash: 'h1', chunkCount: 2 });
  const first = store.getSource('/a.md');
  assert.equal(first.kind, 'markdown');
  assert.equal(Number(first.mtime_ms), 100);
  assert.equal(Number(first.chunk_count), 2);
  assert.ok(first.synced_at.length > 0);

  store.upsertSource({ path: '/a.md', kind: 'markdown', mtimeMs: 200, size: 20, contentHash: 'h2', chunkCount: 5 });
  store.upsertSource({ path: '/b.md' });
  const rows = store.listSources();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => String(row.path)), ['/a.md', '/b.md']);
  assert.equal(Number(store.getSource('/a.md').mtime_ms), 200);
  assert.equal(String(store.getSource('/a.md').content_hash), 'h2');
  assert.equal(store.getSource('/b.md').kind, null);

  assert.throws(() => store.upsertSource({ path: '' }), /path/);
});

test('settings：默认值、覆盖、字符串化', () => {
  const { store } = makeStore();
  assert.equal(store.getSetting('missing'), null);
  assert.equal(store.getSetting('missing', 'fallback'), 'fallback');

  store.setSetting('embedding.provider', 'openai');
  assert.equal(store.getSetting('embedding.provider'), 'openai');
  store.setSetting('search.defaultLimit', 12);
  assert.equal(store.getSetting('search.defaultLimit'), '12');
  assert.equal(store.getSetting('embedding.provider', 'x'), 'openai');
});

test('listHistory：按 id 倒序、limit 生效', () => {
  const { store } = makeStore();
  const memory = store.addMemory({ text: 'v0' });
  store.updateMemoryText(memory.id, 'v1');
  store.updateMemoryText(memory.id, 'v2');

  const all = store.listHistory(memory.id);
  assert.deepEqual(all.map((row) => String(row.op)), ['supersede', 'supersede', 'add']);
  assert.deepEqual(all.map((row) => row.next_text), ['v2', 'v1', 'v0']);
  assert.equal(store.listHistory(memory.id, { limit: 1 }).length, 1);
  assert.deepEqual(store.listHistory('别的 id'), []);
});

test('文件库：同一个 store 反复开关后数据仍在（WAL 落盘）', () => {
  const file = `${TMP}\\persist.db`;
  const db1 = openDatabase(file);
  const store1 = new MemoryStore(db1, { now: makeClock() });
  const memory = store1.addMemory({ text: '持久化文本' });
  closeDatabase(db1);

  const db2 = openDatabase(file);
  const store2 = new MemoryStore(db2, { now: makeClock() });
  assert.equal(store2.getMemory(memory.id).text, '持久化文本');
  assert.equal(store2.countMemories(), 1);
  closeDatabase(db2);
});
