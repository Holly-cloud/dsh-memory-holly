/**
 * 多向量空间 + 增量补齐：本设计最核心的那条需求的可执行版本。
 *
 * 需求原文：「每次切换需保留对应的向量避免每次都重算；切换回来后只需要检查记忆新旧差异然后补齐」。
 * 所以这里用**离线**的 `local-hash` 档案（不联网、确定性）走完整流程：
 *
 *   档案 A 补齐 → 切到档案 B 补齐 → 离开期间新增一条 → 切回 A **只补那一条** → 两个空间都还在
 *
 * 另外覆盖：档案落库/校验/删除（删档案不删向量）、检索只认当前空间、`testEmbedding` 自检。
 * 用假 ctx 直接构造 `MemoryService`：不起路由、不连网。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { MemoryService } from '../lib/index.js';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('spaces');

/** 每个服务一个注销器：用完必须关库，否则 Windows 上删临时目录会 EPERM。 */
const closers = [];

after(() => {
  for (const close of closers.splice(0)) close();
  cleanupTmpDir(TMP);
});

/**
 * 最小可用 ctx：`effect` 立即执行回调并留下注销器（关库靠它），其余服务一律「未挂载」。
 *
 * @returns {object} 假 ctx（带 `dispose()`）
 */
function makeFakeCtx() {
  const disposers = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get: () => undefined,
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  ctx.dispose = () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  return ctx;
}

let seq = 0;

/**
 * 造一个空库的服务。
 *
 * @returns {{ service: MemoryService, store: import('../src/host/store.js').MemoryStore }} 服务与仓储
 */
function makeService() {
  const ctx = makeFakeCtx();
  closers.push(() => ctx.dispose());
  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`) });
  return { service, store: service.ensureStore() };
}

/**
 * 等补齐跑完（回填是后台跑的，需要轮询）。
 *
 * @param {MemoryService} service 服务
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} 结束时的回填状态
 */
async function waitBackfill(service, timeoutMs = 5000) {
  const startedAt = Date.now();
  for (;;) {
    const state = service.publicBackfill();
    if (state.running !== true) return state;
    if (Date.now() - startedAt > timeoutMs) throw new Error('回填超时未结束');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 启动补齐并等它跑完。
 *
 * @param {MemoryService} service 服务
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} 结束时的回填状态
 */
async function fillAndWait(service, timeoutMs = 5000) {
  const result = await service.startBackfill({});
  assert.equal(result.ok, true, `补齐应能启动：${result.error ?? ''}`);
  return waitBackfill(service, timeoutMs);
}

/** 一个 local-hash 档案（离线、确定性，测试不联网）。 */
const localProfile = (name, dims) => ({ name, provider: 'local-hash', model: 'local-test', localDims: dims });

test('切换档案保留向量：切走不算、切回只补「离开期间新增的」', async () => {
  const { service, store } = makeService();
  const a = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  const b = store.addMemory({ text: '宝宝养了一只叫团子的猫' });
  store.addMemory({ text: '周末去露营' });

  // ── 档案 A（8 维）：全库都缺，补齐 3 条 ──────────────────────────────────────
  assert.equal(service.saveEmbeddingProfile(localProfile('local8', 8)).ok, true);
  const activA = service.activateEmbeddingProfile('local8');
  assert.equal(activA.ok, true);
  assert.equal(activA.space.key, 'local-hash:local-test:8');
  assert.equal(activA.vectors, 0);
  assert.equal(activA.missing, 3, '新空间里一条向量都没有');
  await fillAndWait(service);
  assert.equal(store.countVectors('local-hash:local-test:8'), 3);

  // ── 档案 B（16 维）：另一个空间，同样从头补齐 ────────────────────────────────
  assert.equal(service.saveEmbeddingProfile(localProfile('local16', 16)).ok, true);
  const activB = service.activateEmbeddingProfile('local16');
  assert.equal(activB.space.key, 'local-hash:local-test:16');
  assert.equal(activB.missing, 3);
  await fillAndWait(service);
  assert.equal(store.countVectors('local-hash:local-test:16'), 3);
  assert.equal(store.countVectors('local-hash:local-test:8'), 3, '切到 B 之后 A 的向量必须原样保留');

  // ── 在 B 上写入一条新记忆 ────────────────────────────────────────────────────
  store.addMemory({ text: '新记的一条：明天要下雨' });

  // ── 切回 A：只缺那一条，而且不缺那 3 条老的 ──────────────────────────────────
  const backToA = service.activateEmbeddingProfile('local8');
  assert.equal(backToA.vectors, 3, 'A 空间里原有 3 条仍在');
  assert.equal(backToA.missing, 1, '切回来只该补「离开期间新增的」那一条');
  const fillState = await fillAndWait(service);
  assert.equal(fillState.total, 1, '这次补齐的任务总量就是 1，绝不能重算 3 条');
  assert.equal(store.countVectors('local-hash:local-test:8'), 4);

  // ── 两个空间并存；档案列表各自记账 ──────────────────────────────────────────
  assert.equal(store.countVectors(), 7, 'A(4) + B(3) 都留在库里');
  const list = service.listEmbeddingProfiles();
  assert.equal(list.ok, true);
  assert.equal(list.active, 'local8');
  const profileA = list.profiles.find((item) => item.name === 'local8');
  const profileB = list.profiles.find((item) => item.name === 'local16');
  assert.equal(profileA.space.key, 'local-hash:local-test:8');
  assert.equal(profileA.vectors, 4);
  assert.equal(profileA.missing, 0, 'A 已补齐');
  assert.equal(profileB.vectors, 3);
  assert.equal(profileB.missing, 1, 'B 还缺后来新增的那条');

  // ── 已经齐了的空间再点补齐：什么都不做 ──────────────────────────────────────
  const again = await service.startBackfill({});
  assert.equal(again.ok, true);
  assert.equal(again.started, false);
  assert.equal(again.message, '这个空间里所有记忆都已有向量');
});

test('检索只用当前空间的向量；空间没向量时明确提示而非硬凑', async () => {
  const { service, store } = makeService();
  const a = store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  store.addMemory({ text: '宝宝养了一只叫团子的猫' });

  // 空间还没补齐：应该 vectorUsed=false 且给出提示。
  service.saveEmbeddingProfile(localProfile('local8', 8));
  service.activateEmbeddingProfile('local8');
  const beforeFill = await service.searchText({ query: '冰美式' });
  assert.equal(beforeFill.vectorUsed, false);
  assert.match(String(beforeFill.vectorError), /还没有向量/);
  assert.equal(beforeFill.activeSpace.key, 'local-hash:local-test:8');
  assert.equal(beforeFill.activeSpace.missing, 2);

  await fillAndWait(service);
  const afterFill = await service.searchText({ query: '冰美式' });
  assert.equal(afterFill.vectorUsed, true);
  assert.equal(afterFill.vectorError, null);
  assert.equal(afterFill.activeSpace.vectors, 2);
  assert.equal(afterFill.activeSpace.missing, 0);
  assert.equal(afterFill.items[0].id, a.id, 'local-hash 是确定性的，同文本必然命中最相关那条');
});

test('档案校验与删除：坏值不落库；删档案不删它的向量', async () => {
  const { service, store } = useSeededService();

  // 坏值直接拒绝，且不写进库。
  const bad = service.saveEmbeddingProfile({ name: 'bad', provider: 'zzz' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /embedding\.provider/);
  assert.equal(service.profilesState().profiles.some((item) => item.name === 'bad'), false);

  assert.equal(service.saveEmbeddingProfile({ name: '' }).ok, false);
  assert.equal(service.saveEmbeddingProfile({ name: 'config' }).ok, false, 'config 是 patch 配置的保留名');

  // 保存 → 切换 → 补齐 → 删档案：向量必须还在。
  assert.equal(service.saveEmbeddingProfile(localProfile('local8', 8)).ok, true);
  service.activateEmbeddingProfile('local8');
  await fillAndWait(service);
  assert.equal(store.countVectors('local-hash:local-test:8'), 2);

  const removed = service.deleteEmbeddingProfile('local8');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.wasActive, true);
  assert.equal(service.profilesState().active, 'config', '删掉生效档案后回落到 patch 配置');
  assert.equal(store.countVectors('local-hash:local-test:8'), 2, '删档案不删向量：空间还在');

  assert.equal(service.deleteEmbeddingProfile('config').ok, false, 'patch 配置不能删');
  assert.equal(service.activateEmbeddingProfile('不存在').ok, false);
});

test('testEmbedding：真打一次请求并核对维度（离线 local-hash 也能验）', async () => {
  const { service } = useSeededService();
  service.saveEmbeddingProfile(localProfile('local8', 8));

  const ok = await service.testEmbedding({ name: 'local8' });
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, 'local-hash');
  assert.equal(ok.dims, 8);
  assert.equal(ok.vectorLength, 8);
  assert.equal(ok.space, 'local-hash:local-test:8');

  const missing = await service.testEmbedding({ name: '没有这个档案' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这个档案/);

  // 默认（不传 name）= patch 配置那份：测试环境下没有密钥，应如实报错而不是假装成功。
  const fromConfig = await service.testEmbedding({});
  assert.equal(fromConfig.ok, false);
  assert.match(String(fromConfig.error), /没有可用的密钥|缺少密钥/);
});

/**
 * 造一个已经有两三条记忆的服务（档案类用例的公共起点）。
 *
 * @returns {{ service: MemoryService, store: import('../src/host/store.js').MemoryStore }} 服务与仓储
 */
function useSeededService() {
  const created = makeService();
  created.store.addMemory({ text: '宝宝喜欢喝冰美式咖啡' });
  created.store.addMemory({ text: '宝宝养了一只叫团子的猫' });
  return created;
}

test('memory_embedding 工具：list / activate(autoFill) / test / 坏 action', async () => {
  // 抓住注册进去的工具定义（假 ctx 只提供 tools 服务）。
  const captured = [];
  const ctx = makeFakeCtx();
  const tools = {
    register: (definition) => {
      captured.push(definition);
      return () => {};
    },
    get: () => undefined,
    schemas: () => captured,
  };
  ctx.get = (name) => (name === 'tools' ? tools : undefined);
  closers.push(() => ctx.dispose());

  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`) });
  const store = service.ensureStore();
  store.addMemory({ text: '宝宝喜欢喝冰美式' });
  store.addMemory({ text: '宝宝养了一只叫团子的猫' });

  const tool = captured.find((definition) => definition.name === 'memory_embedding');
  assert.ok(tool, '应注册 memory_embedding 工具');

  const listed = await tool.execute({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.active, 'config');

  service.saveEmbeddingProfile(localProfile('local8', 8));
  const activated = await tool.execute({ action: 'activate', name: 'local8', autoFill: true });
  assert.equal(activated.ok, true);
  assert.equal(activated.space.key, 'local-hash:local-test:8');
  assert.equal(activated.missing, 2);
  await waitBackfill(service);
  assert.equal(store.countVectors('local-hash:local-test:8'), 2);

  const tested = await tool.execute({ action: 'test', name: 'local8' });
  assert.equal(tested.ok, true);
  assert.equal(tested.vectorLength, 8);

  const bad = await tool.execute({ action: '乱写' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /action 只能是/);
});
