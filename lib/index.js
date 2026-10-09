/**
 * dsh-memory — 宿主半边（Node / Cordis）。
 *
 * ## 平台约束（实测，见 DESIGN.md §A）
 * 本文件**不得 import 任何 `@deepseek-ai/*` 裸说明符**：这些包只活在 `app.asar` 里，
 * 磁盘上没有副本，import 一律 `ERR_MODULE_NOT_FOUND`。宿主能力全部经 `ctx` 服务访问。
 * 只能 import `node:*` 内置模块，以及本包内的相对路径模块。
 *
 * ## 观测通道
 * `GET http://127.0.0.1:<端口>/dsh-memory-selftest/*`（走 webserver 前缀表，不经 `/api`，
 * 故本机免鉴权）。存在的理由：`/api` 下的路由要过会话 Cookie，命令行无法自造；
 * 而沙箱化的 shell 又拿不到 TLS 凭据发不出 HTTPS。没有这条通道就没有任何自证手段。
 * **收口已完成**：该路由仅在 `config.diagnostics === true` 时注册，**默认关闭**。
 * 它上面有 `/import`（读任意文件）、`/credential`（写凭据）、`/clean`（改数据）、
 * `/search`（吐记忆正文）——本机任何进程都能调，所以只在排查时临时打开。
 *
 * @module dsh-memory
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

import { closeDatabase, lastMigration, openDatabase, withTransaction } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import { hybridSearch } from '../src/host/search.js';
import { createEmbedder } from '../src/host/embed.js';
import { embeddingFingerprint, normalizeConfig } from '../src/host/config.js';
import { analyzeConflicts } from '../src/host/conflict.js';
import { reviewBatch, rejectBatch, stageExtraction } from '../src/host/review.js';
import { extractFacts } from '../src/host/extract.js';
import { ConversationBuffer, isForeignSession, isHumanMessage, lastHumanMessage, messageText, shouldCapture } from '../src/host/capture.js';
import { createLocalLlm } from '../src/host/locallm.js';
import { buildPlanRequest, normalizePlanOps, planWarnings } from '../src/host/keeper-plan.js';
import { groupDeadlineMs } from '../src/host/keeper.js';
import { RecallEngine } from '../src/host/recall.js';
import { memoryPanelRoutes } from '../src/host/panel.js';
import { exportPack, importPack, resolveExportScope } from '../src/host/portability.js';
import { createLlmClient as createLlmClientFrom } from '../src/host/llm.js';

/** 插件标识：同时是 Loader 行 id、浏览器模块 id、`/plugins/<id>/client.js` 路由 id。 */
const PLUGIN_ID = 'dsh-memory';

/** 面板专用精确路由前缀。必须落在 `/api` 之下，`connection` 才会替我们做信任栅栏与鉴权。 */
const ROUTE_PREFIX = '/api/dsh-memory';

/** 开发期诊断路由前缀（不走 `/api`，无鉴权，仅监听回环）。 */
const DIAG_PREFIX = '/dsh-memory-selftest';

/** JSON 响应头（诊断路由用 raw node:http 写响应，没有 Response 包装）。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** 默认的密钥引用名（config.embedding.apiKeyRef 可覆盖）。 */
const DEFAULT_API_KEY_REF = 'DASHSCOPE_API_KEY';

/** 计分衰减的周期：一周（7 天）。 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 衰减时间戳在 `settings` 表里的键（ISO 串）。 */
const SCORE_DECAYED_AT_KEY = 'score.decayedAt';

/** Phase 1/3 会用到的宿主包。Phase 0 起逐个试解析，结果回给面板。 */
const PROBE_SPECIFIERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-skill',
];

/**
 * patch 配置那份嵌入配置的档案名（保留名，不能新建/删除同名档案）。
 *
 * 它永远是兜底：库里没有生效档案时用它，面板里也把它列成一个可切回去的选项。
 */
const PATCH_PROFILE_NAME = 'config';

/** 一个嵌入档案里真正属于 `embedding` 块的字段（`name` / 展示字段不算）。 */
const EMBEDDING_PROFILE_FIELDS = [
  'provider',
  'baseUrl',
  'model',
  'dimensions',
  'apiKeyRef',
  'batchSize',
  'timeoutMs',
  'ollamaUrl',
  'localDims',
];

/**
 * 从档案对象里摘出 `embedding` 块的字段（只取存在的，缺的让 patch 兜底）。
 *
 * @param {object} profile 档案
 * @returns {Record<string, unknown>} embedding 片段
 */
function profileToEmbedding(profile) {
  const out = {};
  for (const key of EMBEDDING_PROFILE_FIELDS) {
    if (profile?.[key] !== undefined) out[key] = profile[key];
  }
  return out;
}

/** 一个仓管档案里真正属于 `keeper` 块的字段（`name` 不算）。 */
const KEEPER_PROFILE_FIELDS = [
  'provider',
  'ollamaUrl',
  'baseUrl',
  'model',
  'apiKeyRef',
  'timeoutMs',
  'maxTokens',
  'temperature',
  'minChars',
  'digestMinChars',
  'splitChars',
  'dedupeThreshold',
  'sampleSize',
  'perGroup',
];

/**
 * 仓管的首批档案种子。
 *
 * 只在库里**从来没有写过** `keeper.profiles` 时播种一次（见 `listKeeperProfiles`）：
 * - 「线上」走 **OpenAI 兼容格式**，复用嵌入那套 DashScope 端点与密钥引用（用户 2026-10-06 选的）；
 * - 「局域网-ollama」留空，等用户自己填地址与模型 —— 留 `null` 会如实报「未配置」，
 *   而不是拿本机默认 11434 乱连。
 */
const KEEPER_SEED_PROFILES = [
  {
    name: '线上',
    provider: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKeyRef: 'DASHSCOPE_API_KEY',
  },
  { name: '局域网-ollama', provider: 'ollama', ollamaUrl: null, model: null },
];

/**
 * 从档案对象里摘出 `keeper` 块的字段（只取存在的，缺的让 patch 兜底）。
 *
 * @param {object} profile 档案
 * @returns {Record<string, unknown>} keeper 片段
 */
function profileToKeeper(profile) {
  const out = {};
  for (const key of KEEPER_PROFILE_FIELDS) {
    if (profile?.[key] !== undefined) out[key] = profile[key];
  }
  return out;
}

/**
 * 端点是不是「本地 / 局域网」。
 *
 * 判据只看主机名：`localhost` / `127.x` / `::1` / 私有网段（`10.x`、`172.16–31.x`、`192.168.x`）/
 * `.local`。**为什么不按档案名判**：名字是人随手起的（「局域网-ollama」可以填一个公网地址），
 * 而「接手」这件事的要点正是**别把整块记忆送到内网之外**，所以要按真实地址判。
 *
 * @param {unknown} endpoint 端点（`http(s)://…`）
 * @returns {boolean} 是否本地 / 局域网
 */
function isLocalEndpoint(endpoint) {
  const raw = String(endpoint ?? '').trim();
  if (raw === '') return false;
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/\.local$/.test(host)) return true;
  return false;
}

/**
 * 「接手模型」选择 → `resolveTakeoverClient()` 认识的形状。
 *
 * 用户 2026-10-07：「最终由什么模型接手由我启动时决定」。所以调用方给什么就是什么：
 * - 空 / `null` / `'auto'` → `undefined`（走自动顺序：本地优先 → 宿主）；
 * - `'host'` → `{kind:'host'}`；
 * - 其它字符串 = 仓管档案名 → `{kind:'profile', name}`。
 *
 * @param {unknown} model 调用方给的模型选择
 * @returns {{kind: 'profile'|'host', name?: string} | undefined | null} 选择（`null` = 这个值不合法）
 */
function parseTakerChoice(model) {
  if (model == null) return undefined;
  const text = String(model).trim();
  if (text === '' || text === 'auto') return undefined;
  if (text === 'host') return { kind: 'host' };
  if (text.length > 64) return null;
  return { kind: 'profile', name: text };
}

/** Cordis 插件名（fiber 诊断与日志名）。 */
export const name = PLUGIN_ID;

/** 「副仓管」给面板的成员预览：最多几条、每条留几个字。 */
const HANDOFF_PREVIEW_MEMBERS = 3;
const HANDOFF_PREVIEW_CHARS = 80;

/**
 * 「正在处理的记忆」给面板的每条预览字数。
 *
 * 比副仓管那边宽松（200 而不是 80）：这一块是**边跑边看**的，"这一条到底在说什么"要看得出来；
 * 一条组最多 `perGroup + 1` 条（默认 6），所以整包也就 1–2 KB，2 秒一次轮询完全扛得住。
 */
const KEEPER_CURRENT_PREVIEW_CHARS = 200;

/**
 * 截断文本（只在预览里用；真正文永远取 `memories` 里那一份，不复制、不改写）。
 *
 * @param {string} text 文本
 * @param {number} max 上限字数
 * @returns {string} 截断后的文本
 */
function clipText(text, max) {
  const source = String(text ?? '');
  const limit = Math.max(1, Number(max) || 1);
  return source.length <= limit ? source : `${source.slice(0, limit)}…`;
}

/**
 * 需要的宿主服务。
 *
 * `connection` 提供 `/api` 下的精确 Fetch 路由注册表——浏览器面板与我们通信的正路，
 * 由 `/api` 前缀处理器统一鉴权（Host/Origin 栅栏 + 会话 Cookie）。
 * **不要**改用 `ctx.webServer.register` 注册 `/api/**` 的 exact 路由：webserver 先查 exact 表，
 * 那样会绕过鉴权（见 DESIGN.md §B）。
 */
export const inject = ['connection'];

/**
 * 解析数据目录。默认落在 DSH home 下，可用 config.dataDir 覆盖。
 * @param {object} config - 插件配置。
 * @returns {string} 绝对路径。
 */
function resolveDataDir(config) {
  if (typeof config?.dataDir === 'string' && config.dataDir.length > 0) return config.dataDir;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, PLUGIN_ID);
}

/**
 * 造一个 JSON 响应。所有接口统一 `{ok:true,...}` / `{ok:false,error}` 信封。
 * @param {unknown} value - 可 JSON 化的值。
 * @param {number} [status] - HTTP 状态码。
 * @returns {Response} WHATWG 响应。
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * 把异常压成一行可读文本（页面上直接显示）。
 * @param {unknown} error - 捕获到的异常。
 * @returns {string} 文本。
 */
function describeError(error) {
  const name = error?.name ?? 'Error';
  const message = error?.message ?? String(error);
  const code = error?.code === undefined ? '' : ` [${error.code}]`;
  return `${name}${code}: ${message}`;
}

/**
 * 判断一个异常是不是「超时」。**这是仓管同组重试的唯一触发条件。**
 *
 * 判据与 `src/host/timeout.js` 的约定一致：`timeoutSignal()` abort 时给的 reason 是
 * `name === 'TimeoutError'` 的 `DOMException`（legacy `code === 23`），与 `AbortSignal.timeout()` 语义相同。
 * 只认这两个信号，HTTP 4xx/5xx、响应格式错这类**重试也白搭**的错误一律不重试。
 *
 * @param {unknown} error 捕获到的异常
 * @returns {boolean} 是否超时
 */
function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || Number(error?.code) === 23;
}

/**
 * 读一个 raw node:http 请求体（有上限，避免被本机进程打爆内存）。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} [limit] - 字节上限。
 * @returns {Promise<string>} UTF-8 文本。
 */
async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`请求体超过 ${limit} 字节`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 逐个试解析宿主包。一个失败不影响其余结论。
 * @returns {Promise<Record<string, {ok: boolean, error?: string, version?: string}>>} 逐项结果。
 */
async function probeImports() {
  /** @type {Record<string, {ok: boolean, error?: string, version?: string}>} */
  const result = {};
  for (const specifier of PROBE_SPECIFIERS) {
    try {
      const mod = await import(specifier);
      const version = typeof mod?.default?.version === 'string' ? mod.default.version : undefined;
      result[specifier] = { ok: true, ...(version === undefined ? {} : { version }) };
    } catch (error) {
      result[specifier] = { ok: false, error: describeError(error) };
    }
  }
  return result;
}

/**
 * 在内存库里跑一遍本插件依赖的 SQLite 能力（含 FTS5 与向量 BLOB 往返）。
 * @returns {Promise<object>} 探针结果。
 */
async function probeSqlite() {
  /** @type {any} */
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe(id TEXT PRIMARY KEY, text TEXT)');
    db.prepare('INSERT INTO probe VALUES (?, ?)').run('m1', '宝宝喜欢喝冰美式咖啡');
    const row = db.prepare('SELECT text FROM probe WHERE id = ?').get('m1');

    db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(text, tokenize='trigram')");
    db.prepare('INSERT INTO probe_fts(text) VALUES (?)').run(row.text);
    const hits = db.prepare('SELECT text FROM probe_fts WHERE probe_fts MATCH ?').all('冰美式');

    const vec = new Float32Array([1.5, -2.25, 3]);
    db.exec('CREATE TABLE probe_vec(id TEXT PRIMARY KEY, vec BLOB)');
    db.prepare('INSERT INTO probe_vec VALUES (?, ?)').run('v1', new Uint8Array(vec.buffer));
    const back = db.prepare('SELECT vec FROM probe_vec WHERE id = ?').get('v1').vec;
    const roundTrip =
      new Float32Array(back.buffer, back.byteOffset, back.byteLength / 4).length === vec.length;

    return { ok: true, fts5: hits.length === 1, trigramMatch: hits[0]?.text ?? null, blobRoundTrip: roundTrip };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* 探针库关闭失败无关紧要 */
    }
  }
}

/**
 * 工具注册探针：手搓一个规范定义，注册 → 读回 → 注销，验证 `ctx.tools.register` 可用。
 * （`defineTool` 来自 import 不到的 `@deepseek-ai/dsh-tools`，所以必须自己产出编译后的形状。）
 * @param {any} ctx - 插件上下文。
 * @returns {object} 探针结果。
 */
function probeToolRegistration(ctx) {
  const result = { attempted: true, registered: false, error: null, visible: null, schemaCount: null, readBack: null };
  try {
    const tools = ctx.get('tools');
    if (tools === undefined) {
      result.error = 'tools 服务未挂载';
      return result;
    }
    const dispose = tools.register({
      name: 'memory_selftest',
      description: 'Phase 0 探针（注册后立即注销，不应留在工具目录里）。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => ({ ok: true }),
    });
    result.registered = true;
    try {
      result.readBack = tools.get('memory_selftest') === undefined ? 'tools.get() → undefined' : 'tools.get() → present';
    } catch (error) {
      result.readBack = describeError(error);
    }
    try {
      const schemas = tools.schemas();
      result.schemaCount = Array.isArray(schemas) ? schemas.length : null;
      result.visible = Array.isArray(schemas) ? schemas.some((e) => e?.name === 'memory_selftest') : null;
    } catch (error) {
      result.error = `schemas() 失败：${describeError(error)}`;
    }
    dispose();
    return result;
  } catch (error) {
    result.error = describeError(error);
    return result;
  }
}

/**
 * 剥掉正文开头「重复的分节标题」。
 *
 * ## 背景
 * 原系统的存储 payload 是 `【来源】{section}\n\n{piece}`，而当来源是热区文件（按 `§` 切分）时，
 * `section` 取的是该段**首行前 40 字** —— 于是正文自然以同样的文字开头。
 * 导出时这一行又被打印了一次，全量统计有 533/1083 行中招。
 *
 * ## 保守策略
 * 只有「首行去空白、去 `- ` 前缀后，与分节互为前缀」时才剥离，且：
 * - 分节与首行都至少 10 字（避免误伤短内容）；
 * - 至多循环 4 次（实测有正文带两份以上重复分节），每次都用同一判定；
 * - 剥完必须还剩内容，否则整体放弃（返回 `null`，一个字都不改）。
 * 剥离会经 `updateMemoryText` 写 `history`（含 `prev_text`），因此可追溯、可回滚。
 *
 * @param {string} text 正文
 * @param {string|null} section 分节
 * @returns {string|null} 清洗后的正文；无需清洗时返回 `null`
 */
function stripDuplicatedSection(text, section) {
  const norm = (value) => String(value ?? '').replace(/^\s*[-*]\s*/, '').trim();
  const normSection = norm(section);
  if (normSection.length < 10) return null;

  const lines = String(text ?? '').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();

  let stripped = 0;
  while (stripped < 4 && lines.length > 1) {
    const first = norm(lines[0]);
    if (first.length < 10) break;
    const isDuplicate =
      first === normSection || first.startsWith(normSection) || normSection.startsWith(first);
    if (!isDuplicate) break;
    lines.shift();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    stripped += 1;
  }
  if (stripped === 0) return null;

  const next = lines.join('\n').trim();
  if (next.length === 0) return null;
  return next;
}

/** 宽松的对象式输出 schema：工具返回结构化 JSON，由 render 转成文本块。 */
const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

/**
 * `replace`（删旧录新）落库时**不**从原记忆继承的 meta 键。
 *
 * 继承原 meta 是为了不丢「这条从哪来」的出处（例如宫殿导入的 `sync` / `srcHash` / `importedFrom`），
 * 但这几个键必须**剔掉**：
 * - `derivedFrom` / `keeper` / `merged` 是**仓管回滚凭据**（`listKeeperArtifacts()` 按它们分桶）。
 *   继承过来的后果是：新记忆会被当成「研磨产物 / 被改写过的原文 / 合并保留条」再回滚一次；
 * - `replaces` / `replacedAt` / `model` 是本次 `replace` 自己写的，不能从原条抄。
 */
const REPLACE_META_DROP = new Set(['derivedFrom', 'keeper', 'merged', 'replaces', 'replacedAt', 'model']);

/** 造一个已编译的严格对象参数 schema（`defineTool` 用不了，只能手搓这个形状）。 */
const params = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

/**
 * 校验 `memory_keeper` 的 `edits`（审阅变更单时就地改正文的唯一入口）。
 *
 * 口径**与服务层 `reviewKeeperPlan()` 一致**（键是 op 的 `idx` 字符串）：
 * - `split` 的值必须是**非空字符串数组**（逐块正文：第 1 块覆盖原文、其余作为派生条入库）；
 * - `replace` / `merge` 的值必须是**非空字符串**（「删旧录新」的新正文 / 合并后的正文；
 *   旧单里的 `rewrite` 也按 `replace` 收字符串）；
 * - `drop` 没有正文，给了也**忽略**（不当错误）。
 *
 * 不合法的值**直接报原文**，绝不静默丢弃 —— 静默丢的后果是「人以为自己改的字已经落库」，
 * 而 `reviewKeeperPlan()` 对空串 / 空数组是静默 `skipped` 的，那种沉默比报错危险得多。
 *
 * @param {object[]} ops 变更单里的操作数组（来自 `service.getKeeperPlan(id).plan`）
 * @param {unknown} edits 工具入参
 * @param {{reject?: boolean}} [options] `reject:true` 时整单驳回、不落库，`edits` 不该再给
 * @returns {{ok: true, edits: Record<string, string|string[]>} | {ok: false, error: string}} 结论
 */
function validateKeeperEdits(ops, edits, { reject = false } = {}) {
  const entries = edits != null && typeof edits === 'object' && !Array.isArray(edits) ? Object.entries(edits) : null;
  if (edits != null && entries === null) {
    return {
      ok: false,
      error: `edits 必须是对象：键是 op 的 idx 字符串（如 {"0":"改后的正文"}、{"1":["第一块","第二块"]}），收到 ${JSON.stringify(edits)}`,
    };
  }
  if (entries == null || entries.length === 0) return { ok: true, edits: {} };
  if (reject === true) {
    return { ok: false, error: 'reject:true 是整单驳回、不会落库，这时候不该再给 edits（要么改字、要么驳回，别同时给）' };
  }

  const list = Array.isArray(ops) ? ops : [];
  /** @type {Record<string, string|string[]>} */
  const out = {};
  for (const [key, value] of entries) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      return {
        ok: false,
        error: `edits 的键 ${JSON.stringify(key)} 不是这张单里的 op 下标（有效下标 0–${Math.max(0, list.length - 1)}，共 ${list.length} 条 op）`,
      };
    }
    const type = String(list[index]?.type ?? '');
    if (type === 'drop') continue; // drop 没有正文：给了也忽略，不算错

    if (type === 'split') {
      if (!Array.isArray(value)) {
        return {
          ok: false,
          error: `edits["${index}"] 对应的 op 是 split，值必须是字符串数组（如 ["第一块","第二块"]），收到 ${JSON.stringify(value)}`,
        };
      }
      if (value.length === 0) {
        return { ok: false, error: `edits["${index}"] 是 split，但数组是空的：拆细至少要给一块正文` };
      }
      const pieces = [];
      for (const piece of value) {
        if (typeof piece !== 'string') {
          return {
            ok: false,
            error: `edits["${index}"] 是 split，数组里每一块都必须是字符串，收到 ${JSON.stringify(piece)}`,
          };
        }
        if (piece.trim() === '') {
          return { ok: false, error: `edits["${index}"] 是 split，但有一块是空串（空块没有意义，请删掉或补上正文）` };
        }
        pieces.push(piece);
      }
      out[String(index)] = pieces;
      continue;
    }

    // replace / merge：字符串正文
    if (typeof value !== 'string') {
      return {
        ok: false,
        error: `edits["${index}"] 对应的 op 是 ${type}，值必须是字符串（改后的正文），收到 ${JSON.stringify(value)}`,
      };
    }
    if (value.trim() === '') {
      return { ok: false, error: `edits["${index}"] 是空串：要么给出改后的正文，要么别传这一条（空串会被静默跳过）` };
    }
    out[String(index)] = value;
  }
  return { ok: true, edits: out };
}

/**
 * 注册记忆工具。
 *
 * `defineTool` 来自 import 不到的 `@deepseek-ai/dsh-tools`，所以这里直接产出
 * `ctx.tools.register` 需要的**已编译**形状（Phase 0 已实测可被接受并投影成模型可见 schema）。
 *
 * 工具在宿主层注册（不用 agent 作用域），preset 里的 agent 会继承全局层。
 *
 * @param {any} ctx - 插件上下文
 * @param {MemoryService} service - 记忆服务
 * @returns {(() => void)[]} 注销器
 */
function registerMemoryTools(ctx, service) {
  const tools = ctx.get('tools');
  if (tools === undefined) return [];
  const definitions = [
    {
      name: 'memory_search',
      description:
        '检索本地记忆库（关键词 + 语义，RRF 融合）。用户提到「你还记得吗」「上次」「之前说过」或需要了解其人偏好/经历/项目时先用它。返回按相关度排序的条目，score 只是线索，关键那条未必排第一——可以换个说法再查。' +
        '（行为计分：命中的每一条读取指数 +1；列表 / 面板浏览不算，仓管内部的召回也不算。）',
      parameters: params(
        {
          query: { type: 'string', description: '查询词。中文建议 ≥3 字以走 FTS5 关键词路；短词也能用（走 LIKE 兜底）' },
          limit: { type: 'integer', description: '返回条数，默认 8' },
        },
        ['query'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const result = await service.searchText({ query: args.query, limit: args.limit ?? 8 });
        // 计分：命中的每条 +1 read（**只在这条工具路径**；`searchText` 本身不动分，
        // 否则仓管的分组召回 / 冲突分析也会被算成「被正常读取」）。
        service.recordReads((Array.isArray(result?.items) ? result.items : []).map((hit) => hit.id));
        return result;
      },
    },
    {
      name: 'memory_remember',
      description:
        '把一段原文写入本地记忆库（原文即真相，不经过 LLM、秒级完成）。用于用户明确要求记住的长期有效事实：偏好、约定、身份、决定、经历。不要记临时状态、公开信息或你自己的猜测。',
      parameters: params(
        {
          text: { type: 'string', description: '要记住的原文' },
          source: { type: 'string', description: '来源标注，可选' },
          kind: { type: 'string', description: '分类标签，如 manual / note，可选' },
        },
        ['text'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const store = service.ensureStore();
        const text = String(args.text ?? '').trim();
        if (text === '') throw new Error('内容为空');
        const result = store.addMemory({
          text,
          scope: service.resolvedConfig().scope,
          source: args.source ?? '手动写入',
          kind: args.kind ?? 'manual',
          meta: { writtenAt: new Date().toISOString() },
        });
        // 写入后立刻排队补向量：没有向量就只能靠关键词被检索到，等于「写进去搜不到」。
        service.scheduleEmbed(result.id);
        // 顺手进「热列表」：下一步就把这条注入进去 —— 刚记下的事当场被引用，最像人。
        service.ensureRecall()?.noteHot(result.id, text);
        return { ok: true, id: result.id, created: result.created, embedding: '已排队自动补向量' };
      },
    },
    {
      name: 'memory_list',
      description: '按时间倒序列出记忆库里的条目（翻旧账用；不做语义检索）。',
      parameters: params(
        {
          limit: { type: 'integer', description: '返回条数，默认 20' },
          offset: { type: 'integer', description: '偏移，默认 0' },
        },
        [],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const store = service.ensureStore();
        const limit = Math.min(Math.max(1, args.limit ?? 20), 200);
        const offset = Math.max(0, args.offset ?? 0);
        const page = store.listMemories({ limit, offset });
        return {
          ok: true,
          total: page.total,
          offset,
          count: page.items.length,
          items: page.items.map((row) => ({
            id: row.id,
            text: row.text,
            source: row.source,
            kind: row.kind,
            createdAt: row.created_at,
          })),
        };
      },
    },
    {
      name: 'memory_get',
      description: '取一条记忆的完整原文（检索结果不截断，但列出时会）。（行为计分：取单条读取指数 +1。）',
      parameters: params({ id: { type: 'string', description: '记忆 id' } }, ['id']),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const store = service.ensureStore();
        const id = String(args.id);
        if (store.getMemory(id) === null) throw new Error(`没有这条记忆：${args.id}`);
        // 计分：取单条算一次「被正常读取」，随后重读一次让返回值里的 readScore 是加过 1 的。
        service.recordReads([id]);
        const row = store.getMemory(id);
        return {
          ok: true,
          id: row.id,
          text: row.text,
          source: row.source,
          section: row.section,
          kind: row.kind,
          scope: row.scope,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revision: row.revision,
          readScore: row.readScore,
          tidyScore: row.tidyScore,
        };
      },
    },
    {
      name: 'memory_forget',
      description:
        '删除一条记忆。默认**软删**（保留行与历史，只从检索与列表里隐藏，删错可恢复）；`hard: true` 则**真删行**（不可恢复，但 `history` 里仍留有 prev_text 可人工找回）。软删的正文仍占用库空间。',
      parameters: params(
        {
          id: { type: 'string', description: '记忆 id' },
          hard: { type: 'boolean', description: 'true = 真删行（不可恢复）；省略/false = 软删（可恢复）' },
        },
        ['id'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const store = service.ensureStore();
        const id = String(args.id);
        if (args.hard === true) {
          const done = store.hardDeleteMemory(id, { note: 'memory_forget:hard' });
          if (!done) throw new Error(`没有这条记忆或已删除：${id}`);
          return { ok: true, id, hardDeleted: true, restorable: false };
        }
        const done = store.softDeleteMemory(id, { note: 'memory_forget' });
        if (!done) throw new Error(`没有这条记忆或已删除：${id}`);
        store.deleteVector(id);
        return { ok: true, id, softDeleted: true, restorable: true };
      },
    },
    {
      name: 'memory_stats',
      description:
        '记忆库统计：条数（含按 scope 分布）、向量总数、**已保留的向量空间**（每个空间多少条）、**当前空间还缺多少**、待审数、回填进度、能力自描述。' +
        '`scores` 是两个行为计数器的聚合（读取 / 整理的总分与均值、Top-N、每周衰减参数与下次衰减时间）。' +
        '排查「为什么搜不到」的第一步。`probe: true` 时额外真打一次最小生成请求，预检宿主 LLM 是否可用（默认不探，省一次调用）。',
      parameters: params(
        { probe: { type: 'boolean', description: 'true = 顺带预检 LLM（真调一次，默认 false）' } },
        [],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const stats = service.storeStats();
        // `recall`：读取侧注入现在到底往提示词里放了什么（索引 / 召回的 id、字节数、话题段版本、错误）。
        // 「自然不自然」要可核对 —— 这一格就是核对口。
        const recall = service.recallStatus();
        if (args.probe !== true) return { ...stats, recall, backfill: service.publicBackfill() };
        const llm = await service.llmProbe({});
        return { ...stats, recall, llm, backfill: service.publicBackfill() };
      },
    },
    {
      name: 'memory_embedding',
      description:
        '查看 / 测试 / 切换嵌入配置档案（线上、局域网、本地模型都能配）。action=list 列出每个档案、它对应的向量空间、已保留多少条、还缺多少；action=test 用指定档案真打一次嵌入请求并核对维度（配错 url/key/模型 id 时立刻能看出来）；action=activate 切换生效档案——**不删任何向量**，切回旧档案只补「离开期间新增的」，autoFill=true 时顺手启动补齐。新建 / 修改档案、写密钥请在面板「设置 → 嵌入配置」里做。',
      parameters: params(
        {
          action: { type: 'string', description: 'list / test / activate' },
          name: { type: 'string', description: '档案名（test / activate 用；`config` = 补丁配置那份）' },
          autoFill: { type: 'boolean', description: 'activate 时顺手启动增量补齐（默认 false）' },
        },
        ['action'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const action = String(args.action ?? '').trim();
        if (action === 'list') return service.listEmbeddingProfiles();
        const name = args.name == null ? '' : String(args.name);
        if (action === 'test') return service.testEmbedding({ name: name === '' ? null : name });
        if (action === 'activate') {
          const result = service.activateEmbeddingProfile(name === '' ? PATCH_PROFILE_NAME : name);
          if (result.ok !== true) return result;
          if (args.autoFill === true && Number(result.missing) > 0) {
            const started = await service.startBackfill({});
            return { ...result, backfill: started?.backfill ?? service.publicBackfill() };
          }
          return { ...result, backfill: service.publicBackfill() };
        }
        return { ok: false, error: `action 只能是 list / test / activate（收到 ${JSON.stringify(args.action)}）` };
      },
    },
    {
      name: 'memory_keeper',
      description:
        '仓管：用插件**自带的本地/局域网 LLM**（配置 `keeper.*`，与宿主模型无关）对已录入的记忆做全库二次加工。' +
        '⚠️ **范式（2026-10-07 起）：仓管只出「变更单」，不改库** —— run 一轮只往 `keeper_plans` 表里写单，' +
        '记忆正文一个字符都不动；要生效必须用 action=review 由人（或你）逐单勾选。' +
        '**统一修改语义（用户 2026-10-07 拍板）：修改记忆 = 依照原记忆编写修改后的记忆 → 新旧记忆进待审区 → 过审后删除原记忆、录入新记忆**；' +
        '所以修改类 op 只有 `replace` 一个类型（旧 `rewrite` 一律按它处理）—— 落库时新记忆是**新 id**、原记忆走**软删**（行仍在、可恢复）、原条向量清掉。' +
        'action=status 看配置/指向/进度/痕迹/待审单数；action=profiles 列出全部仓管档案（内置只读档案 `config` 排第一）；' +
        'action=save 新建/覆盖一个档案（空串/null = 删掉该键、回落 patch）；action=delete 删档案；' +
        'action=activate 切换生效档案（**立刻生效、不用重启**）；action=test 真打一次请求验连通性（`name` 可选：只测那个档案、**不改 active**）；' +
        'action=run 跑一轮出单（随机抽 sample 个种子 → 每个种子用 embedding 语义召回 perGroup 个邻居组成一组 → 每组一次调用产出一张变更单；maxGroups 可限组数）；' +
        '**某一组出错**（超时重试一次仍失败 / 非超时错误 / 答了但解析不出操作）时：**跳过这一组**，把它挂进**副审阅区**，' +
        '并让**接手模型**（优先本地/局域网仓管档案，其次宿主模型；标签写进 tail 与那一行）接着整理那一组 —— ' +
        '接手成功同样只产出一张变更单（`takenOver` 记数），接手也失败才算这一组 `failed`、留在队列里等人处理；' +
        '**删除（drop）必须带理由**（用户 2026-10-07 拍板）：`reason` 空白的删除照旧出在这张单上（人要看得到模型想删什么）、' +
        '但带上 `reasonMissing:true` 与一条警告，且 **`action=review` 一律跳过它**（返回里的 `noReason` 是跳过条数）—— ' +
        '所以没理由的删除**永远不会生效**；同时**仓管（run / grind / digest / takeover）在代码里没有任何删除能力**，' +
        '删除只可能由 `action=review` 在**人审通过**之后执行（`drop` → 软删、可恢复），落库时理由随 history 留痕；' +
        'action=propose **手工提出一条记忆的修改**（`id` + `text` = 修改后的新正文，`reason` 可选）：校验 `id` 存在且未删、`text` 非空且与原文不同，' +
        '建一张单 op 的 `replace` 变更单（`state:open`，**不落库**），返回 `{ok, planId}`；修改**只有**这一条路（不许直接 updateMemoryText）—— 待审区看新旧对比、过审才生效；' +
        'action=propose-drop **手工提出删除一条记忆**（`id`，`reason` 可选）：校验 `id` 存在且未删 → 建一张单 op 的 `drop` 变更单（`state:open`，**不落库**），返回 `{ok, planId}`；' +
        '删除也只有这一条路（不许直删）—— 过审后该条**软删**（可恢复），`action=revert` 能把它放回来；' +
        'action=plans 列出变更单（`state` 可选 open/approved/rejected/partial）；action=plan 看单张单的全文（`id`）；' +
        'action=handoffs 列出**副仓管**（原「待接手记忆」/「副审阅区」：仓管某一组出错、又没被接手模型救回来的组），' +
        'action=takeover 开跑（`id` = 副仓管项 id，`model` = 仓管档案名 / \'host\' / 省略=用副仓管角色设定）：拿它的成员当种子、用 embedding 召回相关记忆 → 组 → 出单（只出单、不改正文）；' +
        'action=drop-handoff 把它从队列里清掉（软状态、不删行）；' +
        'action=side **设定副仓管这个独立角色的模型**（`model` = 仓管档案名 / \'host\' / \'auto\'=删掉设定回落自动）：' +
        '副仓管与主仓管**各用各的档案**（存 `settings.keeper.side`，不动 `keeper.active`）——' +
        '改完之后 `takeover` / `run` 省略 `model`（`taker`）时都走它；' +
        'action=handoff **把一张待审变更单转手给副仓管**（`id` = 变更单 id，`reason` 可选）：原单停在终态 `handed`（不算通过也不算驳回）+ 它的记忆挂进队列 —— **只入队、不自动开跑**（模型由人在副仓管页点「接手」时决定）；' +
        'action=review 审阅落库（`id` 必填；`keep` 是只勾选的 op 下标数组，省略 = 全部；' +
        '`edits` 可就地手改正文（**split 给字符串数组、replace / merge 给字符串**，drop 忽略；不传 = 用仓管给的 after；类型不合直接报错、绝不静默丢）；' +
        '`reject:true` = 整单驳回、不碰记忆库）；' +
        '⚠️ **删除必须先说服人**：`drop` op 的 `reason` 为空时，review **无论如何都不会应用它**（勾了也跳过，返回里的 `noReason` 是跳过条数）—— 这是"仓管不碰删除"的落点；' +
        'action=run / grind 都按「全部手段」出单；action=digest 同样**只出单、不改库**，只是提示词**偏重去重合并**' +
        '（优先找「同一件事被拆成多条」并给 merge，不为了拆而拆）—— `digest` 不是另一种任务，差别只在提示词侧重。' +
        'action=revert 用于回滚：删研磨产物、按 history 恢复历史遗留的直改痕迹、放回被合并软删的条，以及**把 `replace` 的新记忆真删、原记忆放回来**。' +
        '单条 op 的 `warnings` 是机器给的**证据**（**丢了 N 个数字** / **消失的片段**（引号原话、emoji 标签优先列出）/ **压缩到 X%**（压得极狠时附「留意是否过度缩写」）/ **这块可能缺主语**（脱离上下文会被读成全局）/ **新增了原文没有的片段**（可能是模型自己加的）/ split 走了兜底切分），' +
        '**不是「违规」判定**：缩写、去冗余、优化语序、同义换词都是允许的，不影响是否可批准，请据此自己判断。' +
        '⚠️ review 落库时**不会重跑**校验：`edits` 手改的正文由你负责（split 手改的块是否自足、replace / merge 有没有丢事实要点，系统不再核对）。',
      parameters: params(
        {
          action: {
            type: 'string',
            description: 'status / profiles / save / delete / activate / side / test / run / plans / plan / review / propose / propose-drop / handoffs / takeover / handoff / drop-handoff / grind / digest / revert',
          },
          name: { type: 'string', description: '档案名（save / delete / activate / test 用；`config` = 补丁配置那份）' },
          provider: { type: 'string', description: 'save 用：ollama / openai' },
          ollamaUrl: { type: 'string', description: 'save 用：provider=ollama 时的地址，如 http://<局域网 IP>:11434' },
          baseUrl: { type: 'string', description: 'save 用：provider=openai 时的 OpenAI 兼容端点，如 https://dashscope.aliyuncs.com/compatible-mode/v1' },
          model: {
            type: 'string',
            description:
              "save 用：模型 id，如 qwen-plus / qwen3:8b；" +
              "takeover / side 用：接手模型 —— 仓管档案名 / 'host'（宿主模型）/ 'auto'（省略 = 副仓管角色；" +
              "副仓管角色也没设 = 自动：本地优先 → 宿主）。档案没配好会如实报错，不会偷偷换人",
          },
          apiKeyRef: { type: 'string', description: 'save 用：密钥引用名（只存引用，密钥进凭据库）' },
          timeoutMs: { type: 'integer', description: 'save 用：单次请求超时（毫秒）' },
          maxTokens: { type: 'integer', description: 'save 用：单次生成上限' },
          temperature: { type: 'number', description: 'save 用：采样温度（≥0）' },
          minChars: { type: 'integer', description: '「大段」阈值（决定哪些记忆在出单时被建议 split）；save 时也可是档案字段' },
          splitChars: { type: 'integer', description: 'split 的单块目标上限；save 时也可是档案字段（默认取 `keeper.splitChars`）' },
          sample: { type: 'integer', description: 'run：随机抽多少个种子（默认取 `keeper.sampleSize`，20）' },
          perGroup: { type: 'integer', description: 'run：每个种子语义召回多少个邻居（默认取 `keeper.perGroup`，5）' },
          maxGroups: { type: 'integer', description: 'run：本次最多处理多少组（省略/0 = 不限）' },
          taker: { type: 'string', description: "run：这一轮的**接手模型**（某一组失败时用它接手）——仓管档案名 / 'host'（宿主模型）/ 'auto'（省略 = 用副仓管角色那一条设定；副仓管也没设 = 自动：本地优先 → 宿主）；接手模型**由启动者决定**，不自动挑" },
          id: { type: 'string', description: 'plan / review / propose / takeover / drop-handoff / handoff 用：变更单 id（plan / review / handoff）、要修改 / 删除的记忆 id（propose / propose-drop）或副审阅区项 id（takeover / drop-handoff）' },
          text: { type: 'string', description: 'propose 用：**修改后的新正文**（过审后会作为新记忆录入，原记忆被软删）；必须非空且与原文不同' },
          reason: { type: 'string', description: 'propose / propose-drop 用：一句话理由（可选；留空则记「手工提出的修改」/「手工提出的删除」）' },
          keep: { type: 'array', items: { type: 'integer' }, description: 'review 用：只应用这些 0-based 下标（省略 = 全部）' },
          edits: {
            type: 'object',
            additionalProperties: true,
            description:
              'review 用：审阅时就地手改正文（键是 op 的 idx 字符串，如 "0"）。**split 的值是字符串数组**（逐块正文：第 1 块覆盖原文、其余作为派生条入库）；' +
              '**replace / merge 的值是字符串**（replace = 删旧录新后的新正文，merge = 合并后的正文；旧单里的 rewrite 也按 replace 收字符串）；' +
              'drop 没有正文、给了也忽略。不传 = 用仓管给的 after（`action=plan` 能看到每条 op 的 after 原文）。' +
              '类型不合（比如给 split 传了字符串、给 replace 传了数组、空串、下标越界）会直接报错，不会静默落库。',
          },
          state: { type: 'string', description: 'plans 用：只看某个状态（open / approved / rejected / partial）' },
          reject: { type: 'boolean', description: 'review 用：true = 整单驳回，**不碰记忆库**' },
        },
        ['action'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => {
        const action = String(args.action ?? '').trim();
        if (action === 'profiles') return service.listKeeperProfiles();
        // 档案字段就是工具参数本身（`saveKeeperProfile` 只认白名单键，action/sample 会被忽略）。
        if (action === 'save') return service.saveKeeperProfile(args);
        if (action === 'delete') return service.deleteKeeperProfile(args.name);
        if (action === 'activate') return service.activateKeeperProfile(args.name);
        // 副仓管这个**独立角色**的模型（用户 2026-10-07：「副审阅区使用独立的仓管角色」）：
        // 只改一行 setting；`model` 省略 = 回落自动顺序。
        if (action === 'side') {
          return service.setSideKeeper(args.model == null ? null : String(args.model));
        }
        if (action === 'status') return { ok: true, ...service.keeperStatus() };
        if (action === 'test') {
          return service.keeperTest(args.name == null || String(args.name).trim() === '' ? {} : { name: String(args.name).trim() });
        }
        if (action === 'revert') return service.revertKeeper();
        // `run` / `grind` / `digest` 都只出变更单、不改库；`digest` 仅让提示词偏重去重合并（mode 只是侧重）。
        if (action === 'run' || action === 'grind' || action === 'digest') {
          return service.startKeeperRun({
            mode: action === 'digest' ? 'digest' : 'grind',
            sample: Number.isFinite(Number(args.sample)) ? Number(args.sample) : null,
            perGroup: Number.isFinite(Number(args.perGroup)) ? Number(args.perGroup) : null,
            maxGroups: Number.isFinite(Number(args.maxGroups)) ? Number(args.maxGroups) : 0,
            // 这一轮的接手模型（哪一组失败时用它接手）；省略 = 用副仓管角色那一条设定。
            taker: args.taker == null ? null : String(args.taker),
          });
        }
        if (action === 'plans') {
          return service.listKeeperPlans({ state: args.state == null || String(args.state).trim() === '' ? null : String(args.state).trim() });
        }
        if (action === 'plan') return service.getKeeperPlan(String(args.id ?? ''));
        // 副仓管：某一组整理失败后的交接队列（只出单、不改正文）。
        if (action === 'handoffs') {
          return service.listHandoffs({
            state: args.state == null || String(args.state).trim() === '' ? 'open' : String(args.state).trim(),
          });
        }
        // 副仓管是这个插件的**独立角色**：`model` 省略就用它那条设定（`action=side` 写的）。
        if (action === 'takeover') {
          return service.takeOverHandoff({ id: String(args.id ?? ''), model: args.model == null ? null : String(args.model) });
        }
        if (action === 'drop-handoff') return service.dropHandoff({ id: String(args.id ?? '') });
        // 转手：把一张**待审变更单**交给副仓管（**只入队**，真正开跑是 takeOver + 选模型那一步）。
        if (action === 'handoff') {
          return service.handOffPlan({ id: String(args.id ?? ''), reason: args.reason == null ? null : String(args.reason) });
        }
        // 手工提出修改：建一张单 op 的 `replace` 单（**只出单、不落库**），过审仍走 review。
        if (action === 'propose') {
          return service.proposeKeeperReplace({
            id: String(args.id ?? ''),
            text: args.text == null ? '' : String(args.text),
            reason: args.reason == null ? null : String(args.reason),
          });
        }
        // 手工提出删除：建一张单 op 的 `drop` 单（**只出单、不落库**），过审仍走 review。
        if (action === 'propose-drop') {
          return service.proposeKeeperDrop({
            id: String(args.id ?? ''),
            reason: args.reason == null ? null : String(args.reason),
          });
        }
        if (action === 'review') {
          const id = String(args.id ?? '');
          // `edits` 的类型口径依赖「这条 idx 是哪种 op」（split 收数组、replace/merge 收字符串），
          // 所以要先看这张单；不合法就**报原文返回，坚决不落库**。
          let edits = {};
          if (args.edits != null) {
            const envelope = service.getKeeperPlan(id);
            if (envelope.ok !== true) return envelope;
            const checked = validateKeeperEdits(envelope.plan?.ops, args.edits, { reject: args.reject === true });
            if (checked.ok !== true) return { ok: false, error: checked.error };
            edits = checked.edits;
          }
          return service.reviewKeeperPlan({
            id,
            keep: Array.isArray(args.keep) ? args.keep : null,
            edits,
            reject: args.reject === true,
          });
        }
        return {
          ok: false,
          error: `action 只能是 status / profiles / save / delete / activate / test / run / plans / plan / review / propose / propose-drop / grind / digest / revert（收到 ${JSON.stringify(args.action)}）`,
        };
      },
    },
    {
      name: 'memory_backup',
      description:
        '一键备份：把库本体（SQLite 在线一致性快照 `VACUUM INTO`）+ 可读文本包各写一份到 `<dataDir>/备份/backup-<时间戳>/`，并只保留最近几份。换机器 / 防误删 / 改坏了想回退时用；返回路径与体积。',
      parameters: params(
        {
          dir: { type: 'string', description: '备份根目录；省略 = `<dataDir>/备份`' },
          keep: { type: 'integer', description: '只保留最近几份（默认 5）' },
          withPack: { type: 'boolean', description: '是否同时导一份文本包（默认 true）' },
        },
        [],
      ),
      output: JSON_OUTPUT,
      execute: async (args) =>
        service.backupNow({
          dir: args.dir ?? null,
          keep: Number.isFinite(Number(args.keep)) && Number(args.keep) > 0 ? Math.trunc(Number(args.keep)) : 5,
          withPack: args.withPack !== false,
        }),
    },
    {
      name: 'memory_export',
      description:
        '把记忆库导出成一个可迁移的包（manifest.json + memories.jsonl + readable.md + RESTORE.md）。换机器、备份、给人看都用它。默认只导配置里的那个 scope；要连别的 scope 一起导，加 allScopes: true。',
      parameters: params(
        {
          dir: { type: 'string', description: '导出目录；省略则写到数据目录下的 导出包/memory-export-<时间戳>' },
          scope: { type: 'string', description: '只导这个 scope；省略=按配置的默认 scope' },
          allScopes: { type: 'boolean', description: 'true = 导出全部 scope（优先级高于 scope）' },
        },
        [],
      ),
      output: JSON_OUTPUT,
      execute: async (args) =>
        service.exportMemory({
          dir: args.dir ?? null,
          // schema 里 `scope` 是 string，但「没给」有可能被投影成 null；两者都算省略，
          // 落回 config.scope。要全部 scope 请用 allScopes（显式、不会被误判）。
          scope: args.scope == null ? undefined : args.scope,
          allScopes: args.allScopes === true,
        }),
    },
    {
      name: 'memory_import',
      description:
        '从导出包导入记忆。**按全文判重、可反复跑**；dryRun=true 时只演练不写入。导入的向量会用当前嵌入模型重算（不沿用旧向量）。',
      parameters: params(
        {
          dir: { type: 'string', description: '导出包目录（含 memories.jsonl）' },
          dryRun: { type: 'boolean', description: '只演练，不写入' },
        },
        ['dir'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => service.importMemory({ dir: args.dir, dryRun: args.dryRun === true }),
    },
    {
      name: 'memory_extract',
      description:
        '抽取式写入：把长文交给模型抽成一条条事实，**先落待审区、不进记忆库**，等人审批后才入库。内容长、想让系统自己提炼时用它；日常记住一件事请用 memory_remember（原文直存、秒级）。' +
        '抽出来的事实还会过一道**确定性三分类**（默认开）：纯**会话 / 工具 / 进度态**（本次会话的安排、teammate/subagent、助手自述、「目前·正在·刚刚」、`约好用…流程`）被判 transient **丢掉**（`droppedTransient` 是条数）；**拿不准**的判 uncertain，**不丢**、照常进待审区（`deferredToReview` 是条数）；命中 `决定/采纳/拍板/统一/约定/偏好/习惯/要求/基准/长期/日期` 这类长期信号的判 durable，**即使同时出现技术词也保留**。要关掉它（只靠提示词）传 `excludeTransient: false`。',
      parameters: params(
        {
          text: { type: 'string', description: '要抽取的原文' },
          focused: { type: 'boolean', description: '只抽「与人的关系/偏好/经历/拍板决策」，排除技术细节' },
          excludeTransient: {
            type: 'boolean',
            description:
              'true（默认）= 过确定性三分类：会话/工具/进度态（transient）不落待审区，拿不准的（uncertain）照常进待审区；false = 只靠提示词、三分类全部保留',
          },
        },
        ['text'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) =>
        service.extractMemory({
          text: args.text,
          focused: args.focused === true,
          excludeTransient: args.excludeTransient !== false,
        }),
    },
    {
      name: 'memory_pending',
      description: '列出待审批次（抽取式写入产生的缓冲区）。要看某批的具体条目，用 memory_analyze。',
      parameters: params({}, []),
      output: JSON_OUTPUT,
      execute: async () => service.pendingBatches(),
    },
    {
      name: 'memory_analyze',
      description:
        '对一个待审批次逐条查冲突：看每条新事实与库里已有记忆是 supersede（该改写旧的）/ duplicate（重复）/ coexist（都对）/ unrelated（无关）。批准前先跑它，避免新旧状态并存互相干扰。',
      parameters: params(
        {
          batchId: { type: 'string', description: '批次 id，来自 memory_extract 或 memory_pending' },
          topK: { type: 'integer', description: '每条对比多少条相似旧记忆，默认 3' },
        },
        ['batchId'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) => service.analyzeBatch({ batchId: args.batchId, topK: args.topK ?? 3 }),
    },
    {
      name: 'memory_review',
      description:
        '审批一个待审批次。默认整批批准；用 keep 指定只批哪几条（0-based 下标）。**只有显式给出 actions[i].supersede 才会改写旧记忆**（其余一律不动）；actions[i].duplicate=true 表示重复、跳过不存。reject=true 只关批次，不删数据、不改记忆。',
      parameters: params(
        {
          batchId: { type: 'string', description: '批次 id' },
          keep: { type: 'array', items: { type: 'integer' }, description: '只批准这些 0-based 下标；省略=全部' },
          edits: { type: 'object', additionalProperties: true, description: '{"下标":"改后的文本"}' },
          actions: { type: 'object', additionalProperties: true, description: '{"下标":{"supersede":["旧id"],"duplicate":true}}' },
          reject: { type: 'boolean', description: '驳回整批（只关批次）' },
        },
        ['batchId'],
      ),
      output: JSON_OUTPUT,
      execute: async (args) =>
        service.reviewPending({
          batchId: args.batchId,
          keep: Array.isArray(args.keep) ? args.keep : null,
          edits: args.edits ?? {},
          actions: args.actions ?? {},
          reject: args.reject === true,
        }),
    },
  ];

  const disposers = [];
  for (const definition of definitions) {
    try {
      disposers.push(tools.register(definition));
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_ID}: 注册工具 ${definition.name} 失败：${describeError(error)}`);
    }
  }
  return disposers;
}

/**
 * 记忆服务。
 *
 * 不继承 Cordis `Service`：那需要 `import { Service } from '@deepseek-ai/cordis'`，
 * 而该裸说明符解析不了。改用 `ctx.reflect.provide`，已实测等效。
 */
class MemoryService {
  /**
   * @param {any} ctx - 插件上下文。
   * @param {object} config - 插件配置。
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.dataDir = resolveDataDir(config);
    /** @type {import('../src/host/store.js').MemoryStore | null} */
    this.store = null;
    /** @type {any} 数据库句柄 */
    this.db = null;
    /** 探针结果缓存 */
    this.imports = null;
    /** 回填任务状态（进程内，够 Phase 1 用） */
    this.backfill = null;
    /** 仓管任务状态（研磨 / 消化；进程内状态 + `jobs` 表留审计） */
    this.keeper = null;
    // **副仓管自己的槽**（与 `this.keeper` 分开）：两条线各自的 `running` / 进度 / tail，
    // 谁都不覆盖谁、谁也不挡谁（用户 2026-10-08 拍板的口径）。
    this.sideJob = null;
    /** 仓管连通性缓存（测试连接的结果） */
    this.keeperProbe = null;
    /** 写入后待补向量的 id 集合（自动补齐，见 scheduleEmbed） */
    this.embedPending = new Set();
    this.embedDraining = false;
    /** @type {string[]} 最近几次自动补向量的错误 */
    this.embedErrors = [];

    // 面板路由（/api 之下，受信任栅栏 + Cookie 鉴权保护）
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: `${ROUTE_PREFIX}/ping`,
        methods: ['GET'],
        // 必需：`/api` 桥接层用它决定请求体读取方式。漏写会让 bridge() 走流式分支、
        // 用 GET 构造带 body 的 Request 而抛错，最终表现成「HTTP 400：响应不是 JSON」。
        requestBody: 'buffered',
        fetch: () => this.ping(),
      });
      return () => dispose();
    }, `${PLUGIN_ID}: routes`);

    // 面板路由（Phase 4）。全部注册在 `/api` 之下，因此走 connection 的信任栅栏 + Cookie 鉴权。
    //
    // 平台约束：`registerFetchRoute` 按 **pathname** 建键，同一个 path 注册两次会抛
    // 「exact Fetch route … is already registered」。所以 GET/POST 同路径的端点必须在
    // panel.js 里合成一条 `methods: ['GET','POST']` 路由 —— 那是设计约束，不是取舍。
    this.panelRoutes = { ok: true, count: 0, error: null };
    ctx.effect(() => {
      /** @type {(() => Promise<void>)[]} */
      const disposers = [];
      try {
        for (const route of memoryPanelRoutes(this)) {
          disposers.push(ctx.connection.fetch.register(route));
          this.panelRoutes.count += 1;
        }
      } catch (error) {
        // 单条路由注册失败不应该拖垮整个插件；把原因记下来，由 /ping 暴露。
        this.panelRoutes = { ok: false, count: disposers.length, error: describeError(error) };
        ctx.logger?.warn?.(`${PLUGIN_ID}: 面板路由注册失败：${describeError(error)}`);
      }
      return () => {
        for (const dispose of disposers) void dispose();
      };
    }, `${PLUGIN_ID}: panel routes`);

    // 诊断路由（不走 /api，故无鉴权）。
    //
    // ⚠️ 默认关闭。它上面有 /import（读任意文件）、/credential（写凭据）、
    // /clean（改数据）、/search（吐记忆正文）——**本机任何进程都能调**，
    // 因此绝不能默认开着。开发期需要在 profile patch 的 config 里显式写
    // `diagnostics: true` 才启用。
    this.webRoute = { ok: true, enabled: false, error: null };
    if (this.config?.diagnostics === true) {
      this.webRoute.enabled = true;
      try {
        const server = ctx.get('webServer');
        if (server === undefined) {
          this.webRoute = { ok: false, enabled: true, error: 'webServer 服务未挂载' };
        } else {
          ctx.effect(
            () =>
              server.register({
                kind: 'prefix',
                path: DIAG_PREFIX,
                handler: (req, res) => {
                  void this.serveDiagnostic(req, res);
                },
              }),
            `${PLUGIN_ID}: diagnostic route`,
          );
        }
      } catch (error) {
        this.webRoute = { ok: false, enabled: true, error: describeError(error) };
      }
    }

    this.provideResult = { ok: true, error: null };
    try {
      ctx.reflect.provide('memory', this);
    } catch (error) {
      this.provideResult = { ok: false, error: describeError(error) };
    }

    ctx.effect(
      () => () => {
        try {
          if (this.db !== null) closeDatabase(this.db);
        } catch {
          /* 关库失败无妨，进程退出会回收 */
        }
        this.db = null;
        this.store = null;
      },
      `${PLUGIN_ID}: close database`,
    );

    // 记忆工具：让这 1087 条记忆在对话里直接可用。
    this.toolErrors = [];
    ctx.effect(() => {
      const disposers = registerMemoryTools(ctx, this);
      this.toolCount = disposers.length;
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, `${PLUGIN_ID}: tools`);

    // ── 跟随 agent 运行的自主捕获 ────────────────────────────────────────────────
    //
    // 挂 `session/event`（落库后的每条会话事件：`user/message` / `assistant/message` / `turn/end`）。
    // 攒够用户正文 → 回合结束时抽一次 → **连入的 agent 自己免审直接入库**，
    // 其他来源（子代理 / 委派会话）落待审区等这个 agent 审阅。
    //
    // 三条不变量：
    //   1. **绝不阻塞回合**：监听器同步返回、抽取走 `void` 异步；出错只记状态不抛；
    //   2. **节流**：`capture.minChars` + `capture.cooldownMs`，避免每回合都花一次 LLM 调用；
    //   3. **可关**：`capture.enabled=false` 时一条都不抽（默认 true，见 config）。
    this.capture = { subscribed: false, error: null, lastAt: 0, skipped: 0, runs: [], errors: [] };
    /** @type {Map<string, ConversationBuffer>} 每个会话一个转录缓冲（上限 32 个，LRU 淘汰） */
    this.buffers = new Map();
    // 读取侧注入引擎（Layer 0 常驻索引 + Layer 1 按需召回）。**懒建**：`ensureRecall()` 里第一次用才 new，
    // 因为要等 store 开库。注册状态（section / context 挂没挂上）单独记：拿不到 systemPrompt 也要如实报。
    this.recall = null;
    this.recallSection = { ok: false, error: null };
    this.recallContext = { ok: false, error: null };
    // 喂进读取侧的计数：Layer 1 是"拿人的话当查询词"，喂不进去必须**一眼能看出来**，
    // 否则症状只是"注入块空着"，分不清是没查询词、被过滤了、还是引擎没建起来。
    this.recallFeed = { fed: 0, notHuman: 0, foreign: 0, disabled: 0, noEngine: 0, lastAt: 0, lastChars: 0, errors: [] };
    ctx.effect(() => {
      if (typeof ctx.on !== 'function') {
        this.capture.error = 'ctx.on 不可用（宿主没有事件服务）';
        return () => {};
      }
      const dispose = ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
      this.capture.subscribed = true;
      return () => {
        if (typeof dispose === 'function') dispose();
        else if (dispose != null && typeof dispose[Symbol.dispose] === 'function') dispose[Symbol.dispose]();
      };
    }, `${PLUGIN_ID}: capture`);

    // 会话太多时淘汰最老的缓冲：缓冲只是「还没抽的转录」，丢了最多少抽一轮，不会丢数据。
    ctx.effect(() => {
      const dispose = typeof ctx.on === 'function' ? ctx.on('session/disposed', (session) => {
        try {
          this.buffers.delete(String(session?.id ?? ''));
        } catch {
          /* 淘汰失败无妨 */
        }
      }) : null;
      return () => {
        if (typeof dispose === 'function') dispose();
        else if (dispose != null && typeof dispose[Symbol.dispose] === 'function') dispose[Symbol.dispose]();
      };
    }, `${PLUGIN_ID}: capture cleanup`);

    // 系统提示段：只在记忆工具**确实注册成功**时才注入，避免白付 token。
    // DSH 的 SECTION_ORDERS 里没有 memory 槽位（2400 是 TOOL_GOAL、2600 是 TOOL_WORKFLOW），
    // 外部贡献可用任意有限 order —— 取 2500。
    this.promptSection = { ok: false, error: null };
    ctx.effect(() => {
      const systemPrompt = ctx.get('systemPrompt');
      if (systemPrompt === undefined) {
        this.promptSection = { ok: false, error: 'systemPrompt 服务未挂载' };
        return () => {};
      }
      const dispose = systemPrompt.section({
        name: 'tool:memory',
        order: 2500,
        text: ({ scope }) =>
          ctx.get('tools')?.get?.('memory_search', scope) === undefined
            ? ''
            : [
                '你有一份**本地长期记忆库**（存在本机，共约一千条，来自用户长期积累的宫殿与抽取记录）。',
                '**常驻索引已经在你眼前了**（`<memory_index>` 那一块）：不用先去查就能看见几条约定的长期事实；',
                '它只是索引、而且不完整 —— 要细节再用 `memory_get` 取原文。',
                '调用时机：用户提到「你还记得吗」「上次」「之前说过」，或你需要了解其偏好、经历、项目与约定时，',
                '先用 `memory_search`；关键那条未必排第一，换几种说法多查一次常常有效。',
                '**什么时候把记忆说出来**：默认直接用、不必提；只有当你要按一条**旧决定**行事、',
                '而当前用户说法可能与它**冲突**时，才明说一句「我记得你说过 …」（带上 `[mem#…]` 编号）并让用户定夺。',
                '写入：**学到长期有效的事实时主动记下来，不必等用户说「记住」**——',
                '用 `memory_remember`（原文直存，秒级，保真）；一次一条，别把长段落整段塞进去。',
                '内容很长、想让系统自己提炼成一条条事实时用 `memory_extract` —— 它只落**待审区**，',
                '经 `memory_analyze` 查冲突后由 `memory_review` 批准才真正入库。',
                '要换嵌入模型（线上 / 局域网 / 本地）用 `memory_embedding`：list 看档案与缺口，',
                'test 先验证 url / key / 模型 id，activate 切换（旧空间的向量保留，只需补新增的）。',
                '要备份用 `memory_backup`。',
                '不要记：临时状态、公开信息、你自己的猜测。',
              ].join('\n'),
      });
      this.promptSection = { ok: true, error: null };
      return () => dispose();
    }, `${PLUGIN_ID}: prompt section`);

    // ── 读取侧注入（Layer 0 常驻索引 + Layer 1 按需召回）────────────────────────────
    //
    // 分工（2026-10-08，外部评审 + 用户拍板；算法与口径见 `src/host/recall.js` 文件头）：
    //   Layer 0 = **常驻索引**，挂 `section`：话题段内**逐字节冻结** → 保前缀缓存（本机实测命中 99.1%）；
    //   Layer 1 = **按需召回**，挂 `context`：动态内容**放尾部**，miss 的代价封顶在它自己身上。
    // 两个 provider 都必须是**同步**的（宿主只给 `(ctx) => string`）→ 召回走
    // `store.searchBySubstringsSync()`（LIKE + 覆盖度打分），不打 embedding、不加延迟；
    // 语义检索仍留在"想起来之后"的工具路径里。
    ctx.effect(() => {
      const systemPrompt = ctx.get('systemPrompt');
      if (systemPrompt === undefined) {
        this.recallSection = { ok: false, error: 'systemPrompt 服务未挂载' };
        this.recallContext = { ok: false, error: 'systemPrompt 服务未挂载' };
        return () => {};
      }
      const disposers = [];
      try {
        disposers.push(
          systemPrompt.section({
            name: 'tool:memory:index',
            order: 2501,
            text: ({ scope }) => this.ensureRecall()?.indexText(scope) ?? '',
          }),
        );
        this.recallSection = { ok: true, error: null };
      } catch (error) {
        this.recallSection = { ok: false, error: describeError(error) };
      }
      try {
        disposers.push(
          systemPrompt.context({
            // 动态区放到最后：它每轮都可能变，放尾部才不会让后面的 tools / 历史全部重算。
            // 交付前实测确认：context 会被并进宿主自己的 `Current runtime context` 快照（尾部），
            // 而 section 的 text 回调拿到的是**稳定 scope**（WeakMap 冻结真的生效，index.at 一个话题段内不前进）。
            name: 'memory:recall',
            order: 1_000_000,
            text: ({ agent }) => {
              // 全局注册 → 子代理组装提示词时也会走到这儿；只给喂过查询词的那个会话（真机探针验过：
              // 子代理那边 `<memory_index` 在、`<memory_recall` 不在）。
              const session = agent?.session;
              const id = session?.header?.id ?? session?.id;
              // 查询词**现场从会话日志取**（`lastHumanMessage`），拿不到才回落到事件游标 ——
              // 因为 `session/event` 是在该步组装**之后**才到插件手上的（实测差 106 ms），只靠它会永远慢一步：
              // 第 1 步没有查询词，而"没有工具调用的回合"只有一步 → 那个回合永远拿不到本轮的召回。
              // 传懒函数：闸门（别的会话 / 查询词太短）不过时，连日志都不扫。
              return (
                this.ensureRecall()?.recallText(
                  typeof id === 'string' && id !== '' ? id : null,
                  () => lastHumanMessage(session),
                ) ?? ''
              );
            },
          }),
        );
        this.recallContext = { ok: true, error: null };
      } catch (error) {
        this.recallContext = { ok: false, error: describeError(error) };
      }
      return () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose();
            else if (dispose != null && typeof dispose[Symbol.dispose] === 'function') dispose[Symbol.dispose]();
          } catch {
            /* 卸载期错误不改变注册状态 */
          }
        }
      };
    }, `${PLUGIN_ID}: recall injection`);

    // Skill：把完整用法写成按需加载的长文档，避免常驻占 prompt。
    this.skill = { ok: false, error: null };
    ctx.effect(() => {
      const skills = ctx.get('skills');
      if (skills === undefined) {
        this.skill = { ok: false, error: 'skills 服务未挂载' };
        return () => {};
      }
      const dispose = skills.register({
        name: 'dsh-memory-curation',
        // registry 的加载路径要求 source 是字符串（缺了会在 `skill` 工具里报
        // 「loaded skill … source must be a string」——注册成功但用不了）。
        source: PLUGIN_ID,
        description:
          '本地记忆库的整理与维护：什么该记、什么不该记、审阅门怎么走、冲突改写怎么用、脏数据怎么清。',
        whenToUse:
          '当用户要求整理/审阅/清理记忆库，或问「你记得什么」「把这段记下来」，或检索结果不理想需要换策略时。',
        modelInvocable: true,
        userInvocable: true,
        content: [
          '## 本地记忆库维护指南',
          '',
          '### 写入策略',
          '- **插件自己在跟随你运行**：会话攒够长度后会在后台自动抽一次（`capture.enabled` 控制）。',
          '  连入的 agent 自己的会话抽出来**免审直接入库**；子代理 / 委派会话进待审区，由这个 agent 审阅。',
          '  所以你不必把每件事手动记一遍，但这两件值得主动做：① 用户说「记住」时立刻 `memory_remember`；',
          '  ② 你自己判断「以后一定用得上」时主动记，别等用户开口。',
          '- `memory_remember`：原文直存，秒级、保真，**日常默认**。一条一件事，别把长段落整段塞进来。',
          '- `memory_extract`：交给模型抽事实，**结果只落待审区**，不直接入库。适合长文、会议记录、日记。',
          '- `focused=true` 只抽「与人的关系 / 偏好 / 经历 / 拍板决策」，排除命令、端口、路径这类技术细节。',
          '',
          '### 审阅门（infer 写入的必经之路）',
          '1. `memory_pending` 看有哪些批次；',
          '2. `memory_analyze` 查冲突 —— 每条新事实会与库里相似记忆比对，给出',
          '   `supersede`（旧状态过时，该改写）/ `duplicate`（重复）/ `coexist`（都对）/ `unrelated`（无关）；',
          '3. `memory_review` 批准。**只有你在 actions 里显式给出 `supersede` 才会改写旧记忆**，其余一律不动。',
          '',
          '### 四条护栏（不要绕过）',
          '- 只有 `supersede` 才改写，`duplicate` / `coexist` / `unrelated` 都不动旧数据；',
          '- 改写一律要人点头；',
          '- **具体事件、经历、里程碑即使内容相关也算 `coexist`** —— 发生过的事永远是真的；',
          '- 改写自动写 `history`（含 `prev_text`），可追溯可回滚。',
          '',
          '### 检索技巧',
          '- 中文查询**建议 ≥3 字**（FTS5 的 trigram 分词器对 <3 字命不中，这些会走 LIKE 兜底，但排序较弱）；',
          '- 结果里的 `score` 是 RRF 名次融合分，不是相似度；看 `vectorScore` 更直观；',
          '- 一次没搜到就换说法，别下结论说「库里没有」。',
          '',
          '### 维护',
          '- `memory_forget` 是**软删**（保留行与历史），删错了可以恢复；`hard: true` 才是真删行。',
          '- 怀疑向量陈旧或换过嵌入模型时，用面板「概览 → 补齐」；怀疑向量被写坏/不纯时用「强制全量重算」。',
          '- **换嵌入模型 / 局域网模型**：`memory_embedding`（list / test / activate）或面板「设置 → 嵌入配置」。',
          '  切换**不删旧向量**：每个模型一个「空间」，切回来只补离开期间新增的那几条；补齐只算缺的。',
          '- **备份**：`memory_backup {}` → 库本体快照（`VACUUM INTO`，含向量）+ 可读文本包，默认留最近 5 份。',
        ].join('\n'),
      });
      this.skill = { ok: true, error: null };
      return () => dispose();
    }, `${PLUGIN_ID}: skill`);

    ctx.logger?.info?.(`${PLUGIN_ID} 已挂载（dataDir=${this.dataDir}）`);
  }

  /**
   * 解析后的完整配置（带默认值）。
   *
   * 组成 = patch 里的 `config`（基准）+ **库里生效的嵌入档案**（覆盖 `embedding` 块）
   * + **库里生效的仓管档案**（覆盖 `keeper` 块）。两份档案都存在库里
   * （`settings.embedding.profiles` / `settings.keeper.profiles`），所以面板能切换而不用改
   * profile 补丁文件、也不用重启 DSH；patch 里那一份永远是兜底（档案名为 `config`）。
   *
   * 仓管那一块的优先级：**生效档案是 `config` 时** = patch + `keeper.overrides`
   * （上一轮那套「面板改 patch」，见 `saveKeeperConfig`）；生效档案是别的名字时 =
   * patch + 该档案字段，`keeper.overrides` 不参与合并。
   *
   * @returns {ReturnType<typeof normalizeConfig>} 完整配置
   */
  resolvedConfig() {
    const base = this.config ?? {};
    const profile = this.activeProfile();
    const keeperProfile = this.activeKeeperProfile();
    const keeper = keeperProfile === null ? this.keeperOverrides() : profileToKeeper(keeperProfile);
    const withKeeper = Object.keys(keeper).length === 0 ? base : { ...base, keeper: { ...(base.keeper ?? {}), ...keeper } };
    if (profile === null) return normalizeConfig(withKeeper);
    const embedding = { ...(base.embedding ?? {}), ...profileToEmbedding(profile) };
    return normalizeConfig({ ...withKeeper, embedding });
  }

  /**
   * 仓管配置的**面板覆盖**（存在 DB 的 `settings` 里，覆盖 patch 里的同名键）。
   *
   * 和嵌入档案一个思路：patch 是兜底，面板上改的立刻生效、不用重启 DSH。
   * 空值（`''` / `null`）表示「删掉这一项、回落 patch / 默认」。
   *
   * @returns {Record<string, unknown>} 覆盖项（读不到就返回 `{}`）
   */
  keeperOverrides() {
    try {
      const raw = this.store?.getSetting?.('keeper.overrides', null);
      if (raw == null || raw === '') return {};
      const parsed = JSON.parse(raw);
      return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * 保存仓管配置（面板「仓管 → 配置」用）。白名单字段；`''`/`null` = 删除该项。
   *
   * ⚠️ **语义已收紧**：这写的是 `keeper.overrides`，**只在生效档案是内置 `config` 时才参与合并**
   * （`resolvedConfig()` 的规则）。生效档案是别的名字时，用的是那个档案自己的字段，
   * 这份覆盖一点作用都没有 —— 改档案请走 `saveKeeperProfile()`。
   * 所以面板只在 `active === 'config'` 时显示这几个输入框，别让人对着不生效的框改。
   *
   * @param {Record<string, unknown>} patch 要写入的字段
   * @returns {{ok: boolean, overrides: Record<string, unknown>, error?: string}} 结果
   */
  saveKeeperConfig(patch = {}) {
    const store = this.ensureStore();
    const fields = [
      'provider',
      'ollamaUrl',
      'baseUrl',
      'model',
      'apiKeyRef',
      'timeoutMs',
      'maxTokens',
      'temperature',
      'minChars',
      'digestMinChars',
      'splitChars',
      'dedupeThreshold',
      'sampleSize',
      'perGroup',
    ];
    try {
      const next = { ...this.keeperOverrides() };
      for (const key of fields) {
        if (patch == null || !Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const value = patch[key];
        if (value == null || value === '') delete next[key];
        else next[key] = value;
      }
      // 先校验再落库：`normalizeConfig` 对非法值（provider 写错、阈值不是正整数…）直接抛，
      // 这样面板上写错会**当场**得到错误原文，而不是等跑任务时才炸。
      normalizeConfig({ ...(this.config ?? {}), keeper: { ...((this.config ?? {}).keeper ?? {}), ...next } });
      store.setSetting('keeper.overrides', JSON.stringify(next));
      return { ok: true, overrides: next };
    } catch (error) {
      return { ok: false, error: describeError(error), overrides: this.keeperOverrides() };
    }
  }

  // ── 仓管配置档案（线上 / 局域网 / 本机，可主动切换） ─────────────────────────
  //
  // 与「嵌入配置档案」完全同构，但**没有向量空间那一层**：仓管只是一条 LLM 通道，
  // 切换改的是「下次任务用哪个端点 / 模型 / 参数」，不涉及任何数据搬迁，所以代价只有一行设置。
  //
  // - 档案存在库里（`settings.keeper.profiles`）：面板能切换，不用改 profile 补丁、不用重启；
  // - `settings.keeper.active` 指向生效档案；**缺省 / `config`** = 用 patch 里那一份；
  // - 内置档案 `config` 永远排第一、`builtin: true`、**不可删**；
  // - `keeper.overrides`（上一轮那套）**只在生效档案是 `config` 时**参与合并（见 resolvedConfig）。

  /**
   * 读库里的仓管档案集合（**不播种、不写库**；库没开或读坏了都如实回空）。
   *
   * `exists` 区分「没写过」与「写过但是空数组」：播种只认前者，见 `listKeeperProfiles`。
   *
   * @returns {{profiles: object[], active: string | null, exists: boolean, error: string | null}} 档案状态
   */
  keeperProfilesState() {
    if (this.store === null) return { profiles: [], active: null, exists: false, error: null };
    try {
      const raw = this.store.getSetting('keeper.profiles', null);
      const exists = raw != null && String(raw) !== '';
      let profiles = [];
      if (exists) {
        const parsed = JSON.parse(raw);
        profiles = Array.isArray(parsed)
          ? parsed.filter((item) => item != null && typeof item === 'object' && typeof item.name === 'string' && item.name !== '')
          : [];
      }
      const active = this.store.getSetting('keeper.active', null);
      return { profiles, active: typeof active === 'string' && active !== '' ? active : null, exists, error: null };
    } catch (error) {
      return { profiles: [], active: null, exists: true, error: describeError(error) };
    }
  }

  /**
   * 当前生效的仓管档案。
   *
   * `null` = 生效的是内置 `config`（= patch + `keeper.overrides`）。生效名指向一个**不存在**的
   * 档案时也回 `null` —— 与 `listKeeperProfiles()` / `resolvedConfig()` 的回落行为保持一致。
   *
   * @returns {object | null} 档案
   */
  activeKeeperProfile() {
    const { profiles, active } = this.keeperProfilesState();
    if (active === null || active === PATCH_PROFILE_NAME) return null;
    return profiles.find((item) => item.name === active) ?? null;
  }

  /**
   * 删掉一条 setting。
   *
   * `store.js` 只有 get / set（本次改动范围不允许动它），而「切回内置 `config`」的语义是
   * **这个键不存在**（缺省即 `config`），不是写一个 `'config'` 进去：后者会让「人到底有没有
   * 手动选过档案」变得不可分辨。所以这里直接对 settings 表执行一条 DELETE（不改 schema）。
   *
   * @param {string} key 键
   * @returns {boolean} 是否执行了删除
   */
  removeSetting(key) {
    const store = this.ensureStore();
    const db = this.db ?? store.db;
    if (db == null || typeof db.prepare !== 'function') return false;
    db.prepare('DELETE FROM settings WHERE key = ?').run(String(key));
    return true;
  }

  /**
   * 列出全部仓管档案。内置 `config` **永远排第一**、标 `builtin: true`、不可删。
   *
   * 首次调用时若库里**从来没有写过**档案，播种两条（线上 / 局域网-ollama）。
   * 播种判据是「键不存在」而不是「数组为空」：用户把种子删光了是他的决定，不该被塞回来。
   *
   * 每条的 `configured` 与 `keeperStatus().configured` 同一判据（模型与端点都得有），
   * 面板据此把「还不能跑」的档案标出来。
   *
   * @returns {{ok: boolean, active: string, profiles: object[], error?: string}} 列表
   */
  listKeeperProfiles() {
    try {
      const store = this.ensureStore();
      let state = this.keeperProfilesState();
      if (state.exists !== true && state.error === null) {
        store.setSetting('keeper.profiles', JSON.stringify(KEEPER_SEED_PROFILES));
        state = this.keeperProfilesState();
      }
      const patchKeeper = normalizeConfig(this.config ?? {}).keeper;
      const configKeeper = { ...patchKeeper, ...this.keeperOverrides() };
      // 生效名指向不存在的档案时按 `config` 报 —— 和 resolvedConfig() 的回落一致，
      // 免得面板高亮一个其实没生效的档案。
      const active =
        state.active !== null && state.profiles.some((item) => item.name === state.active)
          ? state.active
          : PATCH_PROFILE_NAME;

      /**
       * 整形一个档案（`fields` 是这个档案自己的字段，面板拿它回填表单）。
       *
       * @param {object} keeper 合并后的 keeper 块
       * @param {string} name 档案名
       * @param {boolean} builtin 是否内置
       * @param {object} fields 档案自己的字段
       * @returns {object} 面板用的档案
       */
      const describe = (keeper, name, builtin, fields) => {
        const endpoint = keeper.provider === 'ollama' ? keeper.ollamaUrl : keeper.baseUrl;
        const hasEndpoint = endpoint != null && String(endpoint) !== '';
        const model = typeof keeper.model === 'string' && keeper.model.trim() !== '' ? keeper.model : null;
        return {
          name,
          provider: keeper.provider ?? null,
          endpoint: hasEndpoint ? String(endpoint) : null,
          model,
          apiKeyRef: keeper.apiKeyRef ?? null,
          configured: model !== null && hasEndpoint,
          builtin,
          active: name === active,
          fields,
        };
      };

      const profiles = [
        describe(configKeeper, PATCH_PROFILE_NAME, true, { ...configKeeper }),
        ...state.profiles.map((item) =>
          describe({ ...patchKeeper, ...profileToKeeper(item) }, item.name, false, { ...profileToKeeper(item) }),
        ),
      ];
      return { ok: true, active, profiles, ...(state.error === null ? {} : { error: state.error }) };
    } catch (error) {
      return { ok: false, error: describeError(error), active: PATCH_PROFILE_NAME, profiles: [] };
    }
  }

  /**
   * 新建 / 覆盖一个仓管档案（只写库，**不切换**）。
   *
   * 语义是 **upsert**：没给的字段沿用该档案原来的值（不是清空）；`''` / `null` 才是
   * 「删掉这个键、回落 patch / 默认」。写库前先按 `resolvedConfig()` 同一套合并顺序跑一遍
   * `normalizeConfig`，非法值（provider 写错、阈值不是正整数…）**当场抛**、错误原文回给调用方，
   * 绝不把坏配置落进库。
   *
   * @param {{name: string} & Record<string, unknown>} input 档案字段
   * @returns {{ok: boolean, name?: string, profile?: object, error?: string}} 结果
   */
  saveKeeperProfile(input = {}) {
    try {
      const source = input != null && typeof input === 'object' ? input : {};
      const name = String(source.name ?? '').trim();
      if (name === '') return { ok: false, error: '档案名不能为空' };
      if (name === PATCH_PROFILE_NAME) {
        return { ok: false, error: `「${PATCH_PROFILE_NAME}」是 patch 配置的保留名，请换一个` };
      }
      const store = this.ensureStore();
      const state = this.keeperProfilesState();
      const previous = state.profiles.find((item) => item.name === name);
      const next = { ...(previous ?? {}) };
      for (const key of KEEPER_PROFILE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const value = source[key];
        if (value == null || value === '') delete next[key];
        else next[key] = value;
      }
      delete next.name;
      // patch 打底 + 这个档案的字段：和 resolvedConfig() 用同一套合并顺序，
      // 所以「校验通过」就等于「切过去一定跑得起来」。
      normalizeConfig({ ...(this.config ?? {}), keeper: { ...((this.config ?? {}).keeper ?? {}), ...next } });
      const profiles = state.profiles.filter((item) => item.name !== name);
      profiles.push({ name, ...next });
      store.setSetting('keeper.profiles', JSON.stringify(profiles));
      return { ok: true, name, profile: { name, ...next } };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 删除一个仓管档案。内置 `config` 不可删；删的正好是**生效档案**时自动回落 `config`。
   *
   * @param {string} name 档案名
   * @returns {{ok: boolean, removed?: boolean, wasActive?: boolean, active?: string, error?: string}} 结果
   */
  deleteKeeperProfile(name) {
    try {
      const target = String(name ?? '').trim();
      if (target === '') return { ok: false, error: '缺少档案名' };
      if (target === PATCH_PROFILE_NAME) {
        return { ok: false, error: `内置档案「${PATCH_PROFILE_NAME}」不能删（它就是 patch 里那份，改 profile 补丁文件即可）` };
      }
      const store = this.ensureStore();
      const state = this.keeperProfilesState();
      const next = state.profiles.filter((item) => item.name !== target);
      if (next.length === state.profiles.length) return { ok: false, error: `没有这个档案：${target}` };
      store.setSetting('keeper.profiles', JSON.stringify(next));
      const wasActive = state.active === target;
      // 生效档案被删掉 → 立刻回落 config。绝不能留一个指向不存在档案的 active：
      // 那会让 resolvedConfig() 悄悄退回 patch、而面板还显示在用那个档案。
      if (wasActive) this.removeSetting('keeper.active');
      return {
        ok: true,
        removed: true,
        wasActive,
        active: wasActive ? PATCH_PROFILE_NAME : (state.active ?? PATCH_PROFILE_NAME),
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 切换生效的仓管档案。**只改一行设置**；`config` = 删掉 `keeper.active`、回落 patch。
   *
   * @param {string} name 档案名
   * @returns {{ok: boolean, active?: string, status?: object, error?: string}} 结果（带切换后的现状）
   */
  activateKeeperProfile(name) {
    try {
      const target = String(name ?? '').trim();
      if (target === '') return { ok: false, error: '缺少档案名' };
      const store = this.ensureStore();
      if (target === PATCH_PROFILE_NAME) {
        this.removeSetting('keeper.active');
        return { ok: true, active: PATCH_PROFILE_NAME, status: this.keeperStatus() };
      }
      const { profiles } = this.keeperProfilesState();
      if (!profiles.some((item) => item.name === target)) return { ok: false, error: `没有这个档案：${target}` };
      store.setSetting('keeper.active', target);
      return { ok: true, active: target, status: this.keeperStatus() };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * **副仓管**这个角色的模型选择（用户 2026-10-07：「副审阅区使用独立的仓管角色」）。
   *
   * 存在 `settings.keeper.side`，与主仓管的 `keeper.active` **分开两行** —— 主仓管跑一轮用哪个档案、
   * 副仓管用哪个，从此互不影响。没写这个键 = `null` = 自动（本地 / 局域网档案优先 → 宿主模型）。
   *
   * @returns {string | null} `null` = 没选（自动）；否则 `'host'` 或仓管档案名
   */
  sideKeeperChoice() {
    if (this.store === null) return null;
    try {
      const raw = this.store.getSetting('keeper.side', null);
      const text = typeof raw === 'string' ? raw.trim() : '';
      return text === '' || text === 'auto' ? null : text;
    } catch {
      /* 读不到就当没选（回落自动顺序），不影响别的字段 */
      return null;
    }
  }

  /**
   * 设定**副仓管**的模型角色。`''` / `'auto'` = 删掉这个键、回落自动顺序。
   *
   * 只认三样：`'host'`（宿主模型）、**已存在的仓管档案名**、`'auto'`。名字先校验存在性 ——
   * 写进去一个不存在的名字，效果是"点接手时才报错"，不如当场说清楚。
   *
   * @param {string|null} model 选择（`'auto'` / `'host'` / 档案名）
   * @returns {{ok: boolean, side?: string|null, status?: object, error?: string}} 结果（带设定后的现状）
   */
  setSideKeeper(model) {
    try {
      const target = String(model ?? '').trim();
      // 与 `activateKeeperProfile()` 同一顺序：先开库，档案列表才读得到。
      const store = this.ensureStore();
      if (target === '' || target === 'auto') {
        this.removeSetting('keeper.side');
        return { ok: true, side: null, status: this.keeperStatus() };
      }
      if (target !== 'host') {
        const { profiles } = this.keeperProfilesState();
        if (!profiles.some((item) => item.name === target)) return { ok: false, error: `没有这个档案：${target}` };
      }
      store.setSetting('keeper.side', target);
      return { ok: true, side: target, status: this.keeperStatus() };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 写入一个凭据（面板「设置」页的密钥框用）。
   *
   * 密钥只进 DSH 凭据库，**不落任何本插件生成的文件**，也不回给浏览器。
   * @param {string|null} ref - 引用名，缺省用配置里的 apiKeyRef
   * @param {string} value - 密钥值
   * @returns {Promise<{ref: string}>} 结果
   */
  async setCredential(ref, value) {
    const credentials = this.ctx.get('credentials');
    if (credentials === undefined) throw new Error('credentials 服务未挂载');
    const target = ref ?? this.resolvedConfig().embedding.apiKeyRef;
    await credentials.set(target, value);
    return { ref: target };
  }

  /**
   * 惰性开库。幂等。
   *
   * v1→v2 的向量表升级就在这里发生（`openDatabase` 内部）：先把老表改名留底，
   * 再按「行自己的 model/dims + patch 里的 provider」拼空间键搬过去 ——
   * **不用库里/配置里的当前 provider 之外的猜测**，因为 v1 根本没存 provider。
   * 结果记在 `this.migration` 里，面板「概览」会显示。
   *
   * @returns {import('../src/host/store.js').MemoryStore} 仓储
   */
  /**
   * 读取侧注入引擎（懒建：第一次组装 prompt 时才 new，那时库已开）。
   *
   * 建不起来就回 `null` —— 注入是**加分项**，任何一环不通都不该影响别的功能。
   *
   * @returns {import('../src/host/recall.js').RecallEngine | null} 引擎实例
   */
  ensureRecall() {
    if (this.recall !== null) return this.recall;
    try {
      const cfg = this.resolvedConfig()?.recall ?? {};
      this.recall = new RecallEngine({ store: this.ensureStore(), cfg });
      return this.recall;
    } catch (error) {
      this.recallSection = { ok: false, error: describeError(error) };
      return null;
    }
  }

  /**
   * 读取侧注入的现状（给 `memory_stats` 与诊断看：注入了什么、为什么、有没有出错）。
   *
   * @returns {object} 状态（永远有值，用来如实回答"到底注进去没有"）。
   */
  recallStatus() {
    const engine = this.recall === null ? null : this.recall;
    return {
      section: this.recallSection,
      context: this.recallContext,
      feed: this.recallFeed,
      engine: engine === null ? null : engine.status(),
    };
  }


  ensureStore() {
    if (this.store !== null) return this.store;
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    const file = join(this.dataDir, 'memory.db');
    this.db = openDatabase(file, { legacyProvider: this.patchEmbeddingProvider() });
    const migration = lastMigration(this.db);
    this.migration = migration ?? null;
    if (migration?.migrated === true) {
      this.ctx.logger?.info?.(
        `${PLUGIN_ID}: 向量表已升级为「按空间保留」（${migration.rows} 条，原因 ${migration.reason}，留底表 ${migration.backup ?? '(无)'}）`,
      );
    }
    if (migration?.scoreColumns?.migrated === true) {
      this.ctx.logger?.info?.(
        `${PLUGIN_ID}: memories 已补行为计分列（${migration.scoreColumns.added.join(', ')}，纯增量、既有数据不动）`,
      );
    }
    if (migration?.ftsTriggers?.migrated === true) {
      this.ctx.logger?.info?.(
        `${PLUGIN_ID}: FTS 更新触发器已收窄为 AFTER UPDATE OF text（计分写入不再重建索引）`,
      );
    }
    this.store = new MemoryStore(this.db, {});
    return this.store;
  }

  /**
   * patch 配置里的 provider（**不看**库里的档案）。
   *
   * 只用来给 v1 的老向量行猜 provider：那些向量是「档案功能存在之前」算的，
   * 一定来自 patch 里的配置。读不到就退回 `'openai'`。
   *
   * @returns {string} provider
   */
  patchEmbeddingProvider() {
    try {
      return normalizeConfig(this.config ?? {}).embedding.provider;
    } catch {
      return 'openai';
    }
  }

  // ── 嵌入配置档案 ──────────────────────────────────────────────────────────────
  //
  // 需求：线上 / 局域网 / 本地模型都要能自定义（api url、api key 引用、模型 id），
  // 而且**每次切换都要保留各自的向量**，切回来只补「那个空间里还缺的」。
  //
  // 实现要点：
  // - 档案只是「一组 embedding 字段」，存在库里的 settings，不碰 patch 文件、不重启；
  // - 每个档案算出一个空间键 `provider:model:dims`（`embeddingSpace()`），向量按它分组；
  // - 切换 = 改 `settings.embedding.active`，**一行向量都不删**；缺多少由
  //   `countMissingVectors` 算出来，补齐只遍历缺的（`listTextsMissingVector`）。

  /**
   * 读库里的档案集合。
   *
   * @returns {{ profiles: object[], active: string | null, error: string | null }} 档案状态
   */
  profilesState() {
    if (this.store === null) return { profiles: [], active: null, error: null };
    try {
      const parsed = JSON.parse(this.store.getSetting('embedding.profiles', '[]'));
      const profiles = Array.isArray(parsed)
        ? parsed.filter((item) => item != null && typeof item === 'object' && typeof item.name === 'string' && item.name !== '')
        : [];
      const active = this.store.getSetting('embedding.active', null);
      return { profiles, active: typeof active === 'string' && active !== '' ? active : null, error: null };
    } catch (error) {
      return { profiles: [], active: null, error: describeError(error) };
    }
  }

  /**
   * 当前生效的档案（`null` = 用 patch 里那份）。
   *
   * @returns {object | null} 档案
   */
  activeProfile() {
    const { profiles, active } = this.profilesState();
    if (active === null) return null;
    return profiles.find((item) => item.name === active) ?? null;
  }

  /**
   * 一个嵌入配置对应的向量空间（= 空间键 + 展示用的 provider/model/dims）。
   *
   * @param {object} [cfg] 解析后的配置；省略则用当前生效配置
   * @returns {{ key: string, provider: string, model: string, dims: number }} 空间
   */
  embeddingSpace(cfg = this.resolvedConfig()) {
    const embedding = cfg.embedding;
    const dims = Number(embedding.provider === 'local-hash' ? embedding.localDims : embedding.dimensions);
    return {
      key: embeddingFingerprint(embedding),
      provider: String(embedding.provider),
      model: String(embedding.model),
      dims,
    };
  }

  /**
   * 列出全部档案，并附上「这个档案的空间里已有多少向量、还缺多少」。
   *
   * `missing` 就是切换过去之后要补的条数：0 = 切过去立即可用；>0 = 点一下「补齐」。
   *
   * @returns {{ ok: boolean, active: string, profiles: object[], error?: string }} 列表
   */
  listEmbeddingProfiles() {
    try {
      const store = this.ensureStore();
      const state = this.profilesState();
      const patchEmbedding = normalizeConfig(this.config ?? {}).embedding;

      /** @param {object} embedding @param {string} source */
      const describe = (embedding, source) => {
        const cfg = normalizeConfig({ embedding });
        const dims = Number(cfg.embedding.provider === 'local-hash' ? cfg.embedding.localDims : cfg.embedding.dimensions);
        const key = embeddingFingerprint(cfg.embedding);
        return {
          embedding: {
            provider: cfg.embedding.provider,
            baseUrl: cfg.embedding.baseUrl,
            model: cfg.embedding.model,
            dimensions: cfg.embedding.dimensions,
            apiKeyRef: cfg.embedding.apiKeyRef,
            ollamaUrl: cfg.embedding.ollamaUrl,
            localDims: cfg.embedding.localDims,
            batchSize: cfg.embedding.batchSize,
            timeoutMs: cfg.embedding.timeoutMs,
          },
          space: { key, provider: cfg.embedding.provider, model: cfg.embedding.model, dims },
          vectors: store.countVectors(key),
          missing: store.countMissingVectors(key),
          source,
        };
      };

      const profiles = [
        { name: PATCH_PROFILE_NAME, ...describe(patchEmbedding, 'config') },
        ...state.profiles.map((item) => ({ name: item.name, ...describe({ ...patchEmbedding, ...profileToEmbedding(item) }, 'db') })),
      ];
      return {
        ok: true,
        active: state.active ?? PATCH_PROFILE_NAME,
        profiles,
        ...(state.error === null ? {} : { error: state.error }),
      };
    } catch (error) {
      return { ok: false, error: describeError(error), active: PATCH_PROFILE_NAME, profiles: [] };
    }
  }

  /**
   * 新建 / 覆盖一个档案（只写库，不切换、不删任何向量）。
   *
   * @param {{name: string} & Record<string, unknown>} input 档案字段
   * @returns {{ ok: boolean, name?: string, space?: object, error?: string }} 结果
   */
  saveEmbeddingProfile(input = {}) {
    try {
      const name = String(input.name ?? '').trim();
      if (name === '') return { ok: false, error: '档案名不能为空' };
      if (name === PATCH_PROFILE_NAME) {
        return { ok: false, error: `「${PATCH_PROFILE_NAME}」是 patch 配置的保留名，请换一个` };
      }
      const store = this.ensureStore();
      // 用完整校验挡在写库前：非法值直接抛，绝不把坏配置落进库。
      const embedding = normalizeConfig({ embedding: profileToEmbedding(input) }).embedding;
      const state = this.profilesState();
      const next = state.profiles.filter((item) => item.name !== name);
      next.push({ name, ...embedding });
      store.setSetting('embedding.profiles', JSON.stringify(next));
      const space = this.embeddingSpace(normalizeConfig({ embedding }));
      return {
        ok: true,
        name,
        space,
        vectors: store.countVectors(space.key),
        missing: store.countMissingVectors(space.key),
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 删除一个档案（**不删它的向量**：空间还在，切回来仍然可用）。
   *
   * @param {string} name 档案名
   * @returns {{ ok: boolean, removed?: boolean, wasActive?: boolean, error?: string }} 结果
   */
  deleteEmbeddingProfile(name) {
    try {
      const target = String(name ?? '');
      if (target === '') return { ok: false, error: '缺少档案名' };
      if (target === PATCH_PROFILE_NAME) return { ok: false, error: 'patch 配置不能删，改 profile 补丁文件即可' };
      const store = this.ensureStore();
      const state = this.profilesState();
      const next = state.profiles.filter((item) => item.name !== target);
      const removed = next.length !== state.profiles.length;
      store.setSetting('embedding.profiles', JSON.stringify(next));
      const wasActive = state.active === target;
      if (wasActive) store.setSetting('embedding.active', PATCH_PROFILE_NAME);
      return { ok: true, removed, wasActive };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 切换生效档案。**只改一行设置，不删任何向量**。
   *
   * @param {string} name 档案名（`config` = 回到 patch 配置）
   * @returns {{ ok: boolean, active?: string, space?: object, vectors?: number, missing?: number, error?: string }} 结果
   */
  activateEmbeddingProfile(name) {
    try {
      const target = String(name ?? '').trim();
      if (target === '') return { ok: false, error: '缺少档案名' };
      const store = this.ensureStore();
      if (target === PATCH_PROFILE_NAME) {
        store.setSetting('embedding.active', PATCH_PROFILE_NAME);
        const space = this.embeddingSpace();
        return {
          ok: true,
          active: PATCH_PROFILE_NAME,
          space,
          vectors: store.countVectors(space.key),
          missing: store.countMissingVectors(space.key),
        };
      }
      const { profiles } = this.profilesState();
      const profile = profiles.find((item) => item.name === target);
      if (profile == null) return { ok: false, error: `没有这个档案：${target}` };

      store.setSetting('embedding.active', target);
      const cfg = this.resolvedConfig();
      const space = this.embeddingSpace(cfg);
      return {
        ok: true,
        active: target,
        space,
        vectors: store.countVectors(space.key),
        missing: store.countMissingVectors(space.key),
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 用当前（或指定档案）的嵌入配置真打一次请求，回答「这个配置到底能不能用、多少维」。
   *
   * 这是「可自定义 api url / key / 模型 id」的验收手段：配完立刻验证，不用等补齐跑一半才发现错。
   *
   * @param {{name?: string | null, apiKeyRef?: string | null, text?: string}} [input] 参数
   * @returns {Promise<object>} 探测结果（含是否与声明的维度一致）
   */
  async testEmbedding({ name = null, apiKeyRef = null, text = 'dsh-memory 嵌入自检' } = {}) {
    const started = Date.now();
    /** @type {{ok: boolean, profile: string, provider?: string, model?: string, baseUrl?: string|null, dims?: number, vectorLength?: number, elapsedMs?: number, keySource?: string|null, error?: string}} */
    const result = { ok: false, profile: name ?? PATCH_PROFILE_NAME };
    try {
      let cfg;
      if (name == null || name === PATCH_PROFILE_NAME) {
        cfg = normalizeConfig(this.config ?? {});
      } else {
        const { profiles } = this.profilesState();
        const profile = profiles.find((item) => item.name === name);
        if (profile == null) return { ...result, error: `没有这个档案：${name}` };
        const patchEmbedding = normalizeConfig(this.config ?? {}).embedding;
        cfg = normalizeConfig({ embedding: { ...patchEmbedding, ...profileToEmbedding(profile) } });
      }
      const ref = apiKeyRef ?? cfg.embedding.apiKeyRef;
      const resolved = await this.resolveKey(ref);
      result.provider = cfg.embedding.provider;
      result.model = cfg.embedding.model;
      result.baseUrl = cfg.embedding.provider === 'ollama' ? cfg.embedding.ollamaUrl : cfg.embedding.baseUrl;
      result.dims = cfg.embedding.provider === 'local-hash' ? cfg.embedding.localDims : cfg.embedding.dimensions;
      result.keySource = resolved.source ?? null;
      if (resolved.value === null && cfg.embedding.provider !== 'local-hash') {
        return { ...result, error: `没有可用的密钥（credentials 与环境变量 ${ref} 都是空）` };
      }
      const embedder = createEmbedder(cfg.embedding, { apiKey: resolved.value ?? null });
      const vectors = await embedder.embed([String(text)]);
      result.vectorLength = vectors[0]?.length ?? 0;
      result.space = embedder.fingerprint;
      result.ok = result.vectorLength === result.dims;
      if (!result.ok) {
        result.error = `返回 ${result.vectorLength} 维，配置声明 ${result.dims} 维 —— 维度必须一致，否则向量会被检索层丢弃`;
      }
      result.elapsedMs = Date.now() - started;
      return result;
    } catch (error) {
      result.elapsedMs = Date.now() - started;
      return { ...result, error: describeError(error) };
    }
  }

  /**
   * 一键备份：**库本体 + 文本包**各一份。
   *
   * 库本体用 SQLite 的 `VACUUM INTO` 做**在线一致性快照**（WAL 里的改动也一并落进去，
   * 不用停服务、也不像直接拷文件那样可能拷到半截）。等价于原型的 Qdrant snapshot。
   * 默认保留最近 `keep` 份，更旧的删掉，免得每次备份累积。
   *
   * @param {{dir?: string | null, keep?: number, withPack?: boolean}} [input] 参数
   * @returns {object} 备份结果（含路径与体积）
   */
  backupNow({ dir = null, keep = 5, withPack = true } = {}) {
    try {
      const store = this.ensureStore();
      const cfg = this.resolvedConfig();
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
      const root = dir == null || String(dir).trim() === '' ? join(this.dataDir, '备份') : String(dir).trim();
      const target = join(root, `backup-${stamp}`);
      mkdirSync(target, { recursive: true });

      // ① 库本体：在线一致性快照
      const dbFile = join(target, 'memory.db');
      this.db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
      const dbBytes = statSync(dbFile).size;

      // ② 文本包（人可读 + 可迁移；不含向量，导入时重算）
      let pack = null;
      if (withPack !== false) {
        const exported = exportPack({
          store,
          dir: join(target, 'pack'),
          scope: cfg.scope,
          embedding: { provider: cfg.embedding.provider, model: cfg.embedding.model, dims: cfg.embedding.dimensions },
        });
        pack = { dir: exported.dir, count: exported.count, bytes: exported.bytes };
      }

      // ③ 只留最近 keep 份
      const keepN = Math.max(1, Number.isFinite(Number(keep)) ? Math.trunc(Number(keep)) : 5);
      const pruned = [];
      const backups = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
        .map((entry) => entry.name)
        .sort();
      while (backups.length > keepN) {
        const oldest = backups.shift();
        try {
          rmSync(join(root, oldest), { recursive: true, force: true });
          pruned.push(oldest);
        } catch (error) {
          this.ctx.logger?.warn?.(`${PLUGIN_ID}: 清理旧备份失败 ${oldest}：${describeError(error)}`);
        }
      }

      return { ok: true, dir: target, dbBytes, pack, pruned, memories: store.countMemories({ includeDeleted: false }), vectors: store.countVectors() };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 解析嵌入密钥。优先 DSH 凭据库，退回同名环境变量。密钥永不落盘到本插件生成的文件。
   * @param {string} ref - 密钥引用名。
   * @returns {Promise<{source: string|null, value: string|null, described: unknown}>} 解析结果。
   */
  async resolveKey(ref) {
    let described = null;
    try {
      const credentials = this.ctx.get('credentials');
      if (credentials !== undefined) {
        described = await credentials.describe?.(ref).catch(() => null);
        const resolved = await credentials.resolve(ref);
        if (resolved?.value) return { source: `credentials:${ref}`, value: resolved.value, described };
      }
    } catch (error) {
      described = `describe/resolve 失败：${describeError(error)}`;
    }
    const fromEnv = process.env[ref];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
      return { source: `env:${ref}`, value: fromEnv, described };
    }
    return { source: null, value: null, described };
  }

  // ── 核心能力（后续面板与工具都调这些） ───────────────────────────────────────

  /**
   * 从原系统的 markdown 导出包（已解析好的 JSONL）批量导入原文。
   *
   * **只写文本，不算向量** —— 遵循「文本是本体、向量是派生物」，向量由 `startBackfill` 另算。
   * @param {{ file: string, scope?: string|null, dryRun?: boolean }} input - 导入参数。
   * @returns {Promise<object>} 导入结果统计
   */
  async importLegacy({ file, scope = null, dryRun = false }) {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    const store = this.ensureStore();
    const targetScope = scope ?? this.resolvedConfig().scope;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    /** @type {string[]} */
    const errors = [];

    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (typeof row.text !== 'string' || row.text.length === 0) {
          skipped += 1;
          continue;
        }
        if (dryRun) {
          added += 1;
          continue;
        }
        const result = store.addMemory({
          text: row.text,
          scope: targetScope,
          source: row.source ?? null,
          section: row.section ?? null,
          kind: row.kind ?? null,
          meta: row.meta ?? {},
        });
        if (result.created) added += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        if (errors.length < 5) errors.push(describeError(error));
      }
    }
    return {
      ok: failed === 0,
      file,
      dryRun,
      scope: targetScope,
      total: lines.length,
      added,
      skipped,
      failed,
      errors,
      store: this.storeStats(),
    };
  }

  /**
   * 一次性清洗：剥掉正文开头重复的分节标题（见 `stripDuplicatedSection`）。
   *
   * 每改一条都会：① 经 `updateMemoryText` 写 history 留痕；② **删掉它的向量**，
   * 让它回到「待回填」集合 —— 文本变了向量就作废，绝不能留着旧向量被检索命中。
   * @param {{ dryRun?: boolean, limit?: number }} [input] - 参数
   * @returns {Promise<object>} 清洗结果（含样例与剩余待回填数）
   */
  async cleanDuplicatedSection({ dryRun = true, limit = 0 } = {}) {
    const store = this.ensureStore();
    /** @type {{id: string, text: string, section: string}[]} */
    const rows = [];
    for (const item of store.listTexts({ batchSize: 500 })) {
      const memory = store.getMemory(item.id);
      rows.push({ id: item.id, text: item.text, section: memory?.section ?? '' });
    }

    let changed = 0;
    let savedChars = 0;
    /** @type {object[]} */
    const samples = [];
    for (const row of rows) {
      if (limit > 0 && changed >= limit) break;
      const next = stripDuplicatedSection(row.text, row.section);
      if (next === null) continue;
      changed += 1;
      savedChars += row.text.length - next.length;
      if (samples.length < 5) {
        samples.push({
          id: row.id,
          source: store.getMemory(row.id)?.source ?? null,
          beforeLen: row.text.length,
          afterLen: next.length,
          // 只给结构信息与极短片段，避免把私密正文打进日志
          afterHead: next.slice(0, 24),
        });
      }
      if (!dryRun) {
        store.updateMemoryText(row.id, next, { note: 'clean:strip-duplicated-section' });
        store.deleteVector(row.id);
      }
    }
    return {
      ok: true,
      dryRun,
      scanned: rows.length,
      changed,
      savedChars,
      samples,
      store: this.storeStats(),
    };
  }

  /**
   * 把若干记忆排进「待补向量」队列并启动后台补齐。
   *
   * 为什么必须有它：新写入的记忆若没有向量，就只能靠关键词被检索到（且要 ≥3 字），
   * 语义检索完全看不见它 —— 这是「写进去搜不到」的又一个变种。
   * 补齐是**后台**做的：嵌入一次要 0.5~1.5 秒，绝不能卡住写入本身。
   * @param {string} id - 记忆 id
   */
  scheduleEmbed(id) {
    this.embedPending.add(String(id));
    void this.drainEmbed();
  }

  /**
   * 后台补齐循环：每次取一批、算向量、落库。失败只记录不抛出（不打断写入语义）。
   * @returns {Promise<void>} 队列排空即返回
   */
  async drainEmbed() {
    if (this.embedDraining) return;
    this.embedDraining = true;
    try {
      while (this.embedPending.size > 0) {
        // 先开库：档案覆盖存在库里，resolvedConfig() 要能读到才算数。
        const store = this.ensureStore();
        const cfg = this.resolvedConfig();
        const resolved = await this.resolveKey(cfg.embedding.apiKeyRef);
        if (resolved.value === null && cfg.embedding.provider !== 'local-hash') {
          this.noteEmbedError(`没有可用的密钥（${cfg.embedding.apiKeyRef}），新记忆将只有关键词可检索`);
          this.embedPending.clear();
          break;
        }
        const ids = [...this.embedPending].slice(0, 16);
        for (const id of ids) this.embedPending.delete(id);
        const texts = ids.map((id) => store.getMemory(id)?.text ?? '');
        try {
          const embedder = createEmbedder(cfg.embedding, { apiKey: resolved.value });
          const vectors = await embedder.embed(texts);
          for (let i = 0; i < ids.length; i += 1) {
            if (!texts[i]) continue;
            store.putVector({
              memoryId: ids[i],
              space: embedder.fingerprint,
              provider: embedder.provider,
              model: embedder.model,
              dims: embedder.dims,
              vector: vectors[i],
            });
          }
          store.setActiveSpace({ key: embedder.fingerprint, provider: embedder.provider, model: embedder.model, dims: embedder.dims });
        } catch (error) {
          this.noteEmbedError(describeError(error));
        }
      }
    } finally {
      this.embedDraining = false;
    }
  }

  /**
   * 记录一次自动补向量的失败（只留最近 5 条，避免无界增长）。
   * @param {string} message - 错误文本
   */
  noteEmbedError(message) {
    this.embedErrors.push(message);
    if (this.embedErrors.length > 5) this.embedErrors.shift();
    this.ctx.logger?.warn?.(`${PLUGIN_ID}: 自动补向量失败：${message}`);
  }

  /**
   * 造一个 Phase 2 需要的 `LlmClient`（只有 `chat()`）。
   *
   * 走 `ctx.llm.stream`，把流式 chunk 拼成纯文本。这里**不假设** chunk 的字段名：
   * 任何带字符串 `text` / `delta` / `content` 的 chunk 都会累加，并记录出现过的
   * `kind` 集合 —— 由 `/llm-probe` 把它暴露出来，用测量代替猜测。
   *
   * @returns {{chat: (req: {messages: unknown[], temperature?: number, maxTokens?: number, sink?: object}) => Promise<string>}} LLM 客户端
   */
  createLlmClient() {
    const ctx = this.ctx;
    const llm = ctx.get('llm');
    if (llm === undefined) throw new Error('llm 服务未挂载');
    const cfg = this.resolvedConfig().llm;
    // 拼装逻辑抽在 `src/host/llm.js` 里，由 `test/llm.test.js` 的 23 个用例覆盖 ——
    // 「只取 text-delta、丢弃 reasoning-delta」那条护栏必须有自动化测试守着，
    // 否则一旦有人「顺手简化」成拼所有 chunk，抽取会静默变成永远 0 条事实。
    return createLlmClientFrom(llm, {
      provider: cfg.provider,
      model: cfg.model,
      fallbackSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
    });
  }

  // ── Phase 2：抽取 / 审阅门 / 冲突 ───────────────────────────────────────────

  /**
   * 抽取式写入：调 LLM 抽事实，**只落待审批次，绝不入库**。
   *
   * `excludeTransient`（默认 true）与自主捕获同一道确定性三分类（`src/host/transient.js`）：
   * `durable` 与 `uncertain` 都进待审区（本方法本来就只进待审区），只有被判 `transient` 的
   * 会话 / 工具 / 进度态条不落待审区，只回报计数（`droppedTransient` / `deferredToReview`）。
   *
   * @param {{text: string, focused?: boolean, excludeTransient?: boolean}} input - 参数
   * @returns {Promise<object>} 批次信息
   */
  async extractMemory({ text, focused = false, excludeTransient = true }) {
    const store = this.ensureStore();
    const cfg = this.resolvedConfig();
    const body = String(text ?? '').trim();
    if (body === '') return { ok: false, error: '内容为空' };
    const result = await stageExtraction({
      store,
      llm: this.createLlmClient(),
      text: body,
      focused: focused === true,
      model: cfg.llm.model ?? null,
      maxTokens: cfg.llm.extractMaxTokens,
      excludeTransient: excludeTransient !== false,
    });
    return {
      ...result,
      focused: focused === true,
      droppedTransient: Array.isArray(result.dropped) ? result.dropped.length : 0,
      deferredToReview: Array.isArray(result.deferred) ? result.deferred.length : 0,
    };
  }

  /** 待审批次列表。 */
  pendingBatches() {
    const store = this.ensureStore();
    try {
      return { ok: true, batches: store.listBatches({ state: 'open' }) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 对一个待审批次逐条查冲突：每条事实取相似记忆 top-k，再让 LLM 批量判关系。
   * @param {{batchId: string, topK?: number}} input - 参数
   * @returns {Promise<object>} 冲突报告
   */
  async analyzeBatch({ batchId, topK = 3 }) {
    const store = this.ensureStore();
    const batch = store.getBatch(String(batchId ?? ''));
    if (batch === null) return { ok: false, error: `没有这个批次：${batchId}` };
    const llm = this.createLlmClient();
    const items = [];
    for (const item of batch.items) {
      if (item.state !== 'pending') continue;
      let candidates = [];
      try {
        const found = await this.searchText({ query: item.text, limit: Math.max(1, topK) });
        candidates = found.items.map((hit) => ({ id: hit.id, text: hit.text ?? '', score: Number(hit.vectorScore ?? 0) }));
      } catch {
        candidates = [];
      }
      const report = await analyzeConflicts({ llm, newText: item.text, candidates });
      items.push({
        itemId: item.id,
        idx: item.idx,
        text: item.text,
        conflicts: report.items,
        error: report.error ?? null,
      });
    }
    return { ok: true, batchId: batch.id, count: items.length, items };
  }

  /**
   * 审批一个批次。人给的那些决定直接透传给 `reviewBatch`；`supersede` 由调用方显式给出。
   *
   * 两个回调都要接：新增的记忆要补向量；**被 supersede 改写的旧记忆，它的向量已被
   * `updateMemoryText` 删掉**（正文变了向量就作废），必须重新排进嵌入队列，否则
   * 语义检索会一直按旧文本的向量出结果、而增量补齐永远修不掉。
   *
   * @param {{batchId: string, keep?: number[]|null, edits?: object, actions?: object, reject?: boolean}} input - 参数
   * @returns {Promise<object>} 结果
   */
  async reviewPending({ batchId, keep = null, edits = {}, actions = {}, reject = false }) {
    const store = this.ensureStore();
    const id = String(batchId ?? '');
    if (reject === true) return rejectBatch({ store, batchId: id });
    return reviewBatch({
      store,
      batchId: id,
      keep,
      edits,
      actions,
      scope: this.resolvedConfig().scope,
      onAdded: (memoryId) => this.scheduleEmbed(memoryId),
      onUpdated: (memoryId) => this.scheduleEmbed(memoryId),
    });
  }

  /**
   * 导出整个记忆库为可迁移的包（`manifest.json` + `memories.jsonl` + `readable.md` + `RESTORE.md`）。
   *
   * scope 的三种写法由 `resolveExportScope` 归一（**省略 ≠ 显式 null**）：
   *   - 省略 `scope` → `config.scope`（默认作用域）；
   *   - `scope: null` 或 `allScopes: true` → `null`，即**全部 scope**（`exportPack` 的约定）。
   * 以前这里是 `scope ?? cfg.scope`，显式 null 会被一起吃掉，全库导出因此到不了 `exportPack`。
   *
   * @param {{dir?: string|null, scope?: string|null, allScopes?: boolean}} [input] 参数
   * @returns {object} 导出结果（含绝对路径）
   */
  exportMemory(input = {}) {
    const store = this.ensureStore();
    const cfg = this.resolvedConfig();
    const dir = input.dir ?? null;
    const scope = resolveExportScope({ scope: input.scope, allScopes: input.allScopes === true }, cfg.scope);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const target = dir ?? join(this.dataDir, '导出包', `memory-export-${stamp}`);
    return exportPack({
      store,
      dir: target,
      scope,
      embedding: { provider: cfg.embedding.provider, model: cfg.embedding.model, dims: cfg.embedding.dimensions },
    });
  }

  /**
   * 从导出包导入。按全文判重（可反复跑），支持 dryRun 演练。
   * @param {{dir: string, dryRun?: boolean}} input - 参数
   * @returns {Promise<object>} 导入统计
   */
  async importMemory({ dir, dryRun = false } = {}) {
    const store = this.ensureStore();
    const target = String(dir ?? '');
    if (target === '') return { ok: false, error: '缺少 dir' };
    return importPack({
      store,
      dir: target,
      dryRun: dryRun === true,
      scope: this.resolvedConfig().scope,
      sourceLabel: basename(target),
      onAdded: (id) => this.scheduleEmbed(id),
    });
  }

  // ── 两个行为计数器（read / tidy）──────────────────────────────────────────────
  //
  // 口径（用户 2026-10-07 拍板的四条，别改）：
  //   1. read：只在 `memory_search` 命中的每一条 + `memory_get` 取单条时 +1；列表 / 面板浏览不算；
  //   2. tidy：一条记忆**被抽进仓管的一组**（种子或被 embedding 召回当邻居）+1；同一轮同一 id 只算一次；
  //   3. 仓管产出 / 替换出的**新记忆**：tidy 初始 = 1（字面：初始 0 再 +1）；
  //   4. 衰减：全库 ×`score.weeklyDecay`（默认 0.98）/周，**懒触发**、按整周数连乘、**比例严格不变**。
  //
  // ⚠️ `searchText()` 是三条路径共享的（工具 / 仓管分组召回 / 冲突分析），所以**加分不放进去**：
  // 只有面向工具的这一层（`recordReads`）才动 read，`recordTidy` 只由仓管 run 调。

  /**
   * 懒衰减：距上次衰减 **≥1 整周** 时，把两个计分器全库同乘 `factor ** weeks`。
   *
   * 三条不变量：
   * 1. **首次启用不乘**：没有 `score.decayedAt` 时只写入当前时间，历史数据一分不减；
   * 2. **只推进整周**：时间戳 += `weeks * 7d`（**不是 `now`**），否则每次触发都会吃掉不足一周的余数；
   * 3. **幂等**：未到期直接返回，重复调用不会二次衰减。
   *
   * @returns {{ok: boolean, initialized?: boolean, decayed: boolean, weeks: number, factor?: number,
   *   applied?: number, decayedAt?: string, nextDecayAt?: string, note?: string, error?: string}} 结果
   */
  maybeDecayScores() {
    try {
      const store = this.ensureStore();
      const factor = Number(this.resolvedConfig().score?.weeklyDecay);
      const nowMs = new Date(store.now()).getTime();
      const sinceRaw = store.getSetting(SCORE_DECAYED_AT_KEY, null);
      if (sinceRaw == null || String(sinceRaw).trim() === '') {
        // 首次启用：只记下起点，**不乘**（否则等于拿一个说不清的时刻把历史数据砍一刀）。
        store.setSetting(SCORE_DECAYED_AT_KEY, new Date(nowMs).toISOString());
        return { ok: true, initialized: true, decayed: false, weeks: 0, factor };
      }
      const sinceMs = Date.parse(String(sinceRaw));
      if (!Number.isFinite(sinceMs)) {
        store.setSetting(SCORE_DECAYED_AT_KEY, new Date(nowMs).toISOString());
        return {
          ok: true,
          initialized: true,
          decayed: false,
          weeks: 0,
          factor,
          note: `score.decayedAt 不是合法时间（${sinceRaw}），已重置为当前时间`,
        };
      }

      const weeks = Math.floor((nowMs - sinceMs) / WEEK_MS);
      if (weeks < 1) {
        return {
          ok: true,
          decayed: false,
          weeks: 0,
          factor,
          decayedAt: new Date(sinceMs).toISOString(),
          nextDecayAt: new Date(sinceMs + WEEK_MS).toISOString(),
        };
      }

      const applied = factor ** weeks;
      // 时间戳只推进**整周**：不足一周的余数留到下次，绝不因为「顺手对齐到 now」而漏衰减。
      const decayedAtMs = sinceMs + weeks * WEEK_MS;
      // 乘系数与推进时间戳必须同生共死：只成一半的话，要么白丢一周衰减，要么下次重复乘。
      withTransaction(store.db, () => {
        store.decayScores(applied);
        store.setSetting(SCORE_DECAYED_AT_KEY, new Date(decayedAtMs).toISOString());
      });
      return {
        ok: true,
        decayed: true,
        weeks,
        factor,
        applied,
        decayedAt: new Date(decayedAtMs).toISOString(),
        nextDecayAt: new Date(decayedAtMs + WEEK_MS).toISOString(),
      };
    } catch (error) {
      return { ok: false, decayed: false, weeks: 0, error: describeError(error) };
    }
  }

  /**
   * 记一次「被 agent 正常读取」：命中 id 各 +1 read（一次批量 UPDATE）。
   *
   * 计分是**旁路**：SQL 失败只记日志并返回 0，绝不让它把检索结果打回去。
   *
   * @param {unknown} ids 记忆 id 数组
   * @returns {number} 实际加分的行数
   */
  recordReads(ids) {
    this.maybeDecayScores();
    try {
      return this.ensureStore().bumpReadScores(ids);
    } catch (error) {
      this.ctx.logger?.warn?.(`${PLUGIN_ID}: 读取计分失败（不影响检索结果）：${describeError(error)}`);
      return 0;
    }
  }

  /**
   * 记一次「被仓管抽进一组」：id 各 +1 tidy（一次批量 UPDATE）。
   *
   * @param {unknown} ids 记忆 id 数组
   * @returns {number} 实际加分的行数
   */
  recordTidy(ids) {
    this.maybeDecayScores();
    try {
      return this.ensureStore().bumpTidyScores(ids);
    } catch (error) {
      this.ctx.logger?.warn?.(`${PLUGIN_ID}: 整理计分失败（不影响出单）：${describeError(error)}`);
      return 0;
    }
  }

  /**
   * 计分整体状态：衰减参数 + 读取/整理的聚合与 Top-N（`memory_stats` 的 `scores` 字段）。
   *
   * @param {{top?: number}} [options] Top-N 的 N（默认 5）
   * @returns {object} 计分状态
   */
  scoreStats({ top = 5 } = {}) {
    const store = this.ensureStore();
    const factor = Number(this.resolvedConfig().score?.weeklyDecay);
    const decayedAt = store.getSetting(SCORE_DECAYED_AT_KEY, null);
    const sinceMs = decayedAt == null ? Number.NaN : Date.parse(String(decayedAt));
    return {
      decayFactor: factor,
      decayedAt: decayedAt == null ? null : String(decayedAt),
      nextDecayAt: Number.isFinite(sinceMs) ? new Date(sinceMs + WEEK_MS).toISOString() : null,
      ...store.scoreStats({ top }),
    };
  }

  /** 仓储概况。 */
  storeStats() {
    try {
      const store = this.ensureStore();
      const cfg = this.resolvedConfig();
      const space = this.embeddingSpace(cfg);
      const total = store.countMemories({ includeDeleted: false });
      const vectors = store.vectorStats();
      const inSpace = store.countVectors(space.key);
      const missing = store.countMissingVectors(space.key);
      return {
        ok: true,
        memories: total,
        /** 按 scope 分组的条数（写入按 config.scope，检索是全局的） */
        scopes: store.countByScope(),
        /** 全部空间加起来的向量条数 */
        vectors: vectors.count,
        /** 已保留的向量空间（每个空间一套，切换模型不会互相覆盖） */
        spaces: vectors.spaces,
        /** 当前配置对应的空间，`missing` = 还要补多少条才齐 */
        activeSpace: { ...space, vectors: inSpace, missing },
        /** 上次实际写入向量时记下的空间（诊断用；正常应与 activeSpace.key 一致） */
        lastWriterSpace: store.getActiveSpace(),
        /** 当前生效的嵌入档案名（`config` = patch 里那份） */
        profile: this.profilesState().active ?? PATCH_PROFILE_NAME,
        /** v1→v2 向量表升级的结果（没升级过就是 `{migrated:false,...}`） */
        migration: this.migration ?? null,
        /** 机器可读的能力自描述：一次调用就知道这套工具能干什么、上限是多少 */
        capabilities: this.capabilities(),
        /** 跟随 agent 运行的自主捕获现状（开关、模式、最近几次捕获、错误） */
        capture: this.captureStatus(),
        /** 仓管现状（配置、指向、任务进度、留下的痕迹） */
        keeper: this.keeperStatus(),
        /** 两个行为计数器的聚合与衰减时间（面板概览「记忆计分」那一行读它） */
        scores: this.scoreStats(),
        /** 正在等待自动补向量的条数（0 表示检索完全可用） */
        embedQueued: this.embedPending.size,
        ...(this.embedErrors.length > 0 ? { embedErrors: this.embedErrors } : {}),
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 能力自描述（原型 `/v1/capabilities` 的等价物）。
   *
   * 工具 schema 本身是静态的；这里补上**动态**的那部分：条数、写入模式、上限，
   * 以及备份 / 多空间 / 真删这些能力在不在。让 agent 一次调用就能决定怎么用它。
   *
   * @returns {object} 能力清单
   */
  capabilities() {
    const cfg = this.resolvedConfig();
    let tools = null;
    try {
      const schemas = this.ctx.get('tools')?.schemas?.();
      if (Array.isArray(schemas)) {
        tools = schemas.map((entry) => entry?.name).filter((name) => typeof name === 'string' && name.startsWith('memory_'));
      }
    } catch {
      /* 拿不到工具目录不影响能力自描述 */
    }
    return {
      writeModes: ['raw（原文直存，秒级）', 'extract（LLM 抽事实 → 落待审区，人审后入库）'],
      writeOrder: 'raw 默认；长文用 extract，先 memory_analyze 查冲突再 memory_review 批准',
      search: { lines: ['keyword(trigram+LIKE)', 'vector(cosine)', 'RRF'], defaultLimit: cfg.search.defaultLimit, maxLimit: cfg.search.maxLimit },
      backfillModes: ['missing（只补缺的）', 'all（强制全量重算）'],
      embeddingProfiles: true,
      multiSpace: true,
      backup: true,
      hardDelete: true,
      exportImport: true,
      /** 跟随 agent 运行的自主捕获 + 待审批次由 agent 审阅 */
      autoCapture: true,
      agentReview: cfg.review?.agent === true,
      /** 仓管：自带的本地/局域网 LLM 通道 + 全库二次加工（研磨 / 消化 / 回滚） */
      keeper: true,
      /** 两个行为计数器（read / tidy）+ 每周防膨胀衰减 */
      scores: true,
      limits: { searchMaxLimit: cfg.search.maxLimit, extractMaxTokens: cfg.llm.extractMaxTokens },
      ...(tools === null ? {} : { tools }),
    };
  }

  /**
   * LLM 预检：真打一次最小的生成请求，回答「宿主这套模型现在能不能用」。
   *
   * 为什么需要：抽取 / 冲突判定都依赖宿主模型，而它的失败模式很隐蔽
   * （能连上、却只吐 reasoning-delta → 抽出 0 条）。原型的 `/v1/health` 有 `llm.available`，
   * 这里做成**按需探测**（`memory_stats({probe:true})` 才打），免得每次统计都花一次调用。
   *
   * @param {{maxTokens?: number}} [input] 参数
   * @returns {Promise<object>} 探测结果
   */
  async llmProbe({ maxTokens = 256 } = {}) {
    const started = Date.now();
    try {
      const cfg = this.resolvedConfig();
      const client = this.createLlmClient();
      const text = await client.chat({
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        temperature: 0,
        maxTokens: Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Math.trunc(Number(maxTokens)) : 256,
      });
      const answer = String(text ?? '');
      return {
        ok: answer.length > 0,
        provider: cfg.llm.provider ?? null,
        model: cfg.llm.model ?? null,
        textLength: answer.length,
        text: answer.slice(0, 40),
        elapsedMs: Date.now() - started,
        ...(answer.length === 0
          ? { warning: '模型没吐出任何 text-delta（只有 reasoning-delta？）：抽取会得到 0 条，需调大 llm.extractMaxTokens' }
          : {}),
      };
    } catch (error) {
      return { ok: false, error: describeError(error), elapsedMs: Date.now() - started };
    }
  }

  // ── 跟随 agent 运行的自主捕获 ─────────────────────────────────────────────────
  //
  // 归属规则（用户 2026-10-06 明确）：
  // - **连入记忆系统的那个 agent 自己**抽出来的记忆 → 免审，直接入库；
  // - 其他来源（子代理 / 被委派的会话）→ 进待审区，由这个 agent 审阅（`review.agent`）。
  // 这里只做编排：抽取在 `runCapture`，审阅在 `agentReviewBatch`，纯逻辑在 `src/host/capture.js`。

  /**
   * 把**主会话里人说的话**喂给读取侧引擎（Layer 1 的查询词 + 话题段判定）。
   *
   * 三个必须的判据（2026-10-08 真机踩坑后补齐）：
   *   1. `user/message` 是个**共用信封**，插件注入 / 工作区指令 / compaction / 工具回灌都走它
   *      → 只认 `data.source.kind === 'user'`（宿主的渲染层用的是同一个判据）；
   *   2. 正文在 **`event.data`** 里，不在 `event` 上（这个取错 = 永远拿到空串，静默失效）；
   *   3. 只吃主会话（子代理 / 委派会话属于别的活，拿它们的正文当查询词会把无关记忆注过来）。
   *
   * 全程同步、绝不抛：这段跑在会话事件链上。
   *
   * @param {any} session 会话。
   * @param {{type?: string, data?: any}} event 会话事件。
   * @returns {void}
   */
  feedRecall(session, event) {
    try {
      if (String(event?.type ?? '') !== 'user/message') return;
      if (!isHumanMessage(event)) {
        this.recallFeed.notHuman += 1;
        return;
      }
      if (isForeignSession(session)) {
        this.recallFeed.foreign += 1;
        return;
      }
      if (this.resolvedConfig()?.recall?.enabled === false) {
        this.recallFeed.disabled += 1;
        return;
      }
      const engine = this.ensureRecall();
      if (engine === null) {
        this.recallFeed.noEngine += 1;
        return;
      }
      const text = messageText(event?.data);
      if (text === '') return;
      engine.noteUserMessage(String(session?.id ?? ''), text);
      this.recallFeed.fed += 1;
      this.recallFeed.lastAt = Date.now();
      this.recallFeed.lastChars = text.length;
    } catch (error) {
      this.recallFeed.errors.push(describeError(error));
      if (this.recallFeed.errors.length > 5) this.recallFeed.errors.shift();
    }
  }

  /**
   * `session/event` 监听器入口。
   *
   * 同步返回、绝不做 await：这是落库后的 fire-and-forget 事件，阻塞它会拖慢整个会话。
   *
   * @param {any} session 会话（读 `id` 与 `header`）
   * @param {{type?: string, data?: any}} event 会话事件
   * @returns {void}
   */
  onSessionEvent(session, event) {
    try {
      // 读取侧注入先吃这一步 —— 它与捕获**互不依赖**：`capture.enabled=false` 时照样要注入记忆。
      this.feedRecall(session, event);
      const cfg = this.resolvedConfig();
      const capture = cfg.capture;
      if (capture?.enabled !== true) return;
      const sessionId = String(session?.id ?? '');
      if (sessionId === '') return;

      let buffer = this.buffers.get(sessionId);
      if (buffer == null) {
        // 缓冲只是「还没抽的转录」：丢最老的顶多漏抽一轮，不会丢任何已入库数据。
        if (this.buffers.size >= 32) {
          const oldest = this.buffers.keys().next().value;
          if (oldest !== undefined) this.buffers.delete(oldest);
        }
        buffer = new ConversationBuffer({ maxChars: capture.maxChars });
        this.buffers.set(sessionId, buffer);
      }

      const { userChars } = buffer.note(event);
      if (String(event?.type ?? '') !== 'turn/end') return;

      const verdict = shouldCapture({
        userChars,
        minChars: capture.minChars,
        lastCaptureAt: this.capture.lastAt,
        cooldownMs: capture.cooldownMs,
      });
      if (verdict.capture !== true) {
        this.capture.skipped += 1;
        return;
      }

      const slice = buffer.take();
      if (slice.text.trim() === '') return;
      this.capture.lastAt = Date.now();
      void this.runCapture({
        sessionId,
        turn: Number(event?.data?.turn ?? 0) || null,
        foreign: isForeignSession(session),
        text: slice.text,
        cfg,
      }).catch((error) => this.noteCaptureError(describeError(error)));
    } catch (error) {
      this.noteCaptureError(describeError(error));
    }
  }

  /**
   * 记一条捕获失败（只留最近 5 条，供面板/工具查看）。
   *
   * @param {string} message 错误文本
   * @returns {void}
   */
  noteCaptureError(message) {
    this.capture.errors.push(String(message));
    if (this.capture.errors.length > 5) this.capture.errors.shift();
    this.ctx.logger?.warn?.(`${PLUGIN_ID}: 自主捕获失败：${message}`);
  }

  /**
   * 抽一次转录并入库。
   *
   * @param {{sessionId: string, turn?: number|null, foreign?: boolean, text: string, cfg?: object}} input 参数
   * @returns {Promise<object>} 本次捕获的结果（也进 `captureStatus().recentRuns`）
   */
  async runCapture({ sessionId, turn = null, foreign = false, text, cfg = this.resolvedConfig() }) {
    const capture = cfg.capture ?? {};
    const store = this.ensureStore();
    const body = String(text ?? '').trim();
    if (body === '') return null;

    const started = Date.now();
    // 第二道闸的开关（默认开）：三分类在 `extractFacts()` / `stageExtraction()` 里执行 ——
    // 两条捕获路径与手工 `memory_extract` 共用同一份判据（`src/host/transient.js`）。
    // `false` = 三分类全部保留（等价于关闭过滤：一条不丢、全按原路径走）。
    const excludeTransient = capture.dropTransient !== false;
    const job = {
      at: new Date().toISOString(),
      sessionId: String(sessionId).slice(0, 8),
      turn,
      foreign: foreign === true,
      mode: foreign === true || capture.mode === 'pending' ? 'pending' : 'direct',
      /** 过闸后**留在手上的**条数（durable + uncertain；不含被判 transient 丢掉的） */
      facts: 0,
      added: 0,
      skipped: 0,
      /** 被判定为临时（会话 / 工具 / 进度态）、**没写库 / 没入待审区**的条数 */
      droppedTransient: 0,
      /** 被判「拿不准」、**没丢但也没直存**、已并进待审区的条数（2026-10-07 三分类新增） */
      deferredToReview: 0,
      batchId: null,
      reviewed: null,
      elapsedMs: 0,
      error: null,
    };

    try {
      const llm = this.createLlmClient();
      if (job.mode === 'pending') {
        const staged = await stageExtraction({
          store,
          llm,
          text: body,
          focused: capture.focused === true,
          model: cfg.llm.model ?? null,
          maxTokens: cfg.llm.extractMaxTokens,
          excludeTransient,
        });
        job.droppedTransient = Array.isArray(staged.dropped) ? staged.dropped.length : 0;
        job.deferredToReview = Array.isArray(staged.deferred) ? staged.deferred.length : 0;
        if (staged.ok !== true) {
          // 「抽出来的全被判临时」不是失败（与 direct 路径口径一致：没有可进待审区的内容而已），
          // 只有真错误（LLM 不可用 / 建批次失败）才记进 capture.errors。
          if (staged.allTransient !== true) job.error = staged.error ?? '抽取失败';
        } else {
          job.batchId = staged.batchId;
          job.facts = staged.count;
          // 其他来源进待审区后，由「这个 agent」自动审阅（可关：review.agent=false 就留给人）。
          if (cfg.review?.agent === true) job.reviewed = await this.agentReviewBatch(staged.batchId, { topK: cfg.review.topK });
        }
      } else {
        // 连入的 agent 自己：免审，**durable 直存**；uncertain 不丢也不直存，并成一个待审批次。
        const extracted = await extractFacts({
          llm,
          text: body,
          focused: capture.focused === true,
          maxTokens: cfg.llm.extractMaxTokens,
          excludeTransient,
        });
        job.droppedTransient = Array.isArray(extracted.dropped) ? extracted.dropped.length : 0;
        const deferred = Array.isArray(extracted.deferred) ? extracted.deferred : [];
        job.deferredToReview = deferred.length;
        if (extracted.ok !== true) {
          job.error = extracted.error ?? '抽取失败';
        } else {
          // `facts` = 过闸后留在手上的（durable + uncertain），`added` 才是真直存的。
          job.facts = extracted.facts.length;
          const stamp = new Date().toISOString();
          for (const fact of extracted.durable) {
            const created = store.addMemory({
              text: fact,
              scope: cfg.scope,
              source: '自主捕获',
              kind: 'auto',
              meta: { capturedFrom: String(sessionId), turn, at: stamp },
            });
            if (created.created === true) {
              job.added += 1;
              this.scheduleEmbed(created.id);
            } else {
              job.skipped += 1;
            }
          }
          // uncertain → 待审区（**只建批次、不自动落库**）：拿不准的条交给人 / 后续审阅，
          // 绝不因为「拿不准」就静默丢掉，也绝不因为「免审」就直接入库。
          if (deferred.length > 0) {
            const batch = store.createBatch({
              model: cfg.llm.model ?? null,
              sourceText: body,
              focused: capture.focused === true,
              items: deferred.map((entry) => entry.text),
            });
            job.batchId = batch.id;
          }
        }
      }
    } catch (error) {
      job.error = describeError(error);
    }

    job.elapsedMs = Date.now() - started;
    this.capture.runs.unshift(job);
    if (this.capture.runs.length > 8) this.capture.runs.length = 8;
    if (job.error !== null) this.noteCaptureError(job.error);
    return job;
  }

  /**
   * 「该 agent 的审阅」：用同一套冲突判定（supersede / duplicate / coexist / unrelated + 四条护栏）
   * 自动审一个待审批次，然后按判定执行。
   *
   * 保守之处：`supersede` **只取最相似的那一条**目标 —— 自动化改写要控制爆炸半径；
   * 其余关系（coexist / unrelated）正常入库，`duplicate` 跳过，全都有 `history` 留痕。
   *
   * @param {string} batchId 批次 id
   * @param {{topK?: number}} [options] 每条的候选条数
   * @returns {Promise<object>} 审阅结果
   */
  async agentReviewBatch(batchId, { topK = 3 } = {}) {
    const id = String(batchId ?? '');
    if (id === '') return { ok: false, error: '缺少 batchId' };
    const report = await this.analyzeBatch({ batchId: id, topK });
    if (report.ok !== true) return { ok: false, error: report.error ?? '冲突分析失败' };

    /** @type {Record<string, object>} */
    const actions = {};
    for (const entry of Array.isArray(report.items) ? report.items : []) {
      const conflicts = Array.isArray(entry?.conflicts) ? entry.conflicts : [];
      const supersedes = conflicts
        .filter((item) => item?.relation === 'supersede' && item?.id != null)
        .sort((a, b) => Number(b?.score ?? 0) - Number(a?.score ?? 0));
      if (supersedes.length > 0) actions[entry.idx] = { supersede: [String(supersedes[0].id)], relation: 'supersede' };
      else if (conflicts.some((item) => item?.relation === 'duplicate')) actions[entry.idx] = { duplicate: true, relation: 'duplicate' };
    }

    const result = await this.reviewPending({ batchId: id, actions });
    return { ...result, analyzed: Number(report.count ?? 0), applied: Object.keys(actions).length };
  }

  /**
   * 自主捕获的现状（`memory_stats` 与面板用）。
   *
   * @returns {object} 状态
   */
  captureStatus() {
    let cfg = null;
    try {
      cfg = this.resolvedConfig();
    } catch {
      cfg = null;
    }
    const capture = cfg?.capture ?? null;
    const state = this.capture ?? { subscribed: false, error: null, skipped: 0, runs: [], errors: [] };
    const runs = Array.isArray(state.runs) ? state.runs : [];
    return {
      enabled: capture?.enabled === true,
      mode: capture?.mode ?? null,
      focused: capture?.focused === true,
      minChars: capture?.minChars ?? null,
      maxChars: capture?.maxChars ?? null,
      cooldownMs: capture?.cooldownMs ?? null,
      // 第二道闸：开关 + 最近几次运行里的三分类计数（单次看 `lastRun.*`）
      // - `droppedTransient`：判临时丢掉的总条数；
      // - `deferredToReview`：判「拿不准」、并进待审区的总条数（2026-10-07 三分类新增）。
      dropTransient: capture?.dropTransient !== false,
      droppedTransient: runs.reduce((sum, run) => sum + Number(run?.droppedTransient ?? 0), 0),
      deferredToReview: runs.reduce((sum, run) => sum + Number(run?.deferredToReview ?? 0), 0),
      subscribed: state.subscribed === true,
      ...(state.error == null ? {} : { error: state.error }),
      sessions: this.buffers?.size ?? 0,
      skipped: Number(state.skipped ?? 0),
      reviewAgent: cfg?.review?.agent === true,
      lastRun: runs[0] ?? null,
      recentRuns: runs.slice(0, 5),
      ...(Array.isArray(state.errors) && state.errors.length > 0 ? { errors: state.errors.slice(-3) } : {}),
    };
  }

  // ── 仓管（keeper）：插件自带的本地 / 局域网 LLM + 全库二次加工 ─────────────────────
  //
  // 需求原话：「内置一个 LLM，专门用于接入 Local LLM … 成为记忆系统的『仓管』，
  // 负责对已录入的所有记忆进行二次消化、对已录入但大段的记忆进行无损研磨」。
  //
  // **范式升级（用户 2026-10-07 拍板）：仓管不再直接改库，改成「先出变更单 → 独立待审区
  // → 审阅通过才落库」**。三条不变量：
  //   1. 出单阶段（`startKeeperRun`）**一个字都不写记忆库**，只写 `keeper_plans` 表 ——
  //      所以「跑一轮仓管」是绝对安全的，最坏情况只是多了一张 open 的单；
  //   2. 落库只发生在 `reviewKeeperPlan()`：人整单通过、驳回，或只勾选其中几条；
  //   3. 证据分两条路（用户 2026-10-07 的最终语义 + 同日追加的「每块自足」）：
  //      `split` 跑**①每块自足 ②不丢内容 ③不新增信息**（`anchorsOf()` / `selfContained()` /
  //      `addedTerms()`），**旧的「逐字无损 / 子序列 ≥98%」承诺已作废**（为自足而重复原文主语词
  //      天然不是子序列）；真的走了确定性切分时 op 带 `fallback: true`。`replace` / `merge`
  //      **允许**缩写、去冗余、优化语序、同义换词、合并、改错别字，**唯一不变量是事实要点不许丢**
  //      （人物 / 时间 / 决定 / 数值 / 引号里的原话 / emoji 标签）、不许新增、不许把不确定写成确定。
  //      `factCheck()` / `addedTerms()` / `selfContained()` 只产证据（丢数字 / 消失的片段 / 压缩比 /
  //      缺主语 / 新增片段），**不改判、不自动拒绝**，措辞中性 —— 同义改写与语序优化是正常且允许的，
  //      不叫「违规」。
  //
  //   4. **统一修改语义（用户 2026-10-07 拍板）**：「修改记忆 = 依照原记忆编写修改后的记忆 →
  //      新旧记忆展示在待审区 → 过审后删除原记忆、录入新记忆」。所以修改类 op 只有 `replace`
  //      一个类型（旧的 `rewrite` 一律按 `replace` 解析 / 落库），落库时 `addMemory` 出**新 id**、
  //      原条走 `softDeleteMemory`（软删 = 系统默认的「删除」，行仍在、可恢复）+ 清原条向量，
  //      并把 `meta.replaces` / `meta.replacedAt` / `meta.model` 记到新条上；手工入口是
  //      `proposeKeeperReplace()`（工具 `memory_keeper {action:'propose'}`），它**只出单、不落库**。
  //
  // 旧的直接写入路径（`grindOne` / `dedupePass`）已删除；`revertKeeper()` 保留，
  // 它现在处理三类痕迹：**历史遗留**的直改痕迹、新范式 `merge` 落库时写在保留条上的
  // `meta.merged`（被并掉的条靠它才放得回来）、以及新范式 `replace` 落库时写在新记忆上的
  // `meta.replaces`（新记忆真删 + 原记忆放回来）。所以 `reviewKeeperPlan()` 的 merge 分支
  // 必须写这个 meta —— 漏写就等于「软删了却回滚不到」（2026-10-07 本轮修掉的实测缺口）。

  /**
   * 解析「当前生效」的仓管配置（`createKeeperClient()` 与 `keeperStatus()` 共用同一套）。
   *
   * 规则与 `resolvedConfig()` 的 keeper 那一块完全一致：生效档案是内置 `config` → patch +
   * `keeper.overrides`；是具名档案 → patch + `profileToKeeper(该档案)`（`overrides` 不参与）。
   *
   * ⚠️ **必须先 `ensureStore()`**：档案存在库里（`settings.keeper.profiles` / `keeper.active`），
   * 库还没开时 `keeperProfilesState()` 恒回空、`activeKeeperProfile()` 恒回 `null`，
   * 于是悄悄回落到 patch —— 实测现象是 `keeperStatus()` 里 `active:'线上'` 而
   * `configured:false / provider:'ollama' / model:null` 自相矛盾（面板那张卡显示「未配置」）。
   * 根因是旧实现先 `resolvedConfig()`、后 `ensureStore()`，顺序反了。
   *
   * @returns {ReturnType<typeof normalizeConfig>} 生效的完整配置（含 `keeper` 块）
   */
  resolvedKeeperConfig() {
    this.ensureStore();
    const base = this.config ?? {};
    const profile = this.activeKeeperProfile();
    const keeper = profile === null ? this.keeperOverrides() : profileToKeeper(profile);
    return normalizeConfig({ ...base, keeper: { ...(base.keeper ?? {}), ...keeper } });
  }

  /**
   * 造仓管 LLM 客户端（配置不完整时抛错，错误文本直接给用户看）。
   *
   * @param {object} [cfg] 已解析配置（默认现取「当前生效档案」那一份，见 `resolvedKeeperConfig()`）
   * @returns {Promise<object>} `createLocalLlm` 的客户端
   */
  async createKeeperClient(cfg = this.resolvedKeeperConfig()) {
    const keeper = cfg?.keeper ?? {};
    if (typeof keeper.model !== 'string' || keeper.model.trim() === '') {
      throw new Error('仓管未配置模型：请在配置里写 keeper.model（以及 keeper.ollamaUrl 或 keeper.baseUrl）');
    }
    // ⚠ `resolveKey()` 回的是**信封** `{source, value, described}`，不是裸字符串。把信封直接塞进
    // `Bearer` 头会变成 "Bearer [object Object]"，线上端点只会回 401 invalid_api_key ——
    // 这个坑实际踩过：**同一把凭据嵌入是通的、仓管 401**，差别就在这一处。必须取 `.value`。
    const resolved = keeper.provider === 'openai' ? await this.resolveKey(keeper.apiKeyRef) : null;
    if (keeper.provider === 'openai' && (resolved?.value == null || String(resolved.value) === '')) {
      throw new Error(
        `仓管：取不到密钥（apiKeyRef=${keeper.apiKeyRef == null || keeper.apiKeyRef === '' ? '(空)' : keeper.apiKeyRef}）` +
          ' —— 在面板「设置」里给该档案写入密钥，或把 provider 换成 ollama',
      );
    }
    return createLocalLlm(keeper, { fetchImpl: this.fetchImpl, apiKey: resolved?.value ?? null });
  }

  /**
   * 仓管现状：配置是否齐、指向哪里、**生效的是哪个档案**、任务跑到哪一步、留下的痕迹有多少。
   *
   * @returns {object} 状态
   */
  keeperStatus() {
    let cfg = null;
    try {
      // 顶层这些字段必须与真正会跑的那份配置一致（生效档案），所以走 resolvedKeeperConfig()：
      // 它先开库、再按生效档案解析 —— 否则库里明明 active=「线上」，这里却报 patch 的
      // configured:false / provider:'ollama' / model:null，面板那张卡会显示「未配置」。
      cfg = this.resolvedKeeperConfig();
    } catch {
      cfg = null;
    }
    const keeper = cfg?.keeper ?? null;
    const endpoint =
      keeper == null
        ? null
        : keeper.provider === 'ollama'
          ? String(keeper.ollamaUrl ?? '')
          : String(keeper.baseUrl ?? '');
    const configured = keeper != null && typeof keeper.model === 'string' && keeper.model.trim() !== '' && endpoint !== '';
    // 待审的变更单数：新范式下「仓管跑完了没落库」的东西都在这张表里。
    // ⚠️ 这里**只数条数**（`countKeeperPlans`）—— 面板跑一轮期间每 2 秒调一次 `keeperStatus()`，
    // 把整表读出来再逐张 parse ops 是纯浪费。
    let openPlans = null;
    try {
      openPlans = this.ensureStore().countKeeperPlans({ state: 'open' });
    } catch {
      openPlans = null;
    }
    // 副仓管：某一组整理失败、又没被接手模型救回来的组数（0 = 队列是空的）。
    let openHandoffs = null;
    try {
      openHandoffs = this.ensureStore().countOpenHandoffs();
    } catch {
      openHandoffs = null;
    }
    // 生效档案名 + 全部档案：面板与 `/state` 直接拿去渲染切换器（拿不到就如实空着，不影响其余字段）。
    let active = PATCH_PROFILE_NAME;
    let profiles = [];
    try {
      const listed = this.listKeeperProfiles();
      active = listed.active ?? PATCH_PROFILE_NAME;
      profiles = Array.isArray(listed.profiles) ? listed.profiles : [];
    } catch {
      /* 档案列表拿不到不影响现状里其余字段 */
    }
    return {
      configured,
      active,
      profiles,
      provider: keeper?.provider ?? null,
      endpoint: endpoint === '' ? null : endpoint,
      model: keeper?.model ?? null,
      // 宿主模型的 id：面板那个「副仓管模型」选择要用它当选项标签（空串 = 没显式配置，用宿主默认）。
      hostModel: String(cfg?.llm?.model ?? '').trim() || null,
      // 副仓管这个角色选的模型（用户 2026-10-07：「副审阅区使用独立的仓管角色」）：
      // `null` = 自动（本地优先 → 宿主）；面板「副仓管」页那个下拉读它、写它走 `POST /keeper-side`。
      side: this.sideKeeperChoice(),
      minChars: keeper?.minChars ?? null,
      splitChars: keeper?.splitChars ?? null,
      sampleSize: keeper?.sampleSize ?? null,
      perGroup: keeper?.perGroup ?? null,
      probe: this.keeperProbe,
      // 两条线各自的进度（互不覆盖）：主仓管的轮次 + 副仓管正在接手的那一组。
      job: this.publicKeeper(),
      sideJob: this.publicSideKeeper(),
      // ⚠️ 这里**不再回 `artifacts`**（原「现存痕迹 derived/rewritten/merged/replaced」）：
      // 它要跑 4 次全表 `LIKE` 扫（活库实测 ~5 ms / 1436 行），而**面板一次都不读**，
      // 却在跑一轮期间每 2 秒被算一遍。要看痕迹直接调 `store.listKeeperArtifacts()`。
      // ⚠️ `digestMinChars` / `dedupeThreshold` 也从这里摘了：**逻辑里一次都不用**（见工具说明）。
      openPlans,
      openHandoffs,
      ...(configured
        ? {}
        : {
            // hint 也按**生效档案**分支：具名档案没配齐时，别再让人去改 patch 的 `keeper.model`
            // （那份在 active 不是「config」时根本不参与合并，改了也白改）。
            hint:
              active === PATCH_PROFILE_NAME
                ? '在配置里写 keeper.provider / keeper.ollamaUrl（局域网 Ollama）/ keeper.model，然后「测试连接」'
                : `生效档案「${active}」还没配齐：在面板「仓管 → 档案」里给它补上 model 与端点（改完先「测试」再「启用」），或者切回 config`,
          }),
    };
  }

  /**
   * 测试仓管连通性：真打一次最小请求，把**回应与耗时**都回给用户（配错地址时立刻能看出来）。
   *
   * `name` 省略 = 测**当前生效**的档案；给了名字 = 测那个档案，**绝不改 active**
   * （配完先试一下、能用再切过去）。测 `config` 时用的是 patch + `keeper.overrides`，
   * 也就是「切回 config 之后真正会跑的那份」。
   *
   * @param {{name?: string | null}} [input] 参数
   * @returns {Promise<object>} 结果
   */
  async keeperTest({ name = null } = {}) {
    const started = Date.now();
    const target = name == null || String(name).trim() === '' ? null : String(name).trim();
    try {
      let cfg;
      if (target === null) {
        // ⚠ 同样必须先开库再解析（`resolvedKeeperConfig()` 内部会 `ensureStore()`）：
        //   否则「重启后第一件事就是测当前生效档案」会拿 patch 那份去测，报出假的「未配置模型」。
        cfg = this.resolvedKeeperConfig();
      } else if (target === PATCH_PROFILE_NAME) {
        cfg = normalizeConfig({
          ...(this.config ?? {}),
          keeper: { ...((this.config ?? {}).keeper ?? {}), ...this.keeperOverrides() },
        });
      } else {
        // 两步缺一不可：
        //  1. `listKeeperProfiles()` 有**播种副作用**（种子档案只在这里写进库），必须走一次，
        //     否则重启后第一件事就"按名字测档案"会得到莫名其妙的「没有这个档案：线上」；
        //  2. 但它的返回值是**视图对象**（`endpoint` 已归一、没有 `baseUrl`/`ollamaUrl`），
        //     直接喂 `profileToKeeper()` 会得到空对象 —— 所以还要回 `keeperProfilesState()`
        //     的**原始存储形态**里查那一条。两处都实测踩过。
        this.listKeeperProfiles();
        const { profiles } = this.keeperProfilesState();
        const profile = profiles.find((item) => item.name === target);
        if (profile == null) {
          return { ok: false, profile: target, error: `没有这个档案：${target}`, elapsedMs: Date.now() - started };
        }
        cfg = normalizeConfig({
          ...(this.config ?? {}),
          keeper: { ...((this.config ?? {}).keeper ?? {}), ...profileToKeeper(profile) },
        });
      }
      const client = await this.createKeeperClient(cfg);
      const text = await client.chat({
        messages: [
          { role: 'system', content: '你只需要回答两个字：可用' },
          { role: 'user', content: '在吗？' },
        ],
        maxTokens: 32,
      });
      const result = {
        ok: true,
        profile: target ?? (this.activeKeeperProfile()?.name ?? PATCH_PROFILE_NAME),
        provider: client.provider,
        model: client.model,
        endpoint: client.endpoint,
        elapsedMs: Date.now() - started,
        text: String(text).trim().slice(0, 60),
      };
      this.keeperProbe = { at: new Date().toISOString(), ok: true, model: client.model, endpoint: client.endpoint, elapsedMs: result.elapsedMs };
      return result;
    } catch (error) {
      const result = { ok: false, error: describeError(error), elapsedMs: Date.now() - started };
      this.keeperProbe = { at: new Date().toISOString(), ok: false, error: result.error };
      return result;
    }
  }

  /**
   * 仓管任务的对外状态（面板 `/keeper` 与工具 status 都用它）。
   *
   * 形状沿用旧 job（`mode` 现在恒为 `'run'`，侧重另记在 `emphasis`：`'all'` | `'dedupe'`），
   * 另加 `plans` / `ops` / `runId` 三个字段：
   * 一轮 run 的产出就是「几张变更单、共几条操作」，`tail` 里逐组写「组 N：M 条操作」。
   * 另有 `retried`：本轮超时重试发生了几次（0 = 一次超时都没有）—— 观测用，面板不强制展示。
   *
   * ⚠️ **旧 job 里的 `derived` / `merged` 两个格子已删除**（2026-10-07 本轮）：它们原本是
   * `dedupePass` 直接改库时累加的「本轮产出 / 本轮合并」，而新范式的 run **一个字都不写记忆库**，
   * 没有任何地方在累加它们 → 面板上「产出 0 / 合并 0」是**恒 0 的假数字**（实测：审掉两张 merge 单
   * 之后 `publicKeeper().merged` 仍是 0）。真实的存量数字在 `store.listKeeperArtifacts()`
   * （现扫库：产物 / 改写 / 合并痕迹）—— 面板那行「现存痕迹」已经删了，`keeperStatus()` 也不再回它
   * （见那里的注释：4 次全表扫而没人读）；
   * 单次审阅应用了几条，由 `reviewKeeperPlan()` 的返回值 `applied` 如实给出。宁可删格子，也不留假 0。
   *
   * @returns {object} 状态
   */
  publicKeeper() {
    const job = this.keeper;
    if (job == null) {
      return { running: false, mode: null, emphasis: null, total: 0, done: 0, failed: 0, skipped: 0, losslessFallback: 0, plans: 0, ops: 0, retried: 0, handedOff: 0, takenOver: 0, current: null, taker: null, runId: null, startedAt: null, finishedAt: null, model: null, error: null, lastError: null, tail: [] };
    }
    return {
      running: job.running === true,
      mode: job.mode,
      emphasis: job.emphasis ?? null,
      total: job.total,
      done: job.done,
      failed: job.failed,
      skipped: job.skipped,
      losslessFallback: job.losslessFallback,
      plans: job.plans,
      ops: job.ops,
      // 超时重试次数（0 = 本轮没有一次超时）。观测用，非必展示。
      retried: job.retried ?? 0,
      // 副仓管：挂进队列的组数 / 其中被接手模型救回来的组数（面板在 >0 时显示）。
      handedOff: job.handedOff ?? 0,
      takenOver: job.takenOver ?? 0,
      // **当前这一组**（`{groupNo, seedId, count, members:[{id,text}], startedAt}`）；
      // 组跑完就清成 `null`（`runKeeperRun()` 用 try/finally 兜住三条退出路径）。
      current: job.current ?? null,
      // 这一轮的接手模型（启动时选的；`null` = 自动）。
      taker: job.taker ?? null,
      runId: job.runId ?? null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      model: job.model,
      error: job.error ?? null,
      lastError: job.lastError ?? null,
      // 面板要看「正在做什么」：留 20 行（原来是 5 行），一轮十几组也能看出节奏。
      tail: Array.isArray(job.tail) ? job.tail.slice(-20) : [],
    };
  }

  /**
   * 跑一轮仓管：**随机抽种子 → 语义召回邻居 → 每组一次调用 → 每组一张变更单**。
   *
   * ## 这一轮**一个字都不改记忆正文**
   * 全程只有三类写入：`keeper_plans`（变更单）、`jobs`（审计），以及 `memories.tidy_score`
   * —— 一条记忆**被抽进某组**时整理指数 +1（种子与召回邻居都算，同轮只算一次）。
   * 记忆正文、meta、`updated_at`、向量都不动 —— 所以「跑一轮」永远安全，
   * 最坏情况只是多了一张 open 的单等人审；计分列的变动不影响任何内容字段。
   *
   * ## 种子与分组
   * - 种子：随机抽 `sample` 条（Fisher-Yates + `Math.random`），默认 `keeper.sampleSize`；
   * - 邻居：对每个种子用 `searchText({query: 种子正文, limit: perGroup})` 做**语义召回**
   *   （就是 embedding 近邻），种子 + 邻居 = 一组；
   * - 去重：成员去重；**已被前面的组覆盖过的种子不再单开一组**（避免同一坨记忆反复出单）；
   * - `maxGroups` 可截断本次处理的组数（省略/0 = 不限）。
   *
   * ## `mode` 只是**提示词侧重**，不是两种任务
   * `'digest'` → `emphasis:'dedupe'`（偏重去重合并：优先 merge、不为了拆而拆）；
   * `'grind'` / 省略 / 其它值 → `emphasis:'all'`（四种 op 视情况决定，即现状）。
   * 两边的流程、校验、落库语义**完全一样** —— 都只写 `keeper_plans`。
   * `job.mode` 仍然恒为 `'run'`（沿用旧形状），侧重记在 `job.emphasis` 上。
   *
   * ## 「接手模型」也在启动时定（用户 2026-10-07：「最终由什么模型接手由我启动时决定」）
   * `taker` 是**这一轮的接手模型**：仓管档案名 / `'host'` / 省略（= 自动：本地优先 → 宿主）。
   * 它不会立刻用上 —— 只在**某一组失败**、需要接手时生效（`handOffGroup` → `reorganizeMemories`）；
   * 这样"没人看着"的自动接手也用的是**我启动这一轮时选的**模型，而不是系统自己挑的。
   *
   * @param {{mode?: 'grind'|'digest'|string|null, sample?: number|null, perGroup?: number|null, maxGroups?: number|null, taker?: string|null}} [input] 参数
   * @returns {Promise<object>} `{ok:true, started:true, runId, planned, keeper}`
   */
  async startKeeperRun({ mode = 'grind', sample = null, perGroup = null, maxGroups = 0, taker = null } = {}) {
    if (this.keeper?.running === true) {
      return { ok: false, error: `仓管正在跑（${this.keeper.mode}，${this.keeper.done}/${this.keeper.total}）`, keeper: this.publicKeeper() };
    }
    const explicitTaker = parseTakerChoice(taker);
    if (explicitTaker === null) return { ok: false, error: `接手模型只能填仓管档案名 / 'host' / 'auto'（收到 ${JSON.stringify(taker)}）` };
    // ⚠ 顺序要紧：`resolvedConfig()` 要先能读到库里的生效档案（`keeper.profiles` / `keeper.active`），
    //   所以**先 `ensureStore()` 再解析**。反过来的话，冷启动第一轮 run 会拿 patch 的
    //   `model:null` 去建客户端，明明生效档案是「线上」也会报「未配置模型」。
    const store = this.ensureStore();
    const cfg = this.resolvedConfig();
    // 没显式给 taker → 用**副仓管**那个角色设定（用户 2026-10-07：「副审阅区使用独立的仓管角色」）：
    // 副仓管用哪个模型在「副仓管」页选一次、存 `settings.keeper.side`，这里只读它。
    const takerChoice = explicitTaker ?? parseTakerChoice(this.sideKeeperChoice()) ?? undefined;
    // 只有 `digest` 走「偏重去重合并」，其余（含未给）都是「全部手段」—— 见 buildPlanRequest 的 emphasis。
    const emphasis = mode === 'digest' ? 'dedupe' : 'all';

    let client;
    try {
      client = await this.createKeeperClient(cfg);
    } catch (error) {
      return { ok: false, error: describeError(error), keeper: this.publicKeeper() };
    }

    const sampleN = Number.isFinite(Number(sample)) && Number(sample) > 0 ? Math.trunc(Number(sample)) : Number(cfg.keeper.sampleSize);
    const perGroupN = Number.isFinite(Number(perGroup)) && Number(perGroup) > 0 ? Math.trunc(Number(perGroup)) : Number(cfg.keeper.perGroup);
    const groupLimit = Number.isFinite(Number(maxGroups)) && Number(maxGroups) > 0 ? Math.trunc(Number(maxGroups)) : 0;

    // 随机抽种子：先把全部未删除记忆读成 {id, text} 再洗牌。
    const pool = [];
    for (const row of store.listTexts({ batchSize: 500 })) pool.push({ id: String(row.id), text: String(row.text) });
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const chosen = pool.slice(0, Math.max(1, sampleN));
    const seeds = groupLimit > 0 ? chosen.slice(0, groupLimit) : chosen;

    const job = {
      running: true,
      mode: 'run',
      // 提示词侧重（'all' | 'dedupe'）：与 `mode` 分开记，`mode` 沿用旧形状恒为 'run'。
      emphasis,
      total: seeds.length,
      done: 0,
      failed: 0,
      skipped: 0,
      losslessFallback: 0,
      plans: 0,
      ops: 0,
      // 超时重试发生了多少次（每个「第一次超时」+1）。观测用：面板不强制展示。
      retried: 0,
      // 副仓管：`handedOff` = 本轮有几组挂进了副仓管；`takenOver` = 其中被接手模型救回来的组数。
      handedOff: 0,
      takenOver: 0,
      // 这一轮的接手模型（用户启动时选的；`null` = 自动（本地优先 → 宿主））。
      taker: takerChoice ?? null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      provider: client.provider,
      model: client.model,
      endpoint: client.endpoint,
      error: null,
      lastError: null,
      tail: [],
      sample: Math.max(1, sampleN),
      perGroup: Math.max(1, perGroupN),
      maxGroups: groupLimit,
      minChars: Number(cfg.keeper.minChars),
      splitChars: Number(cfg.keeper.splitChars),
      // 一组的**硬墙钟安全网**（`0` = 自动 = 本档案 timeoutMs × 2）与单次请求超时；
      // 见 `groupDeadlineMs()`：正常慢请求（实测 231 秒那组）照旧跑完，只有"彻底不回来"才被兜住。
      groupTimeoutMs: Number(cfg.keeper.groupTimeoutMs) || 0,
      requestTimeoutMs: Number(cfg.keeper.timeoutMs) || 0,
      runId: null,
      jobId: null,
    };
    try {
      job.jobId = store.createJob({ kind: 'keeper:run', total: seeds.length });
    } catch {
      job.jobId = null;
    }
    // runId 同时是审计任务 id：变更单靠它归组，面板能把一轮的产出串起来。
    job.runId = job.jobId ?? randomUUID();
    this.keeper = job;

    this.ctx.logger?.info?.(
      `${PLUGIN_ID}: 仓管 run 启动：${seeds.length} 组（样本 ${pool.length} 条里抽 ${Math.max(1, sampleN)}，每组召回 ${Math.max(1, perGroupN)}）（${client.provider}/${client.model}）`,
    );
    void this.runKeeperRun(store, cfg, client, seeds, job).catch((error) => {
      job.error = describeError(error);
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });

    return { ok: true, started: true, runId: job.runId, planned: seeds.length, keeper: this.publicKeeper() };
  }

  /**
   * 找一个「接手模型」—— 某一组记忆整理失败后，让它接着把那组整理完。
   *
   * ## 谁决定用哪个模型（用户 2026-10-07：「最终由什么模型接手由我启动时决定」）
   * `choice` 显式给了就**只认它**（面板那个选模型的窗口、跑一轮时选的「接手模型」都走这条）：
   * - `{kind:'profile', name:'线上'}` → 用那个仓管档案（**没配好就如实报错，不偷偷换人**）；
   * - `{kind:'host'}` → 宿主模型；
   * - 不给 / `auto` → 才走下面的**自动顺序**（没人看着的时候，比如后台跑一轮里的某组失败）。
   *
   * ## 自动顺序（只有 `auto` 才用）
   *   1. **本地 / 局域网仓管档案**：`configured` 且端点落在本机或内网（`isLocalEndpoint`），
   *      且不是刚刚失败的那个（同 provider+model+endpoint）—— 数据不出内网是这条通道存在的理由；
   *   2. **宿主模型**（`ctx.llm`）：一个本地档案都没有时的兜底。它**不是**本地模型，
   *      所以标签里写明「宿主模型」，tail / 面板 / 副仓管记录都看得到究竟是谁接的手。
   *
   * 拿不到就回 `{ client: null, error, label: '', kind: '' }`，**失败原因随调用返回**、不挂实例字段 ——
   * 用户 2026-10-08「各自的运行不能互相产生干扰」：主仓管那一轮里的当场接手与面板上的一次接手
   * 是两条线，都有可能在同一个 tick 调进这里；挂字段的话 A 会读到 B 的失败原因。
   *
   * @param {{provider?: string, model?: string, endpoint?: string} | null} failed 刚刚失败的那个客户端
   * @param {{kind: 'profile'|'host', name?: string} | null} [choice] 显式指定的接手模型
   * @returns {Promise<{client: object | null, label: string, kind: string, error: string | null}>} 接手目标
   */
  async resolveTakeoverClient(failed = null, choice = null) {
    /** 失败出口：把原因绑在这一份返回值上（不是 `this.`）。 */
    const miss = (error) => ({ client: null, label: '', kind: '', error: String(error) });
    // 显式指定：不猜、不兜底、不换人。
    if (choice != null && choice.kind === 'profile') {
      const wanted = String(choice.name ?? '');
      try {
        const listed = this.listKeeperProfiles();
        const profile = (Array.isArray(listed?.profiles) ? listed.profiles : []).find((item) => item?.name === wanted) ?? null;
        if (profile == null) return miss(`没有这个仓管档案：${wanted}`);
        if (profile.configured !== true) {
          return miss(`档案「${wanted}」还没配齐（模型 / 端点缺一个）：先在「设置」里补上，或换一个模型`);
        }
        const raw = this.keeperProfilesState().profiles.find((item) => item?.name === wanted) ?? null;
        const cfg = normalizeConfig({
          ...(this.config ?? {}),
          keeper: { ...((this.config ?? {}).keeper ?? {}), ...profileToKeeper(raw) },
        });
        const client = await this.createKeeperClient(cfg);
        return { client, label: `${profile.name} / ${client.model}`, kind: 'profile', error: null };
      } catch (error) {
        return miss(`${wanted}：${describeError(error)}`);
      }
    }
    if (choice != null && choice.kind === 'host') {
      try {
        const client = this.createLlmClient();
        const model = String(this.resolvedConfig()?.llm?.model ?? '').trim();
        return { client, label: model === '' ? '宿主模型' : `宿主模型 / ${model}`, kind: 'host', error: null };
      } catch (error) {
        return miss(describeError(error));
      }
    }
    const failedKey = `${failed?.provider ?? ''}|${failed?.model ?? ''}|${failed?.endpoint ?? ''}`;
    // 试过但没成的原因：**局部变量**，随这次调用返回（并发时不会串）。
    let lastError = null;
    // ① 本地 / 局域网档案（**逐个**试：某个档案自己配歪了不能挡住后面的候选）
    try {
      const listed = this.listKeeperProfiles();
      const stored = this.keeperProfilesState().profiles;
      for (const profile of Array.isArray(listed?.profiles) ? listed.profiles : []) {
        if (profile?.configured !== true || profile?.builtin === true) continue;
        if (!isLocalEndpoint(profile?.endpoint)) continue;
        if (`${profile.provider ?? ''}|${profile.model ?? ''}|${profile.endpoint ?? ''}` === failedKey) continue;
        try {
          const raw = stored.find((item) => item?.name === profile.name) ?? null;
          const cfg = normalizeConfig({
            ...(this.config ?? {}),
            keeper: { ...((this.config ?? {}).keeper ?? {}), ...profileToKeeper(raw) },
          });
          const client = await this.createKeeperClient(cfg);
          return { client, label: `${profile.name} / ${client.model}`, kind: 'local', error: null };
        } catch (error) {
          lastError = `${profile.name}：${describeError(error)}`;
        }
      }
    } catch (error) {
      // 档案列表整个取不出来（库有问题）也不致命：继续往宿主模型走。
      lastError = describeError(error);
    }
    // ② 宿主模型
    try {
      const client = this.createLlmClient();
      const model = String(this.resolvedConfig()?.llm?.model ?? '').trim();
      return { client, label: model === '' ? '宿主模型' : `宿主模型 / ${model}`, kind: 'host', error: null };
    } catch (error) {
      return miss(lastError ?? describeError(error));
    }
  }

  /**
   * **副仓管**的重做：拿一组「种子记忆」**从头**跑一遍整理流程（用户 2026-10-07）。
   *
   * 「重头」是字面意思 —— 与跑一轮的同一个流程，不只是把存下来的成员直接丢给模型：
   *   1. 种子正文 → `searchText()` **用 embedding 召回相关记忆**（每轮 `keeper.perGroup` 条）；
   *   2. 整组 = **全部种子 ∪ 召回的邻居**（活着、未软删、去重；召回以**第一条种子**为主种子，
   *      与跑一轮「一组一个种子」的口径一致）；
   *   3. `buildPlanRequest()` 拼请求 → 打接手模型（本地 / 局域网档案优先，其次宿主模型）；
   *   4. `normalizePlanOps()` 校验 → **出单**（`runId` 为空 = 散单；不改任何记忆正文）。
   *
   * 三个入口共用它：run 里某组失败后的当场接手、副仓管那一行的「接手」、待审变更单的「转手」（转手只入队，
   * 真正开跑是人在**副仓管**页点「接手」的时候 —— 用哪个模型就是那一页选的副仓管角色）。
   * 召回失败（`searchText` 抛错）**不致命**：退化成"只用种子"，把原因放进 `recallError` 如实报。
   *
   * @param {{store: object, seedIds: string[], minChars?: number, splitChars?: number, perGroup?: number,
   *   emphasis?: string, failed?: object | null, runId?: string | null,
   *   taker?: {kind: 'profile'|'host', name?: string} | null, timeoutMs?: number}} input 参数
   * @returns {Promise<{ok: boolean, taker?: string|null, kind?: string, ops?: number, planId?: string|null,
   *   memberIds?: string[], recalled?: number, recallError?: string|null, seedId?: string|null, error?: string}>} 结果
   */
  async reorganizeMemories({ store, seedIds, minChars = 240, splitChars = 400, perGroup = 5, emphasis = 'all', failed = null, runId = null, taker = null, timeoutMs = undefined }) {
    const target = await this.resolveTakeoverClient(failed, taker);
    if (target == null || target.client == null) {
      return {
        ok: false,
        taker: null,
        error: target?.error ?? '没有可接手的模型（本地档案都没配好，宿主模型也不可用）',
      };
    }
    // 种子：只要还活着的（软删 / 已消失的跳过 —— 拿不到正文就没法整理）。
    const seeds = [];
    for (const id of Array.isArray(seedIds) ? seedIds : []) {
      const row = store.getMemory(String(id));
      if (row == null) continue;
      seeds.push({ id: String(row.id), text: String(row.text ?? '') });
    }
    if (seeds.length === 0) return { ok: false, taker: target.label, kind: target.kind, error: '这些记忆都不在了（已删除）' };

    // ① 用 embedding 召回：以**第一条种子**为主种子（与 run 一组一个种子同形）。
    const members = seeds.map((seed) => ({ id: seed.id, text: seed.text }));
    const seen = new Set(members.map((member) => member.id));
    let recalled = 0;
    let recallError = null;
    try {
      const found = await this.searchText({ query: seeds[0].text, limit: Math.max(1, Number(perGroup) || 5) });
      for (const hit of Array.isArray(found?.items) ? found.items : []) {
        const id = String(hit?.id ?? '');
        if (id === '' || seen.has(id)) continue;
        const row = store.getMemory(id);
        if (row == null || row.deleted_at != null) continue;
        seen.add(id);
        members.push({ id, text: String(row.text ?? '') });
        recalled += 1;
      }
    } catch (error) {
      recallError = describeError(error);
    }

    try {
      const request = buildPlanRequest({ members, minChars, splitChars, emphasis });
      const answer = await target.client.chat(request, { timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined });
      const ops = normalizePlanOps(answer, { members, splitChars, minChars });
      const memberIds = members.map((member) => member.id);
      if (ops.length === 0) {
        return { ok: true, taker: target.label, kind: target.kind, ops: 0, planId: null, memberIds, recalled, recallError, seedId: seeds[0].id };
      }
      const plan = store.createKeeperPlan({ runId, seedId: seeds[0].id, memberIds, ops, model: target.client.model });
      return {
        ok: true,
        taker: target.label,
        kind: target.kind,
        ops: ops.length,
        planId: String(plan.id),
        memberIds,
        recalled,
        recallError,
        seedId: seeds[0].id,
      };
    } catch (error) {
      return { ok: false, taker: target.label, kind: target.kind, error: describeError(error), memberIds: members.map((m) => m.id), recalled, recallError };
    }
  }

  /**
   * 一组的**失败处理**：挂到「副仓管」→ 当场让接手模型接着整理。
   *
   * 三条口径（都在 `job` / `tail` / `keeper_handoffs` 里留痕，绝不静默吞掉）：
   * - **跳过这一组**：主循环 `continue` 下一组，一轮不会被一组拖死；
   * - **挂到副仓管**：`attempts` 如实累加（同一组反复失败不会插出很多行）；
   * - **接手成功也算这一组出单**：`done` / `plans` / `ops` 照常加，`takenOver` 单独记数；
   *   接手也失败才计 `failed`，并把接管后的原因写回那一行（面板照它显示「为什么还在这儿」）。
   *
   * @param {{store: object, job: object, groupNo: number, seed: {id: string, text: string},
   *   members: {id: string, text: string}[], memberIds: string[], errorText: string,
   *   failed: object | null}} input 参数
   * @returns {Promise<void>} 完成
   */
  async handOffGroup({ store, job, groupNo, seed, members, memberIds, errorText, failed = null, timeoutMs = undefined, takeOver = true }) {
    job.tail.push(`组 ${groupNo}：失败（${errorText}）`);
    let handoff;
    try {
      handoff = store.createHandoff({
        runId: job.runId,
        seedId: String(seed.id),
        memberIds: [...memberIds],
        error: errorText,
      });
      job.handedOff += 1;
      job.tail.push(`组 ${groupNo}：已挂到副审阅区（第 ${handoff.attempts} 次）`);
    } catch (error) {
      // 挂不上（库写失败）也必须说清楚，不能让人以为这一组消失得理所当然。
      job.tail.push(`组 ${groupNo}：挂到副审阅区失败（${describeError(error)}）`);
      job.failed += 1;
      return;
    }
    // **先认领再接手**（原子 `open` → `taking`）：不然这一窗口里面板也看得到它、人也可能点「接手」，
    // 同一组就被接两次、出两张单（用户 2026-10-08：「各自的运行不能互相产生干扰」）。
    try {
      store.claimHandoff(handoff.id);
    } catch {
      /* 认领失败不致命：接手本身照跑，最坏是面板那一瞬间也能点 */
    }
    // **整组到点了就不再自动接手**：接手那次请求是在预算耗尽之后才开跑的，真机上实测能让一组
    // 跑到 602s（声明上限 480s）—— 仅靠 `timeoutMs` 收不住它。这里改成我们自己说了算：留在副审阅区，
    // 由人（或以后换一个模型）来接手。没到点的失败照旧当场接手 —— 那条救回路径不变。
    if (takeOver !== true) {
      // ⚠️ 必须**把认领放回**（`taking` → `open`）：不然这一行会卡在 `taking` —— 面板只列 `open`，
      // 那它就 10 分钟看不见也接不了（等于悄悄丢了）。原因一并写进去，面板那行看得到。
      try {
        store.releaseHandoff(handoff.id, { error: errorText });
      } catch {
        /* 放不回不影响"它还在队列里"这个事实（清扫会在 10 分钟后兜底） */
      }
      job.tail.push(`组 ${groupNo}：整组预算已用完 → 不自动接手，留在副审阅区等你接手`);
      return;
    }
    const taken = await this.reorganizeMemories({
      store,
      // 「重头」：把这一组的成员当**种子**，让接手模型自己再召回一次相关记忆（见 reorganizeMemories）。
      seedIds: [...memberIds],
      minChars: job.minChars,
      splitChars: job.splitChars,
      perGroup: job.perGroup,
      emphasis: job.emphasis,
      failed,
      runId: job.runId,
      // 「接手模型由我启动时决定」：run 启动时选的那个（没选 = 自动）。
      taker: job.taker ?? null,
      // 接手也在**同一组的墙钟预算**内：整组到点了就让它立刻失败、如实记「接手也失败」，
      // 而不是又等一个档案超时（`undefined` = 这一轮没设预算，按档案超时走）。
      timeoutMs,
    });
    if (taken.ok !== true) {
      job.failed += 1;
      const why = taken.taker == null ? `没有可接手的模型（${taken.error}）` : `${taken.taker} 接手也失败（${taken.error}）`;
      job.tail.push(`组 ${groupNo}：${why} → 留在副审阅区`);
      try {
        // 认领失败要**放回队列**：不然这一条会停在 `taking`，面板看不到、也接手不了（等于悄悄丢了）。
        const released = store.releaseHandoff(handoff.id, { error: taken.error });
        if (released !== true) store.updateHandoff(handoff.id, { error: taken.error });
      } catch {
        /* 写不回原因不影响「这一组留在队列里」 */
      }
      return;
    }
    try {
      store.updateHandoff(handoff.id, { state: 'taken', taker: taken.taker, planId: taken.planId });
    } catch {
      /* 状态写失败不该影响已经出好的单；tail 里仍能看到接手结果 */
    }
    if (taken.ops === 0) {
      job.skipped += 1;
      job.tail.push(`组 ${groupNo}：${taken.taker} 接手 → 0 条操作（无需变更）`);
      return;
    }
    job.takenOver += 1;
    job.done += 1;
    job.plans += 1;
    job.ops += Number(taken.ops);
    job.tail.push(`组 ${groupNo}：${taken.taker} 接手 → ${taken.ops} 条操作`);
  }

  /**
   * **副仓管**自己的运行状态（与主仓管**各存各的**：用户 2026-10-08「主副仓管独立，各自的运行不能互相产生干扰」）。
   *
   * 副仓管一次只接一组（`takeOverHandoff` 会被自己的 `running` 挡住），但**不受主仓管轮次影响** ——
   * 主仓管在跑的时候照样能接手，两边的进度、计数、tail 谁都不覆盖谁。
   *
   * @returns {object} 状态（永远有值）
   */
  publicSideKeeper() {
    const job = this.sideJob;
    if (job == null) {
      return { running: false, handoffId: null, seedId: null, taker: null, model: null, startedAt: null, finishedAt: null, error: null, tail: [] };
    }
    return {
      running: job.running === true,
      handoffId: job.handoffId ?? null,
      seedId: job.seedId ?? null,
      taker: job.taker ?? null,
      model: job.model ?? null,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      error: job.error ?? null,
      tail: Array.isArray(job.tail) ? job.tail.slice(-10) : [],
    };
  }

  /**
   * 跑完一轮出单（后台，不阻塞调用方）。**不改记忆正文，只写 `keeper_plans` + 进组记忆的 tidy 计分。**
   *
   * `job.emphasis`（`'all'` | `'dedupe'`）原样传给 `buildPlanRequest()`：只改提示词侧重，
   * 不改 op 种类、校验或落库语义。
   *
   * ## 超时同组重试一次（2026-10-07 实测补）
   * 线上模型（`qwen3.8-flash`）吐 2000 token 的 JSON 实测约 1/3 的组会超时：那一组进组的 tidy
   * **照常计入**、却一行产出都没有，采样机会白花。所以**只在超时**（`name==='TimeoutError'`
   * 或 `code===23`，见 `isTimeoutError()`）时用**同一份请求**再打一次：
   * - 重试是同一组 —— **不重复 `recordTidy()`、不重复建单**；
   * - 只重试一次；第二次仍失败才算该组 `failed`，tail 记「失败（超时，已重试一次）」；
   * - 非超时错误（HTTP 4xx/5xx、响应格式错…）**不重试**，错误原文直接进 tail / `lastError`；
   * - `job.retried` 累加重试发生了多少次（观测用）。
   *
   * @param {object} store 库
   * @param {object} cfg 配置
   * @param {object} client 仓管 LLM
   * @param {{id: string, text: string}[]} seeds 种子（已随机、已截断）
   * @param {object} job 任务状态（就地更新；含 `emphasis`）
   * @returns {Promise<void>} 完成
   */
  async runKeeperRun(store, cfg, client, seeds, job) {
    const covered = new Set();
    let groupNo = 0;
    try {
      for (const seed of seeds) {
        groupNo += 1;
        // 「已有组覆盖过的不再单开」：种子被前面的组收走了就跳过，连检索都不用做。
        if (covered.has(seed.id)) {
          job.skipped += 1;
          job.tail.push(`组 ${groupNo}：跳过（种子已被前面的组覆盖）`);
          continue;
        }

        /** @type {{id: string, text: string}[]} */
        const members = [{ id: seed.id, text: seed.text }];
        const memberIds = new Set([seed.id]);
        try {
          const found = await this.searchText({ query: seed.text, limit: Math.max(1, job.perGroup) });
          for (const hit of Array.isArray(found?.items) ? found.items : []) {
            const id = String(hit?.id ?? '');
            if (id === '' || memberIds.has(id) || covered.has(id)) continue;
            const row = store.getMemory(id);
            if (row == null || row.deleted_at != null) continue;
            memberIds.add(id);
            members.push({ id, text: String(row.text) });
          }
        } catch (error) {
          job.lastError = describeError(error);
        }
        for (const id of memberIds) covered.add(id);

        // 计分：进这一组的每条记忆 tidy +1（种子与召回邻居都算，**不管这组最后出不出单**）。
        // 每组一次批量 UPDATE；跨组的重复由上面的 `covered` 保证（同一条记忆不会进第二组），
        // 所以「同一轮里同一 id 只算一次」是结构性的，不靠额外去重。
        this.recordTidy([...memberIds]);

        // 进这一组之前先记一行「开始」：一轮里单组可能要跑 1–4 分钟（线上模型吐 2000 token 的
        // JSON 实测如此），只记「结果」的话面板在整组跑完前**一行都没有**，人就会以为卡死了。
        // 用户 2026-10-07：「我需要能看见仓管的工作过程…以及确保它没卡住而是在正常运行」。
        job.tail.push(`组 ${groupNo}：开始（${members.length} 条记忆，种子 ${String(seed.id).slice(0, 8)}）`);

        // 「正在处理的记忆是哪些」（用户 2026-10-07）—— tail 只写得出条数与种子前 8 位，
        // 面板要能**看见这一组的正文**。所以把这一组的成员摊在 `job.current` 上，随 `/keeper`
        // 一起轮询出去（每组几十 KB 上限：条数 ≤ perGroup+1，每条截 200 字）。
        // 用 try/finally 兜住整组：成功 / 失败 / `continue` 三条路都会把 `current` 清掉，
        // 绝不留下一个"看起来还在处理"的假状态。
        job.current = {
          groupNo,
          seedId: String(seed.id),
          startedAt: new Date().toISOString(),
          count: members.length,
          members: members.map((member) => ({
            id: String(member.id),
            text: clipText(String(member.text ?? ''), KEEPER_CURRENT_PREVIEW_CHARS),
          })),
        };
        try {
          let ops = [];
          // 这一组的**硬墙钟**：整组（超时重试、接手那一次都算）共用同一个预算。
          // 单次 `timeoutMs` 管不住"一组打两次"和"接手再打一次"，所以这里按组兜一道；
          // 到点就挂副审阅区等人接手，绝不让一轮被一组拖住。
          const groupBudget = groupDeadlineMs({ groupTimeoutMs: job.groupTimeoutMs, requestTimeoutMs: job.requestTimeoutMs });
          const groupStopAt = groupBudget > 0 ? Date.now() + groupBudget : 0;
          const budgetLeft = () => (groupStopAt === 0 ? undefined : groupStopAt - Date.now());
          const groupExpired = () => groupStopAt !== 0 && Date.now() >= groupStopAt;
          // 接手预算：到点后给 1ms（立即失败、如实记「接手也失败」），不额外等一个档案超时。
          const handoffBudget = () => (groupStopAt === 0 ? undefined : Math.max(1, groupStopAt - Date.now()));
          const groupBudgetText = `整组超过 ${Math.round(groupBudget / 1000)} 秒`;
          // 请求体只拼一次：重试打的是**同一组、同一份请求**（不是另开一组，也不重复计分 / 建单）。
          const request = buildPlanRequest({ members, minChars: job.minChars, splitChars: job.splitChars, emphasis: job.emphasis });
          let answer;
          if (groupExpired()) {
            job.tail.push(`组 ${groupNo}：${groupBudgetText} → 直接挂副审阅区`);
            await this.handOffGroup({
              store,
              job,
              groupNo,
              seed,
              members,
              memberIds: [...memberIds],
              errorText: groupBudgetText,
              failed: client,
              timeoutMs: handoffBudget(),
              takeOver: false,
            });
            continue;
          }
          try {
            answer = await client.chat(request, { timeoutMs: budgetLeft() });
          } catch (error) {
            // **只有超时**才重试（线上模型吐 2000 token 的 JSON 实测会超过 timeoutMs）；
            // 非超时错误（HTTP 4xx/5xx、响应格式错…）重试也白搭，直接把原文记进 tail / lastError。
            if (!isTimeoutError(error)) {
              job.lastError = `${String(seed.id).slice(0, 8)}：${describeError(error)}`;
              // 跳过这一组 + 挂到副仓管 + 让接手模型接着整理（见 handOffGroup 的三条口径）。
              await this.handOffGroup({
                store,
                job,
                groupNo,
                seed,
                members,
                memberIds: [...memberIds],
                errorText: describeError(error),
                failed: client,
                timeoutMs: handoffBudget(),
              });
              continue;
            }
            // 超时了但整组预算已经用完：重试没有意义（它自己也会立刻超时），直接挂副审阅区。
            if (groupExpired()) {
              job.tail.push(`组 ${groupNo}：超时后已无整组预算（${groupBudgetText}）→ 直接挂副审阅区`);
              await this.handOffGroup({
                store,
                job,
                groupNo,
                seed,
                members,
                memberIds: [...memberIds],
                errorText: groupBudgetText,
                failed: client,
                timeoutMs: handoffBudget(),
                takeOver: false,
              });
              continue;
            }
            job.retried += 1;
            job.tail.push(`组 ${groupNo}：超时，重试一次`);
            try {
              answer = await client.chat(request, { timeoutMs: budgetLeft() });
            } catch (retryError) {
              job.lastError = `${String(seed.id).slice(0, 8)}：${describeError(retryError)}`;
              // ⚠️ 真机（2026-10-08）：整组墙钟声明 480s，实际一组跑到 **602s** —— 因为"接手那一次"
              // 是在预算耗尽之后才开跑的，仅靠 `timeoutMs` 收不住它（那一次的预算怎么传、真实 fetch
              // 认不认那个 1ms 信号，我在真机上无法直接观测）。所以这里改成**我们自己说了算**：
              // 整组到点就**不自动接手**，留在副审阅区等人接手（用户的口径本来就是"留着等"）。
              // 没到点的失败照旧当场接手 —— 那条救回路径不变。
              await this.handOffGroup({
                store,
                job,
                groupNo,
                seed,
                members,
                memberIds: [...memberIds],
                errorText: isTimeoutError(retryError) ? '超时，已重试一次' : describeError(retryError),
                failed: client,
                timeoutMs: handoffBudget(),
                takeOver: !groupExpired(),
              });
              continue;
            }
          }
          try {
            ops = normalizePlanOps(answer, { members, splitChars: job.splitChars, minChars: job.minChars });
          } catch (error) {
            job.lastError = `${String(seed.id).slice(0, 8)}：${describeError(error)}`;
            // 模型答了但解析不出可用操作 —— 与「调用失败」同一处置：跳过、挂副仓管、让接手模型再试。
            await this.handOffGroup({
              store,
              job,
              groupNo,
              seed,
              members,
              memberIds: [...memberIds],
              errorText: describeError(error),
              failed: client,
              timeoutMs: handoffBudget(),
            });
            continue;
          }

          if (ops.length === 0) {
            job.skipped += 1;
            job.tail.push(`组 ${groupNo}：0 条操作（无需变更）`);
            continue;
          }
          for (const op of ops) {
            // ⚠️ 认 `normalizePlanOps()` 打的**结构标记** `fallback`，不认 warning 文案 / 条数：
            // split 现在还会带「缺主语 / 新增片段 / 消失的片段」等**证据**，按 `warnings.length > 0`
            // 计会把它们全算成兜底（面板「兜底切分 N」虚高、含义失真）。
            if (op.type === 'split' && op.fallback === true) job.losslessFallback += 1;
          }
          store.createKeeperPlan({ runId: job.runId, seedId: seed.id, memberIds: [...memberIds], ops, model: job.model });
          job.done += 1;
          job.plans += 1;
          job.ops += ops.length;
          job.tail.push(`组 ${groupNo}：${ops.length} 条操作`);
        } finally {
          job.current = null;
        }
      }
    } catch (error) {
      job.error = describeError(error);
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      if (job.jobId != null) {
        try {
          store.updateJob(job.jobId, {
            state: job.error == null ? 'done' : 'failed',
            done: job.done,
            failed: job.failed,
            error: job.error ?? job.lastError ?? null,
            detail: { mode: job.mode, plans: job.plans, ops: job.ops, skipped: job.skipped, retried: job.retried ?? 0, runId: job.runId, handedOff: job.handedOff ?? 0, takenOver: job.takenOver ?? 0 },
            finished_at: job.finishedAt,
          });
        } catch {
          /* 审计写失败不影响结果 */
        }
      }
      this.ctx.logger?.info?.(
        `${PLUGIN_ID}: 仓管 run 结束：出单 ${job.plans} 张 / ${job.ops} 条操作 · 跳过 ${job.skipped} 组 · 失败 ${job.failed} 组` +
          ` · 副审阅区 ${job.handedOff ?? 0} 组（其中 ${job.takenOver ?? 0} 组被接手模型救回）`,
      );
    }
  }

  /**
   * 列出变更单（新的在前）。`warnings` 是单里全部 op 警告的拍平，供面板一眼看到风险。
   *
   * @param {{state?: string|null, limit?: number|null}} [input] 过滤条件
   * @returns {{ok: boolean, plans: object[], error?: string}} 信封
   */
  listKeeperPlans({ state = null, limit = null } = {}) {
    try {
      const plans = this.ensureStore()
        .listKeeperPlans({ state, limit })
        .map((plan) => ({ ...plan, warnings: planWarnings(plan.ops) }));
      return { ok: true, plans };
    } catch (error) {
      return { ok: false, error: describeError(error), plans: [] };
    }
  }

  /**
   * 取一张变更单的全文（含每条 op 的 `before` / `after` / `warnings`）。
   *
   * @param {string} id 变更单 id
   * @returns {{ok: boolean, plan?: object, error?: string}} 信封
   */
  getKeeperPlan(id) {
    const planId = String(id ?? '').trim();
    if (planId === '') return { ok: false, error: '缺少 id' };
    try {
      const plan = this.ensureStore().getKeeperPlan(planId);
      if (plan == null) return { ok: false, error: `没有这张变更单：${planId}` };
      return { ok: true, plan: { ...plan, warnings: planWarnings(plan.ops) } };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 手工提出一条记忆的修改：**按用户定的统一修改语义**建一张单 op 的 `replace` 变更单。
   *
   * 用户原话：「修改记忆的做法是 **依照原记忆编写修改后的记忆** → **新旧记忆展示在待审区** →
   * **过审后删除原记忆、录入新记忆**」。所以这里**只出单、不落库**：
   * - 校验 `id` 存在且**未软删**（`getMemory()` 默认就看不到软删行）、`text` 非空、且与原文不同；
   * - 建一张 `state:'open'` 的单，op 形状与 `normalizePlanOps()` 的产物同形
   *   （`{idx, type:'replace', targets:[id], before:[{id,text:原文}], after:text, reason}`）——
   *   面板「仓管待审」页签按现有渲染就能显示新旧对比；
   * - 返回 `{ok:true, planId}`；过审仍走**唯一落库入口** `reviewKeeperPlan()`。
   *
   * @param {{id: string, text: string, reason?: string|null}} [input] 哪条记忆、改成什么、为什么
   * @returns {{ok: boolean, planId?: string, error?: string}} 信封
   */
  proposeKeeperReplace({ id, text, reason = null } = {}) {
    const store = this.ensureStore();
    const memoryId = String(id ?? '').trim();
    if (memoryId === '') return { ok: false, error: '缺少 id' };
    const next = String(text ?? '');
    if (next.trim() === '') return { ok: false, error: 'text 不能为空：请给出修改后的新正文' };

    const row = store.getMemory(memoryId);
    if (row == null) return { ok: false, error: `没有这条记忆（或已被删除）：${memoryId}` };
    const current = String(row.text ?? '');
    if (next === current) return { ok: false, error: '新正文与原文一字不差，没有可提交的修改' };

    const note = typeof reason === 'string' ? reason.trim() : '';
    try {
      const plan = store.createKeeperPlan({
        seedId: memoryId,
        memberIds: [memoryId],
        ops: [
          {
            idx: 0,
            type: 'replace',
            targets: [memoryId],
            before: [{ id: memoryId, text: current }],
            after: next,
            reason: note === '' ? '手工提出的修改' : note,
            warnings: [],
          },
        ],
      });
      return { ok: true, planId: plan.id };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 手工提出**删除**一条记忆：建一张单 op 的 `drop` 变更单（**只出单、不落库**）。
   *
   * 为什么要有它（用户 2026-10-07）：「删改都要进待审区」—— 库里已经录进去的噪声
   * （例如早期过滤器误杀之外还混进去的会话态）以前**只能直删**，没有「先出单、再审」的入口。
   * 本方法与 `proposeKeeperReplace()` 并列，是删除的**唯一**手工入口：
   * - 校验 `id` 存在且**未软删**（`getMemory()` 默认看不到软删行）；
   * - 建一张 `state:'open'` 的单，op 形状与其它 op 同形
   *   （`{idx:0, type:'drop', targets:[id], before:[{id,text:原文}], after:null, reason, warnings:[]}`）——
   *   面板「仓管待审」页签按现有渲染就能显示待删正文；
   * - 返回 `{ok:true, planId}`；过审仍走**唯一落库入口** `reviewKeeperPlan()`（`drop` → 软删），
   *   回滚由 `revertKeeper()` 从已应用变更单里的 `drop` op 放回。
   *
   * @param {{id: string, reason?: string|null}} [input] 删哪条、为什么
   * @returns {{ok: boolean, planId?: string, error?: string}} 信封
   */
  proposeKeeperDrop({ id, reason = null } = {}) {
    const store = this.ensureStore();
    const memoryId = String(id ?? '').trim();
    if (memoryId === '') return { ok: false, error: '缺少 id' };

    const row = store.getMemory(memoryId);
    if (row == null) return { ok: false, error: `没有这条记忆（或已被删除）：${memoryId}` };

    const note = typeof reason === 'string' ? reason.trim() : '';
    try {
      const plan = store.createKeeperPlan({
        seedId: memoryId,
        memberIds: [memoryId],
        ops: [
          {
            idx: 0,
            type: 'drop',
            targets: [memoryId],
            before: [{ id: memoryId, text: String(row.text ?? '') }],
            after: null,
            reason: note === '' ? '手工提出的删除' : note,
            warnings: [],
          },
        ],
      });
      return { ok: true, planId: plan.id };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 列出「副仓管」—— 仓管某一组出错、又没被接手模型救回来的那些组。
   *
   * 一行 = 一组记忆（正文**不复制**，这里按 `memberIds` 回库里取几条预览给面板看）。预览最多
   * 3 条、每条截 `PREVIEW_CHARS`：面板要的是「这是哪一坨记忆」，不是把整块正文再铺一遍
   * （要全文点进去看原记忆）。
   *
   * @param {{state?: string|null, limit?: number|null}} [input] 过滤条件（默认只看 open）
   * @returns {{ok: boolean, handoffs?: object[], open?: number, error?: string}} 信封
   */
  listHandoffs({ state = 'open', limit = 50 } = {}) {
    try {
      const store = this.ensureStore();
      const rows = store.listHandoffs({ state, limit });
      const handoffs = rows.map((row) => {
        const members = [];
        for (const id of row.memberIds) {
          if (members.length >= HANDOFF_PREVIEW_MEMBERS) break;
          const memory = store.getMemory(String(id));
          if (memory == null) continue;
          members.push({ id: String(memory.id), text: clipText(String(memory.text ?? ''), HANDOFF_PREVIEW_CHARS) });
        }
        return {
          id: row.id,
          runId: row.runId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          state: row.state,
          seedId: row.seedId,
          count: row.memberIds.length,
          members,
          error: row.error,
          attempts: row.attempts,
          taker: row.taker,
          planId: row.planId,
        };
      });
      return { ok: true, handoffs, open: store.countOpenHandoffs() };
    } catch (error) {
      return { ok: false, error: describeError(error), handoffs: [] };
    }
  }

  /**
   * **副仓管**的一行开跑（面板那一行的「接手」按钮 / 工具同类动作）。
   *
   * `model` **省略**就用**副仓管这个角色**的设定（`settings.keeper.side`，见 `setSideKeeper`）；
   * 显式给了就只认它（不猜、不兜底、不换人）。
   *
   * 显式传 `model` 时（用户 2026-10-07：「最终由什么模型接手由我启动时决定」）：
   * - 仓管档案名（如 `'线上'` / `'局域网-ollama'`）→ 就用那个档案，**没配好就如实报错、不偷偷换人**；
   * - `'host'` → 宿主模型；
   * - `'auto'` → 显式要自动顺序（本地 / 局域网档案优先，其次宿主模型）。
   *
   * 与 run 里当场接手**同一个方法**（`reorganizeMemories`）：拿这一行的成员当**种子**、**重头跑一遍**
   * （embedding 召回相关记忆 → 组 → 出手模型 → 出单），只出单、不改正文。
   * - 涉及的记忆**全被删了** → 这一行直接标 `dropped`（否则它会永远卡在队列里，谁也接不了）；
   * - 成功 → 标 `taken`、记下接手模型与新建的单 id，**并把这一行成员换成这次真正整理的那一组**；
   * - 失败 → 留在 `open`，`attempts` +1、`error` 换成这次的原因（面板就显示它）。
   *
   * @param {{id: string, model?: string|null}} input 副仓管项 id + 接手模型
   * @returns {Promise<{ok: boolean, handoff?: object, planId?: string|null, ops?: number, taker?: string,
   *   recalled?: number, recallError?: string|null, dropped?: boolean, error?: string}>} 信封
   */
  async takeOverHandoff({ id, model = null } = {}) {
    const store = this.ensureStore();
    const handoffId = String(id ?? '').trim();
    if (handoffId === '') return { ok: false, error: '缺少 id' };
    // 副仓管**自己**一次只接一组 —— 但**与主仓管的轮次无关**：主仓管在跑的时候照样能接手。
    // （用户 2026-10-08：「主副仓管独立，各自的运行不能互相产生干扰」。）
    if (this.sideJob?.running === true) {
      return {
        ok: false,
        error: `副仓管正在接手另一组（${this.sideJob.handoffId ?? '…'}），等它做完再点`,
        sideJob: this.publicSideKeeper(),
      };
    }
    // 把**僵住的认领**放回来（进程被杀留下的 `taking`）：不做这一步那条就永远接手不了了。
    try {
      store.reclaimStaleHandoffs({});
    } catch {
      /* 清不动不影响正经接手 */
    }
    const row = store.getHandoff(handoffId);
    if (row == null) return { ok: false, error: `没有这条副审阅区记忆：${handoffId}` };
    if (row.state !== 'open') return { ok: false, error: `这一项已经处理过了（state=${row.state}）` };

    // 只要「还有活着的种子」就往下走；全没了才标 dropped。
    const alive = row.memberIds.filter((memberId) => {
      const memory = store.getMemory(String(memberId));
      return memory != null && memory.deleted_at == null;
    });
    // **原子认领**（`open` → `taking`）：上面那行 `state !== 'open'` 检查与这里之间有窗口 ——
    // 主仓管某组失败后是「挂队列 + 当场接手」，那一瞬间面板也看得到它、人也可能点「接手」，
    // 同一组就会被接两次、出两张单。比较并交换只有一个人拿得到。
    if (store.claimHandoff(handoffId) !== true) {
      return { ok: false, error: '这一项刚被另一个接手拿走了（读到的状态已经变了）' };
    }
    if (alive.length === 0) {
      const dropped = store.updateHandoff(handoffId, { state: 'dropped', error: '涉及的记忆都已删除' });
      return { ok: true, handoff: dropped, dropped: true, planId: null, ops: 0 };
    }
    // 副仓管自己的槽：主仓管那一轮的状态**一个字都不碰**。
    this.sideJob = {
      running: true,
      handoffId,
      seedId: row.seedId == null ? null : String(row.seedId),
      taker: null,
      model: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      tail: [`接手 ${handoffId}（${alive.length} 条记忆）`],
    };
    try {
      // 没显式指定 → 用**副仓管**那个角色设定（面板「副仓管」页选一次就定下来）。
      const taker = parseTakerChoice(model ?? this.sideKeeperChoice());
      if (taker === null) {
        store.releaseHandoff(handoffId, { error: '接手模型不合法' });
        return { ok: false, error: `接手模型只能填仓管档案名 / 'host' / 'auto'（收到 ${JSON.stringify(model)}）` };
      }
      // ⚠️ `undefined` 是**合法**的（= 自动顺序），别把它当"没选"来报错 —— 只有 `null` 才是不合法。
      this.sideJob.taker = taker == null ? '自动' : taker.kind === 'host' ? '宿主模型' : (taker.name ?? null);
      const cfg = this.resolvedConfig();
      const taken = await this.reorganizeMemories({
        store,
        seedIds: alive,
        minChars: cfg.keeper.minChars,
        splitChars: cfg.keeper.splitChars,
        perGroup: cfg.keeper.perGroup,
        emphasis: 'all',
        failed: null,
        runId: row.runId,
        taker,
      });
      this.sideJob.model = taken.taker ?? null;
      if (taken.ok !== true) {
        store.bumpHandoffAttempts(handoffId);
        // 失败必须**放回队列**（`taking` → `open`），否则这一条面板看不到、也接手不了。
        const released = store.releaseHandoff(handoffId, { error: taken.error });
        const updated = released === true ? store.getHandoff(handoffId) : store.updateHandoff(handoffId, { error: taken.error });
        this.sideJob.error = taken.error ?? null;
        this.sideJob.tail.push(`失败：${taken.error} → 放回队列`);
        return { ok: false, error: taken.error, handoff: updated, taker: taken.taker ?? null };
      }
      if (Array.isArray(taken.memberIds) && taken.memberIds.length > 0) {
        try {
          // 成员换成"真正整理的那一组"（种子 ∪ 召回的邻居）—— 面板那行「N 条记忆」说的才是事实。
          store.updateHandoff(handoffId, { memberIds: taken.memberIds });
        } catch {
          /* 成员表刷新失败不影响已经出好的单 */
        }
      }
      const updated = store.updateHandoff(handoffId, {
        state: 'taken',
        taker: taken.taker,
        planId: taken.planId,
      });
      this.sideJob.tail.push(`完成：${taken.ops ?? 0} 条操作`);
      return {
        ok: true,
        handoff: updated,
        taker: taken.taker,
        planId: taken.planId ?? null,
        ops: taken.ops ?? 0,
        recalled: taken.recalled ?? 0,
        recallError: taken.recallError ?? null,
      };
    } finally {
      this.sideJob.running = false;
      this.sideJob.finishedAt = new Date().toISOString();
    }
  }

  /**
   * **把一张待审变更单「转手」给副仓管**（用户 2026-10-07：「为所有待审记忆改动新增按钮『转手』」）。
   *
   * 语义（两步，顺序不能反）：
   *   1. 原单**停在 `handed`**（不应用、也不算"人驳回"）：人没同意这个方案，而是要求**重头再做一遍**；
   *   2. 原单涉及的那些记忆（每条 op 的 `targets`，去重、只要还活着的）**挂进副仓管**。
   *
   * ⚠️ **转手不自动开跑**（用户 2026-10-07 更正：「转手后进入副审阅区，最终由什么模型接手由我启动时决定」）：
   * 这一步只把人送进队列；真正开跑是在**副仓管页**点「接手」的时候 —— 用哪个模型由那一页选的
   * 副仓管角色决定（`settings.keeper.side`），不再逐条问。
   * （`takeOverHandoff({id, model})` → `reorganizeMemories()`）。
   * 所以这里**一个字都不打模型、也不建单** —— 也就不会出现"我还没选模型，它已经用别人的模型跑完了"。
   *
   * @param {{id: string, reason?: string|null}} input 变更单 id
   * @returns {Promise<{ok: boolean, handoff?: object, seeds?: number, queued?: boolean, error?: string}>} 信封
   */
  async handOffPlan({ id, reason = null } = {}) {
    const store = this.ensureStore();
    const planId = String(id ?? '').trim();
    if (planId === '') return { ok: false, error: '缺少 id' };
    const plan = store.getKeeperPlan(planId);
    if (plan == null) return { ok: false, error: `没有这张变更单：${planId}` };
    if (plan.state !== 'open') return { ok: false, error: `这张单已经是 ${plan.state}，不能再转手（${planId}）` };

    // 转手的是「这条改动要动的记忆」：每条 op 的 targets（去重、保序）；坏单没有 targets 时退回成员表。
    const seeds = [];
    const seen = new Set();
    for (const op of Array.isArray(plan.ops) ? plan.ops : []) {
      for (const target of Array.isArray(op?.targets) ? op.targets : []) {
        const targetId = String(target);
        if (targetId === '' || seen.has(targetId)) continue;
        seen.add(targetId);
        seeds.push(targetId);
      }
    }
    if (seeds.length === 0) {
      for (const memberId of Array.isArray(plan.memberIds) ? plan.memberIds : []) {
        const memberKey = String(memberId);
        if (memberKey === '' || seen.has(memberKey)) continue;
        seen.add(memberKey);
        seeds.push(memberKey);
      }
    }
    if (seeds.length === 0) return { ok: false, error: '这张单没有可转手的记忆（没有任何 targets）' };

    const note = typeof reason === 'string' ? reason.trim() : '';
    let handoff;
    try {
      handoff = store.createHandoff({
        runId: plan.runId,
        seedId: seeds[0],
        memberIds: seeds,
        error: note === '' ? `面板转手：原单 ${planId.slice(0, 8)} 等你选模型接手` : note,
      });
    } catch (error) {
      // 挂不上就别动原单（不然"转手"变成一个既没进队列、又没单的死角）。
      return { ok: false, error: `挂到副审阅区失败：${describeError(error)}` };
    }

    // 原单先停：`handed` 是**终态**（不是 approved / rejected —— 那两种都会让人以为"记忆已经按这方案动过"）。
    try {
      store.updateKeeperPlan(planId, {
        state: 'handed',
        review: { handedOff: true, handoffId: handoff.id, at: new Date().toISOString() },
      });
    } catch (error) {
      return { ok: false, error: `标记原单转手失败：${describeError(error)}`, handoff };
    }

    return { ok: true, handoff, seeds: seeds.length, queued: true };
  }

  /**
   * 把一条副仓管记忆从队列里清掉（`state: 'dropped'`）—— **软状态、不删行**。
   *
   * 为什么不是真删：这一行是「某一组曾经整理失败 / 被人转手」的痕迹，删掉就再也说不清当时发生过什么。
   * 清掉只是不再占着队列等人接手。
   *
   * @param {{id: string}} input 副仓管项 id
   * @returns {{ok: boolean, handoff?: object, error?: string}} 信封
   */
  dropHandoff({ id } = {}) {
    try {
      const store = this.ensureStore();
      const handoffId = String(id ?? '').trim();
      if (handoffId === '') return { ok: false, error: '缺少 id' };
      const row = store.getHandoff(handoffId);
      if (row == null) return { ok: false, error: `没有这条副审阅区记忆：${handoffId}` };
      return { ok: true, handoff: store.updateHandoff(handoffId, { state: 'dropped' }) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * 审阅一张变更单并落库 —— **这是新范式下唯一会改记忆库的入口**。
   *
   * ## 绝不自动应用
   * 没有调用过本方法的变更单永远停在 `open`，记忆库一个字都不会变。
   *
   * ## 勾选语义
   * `keep` 是 op 下标数组（0-based），**省略 = 全部**：
   * - `replace`（旧的 `rewrite` 也按它处理）→ **删旧录新**：先 `getMemory(target)` 预检
   *   （拿不到 / 已软删 → 跳过，绝不半途动手），再 `addMemory` 拿**新 id**，然后
   *   `softDeleteMemory(原 id, {note:'keeper:replace'})`（软删 = 可恢复）+ 清原条向量，
   *   最后 `scheduleEmbed(新 id)`；新条记 `meta.replaces` / `meta.replacedAt` / `meta.model`，
   *   新 id 写回该 op 的 `newId`（面板显示「新记忆 id」）；**新条 `tidyScore = 1`**（仓管产出的初始整理指数）；
   * - `split`   → 第 1 块 `updateMemoryText`，其余 `addMemory({source:'仓管研磨', kind:'keeper', meta:{derivedFrom}, tidyScore:1})`；
   * - `merge`   → `updateMemoryText(targets[0], after, {note:'keeper:merge', meta:{...meta, merged:[{from,at,reason}]}})`
   *               + 其余 `softDeleteMemory`。**被并掉的 id 必须记进保留条的 `meta.merged`** ——
   *               `revertKeeper()` 就是靠 `listKeeperArtifacts().merged` 里这个数组找回它们的；
   * - `drop`    → `softDeleteMemory`（软删=可恢复）。`memories` 行上**不留 meta 痕迹**，
   *   所以 `revertKeeper()` 改成从**已应用变更单里的 `drop` op** 找回目标并 `restoreMemory()`
   *   —— `propose-drop` 与仓管自己出的 drop op 走的是同一条回滚路。
   *
   * 每条应用后都会 `scheduleEmbed(...)`（正文变了向量就作废，必须重算）；
   * 被软删的那些还会顺手 `deleteVector`，免得留下「有向量没正文」的幽灵命中。
   *
   * @param {{id: string, keep?: number[]|null, edits?: Record<string, unknown>, reject?: boolean}} input 审阅决定
   * @returns {Promise<object>} `{ok, applied:{replace,split,merge,drop}, replaced:[{from,to}], skipped, state}`
   */
  async reviewKeeperPlan({ id, keep = null, edits = {}, reject = false } = {}) {
    const store = this.ensureStore();
    const planId = String(id ?? '').trim();
    if (planId === '') return { ok: false, error: '缺少 id' };

    const plan = store.getKeeperPlan(planId);
    if (plan == null) return { ok: false, error: `没有这张变更单：${planId}` };
    if (plan.state !== 'open') {
      return { ok: false, error: `变更单已是 ${plan.state}，不能重复审阅（${planId}）` };
    }

    const ops = Array.isArray(plan.ops) ? plan.ops : [];
    const stamp = new Date().toISOString();
    const applied = { replace: 0, split: 0, merge: 0, drop: 0 };
    /** @type {{from: string, to: string}[]} 本次落库的每一次「删旧录新」（旧 id → 新 id）。 */
    const replaced = [];

    // 整单驳回：只标记，记忆库一个字都不碰。
    if (reject === true) {
      store.updateKeeperPlan(planId, {
        state: 'rejected',
        review: { reject: true, at: stamp, ops: ops.length },
        reviewedAt: stamp,
      });
      return { ok: true, applied, replaced, skipped: ops.length, noReason: 0, state: 'rejected' };
    }

    const selected = keep == null
      ? new Set(ops.map((_op, index) => index))
      : new Set(
          (Array.isArray(keep) ? keep : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < ops.length),
        );
    const scope = this.resolvedConfig().scope;

    const softDrop = (memoryId, note) => {
      const done = store.softDeleteMemory(memoryId, { note });
      if (done) {
        // 软删的正文取不到了，旧向量必须显式删掉（否则检索里会出现 text:null 的幽灵项）。
        try {
          store.deleteVector(memoryId);
        } catch {
          /* 向量删除失败不影响软删结果：它只是派生物 */
        }
      }
      return done;
    };

    let skipped = 0;
    /** 被跳过的删除里有几条是**没写理由**的（面板/工具要能如实说出来，不能混进普通 skipped）。 */
    let noReason = 0;
    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index];
      if (!selected.has(index)) {
        skipped += 1;
        continue;
      }
      const type = String(op?.type ?? '');
      const targets = (Array.isArray(op?.targets) ? op.targets : []).map((value) => String(value));
      const edited = edits != null && typeof edits === 'object' ? edits[index] ?? edits[String(index)] : undefined;
      const afterRaw = edited === undefined ? op?.after : edited;
      if (targets.length === 0) {
        skipped += 1;
        continue;
      }

      try {
        if (type === 'replace' || type === 'rewrite') {
          // 统一修改语义（用户 2026-10-07 拍板）：**删旧录新**。旧的 `rewrite` 也走这条分支 ——
          // 系统里**没有**「原地改写同一条」这条老路径。
          const after = typeof afterRaw === 'string'
            ? afterRaw
            : Array.isArray(afterRaw)
              ? afterRaw.map((piece) => String(piece ?? '').trim()).filter((piece) => piece !== '').join('\n')
              : '';
          if (after.trim() === '') {
            skipped += 1;
            continue;
          }
          // ① 预检：拿不到 / 已软删就**一个字都不动**（绝不半途动手）。
          const target = store.getMemory(targets[0]);
          if (target == null) {
            skipped += 1;
            continue;
          }
          // 新正文与原文一字不差 = 没有修改。这一条同时是安全闸：`addMemory` 按正文 hash 去重，
          // 若 after 撞上原条自己的 hash，会回**原条 id**，接着「软删原条」就把新记忆也删了。
          if (after === String(target.text)) {
            skipped += 1;
            continue;
          }
          // ② 录入新记忆：原 scope / kind / source 照抄（source 空则给个默认），meta 只带上
          //    「出处」类字段（仓管自己的回滚凭据一律不继承，见 REPLACE_META_DROP）。
          const meta = {};
          for (const [key, value] of Object.entries(target.meta ?? {})) {
            if (REPLACE_META_DROP.has(key)) continue;
            meta[key] = value;
          }
          meta.replaces = String(targets[0]);
          meta.replacedAt = stamp;
          // **署名认这张单自己的**（`keeper_plans.model`），不认"主仓管那一轮" ——
          // 以前读 `this.keeper?.model`，副仓管接手的单会被盖成主仓管的模型名（用户 2026-10-08：
          // 「主副仓管独立，各自的运行不能互相产生干扰」）。老单没有这一列 = `null`（不知道，不假装）。
          meta.model = plan.model ?? null;
          const created = store.addMemory({
            text: after,
            scope: target.scope,
            kind: target.kind,
            source: target.source == null || String(target.source).trim() === '' ? '仓管改写' : String(target.source),
            meta,
            // 计分（口径 3）：仓管替换出的新记忆，整理指数初始 = 1（字面：初始 0 再 +1）。
            tidyScore: 1,
          });
          if (created.created !== true) {
            // 正文撞上库里**另一条活着的**记忆（它是既有的、不是本轮产物）：这条 op 不动手。
            // 否则回滚时的「真删本轮新记忆」会误删别人的数据，而原条又已经被软删 —— 那是数据事故。
            skipped += 1;
            continue;
          }
          // ③ 删除原记忆：软删（系统默认的「删除」，行仍在、可恢复），并清掉它的向量 ——
          //    软删的行若还能被语义搜到就是幽灵命中。
          softDrop(targets[0], 'keeper:replace');
          // ④ 新记忆排队补向量；新 id 写回 op（面板显示「新记忆 id」）。
          this.scheduleEmbed(created.id);
          op.newId = String(created.id);
          applied.replace += 1;
          replaced.push({ from: String(targets[0]), to: String(created.id) });
        } else if (type === 'split') {
          const blocks = (Array.isArray(afterRaw) ? afterRaw : [afterRaw])
            .map((piece) => String(piece ?? '').trim())
            .filter((piece) => piece !== '');
          if (blocks.length === 0) {
            skipped += 1;
            continue;
          }
          store.updateMemoryText(targets[0], blocks[0], { note: 'keeper:split' });
          this.scheduleEmbed(targets[0]);
          for (const piece of blocks.slice(1)) {
            const created = store.addMemory({
              text: piece,
              scope,
              source: '仓管研磨',
              kind: 'keeper',
              meta: { derivedFrom: targets[0], at: stamp },
              // 计分（口径 3）：split 派生出的碎片也是「仓管产出的新记忆」→ 整理指数初始 = 1。
              // 第 1 块是**既有行**（走 updateMemoryText），它的 tidy 已在进组时加过，不在这里重复加。
              tidyScore: 1,
            });
            if (created.created === true) this.scheduleEmbed(created.id);
          }
          applied.split += 1;
        } else if (type === 'merge') {
          const after = typeof afterRaw === 'string' ? afterRaw : Array.isArray(afterRaw) ? afterRaw.join('\n') : '';
          if (after === '') {
            skipped += 1;
            continue;
          }
          // ⚠️ 合并痕迹必须**先写进保留条的 meta**，`revertKeeper()` 才找得到被并掉的那些：
          // 它读的是 `listKeeperArtifacts().merged`（`meta LIKE '%"merged"%'`）里的 `meta.merged[].from`。
          // 这里是新范式漏写的那一半 —— 旧 `dedupePass` 写、`reviewKeeperPlan` 不写，后果不是「没落库」
          // （被并的条确实软删了），而是**回滚找不到它们**：实测合并痕迹恒 0，
          // 「所有改动可一键回滚」对 merge 不成立。元素形状沿用旧痕迹 `{from, at, reason}`，
          // 于是一条 revert 分支同时吃两代数据，**`revertKeeper()` 的逻辑一个字都不用改**。
          const retained = store.getMemory(targets[0]);
          if (retained == null) {
            // 保留条拿不到（不存在 / 已被软删）就别动手：先软删其余条再改写会留下「删了却没痕迹」的孤儿，
            // 那比跳过这条 op 危险得多（`updateMemoryText` 对不存在的行本来也会抛）。
            skipped += 1;
            continue;
          }
          const reason =
            typeof op?.reason === 'string' && op.reason.trim() !== '' ? op.reason.trim() : '同一件事（合并）';
          const meta = { ...(retained.meta ?? {}) };
          meta.merged = [
            ...(Array.isArray(meta.merged) ? meta.merged : []),
            ...targets.slice(1).map((memoryId) => ({ from: memoryId, at: stamp, reason })),
          ];
          store.updateMemoryText(targets[0], after, { note: 'keeper:merge', meta });
          this.scheduleEmbed(targets[0]);
          for (const memoryId of targets.slice(1)) softDrop(memoryId, 'keeper:merge');
          applied.merge += 1;
        } else if (type === 'drop') {
          // 用户 2026-10-07：「仓管对整理记忆提出『删除』时必须附带理由」「仓管禁止触碰删除功能本身」。
          // 落点就在这一行：**没写理由的删除永远不应用** —— 人在面板上勾了也跳过（如实记 skipped /
          // noReason），所以"仓管想删就删"这条路在代码上不存在；`normalizePlanOps()` 已经把
          // `reasonMissing` 标在 op 上，这里再按 `reason` 原文兜一次（面板手改 / 旧单也吃得住）。
          const dropReason = String(op?.reason ?? '').trim();
          if (op?.reasonMissing === true || dropReason === '') {
            skipped += 1;
            noReason += 1;
            continue;
          }
          // 理由随 history 一起留痕：`keeper:drop（理由）` —— 事后能查到"当时凭什么删的"。
          const note = `keeper:drop（${dropReason.length > 120 ? `${dropReason.slice(0, 120)}…` : dropReason}）`;
          for (const memoryId of targets) softDrop(memoryId, note);
          applied.drop += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        skipped += 1;
        this.ctx.logger?.warn?.(`${PLUGIN_ID}: 应用变更单 ${planId} 的第 ${index} 条 op 失败：${describeError(error)}`);
      }
    }

    const state = skipped > 0 ? 'partial' : 'approved';
    store.updateKeeperPlan(planId, {
      state,
      review: { keep: keep == null ? null : [...selected], edits: edits ?? {}, applied, replaced, skipped, noReason, at: stamp },
      reviewedAt: stamp,
      // 把改过的 ops 一起写回：`replace` 落库后 op 上多了 `newId`（面板审阅完刷新时要能读到）。
      ops,
    });
    // 刚拍板的事进「热列表」：下一步就注入（最多 3 条，`newId` 优先 —— 那是真正落库的新正文）。
    const engine = this.ensureRecall();
    if (engine !== null) {
      const fresh = [];
      for (const op of ops) {
        if (String(op?.newId ?? '') !== '') fresh.push(op.newId);
        for (const target of Array.isArray(op?.targets) ? op.targets : []) fresh.push(target);
      }
      let added = 0;
      for (const id of [...new Set(fresh)]) {
        if (added >= 3) break;
        const row = store.getMemory(String(id));
        // 只放**活着**的条：merge / replace 之后原条是软删的，`getMemory` 拿不到正文 ——
        // 那就会在提示词里留下一行只有编号、没有内容的空话（真机看到过），纯噪音，直接跳过。
        if (row == null) continue;
        engine.noteHot(String(id), String(row.text ?? ''));
        added += 1;
      }
    }
    return { ok: true, applied, replaced, skipped, noReason, state };
  }

  /**
   * 回滚仓管做过的一切：删掉研磨产物、把被改写的原文按 history 恢复、把被合并 / 被替换的放回来。
   *
   * 四类痕迹（`listKeeperArtifacts()` 分桶）+ 第五类（变更单里的 `drop` op）：
   * - `derived`：研磨产物 → **真删**；
   * - `rewritten`：历史遗留的直改痕迹 → 按 history 最早一条 `keeper:*` 的 `prev_text` 恢复；
   * - `merged`：被合并软删的条 → `restoreMemory()` 放回来；
   * - `replaced`：`replace`（删旧录新）产出的**新记忆** → **真删新记忆**（它本来就是本轮产物）
   *   并把 `meta.replaces` 指向的**原记忆放回来**（原条是软删，可恢复）；
   * - `drop`（2026-10-07 新增，`propose-drop` 与仓管出的 drop op 共用）：**软删的行上没有 meta
   *   痕迹可找**，所以改成扫**已应用**的变更单（`approved` / `partial`）里的 `drop` op，
   *   按它的 `targets` 把目标放回来（`restoreMemory()`，已经放回来的自然跳过）。
   *
   * @returns {object} 回滚统计
   */
  revertKeeper() {
    const store = this.ensureStore();
    let removedDerived = 0;
    let restored = 0;
    let revived = 0;
    let removedReplaced = 0;
    let restoredOriginal = 0;
    let restoredDropped = 0;
    try {
      const { derived, rewritten, merged, replaced } = store.listKeeperArtifacts();

      for (const row of derived) {
        if (store.hardDeleteMemory(row.id, { note: 'keeper:revert' }) === true) removedDerived += 1;
      }

      for (const row of rewritten) {
        const history = store.listHistory(row.id, { limit: 100 });
        const anchor = history.find(
          (entry) => entry.op === 'supersede' && String(entry.note ?? '').startsWith('keeper:') && String(entry.prev_text ?? '') !== '',
        );
        if (anchor == null) continue;
        const meta = { ...(row.meta ?? {}) };
        delete meta.keeper;
        store.updateMemoryText(row.id, String(anchor.prev_text), { note: 'keeper:revert', meta });
        this.scheduleEmbed(row.id);
        restored += 1;
      }

      for (const row of merged) {
        for (const entry of Array.isArray(row.meta?.merged) ? row.meta.merged : []) {
          if (entry?.from != null && store.restoreMemory(String(entry.from)) === true) revived += 1;
        }
        const meta = { ...(row.meta ?? {}) };
        delete meta.merged;
        const current = store.getMemory(row.id);
        if (current != null) store.updateMemoryText(row.id, String(current.text), { note: 'keeper:revert', meta });
      }

      for (const row of replaced) {
        // 这一桶里是 `replace` 产出的**新记忆**（`meta.replaces` = 被替换掉的旧 id）：
        // 新记忆真删（它本来就是本轮产物），原记忆放回来（软删=可恢复，正文一个字没动）。
        const from = row.meta?.replaces == null ? '' : String(row.meta.replaces);
        if (store.hardDeleteMemory(row.id, { note: 'keeper:revert' }) === true) removedReplaced += 1;
        if (from !== '' && store.restoreMemory(from) === true) {
          restoredOriginal += 1;
          // 原记忆正文没变（replace 走的是新增 + 软删，不是 updateMemoryText），但它回来之后
          // 向量已被清掉 → 重新排队补，否则它会落到「关键词能搜、语义搜不到」。
          this.scheduleEmbed(from);
        }
      }

      // 第五类痕迹：已应用变更单里的 `drop` op。软删的行上**没有 meta 痕迹**（`softDeleteMemory`
      // 只填 deleted_at），所以只能从变更单本身找回目标 —— `propose-drop` 与仓管出的 drop op
      // 都在这条路上。已放回来的条 `restoreMemory()` 回 false，天然幂等。
      for (const state of ['approved', 'partial']) {
        for (const plan of store.listKeeperPlans({ state })) {
          for (const op of Array.isArray(plan.ops) ? plan.ops : []) {
            if (String(op?.type ?? '') !== 'drop') continue;
            for (const target of Array.isArray(op.targets) ? op.targets : []) {
              const memoryId = String(target);
              if (store.restoreMemory(memoryId) === true) {
                restoredDropped += 1;
                // 软删时向量被清掉了，放回来必须重新排队补，否则语义检索搜不到它。
                this.scheduleEmbed(memoryId);
              }
            }
          }
        }
      }

      const left = store.listKeeperArtifacts();
      return {
        ok: true,
        removedDerived,
        restored,
        revived,
        removedReplaced,
        restoredOriginal,
        restoredDropped,
        remaining: {
          derived: left.derived.length,
          rewritten: left.rewritten.length,
          merged: left.merged.length,
          replaced: left.replaced.length,
        },
      };
    } catch (error) {
      return { ok: false, error: describeError(error), removedDerived, restored, revived, removedReplaced, restoredOriginal, restoredDropped };
    }
  }

  /** 回填任务的可公开状态。 */
  publicBackfill() {
    if (this.backfill === null) {
      return {
        running: false,
        startedAt: null,
        finishedAt: null,
        done: 0,
        total: 0,
        failed: 0,
        error: null,
        mode: null,
        space: null,
        model: null,
        dims: null,
      };
    }
    const { running, startedAt, finishedAt, done, total, failed, error, mode, space, model, dims } = this.backfill;
    return { running, startedAt, finishedAt, done, total, failed, error, mode: mode ?? 'missing', space: space ?? null, model, dims };
  }

  /**
   * 为记忆补齐 / 重算嵌入。**异步后台跑**，调用方轮询 `publicBackfill()`。
   *
   * 两种模式（对应原型的 backfill 与 rebuild 两颗按钮）：
   * - `mode: 'missing'`（默认）**只补缺的**：已在这个空间里算过的记忆一行都不碰。
   *   所以：新写入 → 补它一条；切到新模型 → 全库都缺 → 全量补齐；
   *   **切回旧模型 → 只缺「离开期间新增的」→ 只补那几条**。
   * - `mode: 'all'`**强制全量重算**：不管缺不缺，把这个空间的每条记忆都用当前模型重算一遍
   *   （同 id 原地覆盖，断了可以再点一次，不会丢数据）。用在「怀疑空间里的向量不纯」
   *   「改过文本但向量没跟上」这类场景。
   *
   * 原项目的教训：长任务若做成同步 HTTP，客户端会先超时/被重置。这里一律后台 + 轮询。
   * @param {{ batchSize?: number, limit?: number, apiKeyRef?: string, spaceKey?: string | null,
   *   mode?: 'missing' | 'all' }} [input] - 参数。
   * @returns {Promise<object>} 启动结果（含初始状态）
   */
  async startBackfill({ batchSize = null, limit = 0, apiKeyRef = null, spaceKey = null, mode = 'missing' } = {}) {
    if (this.backfill?.running === true) {
      return { ok: false, error: '已有回填任务在跑', backfill: this.publicBackfill() };
    }
    const rebuild = String(mode) === 'all';
    const store = this.ensureStore();
    const cfg = this.resolvedConfig();
    const space = this.embeddingSpace(cfg);
    const target = spaceKey == null ? space.key : String(spaceKey);
    const ref = apiKeyRef ?? cfg.embedding.apiKeyRef;
    const resolved = await this.resolveKey(ref);

    const pending = [];
    if (rebuild) {
      for (const { id } of store.listTexts({ batchSize: 500 })) pending.push(id);
    } else {
      for (const { id } of store.listTextsMissingVector(target, { batchSize: 500 })) pending.push(id);
    }
    const slice = limit > 0 ? pending.slice(0, limit) : pending;

    const job = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      done: 0,
      total: slice.length,
      failed: 0,
      error: null,
      mode: rebuild ? 'all' : 'missing',
      space: target,
      model: space.model,
      dims: space.dims,
      keySource: resolved.source,
    };
    this.backfill = job;

    if (resolved.value === null && cfg.embedding.provider !== 'local-hash') {
      job.running = false;
      job.error = `没有可用的密钥（credentials 与环境变量 ${ref} 都是空）`;
      job.finishedAt = new Date().toISOString();
      return { ok: false, error: job.error, backfill: this.publicBackfill() };
    }
    if (slice.length === 0) {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      return {
        ok: true,
        started: false,
        message: rebuild ? '库里还没有可重算的记忆' : '这个空间里所有记忆都已有向量',
        backfill: this.publicBackfill(),
      };
    }

    void this.runBackfill(store, cfg, resolved.value, slice, batchSize ?? cfg.embedding.batchSize, job);
    return { ok: true, started: true, mode: job.mode, keySource: resolved.source, space: target, backfill: this.publicBackfill() };
  }

  /**
   * 后台回填主循环。
   * @param {import('../src/host/store.js').MemoryStore} store - 仓储
   * @param {object} cfg - 解析后的配置
   * @param {string} apiKey - 嵌入密钥
   * @param {string[]} ids - 待回填的记忆 id
   * @param {number} batchSize - 每批条数
   * @param {object} job - 任务状态对象（就地更新）
   * @returns {Promise<void>} 完成即返回
   */
  async runBackfill(store, cfg, apiKey, ids, batchSize, job) {
    try {
      const embedder = createEmbedder(cfg.embedding, { apiKey });
      // 配置可能在补齐过程中被切换：指纹对不上就停手，绝不把向量写进别的空间。
      if (job.space != null && embedder.fingerprint !== job.space) {
        throw new Error(`配置在补齐过程中被切换（任务空间 ${job.space}，当前 ${embedder.fingerprint}）；请对新配置重新补齐`);
      }
      store.setActiveSpace({ key: embedder.fingerprint, provider: embedder.provider, model: embedder.model, dims: embedder.dims });
      const size = Math.max(1, Number(batchSize) || 16);
      for (let offset = 0; offset < ids.length; offset += size) {
        const slice = ids.slice(offset, offset + size);
        const texts = slice.map((id) => store.getMemory(id)?.text ?? '');
        const vectors = await embedder.embed(texts);
        for (let i = 0; i < slice.length; i += 1) {
          store.putVector({
            memoryId: slice[i],
            space: embedder.fingerprint,
            provider: embedder.provider,
            model: embedder.model,
            dims: embedder.dims,
            vector: vectors[i],
          });
          job.done += 1;
        }
      }
      job.running = false;
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.running = false;
      job.error = describeError(error);
      job.finishedAt = new Date().toISOString();
    }
  }

  /**
   * 混合检索：**只在当前配置对应的那个空间里**做向量检索。
   *
   * 库里可能同时保留着好几套向量（换过模型没删），所以：
   * - 空间里一条向量都没有 → 明确回「需补齐」，降级为关键词（绝不拿别的空间的向量硬凑）；
   * - 空间里有向量但不齐 → 用已有的算，并在返回里带上 `missing`，让调用方知道「还有 N 条只有关键词」。
   *
   * @param {{ query: string, limit?: number, scope?: string|null }} input - 查询
   * @returns {Promise<object>} 结果
   */
  async searchText({ query, limit = 8, scope = null }) {
    const store = this.ensureStore();
    const cfg = this.resolvedConfig();
    const started = Date.now();
    const space = this.embeddingSpace(cfg);
    const inSpace = store.countVectors(space.key);
    const missing = store.countMissingVectors(space.key);
    let queryVector = null;
    /** @type {string|null} */
    let vectorError = null;
    let vectorUsed = false;

    const trimmed = String(query ?? '').trim();
    if (trimmed !== '') {
      if (inSpace === 0) {
        vectorError = `当前嵌入空间（${space.key}）里还没有向量，需补齐索引`;
      } else {
        try {
          const resolved = await this.resolveKey(cfg.embedding.apiKeyRef);
          if (resolved.value === null && cfg.embedding.provider !== 'local-hash') {
            vectorError = `没有可用的密钥 ${cfg.embedding.apiKeyRef}`;
          } else {
            const embedder = createEmbedder(cfg.embedding, { apiKey: resolved.value ?? null });
            if (embedder.fingerprint !== space.key) {
              vectorError = `嵌入器指纹 ${embedder.fingerprint} 与空间 ${space.key} 不一致，需补齐索引`;
            } else {
              const [vec] = await embedder.embed([trimmed]);
              queryVector = vec;
              vectorUsed = true;
            }
          }
        } catch (error) {
          vectorError = describeError(error);
        }
      }
    }

    const hits = hybridSearch(store, { query: trimmed, queryVector, limit, scope, space: vectorUsed ? space.key : null });
    const items = hits.map((hit) => {
      const memory = store.getMemory(hit.id);
      return {
        id: hit.id,
        score: Number(hit.score.toFixed(6)),
        keywordScore: hit.keywordScore,
        vectorScore: Number(Number(hit.vectorScore).toFixed(4)),
        text: memory?.text ?? null,
        source: memory?.source ?? null,
        section: memory?.section ?? null,
        kind: memory?.kind ?? null,
        createdAt: memory?.created_at ?? null,
        // 两个行为计数器随命中一起带出来（面板搜索行画小 Tag 用；数据本来就在手里，零额外查询）。
        readScore: Number(memory?.readScore ?? 0),
        tidyScore: Number(memory?.tidyScore ?? 0),
      };
    });
    return {
      ok: true,
      query: trimmed,
      limit,
      count: items.length,
      vectorUsed,
      vectorError,
      activeSpace: { ...space, vectors: inSpace, missing },
      tookMs: Date.now() - started,
      items,
    };
  }

  // ── 自检 ──────────────────────────────────────────────────────────────────────

  /** 自检入口：一切异常都收进 JSON，绝不让 webserver 折成 400 空响应。 */
  async ping() {
    try {
      return json(await this.snapshot());
    } catch (error) {
      return json({ ok: false, error: describeError(error) }, 500);
    }
  }

  /** 一次性回答「插件活着吗、库开了吗、哪些能力可用吗」。 */
  async snapshot() {
    this.imports ??= await probeImports();
    const sqlite = await probeSqlite();
    const get = (key) => {
      try {
        return this.ctx.get(key) !== undefined;
      } catch {
        return false;
      }
    };
    return {
      ok: true,
      plugin: PLUGIN_ID,
      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      at: new Date().toISOString(),
      runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
      probes: {
        sqlite,
        imports: this.imports,
        provide: this.provideResult,
        webRoute: this.webRoute,
        panelRoutes: this.panelRoutes,
        promptSection: this.promptSection,
        recall: this.recallStatus(),
        skill: this.skill,
        toolRegistration: this.toolProbe(),
        services: {
          connection: get('connection'),
          tools: get('tools'),
          systemPrompt: get('systemPrompt'),
          llm: get('llm'),
          credentials: get('credentials'),
          skills: get('skills'),
          webServer: get('webServer'),
        },
      },
      dataDir: this.dataDir,
      dataDirExists: existsSync(this.dataDir),
      store: this.storeStats(),
      backfill: this.publicBackfill(),
    };
  }

  /** 工具探针（懒执行一次）。 */
  toolProbe() {
    this.toolProbeResult ??= probeToolRegistration(this.ctx);
    return this.toolProbeResult;
  }

  // ── 诊断路由 ──────────────────────────────────────────────────────────────────

  /**
   * 诊断路由的 raw node:http 处理器。
   * 支持：`GET /ping`、`POST /import`、`POST /backfill`、`GET /search`、`GET /embed`、`GET|POST /credential`。
   * @param {import('node:http').IncomingMessage} req - 请求
   * @param {import('node:http').ServerResponse} res - 响应
   */
  async serveDiagnostic(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.internal');
    const sub = url.pathname.slice(DIAG_PREFIX.length) || '/';
    const send = (status, value) => {
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify(value, null, 2));
    };
    const bodyJson = async () => {
      const raw = await readBody(req);
      return raw.length > 0 ? JSON.parse(raw) : {};
    };
    try {
      if (sub === '/' || sub === '/ping') {
        send(200, await this.snapshot());
        return;
      }
      if (sub === '/import') {
        const input = req.method === 'POST' ? await bodyJson() : Object.fromEntries(url.searchParams);
        send(200, await this.importLegacy({ file: input.file, scope: input.scope ?? null, dryRun: input.dryRun === true || input.dryRun === 'true' }));
        return;
      }
      if (sub === '/backfill') {
        const input = req.method === 'POST' ? await bodyJson() : Object.fromEntries(url.searchParams);
        send(200, await this.startBackfill({
          batchSize: input.batchSize === undefined ? null : Number(input.batchSize),
          limit: input.limit === undefined ? 0 : Number(input.limit),
          apiKeyRef: input.apiKeyRef ?? null,
        }));
        return;
      }
      if (sub === '/clean') {
        const input = req.method === 'POST' ? await bodyJson() : Object.fromEntries(url.searchParams);
        send(200, await this.cleanDuplicatedSection({
          dryRun: input.dryRun === undefined ? true : input.dryRun === true || input.dryRun === 'true',
          limit: input.limit === undefined ? 0 : Number(input.limit),
        }));
        return;
      }
      if (sub === '/llm-probe') {
        const sink = { kinds: new Set() };
        let text = '';
        let error = null;
        try {
          text = await this.createLlmClient().chat({
            messages: [
              { role: 'system', content: '只回答两个字，不要标点。' },
              { role: 'user', content: url.searchParams.get('q') ?? '说「收到」' },
            ],
            maxTokens: Number(url.searchParams.get('maxTokens') ?? 512),
            sink,
          });
        } catch (e) {
          error = describeError(e);
        }
        send(200, {
          ok: error === null,
          error,
          provider: sink.provider ?? null,
          model: sink.model ?? null,
          chunkCount: sink.chunkCount ?? 0,
          chunkKinds: [...(sink.kinds ?? [])],
          textLength: text.length,
          text: text.slice(0, 200),
        });
        return;
      }
      if (sub === '/pending') {
        send(200, this.pendingBatches());
        return;
      }
      if (sub === '/search') {        send(200, await this.searchText({
          query: url.searchParams.get('q') ?? '',
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 8,
          scope: url.searchParams.get('scope'),
        }));
        return;
      }
      if (sub === '/embed') {
        const probe = await this.embedProbe({
          text: url.searchParams.get('q') ?? undefined,
          model: url.searchParams.get('model') ?? undefined,
          dimensions: url.searchParams.has('dims') ? Number(url.searchParams.get('dims')) : undefined,
          apiKey: url.searchParams.get('apiKey') ?? undefined,
        });
        send(200, probe);
        return;
      }
      if (sub === '/credential') {
        const input = req.method === 'POST' ? await bodyJson() : Object.fromEntries(url.searchParams);
        const ref = input.ref ?? this.resolvedConfig().embedding.apiKeyRef;
        const credentials = this.ctx.get('credentials');
        if (credentials === undefined) {
          send(500, { ok: false, error: 'credentials 服务未挂载' });
          return;
        }
        if (typeof input.value === 'string' && input.value.length > 0) {
          await credentials.set(ref, input.value);
        }
        const described = await credentials.describe(ref).catch((error) => describeError(error));
        send(200, { ok: true, ref, written: typeof input.value === 'string' && input.value.length > 0, described });
        return;
      }
      send(404, { ok: false, error: `未知诊断路径 ${sub}` });
    } catch (error) {
      send(500, { ok: false, error: describeError(error) });
    }
  }

  /**
   * 在**宿主进程内**打一次真实嵌入往返。
   *
   * 为什么要放在宿主里测：本机沙箱化的 shell 拿不到 TLS 凭据
   * （`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`），
   * 命令行发不出 HTTPS；宿主进程的 Node fetch（走 `dsh-http-proxy` 装的全局 dispatcher）
   * 才是插件真实运行环境。
   * @param {{text?: string, model?: string, dimensions?: number, baseUrl?: string, apiKeyRef?: string, apiKey?: string}} input - 覆盖项
   * @returns {Promise<object>} 往返结果
   */
  async embedProbe(input = {}) {
    const cfg = this.resolvedConfig().embedding;
    const ref = input.apiKeyRef ?? cfg.apiKeyRef;
    const resolved = input.apiKey
      ? { source: 'request(仅本次，不落盘)', value: input.apiKey, described: null }
      : await this.resolveKey(ref);
    const result = {
      baseUrl: input.baseUrl ?? cfg.baseUrl,
      model: input.model ?? cfg.model,
      dimensions: input.dimensions ?? cfg.dimensions,
      keySource: resolved.source,
      keyDescribed: resolved.described,
      ok: false,
      error: null,
      returnedDims: null,
      count: null,
      usage: null,
      elapsedMs: null,
    };
    if (resolved.value === null) {
      result.error = `没有可用的密钥（credentials 与环境变量 ${ref} 都是空）`;
      return result;
    }
    const started = Date.now();
    try {
      const response = await fetch(`${String(result.baseUrl).replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${resolved.value}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: result.model,
          input: [input.text ?? '宝宝喜欢喝冰美式咖啡'],
          dimensions: result.dimensions,
        }),
      });
      result.elapsedMs = Date.now() - started;
      const text = await response.text();
      if (!response.ok) {
        result.error = `HTTP ${response.status}: ${text.slice(0, 400)}`;
        return result;
      }
      const payload = JSON.parse(text);
      const first = payload?.data?.[0]?.embedding;
      result.returnedDims = Array.isArray(first) ? first.length : null;
      result.count = Array.isArray(payload?.data) ? payload.data.length : null;
      result.usage = payload?.usage ?? null;
      result.ok = result.returnedDims !== null;
      if (!result.ok) result.error = `响应里没有 embedding：${text.slice(0, 300)}`;
      return result;
    } catch (error) {
      result.elapsedMs = Date.now() - started;
      result.error = describeError(error);
      return result;
    }
  }
}

/**
 * `MemoryService` 与 `registerMemoryTools` 也导出，**只为测试**：`apply()` 之外没人用。
 *
 * 收益是 `test/export-scope.test.js` 能用一个假 ctx 直接构造服务、抓住注册的工具定义，
 * 钉住「省略 scope = 默认作用域 / 显式 null = 全部 / allScopes 优先」这条接线——
 * 它以前只活在文档里，`scope ?? cfg.scope` 把显式 null 吃掉也没人发现。
 */
export { MemoryService, registerMemoryTools };

/**
 * 插件入口。
 * @param {any} ctx - 插件上下文。
 * @param {object} [config] - 插件配置。
 */
export function apply(ctx, config) {
  const service = new MemoryService(ctx, config ?? {});
  // 启动时做一次懒衰减（幂等）：距上次 ≥7 整周才真正乘；首次启用只写起点时间戳，不乘。
  // `maybeDecayScores()` 内部自己收异常，因此打不开库也不会拖垮插件加载。
  service.maybeDecayScores();
}
