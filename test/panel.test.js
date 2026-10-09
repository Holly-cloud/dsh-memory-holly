/**
 * panel.js 测试：`/api/dsh-memory/*` 精确路由的**结构性护栏**。
 *
 * 本文件守护两条「静默失效」，它们的共同点是**报错完全指不出真因**：
 *
 * 1. **漏写 `requestBody: 'buffered'`**（DESIGN §B）：`/api` 桥接层拿到的 bodyMode 是
 *    `undefined`，于是走流式分支、用 `method:'GET'` 构造带 body 的 Request，
 *    WHATWG 构造器抛错 → webserver 折成 **400 空响应**，浏览器只看到
 *    「HTTP 400：响应不是 JSON」。唯一能拦住它的就是「每条路由都必须声明」这条断言。
 * 2. **同一 path 注册两次**（DESIGN §B）：注册表按 pathname 建键，重复注册直接抛
 *    `already registered`，插件加载时整批路由挂掉。GET/POST 同路径必须合成一条
 *    `methods:['GET','POST']`（当前 `/backfill` 就是）。
 *
 * 全程不连真库、不联网、不写临时文件：service 是内存假对象。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryPanelRoutes, MEMORY_ROUTE_PREFIX } from '../src/host/panel.js';

/** 造 Request 用的哑 base（不参与任何网络行为）。 */
const BASE = 'http://127.0.0.1:19387';

/** 拼一条面板路由的完整路径。 */
const P = (suffix) => MEMORY_ROUTE_PREFIX + suffix;

/** 假密钥：它的出现即失败（安全红线：密钥绝不进响应）。 */
const SECRET = 'sk-SECRET-VALUE';

/** 500 字假记忆：用来验证列表接口的 300 字截断。 */
const LONG_TEXT = '长'.repeat(500);

/**
 * 造一个 GET 请求。
 *
 * @param {string} path 完整路径（含 query）。
 * @returns {Request} 请求。
 */
function getReq(path) {
  return new Request(BASE + path, { method: 'GET' });
}

/**
 * 造一个 POST 请求。
 *
 * @param {string} path 完整路径。
 * @param {unknown} body 请求体：字符串原样发（用来造坏 JSON），其余 `JSON.stringify`。
 * @returns {Request} 请求。
 */
function postReq(path, body) {
  return new Request(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * 读响应并把信封解析出来。
 *
 * @param {Response} res 响应。
 * @returns {Promise<{res: Response, text: string, payload: any}>} 文本与解析结果（解析失败时 `payload` 为 null）。
 */
async function readEnvelope(res) {
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { res, text, payload };
}

/**
 * 在路由表里按后缀找一条路由（找不到直接断言失败）。
 *
 * @param {object[]} routes 路由表。
 * @param {string} suffix 形如 `/search`。
 * @returns {any} 路由。
 */
function routeBySuffix(routes, suffix) {
  const path = P(suffix);
  const route = routes.find((item) => item.path === path);
  assert.ok(route, `路由表里没有 ${path}`);
  return route;
}

/**
 * 造一个内存假 MemoryService（`lib/index.js` 那个实例的接口子集，不碰数据库）。
 *
 * 所有调用都记在 `service.calls` 里，测试据此断言参数（例如 `/search` 的 limit 夹取）。
 *
 * @param {object} [overrides] 覆盖若干方法（用来造「handler 内部抛错」这类场景）。
 * @returns {any} 假 service。
 */
function makeFakeService(overrides = {}) {
  /** @type {Record<string, any[]>} */
  const calls = {
    search: [],
    listMemories: [],
    getMemory: [],
    addMemory: [],
    softDelete: [],
    deleteVector: [],
    credentials: [],
    backfill: [],
    extract: [],
    analyze: [],
    review: [],
  };

  const memoryRow = {
    id: 'm1',
    text: LONG_TEXT,
    source: '面板写入',
    section: null,
    kind: 'manual',
    scope: 'default',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    revision: 1,
  };

  const store = {
    listMemories(input) {
      calls.listMemories.push(input);
      return { total: 2, items: [{ ...memoryRow }, { ...memoryRow, id: 'm2', text: '短正文' }] };
    },
    getMemory(id) {
      calls.getMemory.push(id);
      return id === 'm1' ? { ...memoryRow } : null;
    },
    addMemory(input) {
      calls.addMemory.push(input);
      return { id: 'm-new', created: true };
    },
    softDeleteMemory(id, options) {
      calls.softDelete.push({ id, options });
      return id === 'm1';
    },
    deleteVector(id) {
      calls.deleteVector.push(id);
    },
    getBatch(id) {
      return id === 'b1' ? { id: 'b1', state: 'open', items: [] } : null;
    },
  };

  const service = {
    calls,
    dataDir: 'C:/fake/dsh-memory',
    ensureStore() {
      return store;
    },
    storeStats() {
      return {
        ok: true,
        memories: 2,
        scopes: [{ scope: 'default', count: 2 }],
        vectors: 1,
        spaces: [
          { key: 'openai:qwen3.7-text-embedding:1024', provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024, count: 1 },
        ],
        activeSpace: {
          key: 'openai:qwen3.7-text-embedding:1024',
          provider: 'openai',
          model: 'qwen3.7-text-embedding',
          dims: 1024,
          vectors: 1,
          missing: 1,
        },
        profile: 'config',
        migration: { migrated: false, reason: 'already-v2', rows: 0 },
        // 仓管现状：`/state` 直接透传这一块（面板的档案切换器靠它）
        keeper: {
          configured: true,
          active: 'config',
          profiles: [
            { name: 'config', provider: 'ollama', endpoint: 'http://<局域网 IP>:11434', model: 'qwen3:8b', apiKeyRef: null, configured: true, builtin: true, active: true },
          ],
        },
        embedQueued: 0,
        embedErrors: [],
        // 两个行为计数器的聚合 + 衰减参数（概览「记忆计分」那一行的数据源）
        scores: {
          decayFactor: 0.98,
          decayedAt: '2026-10-07T00:00:00.000Z',
          nextDecayAt: '2026-10-14T00:00:00.000Z',
          count: 2,
          totalRead: 6,
          totalTidy: 2,
          avgRead: 3,
          avgTidy: 1,
          topRead: [{ id: 'm1', preview: '甲', readScore: 5 }],
          topTidy: [],
        },
      };
    },
    profilesState() {
      return { profiles: [], active: null, error: null };
    },
    embeddingSpace() {
      return { key: 'openai:qwen3.7-text-embedding:1024', provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024 };
    },
    listEmbeddingProfiles() {
      calls.profiles = [...(calls.profiles ?? []), 'list'];
      return { ok: true, active: 'config', profiles: [] };
    },
    saveEmbeddingProfile(input) {
      calls.profiles = [...(calls.profiles ?? []), { save: input.name }];
      return { ok: true, name: input.name, space: { key: 'x', provider: 'openai', model: input.model, dims: 1024 }, vectors: 0, missing: 0 };
    },
    deleteEmbeddingProfile(name) {
      calls.profiles = [...(calls.profiles ?? []), { delete: name }];
      return { ok: true, removed: true, wasActive: false };
    },
    activateEmbeddingProfile(name) {
      calls.profiles = [...(calls.profiles ?? []), { activate: name }];
      return {
        ok: true,
        active: name,
        space: { key: 'openai:qwen3.7-text-embedding:1024', provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024 },
        vectors: 1,
        missing: 1,
      };
    },
    async testEmbedding(input) {
      calls.profiles = [...(calls.profiles ?? []), { test: input.name }];
      return { ok: true, profile: input.name ?? 'config', provider: 'openai', model: 'qwen3.7-text-embedding', dims: 1024, vectorLength: 1024 };
    },
    async llmProbe() {
      return { ok: true, provider: null, model: null, textLength: 2, text: '可用', elapsedMs: 12 };
    },
    saveKeeperConfig(patch) {
      calls.keeper = [...(calls.keeper ?? []), { config: patch }];
      return { ok: true, overrides: { provider: 'ollama' } };
    },
    keeperStatus() {
      return {
        ok: true,
        configured: true,
        active: 'config',
        profiles: [
          { name: 'config', provider: 'ollama', endpoint: 'http://<局域网 IP>:11434', model: 'qwen3:8b', apiKeyRef: null, configured: true, builtin: true, active: true },
        ],
        provider: 'ollama',
        endpoint: 'http://<局域网 IP>:11434',
        model: 'qwen3:8b',
        minChars: 240,
        digestMinChars: 120,
        splitChars: 400,
        dedupeThreshold: 0.86,
        probe: null,
        job: { running: false, mode: null, total: 0, done: 0, failed: 0, skipped: 0, derived: 0, merged: 0, losslessFallback: 0 },
        artifacts: { derived: 0, rewritten: 0, merged: 0, replaced: 0 },
      };
    },
    listKeeperProfiles() {
      calls.keeper = [...(calls.keeper ?? []), { profiles: 'list' }];
      return { ok: true, active: 'config', profiles: this.keeperStatus().profiles };
    },
    saveKeeperProfile(input) {
      calls.keeper = [...(calls.keeper ?? []), { save: input.name, input }];
      return { ok: true, name: input.name, profile: { name: input.name, provider: input.provider ?? null } };
    },
    deleteKeeperProfile(name) {
      calls.keeper = [...(calls.keeper ?? []), { delete: name }];
      return { ok: true, removed: true, wasActive: false, active: 'config' };
    },
    activateKeeperProfile(name) {
      calls.keeper = [...(calls.keeper ?? []), { activate: name }];
      return { ok: true, active: name, status: this.keeperStatus() };
    },
    setSideKeeper(model) {
      calls.keeper = [...(calls.keeper ?? []), { side: model }];
      return { ok: true, side: model == null || String(model).trim() === '' || String(model) === 'auto' ? null : String(model), status: this.keeperStatus() };
    },
    async startKeeperRun(input) {
      calls.keeper = [...(calls.keeper ?? []), { run: input }];
      return {
        ok: true,
        started: true,
        runId: 'run-1',
        planned: 2,
        keeper: { running: true, mode: 'run', total: 2, done: 0, failed: 0, skipped: 0, plans: 0, ops: 0, tail: [] },
      };
    },
    listKeeperPlans(input = {}) {
      calls.plans = [...(calls.plans ?? []), { list: input }];
      return {
        ok: true,
        plans: [
          {
            id: 'p1',
            runId: 'run-1',
            createdAt: '2026-10-07T00:00:00.000Z',
            state: 'open',
            seedId: 'm1',
            memberIds: ['m1', 'm2'],
            ops: [{ idx: 0, type: 'replace', targets: ['m1'], before: [{ id: 'm1', text: '旧' }], after: '新', reason: '', warnings: ['丢了 1 个数字：3.5'] }],
            warnings: ['#1 丢了 1 个数字：3.5'],
          },
        ],
      };
    },
    getKeeperPlan(id) {
      calls.plans = [...(calls.plans ?? []), { get: id }];
      if (String(id) !== 'p1') return { ok: false, error: `没有这张变更单：${id}` };
      return {
        ok: true,
        plan: {
          id: 'p1',
          runId: 'run-1',
          createdAt: '2026-10-07T00:00:00.000Z',
          state: 'open',
          seedId: 'm1',
          memberIds: ['m1', 'm2'],
          ops: [],
          warnings: [],
        },
      };
    },
    proposeKeeperReplace(input) {
      calls.proposals = [...(calls.proposals ?? []), input];
      if (String(input?.id ?? '') !== 'm1') return { ok: false, error: `没有这条记忆：${input?.id}` };
      if (String(input?.text ?? '').trim() === '') return { ok: false, error: '新正文不能为空' };
      return { ok: true, planId: 'plan-from-panel' };
    },
    listHandoffs(input = {}) {
      calls.handoffs = [...(calls.handoffs ?? []), { list: input }];
      return {
        ok: true,
        open: 1,
        handoffs: [
          {
            id: 'h1',
            runId: 'run-1',
            createdAt: '2026-10-07T00:00:00.000Z',
            updatedAt: '2026-10-07T00:00:00.000Z',
            state: 'open',
            seedId: 'm1',
            count: 2,
            members: [{ id: 'm1', text: '卡住的记忆正文' }],
            error: 'TimeoutError: 超时',
            attempts: 2,
            taker: null,
            planId: null,
          },
        ],
      };
    },
    async takeOverHandoff(input) {
      calls.handoffs = [...(calls.handoffs ?? []), { takeover: input }];
      if (String(input?.id ?? '') !== 'h1') return { ok: false, error: `没有这条副整理区记忆：${input?.id}` };
      return {
        ok: true,
        handoff: { id: 'h1', state: 'taken', taker: '宿主模型', planId: 'plan-from-takeover' },
        taker: '宿主模型',
        planId: 'plan-from-takeover',
        ops: 2,
      };
    },
    async handOffPlan(input) {
      calls.handoffs = [...(calls.handoffs ?? []), { plan: input }];
      if (String(input?.id ?? '') !== 'p1') return { ok: false, error: `没有这张变更单：${input?.id}` };
      return {
        ok: true,
        handoff: { id: 'h9', state: 'taken', taker: '宿主模型', planId: 'plan-from-redo' },
        taker: '宿主模型',
        planId: 'plan-from-redo',
        ops: 3,
        seeds: 2,
        recalled: 1,
      };
    },
    dropHandoff(input) {
      calls.handoffs = [...(calls.handoffs ?? []), { drop: input }];
      if (String(input?.id ?? '') !== 'h1') return { ok: false, error: `没有这条副整理区记忆：${input?.id}` };
      return { ok: true, handoff: { id: 'h1', state: 'dropped' } };
    },
    async reviewKeeperPlan(input) {
      calls.plans = [...(calls.plans ?? []), { review: input }];
      const rejected = input.reject === true;
      return {
        ok: true,
        applied: { replace: rejected ? 0 : 1, split: 0, merge: 0, drop: 0 },
        skipped: rejected ? 1 : 0,
        state: rejected ? 'rejected' : 'approved',
      };
    },
    async keeperTest(input = {}) {
      calls.keeper = [...(calls.keeper ?? []), { test: true, name: input?.name ?? null }];
      return { ok: true, profile: input?.name ?? 'config', provider: 'ollama', model: 'qwen3:8b', endpoint: 'http://<局域网 IP>:11434', elapsedMs: 42, text: '可用' };
    },
    revertKeeper() {
      return {
        ok: true,
        removedDerived: 3,
        restored: 2,
        revived: 1,
        removedReplaced: 1,
        restoredOriginal: 1,
        remaining: { derived: 0, rewritten: 0, merged: 0, replaced: 0 },
      };
    },
    backupNow(input) {
      calls.backup = [...(calls.backup ?? []), input];
      return {
        ok: true,
        dir: 'C:/fake/dsh-memory/备份/backup-1',
        dbBytes: 1024,
        pack: { dir: 'C:/fake/dsh-memory/备份/backup-1/pack', count: 2, bytes: 100 },
        pruned: [],
        memories: 2,
        vectors: 1,
      };
    },
    publicBackfill() {
      return { running: false, done: 0, total: 0, error: null };
    },
    resolvedConfig() {
      return {
        scope: 'default',
        embedding: {
          provider: 'openai',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen3.7-text-embedding',
          dimensions: 1024,
          apiKeyRef: 'DASHSCOPE_API_KEY',
        },
        search: { defaultLimit: 20, maxLimit: 50 },
        llm: { provider: null, model: null },
      };
    },
    searchText(input) {
      calls.search.push(input);
      return { ok: true, query: input.query, limit: input.limit, count: 0, items: [] };
    },
    pendingBatches() {
      return { ok: true, batches: [] };
    },
    scheduleEmbed(id) {
      calls.scheduleEmbed = [...(calls.scheduleEmbed ?? []), id];
    },
    async extractMemory(input) {
      calls.extract.push(input);
      return { ok: true, batchId: 'b-new', count: 0 };
    },
    async analyzeBatch(input) {
      calls.analyze.push(input);
      return { ok: true, batchId: input.batchId, items: [] };
    },
    async reviewPending(input) {
      calls.review.push(input);
      return { ok: true, batchId: input.batchId, applied: 0 };
    },
    async resolveKey(ref) {
      // 假密钥：真实现里它来自 `ctx.credentials`，形状一致。
      return { value: SECRET, source: 'file', ref };
    },
    async setCredential(ref, value) {
      calls.credentials.push({ ref, value });
    },
    async startBackfill(input) {
      calls.backfill.push(input);
      return { ok: true, started: true, backfill: { running: true, done: 0, total: 0 } };
    },
  };

  return Object.assign(service, overrides);
}

/**
 * 一张「每条路由的正常请求」表。
 *
 * 正常 = 假 service 会给 `ok:true` 的那条路径；`/backfill` 有两条（GET 看进度、POST 启动）。
 *
 * @returns {[string, () => Request][]} `[完整路径, 请求工厂]` 列表。
 */
function normalRequests() {
  return [
    [P('/state'), () => getReq(P('/state'))],
    [P('/search'), () => getReq(`${P('/search')}?q=%E5%92%96%E5%95%A1&limit=5`)],
    [P('/memories'), () => getReq(`${P('/memories')}?limit=10&offset=0`)],
    [P('/memory'), () => getReq(`${P('/memory')}?id=m1`)],
    [P('/remember'), () => postReq(P('/remember'), { text: '宝宝喜欢冰美式', source: '面板' })],
    [P('/forget'), () => postReq(P('/forget'), { id: 'm1' })],
    [P('/propose'), () => postReq(P('/propose'), { id: 'm1', text: '面板改写的正文。' })],
    // 「待办」页（抽取待审区）整页移除后，`/pending`、`/batch`、`/review` 三条路由一起删了 ——
    // 能力还在（`memory_pending` / `memory_analyze` / `memory_review` 三个工具），只是没有 HTTP 面了。
    [P('/extract'), () => postReq(P('/extract'), { text: '随便聊聊', focused: true })],
    [P('/analyze'), () => postReq(P('/analyze'), { batchId: 'b1', topK: 3 })],
    [P('/config'), () => getReq(P('/config'))],
    [P('/credential'), () => postReq(P('/credential'), { value: 'sk-new', ref: 'DASHSCOPE_API_KEY' })],
    [P('/profiles'), () => getReq(P('/profiles'))],
    [
      P('/profile'),
      () =>
        postReq(P('/profile'), {
          name: '局域网',
          provider: 'openai',
          baseUrl: 'http://<局域网 IP>:11434/v1',
          model: 'bge-m3',
          dimensions: 1024,
          apiKeyRef: 'LAN_KEY',
        }),
    ],
    [P('/profile-delete'), () => postReq(P('/profile-delete'), { name: '局域网' })],
    [P('/activate'), () => postReq(P('/activate'), { name: 'config', autoFill: false })],
    [P('/embed-test'), () => postReq(P('/embed-test'), { name: 'config' })],
    [P('/keeper'), () => getReq(P('/keeper'))],
    [P('/keeper'), () => postReq(P('/keeper'), { mode: 'grind', limit: 5 })],
    [P('/keeper-run'), () => postReq(P('/keeper-run'), { sample: 2, perGroup: 3, maxGroups: 1 })],
    [P('/keeper-plans'), () => getReq(P('/keeper-plans'))],
    [P('/keeper-plan'), () => getReq(`${P('/keeper-plan')}?id=p1`)],
    [P('/keeper-plan-review'), () => postReq(P('/keeper-plan-review'), { id: 'p1', keep: [0] })],
    [P('/handoffs'), () => getReq(P('/handoffs'))],
    [P('/handoff-takeover'), () => postReq(P('/handoff-takeover'), { id: 'h1' })],
    [P('/handoff-plan'), () => postReq(P('/handoff-plan'), { id: 'p1' })],
    [P('/handoff-drop'), () => postReq(P('/handoff-drop'), { id: 'h1' })],
    [P('/keeper-test'), () => postReq(P('/keeper-test'), { name: '线上' })],
    [P('/keeper-profiles'), () => getReq(P('/keeper-profiles'))],
    [
      P('/keeper-profile'),
      () =>
        postReq(P('/keeper-profile'), {
          name: '线上',
          provider: 'openai',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKeyRef: 'DASHSCOPE_API_KEY',
        }),
    ],
    [P('/keeper-profile-delete'), () => postReq(P('/keeper-profile-delete'), { name: '局域网-ollama' })],
    [P('/keeper-activate'), () => postReq(P('/keeper-activate'), { name: 'config' })],
    [P('/keeper-side'), () => postReq(P('/keeper-side'), { model: '线上' })],
    [P('/keeper-config'), () => postReq(P('/keeper-config'), { provider: 'ollama', ollamaUrl: 'http://<局域网 IP>:11434', model: 'qwen3:8b' })],
    [P('/keeper-revert'), () => postReq(P('/keeper-revert'), {})],
    [P('/backup'), () => postReq(P('/backup'), { keep: 3 })],
    [P('/llm-test'), () => postReq(P('/llm-test'), {})],
    [P('/backfill'), () => getReq(P('/backfill'))],
    [P('/backfill'), () => postReq(P('/backfill'), { batchSize: 16, limit: 0 })],
  ];
}

// ── 护栏 1：requestBody ──────────────────────────────────────────────────────

test('护栏：**每条路由都必须声明 requestBody:"buffered"**（漏了浏览器只会看到 HTTP 400）', () => {
  const routes = memoryPanelRoutes(makeFakeService());
  assert.ok(routes.length > 0, '路由表不该为空');

  for (const route of routes) {
    assert.equal(
      route.requestBody,
      'buffered',
      `${route.path} 漏了 requestBody: 'buffered' —— /api 桥接层会走流式分支、` +
        '用 GET 构造带 body 的 Request 而抛错，最终表现成「HTTP 400：响应不是 JSON」',
    );
  }

  // panel.js 的契约注释写着「33 条注册、覆盖 35 个端点」：数量变了就要同步这份注释。
  assert.equal(routes.length, 36, '路由条数与 panel.js 契约注释不一致');
});

// ── 护栏 2：path 唯一 / methods 合法 ─────────────────────────────────────────

test('护栏：所有 path 两两不同（重复注册会抛 already registered）', () => {
  const routes = memoryPanelRoutes(makeFakeService());
  const paths = routes.map((route) => route.path);

  assert.equal(new Set(paths).size, paths.length, `路由 path 有重复：${paths.join(', ')}`);
  for (const path of paths) {
    assert.ok(path.startsWith('/api/'), `${path} 不在 /api 之下，拿不到鉴权与信任栅栏`);
  }
});

test('护栏：/backfill 必须只注册一条路由，同时含 GET 与 POST', () => {
  const routes = memoryPanelRoutes(makeFakeService());
  const backfill = routes.filter((route) => route.path === P('/backfill'));

  assert.equal(backfill.length, 1, '/backfill 只能注册一条（同 path 注册两次会抛 already registered）');
  assert.deepEqual([...backfill[0].methods].sort(), ['GET', 'POST']);
});

test('护栏：每条路由的 methods 非空、无重复、只含大写方法名', () => {
  const routes = memoryPanelRoutes(makeFakeService());

  for (const route of routes) {
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `${route.path} 的 methods 为空`);
    assert.equal(new Set(route.methods).size, route.methods.length, `${route.path} 的 methods 有重复`);
    for (const method of route.methods) {
      assert.match(method, /^[A-Z]+$/, `${route.path} 的方法名不是大写：${method}`);
    }
  }
});

// ── 护栏 3：统一信封 ─────────────────────────────────────────────────────────

test('每条路由对正常请求都回 Response + status 200 + 含布尔 ok 的 JSON 信封', async () => {
  const service = makeFakeService();
  const routes = memoryPanelRoutes(service);
  /** @type {Set<string>} 被覆盖到的路由 path */
  const covered = new Set();

  for (const [path, makeRequest] of normalRequests()) {
    const route = routes.find((item) => item.path === path);
    assert.ok(route, `路由表里没有 ${path}`);

    const { res, payload } = await readEnvelope(await route.fetch(makeRequest()));
    const where = `${path} 正常请求`;

    assert.ok(res instanceof Response, `${where} 没返回 Response`);
    assert.equal(res.status, 200, `${where} 的状态码必须是 200（成败靠信封里的 ok）`);
    assert.ok(payload !== null, `${where} 的响应体不是 JSON`);
    assert.equal(typeof payload.ok, 'boolean', `${where} 的信封缺少布尔 ok`);
    assert.equal(payload.ok, true, `${where} 应当成功，实际：${JSON.stringify(payload).slice(0, 200)}`);
    covered.add(path);
  }

  for (const route of routes) {
    assert.ok(covered.has(route.path), `没有为 ${route.path} 准备正常请求，护栏漏了这条路由`);
  }
});

test('/state 透出 scope 分布（面板概览那一行小字的数据源）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/state');
  const payload = (await readEnvelope(await route.fetch(getReq(P('/state'))))).payload;
  assert.deepEqual(payload.scopes, [{ scope: 'default', count: 2 }], 'storeStats 的 scopes 必须原样进信封');
});

test('/state 透出 scores（概览「记忆计分」那一行的数据源）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/state');
  const payload = (await readEnvelope(await route.fetch(getReq(P('/state'))))).payload;

  assert.equal(payload.scores.decayFactor, 0.98);
  assert.equal(payload.scores.avgRead, 3);
  assert.equal(payload.scores.avgTidy, 1);
  assert.equal(payload.scores.topRead[0].id, 'm1');
  assert.equal(payload.scores.nextDecayAt, '2026-10-14T00:00:00.000Z', '下次衰减时间要能被面板直接格式化');
});

test('/state 透出仓管的 active 与 profiles（面板档案切换器的数据源）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/state');
  const payload = (await readEnvelope(await route.fetch(getReq(P('/state'))))).payload;

  assert.equal(payload.keeper.active, 'config');
  assert.equal(Array.isArray(payload.keeper.profiles), true);
  assert.equal(payload.keeper.profiles[0].builtin, true, '内置 config 档案要能被面板认出来');
});

test('/keeper-test 把可选 name 透传（不传 = 测当前生效档案，传了 = 只测那个档案）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper-test');

  const current = (await readEnvelope(await route.fetch(postReq(P('/keeper-test'), {})))).payload;
  assert.equal(current.ok, true);
  assert.equal(current.profile, 'config');

  const named = (await readEnvelope(await route.fetch(postReq(P('/keeper-test'), { name: '线上' })))).payload;
  assert.equal(named.ok, true);
  assert.equal(named.profile, '线上');

  const tests = service.calls.keeper.filter((entry) => entry.test === true);
  assert.deepEqual(
    tests.map((entry) => entry.name),
    [null, '线上'],
    '不传 name 要原样给 null（测当前生效档案），传了要带过去',
  );
});

test('/backfill 按 req.method 分派：GET 看进度、POST 启动', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/backfill');

  const state = (await readEnvelope(await route.fetch(getReq(P('/backfill'))))).payload;
  assert.equal(state.ok, true);
  assert.equal(state.started, undefined, 'GET 不该带 started');
  assert.equal(service.calls.backfill.length, 0, 'GET 不该启动回填');

  const started = (await readEnvelope(await route.fetch(postReq(P('/backfill'), { batchSize: 8 })))).payload;
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.equal(service.calls.backfill.length, 1);
  assert.deepEqual(service.calls.backfill[0], { batchSize: 8, limit: 0, mode: 'missing' });
});

// ── 仓管变更单（新范式：只出单，人审才落库） ──────────────────────────────────

test('/keeper-run 把 mode / sample / perGroup / maxGroups / taker 透传（省略 = 用配置默认）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper-run');

  const started = (await readEnvelope(await route.fetch(postReq(P('/keeper-run'), { mode: 'digest', sample: 3, perGroup: 2, maxGroups: 4, taker: '线上' })))).payload;
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.equal(started.runId, 'run-1', '启动结果必须带 runId（变更单靠它归组）');

  // 一个字段都不给：mode 回落 'grind'，其余走 null / 0，由宿主回落到 keeper.sampleSize / keeper.perGroup；
  // taker 省略 = 自动（接手模型由启动者决定，不给就交给自动顺序）。
  await route.fetch(postReq(P('/keeper-run'), {}));
  // 乱传的 mode 一律按 'grind'：它不是两种任务，只有显式 'digest' 才换成「偏重去重合并」。
  await route.fetch(postReq(P('/keeper-run'), { mode: '乱写' }));
  const runs = service.calls.keeper.filter((entry) => entry.run != null).map((entry) => entry.run);
  assert.deepEqual(runs, [
    { mode: 'digest', sample: 3, perGroup: 2, maxGroups: 4, taker: '线上' },
    { mode: 'grind', sample: null, perGroup: null, maxGroups: 0, taker: null },
    { mode: 'grind', sample: null, perGroup: null, maxGroups: 0, taker: null },
  ]);
});

test('/keeper POST 是 /keeper-run 的别名：mode 当提示词侧重透传，limit / redo 仍是死参数', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper');

  const payload = (await readEnvelope(await route.fetch(postReq(P('/keeper'), { mode: 'digest', limit: 5, redo: true })))).payload;
  assert.equal(payload.ok, true);
  assert.equal(payload.runId, 'run-1');
  // 老前端的 limit / redo 进不了宿主（死参数）；mode 只当提示词侧重 —— 出单阶段永远不改库。
  assert.deepEqual(service.calls.keeper.filter((entry) => entry.run != null).map((entry) => entry.run), [
    { mode: 'digest', sample: null, perGroup: null, maxGroups: 0, taker: null },
  ]);
});

test('/keeper-plans：state / limit 透传，列表原样回显（含 warnings）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper-plans');

  const plain = (await readEnvelope(await route.fetch(getReq(P('/keeper-plans'))))).payload;
  assert.equal(plain.ok, true);
  assert.equal(plain.plans.length, 1);
  assert.deepEqual(plain.plans[0].warnings, ['#1 丢了 1 个数字：3.5'], '单里的警告要拍平给面板');

  await route.fetch(getReq(`${P('/keeper-plans')}?state=open&limit=5`));
  await route.fetch(getReq(`${P('/keeper-plans')}?limit=0`));
  assert.deepEqual(service.calls.plans, [
    { list: { state: null, limit: null } },
    { list: { state: 'open', limit: 5 } },
    { list: { state: null, limit: null } },
  ]);
});

test('/keeper-plan：id 必填；找不到时如实报错', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper-plan');

  const missing = (await readEnvelope(await route.fetch(getReq(P('/keeper-plan'))))).payload;
  assert.equal(missing.ok, false);
  assert.match(missing.error, /缺少 id/);

  const found = (await readEnvelope(await route.fetch(getReq(`${P('/keeper-plan')}?id=p1`)))).payload;
  assert.equal(found.ok, true);
  assert.equal(found.plan.id, 'p1');

  const nope = (await readEnvelope(await route.fetch(getReq(`${P('/keeper-plan')}?id=p9`)))).payload;
  assert.equal(nope.ok, false);
  assert.match(nope.error, /没有这张变更单/);
});

test('/handoffs：默认只看 open，state 可显式给；列表原样回显（含成员预览）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/handoffs');

  const plain = (await readEnvelope(await route.fetch(getReq(P('/handoffs'))))).payload;
  assert.equal(plain.ok, true);
  assert.equal(plain.open, 1);
  assert.equal(plain.handoffs.length, 1);
  assert.equal(plain.handoffs[0].members[0].text, '卡住的记忆正文', '成员预览要带正文片段');

  // 空串与缺省一样按 open；显式给 state 就照传。
  await route.fetch(getReq(`${P('/handoffs')}?state=`));
  await route.fetch(getReq(`${P('/handoffs')}?state=taken`));
  assert.deepEqual(service.calls.handoffs, [
    { list: { state: 'open' } },
    { list: { state: 'open' } },
    { list: { state: 'taken' } },
  ]);
});

test('/handoff-takeover 与 /handoff-drop：id 必填；接手的产物原样回显', async () => {
  const service = makeFakeService();
  const routes = memoryPanelRoutes(service);
  const takeover = routeBySuffix(routes, '/handoff-takeover');
  const drop = routeBySuffix(routes, '/handoff-drop');

  const noId = (await readEnvelope(await takeover.fetch(postReq(P('/handoff-takeover'), {})))).payload;
  assert.equal(noId.ok, false);
  assert.match(noId.error, /缺少 id/);
  const noIdDrop = (await readEnvelope(await drop.fetch(postReq(P('/handoff-drop'), { id: '  ' })))).payload;
  assert.equal(noIdDrop.ok, false);
  assert.match(noIdDrop.error, /缺少 id/);
  assert.equal((service.calls.handoffs ?? []).length, 0, '缺 id 不该调到服务层');

  const taken = (await readEnvelope(await takeover.fetch(postReq(P('/handoff-takeover'), { id: 'h1', model: '线上' })))).payload;
  assert.equal(taken.ok, true);
  assert.equal(taken.handoff.state, 'taken');
  assert.equal(taken.planId, 'plan-from-takeover');
  assert.equal(taken.ops, 2);

  const dropped = (await readEnvelope(await drop.fetch(postReq(P('/handoff-drop'), { id: 'h1' })))).payload;
  assert.equal(dropped.handoff.state, 'dropped');
  assert.deepEqual(service.calls.handoffs, [
    { takeover: { id: 'h1', model: '线上' } },
    { drop: { id: 'h1' } },
  ]);
});

test('/handoff-plan：转手一张待审变更单（id 必填、reason 可省）；原单与新单都如实回显', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/handoff-plan');

  const noId = (await readEnvelope(await route.fetch(postReq(P('/handoff-plan'), {})))).payload;
  assert.equal(noId.ok, false);
  assert.match(noId.error, /缺少 id/);
  assert.equal((service.calls.handoffs ?? []).length, 0, '缺 id 不该调到服务层');

  const handed = (await readEnvelope(await route.fetch(postReq(P('/handoff-plan'), { id: 'p1' })))).payload;
  assert.equal(handed.ok, true);
  assert.equal(handed.handoff.state, 'taken');
  assert.equal(handed.planId, 'plan-from-redo');
  assert.equal(handed.ops, 3);
  assert.equal(handed.recalled, 1, '重头整理用 embedding 召回了几条：要透传给面板');

  // 空串 reason 归一成 null（面板不带理由时走默认那句），不把 '' 塞给服务层。
  await route.fetch(postReq(P('/handoff-plan'), { id: 'p1', reason: '' }));
  assert.equal((await readEnvelope(await route.fetch(postReq(P('/handoff-plan'), { id: 'nope' })))).payload.ok, false);
  assert.deepEqual(service.calls.handoffs, [
    { plan: { id: 'p1', reason: null } },
    { plan: { id: 'p1', reason: null } },
    { plan: { id: 'nope', reason: null } },
  ]);
});

test('/keeper-side：设定**副仓管**这个独立角色的模型（model 原样透传；空 / auto = 回落自动）', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper-side');

  const byProfile = (await readEnvelope(await route.fetch(postReq(P('/keeper-side'), { model: '线上' })))).payload;
  assert.equal(byProfile.ok, true);
  assert.equal(byProfile.side, '线上');

  // 缺 model / 显式 'auto' → 都是"删掉设定、回落自动顺序"，服务层收到 null。
  const auto = (await readEnvelope(await route.fetch(postReq(P('/keeper-side'), {})))).payload;
  assert.equal(auto.side, null);
  const explicitAuto = (await readEnvelope(await route.fetch(postReq(P('/keeper-side'), { model: 'auto' })))).payload;
  assert.equal(explicitAuto.side, null);

  assert.deepEqual(
    service.calls.keeper.filter((call) => 'side' in call).map((call) => call.side),
    ['线上', null, 'auto'],
  );
});

test('/keeper-plan-review：keep 只保留整数、reject 原样透传、缺 id 直接报错', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/keeper-plan-review');

  const empty = (await readEnvelope(await route.fetch(postReq(P('/keeper-plan-review'), {})))).payload;
  assert.equal(empty.ok, false);
  assert.match(empty.error, /缺少 id/);
  assert.equal((service.calls.plans ?? []).length, 0, '缺 id 不该调到服务层');

  const approved = (await readEnvelope(
    await route.fetch(postReq(P('/keeper-plan-review'), { id: 'p1', keep: [0, '2', 1.5, -1], edits: { 0: '改过的正文' } })),
  )).payload;
  assert.equal(approved.ok, true);
  assert.equal(approved.state, 'approved');

  const rejected = (await readEnvelope(
    await route.fetch(postReq(P('/keeper-plan-review'), { id: 'p1', reject: true, keep: [0] })),
  )).payload;
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.applied.replace, 0, '驳回不应用任何 op');

  assert.deepEqual(service.calls.plans, [
    // 面板这一层只做「是不是整数」的过滤（越界交给服务层，与 /review 同一套约定）
    { review: { id: 'p1', keep: [0, 2, -1], edits: { 0: '改过的正文' }, reject: false } },
    { review: { id: 'p1', keep: [0], edits: {}, reject: true } },
  ]);
});

// ── 护栏 4：异常一律收进信封 ─────────────────────────────────────────────────

test('POST 请求体是坏 JSON / 非对象 → ok:false 且**不抛**', async () => {
  const routes = memoryPanelRoutes(makeFakeService());
  const route = routeBySuffix(routes, '/remember');

  for (const raw of ['{这不是 JSON', '[1,2,3]', '"一个字符串"', '42', '', '   ']) {
    /** @type {Response | undefined} */
    let res;
    await assert.doesNotReject(async () => {
      res = await route.fetch(postReq(P('/remember'), raw));
    }, `坏请求体 ${JSON.stringify(raw)} 不该抛出`);

    const { payload } = await readEnvelope(/** @type {Response} */ (res));
    assert.equal(/** @type {Response} */ (res).status, 200);
    assert.equal(payload.ok, false, `坏请求体 ${JSON.stringify(raw)} 应当 ok:false`);
    assert.equal(typeof payload.error, 'string');
    assert.ok(payload.error.length > 0);
  }
});

test('handler 内部抛错（同步 / 异步）→ 也收进 ok:false，仍是 200', async () => {
  for (const searchText of [
    () => {
      throw new Error('索引炸了');
    },
    async () => {
      throw new Error('索引炸了');
    },
  ]) {
    const route = routeBySuffix(memoryPanelRoutes(makeFakeService({ searchText })), '/search');
    const { res, payload } = await readEnvelope(await route.fetch(getReq(`${P('/search')}?q=x`)));

    assert.equal(res.status, 200, '抛错也要 200（否则真因会被浏览器/框架的报错盖掉）');
    assert.equal(payload.ok, false);
    assert.match(payload.error, /索引炸了/);
  }
});

// ── /memories 截断 ───────────────────────────────────────────────────────────

test('/memories：正文截断到 300 字并带 truncated 标记，未超长的不截断', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/memories');

  const { payload } = await readEnvelope(await route.fetch(getReq(P('/memories'))));

  assert.equal(payload.ok, true);
  assert.equal(payload.total, 2);
  assert.equal(payload.count, 2);
  assert.equal(payload.offset, 0);
  assert.equal(payload.items.length, 2);

  const long = payload.items[0];
  assert.equal(long.id, 'm1');
  assert.equal(long.text.length, 300, '列表正文必须截断到 300 字');
  assert.equal(long.text, LONG_TEXT.slice(0, 300));
  assert.equal(long.truncated, true, '截断必须有标记，否则面板会照抄半句话');

  const short = payload.items[1];
  assert.equal(short.text, '短正文');
  assert.equal(short.truncated, false);

  // 列表页大小仍是分页参数（本用例只确认它被透传）。
  assert.equal(service.calls.listMemories.length, 1);
  assert.ok(service.calls.listMemories[0].limit > 0);
});

// ── /search limit 夹取 ──────────────────────────────────────────────────────

test('/search：limit 按 search.maxLimit 夹取，缺省用 search.defaultLimit', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/search');
  const call = async (query) => {
    const { payload } = await readEnvelope(await route.fetch(getReq(`${P('/search')}?${query}`)));
    assert.equal(payload.ok, true);
    return service.calls.search[service.calls.search.length - 1];
  };

  assert.equal((await call('q=%E5%92%96%E5%95%A1&limit=999')).limit, 50, '超过 maxLimit 要夹到 50');
  assert.equal((await call('q=x&limit=50')).limit, 50);
  assert.equal((await call('q=x&limit=7')).limit, 7);
  assert.equal((await call('q=x')).limit, 20, '缺省用 defaultLimit');
  assert.equal((await call('q=x&limit=abc')).limit, 20, '非法值回退默认');
  assert.equal((await call('q=x&limit=0')).limit, 1, '下限是 1');
  assert.equal((await call('q=x&limit=-5')).limit, 1);

  const first = await call('q=%E5%92%96%E5%95%A1&limit=5');
  assert.equal(first.query, '咖啡', 'query 原样透传（已解码）');
  assert.equal(first.scope, null, '面板是全局视图，scope 必须显式传 null');
});

// ── 安全红线：密钥绝不外泄 ───────────────────────────────────────────────────

test('安全红线：/config 与 /state 的响应文本里绝不出现密钥值，只回「配没配」', async () => {
  const service = makeFakeService(); // resolveKey 返回 {value: SECRET, source:'file'}
  const routes = memoryPanelRoutes(service);

  const config = await readEnvelope(await routeBySuffix(routes, '/config').fetch(getReq(P('/config'))));
  assert.ok(!config.text.includes(SECRET), '/config 把密钥值写进了响应');
  assert.equal(config.payload.ok, true);
  assert.equal(config.payload.keyStatus.configured, true);
  assert.equal(config.payload.keyStatus.source, 'file');
  assert.equal(config.payload.keyStatus.ref, 'DASHSCOPE_API_KEY');
  assert.equal(
    Object.hasOwn(config.payload.keyStatus, 'value'),
    false,
    '/config 的 keyStatus 里不该有 value 字段',
  );

  const state = await readEnvelope(await routeBySuffix(routes, '/state').fetch(getReq(P('/state'))));
  assert.ok(!state.text.includes(SECRET), '/state 把密钥值写进了响应');
  assert.equal(state.payload.ok, true);
  assert.equal(state.payload.memories, 2);
  assert.equal(state.payload.backfill.running, false);

  // 写密钥的那条也不能回显密钥。
  const credential = await readEnvelope(
    await routeBySuffix(routes, '/credential').fetch(postReq(P('/credential'), { value: SECRET })),
  );
  assert.ok(!credential.text.includes(SECRET), '/credential 回显了密钥');
  assert.equal(credential.payload.ok, true);
  assert.equal(credential.payload.ref, 'DASHSCOPE_API_KEY');
  assert.deepEqual(service.calls.credentials, [{ ref: 'DASHSCOPE_API_KEY', value: SECRET }]);
});

// ── /forget 信封 ─────────────────────────────────────────────────────────────

test('/forget 成功时信封含 id，失败时 ok:false 且带原因', async () => {
  const service = makeFakeService();
  const route = routeBySuffix(memoryPanelRoutes(service), '/forget');

  const done = await readEnvelope(await route.fetch(postReq(P('/forget'), { id: 'm1' })));
  assert.equal(done.res.status, 200);
  assert.equal(done.payload.ok, true);
  assert.equal(done.payload.id, 'm1', '成功后必须回 id，面板据此从列表里摘掉这一条');
  assert.deepEqual(service.calls.softDelete, [{ id: 'm1', options: { note: '面板删除' } }]);
  assert.deepEqual(service.calls.deleteVector, ['m1'], '软删同时删向量，避免幽灵命中');

  const missing = await readEnvelope(await route.fetch(postReq(P('/forget'), { id: 'nope' })));
  assert.equal(missing.payload.ok, false);
  assert.match(missing.payload.error, /nope/);

  const empty = await readEnvelope(await route.fetch(postReq(P('/forget'), {})));
  assert.equal(empty.payload.ok, false);
  assert.match(empty.payload.error, /缺少 id/);
});

// ── 精确匹配 ─────────────────────────────────────────────────────────────────

test('路由表是精确字符串匹配：未知路径不在表里，也没有前缀式条目', () => {
  const routes = memoryPanelRoutes(makeFakeService());
  const paths = routes.map((route) => route.path);

  for (const unknown of [
    '/api/dsh-memory',
    '/api/dsh-memory/',
    '/api/dsh-memory/nope',
    '/api/dsh-memory/search/',
    '/api/dsh-memory/search-extra',
    '/api/dsh-memory/../dsh-memory/state',
  ]) {
    assert.ok(!paths.includes(unknown), `未知路径不该出现在路由表里：${unknown}`);
  }

  // 已知路径必须**逐个**存在（表是构造出来的固定字符串，不做通配）。
  for (const suffix of [
    '/state',
    '/search',
    '/memories',
    '/memory',
    '/remember',
    '/forget',
    '/extract',
    '/analyze',
    '/config',
    '/credential',
    '/keeper-profiles',
    '/keeper-profile',
    '/keeper-profile-delete',
    '/keeper-activate',
    '/keeper-side',
    '/backfill',
  ]) {
    assert.ok(paths.includes(P(suffix)), `缺少路由 ${P(suffix)}`);
  }
});
