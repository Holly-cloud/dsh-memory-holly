/**
 * dsh-memory · Phase 2：冲突判定 —— 新记忆与已有记忆候选之间是什么关系。
 *
 * 设计要点（Phase 3–5 直接依赖）：
 * - 只做「判定」，不改库：返回 `items[].suggestion` 供审阅门决定怎么处理；
 * - **一次 LLM 调用批量判定**全部候选（省 token、也避免逐条判定时标准漂移）；
 * - 判定不确定性一律倒向 **`unrelated`（不动）**：宁可不改，也不要把对的记忆改坏；
 * - 具体事件 / 经历 / 里程碑即使内容相关也只能是 `coexist` —— 发生过的事永远是真的。
 *
 * @module dsh-memory/host/conflict
 */

/**
 * 注入的 LLM 接口（与 extract.js 同一份契约）。
 *
 * @typedef {{ chat(request: { messages: { role: string, content: string }[], temperature?: number,
 *   maxTokens?: number }): Promise<string> }} LlmClient
 */

/** 四种关系，顺序即优先级展示顺序。 */
export const RELATIONS = ['supersede', 'duplicate', 'coexist', 'unrelated'];

/** 没判断出来时的兜底理由（也是「按不动处理」的显式提示）。 */
export const UNJUDGED_REASON = '（没判断出来，按不动处理）';

/** 冲突判定提示词：分类学 + 铁律 + 严格的输出格式。 */
export const CONFLICT_PROMPT = `你是记忆冲突判定器。用户会给出一条【新记忆】和一组带编号的【已有记忆候选】，
请逐条判断「新记忆」和每条候选之间是什么关系。

关系只能从下面四种里选一种：
- supersede：同一个东西的**新状态**，旧记忆已经过时，应当被改写。
  例：端口从 8080 改成 9090；常喝的咖啡从冰美式换成热拿铁；住处从北京搬到上海。
- duplicate：同一件事的重复表述，说的其实就是一回事，不必再存一遍。
- coexist：两者都对、并不冲突（不同侧面、不同时期、互相补充）。
- unrelated：只是用词相近，实际说的不是一回事。

**铁律：具体事件、经历、里程碑即使内容相关，也算 coexist。**
发生过的事永远是真的，后来的变化不能「改写」它。
例：「去年去了京都」与「明年想去大阪」→ coexist；
「上个月买了咖啡机」与「想再买一台磨豆机」→ coexist；
「宝宝三岁学会骑车」与「宝宝今年上小学」→ coexist。

判定原则：
1. 只有**同一主体、同一属性**且**新状态覆盖旧状态**时，才允许 supersede；
2. 拿不准时选 unrelated，宁可不动，也不要改坏已有记忆；
3. 每条候选都必须给出一条结果，一次调用批量判定，不要遗漏。

输出格式：**只输出 JSON 数组**，index 从 1 开始，对应候选列表的编号：
[{"index": 1, "relation": "coexist", "reason": "一句话理由"}]
reason 用简短中文说明依据，不超过 50 字。
不要输出解释、不要 Markdown 代码块围栏、不要在数组之外写任何一个字。`;

/**
 * 组装一次冲突判定请求。
 *
 * 候选文本带 1-based 编号写进 user 消息，与要求模型返回的 `index` 对齐。
 *
 * @param {{ newText?: string, candidates?: { id?: string, text?: string, score?: number }[],
 *   maxTokens?: number }} [input] 输入
 * @returns {{ messages: { role: string, content: string }[], temperature: number, maxTokens: number }} 请求
 */
export function buildConflictRequest({ newText = '', candidates = [], maxTokens = 1500 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const lines = list.map((candidate, i) => {
    const score = Number(candidate?.score);
    const scoreText = Number.isFinite(score) ? score.toFixed(3) : '未知';
    return `${i + 1}. （相似度 ${scoreText}）${String(candidate?.text ?? '')}`;
  });

  const body = [
    '【新记忆】',
    String(newText ?? ''),
    '',
    '【已有记忆候选】',
    lines.length > 0 ? lines.join('\n') : '（没有候选）',
    '',
    `请对上面 ${list.length} 条候选逐条给出关系判定，只输出 JSON 数组。`,
  ].join('\n');

  const limit = Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : 1500;
  return {
    messages: [
      { role: 'system', content: CONFLICT_PROMPT },
      { role: 'user', content: body },
    ],
    temperature: 0,
    maxTokens: limit,
  };
}

/**
 * 解析模型返回的关系判定。**绝不抛错**。
 *
 * 容错规则：
 * 1. 非字符串 / 候选数为 0 → `[]`；
 * 2. 用 `/\[[\s\S]*\]/` 取第一段 JSON 数组，解析失败 → `[]`；
 * 3. `index` 是 **1-based**，转成 0-based；越界、非整数、缺失 → 丢弃该条；
 * 4. `relation` 不在 `RELATIONS` 里 → 归为 `unrelated`；
 * 5. `reason` 只保留字符串并**截断到 200 字**；
 * 6. 同一个 index 重复出现 → 以**第一次**为准；
 * 7. 结果按 index 升序返回（便于调用方对位）。
 *
 * @param {unknown} raw 模型输出的纯文本
 * @param {number} candidateCount 候选条数（用于越界判断）
 * @returns {{ index: number, relation: string, reason: string }[]} 判定结果
 */
export function parseRelations(raw, candidateCount) {
  if (typeof raw !== 'string') return [];
  const count = Number.isInteger(candidateCount) && candidateCount > 0 ? candidateCount : 0;
  if (count === 0) return [];

  const match = raw.match(/\[[\s\S]*\]/);
  if (match == null) return [];

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  /** @type {{ index: number, relation: string, reason: string }[]} */
  const out = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const rawIndex = entry.index;
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex)) continue;
    const index = rawIndex - 1;
    if (index < 0 || index >= count) continue;
    if (seen.has(index)) continue;
    seen.add(index);

    const relation = RELATIONS.includes(entry.relation) ? entry.relation : 'unrelated';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 200) : '';
    out.push({ index, relation, reason });
  }

  return out.sort((a, b) => a.index - b.index);
}

/**
 * 关系 → 给用户看的一句话建议。
 *
 * @param {string} relation 关系
 * @returns {string} 建议文案
 */
export function suggestionFor(relation) {
  if (relation === 'supersede') return '改写这条旧记忆';
  if (relation === 'duplicate') return '重复，不用存';
  return '并存';
}

/**
 * 把未知异常折成一句话。
 *
 * @param {unknown} err 异常
 * @returns {string} 描述
 */
function describeError(err) {
  if (err == null) return '未知错误';
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

/**
 * 批量判定「新记忆」与候选的关系。
 *
 * 失败（缺 llm、newText 为空、模型抛错）时**所有候选一律 `unrelated`**，
 * 原因写进 `error`；这是刻意的保守设计：判定失败绝不能默认改写。
 *
 * 模型返回了内容但一条都没解析出来时算「没判到」，仍返回 `ok: true`，
 * 由 `items[].reason` 标出 `UNJUDGED_REASON`。
 *
 * @param {{ llm?: LlmClient | null, newText?: string, candidates?: { id?: string, text?: string,
 *   score?: number }[], maxTokens?: number }} input 输入
 * @returns {Promise<{ ok: boolean, items: { id: unknown, text: string, score: unknown, relation: string,
 *   reason: string, suggestion: string }[], raw: string, error: string | null }>} 结果
 */
export async function analyzeConflicts({ llm, newText, candidates = [], maxTokens = 1500 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];

  /**
   * 构造「全部按 unrelated 处理」的结果。
   *
   * @param {string} error 失败原因
   * @param {string} raw 模型原始输出（可能为空）
   * @returns {{ ok: boolean, items: Record<string, unknown>[], raw: string, error: string }} 结果
   */
  const allUnrelated = (error, raw = '') => ({
    ok: false,
    items: list.map((candidate) => ({
      id: candidate?.id ?? null,
      text: String(candidate?.text ?? ''),
      score: candidate?.score ?? null,
      relation: 'unrelated',
      reason: UNJUDGED_REASON,
      suggestion: suggestionFor('unrelated'),
    })),
    raw,
    error,
  });

  // 没有候选就没什么可判的：不是失败，也**不调用模型**。
  if (list.length === 0) {
    return { ok: true, items: [], raw: '', error: null };
  }
  if (llm == null || typeof llm.chat !== 'function') {
    return allUnrelated('缺少 llm 接口：需要注入带有 chat() 的客户端');
  }
  if (typeof newText !== 'string' || newText.trim().length === 0) {
    return allUnrelated('newText 为空或全是空白，无法做冲突判定');
  }

  let raw;
  try {
    raw = await llm.chat(buildConflictRequest({ newText, candidates: list, maxTokens }));
  } catch (err) {
    return allUnrelated(`调用模型失败：${describeError(err)}`);
  }

  const rawText = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  /** @type {Map<number, { index: number, relation: string, reason: string }>} */
  const byIndex = new Map();
  for (const relation of parseRelations(rawText, list.length)) {
    byIndex.set(relation.index, relation);
  }

  const items = list.map((candidate, index) => {
    const judged = byIndex.get(index);
    const relation = judged == null ? 'unrelated' : judged.relation;
    return {
      id: candidate?.id ?? null,
      text: String(candidate?.text ?? ''),
      score: candidate?.score ?? null,
      relation,
      reason: judged == null ? UNJUDGED_REASON : judged.reason,
      suggestion: suggestionFor(relation),
    };
  });

  return { ok: true, items, raw: rawText, error: null };
}
