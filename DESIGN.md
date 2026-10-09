# dsh-memory 设计契约（跨阶段）

这份文件记录**经实测确认、后续阶段必须遵守**的技术约束与设计决定。
每一条都有证据来源；改了这里的约定就要同步改代码与测试。

---

## A. 平台约束：本插件只能零裸导入

**事实**：`@deepseek-ai/*` 这些包**在磁盘上不存在**，只活在
`…\DeepSeek Harness\resources\app.asar` 里。已核实：
`~\.dsh\profiles\node_modules` 不存在；在 `~\.dsh` 与安装目录下递归搜 `dsh-tools` **零命中**；
运行时 node 的 `node_modules` 只有一个 `README.txt`。

**结论**：源码里**不得出现** `import '@deepseek-ai/...'`（宿主半与客户端半都是）。
只能 import `node:*` 内置模块。（客户端半另受模块系统约束，见 §E。）

**替代路径**（均已实测可用）：

| 能力 | 不 import 的用法 |
|---|---|
| Cordis 服务 | `ctx.reflect.provide(name, obj)` |
| 原生工具 | `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })` |
| 系统提示段 | `ctx.systemPrompt.section({ name, order, text })`（DSH 无 memory 槽位，用 order `2500`） |
| Skill | `ctx.skills.register({ name, description, whenToUse, content, source, modelInvocable, userInvocable })` |
|    | ⚠️ 字段名是 **`content`**（不是 `body`），且 **`source` 必填且必须是字符串**。两者缺任一，`register()` 都会成功，但用 `skill` 工具加载时报「source must be a string」/「content must be a string」—— 注册成功却不可用，只能靠真调一次 `skill` 工具才发现。 |
| LLM | `ctx.llm.stream({ provider, model, messages })` |
| 密钥 | `ctx.credentials.resolve/set/describe(ref)` |
| 持久化 | `node:sqlite` |
| 面板通信 | `ctx.connection.fetch.register(...)` + webserver 前缀路由 |

**注意 `ctx.tools.register` 的 `parameters` 必须是「已编译」的 JSON Schema 子集**，
不是作者侧 DSL（那是 `defineTool` 的入参，而 `defineTool` 我们 import 不到）。
已实测可用形状：`{ type: 'object', additionalProperties: false, properties: {}, required: [] }`。

---

## B. `/api` 精确路由必须声明 `requestBody`

`ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 里的
**`requestBody: 'buffered'` 是必需的**。上游 `assertFetchRoute` 只校验 path 与 methods，
漏写它时 `/api` 桥接层拿到的 bodyMode 是 `undefined`，会走流式分支构造
`new Request(url, { method: 'GET', body: Readable.toWeb(req), duplex: 'half' })`，
WHATWG 构造器拒绝「GET 带 body」而抛错 → webserver 把 handler 抛错统一折成 **400 空响应**。
浏览器侧只能看到「HTTP 400：响应不是 JSON」，完全看不出真正原因。

另一条推论：**任何 handler 都要自己把异常收进 JSON 再回答**，否则错误信息会变成 400 空响应。

**安全红线**：绝不用 `ctx.webServer.register` 注册 `/api/**` 的 **exact** 路由 ——
webserver 先查 exact 表再查 prefix 表，那样会绕过 `dsh-connection` 的 Host/Origin 栅栏与 Cookie 鉴权。

**路由表按 pathname 建键**：`registerFetchRoute` 里有
`if (this.fetchRoutes.has(route.path)) throw new Error('… already registered')`。
所以同一路径的 GET 与 POST **不能注册成两条**，必须合成一条
`methods: ['GET','POST']` 的路由、在 handler 里按 `req.method` 分派。
另外 `register()` 返回的是 `() => Promise<void>`，且它内部自带 `owner.effect`，
必须在外层 `ctx.effect` 里注册并收集注销器。

---

## C. 存储契约（`node:sqlite`）

- 库文件：`<dataDir>/memory.db`（`dataDir` 默认 `$DSH_HOME/dsh-memory`，由插件 config 注入）。
- 打开后：`PRAGMA busy_timeout=5000`、`PRAGMA foreign_keys=ON`、非 `:memory:` 时 `journal_mode=WAL`。
- **文本是本体，向量是纯派生物**：`vectors` 里的任何一套都可以整表删掉重算，`memories` 一条不丢。
- 表：`schema_meta` / `memories` / `memories_fts` / `vectors` / `spaces` / `history` /
  `batches` / `batch_items` / `palace_sources`（来源账本；原宫殿同步退役后无调用方，表与方法保留）/ `jobs` / `settings`（字段见 Phase 1 契约）。
- 所有多步写用事务。

### C.1 向量按「空间」保留（schema v2）

```sql
vectors(memory_id, space, provider, model, dims, vec, updated_at, PRIMARY KEY(memory_id, space))
```

- `space` 是 `provider:model:dims` 指纹（`db.js` 的 `spaceKeyOf` = `config.js` 的 `embeddingFingerprint`，
  有一条测试钉住两者同值）。**同一条记忆可以同时拥有多套向量**，互不覆盖。
- 换嵌入模型 = 新建一个空间；**不删**任何旧空间。切回去只补「那个空间里还缺的」
  （`countMissingVectors` / `listTextsMissingVector`），已有的一行都不重算。
- `spaces` 表只记「最近一次写入用的是哪个空间」（`key='active'`），**不作检索判据**：
  检索/补齐该用哪个空间由**当前配置**算出来。两者不一致时的正确行为是「提示需补齐」。
- v1（`memory_id` 单主键）库在 `openDatabase` 里原地升级：老表改名 `vectors_v1` 留底 →
  重跑 DDL 建新表 → 逐行搬过去，`space` 用**行自己的** `model`/`dims` + 调用方给的 provider 提示拼。
  用行自己的 model/dims 是关键：升级前刚换过配置时，旧向量绝不能被错认成新空间。
  迁移幂等（中断后重开会补搬），结果记在 `lastMigration(db)` 里。

### C.2 行为计分契约（schema v4：两个计数器 + 每周懒衰减）

需求原话：「为每条记忆附加两种参数：一个是被 agent 作为正常记忆读取后会增长一次的指数；一个是
被仓管作为待整理记忆读取后会增长一次的指数。整理指数会每周按全库指数高低差进行保持原比例不变的
小幅度下降以防数值膨胀。被整理后产生的新记忆初始会增长一次整理指数」。

**两列（纯增量）**：

```sql
memories(..., read_score REAL NOT NULL DEFAULT 0, tidy_score REAL NOT NULL DEFAULT 0)
```

- 全新库由 DDL 直接带上；老库（v3）在 `openDatabase` 里由 `migrateScoreColumns()` 用
  `PRAGMA table_info(memories)` 检查后 `ALTER TABLE ... ADD COLUMN` 补列 —— **绝不重建表**
  （库里有上千条真实数据）。既有行两列默认 0，其它字段一个字不动。
- `SCHEMA_VERSION = 4`。衰减时间戳存在 `settings['score.decayedAt']`（ISO 串），不进 schema。
- 行整形 `shapeMemory()` 除解析 `meta` 外，把两列以 `readScore` / `tidyScore` 别名带出来
  （`getMemory` / `listMemories` / `listKeeperArtifacts` / `searchText` 的 items 都能看到）。

**四个触发口径**（用户 2026-10-07 拍板，别再改）：

| # | 口径 | 落在哪 |
|---|---|---|
| 1 | **read**：`memory_search` 命中的每一条 + `memory_get` 取单条 → +1；**列表 / 面板浏览不算** | 只放在工具的 handler（`service.recordReads`），**不在 `searchText()` 里** —— 它同时被仓管分组召回与 `analyzeBatch` 候选召回使用，放进去会把「仓管在整理」误记成「被正常读取」 |
| 2 | **tidy**：一条记忆**被抽进仓管的一组**（种子或被 embedding 召回当邻居）→ +1；**同一轮同一 id 只算一次** | `runKeeperRun()` 每组 `recordTidy([...memberIds])`。跨组不重复是结构性的：`covered` 保证进过组的 id 不会进第二组 |
| 3 | **仓管产出 / 替换出的新记忆**：tidy **初始 = 1**（字面：初始 0 再 +1） | `addMemory({..., tidyScore: 1})`：`split` 的派生碎片、`replace` 的新条。`merge` 保留条 / `split` 第 1 块是既有行，不重复加 |
| 4 | **衰减**：全库 ×`score.weeklyDecay`（默认 0.98）/周，懒触发、按整周数连乘、**比例严格不变** | `MemoryService.maybeDecayScores()` |

**懒衰减算法**（`maybeDecayScores()`，幂等、未到期零成本）：

```
since = settings['score.decayedAt']
if since 缺失 / 非法:  since := now; return          # 首次启用只写起点，不乘（历史数据不打折）
weeks = floor((now - since) / 7d)
if weeks < 1:         return                         # 未到期
# 以下两件事在**同一个事务**里（withTransaction）：只成一半就会白丢一周衰减 / 重复乘一次
decayScores(factor ** weeks)                         # 一条 UPDATE：两列同时乘
settings['score.decayedAt'] := since + weeks * 7d    # 只推进整周，余数留到下次
```

「**比例不变**」的含意：全体乘同一个数，因此任意两条的比值 `a/b` 衰减前后完全相等
（`10, 5` 衰减两周 → `9.604, 4.802`，仍是 2 倍）。高低差的结构被保住，只有绝对量缩水 ——
这正是「按全库指数高低差进行保持原比例不变的小幅度下降」。触发点：`apply()` 启动时一次 +
每次计分操作前（`recordReads` / `recordTidy`）各一次。

**与 FTS 的耦合（必须一起改）**：`memories_fts_au` 触发器从裸 `AFTER UPDATE` 收窄成
`AFTER UPDATE OF text`（`migrateFtsTriggers()` 负责把老库换掉；`CREATE TRIGGER IF NOT EXISTS`
对已存在的触发器不做任何事）。否则每次计分都会触发 FTS 删+插：既白付检索延迟，又会在
「索引与主表不同步」的库上抛 `database disk image is malformed`。窄触发器不改变正文改写的同步行为。

---

## D. 检索契约：**trigram 只吃 ≥3 字，中文必须配 LIKE 兜底**

这是本项目最容易踩、也最隐蔽的坑，已用两轮 spike 证实
（`.scratch/spike-fts.mjs`、`.scratch/spike-fts2.mjs`）。

**实测**：

| 查询 | trigram 结果 |
|---|---|
| `"冰美式"`（3字） | ✅ 命中 |
| `冰美式`（3字裸词） | ✅ 命中 |
| `记忆宫殿`（4字） | ✅ 命中 |
| `11434`（5位数字） | ✅ 命中 |
| `"宝宝"`（2字） | ❌ **空** |
| `宝宝`（2字裸词） | ❌ **空** |
| `宝宝*`（2字前缀） | ❌ **空** |
| `"宝"`（1字） | ❌ **空** |
| `咖啡`（2字） | ❌ **空** |

中文里两字词极常见（宝宝/咖啡/偏好/记忆/端口…），**只用 FTS5 会静默漏掉大部分中文查询**。

**正确实现**（`keywordSearch`）：

1. `q` 为空 → `[]`。
2. `terms = q.split(/\s+/).filter(Boolean)`。
3. `terms.length === 1 && q.length >= 3` → FTS5：`memories_fts MATCH ?` 绑定**裸词 `q`**（不加引号），
   `score = -bm25(memories_fts)`，`ORDER BY score DESC LIMIT n`。
4. 否则 → **LIKE 兜底**：每个 term 一个 `text LIKE '%'||?||'%'`，term 之间 **AND**，
   `score = 1`（常量）。`%` 与 `_` 必须用 `ESCAPE '\'` 转义，不能把用户输入当通配符。
5. 两个分支都要 `deleted_at IS NULL`。

**为什么两种分支配分尺度不同也没关系**：融合用 **RRF（只用名次）**，不用原始分值。
`RRF = Σ w · 1/(k + rank)`，rank 从 1 开始。不要改成「按分值加权求和」——那会让 bm25 分与常量 1 不可比。

> 已实现于 `src/host/search.js` 的 `keywordSearch`，并有 8 条回归护栏
> （`test/search.test.js` 的「trigram 边界」一节）：2 字命中、单字命中、多段 AND、
> **`%`/`_` 通配符必须转义**、短查询路径同样过滤软删与 scope、空查询与 limit=0。

**其余已实测无误的部分**：外部内容表 `content='memories', content_rowid='rowid'` +
INSERT/UPDATE/DELETE 三触发器同步正确；改正文后旧词搜不到、新词搜得到；软删靠 join 过滤；
硬删触发器清 FTS；`INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')` 通过。

**性能实测**：5000 行全表 `LIKE '%宝宝%'` = **0.1 ms**；4000×2560 维暴力余弦 = **22.6 ms**。
两者都远低于交互阈值，因此 Phase 1 不需要任何 ANN 索引。

---

## E. 嵌入契约

- 端点：`https://dashscope.aliyuncs.com/compatible-mode/v1`（OpenAI 兼容模式）
- 模型：**`qwen3.7-text-embedding`**；维度 **1024**（实测 `dimensions` 可传，512 亦可用，省略则默认 1024）
- 密钥：只存 DSH 凭据库，引用名 `DASHSCOPE_API_KEY`；**解析顺序 `ctx.credentials.resolve(ref)` → `process.env[ref]`**
- 三后端：`openai`（`POST {baseUrl}/embeddings`，`{model, input, dimensions}`，Bearer 头）/
  `ollama`（`POST {ollamaUrl}/api/embed`，`{model, input}`）/ `local-hash`（离线确定性兜底）
- **每批返回的向量长度必须等于 `dims`，不等就抛错并写清「期望 N 维、返回 M 维、模型名」**。
  原项目最致命的故障就是维度不一致时静默给出错误向量。
- 空间指纹 `provider:model:dims` 就是 §C.1 的 `space` 键；检索只在**当前配置算出的**那个空间里做：
  空间里没有向量 → 明确回「需补齐」，降级为关键词，**绝不拿别的空间的向量硬凑**（那会给出无意义的余弦分）。

### E.1 嵌入配置档案（多套配置 + 切换）

需求原话：「线上 / 局域网 / 本地模型都要能自定义（api url、api key 引用、模型 id）」，
且「每次切换需保留对应的向量，切换回来后只补新旧差异」。落地方式：

| 概念 | 存在哪 | 说明 |
|---|---|---|
| 档案（profile） | 库里的 `settings.embedding.profiles`（JSON 数组） | 一组 `embedding` 字段：`provider` / `baseUrl` / `model` / `dimensions` / `apiKeyRef` / `ollamaUrl` / `localDims` / `batchSize` / `timeoutMs` |
| 生效档案 | `settings.embedding.active` | 档案名；`config` 是保留名，指 profile 补丁文件里那份（永远兜底） |
| 空间 | `vectors.space` | 由档案的 `provider:model:dims` 决定，向量按它分组保留 |

- `resolvedConfig()` = patch 的 `config` **叠加**生效档案的 `embedding` 字段；档案改了**不用改补丁文件、不用重启**。
- 密钥仍然只进 DSH 凭据库：**每个档案带自己的 `apiKeyRef`**，面板写密钥时按所选档案的 ref 写。
- 切换（`POST /activate`）**只改一行设置**；返回该空间的 `vectors` / `missing`。
  `missing > 0` 时点补齐即可 —— 补齐只遍历缺的（`listTextsMissingVector`）。
- 补齐过程中配置被切换 → `runBackfill` 比对指纹后**停手报错**，绝不把向量写进别的空间。
- `POST /embed-test` 真打一次请求并核对维度：这是「url / key / 模型 id 配得对不对」的验收手段。
- 三种 provider 覆盖三类部署：`openai`（线上或**局域网**的 OpenAI 兼容端点，`baseUrl` 自定义）、
  `ollama`（本机/局域网 Ollama，`ollamaUrl` 自定义）、`local-hash`（完全离线兜底）。

### E.2 维护操作的语义（容易写错的几处）

- **改写正文必须作废向量**：`updateMemoryText` 在**同一事务**里删掉该 id 在**所有空间**的向量，
  并把 `vectorsDeleted` 回给调用方；审阅门用 `onUpdated` 回调把这条重新排进嵌入队列。
  不这么做的话语义检索会一直按旧文本的向量出结果，而且 `countMissingVectors` 看不见它（向量行还在），
  增量补齐永远修不掉。
- **补齐 ≠ 重算**：`startBackfill({mode:'missing'})` 只补缺的；`{mode:'all'}` 强制全量重算
  （同 id 原地覆盖，断了可以再点）。被改坏 / 不纯的向量只有 `all` 能修。
- **软删 ≠ 真删**：`memory_forget` 默认软删（填 `deleted_at`，行与历史都在）；
  `hard: true` 真删行（FTS 触发器同步、向量外键级联、`history` 保留 `hard_delete` + `prev_text`）。
- **备份用 `VACUUM INTO`**：库开着也能拿到一致快照（WAL 里的改动一并落进去），
  不像直接拷文件那样可能拷到半截；快照含向量与 history，文本包另存一份给人看。

### E.3 自主捕获契约（跟随 agent 运行）

宿主事件目录里可用的挂钩点是 `session/event`（**落库后的** append feed，emit 模式、fire-and-forget）
与 `agent/turn-stopping`。我们选前者：它给出 `user/message` / `assistant/message` / `turn/end` 三种事件，
正文与回合边界都在里面，且**监听器抛错不会让落库失败**（上游会记日志并吞掉）—— 对一个旁路功能来说正合适。

| 约定 | 内容 |
|---|---|
| 挂点 | `ctx.on('session/event', (session, event) => …)`，注册在 `ctx.effect` 里；**`ctx.on` 不可用时只记状态、绝不抛**（`capture.subscribed=false`） |
| 缓冲 | 每个会话一个 `ConversationBuffer`：只收 `user/message` 与 `assistant/message` 的 **text 块**（`reasoning` / `tool-call` 一律丢，否则抽取会被思考过程带偏）；上限 `capture.maxChars`，超了丢最旧的整行 |
| 触发 | `turn/end` 时，**还没抽走的用户正文累计** ≥ `capture.minChars` 且距上次捕获 ≥ `capture.cooldownMs` → 取走转录、后台抽一次。`note()` 必须返回**累计值**，不能返回本条事件的字数 —— `turn/end` 本身不带正文，否则永远触发不了（这个坑踩过） |
| 归属 | **连入记忆系统的那个 agent 自己**的会话 → `direct`：三分类判 `durable` 的**免审直入库**、判 `uncertain` 的**并成一个 `open` 待审批次**（不直存、也不丢）；其他来源（`header.origin==='subagent'` / 有 `parentSession` / `delegationDepth>0`）→ `pending` 落待审区（`durable` 与 `uncertain` 都在同一批次里，再走 agent 审阅） |
| agent 审阅 | 待审批次由**这个 agent** 自动审：`analyzeConflicts`（四关系 + 四条护栏，prompt 里已写死「事件/经历算 coexist」）→ `reviewBatch` 执行。`supersede` **只取最相似的那一条**目标，控制自动化改写的爆炸半径。⚠️ 直存路径为 `uncertain` 建的批次**不自动审**（拿不准的东西不该由自动判定直接落库），留给人 |
| **两道闸（2026-10-07 新增；同日升级为三分类）** | ① **提示词**：`EXTRACT_PROMPT` / `EXTRACT_FOCUSED_PROMPT` 里的「不要记」清单 + 正反例对照（会话/任务态、工具/协作态、助手自身的立场与自述、一次性当下状态）。② **确定性三分类**：`src/host/transient.js` 的 `looksTransient()` → `{verdict: 'durable' \| 'transient' \| 'uncertain', hit}` —— 提示词**不是保证**，所以抽出来的 fact 在**写库 / 入待审区之前**逐条三分（`capture.dropTransient`，默认 true；`false` = 三分类全部保留，只靠提示词）。**判定顺序**：会话/协作态（硬规则，`teammate` / `subagent` / `子代理` / 以「助手、我」作**句首主语**的自述 / `本次会话` / `这轮` / `接下来` / `待办` / `约好用…流程` / `跑通了 N 条` / `已完成…` 开头）→ **长期信号**（`决定` / `采纳` / `拍板` / `统一` / `约定`＋人称主体且非 `约定：` 冒号清单 / `偏好` / `习惯` / `要求` / `记住` / `基准` / `长期` / 日期锚点 / 身份关系词）→ **弱规则**（`约定：` 冒号清单、`正在` / `刚刚` / `目前` / `暂定` / `暂时` / `进度`）→ 都没命中 = `uncertain`。要点：**技术词（`变更单` / `待审区` / `验收` / `重启` / `panel` / `工具`）单独出现不再构成 transient**（旧二分类正是拿这些词误杀了三条真实长期决定）；**长期信号一律保留**，哪怕同句带技术词。落地方式：`extractFacts()` 透传 `excludeTransient`，返回 `{facts（durable+uncertain 原顺序）, durable, deferred, dropped}`；`stageExtraction()` 用 `facts` 建批次（所以 durable 与 uncertain 都进待审区、只有 transient 不进）并回报 `deferred` —— **direct 捕获、pending 捕获、手工 `memory_extract` 三条路共用同一份判据**。计数进 `capture.lastRun.droppedTransient` / `deferredToReview` 与 `capture.droppedTransient` / `deferredToReview`；面板「概览 → 自主捕获」各写一行 |
| 不变量 | ① 监听器**同步返回**，抽取走 `void` 异步（绝不拖慢回合）；② 节流（阈值 + 冷却）；③ `capture.enabled=false` 一条不抽；④ 失败只写 `capture.runs/errors`，不重试、不抛 |

**为什么要「归属」而不是一刀切**：这段逻辑的输入是**会话**，而会话有主次之分 ——
主会话是「被记忆系统接入的那个 agent」在说话，它抽出来的东西直接入库是可信的；
子代理/委派会话是临时工，它们抽的东西要过一道审。这条规则是用户 2026-10-06 明确要求的。

**为什么要「两道闸」**：自主捕获的输入是整段对话，里面天然混着**本次会话的工作安排、工具协作状态、
助手自己的立场**——它们不是长期事实。只有提示词一道闸不够（模型照样会抽），所以在提示词之外再加一道
**确定性**分类（纯函数、可单测、零 LLM 调用），并把它放在**写库 / 入待审区之前**的唯一分叉点上
（`extractFacts` / `stageExtraction` 内部），这样 direct / pending / 手工抽取三条路不会各写一套判据。
分类是**宁可漏判、不要误杀**：长期信号一律保留（例：「用户拍板统一了修改记忆的做法：…进待审区…」虽然命中
`待审区`，但 `拍板 / 统一` 把它救回来），而且**拿不准的不再丢、改走审阅**
（2026-10-07 的一次真实事故：旧二分类把「用户采纳了…只出变更单、不直接改库」这类**用技术词表述的长期决定**
判成临时并静默丢掉，用户点名的 3 条已写进 `test/transient.test.js` 的回归用例与 `REGRESSION.md` 专节）。
真实效果与剩余边界在 `REGRESSION.md` 有只读实测。

**为什么要放宿主里测**：本机沙箱化的 shell 拿不到 TLS 凭据
（`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`），命令行发不出 HTTPS；
宿主进程用的 Node fetch 才是插件真实环境。

---

### E.4 仓管契约（自带本地 LLM + 全库二次加工）

需求原话：「内置一个 LLM，专门用于接入 Local LLM …它将成为记忆系统的『仓管』，负责对已录入的所有记忆
进行二次消化、对已录入但大段的记忆进行**无损研磨**」。两条用户拍板的语义：**研磨改写原文（原文只留 history）**、
**拆细与去重分别可触发**。⚠️ **2026-10-07 凌晨范式升级**：仓管不再直接改库，改成 **出单 → 审阅 → 落库**（见下表）。
⚠️ **2026-10-07 最终语义**（用户原话：「灵活一些 让LLM视情况决策 缩写、去冗余、优化语序 都是被允许的」）：
`replace` / `merge` **允许改写**（缩写 / 去冗余 / 优化语序 / 同义换词 / 理顺句子 / 合并 / 必要时改错别字），
唯一不变量是**事实要点不许丢**（人物 / 时间 / 决定 / 数值 / 引号里的原话 / emoji 标签）、**不许新增**、
**不许把不确定的写成确定**；`factCheck()` 只产**证据**、不做「违规」定性。
⚠️ **2026-10-07 同日追加**（用户发现「整理后的记忆块会丢语句成分：第二块是指劳工边界，可它只说边界，
会被理解为某个全局边界，**这很危险**」）：`split` 走另一条路 —— **①每块自足 ②不丢内容 ③不新增信息**，
**旧的「`split` 逐字无损 / 子序列 ≥98%」承诺作废**（见下表 `split` 行）。
⚠️ **2026-10-07 统一修改语义**（用户原话：「修改记忆的做法是 **依照原记忆编写修改后的记忆** →
**新旧记忆展示在待审区** → **过审后删除原记忆、录入新记忆**」）：修改类 op **只有 `replace`**，
落库 = `addMemory`（新 id）+ 原条 `softDeleteMemory`（**软删 = 系统默认的「删除」**：行与 history 都在、
可恢复）+ 清原条向量 + `scheduleEmbed(新 id)`；**旧的 `rewrite` 一律按 `replace` 解析 / 落库**，
系统里**不再有「原地改写同一条」这条路径**。手工入口 `proposeKeeperReplace()`（工具
`memory_keeper {action:'propose', id, text, reason?}`）**只出单、不落库**。
⚠️ **2026-10-07 同日：删除也进待审区**（用户原话「删改都要进待审区」）。手工入口
`proposeKeeperDrop()`（工具 `memory_keeper {action:'propose-drop', id, reason?}`）建一张单 op 的
`drop` 变更单（`{idx:0, type:'drop', targets:[id], before:[{id,text:原文}], after:null, reason, warnings:[]}`，
`state:'open'`）—— **只出单、不落库**；过审后走 `reviewKeeperPlan()` 的 `drop` 分支 → `softDeleteMemory`
（软删=可恢复）+ 清向量。因为 `drop` 的目标行上**没有 meta 痕迹**，`revertKeeper()` 专门扫**已应用变更单**
（`state` 为 `approved` / `partial`）里的 `drop` op，按 `targets` `restoreMemory()` 放回来（`restoredDropped` 计数）。

| 约定 | 内容 |
|---|---|
| 独立通道 | `src/host/locallm.js` 直连 HTTP，**不经过宿主的 `ctx.llm`**：`ollama` → `POST {ollamaUrl}/api/chat`（`stream:false`，显式 `num_ctx:32768` —— Ollama 默认 4096 装不下长记忆 + 提示词）；`openai` → `POST {baseUrl}/chat/completions` + Bearer。密钥走 `keeper.apiKeyRef` → DSH 凭据库 |
| 超时信号 | 两处（`locallm.js` / `embed.js`）都用 `src/host/timeout.js` 的 `timeoutSignal(ms)` —— 自建 `AbortController` + `setTimeout(...).unref?.()`，请求结束（成功 / 失败 / 抛错）在 `finally` 里 `clear()`。**不用 `AbortSignal.timeout()`**：它的定时器不可撤回 / 不 unref，请求早就结束了还把进程钉住 ~`timeoutMs`，攥着 sqlite 句柄 → 下一个测试进程 `freshTmpDir()` 的 `rmSync` 抛 EPERM（表现为「整份测试文件假失败、还抑制后续用例」）。超时 reason 仍是 `name='TimeoutError'` 的 `DOMException`，错误语义与原来一致 |
| 为什么自带 | 全库加工是「上千条 × 每条一次调用」：用宿主的云模型既贵、又会把整库正文发出去。默认指向局域网，数据不出内网 |
| **事实保全**（`replace` / `merge` 的不变量） | **不由提示词单独保证**，但也**不做「不许改写」的硬校验**：`factCheck(before, after)` 是纯函数，只产四样证据 —— `ok`（**仅**表示硬信号：数字 / 日期没丢）、`lengthRatio`、`missingNumbers`、`missingTerms`。片段的取法是**内容片段**而不是逐字对齐（逐字对齐遇到「优化语序」会切出一堆读不通的碎渣）：引号原话（连引号一起）→ emoji 标签簇（按图形字符切，`🎞️` 绝不被拆成半个）→ 汉字串 / 拉丁词（≥2 字）；纯填充词（`STOP_WORDS`，只有「整段什么都不剩」时才丢）与重复项被过滤，**引号原话 / emoji / 带数字的词排在 `missingTerms` 最前面**（`fragmentRank`）。`factWarnings()` 把它们翻成中性人话：`丢了 N 个数字：…` / `消失的片段：…` / `压缩到 X%`（**仅** `lengthRatio < LOW_LENGTH_RATIO = 0.4` 时附「留意是否过度缩写」；正常去冗余变短不报警）。**模型怎么改写由模型视情况决策，代码只交出证据**。2026-10-07 追加两条同源证据：`这块可能缺主语：…`（after 命中不了原文任何锚点 —— 主语 / 对象 / 时间锚全丢）、`新增了原文没有的片段：…`（`addedTerms()`，见下行） |
| **`split` 的三条证据**（2026-10-07 追加，与上面分开看） | 用户现象：「整理后丢了语句成分，第二块是指劳工边界，可它只说边界，会被理解为某个全局边界，**这很危险**，因此整理后的记忆块要完整」。三条一起跑：**①每块自足** —— `anchorsOf(texts)` 从原文提锚点（引号内术语 / 英文与数字标识 / 出现频次高的 2–4 字主题词；2 字窗要 ≥3 次、3–4 字窗要 ≥2 次，去 `STOP_WORDS`），`selfContained(block, anchors)` 命中 ≥1 个算自足（**提不出锚点时不判缺主语**）；为此**允许重复原文里的主语词**（重复不算冗余，缺主语才是问题）；**②不丢内容** —— 各块拼起来跑 `factCheck()`，`丢了 N 个数字` / `消失的片段` 照旧；**③不新增信息** —— `addedTerms(before, after)`：先按「最长可命中 before 的连续前缀」贪心前移（命中 ≥ `ADDED_MATCH_RUN`=4 字算「原文本来就有」），剩下的未对齐片段**只有含连续 ≥ `ADDED_MIN_CHARS`=2 个原文里根本没出现过的字**才报 —— 于是同义换词（`改成`→`改为`）、语序调整、引号样式变化都不会误报，而「边界=全局」「还行」这种原文字典里没有的词一定报。证据**只写 `warnings`、不改判**：缺主语 / 新增片段的 op 照样出单。⚠️ **旧的「逐字无损 / 子序列 ≥98%」承诺已作废**：为自足而重复的主语词天然不是子序列。`coverageOf()` / `losslessSplit()` 保留但降级 —— 前者只是核对工具，后者**只在模型没给可用碎片 / 只给了一块时兜底**，该 op 带结构化标记 **`fallback: true`**（`losslessFallback` 计数与面板「兜底切分」都认这个字段，**不认 warning 文案 / 条数**） |
| **范式** | **出单 → 审阅 → 落库**：`startKeeperRun()` 只往 `keeper_plans` 表（`SCHEMA_VERSION=3`）写变更单，**记忆库一个字都不动**；`reviewKeeperPlan({id, keep, edits, reject})` 是**唯一**落库入口。旧的直接改库路径（`startKeeper` / `runKeeper` / `grindOne` / `dedupePass`）**已删除** |
| 分组口径 | 随机抽 `keeper.sampleSize`（20）个种子 → 每个种子用**当前空间的向量**语义召回 `keeper.perGroup`（5）个邻居成一组 → **每组一次调用出一张单**；`maxGroups` 限本次组数，已被前面组覆盖过的种子不再单开一组 |
| 出单整形（`keeper-plan.js`） | `normalizePlanOps()`：`targets` 只留组内真实 id；`split` 只认单目标、跑「每块自足 / 不丢内容 / 不新增」三条证据（**不再要求子序列覆盖率**；只有模型没给可用碎片 / 只给一块时才 `losslessSplit()` 兜底、打 `fallback: true` + 一条兜底 `warnings`；拆不开就不出这条 op）；`replace`（含旧 `rewrite`、`merge` 单目标）跑 `factWarnings()`，把「丢了 N 个数字 / 消失的片段 / 压缩到 X% / 缺主语 / 新增片段」写成 `warnings`（**只给证据、不改判**，op 照样出单）；被删片段里**引号原话 / emoji 标签 / 数字优先排在前面**；`merge` 只有一条目标时按 `replace` 归一；`after` 为空的 replace / merge 直接丢弃；**after 与原文一字不差（抹掉空白后相同）的 replace 也直接丢弃** —— 没有变更就不是变更，同时挡住「新正文撞上原条 hash → `addMemory` 回原条 id → 再把原条软删」的自删事故。⚠️ **已知口径**：`merge` 的 `lengthRatio` 拿「各条原文按 `targets` 顺序用 `\n` 连起来的并集」当分母，所以多路合并天然显得压得很狠（会带出「留意」）；片段级比对不逐字，删一个虚词可能不出现 |
| 落库语义 | **`replace` = 删旧录新**（统一修改语义）：① 先 `getMemory(targets[0])` 预检（拿不到 / 已软删 / 新正文与原文相同 → `skipped`，绝不半途动手）；② `addMemory({text: after, scope/kind/source 照抄原条（source 空则 '仓管改写'）, meta: 原 meta 去掉仓管回滚凭据 + `replaces`/`replacedAt`/`model`})` 拿到**新 id**，若 `created:false`（正文撞上另一条活着的记忆）也 `skipped`；③ 原条 `softDeleteMemory(id, {note:'keeper:replace'})`（**软删 = 系统默认的「删除」**：行与 history 保留、可 `restoreMemory` 恢复）+ `deleteVector()`（软删的行不能留下幽灵命中）；④ `scheduleEmbed(新 id)`；⑤ `op.newId` 写回单子（面板显示「新记忆 id」）。`split` → 第 1 块写回原记忆（`history.prev_text` = 完整原文）+ 其余块 `addMemory` 并带 `meta.derivedFrom`；`merge` → 保留 `targets[0]`，**被并掉的 id 记进保留条的 `meta.merged`（`{from, at, reason}`，回滚凭据）**，其余 `softDeleteMemory`（可恢复）；`drop` → `softDeleteMemory`。有跳过 → 单子记 `partial`，全应用 → `approved`；`applied` 的键是 `{replace, split, merge, drop}`，另返回 `replaced:[{from,to}]` |
| `edits` 口径 | 键是 op 的 `idx` 字符串：`split` 的值必须是**字符串数组**、`replace` / `merge`（含旧单里的 `rewrite`）必须是**字符串**、`drop` 忽略；工具层 `memory_keeper {action:'review', edits}` 在调用前逐键校验（要按 op 类型判），类型不合 / 下标越界 / 空串**当场报错原文、不落库**。⚠️ 已知边界：`edits` **落库前不重跑** `coverageOf()` / `factCheck()` / `addedTerms()` / `selfContained()` —— 手改的字由人负责 |
| 回滚 | `revertKeeper()` 五件事：`derived` 产物**真删**、`rewritten` 被改写的原文按 history 里最早一条 `keeper:*` 的 `prev_text` 恢复、`merged` 里 `meta.merged[].from` 指向的行 `restoreMemory()` 放回来、**`replaced`（`meta.replaces` 指向的旧 id）放回 + 把该 `replace` 的新记忆真删**（新记忆本来就是本轮产物；放回的原条正文没被动过，只是重新 `scheduleEmbed` 补向量）、**已应用变更单里 `drop` op 的 `targets` 放回来**（`drop` 不留 meta 痕迹，只能从单子找；已放回的 `restoreMemory()` 回 false，天然幂等；统计 `restoredDropped`）。`listKeeperArtifacts()` 四桶：`derived` / `rewritten` / `merged` / `replaced`，后两桶**不按 `deleted_at` 过滤**（回滚凭据不能因那条记忆被软删就消失）。⚠️ **边界（如实）**：合并保留条 / 历史被改写条自己的正文**不**由 revert 回退（它们没有 `meta.keeper` 标记，不在 `listKeeperArtifacts().rewritten` 里），要回退只能走 `history.prev_text` 手工恢复 |
| 任务模型 | 后台任务（`startKeeperRun` 立即返回、`void runKeeperRun(...)`），状态在 `publicKeeper()`（`running/total/done/failed/skipped/losslessFallback/plans/ops/retried/runId/tail`），审计写 `jobs` 表。**超时重试一次**（2026-10-07 实测补）：线上模型（`qwen3.8-flash`）吐 2000 token 的 JSON 约 1/3 的组会 `TimeoutError [23]`，那一组 tidy 照加却一行产出都没有 —— 所以 `runKeeperRun()` 在**只有超时**（`isTimeoutError()`：`name==='TimeoutError'` 或 `code===23`）时用**同一份请求**再打一次：重试是同一组，**不重复 `recordTidy()`、不重复建单**；两次都超时才记 `failed`（tail 写「失败（超时，已重试一次）」），非超时错误不重试、错误原文直接进 tail / `lastError`；`retried` 累计重试次数（观测用，面板不强制展示）。`keeper.timeoutMs` 默认同步从 120000 提到 **240000**。⚠️ 旧形状里的 `derived` / `merged` 两个格子**已删除**（2026-10-07 本轮）：新范式的 run 一个字都不写记忆库，没有任何地方累加它们，留着就是「面板显示 0、其实有产出」的假数字；真实存量在 `keeperStatus().artifacts`（现扫库），单次审阅应用了几条在 `reviewKeeperPlan()` 的 `applied`。**不阻塞对话；进程重启会中断，但已出的单还在 `keeper_plans` 里** |
| 未配置时的行为 | `keeperStatus().configured=false` + `hint`；生效档案是内置 `config` 时提示去写 `keeper.provider / keeper.ollamaUrl / keeper.model`，是具名档案时提示去面板「仓管 → 档案」里给**那个档案**补 model 与端点（不会误导人去改 patch）。`startKeeperRun` / `keeperTest` 都**如实报错**（绝不拿本机默认地址瞎连） |
| 生效档案解析（`resolvedKeeperConfig()`） | `keeperStatus()` 顶层 `configured/provider/endpoint/model/各阈值`、`createKeeperClient()` 的默认配置、`keeperTest()`（不带 `name`）、`startKeeperRun()` 的 `cfg` **共用同一套**：**先 `ensureStore()` 再按生效档案解析**（`config` → patch + `keeper.overrides`；具名 → patch + 该档案字段）。⚠️ 顺序不能反：库没开时 `keeperProfilesState()` 恒回空、`activeKeeperProfile()` 恒回 `null`，具名档案会**静默退回 patch** —— 实测现象就是 `active:'线上'` 却 `configured:false / provider:'ollama' / model:null`（面板那张卡显示「未配置」），冷启动第一轮 `run` / `test` 也会拿 patch 的 `model:null` 去建客户端 |
| 面板与路由 | 第 6 个页签「**仓管待审**」（`keeperQueue`）专门审单；4 条新路由 `POST /keeper-run`（出单）、`GET /keeper-plans`（列单）、`GET /keeper-plan`（单张全文）、`POST /keeper-plan-review`（审阅落库）；旧的 `POST /keeper` 保留为 `/keeper-run` 的兼容别名（老的 `mode/limit/minChars` 字段一律忽略，不会再变成直接改库） |

**档案与切换**（2026-10-07 补：通道从「单组配置（只能指本地 Ollama）」升级为**多档案 + 主动切换**）

| 概念 | 存在哪 | 语义 |
|---|---|---|
| 档案 | `settings.keeper.profiles`（JSON 数组） | 一条档案 = 一组 `KEEPER_PROFILE_FIELDS`：`provider` / `ollamaUrl` / `baseUrl` / `model` / `apiKeyRef` / `timeoutMs` / `maxTokens` / `temperature` / `minChars` / `splitChars` / **`sampleSize` / `perGroup`**（新范式出单用：种子数与每组邻居数）/ `digestMinChars` / `dedupeThreshold`（后两个**已不再参与加工逻辑**，只作档案字段与面板显示保留）；`name` 是键，不在字段白名单里 |
| 生效档案 | `settings.keeper.active` | 档案名。**缺省 / `'config'` / 指向一个不存在的档案**三种都当 `config` 处理（`activeKeeperProfile()` 回 `null`、`listKeeperProfiles()` 把 active 报成 `config`）—— 面板绝不显示一个其实没生效的档案 |
| 内置 `config` | patch（+ `keeper.overrides`） | **永远排第一、`builtin: true`、不可删**（`saveKeeperProfile` / `deleteKeeperProfile` 都拒收这个名字），是永远存在的兜底 |

- **合并顺序**（`resolvedConfig()`）：生效档案是 `config` → `keeper` = patch + `keeper.overrides`；是具名档案 → patch + `profileToKeeper(该档案)`，**`overrides` 不参与**。
  所以「面板改 patch 那几个框」只在 `active === 'config'` 时有意义（面板也只在此时显示它们）。`saveKeeperProfile()` 落库前用**同一套合并顺序**
  跑 `normalizeConfig()`，非法值当场抛、绝不入库（`provider` 写错之类的错误原文直接回给调用方）。
- **播种判据是「键从未写过」，不是「数组为空」**：`listKeeperProfiles()` 只在 `keeperProfilesState().exists !== true` 时写一次种子 ——
  种子是「线上」（openai + DashScope 兼容端点 + `qwen-plus`（**占位，按实际模型改**）+ `apiKeyRef: DASHSCOPE_API_KEY`）与
  「局域网-ollama」（ollama、地址与模型留 `null` 待填）。用户把种子删光了是他的决定，不塞回来。播种是这个方法的**副作用**，
  所以首次 `/state`、`memory_stats`、`action=profiles` 都会触发那一次写入。
- **切换 = 改一行设置**：`activateKeeperProfile(name)` 对具名档案写 `keeper.active`；对 `config` 是**删掉这个键**（缺省即 `config`；
  写一个 `'config'` 进去会让「人到底有没有手动选过」不可分辨）。仓管没有向量空间那一层，所以**立刻生效、不用重启**。
- **删掉生效档案必须回落**：`deleteKeeperProfile(name)` 删的正好是当前 `active` 时顺手 `removeSetting('keeper.active')`，
  并把 `wasActive` 回给调用方 —— 否则 `resolvedConfig()` 会悄悄退回 patch、而面板还显示在用那个档案。
- **`test {name}` 只测不切**：`keeperTest({name})` 对具名档案走「patch + 该档案字段」，**绝不改 `active`**；省略 `name` 才测当前生效那份，
  测 `config` 用的是 patch + `keeper.overrides`（也就是「切回 config 之后真正会跑的那份」）。配完先试、通了再切。
- **两个隐蔽的坑（都是实测踩出来的，别再踩）**：
  1. `resolveKey()` 回的是**信封** `{source, value, described}`，不是裸字符串。密钥必须取 **`.value`** —— 把信封直接塞进 `Authorization`
     会发出 `Bearer [object Object]`，线上端点只回 401 `invalid_api_key`；而**同一把凭据嵌入却是通的**（嵌入那边取的就是 `.value`），
     从现象上极难反推。判据：`test/keeper.test.js`「线上档案取密钥：Bearer 里必须是信封里的 value（不能是整个信封）」。
  2. 「按名字测档案」必须先**播种**、再回**原始存储形态**查：`listKeeperProfiles()` 有播种副作用（种子只在它里面写库），必须走一次；
     但它返回的是**视图对象**（`endpoint` 已归一、没有 `baseUrl` / `ollamaUrl`），直接喂 `profileToKeeper()` 会得到空对象 ——
     所以还要回 `keeperProfilesState()` 的原始条目里查那一条。否则重启后第一件事测档案会假报「没有这个档案：线上」。

**为什么 `losslessFallback` 要显示在面板上**：它是「模型有没有老实把原文交回来切」的唯一外部指标。
⚠️ 计数口径是 `op.fallback === true`（`normalizePlanOps()` 打的结构化标记），**不是 `warnings.length > 0`** ——
split 从 2026-10-07 起还会带「缺主语 / 新增片段 / 消失的片段」等**证据**，按 warning 条数计会把有证据的 split
全算成兜底、数字虚高。大于 0 说明模型给不出可用碎片（空 / 只给一块）、代码兜住了 —— 结果不丢字，
但这告诉用户「该换个更大的模型或把 `splitChars` 调小」。

---

## F. 客户端半契约（免构建手写束）

- 文件是经典脚本，唯一动作：`window.__ModuleLoader__.load({ id, factory })`；
  `id` **必须等于** `package.json` 的 `name`；`factory(require)` 的**返回值**就是 exports。
- 导出 `apply(ctx)` 与 `inject`（**浏览器端 cordis 服务名**数组）。
- 注意两个 `inject` 不是一回事：`package.json > dsh.client.inject` 是**包名**（启动图顺序），
  模块 `exports.inject` 是**服务名**（fiber 依赖）。
- 只能 `require` 平台种子模块：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
  其余必须写进 `dsh.client.external` 且供应方是图里的行。
- 自注入 `<style>` 必须带 `data-plugin=<模块 id>` 与 `data-plugin-css=<稳定唯一键>`（框架据此做卸载清理）。
- 注册项带 `locale: NS` → 框架注入 `t` prop（缺 locale face 会直接抛 `SlotAssemblyError`）。
- 槽位必须走 `ctx.slots.inject(name, () => ctx.slots.register(...))` —— 槽由别的包声明，插件激活顺序无保证。

---

## F. LLM 适配契约：**必须只取 `text-delta`，丢弃 `reasoning-delta`**

`ctx.llm.stream()` 产出的是 token 级 chunk。实测（`deepseek-official` / `deepseek-flash`）出现过的 `kind`：

```
block-start · reasoning-delta · block-end · text-delta · usage · finish
```

- **`reasoning-delta` 是模型的思考过程，`text-delta` 才是答案。** 把两者拼在一起，
  抽取/冲突判定拿到的就是一整段「我们需要回答用户…」，JSON 解析必然失败 → 永远抽出 0 条事实，
  而表面上"LLM 正常返回了"。这是最难查的一类静默故障。
- **推理模型的 token 预算要先被思考吃掉**：第一次探针用 `maxTokens: 32` 时，
  36 个 chunk 全是 `reasoning-delta`，**根本没有 `text-delta`**，答案压根没开始生成。
  抽取/判定这类任务不要把 maxTokens 压得太紧（当前默认 `extractMaxTokens: 2000`）。
- 适配器实现见 `lib/index.js` 的 `createLlmClient()`：只累加 `text-delta`/`text`；
  同时保留「若整条流一个 `text-delta` 都没有，则回退拼接其它 chunk」的兜底，以兼容别的 provider。
- 自证通道：`GET /dsh-memory-selftest/llm-probe?q=&maxTokens=` 会返回
  `chunkKinds` / `chunkCount` / 拼出来的 `text` —— **改适配器前先看它，别猜字段名**。

---

## G. 开发环路

HMR 监听本插件目录需要 profile patch 里这样写（**两个字段都必要**）：

```yaml
- id: hmr
  config:
    base: 'file:///<DSH 工作区>/dsh-memory/'
    root: ['.']
```

- `base` 会被 `new URL(config.base || '.', ctx.baseUrl)` 解析后再 `fileURLToPath`，
  所以**必须写 URL**；写 `C:/...` 会被当成 scheme `c:` 直接炸。
- `root` 是**相对 `base`** 的；HMR 用 `cwd: baseDir` 调 chokidar，ignored 模式按
  `relative(baseDir, path)` 匹配。base 留在 profile 目录而 root 给 profile 之外的绝对路径时，
  相对路径是 `../../..`，正好被默认 ignored 的 `**/.*` 吃掉 —— watcher 静默失效。

生效后：改 `lib/*.js` 约 9 秒热重载，**无需重启、无需审批**。

---

## H. 开发期诊断面（Phase 5 必须收口）
`/dsh-memory-selftest/*`（注册在 webserver 前缀表，**不走 `/api`，因此无鉴权**，仅监听回环）：

| 接口 | 作用 |
|---|---|
| `GET /ping` | 能力自检：存储、宿主包解析、宿主服务、工具注册、服务注册 |
| `POST /credential` | `{ref, value}` → `ctx.credentials.set` |
| `GET /embed?q=&model=&dims=&apiKey=` | 宿主内真实嵌入往返 |

存在的理由：`/api` 下的路由要过 Cookie 鉴权，命令行无法自造 Cookie；
而 shell 又发不出 HTTPS。没有这条通道，Phase 0–5 的每一步都只能靠人点面板才能观测。

**TODO(Phase 5)**：删掉，或改成 config 显式开启且默认关。
