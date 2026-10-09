/**
 * dsh-memory · Phase 5：导出 / 导入包。
 *
 * 产出的包与原版（Python 记忆服务 `POST /v1/export`）**同构**，一个包就是
 * 「换机器 / 换系统 / 灾后重建」所需的全部东西：
 *
 * ```
 * memory-export-<时间>/
 *   manifest.json    元信息（格式 / 版本 / 导出时间 / 条数 / 当时的向量空间）
 *   memories.jsonl   **本体**：每行 `{ id, text, metadata }`
 *   readable.md      人可读全文（按 source 分组，人翻查用）
 *   RESTORE.md       恢复手册（照做即可）
 * ```
 *
 * 三条不可动摇的规矩：
 * 1. **文本是本体，向量是派生物** —— 包里**不含**向量；导入时用目标机器**当前**的
 *    embedding 模型从文本重算，所以换了模型也能搬。
 * 2. **按全文判重** —— 判重完全交给 `store.addMemory()`（它按文本 sha256 比对
 *    `deleted_at IS NULL` 的既有行），因此**同一个包可以反复导入**，不会长出重复项。
 * 3. **正文为空的行不写进包** —— 空正文在库里没有任何检索价值，写出去只会制造重复项。
 *
 * 零第三方依赖、零裸导入：只用 `node:fs` / `node:path` 与包内相对路径。
 * 全部函数都是纯文件 / 库操作，**不联网、不调 LLM**——向量重算由调用方另做（见 `embed.js`）。
 *
 * @module dsh-memory/host/portability
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hashText } from './store.js';

/** 包格式标识（与原版 `manifest.format` 同值）。 */
export const PACK_FORMAT = 'local-memory-export';

/** 包格式版本（与原版 `manifest.format_version` 同代）。 */
export const PACK_FORMAT_VERSION = 1;

/** 信条，写进 manifest 让拿包的人一眼看懂「向量为什么可以丢」。 */
export const PACK_PRINCIPLE = '文本是本体，向量是派生物';

/** 四个包的固定文件名（顺序即写盘顺序）。 */
export const PACK_FILES = ['manifest.json', 'memories.jsonl', 'readable.md', 'RESTORE.md'];

/** `errors` 最多保留几条（与原版一致：只留 5 条）。 */
const MAX_ERRORS = 5;

/** 分页读库时的批大小（不要一次性把大库读进内存）。 */
const PAGE_SIZE = 500;

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
 * 把异常变成一行可读文本（错误进 `errors` 数组，不能是 `[object Object]`）。
 *
 * @param {unknown} error 异常
 * @returns {string} 文本
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把 `now()` 的返回值规范成 UTC ISO 字符串。
 *
 * @param {() => Date | string} now 时钟（通常是 `() => new Date()`）
 * @returns {string} ISO 字符串
 */
function isoNow(now) {
  try {
    const value = typeof now === 'function' ? now() : new Date();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  } catch {
    /* 时钟坏了也要能导出，退化成「现在」 */
  }
  return new Date().toISOString();
}

/**
 * 「正文为空」的判定：与导出侧的过滤、导入侧的 `skipped` 共用同一条规则。
 *
 * 与原版一致：先 `strip()` 再判空——全空白（空格 / 换行）同样算空。
 *
 * @param {unknown} text 正文
 * @returns {boolean} 是否为空
 */
function isBlank(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

/**
 * 正文单行化（`readable.md` 的每条一行）：把所有空白折成一个空格。
 *
 * @param {unknown} text 正文
 * @returns {string} 单行文本
 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 分页取出要导出的记忆行（`deleted_at IS NULL`；`scope === null` 表示不过滤）。
 *
 * 用 `offset` 分页而不是一次性 `listMemories({limit: 巨大})`，避免大库把内存吃满；
 * 导出期间不写库，所以 offset 分页的顺序是稳定的。
 *
 * @param {import('./store.js').MemoryStore} store 仓储
 * @param {string | null} scope 作用域；`null` = 全部
 * @returns {Record<string, unknown>[]} 记忆行（含解析后的 `meta`）
 */
function collectRows(store, scope) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = store.listMemories({ limit: PAGE_SIZE, offset, scope });
    rows.push(...page.items);
    offset += page.items.length;
    if (page.items.length < PAGE_SIZE || offset >= Number(page.total)) break;
  }
  return rows;
}

/**
 * 从一条记忆行生成 JSONL 里的 `metadata`。
 *
 * 规则（与原版「除正文与 id 之外的键全给」等价，但更明确）：
 * 用户自定义 meta 先平铺，再用**权威列**覆盖同名字段，最后补上时间戳与 revision。
 * 这样导入侧可以「列归列、meta 归 meta」地还原，不会把 `source` 又塞回用户 meta。
 *
 * @param {Record<string, unknown>} row 记忆行
 * @returns {Record<string, unknown>} metadata
 */
function metadataOf(row) {
  const meta = isPlainObject(row.meta) ? row.meta : {};
  return {
    ...meta,
    source: row.source ?? null,
    section: row.section ?? null,
    kind: row.kind ?? null,
    scope: row.scope ?? 'default',
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    revision: Number(row.revision ?? 1),
  };
}

/**
 * 组装 `manifest.embedding`：调用方给了就用，没给就从库里的活动向量空间推。
 *
 * 三项都允许是 `null`（例如从未建过索引、或调用方不关心）——
 * **绝不编造** provider / dims，否则拿包的人会以为向量空间是已知的。
 *
 * @param {import('./store.js').MemoryStore} store 仓储
 * @param {{ provider?: string | null, model?: string | null, dims?: number | null } | null} embedding 调用方给的空间描述
 * @returns {{ provider: string | null, model: string | null, dims: number | null }} 三项可空
 */
function embeddingOf(store, embedding) {
  if (isPlainObject(embedding)) {
    return {
      provider: embedding.provider ?? null,
      model: embedding.model ?? null,
      dims: embedding.dims ?? null,
    };
  }
  let space = null;
  try {
    space = typeof store?.getActiveSpace === 'function' ? store.getActiveSpace() : null;
  } catch {
    /* 空间表坏掉不该拦住导出 */
  }
  return { provider: space?.provider ?? null, model: space?.model ?? null, dims: space?.dims ?? null };
}

/**
 * 取「库里已存在的正文 hash」集合（`dryRun` 判重用）。
 *
 * 优先直接从 `memories.hash` 列取（只读一遍索引列，万级条数下远快于把全库正文读出来重算）；
 * 拿不到 `db` 句柄时退回 `listTexts()` 流式重算——**语义完全一致**，只是慢一些。
 *
 * @param {import('./store.js').MemoryStore} store 仓储
 * @returns {Set<string>} hash 集合
 */
function existingHashes(store) {
  const db = store?.db;
  if (db != null && typeof db.prepare === 'function') {
    const rows = db.prepare('SELECT hash FROM memories WHERE deleted_at IS NULL').all();
    return new Set(rows.map((row) => String(row.hash)));
  }
  const set = new Set();
  if (typeof store?.listTexts === 'function') {
    for (const row of store.listTexts()) set.add(hashText(row.text));
  }
  return set;
}

/**
 * 渲染 `readable.md`：`# 记忆库导出（n 条 · m 个来源）` + 每个 source 一段。
 *
 * @param {{ source: string, text: string }[]} entries 条目（已排除空正文）
 * @param {string} exportedAt 导出时间（ISO）
 * @returns {string} markdown 全文
 */
function renderReadable(entries, exportedAt) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.source;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry.text);
  }

  const lines = [`# 记忆库导出（${entries.length} 条 · ${groups.size} 个来源）`, '', `> 导出时间：${exportedAt}`, ''];
  // 用码点排序（与原版 Python 的 sorted() 一致），**不用 localeCompare**：
  // 后者依赖 ICU 版本，同一份数据在不同机器上可能给出不同的段落顺序。
  for (const source of [...groups.keys()].sort()) {
    lines.push(`## ${source}`, '');
    for (const text of groups.get(source)) lines.push(`- ${text}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * 渲染 `RESTORE.md`：怎么把这包记忆装回去。
 *
 * @param {string} exportedAt 导出时间（ISO）
 * @returns {string} markdown 全文
 */
function renderRestore(exportedAt) {
  return [
    '# 怎么把这包记忆装回去',
    '',
    '这个包是 **dsh-memory 插件**的全量导出，换机器 / 换系统 / 灾后重建都用它。',
    `导出时间：${exportedAt}`,
    '',
    '## 前提',
    '',
    '目标机器上 DSH 已经跑起来、dsh-memory 插件那一行是 active（左栏能看到「记忆」）。',
    '',
    '## 装回去（在 DSH 会话里让 agent 调 `memory_import` 工具）',
    '',
    '```',
    'memory_import { "dir": "<这个包的绝对路径>" }              # 真导入',
    'memory_import { "dir": "<这个包的绝对路径>", "dryRun": true }  # 只演练，不写库',
    '```',
    '',
    '拿不到工具通道时，等价地在宿主里调模块函数（`src/host/portability.js`）：',
    '',
    '```js',
    "import { importPack } from './portability.js';",
    "await importPack({ store, dir: '<包的绝对路径>', dryRun: true });",
    '```',
    '',
    '## 导入的规矩',
    '',
    '- **按全文判重**：库里已有同一条文本会被跳过（`added: 0` / 全是 `skipped`）——',
    '  所以**同一个包可以反复导入**，不会长出重复项。',
    '- **向量现算**：包里的向量不被信任（包里本来也没有向量），',
    '  导入后用**目标机器当前的 embedding 模型**从文本重算 —— 换了 embedding 模型也能搬。',
    '- **原文保真**：文本与元数据原样保留；原 id 记在 `meta.originalId`，',
    '  来源包记在 `meta.importedFrom`，备查。',
    '- **空正文的行不会被写进包**，导入侧遇到空正文也只计 `skipped`。',
    '',
    '## 导入后验证（做一次）',
    '',
    '1. 面板「概览」看记忆条数对不对；',
    '2. 挑一条记忆的开头几个字去「搜索」页搜它，看能不能命中；',
    '3. 面板「概览」页点一次「重建索引」，把向量按当前模型补齐（否则只有关键词检索能命中它）。',
    '',
    '## 包里都有什么',
    '',
    '- `manifest.json`：格式版本、条数、当时的模型与维度、导出时间；',
    '- `memories.jsonl`：**本体**（每条一行：id + 全文 + 元数据）；',
    '- `readable.md`：给人看的全文（按来源分组）；',
    '- `RESTORE.md`：本文件。',
    '',
  ].join('\n');
}

/**
 * 归一「导出作用域」的调用写法。
 *
 * 规则（优先级从高到低）：
 *   - `allScopes === true` → `null`（全部 scope）；
 *   - `scope === undefined`（**省略**）→ `defaultScope`；
 *   - `scope === null`（**显式给 null**）→ `null`（全部 scope，与 `exportPack` 的约定一致）；
 *   - `scope` 是非空字符串 → 原样；
 *   - 其它（空串 / 数字 / 对象…）→ 抛错，别把坏值静默变成「全导」或「空导」。
 *
 * 为什么需要它：`scope ?? defaultScope` 会把**显式 null** 一起吃掉，于是「全库导出」
 * 永远到不了 `exportPack`——这一条以前只写在文档里，既没有代码也没有测试盯着。
 *
 * @param {{ scope?: string | null, allScopes?: boolean }} [input] 调用参数
 * @param {string} [defaultScope] 省略 scope 时用的默认作用域
 * @returns {string | null} 交给 `exportPack` 的 scope（`null` = 全部）
 */
export function resolveExportScope({ scope, allScopes } = {}, defaultScope = 'default') {
  if (allScopes === true) return null;
  if (scope === undefined) return defaultScope;
  if (scope === null) return null;
  if (typeof scope === 'string' && scope.length > 0) return scope;
  throw new Error(
    `resolveExportScope：scope 只能是「省略 / null / 非空字符串」，收到 ${JSON.stringify(scope)}；` +
      '要导全部 scope 请用 allScopes: true',
  );
}

/**
 * 全量导出：写一个「能自己站起来」的包。
 *
 * 目录不存在会递归创建；四类文件按 `PACK_FILES` 顺序覆盖写出（重复导出到同一目录是安全的）。
 *
 * @param {{ store: import('./store.js').MemoryStore, dir: string,
 *   now?: () => Date | string, scope?: string | null,
 *   embedding?: { provider?: string | null, model?: string | null, dims?: number | null } | null }} options 入参
 *   - `store`：仓储（必需）；
 *   - `dir`：包目录（必需，不存在则递归创建）；
 *   - `now`：时钟，默认 `() => new Date()`（测试可注入固定时钟）；
 *   - `scope`：要导出的作用域，默认 `'default'`；传 `null` 表示**导出全部 scope**；
 *   - `embedding`：可选的向量空间描述，用来填 `manifest.embedding`；
 *     不给就从 `store.getActiveSpace()` 推（provider 会是 `null`，因为库里不存 provider）。
 * @returns {{ ok: boolean, dir: string, count: number, files: string[], bytes: number }} 结果
 *   - `count`：真正写进包的非空正文条数（`manifest.count` 与它一致）；
 *   - `files`：写出的文件名（升序）；
 *   - `bytes`：四个文件的字节数合计。
 */
export function exportPack({ store, dir, now = () => new Date(), scope = 'default', embedding = null } = {}) {
  if (store == null || typeof store.listMemories !== 'function') {
    throw new Error('exportPack：缺少 store（MemoryStore 实例）');
  }
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('exportPack：dir 必须是非空字符串（包目录）');
  }

  const outDir = resolve(dir);
  mkdirSync(outDir, { recursive: true });

  const exportedAt = isoNow(now);
  const scopeValue = scope === undefined ? 'default' : scope;
  const rows = collectRows(store, scopeValue ?? null);

  /** 非空正文的行才是「本体」。 */
  const usable = rows.filter((row) => !isBlank(row.text));

  const manifest = {
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    exportedAt,
    count: usable.length,
    scope: scopeValue ?? null,
    embedding: embeddingOf(store, embedding),
    principle: PACK_PRINCIPLE,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const jsonl = usable
    .map((row) => JSON.stringify({ id: row.id ?? null, text: String(row.text), metadata: metadataOf(row) }))
    .join('\n');
  writeFileSync(join(outDir, 'memories.jsonl'), usable.length === 0 ? '' : `${jsonl}\n`, 'utf8');

  writeFileSync(
    join(outDir, 'readable.md'),
    renderReadable(
      usable.map((row) => ({ source: row.source == null || row.source === '' ? '(无来源)' : String(row.source), text: oneLine(row.text) })),
      exportedAt,
    ),
    'utf8',
  );

  writeFileSync(join(outDir, 'RESTORE.md'), renderRestore(exportedAt), 'utf8');

  const files = PACK_FILES.slice().sort();
  const bytes = files.reduce((sum, name) => sum + statSync(join(outDir, name)).size, 0);

  return { ok: true, dir: outDir, count: usable.length, files, bytes };
}

/**
 * 读一个导出包（**只读文件，不碰库**）。
 *
 * - 找不到 `memories.jsonl` → `ok: false`，`error` 里点明「这不像一个导出包」；
 * - `manifest.json` 缺失或坏掉不算失败（`manifest: null`）——本体是 JSONL，不是 manifest；
 * - 坏 JSON 行 / 非对象行进 `badLines`（带行号），**不影响其它行**；
 * - `rows` 只放能解析成对象的行，`text` 非字符串时归零成 `''`
 *   （这样导入侧会把它算成 `skipped`，而不是凭空 `String(123)` 造出一条假记忆）。
 *
 * @param {string} dir 包目录
 * @returns {{ ok: boolean, manifest: Record<string, unknown> | null,
 *   rows: { id: string | null, text: string, metadata: Record<string, unknown> }[],
 *   badLines: { line: number, error: string }[], dir: string | null, error: string | null }} 结果
 */
export function readPack(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, manifest: null, rows: [], badLines: [], dir: null, error: '缺少 dir（导出包目录）' };
  }

  const packDir = resolve(dir);
  const jsonlPath = join(packDir, 'memories.jsonl');
  if (!existsSync(jsonlPath)) {
    return {
      ok: false,
      manifest: null,
      rows: [],
      badLines: [],
      dir: packDir,
      error: `找不到 ${jsonlPath} —— 这不像一个导出包`,
    };
  }

  let manifest = null;
  const manifestPath = join(packDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (isPlainObject(parsed)) manifest = parsed;
    } catch {
      manifest = null; // 坏 manifest 不致命：本体是 memories.jsonl
    }
  }

  /** @type {{ id: string | null, text: string, metadata: Record<string, unknown> }[]} */
  const rows = [];
  /** @type {{ line: number, error: string }[]} */
  const badLines = [];

  const lines = readFileSync(jsonlPath, 'utf8').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return; // 空行（含文件末尾换行）直接跳过，不算坏行
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      badLines.push({ line: index + 1, error: `JSON 解析失败：${describeError(error)}` });
      return;
    }
    if (!isPlainObject(parsed)) {
      badLines.push({ line: index + 1, error: `不是一个 JSON 对象（${Array.isArray(parsed) ? 'array' : typeof parsed}）` });
      return;
    }
    rows.push({
      id: parsed.id == null ? null : String(parsed.id),
      text: typeof parsed.text === 'string' ? parsed.text : '',
      metadata: isPlainObject(parsed.metadata) ? parsed.metadata : {},
    });
  });

  return { ok: true, manifest, rows, badLines, dir: packDir, error: null };
}

/**
 * 从导出包导入（按全文判重，可反复跑）。
 *
 * 规则逐条：
 * 1. 读不到包 → `ok: false`，`error` 说明「这不像一个导出包」；
 * 2. 坏 JSON 行 / 非对象行 → 每条 `failed++`（读包时就已归类进 `badLines`）；
 * 3. `text` 为空（含全空白）→ `skipped++`；
 * 4. 其余交给 `store.addMemory()`：它按文本 sha256 判重，`created: true` → `added++`
 *    并对新 id `await onAdded(id)`；`created: false` → `skipped++`。
 *    **同一包内的重复行也只能算一次**，因为 `addMemory` 每写一条就立刻能被下一次查到；
 * 5. `dryRun: true` 时**一个字节都不写库**，但按同样的规则统计
 *    （用库里的 `hash` 集合 + 包内已见集合模拟判重，结果与真导入一致）。
 *
 * `meta` 里额外写两个键：`importedFrom`（`sourceLabel`，否则包目录名）与
 * `originalId`（包里的原 id，备查）。目标库的 `scope` 由调用方给（默认 `'default'`）；
 * 包里的原 scope 仍旧留在 `meta.scope` 里，不丢信息。
 *
 * @param {{ store: import('./store.js').MemoryStore, dir: string, dryRun?: boolean,
 *   scope?: string, onAdded?: ((id: string) => unknown) | null, sourceLabel?: string | null }} options 入参
 * @returns {Promise<{ ok: boolean, dryRun: boolean, dir: string | null, inPack: number | null,
 *   added: number, skipped: number, failed: number, errors: string[], error?: string }>} 结果
 */
export async function importPack({
  store,
  dir,
  dryRun = false,
  scope = 'default',
  onAdded = null,
  sourceLabel = null,
} = {}) {
  const pack = readPack(dir);
  if (!pack.ok || store == null || typeof store.addMemory !== 'function') {
    const error = pack.ok ? 'importPack：缺少 store（MemoryStore 实例）' : pack.error;
    return {
      ok: false,
      dryRun: dryRun === true,
      dir: pack.dir ?? (typeof dir === 'string' && dir.length > 0 ? resolve(dir) : null),
      inPack: null,
      added: 0,
      skipped: 0,
      failed: 0,
      errors: error == null ? [] : [error],
      error: error ?? '导入失败',
    };
  }

  const label = typeof sourceLabel === 'string' && sourceLabel.length > 0
    ? sourceLabel
    : basename(pack.dir ?? resolve(String(dir)));

  /** 坏行先计 `failed`（每个坏行一条，`errors` 只留前 5 条）。 */
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  const pushError = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };
  for (const bad of pack.badLines) {
    failed += 1;
    pushError(`第 ${bad.line} 行：${bad.error}`);
  }

  /**
   * `dryRun` 用的「已存在」集合：从库里的 hash 列取（只读），
   * 而不是把全库正文读出来重算——万级条数下这是数量级的差别。
   */
  const seen = dryRun ? existingHashes(store) : null;

  let added = 0;
  let skipped = 0;

  for (const row of pack.rows) {
    if (isBlank(row.text)) {
      skipped += 1;
      continue;
    }

    if (seen !== null) {
      const hash = hashText(row.text);
      if (seen.has(hash)) {
        skipped += 1;
      } else {
        seen.add(hash); // 同一包内的重复行只算一次
        added += 1;
      }
      continue;
    }

    const meta = { ...row.metadata, importedFrom: label };
    if (row.id != null) meta.originalId = row.id;

    let result;
    try {
      result = store.addMemory({
        text: row.text,
        scope: scope ?? 'default',
        source: row.metadata.source == null ? null : String(row.metadata.source),
        section: row.metadata.section == null ? null : String(row.metadata.section),
        kind: row.metadata.kind == null ? null : String(row.metadata.kind),
        meta,
      });
    } catch (error) {
      failed += 1;
      pushError(`「${oneLine(row.text).slice(0, 40)}…」：${describeError(error)}`);
      continue;
    }

    if (result?.created === true) {
      added += 1;
      if (typeof onAdded === 'function') {
        try {
          await onAdded(result.id); // 调用方可能要拿新 id 去算向量，必须等它做完
        } catch (error) {
          // 记忆确实已经进库了，所以只记错误、不改 added/failed 口径。
          pushError(`onAdded(${result.id}) 失败：${describeError(error)}`);
        }
      }
    } else {
      skipped += 1;
    }
  }

  return {
    ok: true,
    dryRun: dryRun === true,
    dir: pack.dir,
    inPack: pack.manifest?.count ?? null,
    added,
    skipped,
    failed,
    errors,
  };
}

/**
 * 只导出「人可读」的那一份 markdown（不发整个包时用）。
 *
 * 与 `exportPack` 里的 `readable.md` **同一套渲染规则**：`# 记忆库导出（n 条 · m 个来源）`，
 * 然后每个 source 一段 `## <source>` + 每条一行 `- <正文单行化>`。
 * 本函数**不按 scope 过滤**（要看某个 scope 请用 `exportPack`）。
 *
 * @param {{ store: import('./store.js').MemoryStore, file: string,
 *   now?: () => Date | string }} options 入参
 *   - `file`：目标 markdown 文件；父目录不存在会递归创建。
 * @returns {{ ok: boolean, file: string, count: number, bytes: number,
 *   sources: { source: string, count: number }[] }} 结果
 *   - `sources`：来源清单（按来源名升序），`sources.length` 就是「m 个来源」。
 */
export function exportReadable({ store, file, now = () => new Date() } = {}) {
  if (store == null || typeof store.listMemories !== 'function') {
    throw new Error('exportReadable：缺少 store（MemoryStore 实例）');
  }
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error('exportReadable：file 必须是非空字符串（目标 markdown 路径）');
  }

  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });

  const rows = collectRows(store, null).filter((row) => !isBlank(row.text));
  const entries = rows.map((row) => ({
    source: row.source == null || row.source === '' ? '(无来源)' : String(row.source),
    text: oneLine(row.text),
  }));

  const markdown = renderReadable(entries, isoNow(now));
  writeFileSync(target, markdown, 'utf8');

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const entry of entries) counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
  const sources = [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)); // 码点序，与 readable.md 的分段顺序一致

  return { ok: true, file: target, count: entries.length, bytes: statSync(target).size, sources };
}
