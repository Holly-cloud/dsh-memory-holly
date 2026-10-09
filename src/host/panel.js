/**
 * dsh-memory · Phase 4 —— 宿主侧「面板接口」（`/api/dsh-memory/*` 精确路由）。
 *
 * ## 为什么是这个形状（每一条都有代价）
 *
 * 1. **必须经 `ctx.connection.fetch.register`**：这些路由落在 `/api` 之下，由 `/api` 前缀
 *    处理器统一做 Host/Origin 栅栏与 Cookie 鉴权。绝不能改用 `ctx.webServer.register`
 *    注册 `/api/**` 的 exact 路由 —— webserver 先查 exact 表，那样会**绕过鉴权**（DESIGN §B）。
 *
 * 2. **每条路由都必须带 `requestBody: 'buffered'`**：上游 `assertFetchRoute` 只校验 path 与
 *    methods，漏写时桥接层拿到的 bodyMode 是 `undefined`，于是走流式分支，用 `method:'GET'`
 *    构造带 body 的 Request，WHATWG 构造器直接抛错，webserver 把 handler 抛错统一折成
 *    **400 空响应** —— 浏览器侧只看到「HTTP 400：响应不是 JSON」，完全看不出真因。
 *
 * 3. **handler 一律自己 try/catch 并把异常收进 JSON**：同 2，抛出去就是 400 空响应。
 *
 * 4. **HTTP 状态码一律 200**，成败由信封里的 `ok` 表达。面板据此把错误文本原样显示出来，
 *    而不是靠浏览器/框架的通用报错（那样信息更少）。
 *
 * 5. **路径匹配是对表精确字符串相等**：`ctx.connection.fetch.register` 的 exact 路由表按键
 *    精确查找，所以这里只产出固定字符串，不做任何通配或正则。
 *
 * 6. **同一个路径只能注册一次**。宿主注册表是按 pathname 建键的
 *    （`fetchRoutes.get(url.pathname)`），重复注册会直接抛
 *    `connection: exact Fetch route "…" is already registered`。
 *    因此本模块产出的 `path` **两两不同**：`/backfill` 的 GET 与 POST 合并成一条
 *    `methods: ['GET','POST']` 的路由，在 handler 里按 `req.method` 分派。
 *
 * @module dsh-memory/host/panel
 */

/**
 * 面板接口前缀。
 *
 * 导出它是为了给 `lib/index.js` 接线用（宿主模块与面板共用同一个常量，避免两处漂移）。
 * 它**必须**以 `/api/` 开头，否则拿不到鉴权与信任栅栏。
 */
export const MEMORY_ROUTE_PREFIX = '/api/dsh-memory';

/** 统一响应头：JSON + 禁止缓存（面板每次都要看真实状态）。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** 列表接口里正文的截断长度（全文走 `/memory` 单条接口）。 */
const LIST_TEXT_LIMIT = 300;

/** 列表接口默认 / 上限页大小。 */
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/** 「最近入库」块（搜索页）默认条数 = 10；上限给 50 就够，别让人把它当第二个分页列表用。 */
const RECENT_LIMIT_DEFAULT = 10;
const RECENT_LIMIT_MAX = 50;

/**
 * 造一个 JSON 响应。
 *
 * **状态码固定 200**：面板用 `ok` 判断成败；非 200 只会让浏览器/框架先报一层自己的错，
 * 把真正的原因（宿主异常文本）盖掉。
 *
 * @param {unknown} value 可 JSON 化的值。
 * @returns {Response} WHATWG 响应。
 */
function json(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: JSON_HEADERS });
}

/**
 * 把异常压成一行可读文本（与 `lib/index.js` 的 `describeError` 保持同形，面板直接显示）。
 *
 * @param {unknown} error 捕获到的异常。
 * @returns {string} 形如 `TypeError: xxx` 的文本。
 */
function describeError(error) {
  const name = String(error?.name ?? 'Error');
  const message = String(error?.message ?? error);
  return `${name}: ${message}`;
}

/**
 * 从请求 URL 取 query 参数。
 *
 * 用固定 base 解析：`req.url` 在 `/api` 桥接下可能是相对路径（`/api/dsh-memory/x?y=1`），
 * 给一个 dummy base 才能稳定解析；这个 base 不参与任何网络行为。
 *
 * @param {Request} req 请求。
 * @returns {URLSearchParams} 查询参数。
 */
function queryOf(req) {
  return new URL(req.url ?? '/', 'http://dsh.internal').searchParams;
}

/**
 * 读一个整数 query 参数（缺失 / 非法一律回退默认值，绝不抛）。
 *
 * @param {URLSearchParams} params 查询参数。
 * @param {string} key 键名。
 * @param {number} fallback 默认值。
 * @param {{min?: number, max?: number}} [bounds] 闭区间夹取范围。
 * @returns {number} 整数。
 */
function intParam(params, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * 把一条 store 行整形为面板用的记忆对象（**全文**，不截断）。
 *
 * 只挑面板需要的字段：`meta` 之类不进面板，避免把无关内容带到 DOM。
 *
 * @param {Record<string, unknown>} row `store.getMemory` 返回的行。
 * @returns {object} 面板记忆对象。
 */
function shapeMemory(row) {
  return {
    id: String(row.id ?? ''),
    text: String(row.text ?? ''),
    source: row.source ?? null,
    section: row.section ?? null,
    kind: row.kind ?? null,
    scope: row.scope ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    deletedAt: row.deleted_at ?? null,
    revision: row.revision ?? null,
  };
}

/**
 * 把一条 store 行整形为**列表条目**（正文截断到 `LIST_TEXT_LIMIT`）。
 *
 * `/memories`（分页浏览）与 `/recent`（最近入库）共用这一个整形器：
 * 列表里可能有几千条，全文只在展开时单独取，所以两处的截断口径必须完全一致。
 *
 * @param {Record<string, unknown>} row store 行。
 * @returns {object} 列表条目。
 */
function shapeListItem(row) {
  const text = String(row.text ?? '');
  return {
    id: String(row.id ?? ''),
    text: text.length > LIST_TEXT_LIMIT ? text.slice(0, LIST_TEXT_LIMIT) : text,
    truncated: text.length > LIST_TEXT_LIMIT,
    source: row.source ?? null,
    section: row.section ?? null,
    kind: row.kind ?? null,
    createdAt: row.created_at ?? null,
  };
}

/**
 * 校验「必须是 JSON 对象」的请求体。
 *
 * @param {unknown} value 解析结果。
 * @returns {boolean} 是否是普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 产出面板要用的 `/api` 精确路由。
 *
 * 调用方（`lib/index.js`）负责把它们逐条交给 `ctx.connection.fetch.register`，
 * 并在 `ctx.effect` 里收集注销器。**每条只注册一次**（`path` 两两不同，见文件头第 6 条）。
 *
 * @param {object} service 宿主侧 MemoryService（`lib/index.js` 里那个实例）。
 * @returns {{path: string, methods: string[], requestBody: 'buffered', fetch: (req: Request) => Promise<Response>}[]}
 *   路由描述数组（37 条注册、覆盖 39 个端点），顺序即注册顺序。
 */
export function memoryPanelRoutes(service) {
  /** 取仓储（惰性开库，幂等）。 */
  const store = () => service.ensureStore();

  // ── 概览 ─────────────────────────────────────────────────────────────────────

  /**
   * GET `/state` —— 概览五项指标 + 回填进度。
   *
   * @returns {Promise<object>} 信封。
   */
  async function stateRoute() {
    const stats = service.storeStats();
    // storeStats 自己就是信封（打不开库时给 {ok:false,error}），直接透传，别包成 ok:true。
    if (stats.ok !== true) return stats;
    return {
      ok: true,
      memories: Number(stats.memories ?? 0),
      // 按 scope 分组的条数（写入按 config.scope，检索是全局的）——面板概览拿它画一行小字
      scopes: Array.isArray(stats.scopes) ? stats.scopes : [],
      vectors: Number(stats.vectors ?? 0),
      // 已保留的向量空间（每个空间一套：换模型不会覆盖旧的）
      spaces: Array.isArray(stats.spaces) ? stats.spaces : [],
      // 当前配置对应的空间：`vectors` 已有、`missing` 还缺多少
      activeSpace: stats.activeSpace ?? null,
      profile: stats.profile ?? null,
      migration: stats.migration ?? null,
      // 仓管现状：`active` 是生效档案名、`profiles` 是全部档案（面板据此渲染切换器）
      keeper: stats.keeper ?? null,
      // 跟随 agent 运行的自主捕获现状（开关 / 模式 / 最近几次捕获 / 错误）
      capture: stats.capture ?? null,
      // 两个行为计数器的聚合 + 每周衰减参数（概览「记忆计分」那一行读它）
      scores: stats.scores ?? null,
      embedQueued: Number(stats.embedQueued ?? 0),
      embedErrors: Array.isArray(stats.embedErrors) ? stats.embedErrors : [],
      backfill: service.publicBackfill(),
    };
  }

  // ── 检索与记忆 ───────────────────────────────────────────────────────────────

  /**
   * GET `/search` —— 混合检索，结果**原样**回给面板（含 vectorUsed / vectorError / tookMs）。
   *
   * @param {URLSearchParams} params 查询参数。
   * @returns {Promise<object>} `searchText` 的信封。
   */
  async function searchRoute(params) {
    const cfg = service.resolvedConfig();
    const limit = intParam(params, 'limit', cfg.search.defaultLimit, { min: 1, max: cfg.search.maxLimit });
    // scope 传 null：面板是全局视图，要能看到导入进来的其它 scope 的旧记忆。
    return service.searchText({ query: params.get('q') ?? '', limit, scope: null });
  }

  /**
   * GET `/memories` —— 分页列表，正文**截断到 300 字**并标记 `truncated`。
   *
   * @param {URLSearchParams} params 查询参数。
   * @returns {Promise<object>} 信封。
   */
  async function listRoute(params) {
    const limit = intParam(params, 'limit', LIST_LIMIT_DEFAULT, { min: 1, max: LIST_LIMIT_MAX });
    const offset = intParam(params, 'offset', 0, { min: 0 });
    const page = store().listMemories({ limit, offset });
    const rows = Array.isArray(page?.items) ? page.items : [];
    const items = rows.map(shapeListItem);
    return {
      ok: true,
      total: Number(page?.total ?? 0),
      offset,
      count: items.length,
      items,
    };
  }

  /**
   * GET `/recent` —— **最近入库**（搜索页那一块）：最近被记录进库的若干条记忆。
   *
   * 口径（与 `/memories` 完全同源，只是去掉分页、固定条数）：
   * - 排序用 `created_at DESC`（`listMemories` 的既定顺序），也就是**入库时刻**；
   * - ⚠️ 导入进来的旧记忆，`created_at` 是**导入那一刻**、不是正文写下的时刻 ——
   *   面板就按「最近被记进库里」呈现，这个口径是真的，别把它读成"最近发生的事"。
   * - 只读、不分页、不写任何状态。
   *
   * @param {URLSearchParams} params 查询参数（`limit`）。
   * @returns {Promise<object>} 信封。
   */
  async function recentRoute(params) {
    const limit = intParam(params, 'limit', RECENT_LIMIT_DEFAULT, { min: 1, max: RECENT_LIMIT_MAX });
    const page = store().listMemories({ limit, offset: 0 });
    const rows = Array.isArray(page?.items) ? page.items : [];
    const items = rows.map(shapeListItem);
    return { ok: true, limit, count: items.length, items };
  }

  /**
   * GET `/memory` —— 单条**全文**。
   *
   * @param {URLSearchParams} params 查询参数（`id`）。
   * @returns {Promise<object>} 信封。
   */
  async function memoryRoute(params) {
    const id = params.get('id') ?? '';
    if (id === '') return { ok: false, error: '缺少 id' };
    const row = store().getMemory(id);
    if (row === null) return { ok: false, error: `没有这条记忆：${id}` };
    return { ok: true, memory: shapeMemory(row) };
  }

  /**
   * POST `/remember` —— 原文直存，然后**排队补向量**。
   *
   * 为什么必须 scheduleEmbed：没有向量的记忆只能靠关键词命中，而关键词对 2 字中文词是
   * 一律漏的（DESIGN §D），结果就是「写进去搜不到」。
   *
   * @param {object} body 请求体 `{text, source?}`。
   * @returns {Promise<object>} 信封 `{ok, id, created}`。
   */
  async function rememberRoute(body) {
    const text = String(body.text ?? '').trim();
    if (text === '') return { ok: false, error: '内容为空' };
    const result = store().addMemory({
      text,
      scope: service.resolvedConfig().scope,
      source: body.source == null ? '面板写入' : String(body.source),
      kind: 'manual',
      meta: { writtenAt: new Date().toISOString() },
    });
    service.scheduleEmbed(result.id);
    return { ok: true, id: result.id, created: result.created === true };
  }

  /**
   * POST `/forget` —— 软删（默认，保留行与历史、可恢复）；`hard: true` 时真删行（不可恢复）。
   *
   * 两种都同时删掉它的向量：文本是本体、向量是派生物，留下旧向量会让检索里出现
   * 「有 id 没正文」的幽灵命中（`getMemory` 已过滤软删，映射出来就是 `text: null`）。
   *
   * @param {object} body 请求体 `{id, hard?}`。
   * @returns {Promise<object>} 信封。
   */
  async function forgetRoute(body) {
    const id = String(body.id ?? '');
    if (id === '') return { ok: false, error: '缺少 id' };
    if (body.hard === true) {
      const removed = store().hardDeleteMemory(id, { note: '面板彻底删除' });
      if (!removed) return { ok: false, error: `没有这条记忆或已删除：${id}` };
      return { ok: true, id, hardDeleted: true, restorable: false };
    }
    const done = store().softDeleteMemory(id, { note: '面板删除' });
    if (!done) return { ok: false, error: `没有这条记忆或已删除：${id}` };
    try {
      store().deleteVector(id);
    } catch {
      /* 向量删除失败不影响软删结果：它只是派生物，下次重建索引会自然清掉 */
    }
    return { ok: true, id, softDeleted: true, restorable: true };
  }

  // ── 待审门 ───────────────────────────────────────────────────────────────────

  /**
   * POST `/propose` —— 面板里**手工改写一条记忆**：建一张单 op 的 `replace` 变更单，**只出单、不落库**。
   *
   * 与工具 `memory_keeper {action:'propose'}` 走**同一个** service 方法 —— 面板不给自己开第二条
   * 改库路径（口径：改库只有 `reviewKeeperPlan` 一个入口）。用户在搜索页改完的正文先落进待审区，
   * 过审后才「删旧录新」。
   *
   * @param {object} body 请求体 `{id, text, reason?}`。
   * @returns {Promise<object>} 信封 `{ok, planId}`。
   */
  async function proposeRoute(body) {
    if (typeof service.proposeKeeperReplace !== 'function') return { ok: false, error: '该能力待接线' };
    return service.proposeKeeperReplace({
      id: String(body.id ?? ''),
      text: body.text == null ? '' : String(body.text),
      reason:
        body.reason == null || String(body.reason) === '' ? '面板手工改写' : String(body.reason),
    });
  }

  /**
   * POST `/extract` —— 抽取式写入（只落待审区，入库要再过 `reviewPending`）。
   *
   * `excludeTransient` 默认 true（与自主捕获同一道确定性三分类：transient 丢、uncertain 照常进待审区）；
   * 面板不传 = 走默认，老客户端也不受影响。
   *
   * @param {object} body 请求体 `{text, focused?, excludeTransient?}`。
   * @returns {Promise<object>} `extractMemory` 的信封。
   */
  async function extractRoute(body) {
    const text = String(body.text ?? '');
    if (text.trim() === '') return { ok: false, error: '内容为空' };
    return service.extractMemory({
      text,
      focused: body.focused === true,
      excludeTransient: body.excludeTransient !== false,
    });
  }

  /**
   * POST `/analyze` —— 逐条查冲突（每条与库里相似的记忆判关系）。
   *
   * @param {object} body 请求体 `{batchId, topK?}`。
   * @returns {Promise<object>} `analyzeBatch` 的信封。
   */
  async function analyzeRoute(body) {
    const batchId = String(body.batchId ?? '');
    if (batchId === '') return { ok: false, error: '缺少 batchId' };
    const topK = Number.isFinite(Number(body.topK)) && Number(body.topK) > 0 ? Math.trunc(Number(body.topK)) : 3;
    return service.analyzeBatch({ batchId, topK });
  }

  // ── 配置与密钥 ───────────────────────────────────────────────────────────────

  /**
   * GET `/config` —— 只读配置 + 密钥「有没有配」的状态。
   *
   * **安全红线**：`service.resolveKey()` 返回的 `value` 就是密钥本身，
   * 这里只取 `source` 与「是否非空」，`value` 绝不进信封、绝不进 DOM。
   *
   * @returns {Promise<object>} 信封。
   */
  async function configRoute() {
    const cfg = service.resolvedConfig();
    const ref = cfg.embedding.apiKeyRef ?? null;
    /** @type {{ref: string|null, configured: boolean, source: string|null, error?: string}} */
    let keyStatus = { ref, configured: false, source: null };
    try {
      const resolved = await service.resolveKey(ref);
      keyStatus = {
        ref,
        configured: typeof resolved?.value === 'string' && resolved.value.length > 0,
        source: resolved?.source ?? null,
      };
    } catch (error) {
      // 探测失败也就是「没配成」，但把原因带上，免得面板显示成一切正常。
      keyStatus = { ref, configured: false, source: null, error: describeError(error) };
    }
    return {
      ok: true,
      config: {
        scope: cfg.scope ?? null,
        embedding: {
          provider: cfg.embedding.provider ?? null,
          baseUrl: cfg.embedding.baseUrl ?? null,
          model: cfg.embedding.model ?? null,
          dimensions: cfg.embedding.dimensions ?? null,
          apiKeyRef: ref,
        },
        search: {
          defaultLimit: cfg.search.defaultLimit ?? null,
          maxLimit: cfg.search.maxLimit ?? null,
        },
        llm: {
          provider: cfg.llm.provider ?? null,
          model: cfg.llm.model ?? null,
        },
        dataDir: service.dataDir ?? null,
      },
      // 当前生效档案 + 它对应的向量空间（已有多少 / 还缺多少）
      profile: service.profilesState?.().active ?? 'config',
      embeddingSpace: service.embeddingSpace ? service.embeddingSpace(cfg) : null,
      keyStatus,
    };
  }

  /**
   * POST `/credential` —— 写密钥。
   *
   * 本文件**不自己摸 `ctx`**（面板路由的职责是转发；凭据写入属于插件装配层）。
   * 接线方式二选一：
   *   1. `lib/index.js` 给 `MemoryService` 加一个直通方法
   *      `setCredential(ref, value)`（内部转 `ctx.credentials.set`）——这里会自动用它；
   *   2. 或者干脆在 `lib/index.js` 里另注册一条 `/credential` 路由（路由表按 path 精确匹配，
   *      与这里的同名路由不能并存）。
   *
   * 两种都没做时**如实回答「待接线」**，绝不假装成功。
   *
   * @param {object} body 请求体 `{value, ref?}`（密钥只在参数里走，不进日志、不进响应）。
   * @returns {Promise<object>} 信封。
   */
  async function credentialRoute(body) {
    if (typeof service.setCredential !== 'function') {
      return { ok: false, error: '该能力待接线' };
    }
    const value = typeof body.value === 'string' ? body.value : '';
    if (value === '') return { ok: false, error: '缺少 value' };
    const ref =
      typeof body.ref === 'string' && body.ref !== ''
        ? body.ref
        : (service.resolvedConfig().embedding.apiKeyRef ?? null);
    await service.setCredential(ref, value);
    // 只回引用名与结果，**绝不回显密钥**。
    return { ok: true, ref };
  }

  // ── 嵌入配置档案（自定义线上 / 局域网 / 本地模型；切换保留向量） ──────────────

  /**
   * GET `/profiles` —— 档案列表。
   *
   * 每个档案都带它的空间键、已有向量数、**还缺多少**：`missing === 0` 表示切过去立即可用，
   * `> 0` 表示切过去后需要补齐（补齐只算缺的那些，不会重算已有向量）。
   *
   * @returns {Promise<object>} 信封。
   */
  async function profilesRoute() {
    return service.listEmbeddingProfiles();
  }

  /**
   * POST `/profile` —— 新建 / 覆盖一个档案。**只写库，不切换、不删向量**。
   *
   * @param {object} body 请求体：`{name, provider, baseUrl, model, dimensions, apiKeyRef, ollamaUrl, localDims, ...}`。
   * @returns {Promise<object>} 信封。
   */
  async function profileSaveRoute(body) {
    if (typeof service.saveEmbeddingProfile !== 'function') return { ok: false, error: '该能力待接线' };
    return service.saveEmbeddingProfile(isPlainObject(body) ? body : {});
  }

  /**
   * POST `/profile-delete` —— 删除一个档案。**不删它的向量**：空间还在，切回来仍可用。
   *
   * @param {object} body 请求体 `{name}`。
   * @returns {Promise<object>} 信封。
   */
  async function profileDeleteRoute(body) {
    if (typeof service.deleteEmbeddingProfile !== 'function') return { ok: false, error: '该能力待接线' };
    return service.deleteEmbeddingProfile(isPlainObject(body) ? body.name : '');
  }

  /**
   * POST `/activate` —— 切换生效档案；`autoFill: true` 时顺手启动增量补齐。
   *
   * @param {object} body 请求体 `{name, autoFill?}`。
   * @returns {Promise<object>} 信封（含该空间的 vectors / missing）。
   */
  async function activateRoute(body) {
    if (typeof service.activateEmbeddingProfile !== 'function') return { ok: false, error: '该能力待接线' };
    const input = isPlainObject(body) ? body : {};
    const result = service.activateEmbeddingProfile(input.name);
    if (result.ok !== true) return result;
    let backfill = null;
    if (input.autoFill === true && Number(result.missing) > 0) {
      backfill = await service.startBackfill({});
    }
    return { ...result, backfill: backfill ?? service.publicBackfill() };
  }

  /**
   * POST `/embed-test` —— 用指定（或当前）配置**真打一次**嵌入请求。
   *
   * 这是「自定义 api url / key / 模型 id」的验收手段：配完立刻知道通不通、多少维，
   * 不用等补齐跑一半才发现维度对不上。响应里**没有密钥**，只有「从哪解析到的」。
   *
   * @param {object} body 请求体 `{name?, apiKeyRef?}`。
   * @returns {Promise<object>} 信封。
   */
  async function embedTestRoute(body) {
    if (typeof service.testEmbedding !== 'function') return { ok: false, error: '该能力待接线' };
    const input = isPlainObject(body) ? body : {};
    return service.testEmbedding({
      name: typeof input.name === 'string' && input.name !== '' ? input.name : null,
      apiKeyRef: typeof input.apiKeyRef === 'string' && input.apiKeyRef !== '' ? input.apiKeyRef : null,
    });
  }

  // ── 仓管 / 备份 ──────────────────────────────────────────────────────────────

  /**
   * POST `/keeper-run` —— 跑一轮仓管**出单**（新范式：只产出变更单，**一个字都不写记忆库**）。
   *
   * 流程：随机抽 `sample` 个种子 → 每个种子用 embedding 语义召回 `perGroup` 个邻居组成一组
   * → 每组一次仓管 LLM 调用 → 每组一张 `keeper_plans`（state=open）。
   *
   * `mode` **不是两种任务**，只是提示词侧重：`'digest'` → 偏重去重合并（优先 merge、不为了拆而拆）；
   * 其余（含未给）→ 全部手段。两个方向都只出单、不改库（落库仍然只在 `/keeper-plan-review`）。
   *
   * @param {object} body 请求体 `{mode?, sample?, perGroup?, maxGroups?, taker?}`。
   *   `taker` = 这一轮的**接手模型**（某组失败时用它接手）：仓管档案名 / `'host'` / **省略 = 用副仓管角色那条设定**
   *   （`POST /keeper-side` 写的；副仓管也没设 = 自动：本地优先 → 宿主）。
   * @returns {Promise<object>} 信封 `{ok, started, runId, planned, keeper}`。
   */
  async function keeperRunPlanRoute(body) {
    if (typeof service.startKeeperRun !== 'function') return { ok: false, error: '该能力待接线' };
    return service.startKeeperRun({
      // 只有显式 `digest` 才换成「偏重去重合并」；别的值（含老前端乱传的）一律按「全部手段」。
      mode: body.mode === 'digest' ? 'digest' : 'grind',
      sample: Number.isFinite(Number(body.sample)) ? Number(body.sample) : null,
      perGroup: Number.isFinite(Number(body.perGroup)) ? Number(body.perGroup) : null,
      maxGroups: Number.isFinite(Number(body.maxGroups)) ? Number(body.maxGroups) : 0,
      taker: body.taker == null || String(body.taker).trim() === '' ? null : String(body.taker).trim(),
    });
  }

  /**
   * GET `/keeper-plans` —— 变更单列表（新的在前），每张单带拍平的 `warnings`。
   *
   * @param {URLSearchParams} params 查询参数（`state?`、`limit?`）。
   * @returns {Promise<object>} 信封 `{ok, plans}`。
   */
  async function keeperPlansRoute(params) {
    if (typeof service.listKeeperPlans !== 'function') return { ok: false, error: '该能力待接线' };
    const state = params.get('state');
    const limit = intParam(params, 'limit', 0, { min: 0, max: 500 });
    return service.listKeeperPlans({ state: state == null || state.trim() === '' ? null : state.trim(), limit: limit > 0 ? limit : null });
  }

  /**
   * GET `/keeper-plan` —— 单张变更单全文（含每条 op 的 before / after / warnings）。
   *
   * @param {URLSearchParams} params 查询参数（`id`）。
   * @returns {Promise<object>} 信封 `{ok, plan}`。
   */
  async function keeperPlanRoute(params) {
    if (typeof service.getKeeperPlan !== 'function') return { ok: false, error: '该能力待接线' };
    const id = params.get('id') ?? '';
    if (id.trim() === '') return { ok: false, error: '缺少 id' };
    return service.getKeeperPlan(id);
  }

  /**
   * POST `/keeper-plan-review` —— 审阅一张变更单（**唯一会改记忆库的入口**）。
   *
   * `reject:true` = 整单驳回，不碰记忆库；否则**只应用被勾选的 op**（`keep` 省略 = 全部）。
   *
   * @param {object} body 请求体 `{id, keep?, edits?, reject?}`。
   * @returns {Promise<object>} 信封 `{ok, applied:{replace,split,merge,drop}, replaced, skipped, state}`。
   */
  async function keeperPlanReviewRoute(body) {
    if (typeof service.reviewKeeperPlan !== 'function') return { ok: false, error: '该能力待接线' };
    const id = String(body.id ?? '');
    if (id.trim() === '') return { ok: false, error: '缺少 id' };
    const keep = Array.isArray(body.keep)
      ? body.keep.map((value) => Number(value)).filter((value) => Number.isInteger(value))
      : null;
    return service.reviewKeeperPlan({
      id,
      keep,
      edits: isPlainObject(body.edits) ? body.edits : {},
      reject: body.reject === true,
    });
  }

  /**
   * GET `/handoffs` —— 「副仓管」列表（仓管某一组出错、又没被接手模型救回来的那些组）。
   *
   * 默认只看 `open`（面板那一段显示的就是「还等着人/模型处理的」）；`state` 可显式给
   * `open` / `taken` / `dropped` 看历史。
   *
   * @param {URLSearchParams} params 查询参数（`state`）。
   * @returns {Promise<object>} 信封 `{ok, handoffs, open}`。
   */
  async function handoffsRoute(params) {
    if (typeof service.listHandoffs !== 'function') return { ok: false, error: '该能力待接线' };
    const state = params.get('state');
    return service.listHandoffs({ state: state == null || state.trim() === '' ? 'open' : state.trim() });
  }

  /**
   * POST `/handoff-takeover` —— 让**指定的**接手模型重头整理一条副仓管记忆（**只出单、不改正文**）。
   *
   * `model`（用户 2026-10-07：「最终由什么模型接手由我启动时决定」→「副审阅区使用独立的仓管角色」）：
   * 仓管档案名（如 `'线上'`）/ `'host'`（宿主模型）/ **省略 = 用副仓管角色那条设定**
   * （`POST /keeper-side` 写的；副仓管也没设 = 自动：本地优先 → 宿主）。
   *
   * @param {object} body 请求体 `{id, model?}`。
   * @returns {Promise<object>} 信封 `{ok, handoff, planId, ops, taker}`。
   */
  async function handoffTakeoverRoute(body) {
    if (typeof service.takeOverHandoff !== 'function') return { ok: false, error: '该能力待接线' };
    const id = String(body.id ?? '');
    if (id.trim() === '') return { ok: false, error: '缺少 id' };
    const model = body.model == null || String(body.model).trim() === '' ? null : String(body.model).trim();
    return service.takeOverHandoff({ id, model });
  }

  /**
   * POST `/handoff-drop` —— 把一条副仓管从队列里清掉（软状态 `dropped`，不删行）。
   *
   * @param {object} body 请求体 `{id}`。
   * @returns {Promise<object>} 信封 `{ok, handoff}`。
   */
  async function handoffDropRoute(body) {
    if (typeof service.dropHandoff !== 'function') return { ok: false, error: '该能力待接线' };
    const id = String(body.id ?? '');
    if (id.trim() === '') return { ok: false, error: '缺少 id' };
    return service.dropHandoff({ id });
  }

  /**
   * POST `/handoff-plan` —— **把一张待审变更单「转手」给副整理区重头再做一遍**。
   *
   * 与工具 `memory_keeper {action:'handoff'}` 走**同一个** service 方法（`handOffPlan`）：
   * 原单停在终态 `handed`（不算通过、也不算驳回）、它的记忆挂进副整理区、当场让接手模型
   * 重头整理（embedding 召回 → 组 → 出单）。**只出单、不改任何记忆正文**。
   *
   * @param {object} body 请求体 `{id, reason?}`。
   * @returns {Promise<object>} 信封 `{ok, handoff, planId, ops, taker, seeds, recalled}`。
   */
  async function handoffPlanRoute(body) {
    if (typeof service.handOffPlan !== 'function') return { ok: false, error: '该能力待接线' };
    const id = String(body.id ?? '');
    if (id.trim() === '') return { ok: false, error: '缺少 id' };
    return service.handOffPlan({
      id,
      reason: body.reason == null || String(body.reason) === '' ? null : String(body.reason),
    });
  }

  /**
   * GET `/keeper` —— 仓管现状（配置、指向、任务进度、留下的痕迹）。
   *
   * @returns {Promise<object>} 信封。
   */
  async function keeperStateRoute() {
    if (typeof service.keeperStatus !== 'function') return { ok: false, error: '该能力待接线' };
    return { ok: true, ...service.keeperStatus() };
  }

  /**
   * POST `/keeper` —— **`/keeper-run` 的旧名（保留兼容）**：跑一轮出单，只产出变更单。
   *
   * 老前端传的 `mode` 现在**有意义**（只当提示词侧重：`'digest'` = 偏重去重合并）；
   * `limit` / `minChars` / `splitChars` / `redo` 仍然被忽略 —— 出单阶段永远不会改库。
   *
   * @param {object} body 请求体 `{mode?, sample?, perGroup?, maxGroups?}`。
   * @returns {Promise<object>} 信封。
   */
  async function keeperRunRoute(body) {
    return keeperRunPlanRoute(body);
  }

  /**
   * POST `/keeper-test` —— 测仓管 LLM 连通性（真打一次最小请求）。
   *
   * `name` 可选：不传 = 测当前生效档案；传了 = 只测那个档案（**不改 active**）。
   *
   * @param {object} body 请求体 `{name?}`。
   * @returns {Promise<object>} 信封。
   */
  async function keeperTestRoute(body) {
    if (typeof service.keeperTest !== 'function') return { ok: false, error: '该能力待接线' };
    const input = isPlainObject(body) ? body : {};
    const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : null;
    return name === null ? service.keeperTest({}) : service.keeperTest({ name });
  }

  /**
   * GET `/keeper-profiles` —— 仓管档案列表（内置只读档案 `config` 永远排第一）。
   *
   * @returns {Promise<object>} 信封 `{ok, active, profiles}`。
   */
  async function keeperProfilesRoute() {
    if (typeof service.listKeeperProfiles !== 'function') return { ok: false, error: '该能力待接线' };
    return service.listKeeperProfiles();
  }

  /**
   * POST `/keeper-profile` —— 新建 / 覆盖一个仓管档案。**只写库，不切换**。
   *
   * @param {object} body 请求体 `{name, provider?, ollamaUrl?, baseUrl?, model?, apiKeyRef?, ...}`；
   *   空串 / null = 删掉该项、回落 patch。
   * @returns {Promise<object>} 信封。
   */
  async function keeperProfileSaveRoute(body) {
    if (typeof service.saveKeeperProfile !== 'function') return { ok: false, error: '该能力待接线' };
    return service.saveKeeperProfile(isPlainObject(body) ? body : {});
  }

  /**
   * POST `/keeper-profile-delete` —— 删除一个仓管档案。
   *
   * 内置 `config` 不可删；删的正好是生效档案时，宿主会自动回落 `config`。
   *
   * @param {object} body 请求体 `{name}`。
   * @returns {Promise<object>} 信封。
   */
  async function keeperProfileDeleteRoute(body) {
    if (typeof service.deleteKeeperProfile !== 'function') return { ok: false, error: '该能力待接线' };
    return service.deleteKeeperProfile(isPlainObject(body) ? body.name : '');
  }

  /**
   * POST `/keeper-activate` —— 切换生效的仓管档案（`config` = 删掉覆盖、回落 patch）。
   *
   * **立刻生效**：`resolvedConfig().keeper` 当场就是新档案的值，不用重启 DSH。
   *
   * @param {object} body 请求体 `{name}`。
   * @returns {Promise<object>} 信封 `{ok, active, status}`。
   */
  async function keeperActivateRoute(body) {
    if (typeof service.activateKeeperProfile !== 'function') return { ok: false, error: '该能力待接线' };
    return service.activateKeeperProfile(isPlainObject(body) ? body.name : '');
  }

  /**
   * POST `/keeper-side` —— 设定**副仓管**这个独立角色的模型（用户 2026-10-07）。
   *
   * `model`：仓管档案名（如 `'线上'`）/ `'host'`（宿主模型）/ `'auto'` 或空（= 删掉设定、
   * 回落自动：本地 / 局域网档案优先 → 宿主）。与 `/keeper-activate`（主仓管用哪个档案）**互不影响**。
   *
   * @param {object} body 请求体 `{model}`。
   * @returns {Promise<object>} 信封 `{ok, side, status}`。
   */
  async function keeperSideRoute(body) {
    if (typeof service.setSideKeeper !== 'function') return { ok: false, error: '该能力待接线' };
    // 缺 `model` 归一成 `null`（= 删掉设定、回落自动），不把 undefined 塞给服务层。
    const model = isPlainObject(body) && body.model != null ? String(body.model).trim() : null;
    return service.setSideKeeper(model === '' ? null : model);
  }

  /**
   * POST `/keeper-config` —— 保存仓管配置（面板改，存在 DB，立刻生效、不用重启 DSH）。
   *
   * @param {object} body 请求体：`{provider?, ollamaUrl?, baseUrl?, model?, apiKeyRef?, minChars?, ...}`；
   *   空串 / null = 删掉该项、回落 patch。也接受 `{config: {...}}` 包一层。
   * @returns {Promise<object>} 信封（`{ok, overrides, status}`）。
   */
  async function keeperConfigRoute(body) {
    if (typeof service.saveKeeperConfig !== 'function') return { ok: false, error: '该能力待接线' };
    const patch = body != null && typeof body === 'object' ? (body.config ?? body) : {};
    const saved = service.saveKeeperConfig(patch);
    return { ...saved, status: typeof service.keeperStatus === 'function' ? service.keeperStatus() : null };
  }

  /**
   * POST `/keeper-revert` —— 回滚仓管做过的一切（产物真删、原文按 history 恢复、合并的放回来）。
   *
   * @returns {Promise<object>} 信封。
   */
  async function keeperRevertRoute() {
    if (typeof service.revertKeeper !== 'function') return { ok: false, error: '该能力待接线' };
    return service.revertKeeper();
  }

  /**
   * POST `/backup` —— 一键备份：库本体（`VACUUM INTO` 快照）+ 文本包。
   *
   * @param {object} body 请求体 `{dir?, keep?, withPack?}`。
   * @returns {Promise<object>} 信封。
   */
  async function backupRoute(body) {
    if (typeof service.backupNow !== 'function') return { ok: false, error: '该能力待接线' };
    const keep = Number.isFinite(Number(body.keep)) && Number(body.keep) > 0 ? Math.trunc(Number(body.keep)) : 5;
    return service.backupNow({
      dir: typeof body.dir === 'string' && body.dir !== '' ? body.dir : null,
      keep,
      withPack: body.withPack !== false,
    });
  }

  /**
   * POST `/llm-test` —— LLM 预检：真打一次最小生成请求。
   *
   * 抽取 / 冲突判定都靠宿主模型，而它的失败模式很隐蔽（连得上、却只吐 reasoning-delta）。
   * 这个按钮让「模型现在到底能不能用」变成一次点击就能回答的问题。
   *
   * @returns {Promise<object>} 信封（`{ok, provider, model, textLength, text, elapsedMs, warning?}`）。
   */
  async function llmTestRoute() {
    if (typeof service.llmProbe !== 'function') return { ok: false, error: '该能力待接线' };
    return service.llmProbe({});
  }

  // ── 回填 ─────────────────────────────────────────────────────────────────────

  /**
   * POST `/backfill` —— 补齐缺的向量，或强制全量重算。**启动即返回**，进度靠 GET 轮询。
   *
   * `mode: 'missing'`（默认）只补这个空间里缺的；`mode: 'all'` 不管缺不缺全部重算
   * （怀疑向量不纯 / 文本改过但向量没跟上时用）。
   *
   * @param {object} body 请求体 `{batchSize?, limit?, mode?}`。
   * @returns {Promise<object>} 信封 `{ok, started, backfill}`。
   */
  async function backfillStartRoute(body) {
    const batchSize = Number.isFinite(Number(body.batchSize)) && Number(body.batchSize) > 0
      ? Math.trunc(Number(body.batchSize))
      : null;
    const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Math.trunc(Number(body.limit)) : 0;
    const mode = String(body.mode ?? 'missing') === 'all' ? 'all' : 'missing';
    const result = await service.startBackfill({ batchSize, limit, mode });
    return {
      ok: result?.ok === true,
      ...(result?.ok === true ? {} : { error: result?.error ?? '启动失败' }),
      started: result?.started === true,
      mode,
      backfill: result?.backfill ?? service.publicBackfill(),
    };
  }

  /**
   * GET `/backfill` —— 回填进度。
   *
   * @returns {Promise<object>} 信封。
   */
  async function backfillStateRoute() {
    return { ok: true, backfill: service.publicBackfill() };
  }

  // ── 路由表（路径 → 方法 → handler） ───────────────────────────────────────────
  //
  // handler 统一签名 `(params, body, req) => Promise<object>`：body 只在 POST 时非空。
  // 表驱动的好处是「每条路由都带 requestBody: 'buffered'」由构造代码保证，
  // 不靠人逐条记得写。
  //
  // ⚠ 路径**必须唯一**：`connection` 的注册表是按 pathname 建键的（`fetchRoutes.get(url.pathname)`），
  // 重复注册同一路径会**直接抛错**：
  //   `connection: exact Fetch route "/api/dsh-memory/backfill" is already registered`
  // 所以「同一个路径分 GET / POST 两件事」必须合成**一条** methods: ['GET','POST'] 的路由，
  // 在 handler 里按 `req.method` 分派，而不是注册两条。
  /** @type {[string, string[], (params: URLSearchParams, body: object, req: Request) => Promise<object>][]} */
  const table = [
    ['/state', ['GET'], (params, body) => stateRoute()],
    ['/search', ['GET'], (params, body) => searchRoute(params)],
    ['/recent', ['GET'], (params, body) => recentRoute(params)],
    ['/memories', ['GET'], (params, body) => listRoute(params)],
    ['/memory', ['GET'], (params, body) => memoryRoute(params)],
    ['/remember', ['POST'], (params, body) => rememberRoute(body)],
    ['/forget', ['POST'], (params, body) => forgetRoute(body)],
    ['/propose', ['POST'], (params, body) => proposeRoute(body)],
    // 「待办」页（抽取待审区）2026-10-07 整页移除之后，它那三条路由（`/pending`、`/batch`、`/review`）
    // 也一并删掉：面板没有入口了，留着的只是死路由。**能力本身没删** —— `memory_pending` /
    // `memory_analyze` / `memory_review` 三个工具走的是同一批 service 方法。
    ['/extract', ['POST'], (params, body) => extractRoute(body)],
    ['/analyze', ['POST'], (params, body) => analyzeRoute(body)],
    ['/config', ['GET'], (params, body) => configRoute()],
    ['/credential', ['POST'], (params, body) => credentialRoute(body)],
    ['/profiles', ['GET'], (params, body) => profilesRoute()],
    ['/profile', ['POST'], (params, body) => profileSaveRoute(body)],
    ['/profile-delete', ['POST'], (params, body) => profileDeleteRoute(body)],
    ['/activate', ['POST'], (params, body) => activateRoute(body)],
    ['/embed-test', ['POST'], (params, body) => embedTestRoute(body)],
    ['/keeper', ['GET', 'POST'], (params, body, req) =>
      String(req.method ?? '').toUpperCase() === 'POST' ? keeperRunRoute(body) : keeperStateRoute()],
    ['/keeper-run', ['POST'], (params, body) => keeperRunPlanRoute(body)],
    ['/keeper-plans', ['GET'], (params, body) => keeperPlansRoute(params)],
    ['/keeper-plan', ['GET'], (params, body) => keeperPlanRoute(params)],
    ['/keeper-plan-review', ['POST'], (params, body) => keeperPlanReviewRoute(body)],
    ['/handoffs', ['GET'], (params) => handoffsRoute(params)],
    ['/handoff-takeover', ['POST'], (params, body) => handoffTakeoverRoute(body)],
    ['/handoff-plan', ['POST'], (params, body) => handoffPlanRoute(body)],
    ['/handoff-drop', ['POST'], (params, body) => handoffDropRoute(body)],
    ['/keeper-test', ['POST'], (params, body) => keeperTestRoute(body)],
    ['/keeper-profiles', ['GET'], () => keeperProfilesRoute()],
    ['/keeper-profile', ['POST'], (params, body) => keeperProfileSaveRoute(body)],
    ['/keeper-profile-delete', ['POST'], (params, body) => keeperProfileDeleteRoute(body)],
    ['/keeper-activate', ['POST'], (params, body) => keeperActivateRoute(body)],
    ['/keeper-side', ['POST'], (params, body) => keeperSideRoute(body)],
    ['/keeper-config', ['POST'], (params, body) => keeperConfigRoute(body)],
    ['/keeper-revert', ['POST'], () => keeperRevertRoute()],
    ['/backup', ['POST'], (params, body) => backupRoute(body)],
    ['/llm-test', ['POST'], () => llmTestRoute()],
    [
      '/backfill',
      ['GET', 'POST'],
      (params, body, req) =>
        String(req.method ?? '').toUpperCase() === 'POST' ? backfillStartRoute(body) : backfillStateRoute(),
    ],
  ];

  return table.map(([path, methods, handler]) => ({
    // 精确字符串路径：connection 的 exact 路由表按键全等查找。
    path: MEMORY_ROUTE_PREFIX + path,
    methods,
    // 必需。见文件头第 2 条：漏了它浏览器只会看到「HTTP 400：响应不是 JSON」。
    requestBody: 'buffered',
    /**
     * 桥接层入口：读 query、解析请求体、兜住所有异常，最后永远回一个 200 JSON。
     *
     * @param {Request} req 请求。
     * @returns {Promise<Response>} 响应。
     */
    async fetch(req) {
      try {
        const params = queryOf(req);
        const method = String(req.method ?? 'GET').toUpperCase();
        let body = {};
        // 只有「这条路由允许 POST 且本次真的是 POST」才读请求体：
        // 既支持 GET/POST 合一的 /backfill，也避免给 GET 请求硬塞一个 body。
        if (method === 'POST' && methods.includes('POST')) {
          // 自己 text() + JSON.parse 而不是 req.json()：解析失败要变成信封里的错误，
          // 而不是抛出后被折成 400 空响应。
          const raw = await req.text().catch(() => null);
          if (raw === null || raw.trim() === '') {
            body = {};
          } else {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              return json({ ok: false, error: '请求体不是合法 JSON' });
            }
            if (!isPlainObject(parsed)) return json({ ok: false, error: '请求体必须是 JSON 对象' });
            body = parsed;
          }
        }
        return json(await handler(params, body, req));
      } catch (error) {
        return json({ ok: false, error: describeError(error) });
      }
    },
  }));
}
