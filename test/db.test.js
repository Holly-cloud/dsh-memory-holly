/**
 * db.js 测试：建库幂等、WAL、foreign_keys、版本号、事务回滚。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, closeDatabase, lastMigration, openDatabase, readSchemaVersion, spaceKeyOf, withTransaction } from '../src/host/db.js';
import { embeddingFingerprint, DEFAULT_CONFIG } from '../src/host/config.js';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('db');

after(() => cleanupTmpDir(TMP));

/**
 * 手搓一个 **v1** 的库（一条记忆一套向量），用来验证升级路径。
 *
 * 这段 DDL 是**历史快照**，不要跟着新 DDL 改：它的价值就在于「旧库长这样」。
 *
 * @param {string} file 文件路径
 * @param {{ memories: [string, string][], vectors: [string, string, number][], active?: object | null }} seed 数据
 * @returns {void}
 */
function seedV1Database(file, { memories, vectors, active = null }) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE memories(
      id TEXT PRIMARY KEY, text TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default',
      source TEXT, section TEXT, kind TEXT, meta TEXT NOT NULL DEFAULT '{}',
      hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE vectors(
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      model TEXT NOT NULL, dims INTEGER NOT NULL, vec BLOB NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_vectors_model_dims ON vectors(model, dims);
    CREATE TABLE spaces(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();
  for (const [id, text] of memories) {
    db.prepare(
      `INSERT INTO memories(id, text, scope, hash, created_at, updated_at, revision)
       VALUES (?, ?, 'default', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
    ).run(id, text, `hash-${id}`);
  }
  for (const [memoryId, model, dims] of vectors) {
    db.prepare('INSERT INTO vectors(memory_id, model, dims, vec, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      memoryId,
      model,
      dims,
      Buffer.from(new Float32Array([0.5, 0.5]).buffer),
      '2026-01-01T00:00:00.000Z',
    );
  }
  if (active !== null) db.prepare("INSERT INTO spaces(key, value) VALUES ('active', ?)").run(JSON.stringify(active));
  db.close();
}

test('迁移 v1→v2：老向量按它自己的 model/dims 归入空间，原表留底', () => {
  const file = join(TMP, 'migrate-v1.db');
  seedV1Database(file, {
    memories: [
      ['m1', '第一条'],
      ['m2', '第二条'],
      ['m3', '第三条'],
    ],
    vectors: [
      ['m1', 'qwen3.7-text-embedding', 2],
      ['m2', 'qwen3.7-text-embedding', 2],
    ],
    active: { model: 'qwen3.7-text-embedding', dims: 2 },
  });

  const db = openDatabase(file, { legacyProvider: 'openai' });
  assert.equal(readSchemaVersion(db), SCHEMA_VERSION, '版本号应升到 2');

  const migration = lastMigration(db);
  assert.equal(migration.migrated, true);
  assert.equal(migration.reason, 'v1-to-v2');
  assert.equal(migration.rows, 2);
  assert.equal(migration.backup, 'vectors_v1');

  // 搬过去的行带着空间键 + provider。
  const rows = db.prepare('SELECT memory_id, space, provider, model, dims FROM vectors ORDER BY memory_id').all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { memory_id: 'm1', space: 'openai:qwen3.7-text-embedding:2', provider: 'openai', model: 'qwen3.7-text-embedding', dims: 2 },
      { memory_id: 'm2', space: 'openai:qwen3.7-text-embedding:2', provider: 'openai', model: 'qwen3.7-text-embedding', dims: 2 },
    ],
  );

  // v1 的老表留底，没被删（provider 是猜的，留条后路）。
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM vectors_v1').get().c), 2);
  // spaces.active 被补上 key/provider。
  const active = JSON.parse(db.prepare("SELECT value FROM spaces WHERE key = 'active'").get().value);
  assert.deepEqual(active, {
    key: 'openai:qwen3.7-text-embedding:2',
    provider: 'openai',
    model: 'qwen3.7-text-embedding',
    dims: 2,
  });

  closeDatabase(db);

  // 再开一次：已经 v2 了，不再迁移，也不会重复搬。
  const again = openDatabase(file);
  assert.equal(lastMigration(again).migrated, false);
  assert.equal(lastMigration(again).reason, 'already-v2');
  assert.equal(Number(again.prepare('SELECT COUNT(*) AS c FROM vectors').get().c), 2);
  closeDatabase(again);
});

test('迁移 v1→v2：老库刚换过模型也不会把旧向量错认成新空间', () => {
  const file = join(TMP, 'migrate-stale.db');
  seedV1Database(file, {
    memories: [['m1', '第一条']],
    // 库里的向量是 old-model 算的，active 却已经被改成 new-model（升级前刚改配置的极端情况）。
    vectors: [['m1', 'old-model', 4]],
    active: { model: 'new-model', dims: 8 },
  });

  const db = openDatabase(file, { legacyProvider: 'ollama' });
  const row = db.prepare('SELECT space, provider, model, dims FROM vectors').get();
  assert.equal(row.space, 'ollama:old-model:4', '空间键来自行自己的 model/dims，不是 active 里的新模型');
  assert.equal(row.provider, 'ollama');
  assert.equal(Number(row.dims), 4);
  closeDatabase(db);
});

test('迁移 v1→v2：中断后重开会把没搬完的补上（幂等）', () => {
  const file = join(TMP, 'migrate-resume.db');
  seedV1Database(file, {
    memories: [
      ['m1', '第一条'],
      ['m2', '第二条'],
    ],
    vectors: [
      ['m1', 'model-x', 2],
      ['m2', 'model-x', 2],
    ],
  });

  // 手工造出「搬到一半」的状态：新表在、只搬了一条、留底表还在。
  const halfway = openDatabase(file, { legacyProvider: 'openai' });
  halfway.prepare("DELETE FROM vectors WHERE memory_id = 'm2'").run();
  closeDatabase(halfway);

  const resumed = openDatabase(file, { legacyProvider: 'openai' });
  const result = lastMigration(resumed);
  assert.equal(result.migrated, true);
  assert.equal(result.reason, 'resumed');
  assert.equal(Number(resumed.prepare('SELECT COUNT(*) AS c FROM vectors').get().c), 2, '漏掉的那条应被补回');
  closeDatabase(resumed);
});

/**
 * 手搓一个 **v3** 的库：有真实数据、但 `memories` 还没有两个行为计分列。
 *
 * 这段 DDL 同样是**历史快照**，不要跟着新 DDL 改：它存在的意义就是「v3 老库长这样」，
 * 用来验证 v3→v4 是**纯增量补列**而不是重建表。
 *
 * @param {string} file 文件路径
 * @param {{ memories: [string, string][] }} seed 数据
 * @returns {void}
 */
function seedV3Database(file, { memories }) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE memories(
      id TEXT PRIMARY KEY, text TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default',
      source TEXT, section TEXT, kind TEXT, meta TEXT NOT NULL DEFAULT '{}',
      hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE vectors(
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      space TEXT NOT NULL, provider TEXT, model TEXT NOT NULL, dims INTEGER NOT NULL,
      vec BLOB NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, space)
    );
    CREATE TABLE spaces(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE keeper_plans(
      id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT NOT NULL, state TEXT NOT NULL,
      seed_id TEXT, member_ids TEXT NOT NULL, ops TEXT NOT NULL,
      reviewed_at TEXT, review TEXT, note TEXT
    );
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '3')").run();
  for (const [id, text] of memories) {
    db.prepare(
      `INSERT INTO memories(id, text, scope, source, kind, meta, hash, created_at, updated_at, revision)
       VALUES (?, ?, 'default', '旧库', 'manual', '{"old":true}', ?, '2025-12-31T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 3)`,
    ).run(id, text, `hash-${id}`);
  }
  db.prepare("INSERT INTO settings(key, value) VALUES ('embedding.active', 'config')").run();
  db.close();
}

test('迁移 v3→v4：老库只 ADD COLUMN，数据一字不动、两列默认 0（不重建表）', () => {
  const file = join(TMP, 'migrate-v3-v4.db');
  seedV3Database(file, {
    memories: [
      ['m1', '第一条真实记忆'],
      ['m2', '第二条真实记忆'],
      ['m3', '第三条真实记忆'],
    ],
  });

  // 迁移前：v3 的表没有这两列。
  const before = new DatabaseSync(file);
  const beforeColumns = before.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name));
  assert.equal(beforeColumns.includes('read_score'), false, 'v3 老库本来没有 read_score');
  assert.equal(beforeColumns.includes('tidy_score'), false, 'v3 老库本来没有 tidy_score');
  const beforeRows = before
    .prepare('SELECT id, text, scope, source, kind, meta, hash, created_at, updated_at, deleted_at, revision FROM memories ORDER BY id')
    .all()
    .map((row) => ({ ...row }));
  before.close();
  assert.equal(beforeRows.length, 3);

  const db = openDatabase(file);
  assert.equal(readSchemaVersion(db), SCHEMA_VERSION, 'v3 老库一路升到当前版本号');
  const scoreMigration = lastMigration(db).scoreColumns;
  assert.equal(scoreMigration.migrated, true);
  assert.equal(scoreMigration.reason, 'v3-to-v4');
  assert.deepEqual(scoreMigration.added, ['read_score', 'tidy_score'], '两列按固定顺序补上');
  // 向量迁移在这条路上什么都不做（v3 的 vectors 已经是按空间保留的）。
  assert.equal(lastMigration(db).reason, 'already-v2');

  // 补上的两列在末尾，且类型是 REAL NOT NULL DEFAULT 0。
  const info = db.prepare('PRAGMA table_info(memories)').all();
  const tail = info.slice(-2).map((row) => ({ name: String(row.name), type: String(row.type), notnull: Number(row.notnull), dflt: Number(row.dflt_value) }));
  assert.deepEqual(tail, [
    { name: 'read_score', type: 'REAL', notnull: 1, dflt: 0 },
    { name: 'tidy_score', type: 'REAL', notnull: 1, dflt: 0 },
  ]);

  // 老数据一字不动 + 两列默认 0。
  const afterRows = db
    .prepare('SELECT id, text, scope, source, kind, meta, hash, created_at, updated_at, deleted_at, revision, read_score, tidy_score FROM memories ORDER BY id')
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(
    afterRows.map((row) => ({ ...row, read_score: Number(row.read_score), tidy_score: Number(row.tidy_score) })),
    beforeRows.map((row) => ({ ...row, read_score: 0, tidy_score: 0 })),
    '除两个新列外，老字段必须逐字相同',
  );
  assert.deepEqual(afterRows.map((row) => row.read_score), [0, 0, 0]);
  assert.deepEqual(afterRows.map((row) => row.tidy_score), [0, 0, 0]);
  db.close();

  // 再开一次：已经 v4，不再补列；写进去的分值必须留住。
  const again = openDatabase(file);
  assert.equal(lastMigration(again).scoreColumns.migrated, false);
  assert.equal(lastMigration(again).scoreColumns.reason, 'already-v4');
  again.prepare('UPDATE memories SET read_score = 7.5 WHERE id = ?').run('m2');
  closeDatabase(again);

  const third = openDatabase(file);
  assert.equal(Number(third.prepare('SELECT read_score FROM memories WHERE id = ?').get('m2').read_score), 7.5);
  assert.equal(Number(third.prepare('SELECT COUNT(*) AS c FROM memories').get().c), 3, '一条都不能少');
  closeDatabase(third);
});

test('迁移：老库的裸 AFTER UPDATE 触发器收窄成 UPDATE OF text（计分写入不再碰 FTS）', () => {
  const file = join(TMP, 'migrate-fts-trigger.db');
  seedV3Database(file, { memories: [['m1', '第一条真实记忆']] });

  // 手工造出「老定义」：裸 AFTER UPDATE（外部内容 FTS5 表此时是空的，索引与主表不同步）。
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  raw.close();

  const db = openDatabase(file);
  const ftsMigration = lastMigration(db).ftsTriggers;
  assert.equal(ftsMigration.migrated, true, '老库的宽触发器要被换掉');
  assert.equal(ftsMigration.reason, 'narrow-to-text');
  const triggerSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_fts_au'").get().sql);
  assert.match(triggerSql, /AFTER\s+UPDATE\s+OF\s+text\s+ON\s+memories/i, '新定义必须带 OF text');

  // 关键收益：写计分列不再触发 FTS 重建 —— 索引与主表不同步时也不会抛 malformed。
  assert.doesNotThrow(() => db.prepare('UPDATE memories SET read_score = read_score + 1 WHERE id = ?').run('m1'));
  assert.equal(Number(db.prepare('SELECT read_score FROM memories WHERE id = ?').get('m1').read_score), 1);
  closeDatabase(db);

  // 再开一次：已经是窄的，不再迁移。
  const again = openDatabase(file);
  assert.equal(lastMigration(again).ftsTriggers.migrated, false);
  assert.equal(lastMigration(again).ftsTriggers.reason, 'already-narrow');
  closeDatabase(again);
  // 「改正文仍会同步 FTS」由 store.test.js 的 FTS 同步 / 关键词检索用例在全新库上钉住
  // （本用例的索引刻意是不同步的旧库状态，正文改写那条路在这里本来就会炸，不是被测行为）。
});

test('空间键口径一致：spaceKeyOf 与 config.js 的 embeddingFingerprint 必须同值', () => {
  const embedding = DEFAULT_CONFIG.embedding;
  assert.equal(
    spaceKeyOf({ provider: embedding.provider, model: embedding.model, dims: embedding.dimensions }),
    embeddingFingerprint(embedding),
  );
  assert.equal(spaceKeyOf({ provider: 'local-hash', model: 'x', dims: 64 }), embeddingFingerprint({ provider: 'local-hash', model: 'x', localDims: 64 }));
});

test('建库幂等：同一个文件开两次不报错，表与版本号都在', () => {
  const file = join(TMP, 'idempotent.db');

  const first = openDatabase(file);
  const tables = first
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
    .all()
    .map((row) => String(row.name));
  closeDatabase(first);

  assert.ok(existsSync(file), '数据库文件应该落盘');
  assert.ok(tables.includes('memories'), 'memories 表应存在');
  assert.ok(tables.includes('memories_fts'), 'memories_fts 应存在');
  assert.ok(tables.includes('memories_fts_ai') && tables.includes('memories_fts_au') && tables.includes('memories_fts_ad'),
    'FTS 同步触发器应存在');

  const second = openDatabase(file);
  assert.equal(readSchemaVersion(second), SCHEMA_VERSION);
  assert.equal(
    String(second.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value),
    String(SCHEMA_VERSION),
  );
  closeDatabase(second);

  // 关两次是安全的空操作。
  closeDatabase(second);
});

test('WAL 在文件库上生效；:memory: 上不启用', () => {
  const file = openDatabase(join(TMP, 'wal.db'));
  assert.equal(String(file.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  closeDatabase(file);

  const memory = openDatabase(':memory:');
  assert.notEqual(String(memory.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  closeDatabase(memory);
});

test('foreign_keys 生效（PRAGMA=1 且外键真的拦得住）', () => {
  const db = openDatabase(join(TMP, 'fk.db'));
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);

  assert.throws(
    () => db.prepare('INSERT INTO vectors(memory_id, space, provider, model, dims, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('不存在的记忆', 'test:m:1', 'test', 'm', 1, Buffer.from(new Float32Array([1]).buffer), new Date().toISOString()),
    /FOREIGN KEY/i,
  );
  closeDatabase(db);
});

test('schema 版本号写入；磁盘版本号更新时拒绝打开', () => {
  const file = join(TMP, 'version.db');
  const db = openDatabase(file);
  assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
  db.exec(`UPDATE schema_meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
  closeDatabase(db);

  assert.throws(() => openDatabase(file), /版本过新/);
});

test('schema v3/v4/v5：keeper_plans / 行为计分列 / keeper_handoffs 随 DDL 建出来（纯增量，不碰旧表）', () => {
  const file = join(TMP, 'keeper-plans.db');
  const db = openDatabase(file);
  assert.equal(SCHEMA_VERSION, 5, 'v4 = 两个行为计数列，v5 = 待接手记忆表');
  assert.equal(readSchemaVersion(db), SCHEMA_VERSION);

  // v4 的两个计分列：全新库由 DDL 直接带上，默认 0。
  const memoryColumns = db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name));
  assert.ok(memoryColumns.includes('read_score'), '全新库该有 read_score');
  assert.ok(memoryColumns.includes('tidy_score'), '全新库该有 tidy_score');
  assert.equal(lastMigration(db).scoreColumns.reason, 'already-v4', '全新库不需要补列');

  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'keeper_plans'")
    .get();
  assert.ok(table != null, 'keeper_plans 表应随建库一并建出来');
  const columns = db.prepare('PRAGMA table_info(keeper_plans)').all().map((row) => String(row.name));
  assert.deepEqual(columns, [
    'id', 'run_id', 'created_at', 'state', 'seed_id', 'member_ids', 'ops', 'reviewed_at', 'review', 'note', 'model',
  ]);
  // `model` = 「产出这张单的模型」（增量列，**不抬 SCHEMA_VERSION**）：全新库由 DDL 直接带上，
  // 老库由 `migratePlanModel()` 补。
  assert.equal(lastMigration(db).planModel.reason, 'already-has-model', '全新库不需要补列');
  db.prepare(
    "INSERT INTO keeper_plans(id, run_id, created_at, state, seed_id, member_ids, ops, model) VALUES ('p0', 'r0', '2026-10-08T00:00:00.000Z', 'open', 'm0', '[\"m0\"]', '[]', 'qwen3.8-flash')",
  ).run();
  assert.equal(String(db.prepare('SELECT model FROM keeper_plans WHERE id = ?').get('p0').model), 'qwen3.8-flash');

  // 写一行进去：JSON 列是 TEXT，主键是 TEXT（和 batches / jobs 同一套路）
  db.prepare(
    "INSERT INTO keeper_plans(id, run_id, created_at, state, seed_id, member_ids, ops) VALUES ('p1', 'r1', '2026-10-07T00:00:00.000Z', 'open', 'm1', '[\"m1\"]', '[]')",
  ).run();
  assert.equal(String(db.prepare('SELECT state FROM keeper_plans WHERE id = ?').get('p1').state), 'open');

  // v5 的 keeper_handoffs（待接手记忆）：列顺序与默认值都钉住 —— 它是新表，没有迁移函数，
  // 「建出来没建对」这件事只能靠断言守。
  const handoffColumns = db.prepare('PRAGMA table_info(keeper_handoffs)').all().map((row) => String(row.name));
  assert.deepEqual(handoffColumns, [
    'id', 'run_id', 'created_at', 'updated_at', 'state', 'seed_id', 'member_ids', 'error', 'attempts', 'taker', 'plan_id',
  ]);
  db.prepare(
    "INSERT INTO keeper_handoffs(id, run_id, created_at, updated_at, state, seed_id, member_ids, error) VALUES ('h1', 'r1', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z', 'open', 'm1', '[\"m1\"]', 'boom')",
  ).run();
  const handoff = db.prepare('SELECT * FROM keeper_handoffs WHERE id = ?').get('h1');
  assert.equal(String(handoff.state), 'open');
  assert.equal(Number(handoff.attempts), 0, 'attempts 默认 0（累加由 store 做）');
  assert.equal(handoff.taker, null);
  closeDatabase(db);

  // v1 老库升级到最新 schema：老表原样保留，新表 / 新列建出来，版本号一次到位。
  const legacy = join(TMP, 'migrate-v1-to-v3.db');
  seedV1Database(legacy, { memories: [['m1', '第一条']], vectors: [['m1', 'model-x', 2]] });
  const upgraded = openDatabase(legacy, { legacyProvider: 'openai' });
  assert.equal(lastMigration(upgraded).reason, 'v1-to-v2', '向量表迁移照旧只做 v1→v2');
  assert.equal(lastMigration(upgraded).scoreColumns.reason, 'v3-to-v4', '计分列迁移在升级路径上也要跑');
  assert.equal(readSchemaVersion(upgraded), SCHEMA_VERSION);
  assert.equal(Number(upgraded.prepare('SELECT COUNT(*) AS c FROM vectors_v1').get().c), 1, '老向量表留底');
  assert.ok(
    upgraded.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'keeper_plans'").get() != null,
    '升级路径上也要建出 keeper_plans',
  );
  assert.ok(
    upgraded.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'keeper_handoffs'").get() != null,
    '升级路径上也要建出 keeper_handoffs（v5 是纯新建表，DDL 直接带出来）',
  );
  closeDatabase(upgraded);
});

test('keeper_plans.model 增量列：老库（没有这一列）在开库时被 ALTER 补上，且**不抬 SCHEMA_VERSION**', () => {
  // 为什么要「不抬版本」：加一列可空列不改"这份代码要求什么形状" —— 旧代码打开新库照样能用。
  // 抬上去会让用户一旦回退插件代码，库就被版本闸门挡住打不开（不值得为一个署名列付这个代价）。
  const file = join(TMP, 'plans-model-column.db');
  const fresh = openDatabase(file);
  fresh.exec('ALTER TABLE keeper_plans DROP COLUMN model');
  closeDatabase(fresh);

  const reopened = openDatabase(file);
  assert.equal(readSchemaVersion(reopened), 5, '版本号保持不变');
  assert.equal(lastMigration(reopened).planModel.reason, 'plans-add-model', '识别为"补列"');
  assert.deepEqual(lastMigration(reopened).planModel.added, ['model']);
  const columns = reopened.prepare('PRAGMA table_info(keeper_plans)').all().map((row) => String(row.name));
  assert.ok(columns.includes('model'), '补列之后老库也有 model');
  assert.equal(reopened.prepare('SELECT model FROM keeper_plans LIMIT 1').all().length, 0, '老行不写值 = NULL');
  closeDatabase(reopened);

  // 幂等：再开一次什么都不做
  const again = openDatabase(file);
  assert.equal(lastMigration(again).planModel.reason, 'already-has-model');
  closeDatabase(again);
});

test('withTransaction 出错时回滚，嵌套时用 SAVEPOINT 只回滚内层', () => {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t(v TEXT)');

  assert.throws(() => withTransaction(db, () => {
    db.prepare('INSERT INTO t(v) VALUES (?)').run('outer');
    throw new Error('boom');
  }), /boom/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM t').get().c), 0, '外层回滚后不应有行');

  withTransaction(db, () => {
    db.prepare('INSERT INTO t(v) VALUES (?)').run('keep');
    try {
      withTransaction(db, () => {
        db.prepare('INSERT INTO t(v) VALUES (?)').run('drop');
        throw new Error('inner');
      });
    } catch {
      /* 内层失败被外层吞掉 */
    }
  });
  const values = db.prepare('SELECT v FROM t').all().map((row) => String(row.v));
  assert.deepEqual(values, ['keep']);

  closeDatabase(db);
});

test('readOnly 打开：不建表、能读已有数据', () => {
  const file = join(TMP, 'readonly.db');
  const write = openDatabase(file);
  write.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('k', 'v');
  closeDatabase(write);

  const read = openDatabase(file, { readOnly: true });
  assert.equal(String(read.prepare('SELECT value FROM settings WHERE key = ?').get('k').value), 'v');
  closeDatabase(read);
});
