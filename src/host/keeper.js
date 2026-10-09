/**
 * dsh-memory · 仓管（Keeper）的纯逻辑：拆细提示词、无损校验、保底切分、判重解析。
 *
 * 需求原话：「内置一个 LLM …它将成为记忆系统的『仓管』，负责对已录入的所有记忆进行二次消化、
 * 对已录入但大段的记忆进行**无损研磨**」。用户明确选了**改写原文、原文只留 history**，
 * 所以「无损」不能只靠提示词承诺 —— 这里用两道代码兜底：
 *
 *   1. `coverageOf()`：拆出来的碎片必须是原文的**子序列**（顺序保留、不丢字），
 *      覆盖率 < `LOSSLESS_RATIO`（98%）就是**不可信输出**；
 *   2. `losslessSplit()`：不可信时**不给模型第二次机会**，直接按句/段确定性切分 ——
 *      它按构造就是无损的（一个字符都不掉）。
 *
 * 也就是说：**模型只负责「切得漂亮」，代码负责「一个字都不能少」。**
 *
 * @module dsh-memory/host/keeper
 */

/** 无损判定的覆盖率阈值。低于它就用确定性切分兜底。 */
export const LOSSLESS_RATIO = 0.98;

/** 确定性切分的默认单块上限。 */
export const DEFAULT_SPLIT_CHARS = 400;

export const GRIND_PROMPT = `你是记忆整理员。用户会给一段较长的记忆原文，请把它拆成若干条**原子事实**。
铁律（违反即作废，系统会用代码逐字核对）：
1. **一个字都不能丢**：只能切分、不能改写、不能总结、不能润色、不能翻译、不能补充；
2. **一个字都不能加**：不要加标题、序号、解释、评论、马克笔；
3. 拆出来的碎片**按原顺序**拼接，应当能还原原文的全部文字（标点也保留）；
4. 每条碎片自成一句、只讲一件事，尽量 20–120 字；
5. 只输出一个 JSON 字符串数组，形如 ["第一条","第二条"]，不要输出任何其它内容。
如果原文本来就只有一件事、无法再拆，就原样输出一个只含它的数组。`;

export const DEDUPE_PROMPT = `你是记忆去重员。用户会给两条已有记忆 A 与 B，请判断它们是否在说**同一件事**。
规则：
- 只有「同一件事、只是说法/详略不同」才算 same=true；
- 具体事件、经历、里程碑、不同时间的同类事实，即使是同一主题也必须 same=false；
- 一条包含另一条时：若 A 更完整、B 是它的子集，same=true 且 keep="a"；反之 keep="b"；
- 输出 JSON 对象：{"same": true|false, "keep": "a"|"b"|null, "reason": "一句话理由"}，不要输出任何其它内容。`;

/**
 * 拼拆细请求。
 *
 * @param {{text: string, maxChars?: number}} input 输入
 * @returns {{messages: {role: string, content: string}[], temperature: number, maxTokens: number}} 请求
 */
export function buildGrindRequest({ text, maxChars = DEFAULT_SPLIT_CHARS } = {}) {
  return {
    messages: [
      { role: 'system', content: GRIND_PROMPT },
      {
        role: 'user',
        content: `单块尽量不超过 ${Math.max(80, Number(maxChars) || DEFAULT_SPLIT_CHARS)} 字。原文如下（两个 <原文> 之间，原样处理）：\n<原文>\n${String(text ?? '')}\n</原文>`,
      },
    ],
    temperature: 0,
    maxTokens: 2000,
  };
}

/**
 * 拼判重请求。
 *
 * @param {{a: string, b: string}} input 两条记忆
 * @returns {{messages: {role: string, content: string}[], temperature: number, maxTokens: number}} 请求
 */
export function buildDedupeRequest({ a, b } = {}) {
  return {
    messages: [
      { role: 'system', content: DEDUPE_PROMPT },
      { role: 'user', content: `A：${String(a ?? '')}\n\nB：${String(b ?? '')}` },
    ],
    temperature: 0,
    maxTokens: 300,
  };
}

/**
 * 从模型输出里抠出 JSON 数组（其它文字一律忽略）。
 *
 * @param {unknown} raw 模型输出
 * @returns {string[]} 碎片数组（保持顺序、去重、丢掉空串）
 */
export function parseFragments(raw) {
  if (typeof raw !== 'string') return [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (match == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text === '') continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 解析判重结论。
 *
 * @param {unknown} raw 模型输出
 * @returns {{same: boolean, keep: 'a'|'b'|null, reason: string, ok: boolean}} 结论
 */
export function parseDedupe(raw) {
  const failed = { same: false, keep: null, reason: '', ok: false };
  if (typeof raw !== 'string') return failed;
  const match = raw.match(/\{[\s\S]*\}/);
  if (match == null) return failed;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return failed;
  }
  if (parsed == null || typeof parsed !== 'object') return failed;
  const keep = parsed.keep === 'a' || parsed.keep === 'b' ? parsed.keep : null;
  return {
    same: parsed.same === true,
    keep,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    ok: true,
  };
}

/**
 * 覆盖率：`fragments` 按顺序拼起来之后，原文（去空白）有多少比例的字符被**按序**覆盖。
 *
 * 判定方式是最朴素的子序列匹配 —— 只要碎片是原文的切分，覆盖率就是 1；
 * 模型但凡改写/丢字/换词，覆盖率立刻掉下来。这是「无损」能不能信的判据。
 *
 * @param {string} original 原文
 * @param {string[]} fragments 碎片
 * @returns {{ok: boolean, ratio: number, matched: number, total: number}} 结论
 */
export function coverageOf(original, fragments) {
  const target = String(original ?? '').replace(/\s+/g, '');
  const joined = (Array.isArray(fragments) ? fragments : [])
    .map((piece) => String(piece ?? '').replace(/\s+/g, ''))
    .join('');
  if (target === '') return { ok: true, ratio: 1, matched: 0, total: 0 };

  let cursor = 0;
  for (let i = 0; i < joined.length && cursor < target.length; i += 1) {
    if (joined[i] === target[cursor]) cursor += 1;
  }
  const ratio = cursor / target.length;
  return { ok: ratio >= LOSSLESS_RATIO, ratio, matched: cursor, total: target.length };
}

/**
 * 确定性切分（**保底**，按构造无损）：优先在句末标点/换行处断开，合并到 ≤ `maxChars`；
 * 单句超长时硬切。**不丢任何字符**（除首尾空白）。
 *
 * @param {string} text 原文
 * @param {{maxChars?: number}} [options] 选项
 * @returns {string[]} 碎片
 */
export function losslessSplit(text, { maxChars = DEFAULT_SPLIT_CHARS } = {}) {
  // 下限只兜「小到没意义的入参」；再小也必须**尊重调用方给的额度**（否则「单块 ≤ N 字」就成了假话）。
  const limit = Math.max(20, Number(maxChars) || DEFAULT_SPLIT_CHARS);
  const source = String(text ?? '').trim();
  if (source === '') return [];
  if (source.length <= limit) return [source];

  // 按「句末标点 + 换行」切开，但**保留分隔符**，保证拼接能还原。
  const units = source.match(/[^。！？；\n]+[。！？；\n]*|\n/g) ?? [source];
  /** @type {string[]} */
  const out = [];
  let buffer = '';
  const flush = () => {
    const piece = buffer.trim();
    if (piece !== '') out.push(piece);
    buffer = '';
  };
  for (const unit of units) {
    let rest = unit;
    while (rest.length > limit) {
      flush();
      out.push(rest.slice(0, limit).trim());
      rest = rest.slice(limit);
    }
    if (buffer.length + rest.length <= limit) buffer += rest;
    else {
      flush();
      buffer = rest;
    }
  }
  flush();
  return out;
}

/**
 * 一条记忆要不要（重新）研磨。
 *
 * 已经研磨过的会带 `meta.keeper.<mode>` 标记；`redo=true` 时才重来一遍。
 *
 * @param {{text?: string, meta?: object}} row 记忆行（`meta` 已解析）
 * @param {{mode?: 'grind'|'digest', minChars?: number, redo?: boolean}} [options] 选项
 * @returns {{candidate: boolean, reason: string}} 结论
 */
export function grindCandidate(row, { mode = 'grind', minChars = 240, redo = false } = {}) {
  const text = String(row?.text ?? '');
  const meta = row?.meta != null && typeof row.meta === 'object' ? row.meta : {};
  const keeper = meta.keeper != null && typeof meta.keeper === 'object' ? meta.keeper : {};
  if (redo !== true && (keeper.grind != null || keeper.digest != null)) {
    return { candidate: false, reason: `已${keeper.grind != null ? '研磨' : '消化'}过` };
  }
  if (meta.derivedFrom != null) return { candidate: false, reason: '这是研磨产物，不再研磨' };
  if (text.trim().length < Math.max(1, Number(minChars) || 1)) {
    return { candidate: false, reason: `只有 ${text.trim().length} 字，没到大段阈值` };
  }
  return { candidate: true, reason: `${text.trim().length} 字${mode === 'digest' ? '（消化）' : ''}` };
}

/**
 * 一组的**硬墙钟预算**（毫秒）—— 安全网，不是正常路径的预算。
 *
 * 为什么需要它（2026-10-08 真机实测）：`keeper.timeoutMs` 只约束**单次请求**，而一组最坏会打
 * 两次（超时重试一次）→ 一组可以卡 2×240s；再加上接手模型那次，一轮里卡十几分钟是有可能的。
 * 但**不能把网收得太紧**：同一次实测里，正常的一组（5 条记忆、2000 token 的 JSON）跑了
 * **231 秒**才成功 —— 设 90 秒会把正常成果直接杀掉。所以默认取**档案超时的 2 倍**：
 * 正常慢请求照旧跑完（它自己受 `timeoutMs` 约束），只有"彻底不回来"才会被这张网兜住。
 *
 * @param {{groupTimeoutMs?: number, requestTimeoutMs?: number, factor?: number}} [input] 选项
 * @returns {number} 毫秒；`0` = 不设上限（配置里两边都没给正数时）
 */
export function groupDeadlineMs({ groupTimeoutMs = 0, requestTimeoutMs = 0, factor = 2 } = {}) {
  const explicit = Number(groupTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const base = Number(requestTimeoutMs);
  if (Number.isFinite(base) && base > 0) {
    const scaled = Number(factor);
    return Math.trunc(base * (Number.isFinite(scaled) && scaled > 0 ? scaled : 2));
  }
  return 0;
}
