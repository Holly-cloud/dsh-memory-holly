/**
 * dsh-memory · Phase 1：检索内核（关键词 FTS5 + 向量余弦 + RRF 融合）。
 *
 * 三条通路互相独立，可以单独使用、也可以融合：
 * - `keywordSearch`：单段且 ≥3 字走 FTS5 `bm25`；其余（多段、短于 3 字）走 `LIKE` 兜底 ——
 *   `trigram` 分词器对短查询恒不命中，中文两字词极常见，详见该函数的文档；
 * - `vectorSearch`：流式扫描 `vectors` 表，余弦相似度；
 * - `hybridSearch`：RRF（Reciprocal Rank Fusion）**名次**融合，缺哪条就只用另一条，不报错。
 *
 * 三条通路都会**过滤掉已软删的记忆**——软删只是打标记，绝不能从这里漏出去。
 *
 * @module dsh-memory/host/search
 */

/**
 * 余弦相似度。任一为零向量时返回 `0`（而不是 NaN）。
 *
 * @param {Float32Array} a 向量 A
 * @param {Float32Array} b 向量 B
 * @returns {number} 余弦值，范围 `[-1, 1]`
 */
export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  if (n === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * L2 归一化。零向量原样返回（不制造 NaN）。
 *
 * @param {Float32Array | ArrayLike<number>} v 向量
 * @returns {Float32Array} 归一化后的新向量
 */
export function normalizeVector(v) {
  const source = v instanceof Float32Array ? v : Float32Array.from(v ?? []);
  const out = new Float32Array(source.length);
  let norm = 0;
  for (let i = 0; i < source.length; i++) norm += source[i] * source[i];
  if (norm === 0) return out;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < source.length; i++) out[i] = source[i] * inv;
  return out;
}

/**
 * 把用户输入转成 FTS5 查询串。
 *
 * 按空白切成词，每段用双引号包成「短语」，内部的 `"` 双写转义。
 * 这样 `-`、`*`、`:` 等 FTS5 语法字符都退化成普通字符，用户输入永远不会导致语法错误。
 *
 * ⚠️ 只适用于「单段且 ≥3 字」的查询 —— 见 `keywordSearch` 里的分词器边界说明。
 *
 * @param {string} query 原始查询
 * @returns {string} FTS5 MATCH 表达式；没有有效词时返回 `''`
 */
function toMatchExpression(query) {
  const tokens = String(query ?? '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' ');
}

/**
 * 转义 LIKE 通配符。`\` 必须先处理，否则会把后面补的转义符再转一遍。
 *
 * 不转义的话，用户查一个 `%` 就会把整库捞出来；查 `_` 会变成任意单字匹配。
 *
 * @param {string} value 原始片段
 * @returns {string} 可安全放进 `LIKE ? ESCAPE '\'` 的片段
 */
function escapeLike(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * 关键词检索。
 *
 * ## 为什么必须分两条路（实测结论，不要简化回单条 FTS5）
 *
 * FTS5 的 `trigram` 分词器**只对长度 ≥3 的查询有效**。实测：
 * `"冰美式"`(3字)、`记忆宫殿`(4字)、`11434` 都能命中；
 * 而 `宝宝`(2字)、`咖啡`(2字)、`宝`(1字) —— 引号、裸词、前缀 `*` 三种写法**全部返回空**。
 * 中文里两字词极常见（宝宝/咖啡/偏好/记忆/端口…），所以只用 FTS5 会**静默漏掉大部分中文查询**。
 *
 * 因此：
 * - **单段且 ≥3 字** → FTS5 `bm25` 排序（相关性最好）；
 * - **其余情况**（含多段、短于 3 字）→ `LIKE '%词%'` 兜底，多词之间 **AND**。
 *   实测 5000 行全表 LIKE 仅 0.1 ms，代价可以忽略。
 *
 * 两条路的 `score` 尺度不同（bm25 分 vs 常量 1），这**没关系**：
 * 融合用的是 `reciprocalRankFusion`，只用**名次**，不比较原始分值。
 * 千万不要改成「按分值加权求和」。
 *
 * @param {import('./store.js').MemoryStore} store 记忆仓储
 * @param {{ query: string, limit?: number, scope?: string | null }} options 查询
 * @returns {{ id: string, score: number }[]} 命中列表（FTS5 路为 `-bm25`，LIKE 路为常量 `1`）
 */
export function keywordSearch(store, { query, limit = 50, scope = null } = {}) {
  const text = String(query ?? '').trim();
  if (text === '') return [];
  const max = Math.max(0, Number(limit) || 0);
  if (max === 0) return [];

  const terms = text.split(/\s+/).filter((term) => term.length > 0);
  const db = store.db;

  // 只有「单段且 ≥3 字」才交给 trigram。
  if (terms.length === 1 && terms[0].length >= 3) {
    const match = toMatchExpression(text);
    if (match !== '') {
      const params = [match];
      let sql = `SELECT m.id AS id, -bm25(memories_fts) AS score
                 FROM memories_fts
                 JOIN memories AS m ON m.rowid = memories_fts.rowid
                 WHERE memories_fts MATCH ? AND m.deleted_at IS NULL`;
      if (scope != null) {
        sql += ' AND m.scope = ?';
        params.push(String(scope));
      }
      sql += ' ORDER BY bm25(memories_fts) ASC LIMIT ?';
      params.push(max);
      return db
        .prepare(sql)
        .all(...params)
        .map((row) => ({ id: String(row.id), score: Number(row.score) }));
    }
  }

  // 兜底：逐词 LIKE + AND。相关性排序交给出题方（向量路）与 RRF。
  const params = [];
  let sql = 'SELECT m.id AS id FROM memories AS m WHERE m.deleted_at IS NULL';
  if (scope != null) {
    sql += ' AND m.scope = ?';
    params.push(String(scope));
  }
  for (const term of terms) {
    sql += " AND m.text LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(term)}%`);
  }
  sql += ' ORDER BY m.created_at DESC, m.id ASC LIMIT ?';
  params.push(max);
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ id: String(row.id), score: 1 }));
}

/**
 * 向量检索：在**一个空间内**流式扫描 `vectors`（按 `batchSize` 分批），归一化后算余弦。
 *
 * ⚠ 必须按 `space` 过滤：库里同时保留着多套向量（换模型时旧的不删），
 * 不过滤就会把「别的模型算的向量」拿去和「当前查询向量」比余弦 —— 那种分数没有意义，
 * 还会让结果看起来「模模糊糊地能搜到」，掩盖「这个空间还没补齐」这件事。
 *
 * 已软删的记忆会被跳过（即使它的向量还在）。
 * 查询向量为零向量时返回空数组（余弦全是 0，排序没有意义）。
 *
 * @param {import('./store.js').MemoryStore} store 记忆仓储
 * @param {{ queryVector: Float32Array, limit?: number, scope?: string | null,
 *   space?: string | null, model?: string | null, dims?: number | null }} options 查询
 * @returns {{ id: string, score: number }[]} 命中列表，按相似度降序
 */
export function vectorSearch(store, { queryVector, limit = 50, scope = null, space = null, model = null, dims = null } = {}) {
  if (!queryVector) return [];
  const probe = normalizeVector(queryVector);
  let probeNorm = 0;
  for (let i = 0; i < probe.length; i++) probeNorm += probe[i] * probe[i];
  if (probeNorm === 0) return [];

  /** @type {{ id: string, score: number }[]} */
  const scored = [];
  for (const { memoryId, vector } of store.listVectors({ space, model, dims })) {
    if (vector.length !== probe.length) continue; // 维度对不上的残留向量直接跳过
    scored.push({ id: memoryId, score: cosineSimilarity(probe, vector) });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const max = Math.max(0, Number(limit) || 0);
  /** @type {{ id: string, score: number }[]} */
  const out = [];
  for (const candidate of scored) {
    if (out.length >= max) break;
    const memory = store.getMemory(candidate.id);
    if (memory == null) continue; // 软删或已硬删
    if (scope != null && memory.scope !== scope) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * Reciprocal Rank Fusion：把多路「名次」融合成一个分数。
 *
 * `score = Σ weight_list * 1 / (k + rank)`，`rank` 从 1 开始。
 *
 * @param {{ name: string, items: { id: string, score: number }[] }[]} lists 各路结果
 * @param {{ k?: number, weights?: Record<string, number> | null }} [options] 融合参数
 * @returns {{ id: string, score: number, parts: Record<string, { rank: number, weight: number, score: number, contribution: number }> }[]} 融合结果（降序）
 */
export function reciprocalRankFusion(lists, { k = 60, weights = null } = {}) {
  /** @type {Map<string, { id: string, score: number, parts: Record<string, { rank: number, weight: number, score: number, contribution: number }> }>} */
  const acc = new Map();

  for (const list of lists ?? []) {
    if (list == null) continue;
    const name = String(list.name ?? '');
    const weight = Number(weights?.[name] ?? 1);
    const items = Array.isArray(list.items) ? list.items : [];
    items.forEach((item, index) => {
      const id = String(item.id);
      const rank = index + 1;
      const contribution = weight * (1 / (k + rank));
      let entry = acc.get(id);
      if (entry == null) {
        entry = { id, score: 0, parts: {} };
        acc.set(id, entry);
      }
      entry.score += contribution;
      entry.parts[name] = { rank, weight, score: Number(item.score ?? 0), contribution };
    });
  }

  return [...acc.values()].sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 关键词通路在 `parts` 里的名字。 */
export const KEYWORD_LIST = 'keyword';

/** 向量通路在 `parts` 里的名字。 */
export const VECTOR_LIST = 'vector';

/**
 * 混合检索：关键词 + 向量，RRF 融合后截断。
 *
 * 行为约定：
 * - `query` 与 `queryVector` **都缺** → 抛错（没有检索依据）；
 * - 只有关键词 → 只用关键词，不报错；只有向量同理；
 * - `keywordScore` / `vectorScore` 是各自通路的**原始分**（该通路缺席时为 0），
 *   `score` 是融合分，`parts` 是每路的名次/权重/原始分/贡献明细。
 *
 * @param {import('./store.js').MemoryStore} store 记忆仓储
 * @param {{ query?: string | null, queryVector?: Float32Array | null, limit?: number, scope?: string | null,
 *   space?: string | null, k?: number, keywordWeight?: number, vectorWeight?: number, minScore?: number }} [options] 查询
 * @returns {{ id: string, score: number, keywordScore: number, vectorScore: number,
 *   parts: Record<string, unknown> }[]} 融合结果
 */
export function hybridSearch(store, {
  query = null,
  queryVector = null,
  limit = 8,
  scope = null,
  space = null,
  k = 60,
  keywordWeight = 1,
  vectorWeight = 1,
  minScore = 0,
} = {}) {
  const hasQuery = typeof query === 'string' && query.trim().length > 0;
  const hasVector = queryVector != null;
  if (!hasQuery && !hasVector) {
    throw new Error('hybridSearch：query 与 queryVector 至少要提供一个');
  }

  // 融合需要比最终条数更宽的候选池，否则某一路的次优结果会被过早截断。
  const poolSize = Math.max(Number(limit) || 0, 1) * 4;
  /** @type {{ name: string, items: { id: string, score: number }[] }[]} */
  const lists = [];
  if (hasQuery) {
    lists.push({ name: KEYWORD_LIST, items: keywordSearch(store, { query, limit: poolSize, scope }) });
  }
  if (hasVector) {
    lists.push({ name: VECTOR_LIST, items: vectorSearch(store, { queryVector, limit: poolSize, scope, space }) });
  }

  const weights = { [KEYWORD_LIST]: Number(keywordWeight) || 0, [VECTOR_LIST]: Number(vectorWeight) || 0 };
  const fused = reciprocalRankFusion(lists, { k, weights });

  return fused
    .filter((entry) => entry.score >= (Number(minScore) || 0))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((entry) => ({
      id: entry.id,
      score: entry.score,
      keywordScore: Number(entry.parts[KEYWORD_LIST]?.score ?? 0),
      vectorScore: Number(entry.parts[VECTOR_LIST]?.score ?? 0),
      parts: entry.parts,
    }));
}
