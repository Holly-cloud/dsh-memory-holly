/**
 * dsh-memory · Phase 2：审阅门 —— 抽取结果先落「库外待审区」，人审过才进记忆库。
 *
 * 设计要点（Phase 3–5 直接依赖）：
 * - `stageExtraction` **绝不直接写 memories**，只建批次（`batches` + `batch_items`）；
 * - `reviewBatch` 是唯一把候选变成记忆的入口，逐条写 `setItemDecision` 留痕；
 * - 一条都没写进去时**不关闭批次**，人可以改完再审（避免误操作丢内容）；
 * - `rejectBatch` 只关批次，不删数据、不动记忆。
 *
 * 本模块不 import 任何第三方包；`store` 由调用方注入（Phase 1 的 `MemoryStore`）。
 *
 * @module dsh-memory/host/review
 */

import { extractFacts } from './extract.js';

/**
 * 注入的 LLM 接口（与 extract.js 同一份契约）。
 *
 * @typedef {{ chat(request: { messages: { role: string, content: string }[], temperature?: number,
 *   maxTokens?: number }): Promise<string> }} LlmClient
 */

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
 * 把 `keep` 规格化成 0-based 下标集合。
 *
 * - `null` / `undefined` → 全部条目；
 * - 数组或其它可迭代对象 → 白名单（只收整数下标，非法值忽略）；
 * - 其它类型（写错了）→ **空集合**，即全部跳过——宁可什么都不写，也不误写。
 *
 * @param {Iterable<unknown> | null | undefined} keep 白名单
 * @param {{ idx: number }[]} items 批次条目
 * @returns {Set<number>} 0-based 下标集合
 */
function buildKeepSet(keep, items) {
  if (keep == null) return new Set(items.map((item) => Number(item.idx)));
  if (typeof keep[Symbol.iterator] !== 'function') return new Set();

  const set = new Set();
  for (const value of keep) {
    const index = Number(value);
    if (Number.isInteger(index)) set.add(index);
  }
  return set;
}

/**
 * 从 `{ [idx]: ... }` 形式的表里按 0-based 下标取值。
 *
 * 对象键本身是字符串，所以 `map[idx]` 对数字下标同样成立。
 *
 * @param {Record<string | number, unknown>} map 表
 * @param {number} idx 下标
 * @returns {Record<string, unknown>} 条目（缺省为 `{}`）
 */
function pick(map, idx) {
  const value = map == null ? null : map[idx];
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * 抽取并暂存到待审区（**不写 memories**）。
 *
 * 抽到 0 条时直接失败（通常是闲聊），**不建空批次**。
 *
 * `excludeTransient`（默认 true）透传给 `extractFacts()`：提示词抽出来的事实会再过一道
 * **确定性三分类**（`looksTransient()`）：`durable` 与 `uncertain` 都**进待审区**
 * （人审 / agent 审时反正都要看），只有被判 `transient` 的会话 / 工具 / 进度态条
 * **不落待审区**，只在 `dropped` 里回报（带命中理由）—— 所以「全被判临时」与
 * 「模型什么都没抽到」是**两种不同的失败**，前者的 `error` 会写明被丢掉几条。
 *
 * @param {{ store: import('./store.js').MemoryStore, llm?: LlmClient | null, text?: string,
 *   focused?: boolean, model?: string | null, maxTokens?: number, excludeTransient?: boolean }} input 输入
 * @returns {Promise<{ ok: boolean, batchId: string | null, count: number, facts: string[],
 *   dropped: { text: string, hit: string }[], deferred: { text: string, hit: string }[],
 *   allTransient: boolean, error: string | null }>} 结果
 */
export async function stageExtraction({
  store,
  llm,
  text,
  focused = false,
  model = null,
  maxTokens = 2000,
  excludeTransient = true,
} = {}) {
  /**
   * @param {string} error 失败原因
   * @param {{ text: string, hit: string }[]} [dropped] 被判临时丢掉的事实
   * @param {boolean} [allTransient] 失败原因是不是「全被判临时」（调用方据此决定要不要当错误记）
   * @param {{ text: string, hit: string }[]} [deferred] 被判「拿不准」的事实（只在失败回执里带出）
   * @returns {{ ok: boolean, batchId: null, count: number, facts: string[],
   *   dropped: { text: string, hit: string }[], deferred: { text: string, hit: string }[],
   *   allTransient: boolean, error: string }} 失败结果
   */
  const failed = (error, dropped = [], allTransient = false, deferred = []) => ({
    ok: false,
    batchId: null,
    count: 0,
    facts: [],
    dropped,
    deferred,
    allTransient,
    error,
  });

  if (store == null) return failed('缺少 store');

  const extracted = await extractFacts({ llm, text, focused, maxTokens, excludeTransient });
  const dropped = Array.isArray(extracted.dropped) ? extracted.dropped : [];
  const deferred = Array.isArray(extracted.deferred) ? extracted.deferred : [];
  if (!extracted.ok) return failed(extracted.error ?? '抽取失败', dropped, false, deferred);
  if (extracted.facts.length === 0) {
    if (dropped.length > 0) {
      return failed(
        `模型抽出的 ${dropped.length} 条都被判定为临时事实（会话 / 工具 / 进度态），未落待审区`,
        dropped,
        true,
        deferred,
      );
    }
    return failed('模型没抽出任何事实（可能是无信息量的闲聊）', dropped, false, deferred);
  }

  try {
    const batch = store.createBatch({ model, sourceText: String(text ?? ''), focused, items: extracted.facts });
    return {
      ok: true,
      batchId: batch.id,
      count: extracted.facts.length,
      facts: extracted.facts,
      dropped,
      deferred,
      allTransient: false,
      error: null,
    };
  } catch (err) {
    return failed(`建批次失败：${describeError(err)}`, dropped, false, deferred);
  }
}

/**
 * 审阅一个批次：按 `keep` / `edits` / `actions` 逐条决定入库、改写还是跳过。
 *
 * 逐条规则（顺序很重要）：
 * 1. 不在 `keep` 里 → `skipped`；
 * 2. 最终文本为空（原文与 `edits` 都为空）→ `skipped`；
 * 3. `actions[idx].supersede` 非空 → 对每个旧 id 调 `updateMemoryText`（**会一并删掉那条
 *    在所有空间里的向量**），`updated++`，**本条不再新增**；删过向量的旧 id 会回调 `onUpdated`，
 *    让调用方把它们重新排进嵌入队列（否则语义检索会一直按旧文本的向量出结果）；
 * 4. `actions[idx].duplicate === true` → `skipped`；
 * 5. 否则 `addMemory`（`source: '抽取审阅'`、`kind: 'extracted'`、`meta.batchId`），
 *    `added++`，并对新 id 调 `onAdded`（回调返回 Promise 时会被等待）；
 * 6. 每条都写 `setItemDecision` 留痕。
 *
 * `added === 0 && updated === 0` 时返回 `ok: false` 且**不关闭批次**，允许改完再审。
 *
 * @param {{ store: import('./store.js').MemoryStore, batchId?: string | null,
 *   keep?: Iterable<unknown> | null, edits?: Record<string | number, string>,
 *   actions?: Record<string | number, { supersede?: unknown[], duplicate?: boolean, relation?: string }>,
 *   scope?: string, onAdded?: ((memoryId: string) => unknown) | null,
 *   onUpdated?: ((memoryId: string) => unknown) | null }} input 输入
 * @returns {Promise<{ ok: boolean, added: number, updated: number, skipped: number,
 *   error: string | null }>} 结果
 */
export async function reviewBatch({
  store,
  batchId,
  keep = null,
  edits = {},
  actions = {},
  scope = 'default',
  onAdded = null,
  onUpdated = null,
} = {}) {
  /**
   * @param {string} error 失败原因
   * @param {{ added?: number, updated?: number, skipped?: number }} [counts] 计数
   * @returns {{ ok: boolean, added: number, updated: number, skipped: number, error: string }} 失败结果
   */
  const failed = (error, counts = {}) => ({
    ok: false,
    added: counts.added ?? 0,
    updated: counts.updated ?? 0,
    skipped: counts.skipped ?? 0,
    error,
  });

  if (store == null) return failed('缺少 store');
  if (batchId == null || String(batchId).length === 0) return failed('缺少 batchId');

  const batch = store.getBatch(batchId);
  if (batch == null) return failed(`批次不存在（${batchId}）`);
  if (batch.state !== 'open') return failed(`批次已关闭（state=${batch.state}），不能再审`);

  const keepSet = buildKeepSet(keep, batch.items);
  const editMap = edits == null || typeof edits !== 'object' ? {} : edits;
  const actionMap = actions == null || typeof actions !== 'object' ? {} : actions;

  let added = 0;
  let updated = 0;
  let skipped = 0;
  /** @type {string[]} */
  const errors = [];

  for (const item of batch.items) {
    const idx = Number(item.idx);
    const itemId = Number(item.id);
    try {
      // 规则 1：不在白名单里。
      if (!keepSet.has(idx)) {
        store.setItemDecision({ itemId, state: 'skipped' });
        skipped++;
        continue;
      }

      // 规则 2：最终文本（edits 优先）为空。
      const edit = editMap[idx];
      const hasEdit = typeof edit === 'string';
      const text = (hasEdit ? edit : String(item.text ?? '')).trim();
      if (text.length === 0) {
        store.setItemDecision({ itemId, state: 'skipped' });
        skipped++;
        continue;
      }

      const action = pick(actionMap, idx);
      /** @type {string[]} */
      const targets = [];
      if (Array.isArray(action.supersede)) {
        for (const target of action.supersede) {
          if (target == null) continue;
          const id = String(target);
          if (id.length > 0) targets.push(id);
        }
      }

      // 规则 3：改写旧记忆，本条不再新增。
      if (targets.length > 0) {
        for (const targetId of targets) {
          // updateMemoryText 会顺手删掉该条在所有空间里的向量（正文变了向量就作废）。
          const rewritten = store.updateMemoryText(targetId, text, { note: 'review:supersede' });
          if (typeof onUpdated === 'function' && Number(rewritten?.vectorsDeleted ?? 0) > 0) {
            try {
              const pending = onUpdated(targetId);
              if (pending != null && typeof pending.then === 'function') await pending;
            } catch (err) {
              errors.push(`onUpdated 回调失败：${describeError(err)}`);
            }
          }
        }
        updated++;
        store.setItemDecision({
          itemId,
          state: 'superseded',
          editedText: hasEdit ? text : null,
          relation: 'supersede',
          targetId: targets.join(','),
          memoryId: targets[0],
        });
        continue;
      }

      // 规则 4：重复，不存。
      if (action.duplicate === true) {
        store.setItemDecision({ itemId, state: 'skipped', relation: 'duplicate' });
        skipped++;
        continue;
      }

      // 规则 5：正常入库。
      const created = store.addMemory({
        text,
        scope,
        source: '抽取审阅',
        kind: 'extracted',
        meta: { batchId: batch.id },
      });
      added++;
      store.setItemDecision({
        itemId,
        state: 'approved',
        editedText: hasEdit ? text : null,
        relation: typeof action.relation === 'string' ? action.relation : null,
        memoryId: created.id,
      });

      if (typeof onAdded === 'function') {
        try {
          const pending = onAdded(created.id);
          if (pending != null && typeof pending.then === 'function') await pending;
        } catch (err) {
          // 记忆已经落库了，回调失败只记录，不影响本条结果。
          errors.push(`onAdded 回调失败：${describeError(err)}`);
        }
      }
    } catch (err) {
      // 单条失败不拖垮整批：记为该条跳过，批次保持可再审。
      errors.push(`第 ${idx + 1} 条处理失败：${describeError(err)}`);
      skipped++;
      try {
        store.setItemDecision({ itemId, state: 'skipped' });
      } catch {
        /* 留痕失败就算了，别把原始错误吞掉 */
      }
    }
  }

  if (added === 0 && updated === 0) {
    return failed(errors.length > 0 ? errors.join('；') : '没有任何条目被写入（全被跳过）', {
      added,
      updated,
      skipped,
    });
  }

  store.closeBatch(batch.id, 'approved');
  return { ok: true, added, updated, skipped, error: null };
}

/**
 * 拒绝一个批次：只关批次，**不删数据、不动记忆**。
 *
 * @param {{ store: import('./store.js').MemoryStore, batchId?: string | null }} input 输入
 * @returns {Promise<{ ok: boolean, error: string | null }>} 结果
 */
export async function rejectBatch({ store, batchId } = {}) {
  if (store == null) return { ok: false, error: '缺少 store' };
  if (batchId == null || String(batchId).length === 0) return { ok: false, error: '缺少 batchId' };

  const batch = store.getBatch(batchId);
  if (batch == null) return { ok: false, error: `批次不存在（${batchId}）` };
  if (batch.state !== 'open') return { ok: false, error: `批次已关闭（state=${batch.state}），不能重复处理` };

  const closed = store.closeBatch(batch.id, 'rejected');
  if (!closed) return { ok: false, error: '批次关闭失败（可能已被并发关闭）' };
  return { ok: true, error: null };
}
