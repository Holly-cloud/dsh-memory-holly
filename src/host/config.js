/**
 * dsh-memory · Phase 1：配置默认值、深合并与校验。
 *
 * 这里同时提供两种校验入口：
 * - `normalizeConfig(raw)`：抛错式，插件内部用（`lib/index.js` 侧调用）；
 * - `Config['~standard'].validate(value)`：Standard Schema 契约，给宿主/面板做表单校验用。
 *
 * 两者共用同一份规则，因此永远不会出现「面板说合法、运行时却抛错」的漂移。
 *
 * @module dsh-memory/host/config
 */

import { EMBEDDING_PROVIDERS } from './embed.js';

/** 出厂默认配置。**不要**就地修改这个对象（`normalizeConfig` 每次都会深拷贝）。 */
export const DEFAULT_CONFIG = {
  dataDir: null,
  scope: 'default',
  // 开发期诊断路由 `/dsh-memory-selftest/*` 的开关。
  // ⚠️ **默认必须为 false**：那条路由挂在 webserver 前缀表上、不经 `/api`，
  // 因此**没有任何鉴权**，而它上面有 /import（读任意文件）、/credential（写凭据）、
  // /clean（改数据）、/search（吐记忆正文）——本机任何进程都能调。
  // 只应在排查问题时临时设为 true。
  diagnostics: false,
  embedding: {
    provider: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-text-embedding',
    dimensions: 1024,
    apiKeyRef: 'DASHSCOPE_API_KEY',
    batchSize: 16,
    timeoutMs: 60000,
    ollamaUrl: 'http://127.0.0.1:11434',
    localDims: 1024,
  },
  search: { defaultLimit: 8, maxLimit: 100, minScore: 0, keywordWeight: 1, vectorWeight: 1, rrfK: 60 },
  llm: { provider: null, model: null, extractMaxTokens: 2000, conflictMaxTokens: 1500, temperature: 0 },
  // 跟随 agent 运行的自主捕获：监听会话事件、攒够用户正文后在回合结束时抽一次。
  // mode 只影响「连入记忆系统的那个 agent 自己」的会话：
  //   direct  = 抽出来**免审直接入库**（用户 2026-10-06 定的规则）
  //   pending = 先落待审区
  // 其他来源（子代理 / 被委派的会话）一律走待审区，不受 mode 影响。
  capture: {
    enabled: true,
    mode: 'direct',
    focused: true,
    minChars: 120,
    maxChars: 4000,
    cooldownMs: 120000,
    // 第二道闸：抽出来的事实在**写库 / 入待审区之前**再过一道确定性三分类
    // （`src/host/transient.js` 的 `looksTransient()`）：
    //   durable（长期信号，即使带技术词）→ 保留；transient（会话/工具/进度态）→ 丢弃；
    //   uncertain（拿不准）→ 不丢，并进待审区（`deferredToReview`）。
    // 提示词里也写了「不要记」清单，但提示词不是保证。
    // false = 三分类全部保留（等价关闭过滤，只靠提示词）。
    dropTransient: true,
  },
  // 待审批次由谁审：agent = 用同一套冲突判定（四关系 + 四条护栏）自动审；human = 留在面板等人审。
  review: { agent: true, topK: 3 },
  // 每条记忆的两个行为计数器的**每周防膨胀衰减**。
  // weeklyDecay = 每周全库同乘的系数（**比例严格不变**：全体同乘一个数，只有绝对值缩水）。
  //   0.98 表示每周整体缩水 2%；懒触发，距上次 ≥7 天才真正乘，按整周数连乘（factor ** weeks）。
  //   必须在开区间 (0, 1) 内：1 = 不衰减（会让数值无限膨胀），0 = 一次归零（信息丢失）。
  score: { weeklyDecay: 0.98 },
  // **读取侧注入（2026-10-08 起）**：把记忆主动送进 agent 的系统提示，而不是等它想起来去查。
  // 两层都是**派生视图**：只读库、不写一个字、可随时关掉重算（`enabled:false` 即完全停用）。
  //   Layer 0（`systemPrompt.section`）常驻索引：`indexSlots` 个固定槽、`charLimit` 字一行、
  //     话题段内**逐字节冻结**（保前缀缓存）；`indexPinnedCap` = 人写的/旧基线/pin 的条数上限。
  //   Layer 1（`systemPrompt.context`）按需召回：`recallSlots` 个固定槽，落在提示词尾部
  //     （动态内容后置 —— 缓存 miss 的代价封顶在它自己身上）。
  //   `minSegmentTurns` / `cohesionFloor` = 话题段判定（段内至少几轮、bigram 衔接度低于多少算换话题；
  //   换话题才重建索引，防"顺口一问"把上下文裁了，也防频繁变动把前缀缓存打散）。
  //   `candidateLimit` = 一次同步 LIKE 最多取多少候选（本机 1356 行，毫秒级）。
  //   `minQueryChars` = 查询词短于这个字数就**不注**（真机实测：「重启完成」4 字注进来 4 行，
  //     其中两条完全无关 —— 短消息摊出的 bigram 全是高频词，闸门挡不住，只能整条不注）。
  //   `dedupeFloor` = 同一块里两行的 bigram Jaccard ≥ 此值就丢掉后者（同一件事的两个版本
  //     会肉眼可见地并排）；`0` = 关。行数可能因此少于 `recallSlots`（**少注优先于补位**）。
  recall: {
    enabled: true,
    indexSlots: 8,
    indexPinnedCap: 4,
    recallSlots: 6,
    charLimit: 60,
    minSegmentTurns: 3,
    cohesionFloor: 0.08,
    candidateLimit: 400,
    terms: 14,
    minQueryChars: 6,
    dedupeFloor: 0.92,
  },
  // 仓管：插件**自带**的一条本地 / 局域网 LLM 通道（与宿主 ctx.llm 无关），
  // 负责对已录入的记忆做全库二次加工。**新范式（2026-10-07）**：仓管只产出「变更单」，
  // 人审阅通过后才落库 —— 所以这里不再有「一次跑多少条」的任务参数，
  // 只有「一轮抽多少种子、每个种子召回多少邻居」这两项。
  // 默认指向局域网 Ollama；`ollamaUrl` 留 null = 未配置，仓管会如实报「未配置」而不是拿本机默认值乱连。
  keeper: {
    provider: 'ollama',
    ollamaUrl: null,
    baseUrl: null,
    model: null,
    apiKeyRef: null,
    // 线上模型（如 qwen3.8-flash）吐 2000 token 的 JSON 实测可能过 2 分钟：
    // 120s 会让约 1/3 的组超时、白花采样机会（那一组 tidy 照加、却一行产出都没有）。
    // 默认提到 240s；同组超时还会在 `runKeeperRun()` 里**自动重试一次**（见 lib/index.js）。
    timeoutMs: 240000,
    // 一组的**硬墙钟安全网**（毫秒）。`0` = 自动取「本节 timeoutMs × 2」。
    // 为什么是安全网而不是正常预算：实测正常的一组（5 条、2000 token JSON）要跑 231 秒才成，
    // 把它当预算会把正常成果杀掉；而一组最坏能打两次请求（超时重试一次），`timeoutMs` 管不到"整组"。
    groupTimeoutMs: 0,
    maxTokens: 2000,
    temperature: 0,
    minChars: 240,
    digestMinChars: 120,
    splitChars: 400,
    dedupeThreshold: 0.86,
    // 一轮 run：随机抽多少个种子（每个种子出一张变更单）
    sampleSize: 20,
    // 每个种子用 embedding 语义召回多少个邻居（种子 + 邻居 = 一组）
    perGroup: 5,
  },
};

/**
 * 判断普通对象（不含数组 / null）。
 *
 * @param {unknown} value 值
 * @returns {boolean} 是否是普通对象
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 深合并（`patch` 覆盖 `base`，两边都是对象时递归）。
 *
 * @param {Record<string, unknown>} base 基准
 * @param {Record<string, unknown>} patch 覆盖
 * @returns {Record<string, unknown>} 新对象
 */
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * 生成一条校验问题。
 *
 * @param {string} path 字段路径（点号分隔）
 * @param {string} detail 原因
 * @returns {{ message: string, path: string[] }} 问题
 */
function issue(path, detail) {
  return { message: `配置项 ${path} ${detail}`, path: path.split('.') };
}

/**
 * 校验非空字符串。
 *
 * @param {unknown} value 值
 * @param {string} path 字段路径
 * @param {{ allowNull?: boolean }} [options] 是否允许 null
 * @returns {boolean} 是否合法
 */
function checkString(value, path, { allowNull = false } = {}) {
  if (allowNull && value === null) return true;
  return typeof value === 'string' && value.length > 0;
}

/**
 * 校验正整数。
 *
 * @param {unknown} value 值
 * @param {string} path 字段路径
 * @returns {boolean} 是否合法
 */
function checkPositiveInt(value, path) {
  return Number.isInteger(value) && value > 0;
}

/**
 * 校验有限数字。
 *
 * @param {unknown} value 值
 * @param {string} path 字段路径
 * @param {number} min 最小值（闭区间）
 * @returns {boolean} 是否合法
 */
function checkNumber(value, path, min = Number.NEGATIVE_INFINITY) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

/**
 * 深合并 + 逐项校验。
 *
 * @param {unknown} raw 用户传入的（部分）配置
 * @returns {{ value: Record<string, unknown>, issues: { message: string, path: string[] }[] }} 结果
 */
export function normalizeConfigResult(raw) {
  if (raw != null && !isPlainObject(raw)) {
    return { value: structuredClone(DEFAULT_CONFIG), issues: [issue('config', '必须是对象')] };
  }
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), raw ?? {});
  /** @type {{ message: string, path: string[] }[]} */
  const issues = [];
  const bad = (path, detail) => issues.push(issue(path, detail));

  // --- 顶层 ---
  if (!checkString(merged.dataDir, 'dataDir', { allowNull: true })) bad('dataDir', '必须是字符串或 null');
  if (!checkString(merged.scope, 'scope')) bad('scope', '必须是非空字符串');

  // --- embedding ---
  const embedding = isPlainObject(merged.embedding) ? merged.embedding : {};
  if (!EMBEDDING_PROVIDERS.includes(embedding.provider)) {
    bad('embedding.provider', `必须是 ${EMBEDDING_PROVIDERS.join(' / ')} 之一（收到 ${JSON.stringify(embedding.provider)}）`);
  }
  if (!checkString(embedding.baseUrl, 'embedding.baseUrl')) bad('embedding.baseUrl', '必须是非空字符串');
  if (!checkString(embedding.model, 'embedding.model')) bad('embedding.model', '必须是非空字符串');
  if (!checkPositiveInt(embedding.dimensions, 'embedding.dimensions')) {
    bad('embedding.dimensions', `必须是正整数（收到 ${JSON.stringify(embedding.dimensions)}）`);
  }
  if (!checkString(embedding.apiKeyRef, 'embedding.apiKeyRef', { allowNull: true })) {
    bad('embedding.apiKeyRef', '必须是字符串或 null');
  }
  if (!checkPositiveInt(embedding.batchSize, 'embedding.batchSize')) {
    bad('embedding.batchSize', `必须是正整数（收到 ${JSON.stringify(embedding.batchSize)}）`);
  }
  if (!checkNumber(embedding.timeoutMs, 'embedding.timeoutMs', 1)) {
    bad('embedding.timeoutMs', `必须是 ≥ 1 的数字（收到 ${JSON.stringify(embedding.timeoutMs)}）`);
  }
  if (!checkString(embedding.ollamaUrl, 'embedding.ollamaUrl')) bad('embedding.ollamaUrl', '必须是非空字符串');
  if (!checkPositiveInt(embedding.localDims, 'embedding.localDims')) {
    bad('embedding.localDims', `必须是正整数（收到 ${JSON.stringify(embedding.localDims)}）`);
  }

  // --- search ---
  const search = isPlainObject(merged.search) ? merged.search : {};
  for (const key of ['defaultLimit', 'maxLimit', 'rrfK']) {
    if (!checkPositiveInt(search[key], `search.${key}`)) {
      bad(`search.${key}`, `必须是正整数（收到 ${JSON.stringify(search[key])}）`);
    }
  }
  if (!checkNumber(search.minScore, 'search.minScore')) {
    bad('search.minScore', `必须是有限数字（收到 ${JSON.stringify(search.minScore)}）`);
  }
  for (const key of ['keywordWeight', 'vectorWeight']) {
    if (!checkNumber(search[key], `search.${key}`, 0)) {
      bad(`search.${key}`, `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(search[key])}）`);
    }
  }
  if (checkPositiveInt(search.defaultLimit, 'search.defaultLimit') && checkPositiveInt(search.maxLimit, 'search.maxLimit')
    && search.defaultLimit > search.maxLimit) {
    bad('search.defaultLimit', `不能大于 search.maxLimit（${search.defaultLimit} > ${search.maxLimit}）`);
  }

  // --- recall（读取侧注入）---
  const recall = isPlainObject(merged.recall) ? merged.recall : {};
  if (typeof recall.enabled !== 'boolean') bad('recall.enabled', '必须是布尔值');
  for (const key of ['indexSlots', 'indexPinnedCap', 'recallSlots', 'charLimit', 'minSegmentTurns', 'candidateLimit', 'terms', 'minQueryChars']) {
    if (!checkPositiveInt(recall[key], `recall.${key}`)) {
      bad(`recall.${key}`, `必须是正整数（收到 ${JSON.stringify(recall[key])}）`);
    }
  }
  if (checkPositiveInt(recall.indexPinnedCap, 'recall.indexPinnedCap') && checkPositiveInt(recall.indexSlots, 'recall.indexSlots')
    && recall.indexPinnedCap > recall.indexSlots) {
    bad('recall.indexPinnedCap', `不能大于 recall.indexSlots（${recall.indexPinnedCap} > ${recall.indexSlots}）`);
  }
  if (!checkNumber(recall.cohesionFloor, 'recall.cohesionFloor', 0)) {
    bad('recall.cohesionFloor', `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(recall.cohesionFloor)}）`);
  }
  // 0 是**合法**值（= 关掉去重），所以这里不能走 checkPositiveInt。
  if (!checkNumber(recall.dedupeFloor, 'recall.dedupeFloor', 0)) {
    bad('recall.dedupeFloor', `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(recall.dedupeFloor)}；0 = 关去重）`);
  }

  // --- llm ---
  const llm = isPlainObject(merged.llm) ? merged.llm : {};
  if (!checkString(llm.provider, 'llm.provider', { allowNull: true })) bad('llm.provider', '必须是字符串或 null');
  if (!checkString(llm.model, 'llm.model', { allowNull: true })) bad('llm.model', '必须是字符串或 null');
  for (const key of ['extractMaxTokens', 'conflictMaxTokens']) {
    if (!checkPositiveInt(llm[key], `llm.${key}`)) {
      bad(`llm.${key}`, `必须是正整数（收到 ${JSON.stringify(llm[key])}）`);
    }
  }
  if (!checkNumber(llm.temperature, 'llm.temperature', 0)) {
    bad('llm.temperature', `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(llm.temperature)}）`);
  }

  // --- capture（跟随 agent 运行的自主捕获） ---
  const capture = isPlainObject(merged.capture) ? merged.capture : {};
  if (typeof capture.enabled !== 'boolean') {
    bad('capture.enabled', `必须是布尔（收到 ${JSON.stringify(capture.enabled)}）`);
  }
  if (capture.mode !== 'direct' && capture.mode !== 'pending') {
    bad('capture.mode', `必须是 direct / pending 之一（收到 ${JSON.stringify(capture.mode)}）`);
  }
  if (typeof capture.focused !== 'boolean') {
    bad('capture.focused', `必须是布尔（收到 ${JSON.stringify(capture.focused)}）`);
  }
  if (!checkPositiveInt(capture.minChars, 'capture.minChars')) {
    bad('capture.minChars', `必须是正整数（收到 ${JSON.stringify(capture.minChars)}）`);
  }
  if (!checkPositiveInt(capture.maxChars, 'capture.maxChars')) {
    bad('capture.maxChars', `必须是正整数（收到 ${JSON.stringify(capture.maxChars)}）`);
  }
  if (checkPositiveInt(capture.minChars, 'capture.minChars') && checkPositiveInt(capture.maxChars, 'capture.maxChars')
    && capture.minChars > capture.maxChars) {
    bad('capture.minChars', `不能大于 capture.maxChars（${capture.minChars} > ${capture.maxChars}）`);
  }
  if (!checkNumber(capture.cooldownMs, 'capture.cooldownMs', 0)) {
    bad('capture.cooldownMs', `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(capture.cooldownMs)}）`);
  }
  if (typeof capture.dropTransient !== 'boolean') {
    bad('capture.dropTransient', `必须是布尔（收到 ${JSON.stringify(capture.dropTransient)}）`);
  }

  // --- review（待审批次由谁审） ---
  const review = isPlainObject(merged.review) ? merged.review : {};
  if (typeof review.agent !== 'boolean') {
    bad('review.agent', `必须是布尔（收到 ${JSON.stringify(review.agent)}）`);
  }
  if (!checkPositiveInt(review.topK, 'review.topK')) {
    bad('review.topK', `必须是正整数（收到 ${JSON.stringify(review.topK)}）`);
  }

  // --- score（两个行为计数器的每周衰减） ---
  const score = isPlainObject(merged.score) ? merged.score : {};
  if (!(typeof score.weeklyDecay === 'number' && Number.isFinite(score.weeklyDecay)
    && score.weeklyDecay > 0 && score.weeklyDecay < 1)) {
    bad('score.weeklyDecay', `必须是 0 与 1 之间的开区间数字（不含 0 / 1，收到 ${JSON.stringify(score.weeklyDecay)}）`);
  }

  // --- keeper（仓管：自带的本地/局域网 LLM + 全库二次加工参数） ---
  const keeper = isPlainObject(merged.keeper) ? merged.keeper : {};
  if (keeper.provider !== 'ollama' && keeper.provider !== 'openai') {
    bad('keeper.provider', `必须是 ollama / openai 之一（收到 ${JSON.stringify(keeper.provider)}）`);
  }
  for (const field of ['ollamaUrl', 'baseUrl', 'model', 'apiKeyRef']) {
    if (!checkString(keeper[field], `keeper.${field}`, { allowNull: true })) {
      bad(`keeper.${field}`, '必须是字符串或 null');
    }
  }
  if (!checkPositiveInt(keeper.timeoutMs, 'keeper.timeoutMs')) {
    bad('keeper.timeoutMs', `必须是正整数（收到 ${JSON.stringify(keeper.timeoutMs)}）`);
  }
  // 0 是**合法**值（= 自动取「timeoutMs × 2」），所以不能走 checkPositiveInt。
  if (!checkNumber(keeper.groupTimeoutMs, 'keeper.groupTimeoutMs', 0)) {
    bad('keeper.groupTimeoutMs', `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(keeper.groupTimeoutMs)}；0 = 自动取 timeoutMs × 2）`);
  }
  if (!checkPositiveInt(keeper.maxTokens, 'keeper.maxTokens')) {
    bad('keeper.maxTokens', `必须是正整数（收到 ${JSON.stringify(keeper.maxTokens)}）`);
  }
  if (!checkNumber(keeper.temperature, 'keeper.temperature', 0)) {
    bad('keeper.temperature', `必须是 ≥ 0 的有限数字（收到 ${JSON.stringify(keeper.temperature)}）`);
  }
  for (const field of ['minChars', 'digestMinChars', 'splitChars', 'sampleSize', 'perGroup']) {
    if (!checkPositiveInt(keeper[field], `keeper.${field}`)) {
      bad(`keeper.${field}`, `必须是正整数（收到 ${JSON.stringify(keeper[field])}）`);
    }
  }
  if (!checkNumber(keeper.dedupeThreshold, 'keeper.dedupeThreshold', 0) || Number(keeper.dedupeThreshold) > 1) {
    bad('keeper.dedupeThreshold', `必须是 0–1 之间的数字（收到 ${JSON.stringify(keeper.dedupeThreshold)}）`);
  }

  return { value: merged, issues };
}

/**
 * 深合并 + 校验，非法值直接抛错。
 *
 * @param {unknown} raw 用户传入的（部分）配置
 * @returns {typeof DEFAULT_CONFIG} 完整配置
 */
export function normalizeConfig(raw) {
  const { value, issues } = normalizeConfigResult(raw);
  if (issues.length > 0) {
    throw new Error(`dsh-memory 配置无效：${issues.map((item) => item.message).join('；')}`);
  }
  return value;
}

/**
 * 向量空间指纹：`provider:model:dims`。
 *
 * 换 provider / 换模型 / 换维度都会得到不同的指纹，因此可以据此判断
 * 「库里的向量是不是当前配置产生的」，从而触发重建。
 *
 * @param {{ provider?: string, model?: string, dimensions?: number, localDims?: number }} embeddingConfig 嵌入配置
 * @returns {string} 指纹
 */
export function embeddingFingerprint(embeddingConfig) {
  const normalized = normalizeConfig({ embedding: embeddingConfig ?? {} }).embedding;
  const dims = normalized.provider === 'local-hash' ? normalized.localDims : normalized.dimensions;
  return `${normalized.provider}:${normalized.model}:${dims}`;
}

/**
 * Standard Schema v1 适配器（宿主面板直接消费这个对象做校验）。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory',
    /**
     * 校验配置。
     *
     * @param {unknown} value 待校验的值
     * @returns {{ value: Record<string, unknown> } | { issues: { message: string, path: string[] }[] }} 结果
     */
    validate(value) {
      const { value: normalized, issues } = normalizeConfigResult(value);
      if (issues.length > 0) return { issues };
      return { value: normalized };
    },
  },
};
