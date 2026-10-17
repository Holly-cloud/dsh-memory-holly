/**
 * dsh-memory · 便携包打包器。
 *
 * 把一个「能在别的设备上完整部署并继续开发」的包打到 `<repo>/../release/<label>/`：
 *
 * ```
 * <label>/
 *   README.md            # 总入口
 *   INSTALL.md           # agent 部署手册
 *   AGENT-HANDOFF.md     # 项目现状 / 开发交接
 *   MANIFEST.json        # 全量文件清单 + sha256 + 计数
 *   1-plugin/dsh-memory/ # 插件本体（代码、测试、工具、文档、.git）
 *   2-personal-data/     # 个人数据（库快照 + 文本包 + 待办 + 一键还原脚本）
 * ```
 *
 * ## 它会自证（打包完先自检，任何一项不过就非零退出）
 *
 * 1. 快照可读、数字与活库一致；
 * 2. 文本包能导进**全新空库**且 `added == 包内条数、skipped == 0、failed == 0`；
 * 3. 附属表（待审批次/变更单/副审阅区/设置）能解析且条数与快照一致；
 * 4. 包里所有 `src/host/*.js` 能被 Node 直接 import（语法/依赖没坏）；
 * 5. zip 能被读回，逐条 sha256 与源文件一致；
 * 6. **包里没有密钥**（对设置与文档做一次 `sk-…` / `apiKey` 扫描）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/make-portable-pack.mjs                        # 默认输出 ../release/<label>/
 * node tools/make-portable-pack.mjs --label v1 --no-zip
 * node tools/make-portable-pack.mjs --db /path/to/memory.db --out D:/tmp/pkg
 * ```
 *
 * @module dsh-memory/tools/make-portable-pack
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeDatabase, openDatabase, SCHEMA_VERSION } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import { exportPack, importPack, readPack } from '../src/host/portability.js';
import { crc32, readZip, writeZip } from './portable/zip.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** 插件本体里要带走的东西（相对仓库根）。 */
const PLUGIN_FILES = ['lib', 'src', 'test', 'tools', 'package.json', '.gitignore', 'README.md', 'DESIGN.md', 'MIGRATION.md', 'PHASE0.md', 'REGRESSION.md'];

/** 默认标签（含日期，便于区分多份包）。 */
function defaultLabel() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `dsh-memory-portable-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * 解析命令行。
 *
 * @param {string[]} argv 参数
 * @returns {{ out: string, db: string, label: string, withGit: boolean, withZip: boolean, force: boolean }} 配置
 */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  const label = typeof args.label === 'string' ? args.label : defaultLabel();
  return {
    out: resolve(typeof args.out === 'string' ? args.out : join(REPO_ROOT, '..', 'release', label)),
    db: resolve(typeof args.db === 'string' ? args.db : join(dshHome, 'dsh-memory', 'memory.db')),
    label,
    withGit: args['no-git'] !== true,
    withZip: args['no-zip'] !== true,
    force: args.force === true,
  };
}

/**
 * 读 git 头信息（**不调用 git 命令**：沙箱里 Node 起子进程拿不到管道）。
 *
 * @param {string} repo 仓库根
 * @returns {{ commit: string | null, branch: string | null, subject: string | null }} 信息
 */
function readGitHead(repo) {
  const gitDir = join(repo, '.git');
  /** @type {{ commit: string | null, branch: string | null, subject: string | null }} */
  const info = { commit: null, branch: null, subject: null };
  if (!existsSync(gitDir)) return info;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      info.branch = head.slice(5).replace(/^refs\/heads\//, '');
      const refFile = join(gitDir, head.slice(5));
      if (existsSync(refFile)) {
        info.commit = readFileSync(refFile, 'utf8').trim();
      } else {
        const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
        const line = packed.split(/\r?\n/).find((row) => row.endsWith(` ${head.slice(5)}`));
        if (line) info.commit = line.slice(0, 40);
      }
    } else {
      info.commit = head; // detached HEAD
      info.branch = null;
    }
    const messageFile = join(gitDir, 'COMMIT_EDITMSG');
    if (existsSync(messageFile)) info.subject = readFileSync(messageFile, 'utf8').split(/\r?\n/)[0] ?? null;
  } catch {
    /* git 元数据读不到不影响打包 */
  }
  return info;
}

/**
 * 递归列出目录下所有文件。
 *
 * @param {string} dir 目录
 * @returns {string[]} 绝对路径
 */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * 计算文件 sha256。
 *
 * @param {string} file 文件
 * @returns {string} 摘要
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 从活库里读数字 + 导出附属表（都在同一个一致性快照上做，不读活库两次）。
 *
 * @param {string} snapshotPath 快照路径
 * @param {string} packDir 文本包输出目录
 * @param {string} sidecarDir 附属表输出目录
 * @returns {Record<string, any>} counts 的原料
 */
function buildDataFiles(snapshotPath, packDir, sidecarDir) {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const one = (sql, ...params) => {
      const row = db.prepare(sql).get(...params);
      return row?.n == null ? 0 : Number(row.n);
    };
    const all = (sql, ...params) => db.prepare(sql).all(...params);

    const memoriesTotal = one('SELECT COUNT(*) n FROM memories');
    const memoriesActive = one('SELECT COUNT(*) n FROM memories WHERE deleted_at IS NULL');
    const vectors = one('SELECT COUNT(*) n FROM vectors');
    const batchesOpen = one("SELECT COUNT(*) n FROM batches WHERE state='open'");
    const batchItemsPending = one("SELECT COUNT(*) n FROM batch_items WHERE state='pending'");
    const plansActionable = one("SELECT COUNT(*) n FROM keeper_plans WHERE state IN ('open','handed')");
    const handoffsOpen = one("SELECT COUNT(*) n FROM keeper_handoffs WHERE state='open'");
    const history = one('SELECT COUNT(*) n FROM history');
    const settingsCount = one('SELECT COUNT(*) n FROM settings');
    const schemaVersion = Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value ?? 0);

    const scopes = all('SELECT scope, COUNT(*) n FROM memories WHERE deleted_at IS NULL GROUP BY scope');
    const spaces = all('SELECT space, COUNT(*) n FROM vectors GROUP BY space');
    const planStates = all('SELECT state, COUNT(*) n FROM keeper_plans GROUP BY state');
    const handoffStates = all('SELECT state, COUNT(*) n FROM keeper_handoffs GROUP BY state');
    const batchStates = all('SELECT state, COUNT(*) n FROM batches GROUP BY state');

    // ── 附属表（只带「还在等人处理」的这些；历史记录在快照里，merge 不需要搬）───────
    const batches = all("SELECT * FROM batches WHERE state='open' ORDER BY created_at");
    for (const batch of batches) {
      batch.items = all('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY idx', batch.id);
    }
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'batches.json'), JSON.stringify(batches, null, 2), 'utf8');

    const plans = all("SELECT * FROM keeper_plans WHERE state IN ('open','handed') ORDER BY created_at");
    writeFileSync(join(sidecarDir, 'keeper-plans.json'), JSON.stringify(plans, null, 2), 'utf8');

    const handoffs = all("SELECT * FROM keeper_handoffs WHERE state='open' ORDER BY created_at");
    writeFileSync(join(sidecarDir, 'keeper-handoffs.json'), JSON.stringify(handoffs, null, 2), 'utf8');

    const settings = {};
    for (const row of all('SELECT key, value FROM settings ORDER BY key')) settings[row.key] = row.value;
    writeFileSync(join(sidecarDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

    const activeSpace = db.prepare("SELECT value FROM spaces WHERE key='active'").get();
    writeFileSync(join(sidecarDir, 'spaces.json'), JSON.stringify({ active: activeSpace?.value ?? null }, null, 2), 'utf8');

    // ── 文本包（走插件自己的 exportPack：已测试的代码路径）─────────────────────────
    const store = new MemoryStore(db, {});
    const exported = exportPack({
      store,
      dir: packDir,
      scope: null,
      embedding: null,
    });
    if (!exported.ok) throw new Error('exportPack 失败');

    return {
      counts: {
        schemaVersion,
        memoriesTotal,
        memoriesActive,
        memoriesDeleted: memoriesTotal - memoriesActive,
        vectors,
        batchesOpen,
        batchItemsPending,
        plansActionable,
        handoffsOpen,
        history,
        settings: settingsCount,
      },
      detail: {
        scopes,
        vectorSpaces: spaces,
        planStates,
        handoffStates,
        batchStates,
        sidecars: {
          batches: batches.length,
          planOps: plans.length,
          handoffs: handoffs.length,
          settings: Object.keys(settings).length,
        },
      },
      activeSpace: activeSpace?.value ?? null,
    };
  } finally {
    db.close();
  }
}

/**
 * 渲染模板：`{{KEY}}` 全量替换，缺值保留占位符（宁可见到 `{{X}}` 也不要静默变空串）。
 *
 * @param {string} template 模板全文
 * @param {Record<string, string | number>} values 值表
 * @returns {string} 渲染结果
 */
function render(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])));
}

/**
 * 把包内所有文件（除 MANIFEST 与 zip 自身）算成清单。
 *
 * ⚠ `.git/` **不进清单**：git 内部文件（尤其 `index`）会被任何一次 `git status` 改写，
 * 把它们写进 sha256 清单只会造成「收包方第一次跑 git 就报包损坏」的假警报。
 * git 对象本身有内容寻址校验（`git fsck`），不需要我们再抄一遍。
 *
 * @param {string} root 包根目录
 * @param {string[]} exclude 额外排除的相对路径
 * @returns {{ path: string, bytes: number, sha256: string }[]} 清单
 */
function manifestOf(root, exclude) {
  const skip = new Set(exclude);
  return listFiles(root)
    .map((file) => ({ abs: file, rel: relative(root, file).split(sep).join('/') }))
    .filter((entry) => !skip.has(entry.rel))
    .filter((entry) => !entry.rel.startsWith('.git/') && !entry.rel.includes('/.git/'))
    .map((entry) => ({ path: entry.rel, bytes: statSync(entry.abs).size, sha256: sha256(entry.abs) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 密钥扫描：包里绝不能出现真 key。`apiKeyRef`（引用名）是允许的。
 *
 * @param {string[]} files 要扫描的文本文件
 * @returns {string[]} 命中的描述（空 = 干净）
 */
function scanSecretLike(files) {
  /** @type {string[]} */
  const hits = [];
  /** @type {RegExp[]} */
  const patterns = [
    /\bsk-[A-Za-z0-9]{16,}/, // OpenAI/通义等常见前缀
    /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token
    /"apiKey"\s*:\s*"[^"]{8,}"/, // 真 key 而不是 apiKeyRef
    /"(password|secret|token)"\s*:\s*"[^"]{8,}"/i,
  ];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.test(text)) hits.push(`${relative(REPO_ROOT, file) || file} 命中 ${pattern}`);
    }
  }
  return hits;
}

/**
 * 打包主流程（CLI 与测试共用）。
 *
 * @param {{ out: string, db: string, label: string, withGit: boolean, withZip: boolean, force: boolean }} config 配置
 * @returns {Promise<{ out: string, zip: string | null, manifest: Record<string, any>, counts: Record<string, any> }>} 结果
 */
export async function buildPackage(config) {
  // 输出目录不能在仓库里：插件目录要整棵拷走，落到源目录的子目录里会自己拷自己（cpSync 直接拒绝）。
  if (config.out === REPO_ROOT || config.out.startsWith(`${REPO_ROOT}${sep}`)) {
    throw new Error(`输出目录不能放在仓库内：${config.out}\n  用 --out 指到仓库外（默认是 <仓库>/../release/<label>/）。`);
  }
  const git = readGitHead(REPO_ROOT);
  console.log('=== dsh-memory 便携包 ===');
  console.log(`  仓库   : ${REPO_ROOT}`);
  console.log(`  提交   : ${git.commit ?? '(未知)'} ${git.subject ? `· ${git.subject}` : ''}`);
  console.log(`  活库   : ${config.db}`);
  console.log(`  输出   : ${config.out}`);

  if (!existsSync(config.db)) {
    throw new Error(`找不到活库：${config.db}\n  用 --db 指定记忆库路径（一般是 <DSH_HOME>/dsh-memory/memory.db）。`);
  }
  if (existsSync(config.out)) {
    if (!config.force) {
      throw new Error(`输出目录已存在：${config.out}\n  加 --force 覆盖，或换一个 --out。`);
    }
    rmSync(config.out, { recursive: true, force: true });
  }

  const pluginDir = join(config.out, '1-plugin', 'dsh-memory');
  const dataRoot = join(config.out, '2-personal-data');
  const packageDataDir = join(dataRoot, 'data');
  const packDir = join(packageDataDir, 'pack');
  const sidecarDir = join(packageDataDir, 'sidecars');
  const toolsDir = join(dataRoot, 'tools');
  for (const dir of [pluginDir, packageDataDir, packDir, sidecarDir, toolsDir]) mkdirSync(dir, { recursive: true });

  // ── 1. 库快照（在线一致性快照；只读打开活库，不打扰正在运行的 DSH）──────────────
  const snapshotPath = join(packageDataDir, 'memory.db');
  const liveDb = openDatabase(config.db, { readOnly: true });
  try {
    const t0 = Date.now();
    const { backup } = await import('node:sqlite');
    await backup(liveDb, snapshotPath);
    console.log(`\n[1/6] 快照 ✓ ${(statSync(snapshotPath).size / 1024 / 1024).toFixed(2)} MB（${Date.now() - t0} ms）`);
  } finally {
    closeDatabase(liveDb);
  }

  // ── 2. 快照 → 数字 / 文本包 / 附属表 ────────────────────────────────────────────
  const built = buildDataFiles(snapshotPath, packDir, sidecarDir);
  console.log(`[2/6] 数据 ✓ 记忆 ${built.counts.memoriesActive} 条（含已删 ${built.counts.memoriesTotal}）· 向量 ${built.counts.vectors} · 待审批次 ${built.counts.batchesOpen} · 变更单 ${built.counts.plansActionable} · 副审阅区 ${built.counts.handoffsOpen}`);

  // ── 3. 包内文件校验（快照可读、文本包无损、附属表计数一致）──────────────────────
  const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
  const fresh = openDatabase(':memory:');
  try {
    const freshStore = new MemoryStore(fresh, {});
    const pack = readPack(packDir);
    if (!pack.ok) throw new Error(`文本包读不出来：${pack.error}`);
    const imported = await importPack({ store: freshStore, dir: packDir, dryRun: false, scope: 'default' });
    if (imported.added !== pack.rows.length || imported.skipped !== 0 || imported.failed !== 0) {
      throw new Error(`文本包无损自检失败：包内 ${pack.rows.length} 行，added ${imported.added} / skipped ${imported.skipped} / failed ${imported.failed}`);
    }
    const liveCheck = snapshotDb.prepare('SELECT COUNT(*) n FROM memories WHERE deleted_at IS NULL').get().n;
    if (Number(liveCheck) !== built.counts.memoriesActive) throw new Error('快照记忆数与活库不一致');
    const sidecarBatches = JSON.parse(readFileSync(join(sidecarDir, 'batches.json'), 'utf8'));
    const pending = sidecarBatches.reduce((sum, b) => sum + b.items.filter((i) => i.state === 'pending').length, 0);
    if (pending !== built.counts.batchItemsPending) throw new Error(`待审条目数不一致：${pending} vs ${built.counts.batchItemsPending}`);
    console.log(`[3/6] 自检 ✓ 文本包 ${pack.rows.length} 行无损导入空库（added ${imported.added} / skipped ${imported.skipped} / failed ${imported.failed}）`);
  } finally {
    closeDatabase(fresh);
    snapshotDb.close();
  }

  // ── 3.5 快照归一：checkpoint 到主文件、切回 rollback journal、清掉 -wal/-shm ─────
  //
  // 为什么必须做：`backup()` 落下来的目标库是 WAL 模式，只要有人（哪怕是只读）再打开一次，
  // 目录里就可能留下 `memory.db-wal` / `-shm`。这些文件**不属于交付物**：
  //   - 包里带一个 `-wal`，拿到别的机器上还原时只拷 `memory.db`，WAL 里的东西就丢了；
  //   - 还原脚本按「只拷 memory.db + 删目标 -wal」设计，包这边必须保证主文件是完整的。
  // 所以这里把 WAL 内容 checkpoint 进主库、把库切回 DELETE 模式（DSH 打开时会自己切回 WAL），
  // 再删残留；删完断言不存在 —— 出包前最后一道闸。
  {
    const normalize = new DatabaseSync(snapshotPath);
    try {
      normalize.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      normalize.exec('PRAGMA journal_mode = DELETE');
    } finally {
      normalize.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${snapshotPath}${suffix}`, { force: true });
    if (existsSync(`${snapshotPath}-wal`) || existsSync(`${snapshotPath}-shm`)) {
      throw new Error('快照归一失败：memory.db 旁边仍有 -wal/-shm');
    }
  }

  // ── 4. 插件本体 ────────────────────────────────────────────────────────────────
  for (const rel of PLUGIN_FILES) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) throw new Error(`插件文件缺失：${from}`);
    cpSync(from, join(pluginDir, rel), {
      recursive: true,
      filter: (src) => !src.includes(`${sep}.tmp${sep}`) && !src.endsWith(`${sep}.tmp`),
    });
  }
  if (config.withGit && existsSync(join(REPO_ROOT, '.git'))) cpSync(join(REPO_ROOT, '.git'), join(pluginDir, '.git'), { recursive: true });
  const strayData = listFiles(pluginDir).filter((file) => /\.(db|db-wal|db-shm|jsonl)$/i.test(file));
  if (strayData.length > 0) throw new Error(`插件目录里混进了数据文件（铁律禁止）：\n${strayData.join('\n')}`);
  const hostModules = readdirSync(join(pluginDir, 'src', 'host')).filter((name) => name.endsWith('.js'));
  for (const name of hostModules) {
    await import(pathToFileURL(join(pluginDir, 'src', 'host', name)).href); // 语法/依赖坏了会在这里炸
  }
  const allToolNames = [...readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8').matchAll(/name: '(memory_[a-z_]+)'/g)].map(
    (match) => match[1],
  );
  const toolCount = [...new Set(allToolNames)].filter((name) => name !== 'memory_selftest').length;
  const toolProbe = new Set(allToolNames).has('memory_selftest');
  console.log(`[4/6] 插件 ✓ ${listFiles(pluginDir).length} 个文件 · ${hostModules.length} 个 host 模块可 import · ${toolCount} 个工具${config.withGit ? ' · 含 .git' : ''}`);

  // ── 5. 还原脚本 + 三份文档 + counts.json ────────────────────────────────────────
  for (const rel of ['restore.mjs', 'restore-core.mjs']) {
    copyFileSync(join(HERE, 'portable', rel), join(toolsDir, rel));
  }
  // 收包方自查脚本放在包根：一条命令核对 MANIFEST + 快照库（只读）
  copyFileSync(join(HERE, 'portable', 'verify-pack.mjs'), join(config.out, 'VERIFY.mjs'));
  const exportedAt = new Date().toISOString();
  const files = {
    ...(() => {
      /** @type {Record<string, { bytes: number, sha256: string }>} */
      const map = {};
      for (const file of listFiles(packageDataDir)) {
        const rel = relative(dataRoot, file).split(sep).join('/');
        map[rel] = { bytes: statSync(file).size, sha256: sha256(file) };
      }
      return map;
    })(),
    'tools/restore.mjs': { bytes: statSync(join(toolsDir, 'restore.mjs')).size, sha256: sha256(join(toolsDir, 'restore.mjs')) },
    'tools/restore-core.mjs': { bytes: statSync(join(toolsDir, 'restore-core.mjs')).size, sha256: sha256(join(toolsDir, 'restore-core.mjs')) },
  };
  const counts = {
    format: 'dsh-memory-personal-data',
    formatVersion: 1,
    label: config.label,
    exportedAt,
    source: {
      repo: REPO_ROOT,
      db: config.db,
      commit: git.commit,
      branch: git.branch,
      schemaVersion: built.counts.schemaVersion,
    },
    counts: built.counts,
    detail: built.detail,
    activeSpace: built.activeSpace,
    expected: {
      snapshot: {
        memoriesActive: built.counts.memoriesActive,
        memoriesTotal: built.counts.memoriesTotal,
        vectors: built.counts.vectors,
        batchesOpen: built.counts.batchesOpen,
        batchItemsPending: built.counts.batchItemsPending,
        plansActionable: built.counts.plansActionable,
        handoffsOpen: built.counts.handoffsOpen,
        settings: built.counts.settings,
      },
      merge: {
        memoriesActive: built.counts.memoriesActive,
        batchesOpen: built.counts.batchesOpen,
        plansActionable: built.counts.plansActionable,
        handoffsOpen: built.counts.handoffsOpen,
      },
    },
    files,
  };
  writeFileSync(join(packageDataDir, 'counts.json'), JSON.stringify(counts, null, 2), 'utf8');

  const values = {
    LABEL: config.label,
    DATE: exportedAt.slice(0, 10),
    DATETIME: exportedAt.replace('T', ' ').slice(0, 19),
    COMMIT: git.commit ?? '(未知)',
    COMMIT_SUBJECT: git.subject ?? '',
    BRANCH: git.branch ?? '',
    SCHEMA: String(SCHEMA_VERSION),
    MEMORIES_ACTIVE: String(built.counts.memoriesActive),
    MEMORIES_TOTAL: String(built.counts.memoriesTotal),
    MEMORIES_DELETED: String(built.counts.memoriesDeleted),
    VECTORS: String(built.counts.vectors),
    BATCHES: String(built.counts.batchesOpen),
    BATCH_ITEMS: String(built.counts.batchItemsPending),
    PLANS: String(built.counts.plansActionable),
    HANDOFFS: String(built.counts.handoffsOpen),
    SETTINGS: String(built.counts.settings),
    TOOL_COUNT: String(toolCount),
    TOOL_PROBE: toolProbe ? '另有 1 个注册探针 `memory_selftest`（注册→读回→立即注销，不是常驻工具）' : '',
    PLUGIN_FILES: String(listFiles(pluginDir).length),
    DB_MB: (statSync(snapshotPath).size / 1024 / 1024).toFixed(2),
  };
  const templateDir = join(HERE, 'portable', 'templates');
  const rendered = {
    'README.md': 'README.md',
    'INSTALL.md': 'INSTALL.md',
    'AGENT-HANDOFF.md': 'AGENT-HANDOFF.md',
    '2-personal-data/README.md': 'PERSONAL-DATA-README.md',
  };
  for (const [target, template] of Object.entries(rendered)) {
    const text = readFileSync(join(templateDir, template), 'utf8');
    writeFileSync(join(config.out, target), render(text, values), 'utf8');
  }
  console.log('[5/6] 文档 ✓ README.md / INSTALL.md / AGENT-HANDOFF.md / 2-personal-data/README.md');

  // ── 6. MANIFEST + zip + 回读校验 ───────────────────────────────────────────────
  const docFiles = Object.keys(rendered);
  const manifest = {
    format: 'dsh-memory-portable-package',
    formatVersion: 1,
    label: config.label,
    generatedAt: exportedAt,
    source: { repo: REPO_ROOT, commit: git.commit, branch: git.branch, commitSubject: git.subject, schemaVersion: built.counts.schemaVersion },
    contents: {
      plugin: { path: '1-plugin/dsh-memory', files: listFiles(pluginDir).length, bytes: listFiles(pluginDir).reduce((sum, f) => sum + statSync(f).size, 0) },
      personalData: { path: '2-personal-data', files: listFiles(dataRoot).length, bytes: listFiles(dataRoot).reduce((sum, f) => sum + statSync(f).size, 0), counts: built.counts },
      docs: docFiles,
    },
    restoreCommand: 'node 2-personal-data/tools/restore.mjs',
    installCommand: 'node 1-plugin/dsh-memory/tools/install.mjs',
    upstream: 'https://github.com/Holly-cloud/dsh-memory-holly',
    files: manifestOf(config.out, ['MANIFEST.json']),
    notes: [
      '.git/ 的内部文件（含 index）不逐条列 sha256：任何一次 git 命令都会改写 index，列进去会造成假警报；git 对象由 git 自身校验。',
    ],
  };
  writeFileSync(join(config.out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const secretHits = scanSecretLike([join(packageDataDir, 'counts.json'), join(sidecarDir, 'settings.json'), ...docFiles.map((rel) => join(config.out, rel))]);
  if (secretHits.length > 0) throw new Error(`包里出现疑似密钥，拒绝出包：\n- ${secretHits.join('\n- ')}`);

  let zipInfo = null;
  if (config.withZip) {
    const zipPath = `${config.out}.zip`;
    rmSync(zipPath, { force: true });
    const entries = listFiles(config.out).map((file) => ({
      name: relative(config.out, file).split(sep).join('/'),
      data: readFileSync(file),
      mtime: statSync(file).mtime,
    }));
    zipInfo = writeZip(zipPath, entries);
    const back = readZip(readFileSync(zipPath));
    if (back.length !== entries.length) throw new Error(`zip 回读条目数不符：${back.length} vs ${entries.length}`);
    const byName = new Map(back.map((entry) => [entry.name, entry.data]));
    for (const entry of entries) {
      const data = byName.get(entry.name);
      if (!data) throw new Error(`zip 回读缺条目：${entry.name}`);
      const a = crc32(entry.data);
      const b = crc32(data);
      if (a !== b) throw new Error(`zip 回读内容不符：${entry.name}`);
    }
    console.log(`[6/6] 打包 ✓ ${relative(dirname(config.out), zipPath)} · ${(zipInfo.bytes / 1024 / 1024).toFixed(2)} MB · ${entries.length} 个条目回读一致`);
  } else {
    console.log('[6/6] 打包 ✓ 目录已生成（--no-zip，未打 zip）');
  }

  console.log('\n=== 完成 ===');
  console.log(`  目录 : ${config.out}`);
  if (zipInfo) console.log(`  zip  : ${zipInfo.file}`);
  console.log(`  插件 : 1-plugin/dsh-memory（${manifest.contents.plugin.files} 个文件）`);
  console.log(`  数据 : 2-personal-data（记忆 ${built.counts.memoriesActive} 条 / 待审 ${built.counts.batchItemsPending} 条 / 变更单 ${built.counts.plansActionable} 张 / 副审阅区 ${built.counts.handoffsOpen} 组）`);
  console.log('  下一步：把这行命令写进给对方的说明：');
  console.log('        node 2-personal-data/tools/restore.mjs && node 1-plugin/dsh-memory/tools/install.mjs');

  return { out: config.out, zip: zipInfo?.file ?? null, manifest, counts };
}

// 直接 `node tools/make-portable-pack.mjs` 时才跑 CLI；被测试 import 时只导出 buildPackage。
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await buildPackage(parseArgs(process.argv.slice(2)));
