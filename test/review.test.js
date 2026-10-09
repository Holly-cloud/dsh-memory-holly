/**
 * review.js 测试：库外待审区（stageExtraction 只建批次）、审阅门逐条规则
 * （keep / edits / supersede / duplicate）、全跳过不关批次、onAdded 回调、rejectBatch。
 *
 * 全程不联网：用内存库（`:memory:`）+ 本地假 LLM，不写任何临时文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import { makeClock } from './util.js';
import { stageExtraction, reviewBatch, rejectBatch } from '../src/host/review.js';

/**
 * 造一个内存库 + 固定时钟的 store（与 store.test.js 的写法一致）。
 *
 * @returns {{ store: MemoryStore, db: import('node:sqlite').DatabaseSync }} 组合
 */
function makeStore() {
  const db = openDatabase(':memory:');
  return { store: new MemoryStore(db, { now: makeClock() }), db };
}

/**
 * 造一个假 LLM：记录每次请求，按需返回固定文本或抛错。
 *
 * @param {string} reply 回复
 * @param {{ throwError?: Error | null }} [options] 是否抛错
 * @returns {{ chat: (request: unknown) => Promise<string>, calls: unknown[] }} 假客户端
 */
function makeFakeLlm(reply, { throwError = null } = {}) {
  /** @type {unknown[]} */
  const calls = [];
  return {
    calls,
    async chat(request) {
      calls.push(request);
      if (throwError != null) throw throwError;
      return reply;
    },
  };
}

/**
 * 造一个「返回给定事实数组」的假 LLM。
 *
 * @param {string[]} facts 事实
 * @returns {{ chat: (request: unknown) => Promise<string>, calls: unknown[] }} 假客户端
 */
function factsLlm(facts) {
  return makeFakeLlm(JSON.stringify(facts));
}

/**
 * 取出库里全部记忆的正文（已排序，顺序无关的比较用）。
 *
 * @param {MemoryStore} store 仓储
 * @returns {string[]} 正文数组（已排序）
 */
function texts(store) {
  return store
    .listMemories({ limit: 100 })
    .items.map((item) => String(item.text))
    .sort();
}

/**
 * 断言库里恰好是这些文本（两边都排序，避免依赖插入顺序）。
 *
 * @param {MemoryStore} store 仓储
 * @param {string[]} expected 期望文本
 * @returns {void}
 */
function assertTexts(store, expected) {
  assert.deepEqual(texts(store), [...expected].sort());
}

test('stageExtraction：抽到事实时**只创建批次、不写 memories**', async () => {
  const { store } = makeStore();
  const llm = factsLlm(['宝宝喜欢喝冰美式咖啡', '周末想去露营']);
  const result = await stageExtraction({
    store,
    llm,
    text: '今天聊了很多：咖啡和露营。',
    focused: true,
    model: 'qwen-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.count, 2);
  assert.deepEqual(result.facts, ['宝宝喜欢喝冰美式咖啡', '周末想去露营']);
  assert.equal(typeof result.batchId, 'string');

  assert.equal(store.countMemories(), 0, '抽取阶段绝不能写 memories');
  const batches = store.listBatches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, result.batchId);
  assert.equal(batches[0].state, 'open');
  assert.equal(batches[0].count, 2);
  assert.equal(batches[0].focused, true);
  assert.equal(batches[0].model, 'qwen-test');

  const batch = store.getBatch(result.batchId);
  assert.deepEqual(batch.items.map((item) => item.text), ['宝宝喜欢喝冰美式咖啡', '周末想去露营']);
  assert.deepEqual(batch.items.map((item) => item.state), ['pending', 'pending']);
  assert.deepEqual(batch.items.map((item) => item.idx), [0, 1]);
});

test('stageExtraction：一条都没抽到 → 失败，且**不建空批次**', async () => {
  const { store } = makeStore();
  const result = await stageExtraction({ store, llm: makeFakeLlm('[]'), text: '今天天气不错，哈哈哈。' });

  assert.equal(result.ok, false);
  assert.equal(result.batchId, null);
  assert.equal(result.count, 0);
  assert.deepEqual(result.facts, []);
  assert.match(result.error, /没抽出任何事实/);
  assert.equal(store.listBatches().length, 0);
  assert.equal(store.countMemories(), 0);
});

test('stageExtraction：模型抛错 → 失败，且不建批次', async () => {
  const { store } = makeStore();
  const llm = makeFakeLlm('', { throwError: new Error('网关 502') });
  const result = await stageExtraction({ store, llm, text: '有内容的文本' });

  assert.equal(result.ok, false);
  assert.equal(result.batchId, null);
  assert.match(result.error, /网关 502/);
  assert.equal(store.listBatches().length, 0);
});

test('stageExtraction：缺少 store 时失败而不抛错', async () => {
  const result = await stageExtraction({ llm: factsLlm(['甲']), text: '有内容的文本' });
  assert.equal(result.ok, false);
  assert.match(result.error, /store/);
});

test('reviewBatch：全量批准 → 事实入库、批次关闭、条目留痕', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({
    store,
    llm: factsLlm(['宝宝喜欢喝冰美式咖啡', '周末想去露营']),
    text: '原始对话',
  });

  const result = await reviewBatch({ store, batchId: staged.batchId });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.equal(store.countMemories(), 2);
  assertTexts(store, ['宝宝喜欢喝冰美式咖啡', '周末想去露营']);

  for (const memory of store.listMemories().items) {
    assert.equal(memory.source, '抽取审阅');
    assert.equal(memory.kind, 'extracted');
    assert.equal(memory.scope, 'default');
    assert.deepEqual(memory.meta, { batchId: staged.batchId });
  }

  const batch = store.getBatch(staged.batchId);
  assert.equal(batch.state, 'approved');
  assert.ok(batch.decidedAt.length > 0);
  for (const item of batch.items) {
    assert.equal(item.state, 'approved');
    assert.equal(typeof item.memoryId, 'string');
    assert.notEqual(store.getMemory(item.memoryId), null);
  }
  assert.deepEqual(
    batch.items.map((item) => item.memoryId).sort(),
    store.listMemories().items.map((memory) => memory.id).sort(),
  );
});

test('reviewBatch：keep 是 0-based 白名单，未选中的条目记 skipped 但仍在库里', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({
    store,
    llm: factsLlm(['甲事实', '乙事实', '丙事实']),
    text: '原始对话',
  });

  const result = await reviewBatch({ store, batchId: staged.batchId, keep: [0, 2] });

  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 1);
  assert.equal(store.countMemories(), 2);
  assertTexts(store, ['丙事实', '甲事实']);

  const batch = store.getBatch(staged.batchId);
  assert.equal(batch.state, 'approved');
  assert.deepEqual(batch.items.map((item) => item.state), ['approved', 'skipped', 'approved']);
  assert.equal(batch.items[1].memoryId, null);
});

test('reviewBatch：edits 生效（入库文本是改后的）', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({
    store,
    llm: factsLlm(['原始事实甲', '原始事实乙']),
    text: '原始对话',
  });

  const result = await reviewBatch({ store, batchId: staged.batchId, edits: { 1: '  改后的事实乙  ' } });

  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assertTexts(store, ['原始事实甲', '改后的事实乙']);
  assert.equal(store.getBatch(staged.batchId).items[1].editedText, '改后的事实乙');
  assert.equal(store.getBatch(staged.batchId).items[0].editedText, null, '没改的条目不写 editedText');
});

test('reviewBatch：edits 把文本改成空白 → 该条跳过', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({ store, llm: factsLlm(['甲事实', '乙事实']), text: '原始对话' });

  const result = await reviewBatch({ store, batchId: staged.batchId, edits: { 0: '   ' } });

  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assertTexts(store, ['乙事实']);
  assert.equal(store.getBatch(staged.batchId).items[0].state, 'skipped');
});

test('reviewBatch：scope 传给 addMemory', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({ store, llm: factsLlm(['甲事实']), text: '原始对话' });
  await reviewBatch({ store, batchId: staged.batchId, scope: 'life' });

  assert.equal(store.countMemories({ scope: 'life' }), 1);
  assert.equal(store.countMemories({ scope: 'default' }), 0);
});

test('reviewBatch：supersede → **只改写旧记录、不新增**，历史里留下 prev_text', async () => {
  const { store } = makeStore();
  const old = store.addMemory({ text: '服务端口是 8080' });
  const staged = await stageExtraction({ store, llm: factsLlm(['服务端口是 9090']), text: '端口改了' });

  const result = await reviewBatch({ store, batchId: staged.batchId, actions: { 0: { supersede: [old.id] } } });

  assert.equal(result.ok, true);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 0);
  assert.equal(store.countMemories(), 1, '改写不新增记忆');
  assert.equal(store.getMemory(old.id).text, '服务端口是 9090');
  assert.equal(store.getMemory(old.id).revision, 2);

  const history = store.listHistory(old.id);
  assert.equal(history.length, 2, 'add + supersede');
  assert.equal(history[0].op, 'supersede');
  assert.equal(history[0].prev_text, '服务端口是 8080');
  assert.equal(history[0].next_text, '服务端口是 9090');
  assert.equal(history[0].note, 'review:supersede');
  assert.equal(history[1].op, 'add');

  const batch = store.getBatch(staged.batchId);
  assert.equal(batch.state, 'approved');
  assert.equal(batch.items[0].state, 'superseded');
  assert.equal(batch.items[0].relation, 'supersede');
  assert.equal(batch.items[0].targetId, old.id);
  assert.equal(batch.items[0].memoryId, old.id);
});

test('reviewBatch：supersede 会作废旧向量，并回调 onUpdated 让调用方重排嵌入', async () => {
  const { store } = makeStore();
  const old = store.addMemory({ text: '服务端口是 8080' });
  // 两个空间各有一条旧向量：正文一改，两条都必须作废（否则语义检索一直用旧文本的名次）。
  store.putVector({ memoryId: old.id, space: 's1:m:2', model: 'm', dims: 2, vector: new Float32Array([1, 0]) });
  store.putVector({ memoryId: old.id, space: 's2:m:2', model: 'm', dims: 2, vector: new Float32Array([0, 1]) });
  assert.equal(store.vectorStats().count, 2);

  const staged = await stageExtraction({ store, llm: factsLlm(['服务端口是 9090']), text: '端口改了' });
  /** @type {string[]} */
  const updated = [];
  const result = await reviewBatch({
    store,
    batchId: staged.batchId,
    actions: { 0: { supersede: [old.id] } },
    onUpdated: (memoryId) => {
      updated.push(String(memoryId));
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.deepEqual(updated, [old.id], '删过向量的旧 id 必须回调 onUpdated');
  assert.equal(store.vectorStats().count, 0, '两个空间的向量都该作废');
  assert.equal(store.countMissingVectors('s1:m:2'), 1, '改完就回到「缺向量」，增量补齐能修它');
});

test('reviewBatch：supersede 多个旧 id → 逐个改写，仍不新增', async () => {
  const { store } = makeStore();
  const first = store.addMemory({ text: '旧记忆一：住北京' });
  const second = store.addMemory({ text: '旧记忆二：在北京上班' });
  const staged = await stageExtraction({ store, llm: factsLlm(['现在住上海了']), text: '搬家了' });

  const result = await reviewBatch({
    store,
    batchId: staged.batchId,
    actions: { 0: { supersede: [first.id, second.id] } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(store.countMemories(), 2);
  assert.equal(store.getMemory(first.id).text, '现在住上海了');
  assert.equal(store.getMemory(second.id).text, '现在住上海了');
  assert.equal(store.getBatch(staged.batchId).items[0].targetId, `${first.id},${second.id}`);
});

test('reviewBatch：duplicate:true → 跳过不新增（同批其它条目照常入库）', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({
    store,
    llm: factsLlm(['宝宝喜欢喝冰美式咖啡', '宝宝养了一只叫团子的猫']),
    text: '原始对话',
  });

  const result = await reviewBatch({ store, batchId: staged.batchId, actions: { 0: { duplicate: true } } });

  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assertTexts(store, ['宝宝养了一只叫团子的猫']);

  const batch = store.getBatch(staged.batchId);
  assert.equal(batch.items[0].state, 'skipped');
  assert.equal(batch.items[0].relation, 'duplicate');
  assert.equal(batch.items[0].memoryId, null);
  assert.equal(batch.items[1].state, 'approved');
});

test('reviewBatch：全部被跳过 → ok:false 且**批次未关闭**，改完还能再审', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({ store, llm: factsLlm(['唯一一条事实']), text: '原始对话' });

  const result = await reviewBatch({ store, batchId: staged.batchId, keep: [] });

  assert.equal(result.ok, false);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.error, '没有任何条目被写入（全被跳过）');
  assert.equal(store.countMemories(), 0);
  assert.equal(store.getBatch(staged.batchId).state, 'open', '批次必须保持 open');
  assert.equal(store.listBatches({ state: 'open' }).length, 1);

  // 还能再审：第二遍全量批准即可入库。
  const again = await reviewBatch({ store, batchId: staged.batchId });
  assert.equal(again.ok, true);
  assert.equal(again.added, 1);
  assert.equal(store.countMemories(), 1);
  assert.equal(store.getBatch(staged.batchId).state, 'approved');
});

test('reviewBatch：onAdded 对每个**新 id** 调用一次（异步回调会被等待）', async () => {
  const { store } = makeStore();
  const staged = await stageExtraction({
    store,
    llm: factsLlm(['甲事实', '乙事实', '丙事实']),
    text: '原始对话',
  });

  /** @type {string[]} */
  const seen = [];
  const result = await reviewBatch({
    store,
    batchId: staged.batchId,
    keep: [0, 1],
    actions: { 1: { duplicate: true } },
    onAdded: async (memoryId) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      seen.push(memoryId);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(seen.length, 1, '只有真正新增的条目才回调（跳过/重复/未选中都不调）');
  assert.deepEqual(seen, store.listMemories().items.map((memory) => memory.id));

  // 回调抛错不该把整批拖垮（记忆已经入库了）。
  const staged2 = await stageExtraction({ store, llm: factsLlm(['丁事实']), text: '原始对话' });
  const second = await reviewBatch({
    store,
    batchId: staged2.batchId,
    onAdded: () => {
      throw new Error('补向量失败');
    },
  });
  assert.equal(second.ok, true);
  assert.equal(second.added, 1);
  assert.equal(store.getBatch(staged2.batchId).state, 'approved');
});

test('reviewBatch：批次不存在 / 已关闭 / 缺参 → ok:false', async () => {
  const { store } = makeStore();

  const missing = await reviewBatch({ store, batchId: '不存在的批次' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /批次不存在/);
  assert.equal(missing.added, 0);

  assert.equal((await reviewBatch({ store })).ok, false);
  assert.equal((await reviewBatch({ batchId: 'x' })).ok, false);

  const staged = await stageExtraction({ store, llm: factsLlm(['甲事实']), text: '原始对话' });
  await reviewBatch({ store, batchId: staged.batchId });

  const closed = await reviewBatch({ store, batchId: staged.batchId });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /已关闭/);
  assert.equal(store.countMemories(), 1, '再审已关闭批次不该再写库');
});

test('rejectBatch：批次变 rejected，数据不删、记忆不动', async () => {
  const { store } = makeStore();
  store.addMemory({ text: '早已存在的记忆' });
  const staged = await stageExtraction({ store, llm: factsLlm(['甲事实', '乙事实']), text: '原始对话' });

  const result = await rejectBatch({ store, batchId: staged.batchId });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(store.getBatch(staged.batchId).state, 'rejected');
  assert.equal(store.listBatches({ state: 'rejected' }).length, 1);
  assert.equal(store.getBatch(staged.batchId).items.length, 2, '条目数据保留');
  assert.equal(store.countMemories(), 1, '记忆一条没动');
  assert.equal(store.listMemories().items[0].text, '早已存在的记忆');

  const again = await rejectBatch({ store, batchId: staged.batchId });
  assert.equal(again.ok, false);
  assert.match(again.error, /已关闭/);
});

test('rejectBatch：批次不存在 / 缺参 → ok:false', async () => {
  const { store } = makeStore();
  const missing = await rejectBatch({ store, batchId: '不存在的批次' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /批次不存在/);

  assert.equal((await rejectBatch({ store })).ok, false);
  assert.equal((await rejectBatch({ batchId: 'x' })).ok, false);
});
