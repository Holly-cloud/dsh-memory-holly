/**
 * dsh-memory · Phase 1：`MemoryStore` —— 全部持久化读写的唯一入口。
 *
 * 约定（Phase 2–5 会直接依赖）：
 * - 所有时间戳都由构造函数注入的 `now()` 生成，测试可注入固定时钟；
 * - 所有写操作都在事务里（`withTransaction`，可嵌套）；
 * - `meta` 列以 JSON 字符串存库，读出来时解析回对象（解析失败给 `{}`）；
 * - 软删只是填 `deleted_at`，行仍在表里，但不出现在任何「正常」查询里。
 *
 * @module dsh-memory/host/store
 */

import { createHash, randomUUID } from 'node:crypto';
import { spaceKeyOf, withTransaction } from './db.js';

/**
 * 文本指纹：sha256 十六进制。作为「同一句话」的判重依据。
 *
 * @param {string} text 原文
 * @returns {string} 64 位十六进制摘要
 */
export function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 把时间值规范成 ISO 字符串。
 *
 * @param {Date | string | null | undefined} value 时间
 * @returns {string | null} ISO 字符串
 */
function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * 解析 meta 列。
 *
 * @param {string | null | undefined} raw 存库的 JSON 字符串
 * @returns {Record<string, unknown>} 对象；解析失败或不是对象时给 `{}`
 */
function parseMeta(raw) {
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 把数据库行变成普通对象（`node:sqlite` 返回的是 null 原型对象）。
 *
 * @param {Record<string, unknown> | undefined} row 数据库行
 * @returns {Record<string, unknown> | null} 普通对象
 */
function plain(row) {
  return row == null ? null : { ...row };
}

/**
 * 把 `memories` 的一行整形为普通对象。
 *
 * 除了解析 `meta`，还把两个行为计数器补上 camelCase 别名：列名是 `read_score` / `tidy_score`，
 * 而工具、面板与测试都读 `readScore` / `tidyScore`（列本身仍在返回值里，不丢原始形状）。
 * 老库/只读句柄万一行里没有这两列，一律按 0 兜底，绝不吐 `undefined`。
 *
 * @param {Record<string, unknown>} row `memories` 的一行
 * @returns {Record<string, unknown>} 整形后的记忆行
 */
function shapeMemory(row) {
  return {
    ...row,
    meta: parseMeta(row.meta),
    readScore: normalizeScore(row.read_score),
    tidyScore: normalizeScore(row.tidy_score),
  };
}

/**
 * 计分列的数值兜底：非有限数字一律当 0（写入与读出两侧共用同一规则）。
 *
 * @param {unknown} value 值
 * @returns {number} 有限数字或 0
 */
function normalizeScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 归一 id 列表：去重、去空、全部转字符串（批量 UPDATE 的 `IN (...)` 参数）。
 *
 * @param {unknown} ids id 数组
 * @returns {string[]} 归一后的 id 列表
 */
function normalizeIdList(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  const seen = new Set();
  for (const value of ids) {
    if (value == null) continue;
    const id = String(value);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 生成 40 字的短预览（stats 的 Top-N 用，比列表预览更短）。
 *
 * @param {unknown} text 原文
 * @returns {string} 预览
 */
function preview40(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** `batch_items` 列名集合（白名单，防止外部 key 直接拼进 SQL）。 */
const BATCH_ITEM_COLUMNS = [
  'state',
  'edited_text',
  'relation',
  'reason',
  'target_id',
  'memory_id',
  'decided_at',
];

/** `jobs` 列名集合（白名单）。 */
const JOB_COLUMNS = ['state', 'total', 'done', 'failed', 'started_at', 'finished_at', 'error', 'detail'];

/**
 * 记忆与向量库的仓储层。
 */
export class MemoryStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db 已打开的数据库句柄（见 `openDatabase`）
   * @param {{ now?: () => Date }} [options] `now` 用于生成所有时间戳
   */
  constructor(db, { now = () => new Date() } = {}) {
    if (db == null) throw new Error('MemoryStore：需要先调用 openDatabase() 得到 db 句柄');
    /** @type {import('node:sqlite').DatabaseSync} */
    this.db = db;
    /** @type {() => Date} */
    this.now = now;
  }

  /** @returns {string} 当前时间戳（ISO 字符串） */
  #stamp() {
    return toIso(this.now());
  }

  /**
   * 文本指纹（实例方法，等价于模块级 `hashText`）。
   *
   * @param {string} text 原文
   * @returns {string} sha256 十六进制
   */
  hashText(text) {
    return hashText(text);
  }

  /**
   * 文本指纹（静态方法，方便不持有 store 的调用方使用）。
   *
   * @param {string} text 原文
   * @returns {string} sha256 十六进制
   */
  static hashText(text) {
    return hashText(text);
  }

  // ------------------------------------------------------------------ 记忆

  /**
   * 新增一条记忆。
   *
   * 判重规则：**同 `hash` 且 `deleted_at IS NULL`** 的既有记录 → 返回 `created: false` 且不新增。
   *
   * @param {{ text: string, scope?: string, source?: string | null, section?: string | null,
   *   kind?: string | null, meta?: Record<string, unknown>, id?: string | null,
   *   createdAt?: Date | string | null, readScore?: number, tidyScore?: number }} input 记忆内容
   *   `readScore` / `tidyScore` 是可选初始分（默认 0）；仓管产出的新记忆用 `tidyScore: 1`。
   * @returns {{ id: string, created: boolean }} 记忆 id 与是否真的新建
   */
  addMemory({
    text,
    scope = 'default',
    source = null,
    section = null,
    kind = null,
    meta = {},
    id = null,
    createdAt = null,
    readScore = 0,
    tidyScore = 0,
  } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('addMemory：text 必须是非空字符串');
    }

    const hash = hashText(text);
    const existing = this.db
      .prepare('SELECT id FROM memories WHERE hash = ? AND deleted_at IS NULL LIMIT 1')
      .get(hash);
    if (existing) return { id: String(existing.id), created: false };

    const memoryId = id == null ? randomUUID() : String(id);
    const stamp = toIso(createdAt) ?? this.#stamp();
    const readStart = normalizeScore(readScore);
    const tidyStart = normalizeScore(tidyScore);

    return withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO memories(id, text, scope, source, section, kind, meta, hash, created_at, updated_at, deleted_at, revision, read_score, tidy_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .run(
          memoryId,
          text,
          scope ?? 'default',
          source,
          section,
          kind,
          JSON.stringify(meta ?? {}),
          hash,
          stamp,
          stamp,
          readStart,
          tidyStart,
        );
      this.#writeHistory({ at: stamp, memoryId, op: 'add', prevText: null, nextText: text, note: null });
      return { id: memoryId, created: true };
    });
  }

  /**
   * 按 id 取一条记忆。
   *
   * @param {string} id 记忆 id
   * @param {{ includeDeleted?: boolean }} [options] 是否允许返回已软删的记录
   * @returns {Record<string, unknown> | null} 记忆行（`meta` 已解析为对象）
   */
  getMemory(id, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id));
    if (row == null) return null;
    if (!includeDeleted && row.deleted_at != null) return null;
    return shapeMemory(row);
  }

  /**
   * 分页列出记忆（按 `created_at` 倒序）。
   *
   * @param {{ limit?: number, offset?: number, scope?: string | null, includeDeleted?: boolean }} [options] 过滤条件
   * @returns {{ total: number, items: Record<string, unknown>[] }} 总数与当前页
   */
  listMemories({ limit = 20, offset = 0, scope = null, includeDeleted = false } = {}) {
    const { where, params } = this.#memoryWhere({ scope, includeDeleted });
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS c FROM memories ${where}`).get(...params).c,
    );
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.max(0, Number(limit) || 0), Math.max(0, Number(offset) || 0));
    return { total, items: rows.map(shapeMemory) };
  }

  /**
   * 统计记忆条数。
   *
   * @param {{ scope?: string | null, includeDeleted?: boolean }} [options] 过滤条件
   * @returns {number} 条数
   */
  countMemories({ scope = null, includeDeleted = false } = {}) {
    const { where, params } = this.#memoryWhere({ scope, includeDeleted });
    return Number(this.db.prepare(`SELECT COUNT(*) AS c FROM memories ${where}`).get(...params).c);
  }

  /**
   * 同步取「常驻索引」的候选（读取侧 Layer 0，只读）。
   *
   * 两个桶分开取，因为「最近入库」按 rowid 倒序，**旧但重要的基线行**（旧 `USER.md` / `MEMORY.md`
   * 导入的那批）根本排不进来：
   *   - `pinned`：显式 `meta.pin === true`、人写的（`kind=manual|note`）、旧基线（`source` 以
   *     `热区基线/USER.md` / `热区基线/MEMORY.md` 开头）—— 这批**不参与排序竞争**，先占槽；
   *   - `recent`：其余活记忆，按 `read_score DESC, rowid DESC`（确定性：不用每轮微变的分数排序）。
   *
   * ⚠️ 本机 1362 条的 `created_at` 全落在 2026-10-06~07（一次批量导入）——**mtime 不能当新鲜度**，
   * 所以这里也不用它排序（见 `src/host/recall.js` 的 `contentDate()`）。
   *
   * @param {{pinnedLimit?: number, recentLimit?: number}} [options] 两个桶的上限。
   * @returns {{pinned: object[], recent: object[], total: number}} 候选与库里活条数。
   */
  listIndexCandidatesSync({ pinnedLimit = 120, recentLimit = 200 } = {}) {
    const rows = this.db
      .prepare(
        // `rowid` 显式取出来：`SELECT *` **不含**隐式 rowid，而确定性排序要拿它兜底。
        `SELECT rowid AS rowid, * FROM memories WHERE deleted_at IS NULL
           AND (meta LIKE '%"pin":%' OR kind IN ('manual','note')
                OR source LIKE '热区基线/USER.md%' OR source LIKE '热区基线/MEMORY.md%')
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(Math.max(0, Number(pinnedLimit) || 0))
      .map(shapeMemory)
      // JSON 里 `"pin":false` 也会命中上面的 LIKE —— 真判据在这边，SQL 只负责缩小范围。
      .filter(
        (row) =>
          row.kind === 'manual' ||
          row.kind === 'note' ||
          row.meta?.pin === true ||
          /^热区基线\/(USER|MEMORY)\.md/.test(String(row.source ?? '')),
      );
    // pinned **内部**也要有序：显式 pin → 人写的 → 旧 USER.md（身份/关系）→ 旧 MEMORY.md（索引），
    // 同档按 rowid 倒序。真机干跑时正是这一步缺失，让"档案味"的条目挤掉了人写的约定。
    const rank = (row) =>
      row.meta?.pin === true ? 0 : row.kind === 'manual' || row.kind === 'note' ? 1 : /^热区基线\/USER\.md/.test(String(row.source ?? '')) ? 2 : 3;
    rows.sort((a, b) => rank(a) - rank(b) || Number(b.rowid ?? 0) - Number(a.rowid ?? 0));
    const recent = this.db
      .prepare('SELECT rowid AS rowid, * FROM memories WHERE deleted_at IS NULL ORDER BY read_score DESC, rowid DESC LIMIT ?')
      .all(Math.max(0, Number(recentLimit) || 0))
      .map(shapeMemory);
    return { pinned: rows, recent, total: this.countMemories() };
  }

  /**
   * 同步按子串找候选（读取侧 Layer 1 注入期用，只读）。
   *
   * 为什么不用 `searchText()`：注入发生在 `systemPrompt.context` 的 provider 里，**那是同步函数**，
   * 不能 await embedding 检索；而且每步都打一次 embedding 会给每个 step 加延迟与费用。
   * 这里用 LIKE 扫活记忆（本机 1356 行 ≈ 毫秒级），再在 JS 里按覆盖度打分 —— 零网络、零 embedding。
   *
   * @param {string[]} terms 子串列表（调用方 `pickTerms()` 已挑好词）。
   * @param {{limit?: number}} [options] 候选上限。
   * @returns {object[]} 命中的活记忆（按 rowid 倒序 = 新→旧）。
   */
  searchBySubstringsSync(terms, { limit = 400 } = {}) {
    const words = (Array.isArray(terms) ? terms : [])
      .filter((term) => typeof term === 'string' && term.trim() !== '')
      .slice(0, 24);
    if (words.length === 0) return [];
    const where = words.map(() => 'text LIKE ?').join(' OR ');
    return this.db
      .prepare(`SELECT * FROM memories WHERE deleted_at IS NULL AND (${where}) ORDER BY rowid DESC LIMIT ?`)
      .all(...words.map((word) => `%${word}%`), Math.max(1, Number(limit) || 0))
      .map(shapeMemory);
  }

  /**
   * 按 scope 分组统计条数（面板/工具里回答「都记在哪个 scope」）。
   *
   * @returns {{ scope: string, count: number }[]} 分组计数（按条数降序）
   */
  countByScope() {
    return this.db
      .prepare('SELECT scope, COUNT(*) AS c FROM memories WHERE deleted_at IS NULL GROUP BY scope ORDER BY c DESC, scope ASC')
      .all()
      .map((row) => ({ scope: String(row.scope), count: Number(row.c) }));
  }

  // -------------------------------------------------------- 行为计分（v4）

  /**
   * 读取指数批量 +1（**一条 SQL**，不是 N 次 UPDATE）。
   *
   * 触发口径：`memory_search` 命中的每一条、`memory_get` 取的那一条。
   * **列表 / 面板浏览 / 仓管内部召回都不算**（调用方负责只在工具路径上调它）。
   *
   * @param {unknown} ids 记忆 id 数组（内部去重、丢空）
   * @returns {number} 实际更新的行数
   */
  bumpReadScores(ids) {
    return this.#bumpScores('read_score', ids);
  }

  /**
   * 整理指数批量 +1（**一条 SQL**）。
   *
   * 触发口径：一条记忆**被抽进仓管的一组**（种子或被 embedding 召回当邻居）时 +1；
   * 同一轮里同一 id 只算一次（由调用方去重）。
   *
   * @param {unknown} ids 记忆 id 数组（内部去重、丢空）
   * @returns {number} 实际更新的行数
   */
  bumpTidyScores(ids) {
    return this.#bumpScores('tidy_score', ids);
  }

  /**
   * 全库两个计分器同乘一个系数（每周衰减用）。
   *
   * **全体同乘**，所以任意两条之间的比例严格不变（`a/b` 不变，只有绝对值缩水）——
   * 这正是「保持原比例不变的小幅度下降」的含意。
   *
   * @param {number} factor 系数（> 0）
   * @returns {number} 更新的行数
   */
  decayScores(factor) {
    const value = Number(factor);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`decayScores：factor 必须是正数（收到 ${JSON.stringify(factor)}）`);
    }
    const info = this.db
      .prepare('UPDATE memories SET read_score = read_score * ?, tidy_score = tidy_score * ?')
      .run(value, value);
    return Number(info.changes);
  }

  /**
   * 计分聚合（`memory_stats` 与面板概览用）。
   *
   * 只统计**未软删**的记忆；`avgRead` / `avgTidy` 是每条的平均值（没有记忆时给 0）。
   * `topRead` / `topTidy` 各取前 `top` 条，`preview` 截 40 字。
   *
   * @param {{ top?: number }} [options] Top-N 的 N（默认 5；0 = 不要 Top）
   * @returns {{ count: number, totalRead: number, totalTidy: number, avgRead: number, avgTidy: number,
   *   topRead: { id: string, preview: string, readScore: number }[],
   *   topTidy: { id: string, preview: string, tidyScore: number }[] }} 聚合
   */
  scoreStats({ top = 5 } = {}) {
    const limit = Math.max(0, Math.trunc(Number(top) || 0));
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(read_score), 0) AS total_read, COALESCE(SUM(tidy_score), 0) AS total_tidy
         FROM memories WHERE deleted_at IS NULL`,
      )
      .get();
    const count = Number(totals.count);
    const totalRead = Number(totals.total_read);
    const totalTidy = Number(totals.total_tidy);

    // Top-N 用两条固定 SQL（不拼列名）：`created_at` 兜底让同分条目有稳定顺序。
    const topRead = limit === 0
      ? []
      : this.db
          .prepare(
            `SELECT id, text, read_score FROM memories WHERE deleted_at IS NULL
             ORDER BY read_score DESC, created_at DESC, id ASC LIMIT ?`,
          )
          .all(limit)
          .map((row) => ({ id: String(row.id), preview: preview40(row.text), readScore: normalizeScore(row.read_score) }));
    const topTidy = limit === 0
      ? []
      : this.db
          .prepare(
            `SELECT id, text, tidy_score FROM memories WHERE deleted_at IS NULL
             ORDER BY tidy_score DESC, created_at DESC, id ASC LIMIT ?`,
          )
          .all(limit)
          .map((row) => ({ id: String(row.id), preview: preview40(row.text), tidyScore: normalizeScore(row.tidy_score) }));

    return {
      count,
      totalRead,
      totalTidy,
      avgRead: count === 0 ? 0 : totalRead / count,
      avgTidy: count === 0 ? 0 : totalTidy / count,
      topRead,
      topTidy,
    };
  }

  /**
   * 批量给某一列 +1 的内部实现。列名走**白名单**，绝不把外部字符串拼进 SQL。
   *
   * @param {'read_score' | 'tidy_score'} column 计分列
   * @param {unknown} ids 记忆 id 数组
   * @returns {number} 实际更新的行数
   */
  #bumpScores(column, ids) {
    if (column !== 'read_score' && column !== 'tidy_score') {
      throw new Error(`bumpScores：未知的计分列 ${JSON.stringify(column)}`);
    }
    const list = normalizeIdList(ids);
    if (list.length === 0) return 0;
    const placeholders = list.map(() => '?').join(', ');
    const info = this.db
      .prepare(`UPDATE memories SET ${column} = ${column} + 1 WHERE id IN (${placeholders})`)
      .run(...list);
    return Number(info.changes);
  }

  /**
   * 流式遍历全部未删除记忆的正文（嵌入 / 重建索引用，避免一次性把库读进内存）。
   *
   * 用 `rowid` 做键集分页（而不是 OFFSET），遍历期间插入新行也不会漏读或重复。
   *
   * @param {{ scope?: string | null, batchSize?: number }} [options] 过滤条件与批大小
   * @returns {Generator<{ id: string, text: string }>} 生成器
   */
  *listTexts({ scope = null, batchSize = 500 } = {}) {
    const size = Math.max(1, Number(batchSize) || 500);
    const params = [];
    let sql = 'SELECT rowid AS _rowid, id, text FROM memories WHERE deleted_at IS NULL';
    if (scope != null) {
      sql += ' AND scope = ?';
      params.push(scope);
    }
    sql += ' AND rowid > ? ORDER BY rowid LIMIT ?';
    const stmt = this.db.prepare(sql);

    let cursor = 0;
    for (;;) {
      const rows = stmt.all(...params, cursor, size);
      if (rows.length === 0) return;
      for (const row of rows) {
        cursor = Number(row._rowid);
        yield { id: String(row.id), text: String(row.text) };
      }
      if (rows.length < size) return;
    }
  }

  /**
   * 流式遍历「仓管可能要加工」的记忆（**已经加工过的默认跳过**）。
   *
   * 过滤分两层：SQL 里先用 `length(trim(text)) >= minChars` 与 `meta NOT LIKE '%"keeper"%'`
   * 粗筛（走索引/避免把整库读进内存），再由 `keeper.grindCandidate()` 精确判定。
   *
   * @param {{minChars?: number, redo?: boolean, batchSize?: number}} [options] 过滤条件
   * @returns {Generator<{ id: string, text: string, meta: Record<string, unknown> }>} 生成器
   */
  *listKeeperCandidates({ minChars = 1, redo = false, batchSize = 200 } = {}) {
    const size = Math.max(1, Number(batchSize) || 200);
    const stmt = this.db.prepare(
      `SELECT rowid AS _rowid, id, text, meta FROM memories
       WHERE deleted_at IS NULL AND rowid > ? AND length(trim(text)) >= ?
         AND (? = 1 OR meta NOT LIKE '%"keeper"%')
       ORDER BY rowid LIMIT ?`,
    );

    let cursor = 0;
    for (;;) {
      const rows = stmt.all(cursor, Math.max(1, Number(minChars) || 1), redo === true ? 1 : 0, size);
      if (rows.length === 0) return;
      for (const row of rows) {
        cursor = Number(row._rowid);
        yield { id: String(row.id), text: String(row.text), meta: parseMeta(row.meta) };
      }
      if (rows.length < size) return;
    }
  }

  /**
   * 列出仓管留下的痕迹（回滚用）：
   * - `derived`：研磨/消化产出的新记忆（`meta.derivedFrom` 指向原文那条）→ 回滚时真删；
   * - `rewritten`：被研磨**改写过**的原文（`meta.keeper.*`）→ 回滚时按 history 的 prev_text 恢复；
   * - `merged`：做过去重合并的保留条（`meta.merged[]` 记着被软删的 id）→ 回滚时把那些行放回来；
   * - `replaced`：`replace`（删旧录新）产出的**新记忆**（`meta.replaces` = 被替换掉的旧 id）→
   *   回滚时真删新记忆、再把旧 id `restoreMemory()` 放回来。
   *
   * ⚠️ `merged` 与 `replaced` 两桶**都要含已软删的行**（不按 `deleted_at` 过滤）：痕迹本身
   * 可能连同那条记忆一起被软删，但回滚凭据还在——被并 / 被替换的正是靠 deleted_at 藏起来的。
   *
   * @returns {{derived: Record<string, unknown>[], rewritten: Record<string, unknown>[],
   *   merged: Record<string, unknown>[], replaced: Record<string, unknown>[]}} 痕迹
   */
  listKeeperArtifacts() {
    const select = (where) =>
      this.db
        .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY rowid ASC`)
        .all()
        .map(shapeMemory);
    return {
      derived: select(`deleted_at IS NULL AND meta LIKE '%"derivedFrom"%'`),
      rewritten: select(`deleted_at IS NULL AND meta LIKE '%"keeper"%'`),
      // 合并痕迹要**含已软删的行**：被并掉的那条正是靠 deleted_at 藏起来的
      merged: select(`meta LIKE '%"merged"%'`),
      // 替换痕迹同理：`replace` 的新记忆可能后来被软删，回滚凭据不能因此消失
      replaced: select(`meta LIKE '%"replaces"%'`),
    };
  }

  /**
   * 改写一条记忆的正文：递增 `revision`、刷新 `updated_at`、写一条 `supersede` 历史，
   * 并**删掉它在所有空间里的向量**。
   *
   * 为什么必须删向量：向量是「这段文本」的派生物。正文一改，旧向量既不描述新内容，
   * 又不会被 `countMissingVectors` 算作缺（它只看有没有向量行）—— 结果是语义检索
   * 一直按旧文本的名次出结果，而增量补齐永远修不掉它。调用方（审阅门 / 清洗）
   * 拿到的返回值里带 `vectorsDeleted`，据此把这条重新排进嵌入队列。
   *
   * @param {string} id 记忆 id
   * @param {string} nextText 新正文
   * @param {{ note?: string | null, meta?: Record<string, unknown> | null }} [options] 备注与替换 meta
   * @returns {Record<string, unknown> & { vectorsDeleted: number }} 更新后的记忆行
   */
  updateMemoryText(id, nextText, { note = null, meta = null } = {}) {
    if (typeof nextText !== 'string' || nextText.length === 0) {
      throw new Error('updateMemoryText：nextText 必须是非空字符串');
    }
    const current = this.getMemory(id, { includeDeleted: true });
    if (current == null) throw new Error(`updateMemoryText：记忆不存在（${id}）`);
    if (current.deleted_at != null) throw new Error(`updateMemoryText：记忆已软删（${id}），不能改写`);

    const stamp = this.#stamp();
    return withTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE memories SET text = ?, hash = ?, meta = ?, updated_at = ?, revision = revision + 1
           WHERE id = ?`,
        )
        .run(
          nextText,
          hashText(nextText),
          meta == null ? JSON.stringify(current.meta ?? {}) : JSON.stringify(meta),
          stamp,
          String(id),
        );
      this.#writeHistory({
        at: stamp,
        memoryId: String(id),
        op: 'supersede',
        prevText: String(current.text),
        nextText,
        note,
      });
      const vectorsDeleted = Number(this.db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(String(id)).changes);
      return { ...this.getMemory(id, { includeDeleted: true }), vectorsDeleted };
    });
  }

  /**
   * 把一条软删的记忆恢复回来（只清 `deleted_at`，正文一个字不动）。
   *
   * 仓管「消化」时把重复项软删（不是真删），回滚就靠它把那些行放回来。
   *
   * @param {string} id 记忆 id
   * @returns {boolean} 是否真的恢复了（不存在或本来就没删时返回 `false`）
   */
  restoreMemory(id) {
    const current = this.getMemory(id, { includeDeleted: true });
    if (current == null || current.deleted_at == null) return false;
    const stamp = this.#stamp();
    return withTransaction(this.db, () => {
      this.db.prepare('UPDATE memories SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(stamp, String(id));
      this.#writeHistory({ at: stamp, memoryId: String(id), op: 'restore', prevText: null, nextText: String(current.text), note: 'restore' });
      return true;
    });
  }

  /**
   * 软删：保留整行与全部历史，只填 `deleted_at`。
   * @param {string} id 记忆 id
   * @param {{ note?: string | null }} [options] 备注
   * @returns {boolean} 是否真的删了（不存在或已软删时返回 `false`）
   */
  softDeleteMemory(id, { note = null } = {}) {
    const current = this.getMemory(id, { includeDeleted: true });
    if (current == null || current.deleted_at != null) return false;

    const stamp = this.#stamp();
    return withTransaction(this.db, () => {
      this.db
        .prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(stamp, stamp, String(id));
      this.#writeHistory({
        at: stamp,
        memoryId: String(id),
        op: 'delete',
        prevText: String(current.text),
        nextText: null,
        note,
      });
      return true;
    });
  }

  /**
   * 硬删：真删行。FTS 由 `memories_fts_ad` 触发器同步，向量由外键级联删除，
   * 历史（无外键）保留。
   *
   * @param {string} id 记忆 id
   * @param {{ note?: string | null }} [options] 备注
   * @returns {boolean} 是否真的删了
   */
  hardDeleteMemory(id, { note = null } = {}) {
    const current = this.getMemory(id, { includeDeleted: true });
    if (current == null) return false;

    const stamp = this.#stamp();
    return withTransaction(this.db, () => {
      this.#writeHistory({
        at: stamp,
        memoryId: String(id),
        op: 'hard_delete',
        prevText: String(current.text),
        nextText: null,
        note,
      });
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(String(id));
      return true;
    });
  }

  /**
   * 读取一条记忆的变更历史（新的在前）。
   *
   * @param {string} memoryId 记忆 id
   * @param {{ limit?: number }} [options] 条数上限
   * @returns {Record<string, unknown>[]} 历史行
   */
  listHistory(memoryId, { limit = 50 } = {}) {
    return this.db
      .prepare('SELECT * FROM history WHERE memory_id = ? ORDER BY id DESC LIMIT ?')
      .all(String(memoryId), Math.max(1, Number(limit) || 50))
      .map(plain);
  }

  // ------------------------------------------------------------------ 向量

  /**
   * 写入（或覆盖）一条记忆在**某个空间**里的向量。`vector` 按 Float32 原始字节存 BLOB。
   *
   * `space` 是必填的：它是 `provider:model:dims` 指纹，也就是「同一套向量」的身份。
   * 同一记忆在**别的**空间里的向量不受影响 —— 这正是「换模型不重算旧空间、切回来只补差」的基础。
   *
   * @param {{ memoryId: string, space: string, provider?: string | null, model: string, dims: number,
   *   vector: Float32Array }} input 向量
   * @returns {void}
   */
  putVector({ memoryId, space, provider = null, model, dims, vector } = {}) {
    if (memoryId == null) throw new Error('putVector：缺少 memoryId');
    if (typeof space !== 'string' || space.length === 0) {
      throw new Error('putVector：space 必须是非空字符串（provider:model:dims 指纹）');
    }
    if (typeof model !== 'string' || model.length === 0) throw new Error('putVector：model 必须是非空字符串');
    const dimsN = Number(dims);
    if (!Number.isInteger(dimsN) || dimsN <= 0) throw new Error(`putVector：dims 必须是正整数（收到 ${dims}）`);
    if (!(vector instanceof Float32Array)) throw new Error('putVector：vector 必须是 Float32Array');
    if (vector.length !== dimsN) {
      throw new Error(`putVector：向量长度 ${vector.length} 与 dims ${dimsN} 不一致`);
    }

    const stamp = this.#stamp();
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO vectors(memory_id, space, provider, model, dims, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(memory_id, space) DO UPDATE SET provider = excluded.provider, model = excluded.model,
             dims = excluded.dims, vec = excluded.vec, updated_at = excluded.updated_at`,
        )
        .run(String(memoryId), space, provider == null ? null : String(provider), model, dimsN, float32ToBlob(vector), stamp);
    });
  }

  /**
   * 取一条记忆在某个空间里的向量。
   *
   * @param {string} memoryId 记忆 id
   * @param {string} space 空间键（`provider:model:dims`）
   * @returns {{ space: string, provider: string | null, model: string, dims: number, vector: Float32Array } | null} 向量或 `null`
   */
  getVector(memoryId, space) {
    if (typeof space !== 'string' || space.length === 0) {
      throw new Error('getVector：space 必须是非空字符串（provider:model:dims 指纹）');
    }
    const row = this.db
      .prepare('SELECT space, provider, model, dims, vec FROM vectors WHERE memory_id = ? AND space = ?')
      .get(String(memoryId), space);
    if (row == null) return null;
    return {
      space: String(row.space),
      provider: row.provider == null ? null : String(row.provider),
      model: String(row.model),
      dims: Number(row.dims),
      vector: blobToFloat32(row.vec),
    };
  }

  /**
   * 删除一条记忆的向量。**省略 `space` = 删掉它在所有空间里的向量**。
   *
   * 默认「全删」是有意的：正文一变（改写 / 清洗 / 软删），**每一套**向量都作废了，
   * 留着会被检索命中，产生「明明改了却还能搜到旧话」的幽灵结果。
   *
   * @param {string} memoryId 记忆 id
   * @param {{ space?: string | null }} [options] 只删某一个空间时给它
   * @returns {number} 删掉的行数
   */
  deleteVector(memoryId, { space = null } = {}) {
    if (space != null) {
      return Number(
        this.db.prepare('DELETE FROM vectors WHERE memory_id = ? AND space = ?').run(String(memoryId), String(space)).changes,
      );
    }
    return Number(this.db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(String(memoryId)).changes);
  }

  /**
   * 删除**整个空间**的向量（只在这个空间的向量确实坏掉时才用）。
   *
   * ⚠ 换嵌入模型时**不要**调它 —— 保留旧空间正是本设计的目的。
   *
   * @param {string} space 空间键
   * @returns {number} 删掉的行数
   */
  deleteVectorsOfSpace(space) {
    if (typeof space !== 'string' || space.length === 0) {
      throw new Error('deleteVectorsOfSpace：space 必须是非空字符串');
    }
    return Number(this.db.prepare('DELETE FROM vectors WHERE space = ?').run(space).changes);
  }

  /**
   * 清空全部向量（**所有**空间）。
   *
   * @returns {number} 删掉的行数
   */
  deleteAllVectors() {
    return Number(this.db.prepare('DELETE FROM vectors').run().changes);
  }

  /**
   * 向量条数。
   *
   * @param {string | null} [space] 省略 = 所有空间
   * @returns {number} 条数
   */
  countVectors(space = null) {
    if (space == null) return Number(this.db.prepare('SELECT COUNT(*) AS c FROM vectors').get().c);
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM vectors WHERE space = ?').get(String(space)).c);
  }

  /**
   * 向量库概况：总数 + **按空间分组**（每个空间一套，互不覆盖）。
   *
   * @returns {{ count: number, spaces: { key: string, provider: string | null, model: string, dims: number, count: number }[] }} 统计
   */
  vectorStats() {
    const count = this.countVectors();
    const spaces = this.db
      .prepare(
        `SELECT space, provider, model, dims, COUNT(*) AS c FROM vectors
         GROUP BY space, provider, model, dims ORDER BY c DESC, space ASC`,
      )
      .all()
      .map((row) => ({
        key: String(row.space),
        provider: row.provider == null ? null : String(row.provider),
        model: String(row.model),
        dims: Number(row.dims),
        count: Number(row.c),
      }));
    return { count, spaces };
  }

  /**
   * 某个空间里**还缺向量**的未删除记忆条数。
   *
   * 这就是「切换配置后要补多少」的答案：0 表示这个空间已经齐了，直接可用。
   *
   * @param {string} space 空间键
   * @returns {number} 条数
   */
  countMissingVectors(space) {
    if (typeof space !== 'string' || space.length === 0) {
      throw new Error('countMissingVectors：space 必须是非空字符串');
    }
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories m
           WHERE m.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.memory_id = m.id AND v.space = ?)`,
        )
        .get(space).c,
    );
  }

  /**
   * 流式遍历某个空间里还缺向量的记忆（**增量补齐**用：只碰缺的，不碰已有的）。
   *
   * @param {string} space 空间键
   * @param {{ batchSize?: number }} [options] 批大小
   * @returns {Generator<{ id: string, text: string }>} 生成器
   */
  *listTextsMissingVector(space, { batchSize = 500 } = {}) {
    if (typeof space !== 'string' || space.length === 0) {
      throw new Error('listTextsMissingVector：space 必须是非空字符串');
    }
    const size = Math.max(1, Number(batchSize) || 500);
    const stmt = this.db.prepare(
      `SELECT m.rowid AS _rowid, m.id AS id, m.text AS text FROM memories m
       WHERE m.deleted_at IS NULL AND m.rowid > ?
         AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.memory_id = m.id AND v.space = ?)
       ORDER BY m.rowid LIMIT ?`,
    );

    let cursor = 0;
    for (;;) {
      const rows = stmt.all(cursor, space, size);
      if (rows.length === 0) return;
      for (const row of rows) {
        cursor = Number(row._rowid);
        yield { id: String(row.id), text: String(row.text) };
      }
      if (rows.length < size) return;
    }
  }

  /**
   * 流式遍历向量，可按空间 / 模型 / 维度过滤。
   *
   * 用 `rowid` 键集分页：`(memory_id, space)` 是复合主键，按 `memory_id` 分页会在
   * 「同一条记忆有多个空间」时漏读——`rowid` 没这个问题。
   *
   * @param {{ space?: string | null, model?: string | null, dims?: number | null, batchSize?: number }} [options] 过滤条件与批大小
   * @returns {Generator<{ memoryId: string, space: string, vector: Float32Array }>} 生成器
   */
  *listVectors({ space = null, model = null, dims = null, batchSize = 512 } = {}) {
    const size = Math.max(1, Number(batchSize) || 512);
    const params = [];
    let sql = 'SELECT rowid AS _rowid, memory_id, space, vec FROM vectors WHERE rowid > ?';
    if (space != null) {
      sql += ' AND space = ?';
      params.push(String(space));
    }
    if (model != null) {
      sql += ' AND model = ?';
      params.push(String(model));
    }
    if (dims != null) {
      sql += ' AND dims = ?';
      params.push(Number(dims));
    }
    sql += ' ORDER BY rowid LIMIT ?';
    const stmt = this.db.prepare(sql);

    let cursor = 0;
    for (;;) {
      const rows = stmt.all(cursor, ...params, size);
      if (rows.length === 0) return;
      for (const row of rows) {
        cursor = Number(row._rowid);
        yield { memoryId: String(row.memory_id), space: String(row.space), vector: blobToFloat32(row.vec) };
      }
      if (rows.length < size) return;
    }
  }

  // ------------------------------------------------------- 向量空间指纹

  /**
   * 读取「最近使用」的向量空间。
   *
   * ⚠ 它只记「上次是谁写的」，**检索/补齐该用哪个空间由当前配置算出来**
   * （`embeddingFingerprint` → `spaceKeyOf`），不要拿这个记录当判据：配置改了但还没补向量时，
   * 两者本来就不一致，而那时正确的行为是「提示需补齐」，不是「继续用旧空间」。
   *
   * @returns {{ key: string, provider: string | null, model: string, dims: number } | null} 空间描述或 `null`
   */
  getActiveSpace() {
    const row = this.db.prepare('SELECT value FROM spaces WHERE key = ?').get('active');
    if (row == null) return null;
    try {
      const parsed = JSON.parse(String(row.value));
      if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string' && parsed.model !== '') {
        const provider = typeof parsed.provider === 'string' && parsed.provider !== '' ? parsed.provider : null;
        const dims = Number(parsed.dims);
        const key =
          typeof parsed.key === 'string' && parsed.key !== ''
            ? parsed.key
            : spaceKeyOf({ provider: provider ?? 'openai', model: parsed.model, dims });
        return { key, provider, model: parsed.model, dims };
      }
    } catch {
      /* 坏值当作没有空间 */
    }
    return null;
  }

  /**
   * 记录当前向量空间（写向量时顺手记一笔，供面板显示）。
   *
   * @param {{ key?: string | null, provider?: string | null, model: string, dims: number }} space 空间描述
   * @returns {string} 归一后的空间键
   */
  setActiveSpace({ key = null, provider = 'openai', model, dims } = {}) {
    if (typeof model !== 'string' || model.length === 0) throw new Error('setActiveSpace：model 必须是非空字符串');
    const dimsN = Number(dims);
    if (!Number.isInteger(dimsN) || dimsN <= 0) throw new Error(`setActiveSpace：dims 必须是正整数（收到 ${dims}）`);
    const providerValue = provider == null ? null : String(provider);
    const spaceKey =
      typeof key === 'string' && key.length > 0 ? key : spaceKeyOf({ provider: providerValue ?? 'openai', model, dims: dimsN });
    this.db
      .prepare('INSERT INTO spaces(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('active', JSON.stringify({ key: spaceKey, provider: providerValue, model, dims: dimsN }));
    return spaceKey;
  }

  // ------------------------------------------------------------- 待审门

  /**
   * 新建一个待审批次。
   *
   * @param {{ model?: string | null, sourceText: string, focused?: boolean, items: (string | { text: string })[] }} input 批次
   * @returns {{ id: string, items: { id: number, idx: number, text: string }[] }} 批次 id 与条目
   */
  createBatch({ model = null, sourceText, focused = false, items } = {}) {
    if (typeof sourceText !== 'string') throw new Error('createBatch：sourceText 必须是字符串');
    if (!Array.isArray(items)) throw new Error('createBatch：items 必须是数组');

    const id = randomUUID();
    const stamp = this.#stamp();
    return withTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO batches(id, created_at, model, source_text, focused, state, decided_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(id, stamp, model, sourceText, focused ? 1 : 0, 'open');

      const insert = this.db.prepare('INSERT INTO batch_items(batch_id, idx, text, state) VALUES (?, ?, ?, ?)');
      /** @type {{ id: number, idx: number, text: string }[]} */
      const created = [];
      items.forEach((item, idx) => {
        const text = typeof item === 'string' ? item : item?.text;
        if (typeof text !== 'string') throw new Error(`createBatch：items[${idx}] 缺少 text`);
        const info = insert.run(id, idx, text, 'pending');
        created.push({ id: Number(info.lastInsertRowid), idx, text });
      });
      return { id, items: created };
    });
  }

  /**
   * 列出批次（默认全部状态，可按状态过滤）。
   *
   * @param {{ state?: string | null }} [options] 状态过滤
   * @returns {{ id: string, createdAt: string, model: string | null, focused: boolean, state: string, count: number, sourcePreview: string }[]} 批次摘要
   */
  listBatches({ state = null } = {}) {
    const params = [];
    let sql = `SELECT b.*, (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id = b.id) AS item_count
               FROM batches b`;
    if (state != null) {
      sql += ' WHERE b.state = ?';
      params.push(String(state));
    }
    sql += ' ORDER BY b.created_at DESC, b.rowid DESC';
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({
        id: String(row.id),
        createdAt: String(row.created_at),
        model: row.model == null ? null : String(row.model),
        focused: Number(row.focused) === 1,
        state: String(row.state),
        count: Number(row.item_count),
        sourcePreview: preview(String(row.source_text)),
      }));
  }

  /**
   * 取一个批次的完整内容（含全部条目）。
   *
   * @param {string} id 批次 id
   * @returns {{ id: string, createdAt: string, model: string | null, focused: boolean, state: string,
   *   sourceText: string, decidedAt: string | null, items: Record<string, unknown>[] } | null} 批次或 `null`
   */
  getBatch(id) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(String(id));
    if (batch == null) return null;
    const items = this.db
      .prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY idx ASC, id ASC')
      .all(String(id))
      .map((row) => ({
        id: Number(row.id),
        idx: Number(row.idx),
        text: String(row.text),
        state: String(row.state),
        editedText: row.edited_text == null ? null : String(row.edited_text),
        relation: row.relation == null ? null : String(row.relation),
        reason: row.reason == null ? null : String(row.reason),
        targetId: row.target_id == null ? null : String(row.target_id),
        memoryId: row.memory_id == null ? null : String(row.memory_id),
        decidedAt: row.decided_at == null ? null : String(row.decided_at),
      }));
    return {
      id: String(batch.id),
      createdAt: String(batch.created_at),
      model: batch.model == null ? null : String(batch.model),
      focused: Number(batch.focused) === 1,
      state: String(batch.state),
      sourceText: String(batch.source_text),
      decidedAt: batch.decided_at == null ? null : String(batch.decided_at),
      items,
    };
  }

  /**
   * 写一条条目的裁决结果。
   *
   * 语义：**传 `null` / `undefined` 表示「保持原值」**，因此只传 `state` 的局部更新是安全的。
   * `state === 'pending'` 会清掉 `decided_at`，其余状态写当前时间。
   *
   * @param {{ itemId: number | string, state?: string, editedText?: string | null, relation?: string | null,
   *   reason?: string | null, targetId?: string | null, memoryId?: string | null }} input 裁决
   * @returns {void}
   */
  setItemDecision({ itemId, state = null, editedText = null, relation = null, reason = null, targetId = null, memoryId = null } = {}) {
    const current = this.db.prepare('SELECT * FROM batch_items WHERE id = ?').get(Number(itemId));
    if (current == null) throw new Error(`setItemDecision：条目不存在（${itemId}）`);

    const next = {
      state: state ?? current.state,
      edited_text: editedText ?? current.edited_text,
      relation: relation ?? current.relation,
      reason: reason ?? current.reason,
      target_id: targetId ?? current.target_id,
      memory_id: memoryId ?? current.memory_id,
      decided_at: (state ?? current.state) === 'pending' ? null : this.#stamp(),
    };

    const assignments = BATCH_ITEM_COLUMNS.map((column) => `${column} = ?`).join(', ');
    this.db
      .prepare(`UPDATE batch_items SET ${assignments} WHERE id = ?`)
      .run(...BATCH_ITEM_COLUMNS.map((column) => next[column]), Number(itemId));
  }

  /**
   * 关闭批次（写 `state` 与 `decided_at`）。
   *
   * @param {string} id 批次 id
   * @param {'approved' | 'rejected'} state 终态
   * @returns {boolean} 是否真的关闭了（不存在或已关闭时返回 `false`）
   */
  closeBatch(id, state) {
    if (state !== 'approved' && state !== 'rejected') {
      throw new Error(`closeBatch：state 只能是 'approved' 或 'rejected'（收到 ${state}）`);
    }
    const info = this.db
      .prepare('UPDATE batches SET state = ?, decided_at = ? WHERE id = ? AND state = ?')
      .run(state, this.#stamp(), String(id), 'open');
    return Number(info.changes) > 0;
  }

  // ------------------------------------------------- 仓管变更单（keeper_plans）

  /**
   * 新建一张仓管变更单。
   *
   * 这是「仓管只出单、不落库」的存储入口：跑一轮仓管**只写这张表**，
   * 记忆正文一个字符都不动；要不要生效由 `review` 之后的执行决定。
   *
   * @param {{id?: string | null, runId?: string | null, seedId?: string | null,
   *   memberIds?: string[], ops?: object[], model?: string | null}} input 变更单
   * @returns {Record<string, unknown>} 建好的变更单（`member_ids` / `ops` 已解析回数组）
   */
  createKeeperPlan({ id = null, runId = null, seedId = null, memberIds = [], ops = [], model = null } = {}) {
    if (!Array.isArray(memberIds)) throw new Error('createKeeperPlan：memberIds 必须是数组');
    if (!Array.isArray(ops)) throw new Error('createKeeperPlan：ops 必须是数组');

    const planId = id == null ? randomUUID() : String(id);
    this.db
      .prepare(
        `INSERT INTO keeper_plans(id, run_id, created_at, state, seed_id, member_ids, ops, reviewed_at, review, note, model)
         VALUES (?, ?, ?, 'open', ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        planId,
        runId == null ? null : String(runId),
        this.#stamp(),
        seedId == null ? null : String(seedId),
        JSON.stringify(memberIds.map((value) => String(value))),
        JSON.stringify(ops),
        // 「谁产出的这张单」：审阅落库时给新记忆盖 `meta.model` 就读它（主/副仓管各署各的名）。
        model == null || String(model).trim() === '' ? null : String(model),
      );
    return this.getKeeperPlan(planId);
  }

  /**
   * 列出变更单（新的在前，可按状态过滤）。
   *
   * @param {{state?: string | null, limit?: number | null}} [options] 过滤条件
   * @returns {Record<string, unknown>[]} 变更单数组
   */
  listKeeperPlans({ state = null, limit = null } = {}) {
    const params = [];
    let sql = 'SELECT * FROM keeper_plans';
    if (state != null) {
      sql += ' WHERE state = ?';
      params.push(String(state));
    }
    sql += ' ORDER BY created_at DESC, rowid DESC';
    if (limit != null && Number(limit) > 0) {
      sql += ' LIMIT ?';
      params.push(Math.max(1, Math.trunc(Number(limit))));
    }
    return this.db.prepare(sql).all(...params).map(shapeKeeperPlan);
  }

  /**
   * 只数变更单条数（`keeperStatus()` 每次调用都要这个数，而它**不该**把整表读出来 +
   * 逐张 `JSON.parse` ops —— 面板跑一轮期间每 2 秒问一次现状）。
   *
   * @param {{state?: string | null}} [options] 过滤条件
   * @returns {number} 条数
   */
  countKeeperPlans({ state = null } = {}) {
    const row =
      state == null
        ? this.db.prepare('SELECT COUNT(*) AS n FROM keeper_plans').get()
        : this.db.prepare('SELECT COUNT(*) AS n FROM keeper_plans WHERE state = ?').get(String(state));
    return Number(row?.n ?? 0);
  }

  /**
   * 取一张变更单。
   *
   * @param {string} id 变更单 id
   * @returns {Record<string, unknown> | null} 变更单或 `null`
   */
  getKeeperPlan(id) {
    const row = this.db.prepare('SELECT * FROM keeper_plans WHERE id = ?').get(String(id));
    return row == null ? null : shapeKeeperPlan(row);
  }

  /**
   * 更新变更单的审阅结果。**传 `null` / `undefined` 表示「保持原值」**
   * （与 `setItemDecision` 同一套语义，因此只写 `state` 是安全的）。
   *
   * `ops` 也是可选补丁：`replace` 落库后要把新记忆 id 写回该 op（`op.newId`，面板
   * 「新记忆 id」那一行读它），所以审阅完成时随 `state` 一起提交。
   *
   * @param {string} id 变更单 id
   * @param {{state?: string | null, review?: unknown, reviewedAt?: string | null, ops?: object[] | null}} [patch] 补丁
   * @returns {Record<string, unknown>} 更新后的变更单
   */
  updateKeeperPlan(id, { state = null, review = null, reviewedAt = null, ops = null } = {}) {
    const current = this.db.prepare('SELECT * FROM keeper_plans WHERE id = ?').get(String(id));
    if (current == null) throw new Error(`updateKeeperPlan：变更单不存在（${id}）`);
    const next = {
      state: state ?? current.state,
      review: review == null ? current.review : typeof review === 'string' ? review : JSON.stringify(review),
      // 只给 `state` 不给时间时补当前时间；这是「人审过」的痕迹，不能留空。
      reviewed_at: reviewedAt ?? (state == null ? current.reviewed_at : this.#stamp()),
      ops: ops == null ? current.ops : JSON.stringify(ops),
    };
    this.db
      .prepare('UPDATE keeper_plans SET state = ?, review = ?, reviewed_at = ?, ops = ? WHERE id = ?')
      .run(String(next.state), next.review, next.reviewed_at, next.ops, String(id));
    return this.getKeeperPlan(id);
  }

  // ------------------------------------------------- 待接手记忆（keeper_handoffs）

  /**
   * 把一组没整理成功的记忆挂进「待接手记忆」。
   *
   * 两种结果：
   * - **已有同一组（`seed_id` 相同）的 open 行** → 就地累加 `attempts`、刷新 `error` / `updated_at`
   *   （同一组反复失败的常见情形：不能每组每轮都新插一行，那会让这张表无界增长）；
   * - 否则新插一行。
   *
   * `member_ids` 只存 id：正文的唯一源头仍是 `memories`，这里复制一份就会有两份真相。
   *
   * @param {{id?: string | null, runId?: string | null, seedId?: string | null, memberIds?: string[],
   *   error?: string | null}} input 待接手项
   * @returns {Record<string, unknown>} 落库后的行
   */
  createHandoff({ id = null, runId = null, seedId = null, memberIds = [], error = null } = {}) {
    if (!Array.isArray(memberIds)) throw new Error('createHandoff：memberIds 必须是数组');
    const seed = seedId == null ? null : String(seedId);
    const existing =
      seed === null ? null : this.db.prepare("SELECT * FROM keeper_handoffs WHERE seed_id = ? AND state IN ('open', 'taking')").get(seed);
    if (existing != null) {
      this.db
        .prepare(
          `UPDATE keeper_handoffs SET attempts = attempts + 1, error = ?, updated_at = ?, run_id = ?,
             member_ids = ? WHERE id = ?`,
        )
        .run(
          error == null ? null : String(error),
          this.#stamp(),
          runId == null ? null : String(runId),
          JSON.stringify(memberIds.map((value) => String(value))),
          String(existing.id),
        );
      return this.getHandoff(String(existing.id));
    }
    const handoffId = id == null ? randomUUID() : String(id);
    const now = this.#stamp();
    this.db
      .prepare(
        `INSERT INTO keeper_handoffs(id, run_id, created_at, updated_at, state, seed_id, member_ids, error,
           attempts, taker, plan_id)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, 1, NULL, NULL)`,
      )
      .run(
        handoffId,
        runId == null ? null : String(runId),
        now,
        now,
        seed,
        JSON.stringify(memberIds.map((value) => String(value))),
        error == null ? null : String(error),
      );
    return this.getHandoff(handoffId);
  }

  /**
   * **原子认领**一条待接手项（`open` → `taking`）。
   *
   * 为什么要原子（用户 2026-10-08：「各自的运行不能互相产生干扰」）：主仓管一轮里某组失败后
   * 会**当场**挂到副审阅区并立刻让接手模型接手；那一窗口里这一行还是 `open` —— 面板同时也看得到它、
   * 人也可能点「接手」，于是**同一组被接两次**、出两张单。用一条
   * `UPDATE ... WHERE state = 'open'` 做比较并交换，两个调用方只有一个能拿到。
   *
   * @param {string} id 待接手项 id
   * @returns {boolean} 是否认领成功（`false` = 已被别人拿走 / 已处理过 / 不存在）
   */
  claimHandoff(id) {
    const info = this.db
      .prepare("UPDATE keeper_handoffs SET state = 'taking', updated_at = ? WHERE id = ? AND state = 'open'")
      .run(this.#stamp(), String(id));
    return Number(info.changes) === 1;
  }

  /**
   * 认领失败 / 中断后**放回队列**（`taking` → `open`），并把原因写进去。
   *
   * 只在当前状态确实是 `taking` 时回退，避免把已经 `taken` / `dropped` 的行踩回去。
   *
   * @param {string} id 待接手项 id
   * @param {{error?: string | null}} [patch] 顺带写回的原因
   * @returns {boolean} 是否放回了
   */
  releaseHandoff(id, { error = null } = {}) {
    const info = this.db
      .prepare("UPDATE keeper_handoffs SET state = 'open', error = COALESCE(?, error), updated_at = ? WHERE id = ? AND state = 'taking'")
      .run(error == null ? null : String(error), this.#stamp(), String(id));
    return Number(info.changes) === 1;
  }

  /**
   * 把**僵住的认领**放回队列（进程被杀 / 崩溃时留下的 `taking`）。
   *
   * 不做这一步的话，那一条会永远停在 `taking`：列表里看不到（面板只列 `open`）、也接手不了 ——
   * 等于悄悄丢了（比出错更糟）。阈值给得比"一组的最坏耗时"宽（`groupTimeoutMs` 默认 480s），
   * 所以正常的接手中不会被误放回。
   *
   * @param {{olderThanMs?: number, now?: number}} [options] 阈值与当前时刻
   * @returns {number} 放回了几条
   */
  reclaimStaleHandoffs({ olderThanMs = 600000, now = null } = {}) {
    // ⚠️ 用**库自己的时钟**（`this.now`），别用 `Date.now()`：写入的时刻是 `#stamp()` 打的，
    // 两边各用一套时钟在有假时钟的测试里会立刻错判（真机上是同一套，但没理由让它只在真机上对）。
    const base = now == null ? Number(this.now()?.getTime?.() ?? Date.now()) : Number(now);
    const cutoff = new Date(base - Math.max(1, Number(olderThanMs) || 0)).toISOString();
    const info = this.db
      .prepare(
        `UPDATE keeper_handoffs SET state = 'open', error = '上次接手没有正常结束（已放回队列）', updated_at = ?
         WHERE state = 'taking' AND updated_at < ?`,
      )
      .run(this.#stamp(), cutoff);
    return Number(info.changes ?? 0);
  }

  /**
   * 列出待接手项（新的在前，可按状态过滤）。
   *
   * @param {{state?: string | null, limit?: number | null}} [options] 过滤条件
   * @returns {Record<string, unknown>[]} 待接手项
   */
  listHandoffs({ state = null, limit = null } = {}) {
    const params = [];
    let sql = 'SELECT * FROM keeper_handoffs';
    if (state != null) {
      sql += ' WHERE state = ?';
      params.push(String(state));
    }
    sql += ' ORDER BY created_at DESC, rowid DESC';
    if (limit != null && Number(limit) > 0) {
      sql += ' LIMIT ?';
      params.push(Math.max(1, Math.trunc(Number(limit))));
    }
    return this.db.prepare(sql).all(...params).map(shapeHandoff);
  }

  /**
   * 取一条待接手项。
   *
   * @param {string} id 待接手项 id
   * @returns {Record<string, unknown> | null} 待接手项或 `null`
   */
  getHandoff(id) {
    const row = this.db.prepare('SELECT * FROM keeper_handoffs WHERE id = ?').get(String(id));
    return row == null ? null : shapeHandoff(row);
  }

  /**
   * 只数 open 的条数（`/state` 与面板卡片用；不用把整表读出来）。
   *
   * @returns {number} 条数
   */
  countOpenHandoffs() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM keeper_handoffs WHERE state = 'open'").get();
    return Number(row?.n ?? 0);
  }

  /**
   * 更新一条待接手项。**传 `null` 表示「保持原值」**（与 `updateKeeperPlan` 同一套语义）。
   *
   * `memberIds` 也是可选补丁：**重头整理之后**这一行的成员要换成"真正整理的那一组"
   * （种子 ∪ 召回的邻居），面板那行「N 条记忆」说的才是事实。传数组才写，传 `null` 保持。
   *
   * @param {string} id 待接手项 id
   * @param {{state?: string | null, error?: string | null, taker?: string | null,
   *   planId?: string | null, memberIds?: string[] | null}} [patch] 补丁
   * @returns {Record<string, unknown>} 更新后的行
   */
  updateHandoff(id, { state = null, error = null, taker = null, planId = null, memberIds = null } = {}) {
    const current = this.db.prepare('SELECT * FROM keeper_handoffs WHERE id = ?').get(String(id));
    if (current == null) throw new Error(`updateHandoff：副整理区项不存在（${id}）`);
    if (memberIds != null && !Array.isArray(memberIds)) throw new Error('updateHandoff：memberIds 必须是数组');
    const next = {
      state: state ?? current.state,
      error: error == null ? current.error : String(error),
      taker: taker == null ? current.taker : String(taker),
      plan_id: planId == null ? current.plan_id : String(planId),
      member_ids: memberIds == null ? current.member_ids : JSON.stringify(memberIds.map((value) => String(value))),
    };
    this.db
      .prepare(
        'UPDATE keeper_handoffs SET state = ?, error = ?, taker = ?, plan_id = ?, member_ids = ?, updated_at = ? WHERE id = ?',
      )
      .run(String(next.state), next.error, next.taker, next.plan_id, next.member_ids, this.#stamp(), String(id));
    return this.getHandoff(id);
  }

  /**
   * 数一条待接手项又被试了一次（`attempts` +1）。
   *
   * @param {string} id 待接手项 id
   * @returns {Record<string, unknown>} 更新后的行
   */
  bumpHandoffAttempts(id) {
    const info = this.db
      .prepare('UPDATE keeper_handoffs SET attempts = attempts + 1, updated_at = ? WHERE id = ?')
      .run(this.#stamp(), String(id));
    if (Number(info.changes) === 0) throw new Error(`bumpHandoffAttempts：副整理区项不存在（${id}）`);
    return this.getHandoff(id);
  }

  // ------------------------------------------------------- 来源账本（palace_sources）
  /**
   * 写入 / 更新一条「来源账本」记录（`palace_sources` 表）。
   *
   * ⚠ 宫殿同步功能已于 2026-10-06 退役（快照归档在 `<DSH 工作区>/dsh-memory-data/.retired/palace/`，
   * 该目录**不属于本仓库**），**当前没有任何调用方**。
   * 保留这三个方法与表：它们是通用的「文件来源 → 灌了多少块」账本，表本身还在 schema 里，
   * 删方法只会让 schema 与代码更不一致。要用时直接调。
   *
   * @param {{ path: string, kind?: string | null, mtimeMs?: number | null, size?: number | null,
   *   contentHash?: string | null, chunkCount?: number | null }} input 来源
   * @returns {void}
   */
  upsertSource({ path, kind = null, mtimeMs = null, size = null, contentHash = null, chunkCount = null } = {}) {
    if (typeof path !== 'string' || path.length === 0) throw new Error('upsertSource：path 必须是非空字符串');
    this.db
      .prepare(
        `INSERT INTO palace_sources(path, kind, mtime_ms, size, content_hash, chunk_count, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, mtime_ms = excluded.mtime_ms,
           size = excluded.size, content_hash = excluded.content_hash,
           chunk_count = excluded.chunk_count, synced_at = excluded.synced_at`,
      )
      .run(path, kind, mtimeMs == null ? null : Number(mtimeMs), size == null ? null : Number(size), contentHash, chunkCount == null ? null : Number(chunkCount), this.#stamp());
  }

  /**
   * 取一条来源记录。
   *
   * @param {string} path 文件路径
   * @returns {Record<string, unknown> | null} 来源行
   */
  getSource(path) {
    return plain(this.db.prepare('SELECT * FROM palace_sources WHERE path = ?').get(String(path)));
  }

  /**
   * 列出全部来源（按路径升序）。
   *
   * @returns {Record<string, unknown>[]} 来源行
   */
  listSources() {
    return this.db.prepare('SELECT * FROM palace_sources ORDER BY path ASC').all().map(plain);
  }

  // ----------------------------------------------------------- 后台任务

  /**
   * 建一个后台任务记录。
   *
   * @param {{ kind: string, total?: number | null }} input 任务
   * @returns {string} 任务 id
   */
  createJob({ kind, total = null } = {}) {
    if (typeof kind !== 'string' || kind.length === 0) throw new Error('createJob：kind 必须是非空字符串');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO jobs(id, kind, state, total, done, failed, started_at, finished_at, error, detail) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, NULL, NULL)')
      .run(id, kind, 'running', total == null ? null : Number(total), this.#stamp());
    return id;
  }

  /**
   * 更新任务进度（只写传入的字段）。
   *
   * @param {string} id 任务 id
   * @param {{ state?: string, total?: number | null, done?: number, failed?: number, error?: string | null,
   *   detail?: unknown, finished_at?: string | null, finishedAt?: string | null, started_at?: string | null,
   *   startedAt?: string | null }} patch 补丁
   * @returns {Record<string, unknown>} 更新后的任务行
   */
  updateJob(id, patch = {}) {
    const aliases = { finishedAt: 'finished_at', startedAt: 'started_at' };
    /** @type {Record<string, unknown>} */
    const normalized = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      const column = aliases[key] ?? key;
      if (JOB_COLUMNS.includes(column)) normalized[column] = value;
    }
    if (typeof normalized.detail === 'object' && normalized.detail !== null) {
      normalized.detail = JSON.stringify(normalized.detail);
    }

    const columns = Object.keys(normalized);
    withTransaction(this.db, () => {
      if (columns.length > 0) {
        const assignments = columns.map((column) => `${column} = ?`).join(', ');
        this.db
          .prepare(`UPDATE jobs SET ${assignments} WHERE id = ?`)
          .run(...columns.map((column) => normalized[column]), String(id));
      }
      if (this.db.prepare('SELECT id FROM jobs WHERE id = ?').get(String(id)) == null) {
        throw new Error(`updateJob：任务不存在（${id}）`);
      }
    });
    return this.getJob(id);
  }

  /**
   * 取一个任务。
   *
   * @param {string} id 任务 id
   * @returns {Record<string, unknown> | null} 任务行
   */
  getJob(id) {
    return plain(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(String(id)));
  }

  /**
   * 取最近的一条任务（可按 kind 过滤）。
   *
   * @param {{ kind?: string | null }} [options] 过滤条件
   * @returns {Record<string, unknown> | null} 任务行
   */
  latestJob({ kind = null } = {}) {
    if (kind != null) {
      return plain(
        this.db
          .prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
          .get(String(kind)),
      );
    }
    return plain(this.db.prepare('SELECT * FROM jobs ORDER BY started_at DESC, rowid DESC LIMIT 1').get());
  }

  // --------------------------------------------------------------- 设置

  /**
   * 读一个设置项。
   *
   * @param {string} key 键
   * @param {string | null} [fallback] 缺省值
   * @returns {string | null} 值
   */
  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row == null ? fallback : String(row.value);
  }

  /**
   * 写一个设置项。
   *
   * @param {string} key 键
   * @param {string} value 值
   * @returns {void}
   */
  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value));
  }

  // --------------------------------------------------------------- 内部

  /**
   * 组装记忆查询的 WHERE 子句。
   *
   * @param {{ scope?: string | null, includeDeleted?: boolean }} options 过滤条件
   * @returns {{ where: string, params: unknown[] }} SQL 片段与参数
   */
  #memoryWhere({ scope = null, includeDeleted = false } = {}) {
    const clauses = [];
    const params = [];
    if (!includeDeleted) clauses.push('deleted_at IS NULL');
    if (scope != null) {
      clauses.push('scope = ?');
      params.push(String(scope));
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /**
   * 写一条历史。
   *
   * @param {{ at: string, memoryId: string, op: string, prevText: string | null,
   *   nextText: string | null, note: string | null }} entry 历史项
   * @returns {void}
   */
  #writeHistory({ at, memoryId, op, prevText, nextText, note }) {
    this.db
      .prepare('INSERT INTO history(at, memory_id, op, prev_text, next_text, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, memoryId, op, prevText, nextText, note);
  }
}

/**
 * 解析 JSON 数组列（`keeper_plans.member_ids` / `ops`）。解析失败或不是数组时给 `[]`。
 *
 * @param {unknown} raw 存库的文本
 * @returns {unknown[]} 数组
 */
function parseJsonArray(raw) {
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 解析 JSON 列（`keeper_plans.review`）。解析失败时给 `null`。
 *
 * @param {unknown} raw 存库的文本
 * @returns {unknown} 解析结果
 */
function parseJsonValue(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/**
 * 把 `keeper_plans` 的一行整形为普通对象（JSON 列解析回数组 / 对象）。
 *
 * @param {Record<string, unknown>} row 数据库行
 * @returns {Record<string, unknown>} 变更单
 */
function shapeKeeperPlan(row) {
  return {
    id: String(row.id),
    runId: row.run_id == null ? null : String(row.run_id),
    createdAt: String(row.created_at),
    state: String(row.state),
    seedId: row.seed_id == null ? null : String(row.seed_id),
    memberIds: parseJsonArray(row.member_ids).map((value) => String(value)),
    ops: parseJsonArray(row.ops),
    reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
    review: parseJsonValue(row.review),
    note: row.note == null ? null : String(row.note),
    // 产出这张单的模型（老单没有这一列 = `null`，表示"不知道是谁产的"，不假装）。
    model: row.model == null ? null : String(row.model),
  };
}

/**
 * 把 `keeper_handoffs` 的一行整形为普通对象（JSON 列解析回数组）。
 *
 * @param {Record<string, unknown>} row 数据库行
 * @returns {Record<string, unknown>} 待接手项
 */
function shapeHandoff(row) {
  return {
    id: String(row.id),
    runId: row.run_id == null ? null : String(row.run_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    state: String(row.state),
    seedId: row.seed_id == null ? null : String(row.seed_id),
    memberIds: parseJsonArray(row.member_ids).map((value) => String(value)),
    error: row.error == null ? null : String(row.error),
    attempts: Number(row.attempts ?? 0),
    taker: row.taker == null ? null : String(row.taker),
    planId: row.plan_id == null ? null : String(row.plan_id),
  };
}

/**
 * Float32Array → BLOB 字节。
 *
 * @param {Float32Array} vector 向量
 * @returns {Buffer} 字节
 */
function float32ToBlob(vector) {  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * BLOB 字节 → Float32Array。
 *
 * `node:sqlite` 返回 Uint8Array，其 `byteOffset` 不保证为 0，
 * 所以先复制一份对齐的字节再建视图，避免踩到未对齐的 buffer。
 *
 * @param {Uint8Array | Buffer} blob 字节
 * @returns {Float32Array} 向量
 */
function blobToFloat32(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
  }
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
}

/**
 * 生成来源文本预览。
 *
 * @param {string} text 原文
 * @returns {string} 预览
 */
function preview(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}
