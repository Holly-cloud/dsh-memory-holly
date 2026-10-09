/**
 * search.js 测试：中文 trigram 关键词、余弦边界、向量检索、RRF 融合、混合检索三态。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import {
  cosineSimilarity,
  hybridSearch,
  keywordSearch,
  normalizeVector,
  reciprocalRankFusion,
  vectorSearch,
} from '../src/host/search.js';
import { cleanupTmpDir, freshTmpDir, makeClock } from './util.js';

const TMP = freshTmpDir('search');

after(() => cleanupTmpDir(TMP));

/**
 * 造一个内存库 + 固定时钟的 store。
 *
 * @returns {MemoryStore} store
 */
function makeStore() {
  const db = openDatabase(':memory:');
  return new MemoryStore(db, { now: makeClock() });
}

const FIXTURE_SPACE = 'test:model-a:2';

/**
 * 造一个「正文 + 向量」的小库。
 *
 * @returns {{ store: MemoryStore, m1: string, m2: string, m3: string }} 库与三条记忆 id
 */
function makeFixture() {
  const store = makeStore();
  const m1 = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' }).id;
  const m2 = store.addMemory({ text: '周末去露营' }).id;
  const m3 = store.addMemory({ text: '今天下雨了' }).id;
  store.putVector({ memoryId: m1, space: FIXTURE_SPACE, model: 'model-a', dims: 2, vector: new Float32Array([1, 0]) });
  store.putVector({ memoryId: m2, space: FIXTURE_SPACE, model: 'model-a', dims: 2, vector: new Float32Array([0.8, 0.6]) });
  store.putVector({ memoryId: m3, space: FIXTURE_SPACE, model: 'model-a', dims: 2, vector: new Float32Array([0, 1]) });
  return { store, m1, m2, m3 };
}

test('cosineSimilarity：同向 1、正交 0、反向 -1、零向量 0、长度不等 0', () => {
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0])), -1);
  assert.equal(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1])), 0);
  assert.equal(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0])), 0);
  assert.equal(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3])), 0);
  assert.equal(cosineSimilarity(null, new Float32Array([1])), 0);
  assert.ok(Math.abs(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([2, 2])) - 1) < 1e-6);
});

test('normalizeVector：模长归一；零向量原样返回；不改原对象', () => {
  const source = new Float32Array([3, 4]);
  const normalized = normalizeVector(source);
  assert.notEqual(normalized, source);
  assert.ok(Math.abs(Math.hypot(normalized[0], normalized[1]) - 1) < 1e-6);
  assert.deepEqual([...source], [3, 4], '原向量不应被改动');

  const zero = normalizeVector(new Float32Array([0, 0, 0]));
  assert.deepEqual([...zero], [0, 0, 0]);
  assert.deepEqual([...normalizeVector([0, 2])], [0, 1], '普通数组也应接受');
});

test('keywordSearch：中文 trigram 子串命中、scope 过滤、limit、非法字符不炸', () => {
  const { store, m1 } = makeFixture();

  const hits = keywordSearch(store, { query: '冰美式' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, m1);
  assert.ok(hits[0].score > 0, 'score = -bm25 应为正数');

  assert.equal(keywordSearch(store, { query: '美式咖啡' }).length, 1);
  assert.equal(keywordSearch(store, { query: '冰美式咖啡' }).length, 1);
  // 「咖啡」是 2 字：trigram 命不中，由 LIKE 兜底命中（详见下方专门的边界用例）。
  assert.equal(keywordSearch(store, { query: '咖啡' }).length, 1, '2 字查询必须靠 LIKE 兜底命中');
  assert.equal(keywordSearch(store, { query: '拿铁' }).length, 0, '库里确实没有「拿铁」');
  assert.equal(keywordSearch(store, { query: '冰美式', limit: 0 }).length, 0);
  assert.deepEqual(keywordSearch(store, { query: '   ' }), []);
  assert.deepEqual(keywordSearch(store, { query: '' }), []);

  // FTS5 语法字符必须被当成普通字符，而不是查询语法。
  for (const weird of ['-冰美式', '冰美式*', '"冰美式"', 'NEAR(', 'a OR b', '冰美式 AND']) {
    assert.doesNotThrow(() => keywordSearch(store, { query: weird }), `query=${weird} 不应抛错`);
  }

  // scope 过滤
  const other = store.addMemory({ text: '冰美式真好喝', scope: 'life' });
  assert.equal(keywordSearch(store, { query: '冰美式' }).length, 2);
  const scoped = keywordSearch(store, { query: '冰美式', scope: 'life' });
  assert.deepEqual(scoped.map((hit) => hit.id), [other.id]);
  assert.equal(keywordSearch(store, { query: '冰美式', scope: 'default' }).length, 1);
});

test('vectorSearch：按余弦排序、limit、模型维度过滤、零查询向量返回空', () => {
  const { store, m1, m2, m3 } = makeFixture();

  const hits = vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: FIXTURE_SPACE });
  assert.deepEqual(hits.map((hit) => hit.id), [m1, m2, m3]);
  assert.ok(Math.abs(hits[0].score - 1) < 1e-6);
  assert.ok(Math.abs(hits[1].score - 0.8) < 1e-6);

  assert.deepEqual(
    vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: FIXTURE_SPACE, limit: 1 }).map((hit) => hit.id),
    [m1],
  );
  assert.deepEqual(vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: FIXTURE_SPACE, model: 'model-b' }), []);
  assert.deepEqual(vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: FIXTURE_SPACE, dims: 8 }), []);
  assert.deepEqual(vectorSearch(store, { queryVector: new Float32Array([0, 0]), space: FIXTURE_SPACE }), []);
  assert.deepEqual(vectorSearch(store, { queryVector: null, space: FIXTURE_SPACE }), []);
});

test('vectorSearch：只认给定空间 —— 别的模型算的向量绝不参与排序', () => {
  const { store, m1, m2, m3 } = makeFixture();
  // 给 m1 在另一个空间里放一个「完全反向」的向量：如果不过滤空间，它会把 m1 排到最后。
  store.putVector({ memoryId: m1, space: 'other:model-b:2', model: 'model-b', dims: 2, vector: new Float32Array([-1, 0]) });

  const inFixture = vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: FIXTURE_SPACE });
  assert.deepEqual(inFixture.map((hit) => hit.id), [m1, m2, m3], '当前空间里的排序不受别的空间影响');

  const inOther = vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: 'other:model-b:2' });
  assert.deepEqual(inOther.map((hit) => hit.id), [m1], '别的空间里只有它自己那一套向量');

  assert.deepEqual(vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: 'nothing:here:2' }), []);
});

test('vectorSearch：软删的记忆不出现在结果里', () => {
  const { store, m1, m2 } = makeFixture();
  assert.equal(store.softDeleteMemory(m1), true);

  const hits = vectorSearch(store, { queryVector: new Float32Array([1, 0]), space: FIXTURE_SPACE });
  assert.equal(hits.some((hit) => hit.id === m1), false, '软删的记录必须被过滤');
  assert.equal(hits[0].id, m2, 'm1 被过滤后 m2 上升为第 1 名');
  assert.equal(hits.length, 2);
});

test('reciprocalRankFusion：RRF 公式、名次融合顺序、weights 生效、parts 明细', () => {
  const lists = [
    { name: 'a', items: [{ id: 'x', score: 9 }, { id: 'y', score: 1 }] },
    { name: 'b', items: [{ id: 'y', score: 5 }, { id: 'z', score: 1 }] },
  ];

  const fused = reciprocalRankFusion(lists);
  assert.deepEqual(fused.map((entry) => entry.id), ['y', 'x', 'z']);
  assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.ok(Math.abs(fused[1].score - 1 / 61) < 1e-12);
  assert.ok(Math.abs(fused[2].score - 1 / 62) < 1e-12);

  const partsX = fused[1].parts.a;
  assert.equal(partsX.rank, 1);
  assert.equal(partsX.weight, 1);
  assert.equal(partsX.score, 9);
  assert.ok(Math.abs(partsX.contribution - 1 / 61) < 1e-12);
  assert.equal(fused[2].parts.b.rank, 2);

  // 把 b 的权重压成 0 → x 反超 y
  const zeroWeighted = reciprocalRankFusion(lists, { weights: { a: 1, b: 0 } });
  assert.deepEqual(zeroWeighted.map((entry) => entry.id), ['x', 'y', 'z']);
  assert.equal(zeroWeighted[2].score, 0);

  // k 影响分母
  const small = reciprocalRankFusion(lists, { k: 1 });
  assert.ok(Math.abs(small[0].score - (1 / 3 + 1 / 2)) < 1e-12);

  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion(null), []);
});

test('hybridSearch：只有关键词 / 只有向量 / 两者都有 / 两者都缺', () => {
  const { store, m1, m2, m3 } = makeFixture();

  assert.throws(() => hybridSearch(store, {}), /至少要提供一个/);
  assert.throws(() => hybridSearch(store, { query: '   ' }), /至少要提供一个/);

  const keywordOnly = hybridSearch(store, { query: '冰美式', limit: 5 });
  assert.equal(keywordOnly.length, 1);
  assert.equal(keywordOnly[0].id, m1);
  assert.ok(keywordOnly[0].keywordScore > 0);
  assert.equal(keywordOnly[0].vectorScore, 0);
  assert.ok(keywordOnly[0].parts.keyword);
  assert.equal(keywordOnly[0].parts.vector, undefined);

  const vectorOnly = hybridSearch(store, { queryVector: new Float32Array([1, 0]), limit: 5 });
  assert.deepEqual(vectorOnly.map((entry) => entry.id), [m1, m2, m3]);
  assert.equal(vectorOnly[0].keywordScore, 0);
  assert.ok(vectorOnly[0].vectorScore > 0);
  assert.equal(vectorOnly[0].parts.keyword, undefined);
  assert.ok(vectorOnly[0].parts.vector);

  const both = hybridSearch(store, { query: '冰美式', queryVector: new Float32Array([1, 0]), limit: 5 });
  assert.deepEqual(both.map((entry) => entry.id), [m1, m2, m3]);
  assert.ok(Math.abs(both[0].score - 2 / 61) < 1e-12, 'm1 在两路里都是第 1 名');
  assert.ok(both[0].keywordScore > 0 && both[0].vectorScore > 0);
  assert.ok(both[1].score < both[0].score);

  // limit 截断
  assert.deepEqual(hybridSearch(store, { query: '冰美式', queryVector: new Float32Array([1, 0]), limit: 1 }).map((e) => e.id), [m1]);

  // minScore 过滤
  const filtered = hybridSearch(store, { query: '冰美式', queryVector: new Float32Array([1, 0]), minScore: 0.02, limit: 5 });
  assert.deepEqual(filtered.map((entry) => entry.id), [m1]);
  assert.deepEqual(hybridSearch(store, { query: '冰美式', minScore: 1, limit: 5 }), []);
});

test('hybridSearch：权重影响融合名次', () => {
  const { store } = makeFixture();
  const vectorOnlyWeight = hybridSearch(store, {
    query: '冰美式',
    queryVector: new Float32Array([1, 0]),
    keywordWeight: 0,
    vectorWeight: 1,
    limit: 5,
  });
  const first = vectorOnlyWeight[0];
  assert.ok(Math.abs(first.score - 1 / 61) < 1e-12);

  const keywordOnlyWeight = hybridSearch(store, {
    query: '冰美式',
    queryVector: new Float32Array([1, 0]),
    keywordWeight: 1,
    vectorWeight: 0,
    limit: 5,
  });
  assert.ok(Math.abs(keywordOnlyWeight[0].score - 1 / 61) < 1e-12);
});

test('hybridSearch：软删的记录在三种模式下都不出现', () => {
  const { store, m1 } = makeFixture();
  store.softDeleteMemory(m1);

  assert.deepEqual(hybridSearch(store, { query: '冰美式' }), []);
  assert.deepEqual(hybridSearch(store, { queryVector: new Float32Array([1, 0]) }).map((e) => e.id).includes(m1), false);
  assert.equal(hybridSearch(store, { query: '冰美式', queryVector: new Float32Array([1, 0]) }).some((e) => e.id === m1), false);
});

test('文件库上的检索仍然工作（FTS 落盘）', () => {
  const file = `${TMP}\\search.db`;
  const db = openDatabase(file);
  const store = new MemoryStore(db, { now: makeClock() });
  const memory = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  const hits = keywordSearch(store, { query: '冰美式' });
  assert.deepEqual(hits.map((hit) => hit.id), [memory.id]);
  closeDatabase(db);
});

// ── trigram 边界：短于 3 字必须靠 LIKE 兜底 ──────────────────────────────────
// 这几条是回归护栏。FTS5 的 trigram 分词器对 <3 字查询恒返回空，
// 而中文两字词极常见；一旦有人把 keywordSearch「简化」回单条 FTS5，这里立刻红。

/**
 * 造一个覆盖短查询边界的小库。
 *
 * @returns {MemoryStore} store
 */
function makeShortQueryStore() {
  const store = makeStore();
  store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' }); // a
  store.addMemory({ text: '宝宝不喜欢喝拿铁' }); // b
  store.addMemory({ text: '咖啡因摄入要控制' }); // c
  store.addMemory({ text: '端口改成 11434 了' }); // d
  store.addMemory({ text: '折扣是 100% 全额' }); // e
  store.addMemory({ text: '名字里有下划线 a_b' }); // f
  return store;
}

test('keywordSearch：3 字及以上走 FTS5，能命中', () => {
  const store = makeShortQueryStore();
  assert.equal(keywordSearch(store, { query: '冰美式' }).length, 1);
  assert.equal(keywordSearch(store, { query: '咖啡因' }).length, 1);
  assert.equal(keywordSearch(store, { query: '11434' }).length, 1);
  assert.equal(keywordSearch(store, { query: '记忆宫殿' }).length, 0);
});

test('keywordSearch：2 字中文词必须命中（trigram 命不中，靠 LIKE 兜底）', () => {
  const store = makeShortQueryStore();
  const baobao = keywordSearch(store, { query: '宝宝' });
  assert.equal(baobao.length, 2, '「宝宝」必须命中 2 条；纯 FTS5 实现这里会是 0');
  assert.equal(baobao[0].score, 1, 'LIKE 路的 score 是常量 1');

  assert.equal(keywordSearch(store, { query: '咖啡' }).length, 2, '「咖啡」命中冰美式与咖啡因两条');
  assert.equal(keywordSearch(store, { query: '拿铁' }).length, 1);
});

test('keywordSearch：单字也必须命中', () => {
  const store = makeShortQueryStore();
  assert.equal(keywordSearch(store, { query: '宝' }).length, 2);
  assert.equal(keywordSearch(store, { query: '铁' }).length, 1);
});

test('keywordSearch：多段查询按 AND 语义（走 LIKE 兜底）', () => {
  const store = makeShortQueryStore();
  // 两个两字词 → LIKE 路，AND
  const both = keywordSearch(store, { query: '宝宝 咖啡' });
  assert.equal(both.length, 1, '同时含「宝宝」与「咖啡」的只有第 1 条');

  // 两个三字词 → 也是 LIKE 路（多段一律不走 FTS5）
  const triple = keywordSearch(store, { query: '冰美式 拿铁' });
  assert.equal(triple.length, 0, '没有一条同时含「冰美式」与「拿铁」');

  assert.equal(keywordSearch(store, { query: '宝宝 拿铁' }).length, 1);
});

test('keywordSearch：LIKE 路的通配符必须被转义', () => {
  const store = makeShortQueryStore();
  // 若 % 未转义，查 % 会把全表捞出来
  const percent = keywordSearch(store, { query: '%' });
  assert.equal(percent.length, 1, '只有那条真的含 % 的记录');
  // 若 _ 未转义，查 _ 会变成任意单字匹配
  const underscore = keywordSearch(store, { query: '_' });
  assert.equal(underscore.length, 1, '只有那条真的含下划线的记录');
});

test('keywordSearch：短查询路径同样过滤软删记录与 scope', () => {
  const store = makeStore();
  const a = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡', scope: 'default' }).id;
  const b = store.addMemory({ text: '宝宝在另一档', scope: 'life' }).id;
  assert.equal(keywordSearch(store, { query: '宝宝' }).length, 2);
  assert.deepEqual(keywordSearch(store, { query: '宝宝', scope: 'life' }).map((h) => h.id), [b]);

  store.softDeleteMemory(a);
  assert.deepEqual(keywordSearch(store, { query: '宝宝', scope: 'default' }), []);
  assert.deepEqual(keywordSearch(store, { query: '宝' }).map((h) => h.id), [b]);
});

test('keywordSearch：空查询与 limit=0 返回空数组', () => {
  const store = makeShortQueryStore();
  assert.deepEqual(keywordSearch(store, { query: '' }), []);
  assert.deepEqual(keywordSearch(store, { query: '   ' }), []);
  assert.deepEqual(keywordSearch(store, { query: '宝宝', limit: 0 }), []);
});

test('hybridSearch：两字查询也能通过关键词路贡献名次', () => {
  const { store, m1 } = makeFixture();
  const fused = hybridSearch(store, {
    query: '宝宝',
    queryVector: new Float32Array([1, 0]),
    limit: 5,
  });
  assert.ok(fused.length > 0, '两字查询不应让关键词路整体失效');
  assert.ok(fused.some((entry) => entry.id === m1));
  assert.ok(fused.every((entry) => entry.keywordScore === 0 || entry.keywordScore === 1));
});
