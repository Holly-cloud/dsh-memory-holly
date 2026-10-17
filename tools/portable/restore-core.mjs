/**
 * dsh-memory · 「个人数据包」还原核心逻辑（CLI 与测试共用；本文件不改任何全局状态）。
 *
 * 包里有两套可以还原的东西：
 *
 * 1. **库快照** `data/memory.db` —— 用 `VACUUM INTO` / `backup()` 从活库复制的一致性快照，
 *    含记忆、向量、历史、待审批次、变更单、副审阅区、设置。**整体替换**目标库，
 *    一字不差地回来（id 都不变）。要求目标库此刻没有被 DSH 打开。
 * 2. **文本包 + 附属表** `data/pack/` + `data/sidecars/` —— 只有正文与待办，
 *    **合并**进已有库（按全文 hash 判重），老记忆 id 会换新、向量要重算。
 *
 * 所以还原有两条路，`mode='auto'` 按目标现状选：
 *
 * | 目标情况 | 选什么 |
 * |---|---|
 * | 库不存在 | snapshot（直接落快照，最完整） |
 * | 库存在但没有记忆/批次/单/副审阅区，且没有 `-wal/-shm`（= 没有被 DSH 开着） | snapshot |
 * | 其余（已在使用 / 正被 DSH 打开） | merge（绝不动已有数据） |
 *
 * ## 安全约定
 *
 * - **绝不删除目标库**：替换前一定先拷一份 `memory.db.before-restore-<时间戳>`；
 * - 清 `-wal/-shm` 只发生在「确认目标库没被打开」的快照替换路径上（旧 WAL 盖到新库上会毁库）；
 * - merge 只增不改：批次/变更单/副审阅区按原 id `INSERT OR IGNORE`，设置项只补缺的键；
 * - 写库前先做包完整性校验（`counts.json` 里的 sha256），坏包直接停。
 *
 * @module dsh-memory/tools/portable/restore-core
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** 数据包格式标识（`counts.json.format`）。 */
export const DATA_FORMAT = 'dsh-memory-personal-data';

/** 数据包格式版本。结构变更就 +1，并在这里写清楚改了哪。 */
export const DATA_FORMAT_VERSION = 1;

/** 还原模式。 */
export const MODES = ['auto', 'snapshot', 'merge'];

/**
 * 还原错误：带一个稳定的 `code`，方便 CLI / 测试断言「失败原因」而不是比字符串。
 */
export class RestoreError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 人读说明（中文，含下一步建议）
   */
  constructor(code, message) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
  }
}

/**
 * 计算文件 sha256。
 *
 * @param {string} file 文件路径
 * @returns {string} 十六进制摘要
 */
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 读 `data/counts.json` 并做最基本的格式校验。
 *
 * @param {string} packageDir 数据包根目录（含 `data/`）
 * @returns {Record<string, any>} counts 对象
 */
export function loadCounts(packageDir) {
  const file = join(packageDir, 'data', 'counts.json');
  if (!existsSync(file)) throw new RestoreError('NO_COUNTS', `找不到 ${file} —— 这不是一个完整的个人数据包。`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RestoreError('BAD_COUNTS', `counts.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed?.format !== DATA_FORMAT) {
    throw new RestoreError('BAD_COUNTS', `counts.json 的 format 不是 ${DATA_FORMAT}（实际：${parsed?.format}）—— 版本不对。`);
  }
  if (Number(parsed?.formatVersion) > DATA_FORMAT_VERSION) {
    throw new RestoreError(
      'BAD_COUNTS',
      `数据包格式版本 ${parsed.formatVersion} 比本还原脚本支持的 ${DATA_FORMAT_VERSION} 新，请用更新版本的插件里的 restore 脚本。`,
    );
  }
  return parsed;
}

/**
 * 校验包内文件完整性（`counts.json.files` 里每个条目都有 bytes + sha256）。
 *
 * @param {string} packageDir 数据包根目录
 * @param {Record<string, any>} counts counts 对象
 * @returns {{ ok: boolean, checked: number, errors: string[] }} 结果
 */
export function verifyPackage(packageDir, counts) {
  /** @type {string[]} */
  const errors = [];
  let checked = 0;
  const files = counts?.files && typeof counts.files === 'object' ? counts.files : {};
  for (const [rel, meta] of Object.entries(files)) {
    const file = join(packageDir, rel);
    if (!existsSync(file)) {
      errors.push(`缺文件：${rel}`);
      continue;
    }
    const size = statSync(file).size;
    if (meta?.bytes != null && size !== meta.bytes) {
      errors.push(`${rel} 大小不符：期望 ${meta.bytes}，实际 ${size}`);
      continue;
    }
    if (typeof meta?.sha256 === 'string' && meta.sha256.length > 0) {
      const actual = sha256File(file);
      if (actual !== meta.sha256) {
        errors.push(`${rel} sha256 不符（期望 ${meta.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
        continue;
      }
    }
    checked += 1;
  }
  return { ok: errors.length === 0, checked, errors };
}

/**
 * 看目标数据目录的现状（**只读**，绝不建库/写文件）。
 *
 * @param {string} dataDir 目标数据目录
 * @returns {{ dbExists: boolean, dbPath: string, walPresent: boolean, schemaVersion: number | null,
 *   memories: number, memoriesTotal: number, deleted: number, vectors: number,
 *   batchesOpen: number, batchItemsPending: number, plansActionable: number, handoffsOpen: number,
 *   settings: number, error: string | null }} 现状
 */
export function inspectTarget(dataDir) {
  const dbPath = join(dataDir, 'memory.db');
  /** @type {ReturnType<typeof inspectTarget>} */
  const result = {
    dbExists: existsSync(dbPath),
    dbPath,
    walPresent: existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`),
    schemaVersion: null,
    memories: 0,
    memoriesTotal: 0,
    deleted: 0,
    vectors: 0,
    batchesOpen: 0,
    batchItemsPending: 0,
    plansActionable: 0,
    handoffsOpen: 0,
    settings: 0,
    error: null,
  };
  if (!result.dbExists) return result;

  /** @type {DatabaseSync | null} */
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const table = (name) => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      return row != null;
    };
    if (!table('memories')) {
      result.error = '目标库里没有 memories 表（不是 dsh-memory 的库，或库被写坏了）';
      return result;
    }
    const one = (sql) => {
      try {
        const row = db.prepare(sql).get();
        return row?.n == null ? 0 : Number(row.n);
      } catch {
        return 0;
      }
    };
    result.schemaVersion = one("SELECT CAST(value AS INTEGER) n FROM schema_meta WHERE key='schema_version'");
    result.memories = one('SELECT COUNT(*) n FROM memories WHERE deleted_at IS NULL');
    result.memoriesTotal = one('SELECT COUNT(*) n FROM memories');
    result.deleted = result.memoriesTotal - result.memories;
    result.vectors = one('SELECT COUNT(*) n FROM vectors');
    result.batchesOpen = one("SELECT COUNT(*) n FROM batches WHERE state='open'");
    result.batchItemsPending = one("SELECT COUNT(*) n FROM batch_items WHERE state='pending'");
    result.plansActionable = one("SELECT COUNT(*) n FROM keeper_plans WHERE state IN ('open','handed')");
    result.handoffsOpen = one("SELECT COUNT(*) n FROM keeper_handoffs WHERE state='open'");
    result.settings = one('SELECT COUNT(*) n FROM settings');
  } catch (error) {
    result.error = `打开目标库失败（${error instanceof Error ? error.message : String(error)}）`;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉不是错 */
    }
  }
  return result;
}

/**
 * 决定用哪条还原路径。
 *
 * @param {{ requested?: string, dbExists: boolean, empty: boolean, walPresent: boolean }} input 目标现状
 * @returns {{ mode: 'snapshot' | 'merge', reason: string }} 选择与理由
 */
export function decideMode({ requested = 'auto', dbExists, empty, walPresent }) {
  if (requested !== 'auto') {
    if (requested !== 'snapshot' && requested !== 'merge') {
      throw new RestoreError('BAD_MODE', `未知模式：${requested}（可选 auto / snapshot / merge）`);
    }
    return { mode: requested, reason: '调用方显式指定' };
  }
  if (!dbExists) return { mode: 'snapshot', reason: '目标库不存在：直接落快照，最完整' };
  if (walPresent) {
    return { mode: 'merge', reason: '目标库正被 DSH 打开（存在 -wal/-shm）：只做合并，不动原文件' };
  }
  if (empty) return { mode: 'snapshot', reason: '目标库是空的且没被打开：用快照还原（含向量/历史/原 id）' };
  return { mode: 'merge', reason: '目标库里已有数据：只做合并，绝不覆盖' };
}

/**
 * 目标库是否「空」（没有任何记忆/批次/变更单/副审阅区）。
 *
 * @param {ReturnType<typeof inspectTarget>} target 现状
 * @returns {boolean} 是否为空
 */
export function isEmptyTarget(target) {
  return (
    target.memories === 0 &&
    target.batchesOpen === 0 &&
    target.plansActionable === 0 &&
    target.handoffsOpen === 0 &&
    target.batchItemsPending === 0
  );
}

/**
 * 从 patch 文件里读 `dataDir`（只认 dsh-memory 块里的那一行）。
 *
 * 这里刻意**不 import** `install-lib.mjs`：本文件会被原样拷进数据包
 * （`2-personal-data/tools/`），独立于插件目录运行；为了一个正则再拖一个模块进来不划算。
 * 写法上要求 `dataDir:` 后跟单引号 —— 安装器与手工配置都这么写；读不到就回落默认值。
 *
 * @param {string} text patch 全文
 * @returns {string | null} dataDir 或 null
 */
export function parsePatchDataDir(text) {
  const match = String(text ?? '').match(/^\s*dataDir:\s*'([^']+)'/m);
  return match === null ? null : match[1];
}

/**
 * 目标数据目录的默认值：优先读已安装 patch 里的 `dataDir`，否则 `$DSH_HOME/dsh-memory`。
 *
 * @param {{ dshHome?: string }} [options] 入参
 * @returns {{ dataDir: string, from: 'patch' | 'default', patchFile: string | null }} 结果
 */
export function detectDataDir({ dshHome } = {}) {
  const home = dshHome ?? (process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh'));
  const profilesDir = join(home, 'profiles');
  /** @type {string[]} */
  const names = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  for (const name of ['desktop', 'default', 'web', ...names]) {
    const patchFile = join(profilesDir, name, 'cordis.patch.yml');
    if (!existsSync(patchFile)) continue;
    try {
      const dataDir = parsePatchDataDir(readFileSync(patchFile, 'utf8'));
      if (typeof dataDir === 'string' && dataDir.length > 0) {
        return { dataDir: resolve(dataDir), from: 'patch', patchFile };
      }
    } catch {
      /* 坏 patch 不该拦住还原：退回默认 */
    }
  }
  return { dataDir: join(home, 'dsh-memory'), from: 'default', patchFile: null };
}

/**
 * 找一个可用的插件源码目录（merge 模式要借它的 schema 与 `addMemory`）。
 *
 * @param {{ packageDir: string, pluginDir?: string | null }} input 入参
 * @returns {{ dir: string, source: string }} 结果
 */
export function resolvePluginDir({ packageDir, pluginDir = null }) {
  /** @type {{ dir: string, source: string }[]} */
  const candidates = [];
  if (typeof pluginDir === 'string' && pluginDir.length > 0) candidates.push({ dir: resolve(pluginDir), source: '--plugin' });
  if (process.env.DSH_MEMORY_PLUGIN) candidates.push({ dir: resolve(process.env.DSH_MEMORY_PLUGIN), source: 'DSH_MEMORY_PLUGIN' });
  candidates.push({ dir: join(packageDir, '..', '1-plugin', 'dsh-memory'), source: '包内 1-plugin/dsh-memory' });
  candidates.push({ dir: join(packageDir, '..', 'dsh-memory'), source: '同级 dsh-memory' });
  candidates.push({ dir: join(packageDir, '..'), source: '包的上一级' });

  for (const candidate of candidates) {
    if (existsSync(join(candidate.dir, 'src', 'host', 'db.js')) && existsSync(join(candidate.dir, 'lib', 'index.js'))) {
      return { dir: candidate.dir, source: candidate.source };
    }
  }
  throw new RestoreError(
    'NO_PLUGIN',
    'merge 模式需要插件源码（要借它的 schema 与判重逻辑），但没找到。\n' +
      '把插件放在包的 1-plugin/dsh-memory/ 下，或用 --plugin <插件目录> 指定。\n' +
      '（只想还原数据的话，先把 DSH 完全退出，再用 --mode snapshot 直接落快照，不需要插件源码。）',
  );
}

/**
 * 动态加载插件模块（只 import 纯 node 依赖的 host 模块，不加载 lib/index.js —— 那个要 cordis）。
 *
 * @param {string} pluginDir 插件目录
 * @returns {Promise<{ openDatabase: Function, closeDatabase: Function, MemoryStore: any, readPack: Function }>} 模块
 */
async function loadPlugin(pluginDir) {
  const url = (rel) => pathToFileURL(join(pluginDir, rel)).href;
  const dbMod = await import(url('src/host/db.js'));
  const storeMod = await import(url('src/host/store.js'));
  const portMod = await import(url('src/host/portability.js'));
  return {
    openDatabase: dbMod.openDatabase,
    closeDatabase: dbMod.closeDatabase,
    MemoryStore: storeMod.MemoryStore,
    readPack: portMod.readPack,
  };
}

/**
 * 快照还原：备份旧库 → 删旧 `-wal/-shm` → 拷入快照 → 只读校验数字。
 *
 * @param {{ packageDir: string, dataDir: string, counts: Record<string, any>, dryRun: boolean,
 *   force: boolean, log: (line: string) => void }} input 入参
 * @returns {{ backup: string | null, actions: string[], after: ReturnType<typeof inspectTarget> }} 结果
 */
function restoreSnapshot({ packageDir, dataDir, counts, dryRun, log }) {
  const source = join(packageDir, 'data', 'memory.db');
  if (!existsSync(source)) throw new RestoreError('NO_SNAPSHOT', `找不到快照：${source}`);
  const target = inspectTarget(dataDir);
  if (target.walPresent) {
    throw new RestoreError(
      'DB_OPEN',
      '目标库看起来正被 DSH 打开（发现 memory.db-wal / memory.db-shm）。\n' +
        '快照替换必须在 DSH 完全退出时做 —— 否则旧 WAL 会盖到新库上，可能直接毁库。\n' +
        '两条路：① 完全退出 DSH，重跑本脚本；② 不关 DSH，改用 --mode merge（合并导入，不替换文件）。',
    );
  }
  if (target.dbExists && !isEmptyTarget(target)) {
    throw new RestoreError(
      'TARGET_NOT_EMPTY',
      `目标库已有数据（${target.memories} 条记忆）。快照替换会覆盖它。\n` +
        '如果确实要覆盖：加 --force（脚本会先把旧库备份成 memory.db.before-restore-<时间戳>）。\n' +
        '只想合并：用 --mode merge（不覆盖，按正文判重）。',
    );
  }

  const dst = join(dataDir, 'memory.db');
  /** @type {string | null} */
  let backup = null;
  const actions = [];
  if (target.dbExists) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    backup = `${dst}.before-restore-${stamp}`;
    actions.push(`备份旧库 → ${basename(backup)}`);
    if (!dryRun) copyFileSync(dst, backup);
  } else {
    actions.push(`新建数据目录 → ${dataDir}`);
  }
  if (target.walPresent) actions.push('清掉旧的 -wal / -shm');
  actions.push(`拷入快照 → ${dst}`);

  if (!dryRun) {
    mkdirSync(dataDir, { recursive: true });
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dst + suffix)) rmSync(dst + suffix, { force: true });
    }
    copyFileSync(source, dst);
    log(`✓ 快照已落盘：${dst}`);
  } else {
    log('· [dry-run] 只报告，不写任何文件');
  }

  const after = dryRun ? target : inspectTarget(dataDir);
  if (!dryRun) verifySnapshotCounts(after, counts);
  return { backup, actions, after };
}

/**
 * 快照还原后的数字必须**完全一致**（这是「一字不差」的验收口）。
 *
 * @param {ReturnType<typeof inspectTarget>} after 还原后现状
 * @param {Record<string, any>} counts counts 对象
 * @returns {void}
 */
export function verifySnapshotCounts(after, counts) {
  const expected = counts?.expected?.snapshot ?? null;
  if (expected == null) return;
  /** @type {string[]} */
  const mismatches = [];
  const cmp = (label, actual, want) => {
    if (want == null) return;
    if (actual !== want) mismatches.push(`${label}：期望 ${want}，实际 ${actual}`);
  };
  cmp('记忆（未删除）', after.memories, expected.memoriesActive);
  cmp('记忆（含已删除）', after.memoriesTotal, expected.memoriesTotal);
  cmp('向量', after.vectors, expected.vectors);
  cmp('待审批次（open）', after.batchesOpen, expected.batchesOpen);
  cmp('待审条目（pending）', after.batchItemsPending, expected.batchItemsPending);
  cmp('待处理变更单', after.plansActionable, expected.plansActionable);
  cmp('副审阅区（open）', after.handoffsOpen, expected.handoffsOpen);
  cmp('设置项', after.settings, expected.settings);
  if (mismatches.length > 0) {
    throw new RestoreError('VERIFY_FAILED', `快照还原后数字对不上（包坏了或目标被并发改过）：\n- ${mismatches.join('\n- ')}`);
  }
}

/**
 * merge 还原：文本包导入 + 待审批次/变更单/副审阅区/设置补齐。**只增不改**。
 *
 * @param {{ packageDir: string, dataDir: string, counts: Record<string, any>, pluginDir: string,
 *   dryRun: boolean, log: (line: string) => void }} input 入参
 * @returns {Promise<{ actions: string[], stats: Record<string, number>, after: ReturnType<typeof inspectTarget> }>} 结果
 */
async function restoreMerge({ packageDir, dataDir, counts, pluginDir, dryRun, log }) {
  const plugin = await loadPlugin(pluginDir);
  const dbPath = join(dataDir, 'memory.db');
  const actions = [];
  /** @type {Record<string, number>} */
  const stats = {
    memoriesAdded: 0,
    memoriesSkipped: 0,
    memoriesFailed: 0,
    batchesRestored: 0,
    batchesSkipped: 0,
    plansRestored: 0,
    plansSkipped: 0,
    handoffsRestored: 0,
    handoffsSkipped: 0,
    settingsAdded: 0,
    settingsSkipped: 0,
    spacesRestored: 0,
    spacesSkipped: 0,
    vectorsMissing: 0,
  };

  if (!dryRun) mkdirSync(dataDir, { recursive: true });
  const db = plugin.openDatabase(dbPath);
  try {
    const store = new plugin.MemoryStore(db, {});

    // ── 1. 记忆正文（按 hash 判重；同时建立 旧 id → 目标 id 的映射）────────────────
    const pack = plugin.readPack(join(packageDir, 'data', 'pack'));
    if (!pack.ok) throw new RestoreError('NO_PACK', pack.error ?? '数据包里的 pack 读不出来');
    /** @type {Map<string, string>} */
    const idMap = new Map();
    /** dry-run 用的「本包已见 hash」集合（同一包内重复正文只算一次，与真导入口径一致）。 */
    const seenHashes = new Set();
    for (const bad of pack.badLines ?? []) {
      stats.memoriesFailed += 1;
      log(`! 包内第 ${bad.line} 行读不出来：${bad.error}`);
    }
    for (const row of pack.rows) {
      const text = typeof row.text === 'string' ? row.text : '';
      if (text.trim() === '') {
        stats.memoriesSkipped += 1;
        continue;
      }
      if (dryRun) {
        // dry-run 用「库里现有 hash + 本包已见 hash」模拟判重，一个字节都不写
        const hash = store.hashText(text);
        const existing = seenHashes.has(hash) ? null : db.prepare('SELECT id FROM memories WHERE hash = ? LIMIT 1').get(hash);
        if (existing != null) {
          if (row.id != null) idMap.set(String(row.id), String(existing.id));
          stats.memoriesSkipped += 1;
        } else if (seenHashes.has(hash)) {
          stats.memoriesSkipped += 1;
        } else {
          seenHashes.add(hash);
          stats.memoriesAdded += 1;
        }
        continue;
      }
      const meta = { ...(row.metadata ?? {}), importedFrom: basename(packageDir), ...(row.id != null ? { originalId: String(row.id) } : {}) };
      let result;
      try {
        result = store.addMemory({
          text,
          scope: 'default',
          source: row.metadata?.source ?? null,
          section: row.metadata?.section ?? null,
          kind: row.metadata?.kind ?? null,
          meta,
        });
      } catch (error) {
        stats.memoriesFailed += 1;
        log(`! 一条记忆写入失败：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (result?.created === true) stats.memoriesAdded += 1;
      else stats.memoriesSkipped += 1;
      if (row.id != null && result?.id != null) idMap.set(String(row.id), String(result.id));
    }
    actions.push(
      `记忆：新增 ${stats.memoriesAdded} / 已存在跳过 ${stats.memoriesSkipped}${stats.memoriesFailed > 0 ? ` / 失败 ${stats.memoriesFailed}` : ''}`,
    );

    /** 把包里的旧记忆 id 换成本库里的 id；换不到的保留原值（不猜、不丢）。 */
    const remap = (id) => (id == null ? null : idMap.get(String(id)) ?? String(id));
    const remapJsonIds = (json) => {
      try {
        const list = JSON.parse(json);
        if (!Array.isArray(list)) return json;
        return JSON.stringify(list.map((id) => remap(id)));
      } catch {
        return json;
      }
    };
    /** 变更单 ops 里引用记忆 id 的字段：targets[]、before[].id。 */
    const remapOps = (opsJson) => {
      try {
        const ops = JSON.parse(opsJson);
        if (!Array.isArray(ops)) return opsJson;
        const next = ops.map((op) => ({
          ...op,
          targets: Array.isArray(op.targets) ? op.targets.map((id) => remap(id)) : op.targets,
          before: Array.isArray(op.before) ? op.before.map((row) => ({ ...row, id: remap(row.id) })) : op.before,
        }));
        return JSON.stringify(next);
      } catch {
        return opsJson;
      }
    };

    // ── 2. 待审阅批次（`batches` + `batch_items`）───────────────────────────────
    const batchesFile = join(packageDir, 'data', 'sidecars', 'batches.json');
    if (existsSync(batchesFile)) {
      const batches = JSON.parse(readFileSync(batchesFile, 'utf8'));
      for (const batch of Array.isArray(batches) ? batches : []) {
        if (db.prepare('SELECT id FROM batches WHERE id = ?').get(batch.id) != null) {
          stats.batchesSkipped += 1;
          continue;
        }
        stats.batchesRestored += 1;
        if (dryRun) continue;
        db.prepare(
          'INSERT INTO batches(id, created_at, model, source_text, focused, state, decided_at) VALUES(?,?,?,?,?,?,?)',
        ).run(batch.id, batch.created_at, batch.model ?? null, batch.source_text ?? '', batch.focused ?? 0, 'open', null);
        for (const item of Array.isArray(batch.items) ? batch.items : []) {
          const row = {
            idx: Number(item.idx ?? 0),
            text: String(item.text ?? ''),
            state: item.state === 'pending' ? 'pending' : String(item.state ?? 'pending'),
            editedText: item.edited_text ?? null,
            relation: item.relation ?? null,
            reason: item.reason ?? null,
            targetId: item.target_id == null ? null : remap(item.target_id),
            memoryId: item.memory_id == null ? null : remap(item.memory_id),
          };
          if (row.text.trim() === '') continue;
          db.prepare(
            'INSERT INTO batch_items(batch_id, idx, text, state, edited_text, relation, reason, target_id, memory_id, decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          ).run(batch.id, row.idx, row.text, row.state, row.editedText, row.relation, row.reason, row.targetId, row.memoryId, item.decided_at ?? null);
        }
      }
      actions.push(`待审批次：恢复 ${stats.batchesRestored} / 已存在跳过 ${stats.batchesSkipped}`);
    }

    // ── 3. 变更单（`keeper_plans`，只恢复还在等人处理的那几种状态）──────────────────
    const plansFile = join(packageDir, 'data', 'sidecars', 'keeper-plans.json');
    if (existsSync(plansFile)) {
      const plans = JSON.parse(readFileSync(plansFile, 'utf8'));
      for (const plan of Array.isArray(plans) ? plans : []) {
        if (db.prepare('SELECT id FROM keeper_plans WHERE id = ?').get(plan.id) != null) {
          stats.plansSkipped += 1;
          continue;
        }
        stats.plansRestored += 1;
        if (dryRun) continue;
        db.prepare(
          'INSERT INTO keeper_plans(id, run_id, created_at, state, seed_id, member_ids, ops, reviewed_at, review, note, model) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          plan.id,
          plan.run_id ?? null,
          plan.created_at,
          plan.state,
          plan.seed_id == null ? null : remap(plan.seed_id),
          remapJsonIds(plan.member_ids ?? '[]'),
          remapOps(plan.ops ?? '[]'),
          plan.reviewed_at ?? null,
          plan.review ?? null,
          plan.note ?? null,
          plan.model ?? null,
        );
      }
      actions.push(`变更单：恢复 ${stats.plansRestored} / 已存在跳过 ${stats.plansSkipped}`);
    }

    // ── 4. 副审阅区（`keeper_handoffs`，open 的）─────────────────────────────────
    const handoffsFile = join(packageDir, 'data', 'sidecars', 'keeper-handoffs.json');
    if (existsSync(handoffsFile)) {
      const handoffs = JSON.parse(readFileSync(handoffsFile, 'utf8'));
      for (const handoff of Array.isArray(handoffs) ? handoffs : []) {
        if (db.prepare('SELECT id FROM keeper_handoffs WHERE id = ?').get(handoff.id) != null) {
          stats.handoffsSkipped += 1;
          continue;
        }
        stats.handoffsRestored += 1;
        if (dryRun) continue;
        db.prepare(
          'INSERT INTO keeper_handoffs(id, run_id, created_at, updated_at, state, seed_id, member_ids, error, attempts, taker, plan_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          handoff.id,
          handoff.run_id ?? null,
          handoff.created_at,
          handoff.updated_at ?? handoff.created_at,
          'open',
          handoff.seed_id == null ? null : remap(handoff.seed_id),
          remapJsonIds(handoff.member_ids ?? '[]'),
          handoff.error ?? null,
          Number(handoff.attempts ?? 0),
          handoff.taker ?? null,
          handoff.plan_id ?? null,
        );
      }
      actions.push(`副审阅区：恢复 ${stats.handoffsRestored} / 已存在跳过 ${stats.handoffsSkipped}`);
    }

    // ── 5. 设置（只补缺的键，绝不覆盖目标已有配置）────────────────────────────────
    const settingsFile = join(packageDir, 'data', 'sidecars', 'settings.json');
    if (existsSync(settingsFile)) {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
      for (const [key, value] of Object.entries(settings ?? {})) {
        const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(key) != null;
        if (exists) {
          stats.settingsSkipped += 1;
          continue;
        }
        stats.settingsAdded += 1;
        if (dryRun) continue;
        db.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      actions.push(`设置：补齐 ${stats.settingsAdded} / 已存在跳过 ${stats.settingsSkipped}（密钥永远不在包里）`);
    }

    // ── 5.5 活动向量空间（目标 spaces 表为空时才写：告诉插件「记忆属于哪个空间」）───────
    const spacesFile = join(packageDir, 'data', 'sidecars', 'spaces.json');
    if (existsSync(spacesFile)) {
      const spaces = JSON.parse(readFileSync(spacesFile, 'utf8'));
      const existing = Number(db.prepare('SELECT COUNT(*) AS n FROM spaces').get().n);
      if (existing === 0 && spaces?.active != null) {
        stats.spacesRestored = 1;
        if (!dryRun) db.prepare('INSERT INTO spaces(key, value) VALUES(?,?)').run('active', String(spaces.active));
        actions.push('活动向量空间：已写回（目标原本没有）');
      } else if (existing > 0) {
        stats.spacesSkipped = 1;
        actions.push('活动向量空间：目标已有，保留目标的值');
      }
    }

    // ── 6. 向量缺口（merge 不搬向量：文本才是本体）────────────────────────────────
    if (!dryRun) {
      const space = store.getActiveSpace();
      if (space?.key) {
        const missing = store.countMissingVectors(space.key);
        stats.vectorsMissing = missing;
        actions.push(`向量：当前空间还缺 ${missing} 条（导入后由「补齐」或后台队列按当前模型重算）`);
      }
    }
  } finally {
    try {
      plugin.closeDatabase(db);
    } catch {
      /* 关不掉不是错 */
    }
  }

  const after = dryRun ? inspectTarget(dataDir) : inspectTarget(dataDir);
  if (!dryRun) verifyMergeCounts(after, counts, stats);
  return { actions, stats, after };
}

/**
 * merge 后的验收：记忆/待办**至少**有包里的那么多（目标原有数据只会让它更多）。
 *
 * @param {ReturnType<typeof inspectTarget>} after 还原后现状
 * @param {Record<string, any>} counts counts 对象
 * @param {Record<string, number>} stats merge 统计
 * @returns {void}
 */
export function verifyMergeCounts(after, counts, stats) {
  const expected = counts?.expected?.merge ?? null;
  if (expected == null) return;
  /** @type {string[]} */
  const problems = [];
  if (after.memories < expected.memoriesActive) {
    problems.push(`记忆（未删除）只有 ${after.memories}，包里应有 ${expected.memoriesActive}`);
  }
  if (after.batchesOpen < expected.batchesOpen) problems.push(`待审批次只有 ${after.batchesOpen}，包里应有 ${expected.batchesOpen}`);
  if (after.plansActionable < expected.plansActionable) {
    problems.push(`待处理变更单只有 ${after.plansActionable}，包里应有 ${expected.plansActionable}`);
  }
  if (after.handoffsOpen < expected.handoffsOpen) problems.push(`副审阅区只有 ${after.handoffsOpen}，包里应有 ${expected.handoffsOpen}`);
  if (stats.memoriesFailed > 0) problems.push(`有 ${stats.memoriesFailed} 条记忆写入失败（见上面的日志）`);
  if (problems.length > 0) throw new RestoreError('VERIFY_FAILED', `合并还原后的数字不对：\n- ${problems.join('\n- ')}`);
}

/**
 * 一键还原入口：校验包 → 选模式 → 还原 → 校验数字 → 报告。
 *
 * @param {{ packageDir: string, dataDir?: string | null, mode?: string, dryRun?: boolean,
 *   force?: boolean, verify?: boolean, pluginDir?: string | null,
 *   log?: (line: string) => void }} options 入参
 * @returns {Promise<{ ok: boolean, mode: string, dataDir: string, dryRun: boolean,
 *   actions: string[], stats: Record<string, number>, before: ReturnType<typeof inspectTarget>,
 *   after: ReturnType<typeof inspectTarget>, package: Record<string, any>, error?: string, code?: string }>} 结果
 */
export async function restorePersonalData({
  packageDir,
  dataDir = null,
  mode = 'auto',
  dryRun = false,
  force = false,
  verify = true,
  pluginDir = null,
  log = () => {},
} = {}) {
  const packageRoot = resolve(packageDir);
  const counts = loadCounts(packageRoot);
  const logLine = (line) => log(line);

  if (verify) {
    const integrity = verifyPackage(packageRoot, counts);
    if (!integrity.ok) {
      throw new RestoreError('PACKAGE_CORRUPT', `数据包完整性校验失败：\n- ${integrity.errors.join('\n- ')}`);
    }
    logLine(`✓ 包完整性 OK（${integrity.checked} 个文件 sha256 全部一致）`);
  }

  const targetDir = dataDir != null && dataDir !== '' ? resolve(dataDir) : detectDataDir().dataDir;
  const before = inspectTarget(targetDir);
  const { mode: chosen, reason } = decideMode({
    requested: mode,
    dbExists: before.dbExists,
    empty: isEmptyTarget(before),
    walPresent: before.walPresent,
  });
  logLine(`· 目标数据目录：${targetDir}`);
  logLine(`· 还原模式：${chosen}（${reason}）`);
  if (before.dbExists) {
    logLine(
      `· 目标现状：记忆 ${before.memories} 条（含已删 ${before.deleted}）· 向量 ${before.vectors} · 待审批次 ${before.batchesOpen} · 变更单 ${before.plansActionable} · 副审阅区 ${before.handoffsOpen}`,
    );
  } else {
    logLine('· 目标现状：库还不存在（全新部署）');
  }

  /** @type {string[]} */
  let actions = [];
  /** @type {Record<string, number>} */
  let stats = {};
  let resolvedPlugin = null;

  if (chosen === 'snapshot') {
    if (force === false && before.dbExists && isEmptyTarget(before) === false) {
      // decideMode 不会在非空目标上选 snapshot（除非显式）；显式 snapshot 时由这里要求 --force
      throw new RestoreError('TARGET_NOT_EMPTY', '目标库非空：快照替换会覆盖它。确认要覆盖请加 --force。');
    }
    const result = restoreSnapshot({ packageDir: packageRoot, dataDir: targetDir, counts, dryRun, log: logLine });
    actions = result.actions;
    stats = {
      memoriesActive: result.after.memories,
      memoriesTotal: result.after.memoriesTotal,
      vectors: result.after.vectors,
      batchesOpen: result.after.batchesOpen,
      plansActionable: result.after.plansActionable,
      handoffsOpen: result.after.handoffsOpen,
    };
  } else {
    const resolved = resolvePluginDir({ packageDir: packageRoot, pluginDir });
    resolvedPlugin = resolved.dir;
    logLine(`· 插件源码：${resolved.dir}（${resolved.source}）`);
    const result = await restoreMerge({
      packageDir: packageRoot,
      dataDir: targetDir,
      counts,
      pluginDir: resolved.dir,
      dryRun,
      log: logLine,
    });
    actions = result.actions;
    stats = result.stats;
  }

  const after = inspectTarget(targetDir);
  logLine('');
  logLine(`✓ 还原完成（${chosen}${dryRun ? ' / dry-run' : ''}）`);
  if (after.dbExists) {
    logLine(
      `  记忆 ${after.memories} 条 · 向量 ${after.vectors} · 待审批次 ${after.batchesOpen}（待审条目 ${after.batchItemsPending}）· 变更单 ${after.plansActionable} · 副审阅区 ${after.handoffsOpen} · 设置 ${after.settings}`,
    );
  }

  return {
    ok: true,
    mode: chosen,
    dataDir: targetDir,
    dryRun,
    actions,
    stats,
    before,
    after,
    package: {
      exportedAt: counts?.exportedAt ?? null,
      label: counts?.label ?? null,
      source: counts?.source ?? null,
      expected: counts?.expected ?? null,
    },
    pluginDir: resolvedPlugin,
  };
}
