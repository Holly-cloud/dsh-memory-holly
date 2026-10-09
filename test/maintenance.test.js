/**
 * 维护类能力的服务层测试：一键备份（含库本体快照）、真删、强制全量重算、
 * LLM 预检、能力自描述，以及 `memory_backup` 工具的接线。
 *
 * 用假 ctx 直接构造 `MemoryService`：不起路由、不联网（嵌入用离线 `local-hash`）。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryService } from '../lib/index.js';
import { createEmbedder } from '../src/host/embed.js';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('maintenance');

/** 每个服务一个注销器：用完必须关库，否则 Windows 上删临时目录会 EPERM。 */
const closers = [];

after(() => {
  for (const close of closers.splice(0)) close();
  cleanupTmpDir(TMP);
});

/**
 * 最小可用 ctx：`effect` 立即执行并留下注销器；可选注入 `tools` / `llm`。
 *
 * @param {{llm?: object | null, withTools?: boolean}} [options] 注入项
 * @returns {{ctx: object, disposers: Function[], captured: object[]}} ctx 与探针
 */
function makeFakeCtx({ llm = null, withTools = false } = {}) {
  const disposers = [];
  /** @type {object[]} */
  const captured = [];
  const tools = {
    register: (definition) => {
      captured.push(definition);
      return () => {};
    },
    get: () => undefined,
    schemas: () => captured,
  };
  const ctx = {
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get(name) {
      if (name === 'tools' && withTools) return tools;
      if (name === 'llm' && llm !== null) return llm;
      return undefined;
    },
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  return { ctx, disposers };
}

let seq = 0;

/**
 * 造一个服务（可选注入 tools / llm / 额外配置）。
 *
 * @param {{llm?: object | null, withTools?: boolean, config?: object}} [options] 选项
 * @returns {{service: MemoryService, store: object, ctx: object, close: Function}} 组合
 */
function makeService({ llm = null, withTools = false, config = {} } = {}) {
  const { ctx, disposers } = makeFakeCtx({ llm, withTools });
  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`), ...config });
  const close = () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  closers.push(close);
  return { service, store: service.ensureStore(), ctx, close };
}

/** 一个离线嵌入档案。 */
const localProfile = (name, dims) => ({ name, provider: 'local-hash', model: 'local-test', localDims: dims });

/**
 * 等后台回填跑完。
 *
 * @param {MemoryService} service 服务
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} 结束状态
 */
async function waitBackfill(service, timeoutMs = 5000) {
  const startedAt = Date.now();
  for (;;) {
    const state = service.publicBackfill();
    if (state.running !== true) return state;
    if (Date.now() - startedAt > timeoutMs) throw new Error('回填超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('backupNow：库本体快照 + 文本包，且只保留最近 N 份', () => {
  const { service, store } = makeService();
  store.addMemory({ text: '备份里的第一条' });
  store.addMemory({ text: '备份里的第二条' });

  // 先造一个「很旧」的备份，验证保留策略会把它清掉。
  const root = join(service.dataDir, '备份');
  mkdirSync(join(root, 'backup-2000-01-01-000000'), { recursive: true });

  const result = service.backupNow({ keep: 1 });
  assert.equal(result.ok, true);
  assert.ok(existsSync(join(result.dir, 'memory.db')), '库本体快照要落盘');
  assert.ok(existsSync(join(result.dir, 'pack', 'memories.jsonl')), '文本包也要在');
  assert.equal(result.memories, 2);
  assert.deepEqual(result.pruned, ['backup-2000-01-01-000000'], '旧的被清掉了');
  assert.equal(result.pack.count, 2);

  // 快照是完整可读的 SQLite：读回来条数应该一致。
  const raw = readFileSync(join(result.dir, 'pack', 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(raw).count, 2);
});

test('memory_forget 工具：默认软删、hard=true 真删且 history 仍留痕', async () => {
  const { ctx, disposers } = makeFakeCtx({ withTools: true });
  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`) });
  closers.push(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const store = service.ensureStore();
  const soft = store.addMemory({ text: '这条走软删' });
  const hard = store.addMemory({ text: '这条走真删' });

  const tool = ctx.get('tools');
  const forget = tool.schemas().find((definition) => definition.name === 'memory_forget');
  assert.ok(forget, '应注册 memory_forget');

  const softResult = await forget.execute({ id: soft.id });
  assert.equal(softResult.softDeleted, true);
  assert.equal(store.getMemory(soft.id), null, '软删后默认查不到');
  assert.ok(store.getMemory(soft.id, { includeDeleted: true }) != null, '软删的行还在');
  assert.equal(store.listHistory(soft.id)[0].op, 'delete');

  const hardResult = await forget.execute({ id: hard.id, hard: true });
  assert.equal(hardResult.hardDeleted, true);
  assert.equal(hardResult.restorable, false);
  assert.equal(store.getMemory(hard.id, { includeDeleted: true }), null, '真删连行都没了');
  assert.equal(store.listHistory(hard.id)[0].op, 'hard_delete', 'history 仍留痕');
  await assert.rejects(() => forget.execute({ id: hard.id, hard: true }), /没有这条记忆/);
});

test('startBackfill：mode=all 强制全量重算，把被改坏的向量修回来', async () => {
  const { service, store } = makeService();
  const memory = store.addMemory({ text: '会被重算的一条' });
  store.addMemory({ text: '另一条' });
  service.saveEmbeddingProfile(localProfile('local8', 8));
  service.activateEmbeddingProfile('local8');
  await service.startBackfill({});
  await waitBackfill(service);

  const spaceKey = service.embeddingSpace().key;
  const expected = (await createEmbedder({ provider: 'local-hash', model: 'local-test', localDims: 8 }).embed(['会被重算的一条']))[0];
  assert.deepEqual([...store.getVector(memory.id, spaceKey).vector], [...expected]);

  // 把这条的向量改坏（模拟「向量不纯 / 和文本对不上」）。
  store.putVector({ memoryId: memory.id, space: spaceKey, provider: 'local-hash', model: 'local-test', dims: 8, vector: new Float32Array(8) });
  assert.notDeepEqual([...store.getVector(memory.id, spaceKey).vector], [...expected]);

  // 只补缺的 → 什么都不做（向量行在，所以它不算「缺」）。
  const missingRun = await service.startBackfill({});
  assert.equal(missingRun.started, false, 'mode=missing 看不到被改坏的向量');

  // 强制全量重算 → 全部重算一遍，坏向量被覆盖回正确值。
  const fullRun = await service.startBackfill({ mode: 'all' });
  assert.equal(fullRun.ok, true);
  assert.equal(fullRun.mode, 'all');
  assert.equal(fullRun.backfill.total, 2, '两条都要重算');
  const state = await waitBackfill(service);
  assert.equal(state.mode, 'all');
  assert.equal(state.done, 2);
  assert.deepEqual([...store.getVector(memory.id, spaceKey).vector], [...expected], '坏向量被修回来了');
});

test('llmProbe：有可用模型时回报文本与耗时，没有 llm 服务时如实报错', async () => {
  const llm = {
    async *stream() {
      yield { kind: 'reasoning-delta', text: '先想一想' };
      yield { kind: 'text-delta', text: '可用' };
      yield { kind: 'finish' };
    },
  };
  const okService = makeService({ llm, config: { llm: { provider: 'p', model: 'm' } } }).service;
  const ok = await okService.llmProbe({});
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '可用', '只该拿到 text-delta');
  assert.equal(ok.provider, 'p');
  assert.ok(Number.isFinite(ok.elapsedMs));

  const noLlm = makeService().service;
  const failed = await noLlm.llmProbe({});
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /llm/);
});

test('storeStats：带 scope 分布与能力自描述（一次调用就能知道怎么用它）', () => {
  const { service, store } = makeService();
  store.addMemory({ text: '默认 scope 的一条' });
  store.addMemory({ text: '工作 scope 的一条', scope: 'work' });

  const stats = service.storeStats();
  assert.equal(stats.ok, true);
  assert.deepEqual(
    stats.scopes,
    [
      { scope: 'default', count: 1 },
      { scope: 'work', count: 1 },
    ],
    'scope 分布按条数降序',
  );
  assert.equal(stats.capabilities.backup, true);
  assert.equal(stats.capabilities.hardDelete, true);
  assert.equal(stats.capabilities.multiSpace, true);
  assert.ok(stats.capabilities.search.maxLimit > 0);
  assert.ok(Array.isArray(stats.capabilities.backfillModes) && stats.capabilities.backfillModes.length === 2);
});

test('memory_backup 工具接线：真写出一份快照（库本体 + 文本包）', async () => {
  const { ctx, disposers } = makeFakeCtx({ withTools: true });
  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`) });
  closers.push(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const store = service.ensureStore();
  store.addMemory({ text: '要被备份的一条' });

  const definitions = ctx.get('tools').schemas();
  const backupTool = definitions.find((definition) => definition.name === 'memory_backup');
  assert.ok(backupTool, '应注册 memory_backup');
  assert.equal(
    definitions.some((definition) => definition.name === 'memory_palace'),
    false,
    '宫殿同步已退役：不该再注册 memory_palace',
  );

  const backup = await backupTool.execute({ keep: 2 });
  assert.equal(backup.ok, true);
  assert.ok(existsSync(join(backup.dir, 'memory.db')), '快照要落盘');
  assert.ok(existsSync(join(backup.dir, 'pack', 'manifest.json')), '文本包要在');
  assert.equal(backup.memories, 1);
});

// ── 两个行为计数器（read / tidy）与每周懒衰减 ─────────────────────────────────

test('memory_search / memory_get 工具：命中即 +1 read，其它条一分不动（tidy 不参与）', async () => {
  const { ctx, service, store } = makeService({ withTools: true });
  const hits = [
    store.addMemory({ text: '甲的记忆碎片一' }),
    store.addMemory({ text: '乙的记忆碎片二' }),
    store.addMemory({ text: '丙的记忆碎片三' }),
  ];
  const other = store.addMemory({ text: '完全无关的另一条内容' });

  const definitions = ctx.get('tools').schemas();
  const search = definitions.find((definition) => definition.name === 'memory_search');
  const get = definitions.find((definition) => definition.name === 'memory_get');
  assert.ok(search && get, '应注册 memory_search / memory_get');

  const result = await search.execute({ query: '记忆碎片' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3, '三条命中');
  const hitIds = new Set(result.items.map((row) => row.id));
  assert.equal(hitIds.size, 3);

  for (const row of store.listMemories({ limit: 20 }).items) {
    assert.equal(row.readScore, hitIds.has(row.id) ? 1 : 0, `read 只加在命中的 3 条上（${row.text}）`);
    assert.equal(row.tidyScore, 0, 'memory_search 不动 tidy');
  }
  assert.equal(store.getMemory(other.id).readScore, 0, '没命中的那条一分不动');

  // 再搜一次：命中的那 3 条再各 +1（不是只算一次）。
  await search.execute({ query: '记忆碎片' });
  for (const row of hits) assert.equal(store.getMemory(row.id).readScore, 2);
  assert.equal(store.getMemory(other.id).readScore, 0);

  // memory_get：只给它取的那一条 +1，返回值里的 readScore 是加过 1 的。
  const got = await get.execute({ id: other.id });
  assert.equal(got.readScore, 1);
  assert.equal(got.tidyScore, 0);
  assert.equal(store.getMemory(other.id).readScore, 1);
  assert.equal(store.getMemory(hits[0].id).readScore, 2, 'get 不该给别人加分');

  // 面板那条检索路径（searchText）**不加分**：列表 / 面板浏览不算「正常读取」。
  const panelSearch = await service.searchText({ query: '记忆碎片' });
  assert.equal(panelSearch.count, 3);
  for (const row of hits) assert.equal(store.getMemory(row.id).readScore, 2, 'searchText 直调不加分');
});

test('懒衰减：跨 2 周同乘 0.98²（比例不变）、不足一周不动、重复调用不二次衰减', () => {
  const { service, store } = makeService();
  const a = store.addMemory({ text: '衰减甲', readScore: 10, tidyScore: 4 });
  const b = store.addMemory({ text: '衰减乙', readScore: 5, tidyScore: 2 });
  const DAY = 24 * 60 * 60 * 1000;

  // 首次启用：只写起点时间戳，**不乘**（历史数据一分不减）。
  const first = service.maybeDecayScores();
  assert.equal(first.ok, true);
  assert.equal(first.initialized, true);
  assert.equal(first.decayed, false);
  assert.equal(store.getMemory(a.id).readScore, 10);
  assert.equal(store.getMemory(a.id).tidyScore, 4);
  const startIso = store.getSetting('score.decayedAt');
  assert.ok(Number.isFinite(Date.parse(String(startIso))), '起点必须是合法 ISO 时间');

  // 往前拨 14 天 = 2 个整周 → 同乘 0.98²。
  const sinceMs = Date.now() - 14 * DAY;
  store.setSetting('score.decayedAt', new Date(sinceMs).toISOString());
  const decayed = service.maybeDecayScores();
  assert.equal(decayed.decayed, true);
  assert.equal(decayed.weeks, 2);
  assert.ok(Math.abs(decayed.applied - 0.98 ** 2) < 1e-12);

  const expectedA = 10 * 0.98 ** 2;
  const expectedB = 5 * 0.98 ** 2;
  assert.ok(Math.abs(store.getMemory(a.id).readScore - expectedA) < 1e-9);
  assert.ok(Math.abs(store.getMemory(b.id).readScore - expectedB) < 1e-9);
  assert.ok(Math.abs(store.getMemory(a.id).tidyScore - 4 * 0.98 ** 2) < 1e-9);
  // 比例严格不变（全体同乘）：read 仍是 2、tidy 仍是 2。
  assert.ok(Math.abs(store.getMemory(a.id).readScore / store.getMemory(b.id).readScore - 2) < 1e-9, 'read 比例不变');
  assert.ok(Math.abs(store.getMemory(a.id).tidyScore / store.getMemory(b.id).tidyScore - 2) < 1e-9, 'tidy 比例不变');

  // 时间戳只推进**整周**（用 since + weeks*7d，不是 now）——余数不能被吃掉。
  assert.equal(store.getSetting('score.decayedAt'), new Date(sinceMs + 14 * DAY).toISOString());
  assert.equal(decayed.nextDecayAt, new Date(sinceMs + 21 * DAY).toISOString());

  // 幂等：紧接着再调一次不再乘。
  const again = service.maybeDecayScores();
  assert.equal(again.decayed, false);
  assert.equal(again.weeks, 0);
  assert.ok(Math.abs(store.getMemory(a.id).readScore - expectedA) < 1e-9, '重复调用不能二次衰减');

  // 不足一周（3 天）→ 一动不动。
  store.setSetting('score.decayedAt', new Date(Date.now() - 3 * DAY).toISOString());
  const none = service.maybeDecayScores();
  assert.equal(none.decayed, false);
  assert.equal(none.weeks, 0);
  assert.ok(Math.abs(store.getMemory(a.id).readScore - expectedA) < 1e-9);

  // 余数留着：距上次 10 天 → 只乘 1 周，时间戳只前进 7 天（剩下 3 天留到下次）。
  const tenDaysAgo = Date.now() - 10 * DAY;
  store.setSetting('score.decayedAt', new Date(tenDaysAgo).toISOString());
  const oneWeek = service.maybeDecayScores();
  assert.equal(oneWeek.weeks, 1);
  assert.ok(Math.abs(oneWeek.applied - 0.98) < 1e-12);
  assert.equal(store.getSetting('score.decayedAt'), new Date(tenDaysAgo + 7 * DAY).toISOString());
});

test('计分操作前会顺手懒衰减（先乘系数、再 +1），坏时间戳被重置而不是乱乘', () => {
  const { service, store } = makeService();
  const a = store.addMemory({ text: '接线甲', readScore: 10 });
  const DAY = 24 * 60 * 60 * 1000;

  service.maybeDecayScores(); // 先写起点
  store.setSetting('score.decayedAt', new Date(Date.now() - 14 * DAY).toISOString());
  assert.equal(service.recordReads([a.id]), 1);
  assert.ok(Math.abs(store.getMemory(a.id).readScore - (10 * 0.98 ** 2 + 1)) < 1e-9, '先衰减再 +1');

  // 坏时间戳：当作「刚启用」重置，绝不拿说不清的时刻去乘历史数据。
  store.setSetting('score.decayedAt', '不是时间');
  const before = store.getMemory(a.id).readScore;
  const recovered = service.maybeDecayScores();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.initialized, true);
  assert.equal(recovered.decayed, false);
  assert.match(String(recovered.note), /重置/);
  assert.equal(store.getMemory(a.id).readScore, before, '重置不当成到期');
});

test('storeStats.scores：聚合 + 衰减参数 + Top-N（40 字预览）', () => {
  const { service, store } = makeService();
  const hot = store.addMemory({ text: '被读了很多次的一条记忆', readScore: 7, tidyScore: 1 });
  store.addMemory({ text: '安安静静的另一条', readScore: 1 });

  service.maybeDecayScores(); // 让 decayedAt 有值
  const stats = service.storeStats();
  assert.equal(stats.ok, true);
  assert.equal(stats.scores.decayFactor, 0.98);
  assert.equal(typeof stats.scores.decayedAt, 'string');
  assert.equal(typeof stats.scores.nextDecayAt, 'string');
  assert.equal(stats.scores.totalRead, 8);
  assert.equal(stats.scores.totalTidy, 1);
  assert.equal(stats.scores.avgRead, 4);
  assert.equal(stats.scores.count, 2);
  assert.equal(stats.scores.topRead[0].id, hot.id);
  assert.equal(stats.scores.topRead[0].readScore, 7);
  assert.equal(stats.scores.topRead[0].preview, '被读了很多次的一条记忆');
  assert.equal(stats.scores.topTidy[0].id, hot.id);
  assert.equal(stats.capabilities.scores, true);
});
