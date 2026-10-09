/**
 * dsh-memory · Phase 1：数据库打开与 schema 建立。
 *
 * 本模块是「数据与检索内核」的最底层，只依赖 `node:sqlite`（Node 24 / Electron 44 内置），
 * 不含任何第三方依赖、不含任何网络调用。
 *
 * 设计要点：
 * 1. 所有 DDL 都是 `IF NOT EXISTS`，因此 `openDatabase` 天然幂等（开两次不报错）。
 * 2. `memories_fts` 用 **外部内容表**（`content='memories'`）+ 三个触发器与主表同步，
 *    这样软删/硬删/改文本都不会让索引与主表漂移。
 * 3. 版本号写在 `schema_meta.schema_version`；若磁盘上的版本号**大于**本代码的
 *    `SCHEMA_VERSION`，说明是「用旧代码打开新库」，直接抛错而不是静默损坏数据。
 *
 * @module dsh-memory/host/db
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * 当前代码期望的 schema 版本。任何破坏性结构变更都必须同时提升这个常量。
 *
 * - v1：`vectors` 主键是 `memory_id` —— **一条记忆只有一套向量**，换嵌入模型就得重算全库。
 * - v2：`vectors` 主键是 `(memory_id, space)`，`space` 是 `provider:model:dims` 指纹。
 *   同一批记忆可以同时保留多套向量，切回旧模型时只需补齐「那个空间里还缺的」。
 * - v3：新增 `keeper_plans` 表（仓管的**变更单**）。仓管不再直接改库，只出单；
 *   人审阅通过后才落库。**纯增量**：不碰任何旧表，也不需要迁移老数据。
 * - v4：`memories` 加两列 `read_score` / `tidy_score`（每条记忆的两个行为计数器：
 *   被 agent 正常读取的次数、被仓管抽进一组的次数）。**纯增量**：全新库直接在 DDL 里带上，
 *   老库用 `ALTER TABLE ... ADD COLUMN` 补列（**绝不重建表**——库里有真实数据），
 *   既有行的两列默认 0，其它字段一个字不动。衰减时间戳存在 `settings['score.decayedAt']`。
 * - v5：新增 `keeper_handoffs` 表（**待接手记忆**）—— 仓管某一组出错时不再白丢：那一组
 *   记进这张表等人/等本地模型接手。同样是**纯增量**：DDL 里 `IF NOT EXISTS`，老库直接建表。
 */
export const SCHEMA_VERSION = 5;

/** FTS5 内容表的名字（`search.js` 与测试都会引用）。 */
export const FTS_TABLE = 'memories_fts';

/**
 * 完整 DDL。
 *
 * 注意 `memories.id` 是 TEXT 主键，所以表仍然有隐式 `rowid`——
 * 这正是外部内容 FTS5 需要的 `content_rowid='rowid'`。
 * 触发器里的 `'delete'` 命令行是 FTS5 官方要求的外部内容表删除写法。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY, text TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default',
  source TEXT, section TEXT, kind TEXT, meta TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
  -- 两个行为计数器（schema v4）：老库由 migrateScoreColumns() 用 ALTER TABLE 补上。
  read_score REAL NOT NULL DEFAULT 0, tidy_score REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_scope_created ON memories(scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
-- ⚠ **必须是 AFTER UPDATE OF text**，不能是裸 AFTER UPDATE：外部内容 FTS5 的 delete 命令
-- 只有在「删的行确实在索引里」时才安全，而且正文没变时重建索引纯属白付代价。
-- v4 起每次 memory_search 命中都会写计分列（read_score）；裸 AFTER UPDATE 会让每一次
-- 计分都触发一遍 FTS 删+插，既拖慢检索，又会在「索引与主表不同步」的老库上直接抛
-- database disk image is malformed。老库的触发器由 migrateFtsTriggers() 换成这条。
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- 向量按「空间」保留（schema v2）：space = provider:model:dims 指纹。
-- 同一批记忆可以同时存在多套向量，换模型不再需要把旧的删掉重算。
CREATE TABLE IF NOT EXISTS vectors(
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  space TEXT NOT NULL, provider TEXT, model TEXT NOT NULL, dims INTEGER NOT NULL,
  vec BLOB NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, space)
);

CREATE TABLE IF NOT EXISTS spaces(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, memory_id TEXT NOT NULL,
  op TEXT NOT NULL, prev_text TEXT, next_text TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_memory ON history(memory_id, id DESC);

CREATE TABLE IF NOT EXISTS batches(
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, model TEXT, source_text TEXT NOT NULL,
  focused INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'open', decided_at TEXT
);

CREATE TABLE IF NOT EXISTS batch_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  edited_text TEXT, relation TEXT, reason TEXT, target_id TEXT, memory_id TEXT, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id, idx);

CREATE TABLE IF NOT EXISTS palace_sources(
  path TEXT PRIMARY KEY, kind TEXT, mtime_ms INTEGER, size INTEGER,
  content_hash TEXT, chunk_count INTEGER, synced_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, total INTEGER, done INTEGER,
  failed INTEGER, started_at TEXT, finished_at TEXT, error TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_started ON jobs(kind, started_at DESC);

-- 仓管的「变更单」（schema v3）：一张单 = 一组语义相关记忆的一组操作（ops 存 JSON）。
-- 仓管跑一轮**只写这张表**，记忆库一个字都不动；state 由审阅决定
-- （open → approved / rejected / partial），review 记下人的勾选与编辑（JSON）。
-- model 列（v3 之后增量补的列，见 migratePlanModel）：**产出这张单的模型名**。
-- 为什么要存下来：审阅落库时给 metadata 里那个 model 盖章用的是"谁改的"——以前读的是
-- **主仓管那一轮**的 job.model，于是副仓管出的单会被盖成主仓管的模型名（用户 2026-10-08
-- 「主副仓管独立」）。存进单里，谁产的谁署名，两条线各说各的。
CREATE TABLE IF NOT EXISTS keeper_plans(
  id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT NOT NULL, state TEXT NOT NULL,
  seed_id TEXT, member_ids TEXT NOT NULL, ops TEXT NOT NULL,
  reviewed_at TEXT, review TEXT, note TEXT, model TEXT
);
CREATE INDEX IF NOT EXISTS idx_keeper_plans_state ON keeper_plans(state, created_at DESC);

-- 待接手记忆（schema v5）：仓管某一组**出错**时，那一组进过的记忆不再白丢 —— 一行 = 一组待整理
-- 的记忆（成员 id 存 JSON，正文不复制：正文只有一个源头，仍在 memories 里）。
-- state：open（等人/等模型接手）| taken（已被接手并出单）| dropped（人主动清掉）。
CREATE TABLE IF NOT EXISTS keeper_handoffs(
  id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  state TEXT NOT NULL, seed_id TEXT, member_ids TEXT NOT NULL, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, taker TEXT, plan_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_keeper_handoffs_state ON keeper_handoffs(state, created_at DESC);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * `vectors` 的索引。
 *
 * ⚠ **必须在 v1→v2 迁移之后**再建：v1 的 `vectors` 表没有 `space` 列，
 * 而 `CREATE INDEX ... (space)` 在缺列时会直接抛 `no such column: space`。
 * 所以这些语句从 `DDL` 里拆出来，由 `openDatabase` 在迁移后单独执行。
 */
const VECTORS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_vectors_space ON vectors(space, memory_id);
CREATE INDEX IF NOT EXISTS idx_vectors_model_dims ON vectors(model, dims);
`;

/**
 * 空间键：`provider:model:dims`。
 *
 * 这是「同一套向量」的身份。库里的向量按它分组保留，切换嵌入模型时新建一个空间，
 * **不动**旧空间的任何一行；切回来只补那个空间里缺的。
 *
 * ⚠ 与 `config.js` 的 `embeddingFingerprint` **必须同口径**（`test/db.test.js` 有一条断言盯着），
 * 否则「配置算出来的空间」与「表里存的空间」会对不上，表现成「明明算过却还要全量重算」。
 *
 * @param {{ provider?: string | null, model: string, dims: number }} input 三个要素
 * @returns {string} 空间键
 */
export function spaceKeyOf({ provider = 'openai', model, dims } = {}) {
  return `${String(provider ?? 'openai')}:${String(model)}:${Number(dims)}`;
}

/**
 * v1 → v2：把「一条记忆一套向量」原地升级成「按空间保留」。
 *
 * 步骤（整体在一个事务里）：
 * 1. 把老表改名成 `vectors_v1` 留底（**故意不删**：万一 provider 猜错了，原数据还在）；
 * 2. 重跑一次 `DDL` 建出新的 `(memory_id, space)` 表；
 * 3. 逐行搬过去，`space` 用行自己的 `model`/`dims` + 调用方给的 provider 提示拼出来
 *    —— **不用当前配置拼**，否则「升级前刚换了模型」会把旧向量错误地当成新空间的。
 *
 * 幂等：已经是 v2 就什么都不做；上次中途挂掉（`vectors_v1` 还在）会把没搬完的补上。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @param {{ providerHint?: string }} [options] provider 提示（v1 没存 provider，只能猜）
 * @returns {{ migrated: boolean, reason: string, rows: number, backup?: string }} 迁移结果
 */
export function migrateVectorsToSpaces(db, { providerHint = 'openai' } = {}) {
  const hint = String(providerHint || 'openai');
  /** @param {string} name 表名 */
  const tableExists = (name) =>
    db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;

  if (!tableExists('vectors')) return { migrated: false, reason: 'no-vectors-table', rows: 0 };

  const columns = db.prepare('PRAGMA table_info(vectors)').all().map((row) => String(row.name));
  const isV2 = columns.includes('space');

  /** 从留底表搬数据（`INSERT OR IGNORE`：重跑不会覆盖已有的新数据）。 */
  const copy = () =>
    db
      .prepare(
        `INSERT OR IGNORE INTO vectors(memory_id, space, provider, model, dims, vec, updated_at)
         SELECT memory_id, ? || ':' || model || ':' || dims, ?, model, dims, vec, updated_at FROM vectors_v1`,
      )
      .run(hint, hint);

  if (isV2) {
    if (tableExists('vectors_v1')) {
      const info = copy();
      if (Number(info.changes) > 0) return { migrated: true, reason: 'resumed', rows: Number(info.changes), backup: 'vectors_v1' };
    }
    return { migrated: false, reason: 'already-v2', rows: 0 };
  }

  return withTransaction(db, () => {
    db.exec('DROP INDEX IF EXISTS idx_vectors_model_dims');
    if (tableExists('vectors_v1')) {
      // 极端情况：留底表已存在但当前表还是 v1（有人手工拷回来的库）。老表先删，避免重名。
      db.exec('DROP TABLE vectors');
    } else {
      db.exec('ALTER TABLE vectors RENAME TO vectors_v1');
    }
    db.exec(DDL); // 全部是 IF NOT EXISTS：此时 `vectors` 已不存在，于是建成 v2
    const info = copy();
    return { migrated: true, reason: 'v1-to-v2', rows: Number(info.changes), backup: 'vectors_v1' };
  });
}

/** v3 → v4 要补的两列（列名 → 列定义）。顺序固定，方便测试与日志对齐。 */
const SCORE_COLUMNS = [
  ['read_score', 'REAL NOT NULL DEFAULT 0'],
  ['tidy_score', 'REAL NOT NULL DEFAULT 0'],
];

/**
 * v3 → v4：给 `memories` 补两个行为计数器列。
 *
 * **纯增量、绝不重建表**：库里有上千条真实数据，`ALTER TABLE ... ADD COLUMN` 是唯一安全的做法
 * （重建表要拷全表数据 + 搬 FTS/触发器/索引，任何一步出错都是数据事故）。
 * 两列都带 `NOT NULL DEFAULT 0`，因此既有行补列后**默认 0**，别的字段一个字不动。
 *
 * 幂等：先用 `PRAGMA table_info(memories)` 看列在不在，都在就什么都不做。
 * 全新库由 `DDL` 直接建成带这两列的表，到这里自然也是「什么都不做」。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @returns {{ migrated: boolean, reason: string, added: string[] }} 迁移结果
 */
export function migrateScoreColumns(db) {
  let exists;
  try {
    exists = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get() != null;
  } catch {
    return { migrated: false, reason: 'no-sqlite_master', added: [] };
  }
  if (!exists) return { migrated: false, reason: 'no-memories-table', added: [] };

  const present = new Set(db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name)));
  /** @type {string[]} */
  const added = [];
  if (SCORE_COLUMNS.every(([name]) => present.has(name))) {
    return { migrated: false, reason: 'already-v4', added };
  }

  withTransaction(db, () => {
    for (const [name, definition] of SCORE_COLUMNS) {
      if (present.has(name)) continue;
      db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
      added.push(name);
    }
  });
  return { migrated: true, reason: 'v3-to-v4', added };
}

/**
 * 给 `keeper_plans` 补 `model` 列（**增量、绝不重建表**，与 v3→v4 计分列同一套做法）。
 *
 * 存在意义：审阅落库时新记忆要盖「谁改的」章（`memories.meta.model`），而"谁"以前是从
 * **主仓管那一轮**的 job 上读的 —— 副仓管接手的单会被盖成主仓管的模型名（用户 2026-10-08：
 * 「主副仓管独立，各自的运行不能互相产生干扰」）。存进单里就没有这个问题。
 *
 * ⚠️ **不抬 `SCHEMA_VERSION`**：加一列可空列不改"这份代码要求什么形状"（旧代码打开新库照样能用，
 * 只是读不到这一列），所以不必把版本闸门往上顶 —— 顶上去会让用户一旦回退插件代码，库就打不开了。
 * 幂等：先看 `PRAGMA table_info(keeper_plans)`。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @returns {{ migrated: boolean, reason: string, added: string[] }} 迁移结果
 */
export function migratePlanModel(db) {
  let exists;
  try {
    exists = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'keeper_plans'").get() != null;
  } catch {
    return { migrated: false, reason: 'no-sqlite_master', added: [] };
  }
  if (!exists) return { migrated: false, reason: 'no-keeper_plans-table', added: [] };
  const present = new Set(db.prepare('PRAGMA table_info(keeper_plans)').all().map((row) => String(row.name)));
  if (present.has('model')) return { migrated: false, reason: 'already-has-model', added: [] };
  withTransaction(db, () => {
    db.exec('ALTER TABLE keeper_plans ADD COLUMN model TEXT');
  });
  return { migrated: true, reason: 'plans-add-model', added: ['model'] };
}

/**
 * FTS 的 UPDATE 触发器名字（`migrateFtsTriggers()` 与测试都会引用）。
 */
export const FTS_UPDATE_TRIGGER = 'memories_fts_au';

/**
 * 把老库上「裸 `AFTER UPDATE`」的 FTS 同步触发器收窄成 `AFTER UPDATE OF text`。
 *
 * 为什么必须迁移：`CREATE TRIGGER IF NOT EXISTS` 对已存在的触发器**什么都不做**，
 * 所以 DDL 里的新定义只对全新库生效；老库（包括本机那份有上千条真实数据的库）会一直
 * 带着旧的宽触发器。而 v4 起每次 `memory_search` 命中都会 UPDATE 计分列 —— 宽触发器会让
 * 每一次计分都白做一遍「FTS 删 + 插」（拖慢检索），并在索引与主表不同步的老库上直接抛
 * `database disk image is malformed`（外部内容 FTS5 删一条不在索引里的行就是这个错）。
 *
 * 只动触发器定义，**不碰任何数据、不重建表**。幂等：已经是窄的就不动。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @returns {{ migrated: boolean, reason: string }} 迁移结果
 */
export function migrateFtsTriggers(db) {
  let row;
  try {
    row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(FTS_UPDATE_TRIGGER);
  } catch {
    return { migrated: false, reason: 'no-sqlite_master' };
  }
  if (row == null) return { migrated: false, reason: 'no-trigger' };
  const sql = String(row.sql ?? '');
  if (/AFTER\s+UPDATE\s+OF\s+text\s+ON/i.test(sql)) return { migrated: false, reason: 'already-narrow' };

  withTransaction(db, () => {
    db.exec(`DROP TRIGGER IF EXISTS ${FTS_UPDATE_TRIGGER}`);
    db.exec(`CREATE TRIGGER ${FTS_UPDATE_TRIGGER} AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;`);
  });
  return { migrated: true, reason: 'narrow-to-text' };
}

/**
 * 把 `spaces.active` 归一成带 `key` / `provider` 的形状（幂等，v1 的记录缺这两项）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @param {{ providerHint?: string }} [options] provider 提示
 * @returns {{ ok: boolean, changed: boolean, error?: string }} 结果
 */
export function normalizeActiveSpace(db, { providerHint = 'openai' } = {}) {
  const hint = String(providerHint || 'openai');
  let row;
  try {
    row = db.prepare("SELECT value FROM spaces WHERE key = 'active'").get();
  } catch (error) {
    return { ok: false, changed: false, error: String(error?.message ?? error) };
  }
  if (row == null) return { ok: true, changed: false };

  let parsed;
  try {
    parsed = JSON.parse(String(row.value));
  } catch {
    return { ok: false, changed: false, error: 'spaces.active 不是合法 JSON' };
  }
  if (parsed == null || typeof parsed.model !== 'string' || parsed.model === '') {
    return { ok: false, changed: false, error: 'spaces.active 缺少 model' };
  }

  const dims = Number(parsed.dims);
  const provider = typeof parsed.provider === 'string' && parsed.provider !== '' ? parsed.provider : hint;
  const key = typeof parsed.key === 'string' && parsed.key !== '' ? parsed.key : spaceKeyOf({ provider, model: parsed.model, dims });
  const next = { key, provider, model: parsed.model, dims };

  if (parsed.key === next.key && parsed.provider === next.provider && Number(parsed.dims) === dims) {
    return { ok: true, changed: false };
  }
  db.prepare("INSERT INTO spaces(key, value) VALUES ('active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(next),
  );
  return { ok: true, changed: true };
}

/**
 * 读取库里的 schema 版本号。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的数据库句柄
 * @returns {number | null} 版本号；表不存在或没有记录时返回 `null`
 */
export function readSchemaVersion(db) {
  try {
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
    if (row == null) return null;
    const parsed = Number.parseInt(String(row.value), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // 表还不存在（全新库 / 只读句柄）：视为「无版本号」。
    return null;
  }
}

/**
 * 打开（必要时初始化）一个 dsh-memory 数据库。
 *
 * 依次执行：`busy_timeout` → `foreign_keys` → 非 `:memory:` 且非只读时 `journal_mode=WAL`
 * → 建表/索引/触发器 → **v1→v2 向量表迁移** → **v3→v4 计分列迁移** → 写 `schema_meta.schema_version`。
 * （v5 的 `keeper_handoffs` 是**纯新建表**，由上面的 `DDL` 直接建出，没有单独的迁移函数。）
 *
 * @param {string} file 数据库文件路径，或 `':memory:'`
 * @param {{ readOnly?: boolean, legacyProvider?: string }} [options]
 *   `readOnly: true` 时跳过全部 DDL 与迁移；
 *   `legacyProvider`：v1 的向量行没存 provider，升级时用它拼空间键（默认 `'openai'`）。
 * @returns {import('node:sqlite').DatabaseSync} 数据库句柄
 */
export function openDatabase(file, { readOnly = false, legacyProvider = 'openai' } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error('openDatabase：file 必须是非空字符串（文件路径或 ":memory:"）');
  }

  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');

    if (!readOnly && file !== ':memory:') {
      // WAL 让读写并发不互相阻塞；内存库没有 WAL 概念，跳过。
      db.exec('PRAGMA journal_mode = WAL');
    }

    const found = readSchemaVersion(db);
    if (found !== null && found > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本过新：文件里是 ${found}，本代码支持到 ${SCHEMA_VERSION}。` +
          '请升级 dsh-memory 插件，或改用另一个数据目录。',
      );
    }

    if (!readOnly) {
      db.exec(DDL);
      // 顺序不能换：先 DDL（全新库直接建成 v2 + v4），再迁移老库，最后才能建带 `space` 的索引。
      const migration = migrateVectorsToSpaces(db, { providerHint: legacyProvider });
      // v3 → v4：补两个计分列。**在 DDL 之后**跑（老库的 memories 已存在，DDL 不会补列），
      // 与向量迁移互不依赖；一起挂在同一个迁移结果上，面板/日志能一次看全。
      const scoreMigration = migrateScoreColumns(db);
      // 计分列会被频繁 UPDATE，必须把 FTS 触发器收窄到 `OF text`，否则每次计分都白做一遍
      // FTS 删+插（详见该函数文档）。
      const ftsTriggers = migrateFtsTriggers(db);
      // `keeper_plans.model`：增量列（不抬 SCHEMA_VERSION），见 migratePlanModel 的文档。
      const planModel = migratePlanModel(db);
      LAST_MIGRATION.set(db, { ...migration, scoreColumns: scoreMigration, ftsTriggers, planModel });
      db.exec(VECTORS_INDEXES);
      normalizeActiveSpace(db, { providerHint: legacyProvider });
      db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION));
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* 关闭失败时保留原始错误 */
    }
    throw err;
  }

  return db;
}

/** 每个句柄最近一次打开时的迁移结果（WeakMap，句柄回收后自动释放）。 */
const LAST_MIGRATION = new WeakMap();

/**
 * 读最近一次 `openDatabase` 的迁移结果。
 *
 * 形状 = `migrateVectorsToSpaces()` 的返回值 + `scoreColumns`（v3→v4 计分列）+ `ftsTriggers`
 * （FTS UPDATE 触发器收窄成 `OF text`）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @returns {{ migrated: boolean, reason: string, rows: number, backup?: string,
 *   scoreColumns?: { migrated: boolean, reason: string, added: string[] },
 *   planModel?: { migrated: boolean, reason: string, added: string[] },
 *   ftsTriggers?: { migrated: boolean, reason: string } } | null} 迁移结果
 */
export function lastMigration(db) {
  return LAST_MIGRATION.get(db) ?? null;
}

/**
 * 关闭数据库句柄（对已关闭的句柄调用是安全的空操作）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @returns {void}
 */
export function closeDatabase(db) {
  if (db == null) return;
  if (typeof db.isOpen === 'boolean' && !db.isOpen) return;
  db.close();
}

/**
 * 事务包装器：保证多步写要么全成、要么全滚。
 *
 * 嵌套调用用 SAVEPOINT 降级（内层回滚不会连累外层），
 * 因为 `store.js` 里既有「公开方法各自开事务」也有「公开方法互相调用」。
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db 数据库句柄
 * @param {() => T} fn 事务体（同步函数）
 * @returns {T} `fn` 的返回值
 */
export function withTransaction(db, fn) {
  const depth = TX_DEPTH.get(db) ?? 0;
  const savepoint = `dsh_memory_sp_${depth}`;

  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  TX_DEPTH.set(db, depth + 1);

  try {
    const result = fn();
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    if (depth === 0) TX_DEPTH.delete(db);
    else TX_DEPTH.set(db, depth);
    return result;
  } catch (err) {
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      /* 回滚自身失败时保留原始错误 */
    }
    if (depth === 0) TX_DEPTH.delete(db);
    else TX_DEPTH.set(db, depth);
    throw err;
  }
}

/** 记录每个句柄当前的事务嵌套深度（WeakMap，句柄回收后自动释放）。 */
const TX_DEPTH = new WeakMap();
