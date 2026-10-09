# dsh-memory 回归清单

这份清单把两批「已知会咬人的东西」逐条落成可核对的条目：**原版 README 的 19 条血泪坑**
（`../原版内容/memory-installer/payload/app/README.md` §「踩过的坑（血泪版，全部实测）」）
和 **18 个代码级缺陷**（读 `../原版内容/memory-installer/payload/app/` 下的源码逐条核出来的）。

判定口径（**只写能核实的**）：

| 状态 | 含义 |
|---|---|
| `已覆盖·测试「…」` | 新实现里有**具名测试**盯着它（测试名逐字来自 `test/*.test.js`，文件:行 给出） |
| `已覆盖·实现` | 新实现里有对应的代码路径，但**没有**专门的自动化测试 |
| `架构性消失` | 这类问题在原架构里成立、在新架构里**没有成立的土壤**（后面说明为什么） |
| `待补` | 现在没人盯着，风险仍在 |

新架构 = DSH 原生插件（宿主半 `lib/index.js` + `src/host/*.js`、客户端半 `lib/client.js`、
持久化 `node:sqlite`），**没有 mem0 / Chroma / Qdrant / MCP / Python / 独立 HTTP 服务**。
路径都相对本目录（`dsh-memory/`），原版路径相对 `../原版内容/memory-installer/payload/app/`。

---

## 一、原版 README 的 19 条血泪坑

### A. 关思考（最关键）

| # | 坑 | 状态 | 证据位置 |
|---|---|---|---|
| 1 | 8080 早期是 llama.cpp 不是 Ollama（`owned_by: llamacpp`、`/api/tags` 404） | 架构性消失 | 不再探测「对面是谁家的 Ollama」：嵌入只走 `openai`（`POST {baseUrl}/embeddings`）/ `ollama`（`POST {ollamaUrl}/api/embed`）/ 离线 `local-hash` 三条**显式**后端，`src/host/embed.js`；契约 `DESIGN.md` §E |
| 2 | thinking 不关 → mem0 只读 `content`、思考在 `reasoning_content`，于是永远拿到空字符串 | 已覆盖·实现（附待补） | `lib/index.js:977,993,998`：只累加 `text-delta`/`text`，`reasoning-delta`/`reasoning` 单独计数后丢弃，并保留「整条流无 `text-delta` 时回退拼接」的兜底；`DESIGN.md` §F。**待补**：该适配器在 `lib/index.js`，不在 `test/` 覆盖范围内，只有诊断路由 `lib/index.js:1390-1417` 的人工自证 |
| 3 | `/no_think` 软开关无效；Ollama `PARAMETER think false` 官方不支持 | 架构性消失 | 不再靠提示词软开关或 Ollama 参数关思考，改在适配器层按 chunk kind 丢弃（`lib/index.js:993-999`） |
| 4 | mem0 没有任何口子传这些参数（工厂白名单 + 无 `extra_body`）→ 必须有网关层 | 架构性消失 | 不用 mem0：`ctx.llm.stream({provider, model, messages})` 直接收参数（`lib/index.js` 的 `createLlmClient()`），`src/host/extract.js` 的 `buildExtractRequest` 直接给 `temperature`/`maxTokens`，不需要中间网关 |

### B. 上下文 / 隐私 / 语言

| # | 坑 | 状态 | 证据位置 |
|---|---|---|---|
| 5 | Ollama 默认 `num_ctx=4096` 装不下 mem0 的 8K 提示词 → 网关注入 `num_ctx=32768` | 已覆盖·实现 + 测试 | 不再经过 Ollama 的默认上下文：预算由 `config.llm.extractMaxTokens`（默认 2000）显式给（`src/host/config.js:31`）。测试 `config.test.js:30`「默认值：DEFAULT_CONFIG 与契约逐字段一致，normalizeConfig() 返回深拷贝」 |
| 6 | `MEM0_TELEMETRY` 默认 **True**（发 posthog）→ 必须 `import mem0` 之前关 | 架构性消失 | 依赖清单里没有 mem0 / posthog / 任何遥测 SDK；只能 `import 'node:*'` 与包内相对路径（`DESIGN.md` §A） |
| 7 | 默认输出英文 → `custom_instructions` 强制中文 | 已覆盖·测试 | 提示词本身是中文并显式要求中文输出：`src/host/extract.js`。测试 `extract.test.js:39`「两个提示词都是中文、都要求只输出 JSON 数组，聚焦版还限制 8 条并排除技术细节」；`conflict.test.js:47`「CONFLICT_PROMPT：写全四种关系，并显式声明「具体事件/经历/里程碑算 coexist」的铁律」 |

### C. API 细节

| # | 坑 | 状态 | 证据位置 |
|---|---|---|---|
| 8 | mem0 2.2.1 的 `search()/get_all()` 不收顶层 `user_id`，要 `filters={"user_id": …}` | 架构性消失 + 测试 | 没有 mem0：scope 是自家 `memories.scope` 列，检索直接过滤（`src/host/search.js:129-131,145-147,194`）。测试 `search.test.js:73`「keywordSearch：中文 trigram 子串命中、scope 过滤、limit、非法字符不炸」、`search.test.js:304`「keywordSearch：短查询路径同样过滤软删记录与 scope」 |
| 9 | Chroma 不支持关键词检索 → 混合检索自动禁用（纯语义） | 已覆盖·测试 | FTS5(trigram) + LIKE 兜底 + 向量，RRF 只排名次（`src/host/search.js`，契约 `DESIGN.md` §D）。测试 `search.test.js:257`「keywordSearch：3 字及以上走 FTS5，能命中」、`:265`「keywordSearch：2 字中文词必须命中（trigram 命不中，靠 LIKE 兜底）」、`:275`「keywordSearch：单字也必须命中」、`:281`「keywordSearch：多段查询按 AND 语义（走 LIKE 兜底）」、`:294`「keywordSearch：LIKE 路的通配符必须被转义」、`:323`「hybridSearch：两字查询也能通过关键词路贡献名次」 |

### D. 进程与索引

| # | 坑 | 状态 | 证据位置 |
|---|---|---|---|
| 10 | **Chroma 单进程铁律**：多进程访问会 `Error finding id` | 架构性消失 + 测试 | 库是单文件 SQLite：`busy_timeout=5000`、`foreign_keys=ON`、文件库 WAL（`src/host/db.js:148-154`）。测试 `db.test.js:45`「WAL 在文件库上生效；:memory: 上不启用」、`store.test.js:376`「文件库：同一个 store 反复开关后数据仍在（WAL 落盘）」 |
| 11 | 「条数不变」检测会漏判（删 5 加 5 净 0）→ 正解是比 `db/chroma.sqlite3` 的 mtime | 架构性消失 + 测试 | 新架构里不存在「索引与数据各存一份、靠时间戳判断同步」的结构：FTS 由 `memories_fts_ai/ad/au` 三个触发器与主表同步（`src/host/db.js:55-64`）。测试 `store.test.js:109`「hardDelete：真删行、FTS 索引同步删掉、向量级联删除、历史保留」、`store.test.js:132`「updateMemoryText：revision 递增、写 supersede 历史、更新 hash 与 updated_at」 |
| 12 | 索引段落后于数据 → `Error loading hnsw index`；修法是删索引段重建 | 架构性消失 + 测试 | 向量是 `vectors` 表的 Float32 BLOB，**按空间分组保留**、任何一套都可删可重算（`src/host/store.js` 的 `deleteAllVectors` / `deleteVectorsOfSpace`），没有独立的索引段文件。测试 `store.test.js`「向量：按空间写入、BLOB 往返、listVectors 分批生成器、过滤、统计、删除」与「多空间共存」、`search.test.js`「vectorSearch：按余弦排序、limit、模型维度过滤、零查询向量返回空」与「只认给定空间」 |
| 13 | 强杀进程（`Stop-Process -Force`）可能打断索引整理 | 架构性消失（附待补） | 没有异步 compactor；崩溃恢复交给 SQLite WAL。**待补**：没有做过「强杀 / 断电后库仍可读」的实测 |
| 14 | Windows 上 `SO_REUSEADDR` 允许两个进程绑同一端口 → 幽灵双监听 | 架构性消失 | 插件**不监听端口**：路由注册到宿主 webserver，且注册表按 pathname 建键、重复注册直接抛 `already registered`（`src/host/panel.js:476-480` 把这条记在注释里）；`DESIGN.md` §B |

### E. 工具链

| # | 坑 | 状态 | 证据位置 |
|---|---|---|---|
| 15 | `mcp` 2.x 里 `FastMCP` 改名 `MCPServer` | 架构性消失 | 不用 MCP：工具经 `ctx.tools.register` 直接注册进 DSH（`lib/index.js:484`） |
| 16 | `hermes mcp add` 的 `--args` 必须**最后** | 架构性消失 | 不做 MCP server 注册，没有 `--args` 这种东西 |
| 17 | `hermes.exe` 在 git-bash 里可能 Permission denied | 架构性消失 | 不用 hermes CLI |
| 18 | 同进程里对同一路径建两个不同 settings 的 Chroma client 会 `An instance of Chroma already exists` | 已覆盖·测试 | `openDatabase` 全幂等（DDL 一律 `IF NOT EXISTS`），插件只持有单一句柄（`src/host/db.js:141-179`）。测试 `db.test.js:17`「建库幂等：同一个文件开两次不报错，表与版本号都在」 |
| 19 | 本机 Clash TUN 让端口扫描出现**假阳性**（TCP 假握手、HTTP 无响应、ARP 无 MAC） | 架构性消失 | 插件不做任何端口扫描 / 连通性猜测；「活着吗」由宿主内能力自检回答（`lib/index.js:1364-1366`，默认关，`DESIGN.md` §H）。教训保留：**别拿端口探测当判据** |

---

## 二、18 个代码级缺陷

编号 1–17 是清点时点名的；18 是这次读源码时**新核实**的（同样有出处）。

| # | 缺陷（原版） | 原版证据 | 新架构下的状态与证据 |
|---|---|---|---|
| 1 | `/v1/livez` **不可达** | `mem0_service.py:1406-1407` 先按 `/v1/` 前缀分派给 `_v1_get`，而 `_v1_get` 里没有 livez 分支（`:1294-1332` 最后兜 404）→ `:1414` 的 `/v1/livez` 分支永远轮不到，只有 `/livez` 能用 | `架构性消失`：不自建 HTTP 服务；生存探针是宿主前缀表上的 `GET /dsh-memory-selftest/ping`（`lib/index.js:1364-1366`），前缀分派不会被 `/v1/` 抢先 |
| 2 | pending 接口**没有 `ok` 字段** → CLI 永远失败 | `mem0_service.py:454-469` `list_pending()` 返回 `{items,count}`；`mem.py:143-145` 却 `if not d.get("ok"): die(d)` → `mem pending` 必挂 | `架构性消失`：没有 CLI；批次与条目在 SQLite 里（`src/host/store.js:537-595`），工具侧 `lib/index.js:435` 返回结构化结果，面板 `GET /pending` 走统一信封（`src/host/panel.js:62`、`:217`） |
| 3 | `GW_MODEL` **恒为空** | `mem0_service.py:445` 是 `GW_MODEL` 在全仓的**唯一**出现处，没有任何地方设置它；真实模型名走的是 `mem0_config.py:29 MEM0_LLM_MODEL` | `架构性消失`：模型名由 `config.llm.provider/model` 给（默认 `null` = 用宿主当前模型，`src/host/config.js:31`），不存在「读了一个没人写的环境变量」这种形状 |
| 4 | v1 与 MCP 的 `keep` **差一位** | HTTP 侧 `mem0_service.py:1367-1370` 把用户给的 `keep` **原样**透传；`approve_pending` 按 0-based 用（`:475,490`）；MCP 侧 `mcp_server.py:276-278` 做了 `int(x)-1`；文档 `API-v1.md:69` 又说是「序号」→ 同一个 `keep="1"` 从 HTTP 来批的是第 2 条 | `已覆盖·测试`：`memory_review` 的 `keep` 明确定义为 **0-based 白名单**并在测试里钉死。测试 `review.test.js:181`「reviewBatch：keep 是 0-based 白名单，未选中的条目记 skipped 但仍在库里」；实现 `src/host/review.js`、`lib/index.js:456` |
| 5 | `/api/search` **忽略 scope** | `mem0_service.py:1472-1482` 写死 `filters={"user_id": DEFAULT_SCOPE}`，而同文件的 `/api/stats`（`:1432`）与 `/api/list`（`:1463`）都读了 `scope` | `已覆盖·实现 + 测试`：检索层一律收 `scope`（`src/host/search.js:111,172,260`），宿主 `searchText({scope})` 也收（`lib/index.js:1225,1256`）。**注意**：面板「搜索」页**有意**传 `scope: null`（全局视图，`src/host/panel.js:189-190` 有注释说明），这是设计不是忽略。测试 `search.test.js:73`、`search.test.js:304` |
| 6 | `int(limit)` 写在 **try 之外** | `mem0_service.py:1474`（`try` 在 `:1477`）与 `:1464`（`try` 在 `:1465`）：`?limit=abc` 直接抛 `ValueError`，外层没有兜底 → 连接断开，错误信息全无 | `已覆盖·实现`：面板每条路由的 `fetch` 都整体 try/catch 并永远返回 JSON 信封（`src/host/panel.js:516-543`），数字参数在 handler 内用 `Number.isFinite` 守卫（`src/host/panel.js:447-451`） |
| 7 | 时间比较用**分钟粒度** | `sync_palace.py:30,44,110`：`STAMP_FMT="%Y-%m-%d %H:%M"` 的字符串比大小 → **同一分钟内**改了源文件不会触发重灌；`import_palace.py:25,38`、`mem0_service.py:65,200,251` 同病 | `已覆盖·实现`：所有时间戳一律 `toISOString()` 毫秒级（`src/host/store.js:32-36`），且不存在「按 mtime 决定要不要重建」的路径（FTS 靠触发器，`src/host/db.js:55-64`）；`palace_sources` 里存的是真实 `mtime_ms`（`src/host/store.js:653-664`） |
| 8 | **离线路径仍用 Chroma API** | `sync_palace.py:50`（离线分支）调 `m.vector_store.collection.get(include=["metadatas"])` —— Qdrant 后端没有 `.collection` 属性（服务侧已在 `mem0_service.py:131-137` 注释里承认并改掉，脚本侧没改） | `架构性消失`：只有 `node:sqlite` 一条实现路径，服务侧 / 脚本侧 / 面板侧共用同一个 `MemoryStore`，不存在「某条路径用了别家的专有 API」 |
| 9 | `_db_stamp` **死代码** | `mem0_service.py:93-97` 读 `db/chroma.sqlite3` 的 mtime，但向量库早已是 Qdrant（`mem0_config.py:103-113`）→ 该文件不存在，恒返回 `0.0`；`memory()`（`:114-120`）的「stamp 变了就重建实例」判定因此永不触发 | `架构性消失`：没有「按指纹重建 process 内实例」这套机制（长连接句柄 + WAL + 触发器），也就不会有「判断依据恒为常量」的静默死逻辑 |
| 10 | 面板**硬编码 2560** | `mem0_service.py:666`（`Qdrant · 2560维`）、`:893`（`${e.dims ?? 2560}`）、`:941`（`!== 2560` 才 confirm） | `已覆盖·实现 + 测试`：维度只来自配置（`embedding.dimensions` / `localDims`，`src/host/config.js`），面板从接口读回显（`/config` 回 `config.embedding.dimensions`，`/state` 回各空间的 `dims`/`count` 与当前空间的 `missing`），`lib/client.js` 全文无 `2560`。测试 `config.test.js`「默认值…」「embeddingFingerprint…」、`panel.test.js` 的 `/state` 信封用例 |
| 11 | **文档漂移** | 两个实证：① `README.md:263` 说正解是比对 `db/chroma.sqlite3` 的 mtime，而 `mem0_config.py:103-113` 已是 Qdrant；② `API-v1.md:69` 把 `keep` 说成「序号」，实现是 0-based（见缺陷 4） | `待补`：本清单与 `README.md` 是**人工核对**的产物，仓库里**没有任何**自动校验保证文档与代码同步。这类漂移随时会复发（`DESIGN.md` 顶部那句「改了约定就要同步改代码与测试」目前靠自觉） |
| 12 | `打包迁移.py` 的 INCLUDE **缺文件** | `打包迁移.py:18-40` 的清单里没有 `embed_switch.py`、`sync_palace.py`、`mem.py`、`API-v1.md`、`AGENTS.md` —— 这些文件确实存在于 `payload/app/`；同时清单里又列着一堆本目录没有的文件（`start_gateway.sh`、`start-memory.bat` …） | `架构性消失`：没有打包脚本。插件就是目录本身 + profile 里一段 patch 块；哪些文件必须一起留着写在 `README.md`「安装 / 目录速览」里（`lib/index.js` 依赖 `src/host/*`，所以 `src/` 不能少） |
| 13 | `_v1_item` 产出**两种 metadata 形状** | `mem0_service.py:1012-1023` 用「排除 memory/text/id/embedding/score」的排除法抽 meta：`_all_rows()` 喂的是**扁平** payload（`:149-160`），而 `memory().search()` 喂的记录带 `metadata` **子对象**（`:1301`）→ 同一个「统一形状」的函数实际吐出平铺与嵌套两种。（两种输入形状是**读代码推断**的，没有做运行实测——`mem0_service.py:1016` 的排除法留下了这个口子） | `已覆盖·实现 + 测试`：只有一个形状来源 —— `store.getMemory` / `listMemories` 都走同一个 `parseMeta`（`src/host/store.js:44-55,182,199`），工具与面板都经它。测试 `store.test.js:27`「addMemory：同文本判重命中既有记录（created:false），meta 往返为对象」、`store.test.js:214`「meta 坏值容错：解析失败给 {}」 |
| 14 | `STAGING_SCOPE` **未使用** | `mem0_service.py:266` 定义后全仓再无引用（抽取的暂存靠 `pending/` 目录，不靠 scope） | `已覆盖·测试`：新实现的 scope 是真在用的参数并透传到写入（`src/host/review.js:135,227`）。测试 `review.test.js:233`「reviewBatch：scope 传给 addMemory」 |
| 15 | **raw 写入未加锁** | `mem0_service.py:1350`：`POST /v1/memories` 的 raw 分支直接 `memory().add(...)`，**没有** `with _lock`；而同文件的 `approve_pending`（`:488`）是加锁的 | `已覆盖·实现`（附说明）：`node:sqlite` 的 `DatabaseSync` 是同步 API，所有多步写都在 `withTransaction` 里（`src/host/db.js:204-230`，`BEGIN IMMEDIATE` / 嵌套 SAVEPOINT）+ `busy_timeout=5000`，单进程内没有「两个写操作交错」的窗口。测试 `db.test.js:77`「withTransaction 出错时回滚，嵌套时用 SAVEPOINT 只回滚内层」。**但**没有并发压力测试 |
| 16 | supersede 时把旧内容**覆盖**掉 | `mem0_service.py:499-506`：`memory().update(oid, text=t2)` 直接改写旧条，服务自己不落旧正文（只依赖 mem0 的 `history.db`）；且 `except: pass` 吞掉失败后仍 `continue` | `已覆盖·测试`：新实现改写前先把旧正文写进 `history`（`op='supersede'`、`prev_text`、`next_text`），`revision` 递增（`src/host/store.js:252-284`）。测试 `store.test.js:132`、`review.test.js:242`「reviewBatch：supersede → **只改写旧记录、不新增**，历史里留下 prev_text」 |
| 17 | `service_client` **硬编码** | `service_client.py:13` 写死 `SERVICE = "http://127.0.0.1:8899"`（不看任何环境变量，换端口就全废）；且 `:18` 的 `alive()` 用 `/health`，而 `mem0_service.py:1412-1413` 自己写着「`/health` 会读记忆条数，不适合当『活着吗』的判据」 | `架构性消失`：没有独立服务、没有端口可配错。面板路由前缀是同一个宿主进程内的常量 `ROUTE_PREFIX = '/api/dsh-memory'`（`lib/index.js:36`），「服务没起来」这种失败模式不存在（只有插件行没激活） |
| 18 | **全量列举有 10 万条硬上限、超出即静默少报** | `mem0_service.py:131-138` `_all_rows(top_k=100000)` 被 `:1285`（`/v1/health` 的 `count`）与 `:1310`（`/v1/memories` 的 `total`）当「全量」用 → 超过 10 万条时条数是错的，而且不报错 | `已覆盖·实现 + 测试`：条数走 `COUNT(*)`（`src/host/store.js:208-211`），分页 `listMemories` 返回真实 `total`（`src/host/store.js:191-200`）；导出/导入的分页读取以 `total` 为终止条件（`src/host/portability.js` 的 `collectRows`）。测试 `store.test.js:51`「getMemory/listMemories/countMemories：scope 过滤、分页、includeDeleted」 |

---

## 三、仍然空着的（诚实版待补清单）

这些不是「原版缺陷」，而是**新实现里现在没人盯着的地方**，按风险从高到低：

> **2026-10-06 复核**：原来的第 1 条（导出/导入工具没接进 `lib/index.js`）与第 2、3 条
> （LLM 适配器 / 面板路由没有自动化测试）都已不成立，从清单里删掉了——工具见 `lib/index.js:425-457`，
> 适配器抽到 `src/host/llm.js` 并由 `test/llm.test.js` 盯着，面板路由护栏在 `test/panel.test.js`。

1. **客户端束 `lib/client.js` 仍然没有测试。** 五个页签只能靠人点；`panel.js` 的路由有护栏了，
   但「客户端半读回的字段与宿主半返回的形状对不上」这类问题仍然只能靠肉眼。
2. **崩溃恢复没有实测。** 血泪坑 #13 在新架构下理论上由 SQLite WAL 兜住，但没跑过「强杀进程 / 断电后重开」。
3. **文档与代码的漂移没有自动校验**（缺陷 #11 就是这一类）——这份清单本身刚才就漂了四条，见上面那段复核。
4. **并发写入没有压力测试。** 缺陷 #15 的结论「单进程同步 API 下没有竞争窗口」是代码推理，不是实测。

### 已闭环（本轮盘点发现的）

- **`memory_export` 导不出非默认 scope。** 原状：`exportPack` 的约定是 `scope: null` = 全部 scope，
  但 `MemoryService.exportMemory` 归一成了 `scope ?? config.scope`，显式 `null` 被吃掉。
  现在：归一逻辑抽成 `resolveExportScope`（`src/host/portability.js`）——**省略** = 默认 scope，
  **显式 `null` / `allScopes: true`** = 全部 scope，坏值抛错而不静默；工具加了 `allScopes` 参数。
  判据：`test/export-scope.test.js` 6 例（含用假 ctx 直接构造 `MemoryService`、并抓住注册的工具定义
  跑 `execute()` 的接线测试——其中一例专门钉「缺席被投影成 `null` 时不能误判成全导」）。
  为了让它们可测，`lib/index.js` 末尾导出了 `MemoryService` 与 `registerMemoryTools`
  （只为测试，`apply()` 之外没人用）。

### 已闭环（2026-10-06 · 多向量空间）

- **换嵌入模型必须全量重算**（原设计的硬伤）：v1 的 `vectors` 主键是 `memory_id`，
  一条记忆只有一套向量，切模型只能覆盖或自毁。
  现在：schema v2，主键 `(memory_id, space)`，`space = provider:model:dims`；
  换模型 = 新建空间，**旧空间一行不动**；切回来只补「离开期间新增的」那几条
  （`countMissingVectors` / `listTextsMissingVector`；旧的「遍历全库 + 逐条 getVector」写法已删除）。
- **自定义线上 / 局域网 / 本地模型**：嵌入配置变成**库里的档案**
  （`settings.embedding.profiles` + `settings.embedding.active`），`resolvedConfig()` 用生效档案
  覆盖 patch 里的 `embedding` 块 —— 切 url / key 引用 / 模型 id 不用改补丁文件、不用重启；
  密钥仍只进 DSH 凭据库（按档案各自的 `apiKeyRef` 分别存）。
  面板新增 `/profiles`、`/profile`、`/profile-delete`、`/activate`、`/embed-test` 五条路由（路由总数 14 → 19）。
- **v1 老库原地升级**：老表改名 `vectors_v1` 留底 → 按 `(memory_id, space)` 重建 → 逐行搬迁，
  空间键用**行自己的** model/dims（+ provider 提示）拼 —— 升级前刚换过配置也不会把旧向量错认成新空间；
  迁移幂等（中断后重开补搬），结果由 `lastMigration(db)` 暴露。
- 判据：`test/spaces.test.js` 4 例（用离线 `local-hash` 走完整流程：A 补齐 → 切 B 补齐 →
  离开期间新增 1 条 → **切回 A 的任务总量 = 1 条**而不是重算 4 条；另覆盖档案校验、删档案不删向量、
  检索只认当前空间、`testEmbedding` 自检）；`test/db.test.js` 新增 4 例（迁移三条路径 + 空间键口径一致）；
  `test/store.test.js` 新增 3 例（多空间共存、missing 统计、active 空间形状）。

### 已闭环（2026-10-06 · 原型功能对账，五项采纳 + 一个漏洞）

盘点 `项目原型/`（mem0 + Qdrant 那套）后，把**没有采纳但有价值**的功能补齐了。逐条：

| # | 原型证据 | 新实现 | 判据 |
|---|---|---|---|
| ~~1~~ | `palace_lib.py`（切块）+ `sync_palace.py`（增量）+ `/api/ingest`·`/api/sync` + MCP `memory_sync` | **2026-10-06 当晚退役**（用户判定无用）。曾实现为 `src/host/palace.js` + `memory_palace` 工具 + `/palace` 路由；已从代码/工具/路由/面板/配置/文档中清除，归档在 `.retired/palace/`（含模块、测试与所有被改动文件的完整快照）。**退役理由**：宫殿是**一次性引导**——605 条内容导出并导入完成后，库就是唯一源，磁盘上也没有宫殿 md，「以磁盘源为准的同步器」没有活干 | 退役时的判据（仍留在归档里）：`test/palace.test.js` 9 例 + 服务层 1 例；其中「采纳闸门」是验收时真实库副本上抓出来的：一个合成文件匹配到 79 条真实热区记忆，没有闸门就会删掉重灌 |
| 2 | `POST /api/embed/rebuild`（后台 + 进度 + 原地覆盖） | `startBackfill({mode:'all'})` + `/backfill {mode}` | `test/maintenance.test.js`「把被改坏的向量修回来」：`missing` 修不掉、`all` 修得掉 |
| 3 | `DELETE /v1/memories/{id}` 真删 | `memory_forget {hard:true}` + `/forget {hard}` | 同文件「默认软删、hard 真删且 history 留痕」 |
| 4 | `/api/backup`（可读导出 + Qdrant 快照，留最近 3 份） | `backupNow` / `memory_backup` / `/backup`：**`VACUUM INTO` 在线一致性快照** + 文本包，留最近 N 份 | 同文件「库本体快照 + 文本包，且只保留最近 N 份」 |
| 5 | `/v1/capabilities`（agent 自描述）+ `/api/stats` 的 scope 分布 + `/v1/health.llm.available` | `memory_stats` 加 `scopes` / `capabilities`（动态能力清单）；`memory_stats {probe:true}` 真调一次 LLM 预检；面板 `/llm-test` | 同文件「带 scope 分布与能力自描述」「llmProbe：有可用模型时回报文本与耗时，没有 llm 服务时如实报错」 |

**顺带修掉一个既有漏洞（不修会一直咬人）**：`updateMemoryText` 过去**不失效向量** ——
审阅门 supersede 改写正文后，该条在所有空间里的旧向量原样留着。后果是双重的：
语义检索继续按旧文本的向量出结果；而 `countMissingVectors` 因为「向量行还在」看不见它，
**增量补齐永远修不掉**（原型那颗「完全重建 embedding」按钮正是为这类脏向量存在的）。
现在：改写与删向量在同一事务里完成、返回 `vectorsDeleted`，审阅门用 `onUpdated` 回调把这条
重新排进嵌入队列。判据：`test/store.test.js`「正文一改，该条在所有空间里的向量立刻作废」、
`test/review.test.js`「supersede 会作废旧向量，并回调 onUpdated」。

> 对账也确认了**不需要回搬**的部分（架构性消失）：MCP server、`mem` CLI、
> gateway 注入 `think=false`/`num_ctx`、`/api/restart|shutdown`、Qdrant/vc_redist 安装器、
> 端口复用坑、开机自启。

### 新增能力（2026-10-06 晚 · 自主录入）

需求原话：「记忆系统跟随 agent 运行进行原生级自主记忆录入」+「用户手工提供事实描述并送入记忆系统
供 LLM 提取出记忆进行录入」。落成两条通路，归属规则由用户当场拍板。

- **通路一（跟随 agent 运行）**：挂 `session/event` → 每会话一个转录缓冲 → `turn/end` 时按
  「累计未抽取用户正文 ≥ `capture.minChars` + 过了 `capture.cooldownMs`」触发后台抽取。
  **连入的那个 agent 自己的会话免审直接入库**（`source: 自主捕获`、`kind: auto`）；
  **子代理/委派会话进待审区，由这个 agent 审阅**（`analyzeConflicts` → `reviewBatch`，
  supersede 只取最相似一条）。三条不变量：不阻塞回合、节流、可关。
  纯逻辑在 `src/host/capture.js`（可单测），编排在 `lib/index.js`。
- **通路二（用户手工提供）**：面板「待审」页的**手动录入**卡片 —— 「原文直存」走 `POST /remember`
  （不过 LLM、立刻入库）、「交给 LLM 提取」走 `POST /extract`（落待审区 → agent 审阅）。
  路由本来就有，缺的是入口，这次补上。
- **prompt 级自主**：系统提示与 skill 的写入策略改成「**学到长期有效的事实时主动记，不必等用户说记住**」，
  并说明后台捕获的存在 —— 让 agent 知道「哪些该它自己做、哪些插件已经在做」。
- 判据：`test/capture.test.js` 8 例（纯逻辑 4：只取 text 块 / 归属判定 / 阈值与冷却 / 缓冲 take 与截断；
  服务层 4：**自己的会话免审直入库**、**子代理进待审 + agent 审阅后入库**、阈值/冷却/开关都不抽、
  **审阅判 supersede 时只改旧记忆不新增且留 history**）。
  踩过一个坑并写进 DESIGN §E.3：`note()` 必须返回**累计**未抽取字数，返回本条事件的字数会让
  `turn/end`（不带正文）永远触发不了。

### 新增能力（2026-10-06 深夜 · 仓管）

需求原话：「插件内置一个 LLM，专门用于接入 Local LLM …成为记忆系统的**仓管**，负责对已录入的所有记忆
进行**二次消化**、对已录入但**大段的记忆进行无损研磨**」。用户当场定了三条：**研磨改写原文（原文只留 history）**、
**拆细 / 去重分开触发**、**通道指向局域网 Ollama**。

- **自带通道**：`src/host/locallm.js` 直连 `ollama /api/chat` 或 OpenAI 兼容 `/chat/completions`，
  **不经宿主的 `ctx.llm`**；密钥仍走 DSH 凭据库（`keeper.apiKeyRef`）。这样全库加工不会把整库正文发给云 API。
- ~~**无损由代码兜底**（本条需求的技术核心）~~ ⚠️ **这一条已于 2026-10-07「五轮」作废**（见文末那一节）。
  当时 `keeper.js` 的 `coverageOf()` 做**子序列覆盖率**核对（碎片按序拼接必须是原文的子序列、≥98%），
  不达标就 `losslessSplit()` 确定性切分 —— 模型只负责「切得漂亮」，「一个字都不能少」由代码保证；
  面板显示 `losslessFallback`，让「模型有没有偷懒」可见。**现在 `split` 只跑「每块自足 / 不丢内容 / 不新增」三条证据**，
  `losslessSplit()` 降级为「模型没给可用碎片 / 只给了一块时的兜底」。
- **落库语义**：第 1 块写回原记忆（`history.prev_text` = 完整原文，回滚入口），其余块带 `meta.derivedFrom` 入库；
  消化先做去重（向量近邻 + 仓管判「同一件事」→ 并集写回 + 被并的软删 + `meta.merged[]` 留痕）；
  `revertKeeper()` 把三类痕迹全清回来。后台任务 + `jobs` 表审计 + `memory_keeper` 工具 + 3 条面板路由 + 面板卡。
- 判据：`test/keeper.test.js` 13 例 —— 通道的三种配错与两种端点的请求形状/鉴权、HTTP 失败与响应格式错误报原文、
  `coverageOf`（原样切分 100%、改一个字就掉下来）、`losslessSplit`（覆盖率 1.0 且尊重单块上限）、
  提示词解析、**研磨采信**（原文进 history、余块带 derivedFrom）、**有损输出自动兜底后对原文覆盖率仍为 1.0**（⚠️ 此行为已于五轮作废）、
  拆不开只打标记不重试、**消化去重 + 回滚把软删的放回来**、**回滚删产物并恢复原文**、未配置时如实报错。
- 踩到并修掉的三个坑：① `losslessSplit` 原先把 `maxChars` 下限钳到 80，导致「单块 ≤ 40 字」成了假话（改成 20）；
  ② 测试里拿 `listMemories` 的重建顺序核对覆盖率 —— 它按 `updated_at` 排、**不是插入序**，要改用
  `listKeeperArtifacts().derived`（`ORDER BY rowid`）；③ 测试桩替换了 `createKeeperClient`，
  把「未配置必须报错」这条校验也绕过去了 —— 验配置的用例必须先 `delete` 掉桩。

### 新增能力（2026-10-07 凌晨 · 仓管多档案 + 线上/本地切换）

仓管的 LLM 通道从「单组配置（只能指本地 Ollama）」升级为**多档案 + 主动切换**：线上 OpenAI 兼容 / 局域网 / 本机三类都能配，
面板上切一下**立刻生效、不用重启**。

- **档案模型**：`settings.keeper.profiles`（JSON 数组）+ `settings.keeper.active`（当前生效名）；**内置只读档案 `config`** 来自 patch，
  永远排第一、`builtin: true`、不可删。生效是 `config` 时 `keeper` = patch + `keeper.overrides`；是具名档案时 = patch + **该档案字段**
  （`overrides` 不参与合并）。
- **首批种子只播一次**：「线上」= `openai` + `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`（**占位，按实际模型改**）
  + `apiKeyRef: DASHSCOPE_API_KEY`；「局域网-ollama」= `ollama`、地址与模型留空待填。播种判据是**键从没写过**，不是「数组为空」——
  删光了不塞回来；播种挂在 `listKeeperProfiles()` 上（副作用），所以首次 `/state`、`memory_stats`、`action=profiles` 都会触发那一次写入。
- **主动切换立刻生效**：`activate` 只改一行设置（切 `config` = 删掉那个键）、不用重启；**删掉生效档案自动回落 `config`**；
  `test {name}` **只测那个档案、绝不改 active**；`save` 是 upsert 且**只写库、不切换**。
- **两个坑，导致我改了两处代码**：
  1. **密钥取错了信封**：`resolveKey()` 回的是 `{source, value, described}`，一开始把整个信封塞进 `Authorization`，
     于是线上端点收到的是 `Bearer [object Object]`，只回 401 `invalid_api_key`；而**同一把凭据嵌入却是通的**，从现象上根本反推不到。
     改成取 `.value`。
  2. **按名字测档案既没先播种、又拿错了形态**：`listKeeperProfiles()` 有播种副作用（种子只在它里面写库），但它返回的是**视图对象**
     （`endpoint` 已归一、没有 `baseUrl` / `ollamaUrl`），直接喂 `profileToKeeper()` 会得到空对象。修法是那条路径先
     `listKeeperProfiles()` 播种、再回 `keeperProfilesState()` 的**原始条目**查。不修的话：**重启后第一件事 `test {name:'线上'}` 会假报「没有这个档案」**。
- 判据（`test/keeper.test.js` **第 4 节：档案 / 切换**，行 439–752）：`仓管档案：首批种子只播一次；内置 config 排第一、只读不可删`、
  `保存档案：非法 provider 当场报错、不落库；空串/null = 删掉该键`、`切到「线上」立刻生效：resolvedConfig().keeper 变成 openai + DashScope（不用重启）`、
  `切回 config 回落 patch；删掉生效档案也自动回落 config`、`keeperTest({name})：只测那个档案，绝不改 active`、
  `memory_keeper 工具：profiles / save / delete / activate / test(name) 都接到服务方法上`、
  `线上档案取密钥：Bearer 里必须是信封里的 value（不能是整个信封）`、
  `重启后第一件事就「按名字测档案」：不能因为种子还没播就说「没有这个档案」`、
  `线上档案但凭据库里没有密钥：明确报「取不到密钥」而不是发一个坏请求`（**没密钥时不发请求**：用例把 `fetchImpl` 换成直接抛错的桩来钉住）。
- **账号侧现象（不是 bug）**：线上档案用过的 DashScope key 可能回 **403 `AllocationQuota.FreeTierOnly`**（免费额度用尽 /
  账号处于「仅免费额度」模式）—— **鉴权已经通过了**，只是在配额上被挡；换个有额度的模型或开付费额度即可，局域网 Ollama 不受影响。

### 仓管范式升级（2026-10-07 凌晨）

仓管从「跑一轮**直接改库**」升级为「**出单 → 审阅 → 落库**」。这是本轮最重要的一次语义变更，
判据全部在 `test/keeper.test.js`。

- **旧直改路径已删除**：宿主侧的 `startKeeper` / `runKeeper` / `grindOne` / `dedupePass` 全部不存在了
  （`lib/index.js:2574` 留了一行注释说明），**`reviewKeeperPlan()` 是唯一会改记忆库的入口**。
  出单走 `startKeeperRun()` → `void runKeeperRun(...)`：只往新表 `keeper_plans`（`SCHEMA_VERSION=3`）写变更单，
  随机抽 `keeper.sampleSize`（20）个种子 → 每个种子语义召回 `keeper.perGroup`（5）个邻居成一组 → 每组一次调用出一张单。
- **面板与路由**：新增第 6 个页签「仓管待审」（`keeperQueue`）+ 4 条新路由
  `POST /keeper-run` / `GET /keeper-plans` / `GET /keeper-plan` / `POST /keeper-plan-review`；
  旧的 `POST /keeper` 保留为 `/keeper-run` 的兼容别名（老的 `mode` / `limit` / `minChars` 一律忽略，不会再变成直接改库）。
- **工具层补齐 `edits`**（本轮收尾修的真缺口）：`memory_keeper {action:'review'}` 原先写死 `edits: {}`，
  agent 审阅时**根本改不了字**（只有面板 `/keeper-plan-review` 能改）。现在 schema 有 `edits`
  （键是 op 的 `idx` 字符串：`split` 收**字符串数组**、`rewrite` / `merge` 收**字符串**、`drop` 忽略），
  并在工具层**逐键按 op 类型校验**：非对象 / 类型不合 / 下标越界 / 空串 / `reject` 与 `edits` 同时给 → `ok:false` + 报错原文，**不落库**。
- **超时信号不再用 `AbortSignal.timeout()`**：`locallm.js` 与 `embed.js` 都改用 `src/host/timeout.js` 的
  `timeoutSignal(ms)`（自建 `AbortController` + `setTimeout(...).unref?.()` + 请求结束 `finally { clear() }`）。
  超时 reason 仍是 `name='TimeoutError'` 的 `DOMException`（`code=23`），**超时语义没变**。
  ⚠️ **诚实记录**：本机 Node **v24.21.0** 下 `AbortSignal.timeout()` 的定时器**已经是 unref 的**
  （`node -e "AbortSignal.timeout(120000)"` 0.04s 就退出），所以本轮**没能复现**「跑完还赖活 ~120s / `test/.tmp` 删不掉」——
  修改前后 `keeper.test.js` 跑完都是 `node 进程数 0`、`test/.tmp` 立刻可删。改动按需求落地（显式 unref + clear），
  在「定时器不 unref」的运行时上才是真修复；`clear()` 那半是确定性的收益（请求结束就撤定时器）。
- **判据**（`test/keeper.test.js` **42 例**：范式升级时为 39 例，本轮收尾补了 3 例）关键几条：
  `run：出单阶段**一个字都不写记忆库**，只多一张 open 变更单`、
  `split 落库：第 1 块改写原文、其余带 derivedFrom 入库，拼起来 100% 无损`、
  `reject：整单驳回只标记，记忆库一个字都不碰`、`只勾选部分 op：其余一个字都不动，状态记 partial`、
  `review 的 edits：能把 op 的 after 换成审阅者自己写的正文`、
  `review 的 edits 类型按实现口径：split 收**字符串数组**、merge 收**字符串**`、
  `memory_keeper 工具：run / grind / digest 都只出单，记忆库一个字都不改`、
  `memory_keeper 工具：review 带 edits → 落库文本就是手改后的文本（split 收数组）`（本轮新增）、
  `memory_keeper 工具：edits 类型不合 → ok:false 报原文，且一个字都不落库`（本轮新增）、
  `createLocalLlm：自建超时信号仍是 TimeoutError（换掉 AbortSignal.timeout 后语义不变）`（本轮新增）。
- **已知边界（都不打算在这轮修，写下来免得被当成 bug）**：
  1. **审过的单不能再审**（`approved` / `rejected` / `partial` 一律拒绝重复审阅）—— `partial` 单**没法再审剩下的 op**，
     想要剩下那几条得重新跑一轮出单；
  2. **`edits` 落库前不重跑任何校验**（`coverageOf()` / `factCheck()` / `addedTerms()` / `selfContained()`）：
     手改的正文由人负责，`split` 手改后是否还**自足**、`rewrite` 有没有丢数字 / 有没有新增，系统都不再核对；
  3. **`keeper.digestMinChars` / `keeper.dedupeThreshold` 已不再参与加工逻辑**：去重合并那一遍（旧「消化第一阶段」）随之取消，
     两个键只剩「档案字段 + 面板显示」，不再影响任何行为；
  4. **`store.listKeeperCandidates` 暂无调用方**：出单改走「种子抽样 + 语义召回邻居」，这个旧候选筛选方法留着没删，但已是死代码。

### 语义回归（2026-10-07 · 三轮）：**作废「只准删、不准改」**，回到「允许改写、只钉事实要点」

用户最终原话：「**灵活一些 让LLM视情况决策 缩写、去冗余、优化语序 都是被允许的**」。
上一轮（二轮）照更早那句「去除冗余字符、保留纯记忆」把 `rewrite` / `merge` 收紧成了
**「只准删、不准改」+ `after` 必须是原文（`merge` 是并集）的子序列 + 「⚠ 不是纯删除」定性**。
**那一版作废，本仓库不留两套**：代码、测试、README、DESIGN 里的该口径全部改回本节的语义。
（诚实记录：这轮开工时那个过严版本刚被一次并行改动落进 `keeper-plan.js`（445 行）与 `test/keeper.test.js`（49 例），
本节既是对它的回退、也是对最终语义的重新钉死；`keeper.js` 与 `losslessSplit()` **一行都没改**。）

- **不变量只剩三条**（其余全放行）：
  1. **事实要点不许丢**：人物 / 时间 / 决定 / 数值（数字 / 日期 / 版本号 / 端口）/ **引号里的原话** /
     emoji 与标签符号（🎞️🎥📍💬🔊 之类）；
  2. **不许新增**原文没有的事实；
  3. **不许把不确定的写成确定的**（「可能 / 大概 / 听说」不能变成断言）。
  缩写、去冗余、优化语序、同义换词、把几句理顺、合并、必要时改错别字 —— **都是允许的**。
- **`factCheck(before, after)` 只产证据，形状回到 `{ok, lengthRatio, missingNumbers, missingTerms}`**：
  - `ok` **只**反映硬信号（数字 / 日期没丢），不再掺长度比；
  - `missingNumbers` → `factWarnings()` 写成 `丢了 N 个数字：…`（硬信号，`previewList` 只显示前 5 个）；
  - `missingTerms` → 中性措辞 `消失的片段：…`；候选是**内容片段**而不是逐字对齐的结果：
    引号原话（**连引号一起**）→ emoji 标签簇（按图形字符切，`🎞️` 绝不被拆成半个）→ 汉字串 / 拉丁词（≥2 字）。
    **为什么不用逐字对齐**：优化语序时子序列对齐会切出读不通的碎渣 —— 实测一句 77 字的记忆改写成 58 字后，
    逐字对齐给出的片段是 `但是周三还要去医院复查，指标是3.5，医生说「记得带` / `报告」，📍复查地点在老` / `区`
    这种；片段级证据则是 `宝宝喜欢喝冰美式` / `就是早上起来一定要喝一杯` / `她其实是习惯凌晨睡的`
    / `但是周三还要去医院复查` / `指标是` —— 审阅者能一眼看懂。
    纯填充词（`STOP_WORDS`，**只有整段什么都不剩**时才丢）与重复项被过滤；**引号原话 / emoji / 带数字的词排最前**
    （`fragmentRank`）；单个片段超过 30 字截断（`TERM_PREVIEW_CHARS`）；上限 `TERM_LIMIT = 20`；
  - `lengthRatio` → `压缩到 X%`（中性）；**只在 `< LOW_LENGTH_RATIO = 0.4` 时**附「留意是否过度缩写」，
    正常去冗余变短**不报警**（`MIN_LENGTH_RATIO` 那套「压太狠算不 ok」作废）。
- **不做「违规」定性**：没有 `⚠ 不是纯删除`、没有「新增/替换」清单、`alignDiff()` / `runsOf()` / `coverage === 1`
  那套判据全删。理由：同义改写必然产生新字，代码判不了「是不是新增了事实」，硬报只会变成噪音；
  「不许新增 / 不许把不确定写成确定」改由**提示词 + 人审**负责（已写进 `PLAN_PROMPT`）。
- ~~**`split` 的逐字无损一个字都没放松**~~ ⚠️ **已于同日「五轮」作废**。旧文：仍用 `keeper.js` 的
  `coverageOf()`（≥98%）+ `losslessSplit()` 确定性兜底，`publicKeeper().losslessFallback` 照旧计数。
  **新口径见文末「五轮」**：`split` 跑「每块自足 / 不丢内容 / 不新增」，`losslessSplit()` 只在模型没给可用碎片时兜底、
  该 op 带结构化标记 `fallback: true`，计数也只认这个字段。
- **出单提示词重写**：明确「改写是允许的，请视情况灵活决策：缩写、去掉重复啰嗦、优化语序、把几句话理顺、
  换同义说法、必要时改错别字」，同时钉住三条不变量、以及「过期 ≠ 删除」（要加时间锚而不是删内容）。
  （原句里那半句「`split` 必须逐字无损」随五轮作废；现在提示词**最显眼处**是「每块 / 每条都必须自足」。）
- **同轮修掉的两个已确认回归**：
  1. **`keeperStatus()` 顶层字段读错源**（面板仓管卡显示「未配置」）：旧实现先 `resolvedConfig()`、后 `ensureStore()`，
     而档案存在库里 —— 库没开时 `keeperProfilesState()` 恒回空、`activeKeeperProfile()` 恒回 `null`，于是悄悄回落 patch，
     出现 `active:'线上'` 而 `configured:false / provider:'ollama' / model:null` 的自相矛盾（重启后第一次打开面板必现）。
     修法：新增 `resolvedKeeperConfig()`（**先 `ensureStore()`**，再按生效档案解析：`config` → patch + `keeper.overrides`；
     具名 → patch + 该档案字段），`keeperStatus()` 与 `createKeeperClient()` 的默认参数**共用它**。
     本轮**另外修了同样顺序错误的两处**：`keeperTest()`（不带 `name` 时原来先 `resolvedConfig()`）与
     `startKeeperRun()`（原来 `resolvedConfig()` 在 `ensureStore()` 之前）—— 不修的话冷启动第一轮 `run` / `test`
     会拿 patch 的 `model:null` 去建客户端、报假的「未配置模型」。`hint` 也按生效档案分支：
     具名档案时提示去「仓管 → 档案」补，而不再误导人去改 `keeper.model`。
  2. **面板两处旧文案**：仓管卡按钮「研磨大段」→「**出变更单（随机抽样）**」、「消化全库」→「**抽样 + 去重合并（出单）**」；
     digest 的二次确认里「重复项会被软删」已不成立（出单阶段不删任何东西）→ 改成「这一轮只出变更单，不会改动任何记忆；
     重复 / 合并要等你审阅通过才落库」。中英各一份、键成对（`check-client.mjs` 会核对键集合一致）；
     顺手把同卡任务标题 `keeperModeGrind/Digest`（原显示「研磨 / 消化」，而 `mode` 现在恒为 `run`）改成「出变更单」，
     并把 `lib/client.js` 里那段「digest 先软删重复项再拆细」的旧注释改对。
- **判据**（`test/keeper.test.js` **58 例**：二轮那批过严用例按新姿态改写或删掉，另补了「语序优化零警告」等新用例；
  「五轮」又补了 6 例自足 / 新增片段 / `fallback` 计数用例）：
  `PLAN_PROMPT：明确允许缩写 / 去冗余 / 优化语序，并钉住三条不变量`、
  `factCheck：只产证据 —— 数字是硬信号，消失的片段（引号原话 / emoji 优先）与压缩比是线索`、
  `factWarnings / planWarnings：中性措辞（丢数字 / 消失的片段 / 压缩比 / 缺主语），不出现「违规」定性`、
  `rewrite：同义换词 / 改错别字 → 允许出单，证据是「消失的片段」，没有「违规」字样`、
  `rewrite：只优化语序 / 缩写而要点齐全 → 零警告（这是允许的正常改写）`、
  `merge：拿各条原文的并集当证据基准 —— 事实要点丢没丢，一眼能看到`、
  `压缩比：极低才附「留意是否过度缩写」，正常去冗余变短不报警`、
  `anchorsOf / selfContained：锚点来自专有名词 / 英文与数字标识 / 高频主题词；缺主语判得出来`（五轮新增）、
  `addedTerms：允许重复，禁止发明`（五轮新增）、
  `split：只有「边界=…」的块 → 报缺主语；每块都补回锚点（重复主语）→ 不再报`（五轮新增）、
  `split：模型自己加信息 → 报「新增了原文没有的片段」；数字 / 引号原话 / emoji 丢了 → 照旧「消失的片段」`（五轮新增）、
  `回归（用户 2026-10-07）：修前缺主语的块有 warning，修后补回主语词就没有（都只产证据、不改判）`（五轮新增）、
  `losslessFallback 认结构标记：带证据的 split 不算兜底，真兜底才算并带 fallback:true`（五轮新增）、
  `split：有损输出不再被兜底抹平（旧「逐字无损」承诺作废）；losslessSplit 只在没给可用碎片时兜底`（五轮改名重写）、
  `rewrite 落库：丢数字 / 消失的片段写成 op 证据，审阅者一眼能看到（证据不改判）`、
  `keeperStatus：顶层 configured/provider/endpoint/model 必须来自**生效档案**（重启后第一次问也一样）`
  （本轮把该用例加严：冷启动的 `keeperTest()` 与 `startKeeperRun()` 也一起钉住 —— 把三处任一处改回
  「先 `resolvedConfig()`」都会如实失败）、
  `真实数据回归（离线）：3 条重复表述出单 —— 允许同义改写，证据只列「消失的片段」`。
- **已知取舍（不谎报）**：
  1. **`addedTerms()` 只抓「连续 ≥2 个原文字典里没有的新字」**：这样同义换词 / 语序调整 / 引号样式变化不会误报
     （免得天天狼来了），代价是用原文里的字重新拼出来的新说法抓不到；**「把可能写成确定」仍然只有提示词约束 + 人审兜着**；
  2. **`merge` 的压缩比拿「各条原文的并集」当分母**，所以多路合并天然显得压得很狠（几条近似重复并成一条 → 25% 很常见），
     此时「留意是否过度缩写」只是提醒人看一眼，不代表内容被压坏；
  3. **片段级比对不逐字**，删掉一个虚词这种极小改动可能不出现在「消失的片段」里（有「压缩到 X%」兜着）；
  4. **面板仓管卡的输入框已接线**（2026-10-07 本轮收尾）：原「本次最多处理 N 条（留空 = 不限）」死控件
     已换成真的 `sample` / `perGroup` / `maxGroups` 三个输入 —— 客户端只 append **填了的**键，
     body 里**已无 `limit`** 这个死参数，`POST /keeper-run` 也真的透传 `mode`。
     同时「两个按钮语义塌成一样」更新成现在的形态：`mode`（`grind` / `digest`）**只作提示词侧重**
     （`grind` = 全部手段 / `digest` = 偏重去重合并），**不是两种任务，都只出变更单、一个字都不写记忆库**。
     二轮记的「README 注意事项第 14 条还在说消化会软删重复项」**已改掉**。

### 事故与抢修（2026-10-07 · 本轮）：`lib/index.js` 被 PowerShell 双重编码，已按会话记录重建

⚠️ 如实记录一次**自伤事故**（不是需求的一部分，但文件被改坏就得说清楚，别让人以为历史是干净的）：

- **怎么坏的**：为了确认刚写的回归用例真的会失败，我用 `pwsh` 做了一次「读文件 → 字符串替换 → 写回」的
  临时验证（把三处 `resolvedKeeperConfig()` 换回旧写法）。本机 `pwsh` 是 **Windows PowerShell 5.1**，
  它对**没有 BOM** 的文件用 **cp936（GBK）** 解码：`Get-Content -Raw` 读出乱码字符串，
  `[IO.File]::WriteAllText(..., UTF8)` 再把乱码按 UTF-8 写回 → `lib/index.js` 被**双重编码**，
  中文全成乱码，且 **1125 处字符的最后一个字节被 `?` 吃掉**（不可逆）。逐字节证据：文件从 167641 字节
  涨到 190133 字节，`gbk 编码 → UTF-8 解码` 后仍是 167486 字节、带 1125 个 `U+FFFD`。
  **只有 `lib/index.js` 中招**（`lib/client.js`、三份 md、测试文件都没经过那条路径）。
- **怎么修的**（三步，全部离线、不碰真实记忆库）：
  1. **可逆映射**：对乱码串做 cp936 编码、再按 UTF-8 解码，拿回约 96% 正文，剩下 **614 行**带空洞；
  2. **从会话记录重建**：`~/.dsh/sessions/**/session.v4.jsonl.zstd` 是**多帧 zstd**（按 `28 B5 2F FD`
     拆帧单独解压才拿得到全部内容），里面存了各轮 agent 对 `lib/index.js` 的 `read` 结果（带行号）
     与工具调用的 `old_string` / `new_string`。把两者当作候选，按**内容通配对齐**补空洞
     （空洞当任意字符；有多个候选时优先取更长的，因为空洞至少吃掉 1 个字符）→ 补回 **584 行**；
  3. **逐字手补 30 行**：15 行是并行改动新写的 `validateKeeperEdits` 文案（此后没有任何会话读过它），
     其余是本轮我自己改过、同样没被再读到的注释。其中若干行的正确文本用 `test/keeper.test.js` 里
     **完好无损的断言**反推（如 `/op 是 split，值必须是字符串数组/`、`/不该再给 edits/`）。
- **怎么确认修好了**：`node --check` 通过；全文 `U+FFFD` 与典型乱码字符都是 **0**；
  与「反转骨架」逐行比对**恰好 614 行不同**（就是被修的那些，没有额外改动）；
  `test/keeper.test.js` 50/50；**全量回归两遍 fail 0** —— 用例里断言了大量来自 `lib/index.js` 的
  中文错误原文与提示文案，这是重建保真度最硬的证据。
- **教训（写下来免得再犯）**：在这台机器上**不要**用 `pwsh` 的 `Get-Content -Raw` + `WriteAllText`
  往返 UTF-8 文件；要么显式指定编码（`[IO.File]::ReadAllText($p, [Text.UTF8Encoding]::new($false))`），
  要么只走受控的编辑工具。尤其别拿「临时改回来验证测试」这种方式做批量读写 ——
  这次就是它把唯一一份 `lib/index.js` 弄坏的（该文件当时没有任何磁盘副本、也不在任何 git 里）。

---

### 用户发现（2026-10-07 · 五轮）：**整理后的每一块都必须自足** —— 旧「`split` 逐字无损」强保证作废

**用户原话（本轮规格的唯一来源）**：「我看了仓管待审内容，它有概率出现整理后的记忆丢失语句成分的情况，
比如第二块是指劳工边界，可它只说边界，这样会被理解为某个全局边界，**这很危险**，因此整理后的记忆块要完整」。

**现象（真实形态的样例）**：一条记忆是
`Nemotron 免费劳工授权（08-13 宝宝拍板）：…；边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人；…`，
拆出来的第二块只有 `边界=只做体力活（登记/整理/批量分析）…` —— **主语「Nemotron 免费劳工」丢了**，
脱离上下文会被读成一条**全局边界**。

- **三条新规则（都落进代码可验证的地方）**：
  1. **每块自足**：产出块必须带主语 / 对象 / 时间锚，能脱离上下文被正确理解；**为此允许重复原文里的主语词**
     （重复不算冗余，缺主语才是问题）；
  2. **不丢内容**：各块合起来仍要覆盖原文（`missingNumbers` / `消失的片段` 证据照旧）；
  3. **不凭空加信息**：after（或 `split` 的每一块）里**新增的片段必须能在原文里找到** ——
     「**允许重复，禁止发明**」。
- **代码落点**（`src/host/keeper-plan.js`）：
  - `PLAN_PROMPT` **最显眼处**新增自足铁律（正文原样）：
    「**每一块 / 每条整理结果都必须自足** —— 带上主语、对象、时间锚，能脱离上下文被正确理解；为此
    **可以重复原文中的主语词**（重复是允许的，缺主语不是）。禁止产出「边界=…」「索引已更新」「已剔除」
    这类脱离上下文会被误读成全局的碎片」；`split` 那条措辞从「**必须逐字无损** —— 只能切分，不能改写、
    不能总结、不能润色、不能增删一个字」改成「**原则是只能切分**（不总结、不润色、不丢内容），但为了
    **每一块都自足**，该重复的主语 / 对象 / 时间锚就重复出来」；`DEDUPE_EMPHASIS_PROMPT` 末句同步改
    （不再提「split 的逐字无损」）。已确认 `PLAN_PROMPT` 里 `逐字无损|子序列|不能增删一个字` 一个都不剩（测试钉住）。
  - 三个**新纯函数**（导出、可单测）：
    - `anchorsOf(texts)` → 锚点词：引号内术语（强）/ 英文与数字标识（强）/ 出现频次高的 2–4 字主题词
      （2 字窗 ≥ `ANCHOR_BIGRAM_MIN_COUNT`=3 次、3–4 字窗 ≥ `ANCHOR_WORD_MIN_COUNT`=2 次，过 `isStopFragment()`），
      `ANCHOR_LIMIT`=60；**提不出锚点就回空数组**，`selfContained()` 对空锚点不判缺主语；
    - `selfContained(text, anchors)` → `{ok, hit}`：命中 ≥1 个锚点算自足（比对前抹空白 + 统一中英文引号）；
    - `addedTerms(before, after)` → 新增片段数组：贪心取「最长可命中 before 的连续前缀」（≥ `ADDED_MATCH_RUN`=4 字
      算「原文里本来就有」），剩下未对齐片段里**只有含连续 ≥ `ADDED_MIN_CHARS`=2 个 before 字典里没有的字**才报。
  - `factWarnings()` 追加两条证据（排在原有「丢数字 / 消失的片段 / 压缩到 X%」**之后**）：
    `这块可能缺主语：…（脱离上下文会被读成全局）`、`新增了原文没有的片段：…（可能是模型自己加的）`；
    顺带修掉一个会让新证据被跳过的 `return warnings` 早退（`percent >= 100` 那条分支改成不 return）。
    两者**只产证据、不改判**：op 照样出单。
  - `normalizePlanOps()` 的 `split` 分支改成跑三条证据：逐块 `selfContained()`（锚点取自原文**整条**）→
    `addedTerms(original, 各块拼起来)` → `factCheck(original, 各块拼起来)`（数字 / 消失片段；
    **split 不报压缩比**：允许重复主语会让总长变长，跟原文比长度没意义）。
- **⚠️ 为什么「`split` 逐字无损 / 子序列 ≥98%」这条旧强保证作废**：规则 1 与子序列判定**天然冲突** ——
  为了补回主语而重复的词是**新增的字符**，拼起来当然不再是原文的子序列。旧实现（`coverageOf()` 不达标就
  `losslessSplit()` 兜底）会把「每块都带主语」的**理想输出**当成有损而丢掉。所以 `split` 不再跑覆盖率硬校验；
  `src/host/keeper.js` 的 `coverageOf()` / `losslessSplit()` **保留但降级** —— 前者只是核对工具，
  后者**只在模型没给可用碎片 / 只给了一块**时兜底（该 op 带结构化标记 `fallback: true` + 人话 warning
  `兜底切分（模型没给可用碎片|只给了一块）`）。README / DESIGN / REGRESSION 里凡是承诺「split 逐字无损」
  的表述**全部改掉**（换成「每块自足 + 不丢内容 + 不新增」），不留旧承诺。
- **`losslessFallback` 计数口径修正（同轮顺手，`lib/index.js`）**：原判定
  `op.type === 'split' && op.warnings.length > 0` —— 在 split 会带新证据之后，它把「有证据的 split」全算成兜底，
  面板「兜底切分 N」虚高、含义失真。改成认**结构化标记** `op.fallback === true`。
  文案前缀匹配（`startsWith('兜底切分')`）**故意不用**：这段文案已经改过两轮，字符串耦合会悄悄失灵。
- **判据**（`test/keeper.test.js` 由 52 例 → **58 例**，本轮新增 6 例；全量 **246 例 / 16 文件，连跑两遍 fail 0**）：
  缺主语块必报 / 补回锚点（重复主语）不报 / 「只重复」不报新增 / 伪造新增必报 /
  数字·引号原话·emoji 丢失照旧 / `losslessFallback` 认结构标记 / 用户那条真实样例的修前修后回归。
- **已知取舍（不谎报）**：
  1. `anchorsOf()` 是**启发式**：只认引号内术语、英文 / 数字标识、高频 2–4 字汉字窗；一句短话里提不出锚点时
     **不判缺主语**（宁可不报，也不乱扣帽子）；
  2. `addedTerms()` 只认「连续 ≥2 个原文里没有的新字」：同义换词 / 语序调整 / 引号样式变化不误报，
     代价是用原文里的字重新拼出来的新说法抓不到；
  3. `publicKeeper().derived / merged` **仍是恒 0 的旧形状**（出单阶段没有任何地方在累加它们；面板上
     「产出 N 条 / 合并 N 条」不该被当成有意义的数字）—— 本轮**没动**，如实记在这里。
     ⚠️ **已于 2026-10-07「merge 回滚凭据」那一轮修掉**：两个格子从 job 形状与面板里删除（不留假 0），见文末新增一节。

---

### 实测缺口（2026-10-07 · 本轮）：`reviewKeeperPlan()` 的 merge 分支**漏写 `meta.merged`** —— 被并的条回滚不到

**现象（真实库实测，不是推理）**：刚在真实库里审掉两张变更单，落库了 **2 次 `merge`**（保留 `targets[0]` +
其余 `softDeleteMemory`），随后 `memory_keeper {action:'status'}` 返回
`"artifacts": { "derived": 0, "rewritten": 0, "merged": 0 }` —— `merged` 仍是 **0**。
被软删的记忆**确实还在库里**（可以 `restoreMemory` 单独放回），但 `revertKeeper()` **找不到它们**：
它读的是 `listKeeperArtifacts().merged`（`meta LIKE '%"merged"%'`）里的 `meta.merged[].from`，
而新范式的 merge 分支只写了 `history.note = 'keeper:merge'`，**没写 `meta.merged`** —— 写它的是已删除的 `dedupePass`。
后果：「所有改动可一键回滚」这句话**对 merge 不成立**，而这正是用户要求「删改先入待审区」的配套保证。

**修法（`lib/index.js` · `reviewKeeperPlan()` 的 merge 分支，本轮唯一的行为改动点）**：
落库前先 `store.getMemory(targets[0])` 拿保留条（拿不到就 `skipped`；**绝不先删后改**，否则会留下
「删了却没痕迹」的孤儿），把 `targets.slice(1)` 逐个记成 `{from, at, reason}`（`reason` 取该 op 的 `reason`，
空则固定串「同一件事（合并）」），追加到保留条原有 `meta.merged` 之后，再
`updateMemoryText(targets[0], after, {note:'keeper:merge', meta})`。元素形状与老痕迹**完全一致**，
所以 `revertKeeper()` 一个字都不用改，同一条分支同时吃两代数据。

**死格子（同轮顺手，选了 (b) 删字段，不选 (a) 累加）**：`publicKeeper()` 的 `derived` / `merged` 在新范式下
没有任何地方累加（run 一个字都不写记忆库），面板「产出 N 条 / 合并 N 条」是**恒 0 的假数字**。
本轮 **(b)**：从 job 形状里删掉这两个字段（`publicKeeper()` 的默认对象、返回对象、`job` 初始化三处），
并删掉面板那两格（`lib/client.js` 的 `keeperStatDerived` / `keeperStatMerged`，**中英键成对删**，
`tools/check-client.mjs` 仍然 50/50）。真数字仍有两处**如实**来源：
`keeperStatus().artifacts`（`listKeeperArtifacts()` 现扫库 —— 就是面板「现存痕迹」那一行）与
`reviewKeeperPlan()` 的 `applied`（本次审阅应用了几条 —— 待审页结果行用的就是它）。

**为什么不选 (a)（让它们在 review 时真累加）**：累加只能记在**内存里的 job 对象**上，而
① `job` 描述的是「出单那一轮」，review 可能是几小时后、甚至**重启之后**（那时 `this.keeper === null`，
`publicKeeper()` 回的是全零默认对象）—— 同一个格子会**一会儿是真数、一会儿又变回 0**，那还是假数字；
② 一次只能看一份 job，把「本次 review 应用了几条」记在「上一轮 run」的格子上，语义本身就错位。
要从库里恢复这些数，最终还是得现扫 —— 那正是 `artifacts` 已经在做的事。**删掉格子，比留一个会骗人的格子诚实。**

**判据**：
- `test/keeper.test.js` 58 例 → **60 例**（**只追加** 2 例）：
  `merge 落库把被并 id 记进保留条的 meta.merged，revertKeeper 一次就放回来`、
  `恒 0 的 job.derived / job.merged 已删除：面板那两格一起删，真数字只看 artifacts / applied`；
- 定向（keeper + panel + config + db）**97 例 / fail 0**；**全量 248 例 / 16 文件，连跑两遍 fail 0**；
  `node tools/check-client.mjs` **50/50**；
- 端到端（离线、临时库、不碰真实库）：3 条同主题记忆 → 假仓管 LLM 出一张 merge 单 → `reviewKeeperPlan` 落库 →
  `meta.merged` 有 **2 个** `from`、`countMemories` **少 2** → `revertKeeper()` 后 **3 条全在**、`artifacts.merged === 0`。

**如实边界（不谎报）**：
1. `revertKeeper()` 仍**不**回退保留条 / 被改写条**自己的正文**（它们没有 `meta.keeper` 标记，不在
   `listKeeperArtifacts().rewritten` 里）：`merge` 之后 `revert` 的结果是「条数都回来了，但保留条是**合并后**的正文」。
   要连正文一起回退只能走 `history.prev_text`；`split` 第 1 块的改写、`rewrite`、`drop` 同理。
   README 仓管节与 DESIGN §E.4 的措辞已按此改准（此前那句「一键回滚」对 merge 是空头支票）；
2. 本轮**没有**给 `rewrite` / `split` / `drop` 补回滚凭据（任务范围只要 merge），也没有改 `revertKeeper()` 的逻辑；
3. 面板概览那行「现存痕迹」取的是 `/state` 的快照，审单是在「仓管待审」页做的 —— 不刷新概览时它可能还是审之前的数
   （取数时机问题，本轮没动）。

---

### 统一修改语义（2026-10-07 · 本轮）：`rewrite` 原地改写 → **`replace` 删旧录新** + 手工 `propose` 入口

**用户原话（本轮规格的来源）**：

> 「我统一一下操作：修改记忆的做法是 **依照原记忆编写修改后的记忆** → **新旧记忆展示在待审区** →
> **过审后删除原记忆、录入新记忆**」

**改前的不一致（实测）**：`reviewKeeperPlan()` 的 `rewrite` 分支是 `updateMemoryText(targets[0], after, {note:'keeper:rewrite'})`
—— **原地改写同一条**（id 不变、旧文进 `history.prev_text`）。这与用户规范不一致：规范要的是「删旧 + 录新」，
而且用户手上就有一条需要按新规范修的实例（宫殿期导入的一条记忆，正文断在「08-14 宝宝自」，
源 `04-环境与事实/新家系统.md`），当时**没有任何手工提出修改的入口**（改它只能直接原地改写，或整轮重跑仓管）。

**改法（四块）**：

1. **出单侧只有 `replace`**（`src/host/keeper-plan.js`）：`PLAN_PROMPT` 的四种操作里 `rewrite` 改为 `replace`，
   并写明「系统会在过审后删除原记忆、录入这条新记忆（原条软删、可恢复），所以 after 必须是**完整自足的新正文**」；
   `parsePlanOps()` **仍收**旧输出里的 `'rewrite'`，`normalizePlanOps()` 一律归一成 `'replace'`
   （`merge` 单目标也归 `replace`）——**系统里不再有「原地改写同一条」这条路径**。
   顺带补一道闸：after 与原文**一字不差**（抹掉空白后相同）的 replace 直接丢弃（没有变更就不是变更）。
2. **落库侧 `replace` = 删旧录新**（`lib/index.js` · `reviewKeeperPlan()`，仍是**唯一**落库入口）：
   `getMemory(target)` 预检（拿不到 / 已软删 / 新正文与原文相同 → `skipped`，**绝不半途动手**）
   → `addMemory({text: after, scope/kind/source 照抄原条, meta: 出处类字段 + replaces/replacedAt/model})` 拿**新 id**
   （`created:false` = 正文撞上另一条活着的记忆 → 也 `skipped`，否则回滚会误删别人的数据）
   → `softDeleteMemory(原 id, {note:'keeper:replace'})`（**软删 = 系统默认的「删除」**：整行与 history 都在、`restoreMemory` 可恢复）
   → `deleteVector(原 id)`（软删的行不能留下幽灵命中）
   → `scheduleEmbed(新 id)` → `op.newId` 写回单子（面板显示「新记忆 id」）。
   `applied` 的键改为 `{replace, split, merge, drop}`（旧 `rewrite` 键去掉），另返回 `replaced:[{from,to}]`。
   **`edits` 口径不变**：审阅者手改的 `after` 就是「新记忆正文」，仍走 replace。
3. **手工提出修改（新入口）**：`MemoryService.proposeKeeperReplace({id, text, reason})`
   （工具 `memory_keeper {action:'propose', id, text, reason?}`）—— 校验 `id` 存在且未删、`text` 非空且与原文不同，
   建一张**单 op 的 `replace` 变更单**（`{idx:0, type:'replace', targets:[老id], before:[{id,text:老正文}], after:text, reason}`，
   `state:'open'`，**不落库**），返回 `{ok, planId}`。这就是用户那条断句实例的正规修法：
   写修改版 → 待审区并排看新旧 → 过审才「删旧录新」。
4. **回滚覆盖 replace**：`store.listKeeperArtifacts()` 新增 `replaced` 桶（`meta LIKE '%"replaces"%'`，
   **含被软删的行**，与 `merged` 同一写法）；`revertKeeper()` 对每条 replace 记录 → **真删新记忆**（它本来就是本轮产物）
   + `restoreMemory(旧 id)` 把原记忆放回来 + 重新 `scheduleEmbed`（原条向量在落库时被清过）。
   `remaining` 加 `replaced`，返回值加 `removedReplaced` / `restoredOriginal`；`keeperStatus().artifacts` 同步加 `replaced`
   （面板概览「现存痕迹」与回滚结果行都补上这个数字，中英键成对）。
   ⚠️ 新记忆的 meta **不继承**原条的仓管回滚凭据（`derivedFrom` / `keeper` / `merged`）——
   继承的后果是它会被 `revertKeeper()` 当「研磨产物 / 被改写原文 / 合并保留条」再处理一次；
   出处类字段（`sync` / `srcHash` / `importedFrom` / `originalId` …）照旧带过去。
5. **面板（`lib/client.js`）**：op 标签 `replace` → 「替换（删旧录新）」/ `replace (delete old, store new)`
   （旧 `kqOpRewrite` 键删除，中英成对；老单里的 legacy `rewrite` 仍按整段正文可编辑，只原样回显类型名），
   结果行改「替换 {replace}」，并在 after 块下显示 `op.newId` 的 8 位短 id（只显示、不交互）。
   **没有重排 / 重构其它卡片**。

**判据（本轮实测）**：
- `test/keeper.test.js` 60 例 → **63 例**（新增 3 例：`propose` 校验与出单形态、
  replace 不继承回滚凭据、**离线端到端**「propose → 待审未落库 → review 删旧录新 → revert 放回」）；
- 定向（keeper + panel + config + db）**100 例 / fail 0**（上一轮 97 例）；
- **全量 251 例 / 16 文件，干净连跑两遍 fail 0**（删 `test/.tmp`、无残留测试进程；上一轮 248 例）；
- `node tools/check-client.mjs` **50/50**；
- 离线端到端（临时库、假 LLM、**不碰真实库**）：**25 项断言全通过**，逐项覆盖
  ①原条 `deleted_at != null`、②新条 id 是新的且 `meta.replaces` = 原 id、③新条正文 = after、
  ④`countMemories()` 仍是 1（删旧录新）、⑤原条向量被清（`countVectors=0`）、⑥新条进 embed 队列
  （`scheduleEmbed(newId)` + `countMissingVectors=1`）；`revertKeeper()` 后原条放回、新条真删、条数回到 1、`artifacts.replaced === 0`。

**如实边界（不谎报）**：
1. `meta.model` 在**手工 propose** 时是 `null` —— 那条新正文是人写的，没有「哪个仓管模型改的」可记；
   走过一轮 `run` 再审时才取 `this.keeper.model`。字段本身照写（面板/接口形状稳定）。
2. `propose` **没有**给面板加新的路由 / 按钮（本轮范围只要工具入口）：面板「仓管待审」页签按现有渲染
   显示 `before` / `after` 对比，`replace` 有中文标签，不会落到默认分支；要发起修改目前走工具。
3. legacy 单子（升级前已经存在 `keeper_plans` 里的 `rewrite` op）**仍能审** —— 服务层按 `replace` 落库；
   前端 `draftFor()` 也认 `rewrite`，但类型标签没有 `rewrite` 键，会原样回显 `rewrite` 字面量（不报错、可编辑）。
4. `revertKeeper()` 对 `replace` 的回滚**只认 `meta.replaces`**：如果新记忆后来被用户手工 `memory_forget --hard`
   真删了，那一桶里就没有它，原记忆**不会**因此自动放回（要手工 `restoreMemory`）—— 这是「凭据随行」的必然结果。
5. 本轮**没有**改 merge / split / derived 的既有回滚逻辑，也没有动 `history` 形状。

### 两个行为计数器 + 每周防膨胀衰减（2026-10-07 · 本轮）

**用户原话（本轮规格的来源）**：

> 「为每条记忆附加两种参数：一个是被 agent 作为正常记忆读取后会增长一次的指数；一个是被仓管作为
> 待整理记忆读取后会增长一次的指数。整理指数会每周按全库指数高低差进行保持原比例不变的小幅度下降
> 以防数值膨胀。被整理后产生的新记忆初始会增长一次整理指数」

**四个口径（用户拍板，照做、不再改）**：

1. **读取指数 `read_score`**：只在 `memory_search` **命中的每一条** 与 `memory_get` **取单条** 时 +1；
   **列表 / 面板浏览不算**（`memory_list`、面板 `/search` 直调 `searchText` 都不加）。
2. **整理指数 `tidy_score`**：一条记忆**被抽进仓管的一组**时 +1（随机抽中的种子 + embedding 召回当邻居）；
   **同一轮里同一 id 只算一次**。
3. **仓管产出 / 替换出的新记忆**：tidy **初始 = 1**（字面：初始 0 再 +1）。
4. **衰减**：全库 ×`0.98/周`，**懒触发**，按**整周数**连乘 `factor ** weeks`；**比例严格不变**。

**改了什么**：

| 位置 | 改动 |
|---|---|
| `src/host/db.js` | `SCHEMA_VERSION = 4`；`memories` 加 `read_score` / `tidy_score REAL NOT NULL DEFAULT 0`（DDL 里带 + 老库 `ALTER TABLE ADD COLUMN`，**不重建表**）；`migrateScoreColumns()`；**FTS 触发器收窄成 `AFTER UPDATE OF text`** + `migrateFtsTriggers()`（老库换触发器）；`lastMigration()` 多带 `scoreColumns` / `ftsTriggers` |
| `src/host/store.js` | `addMemory({readScore, tidyScore})`；`bumpReadScores` / `bumpTidyScores`（**一次批量 `UPDATE ... IN (...)`**）；`decayScores(factor)`（两列同乘，一条 SQL）；`scoreStats({top})`（总分 / 均值 / Top-N，`preview` 截 40 字）；`shapeMemory()` 把两列以 `readScore` / `tidyScore` 别名带出来 |
| `lib/index.js` | `memory_search` / `memory_get` handler 里加分（**不在 `searchText` 里**——它同时被仓管分组召回与 `analyzeBatch` 候选召回使用）；`runKeeperRun()` 每组 `recordTidy([...memberIds])`；`replace` 新条 / `split` 派生碎片 `addMemory({..., tidyScore: 1})`；`maybeDecayScores()`（懒衰减：乘系数与推进时间戳**同一事务**，避免只成一半）+ `recordReads/recordTidy`（计分前先懒衰减）；`storeStats().scores`；`apply()` 启动时跑一次懒衰减；`searchText` items 带出两个分值（面板搜索行的小 Tag 用它） |
| `src/host/config.js` | `score.weeklyDecay`（默认 `0.98`，校验**开区间 (0,1)**）；`DEFAULT_CONFIG` 与 `test/config.test.js` 的 `EXPECTED_DEFAULTS` 同步 |
| `src/host/panel.js` | `/state` 透出 `scores` |
| `lib/client.js` | 概览加一行「记忆计分：平均读取 / 平均整理 / 下次衰减」+「读取最高：…」；搜索结果行加两个小 Tag（中英成对，老宿主没给分值就整块不画） |
| `README.md` / `DESIGN.md` | 工具行为变化 + 新配置键 + 一节口径说明（README）；新增 `§C.2 行为计分契约`（DESIGN）。**顺带修了一处旧伤**：README 故障排查表里两行被上一轮 PowerShell 事故粘成一行（`+ \`n| **面板打不开…`），已拆回两行（只动排版，不改文案） |

**判据（本轮实测）**：

- `node --check`：`src/host/db.js` / `src/host/config.js` / `src/host/store.js` / `src/host/panel.js` /
  `lib/index.js` / `lib/client.js` **全部 OK**；
- 定向 **154 例 / fail 0**：`db 13` + `store 20` + `search 19` + `keeper 65` + `panel 22` + `config 5` + `maintenance 10`；
- **全量 261 例 / 16 文件**（基线 251 + 新增 10），**干净连跑两遍 pass 261 / fail 0**
  （删 `test/.tmp`、无残留 node 进程）；
- `node tools/check-client.mjs` **50/50**；
- 三份 md 仍是 **UTF-8 无 BOM**（前 3 字节不是 `EF BB BF`；实测见下）。

**新增的 10 个用例（逐条对着七个要求）**：

| 要求 | 落点 |
|---|---|
| ① v3→v4 迁移：老库有数据、加列后数据一字不动、默认 0 | `test/db.test.js`「迁移 v3→v4：老库只 ADD COLUMN…」（手搓 v3 库文件，补列前后逐字段比对 + `PRAGMA table_info` 类型/默认值 + 重开幂等） |
| ② `memory_search` 命中 3 条 → 那 3 条 read +1、其它条不动 | `test/maintenance.test.js`「memory_search / memory_get 工具：命中即 +1 read…」 |
| ③ `memory_get` 命中 +1 | 同上（并断言不影响别人） |
| ④ 仓管 run 的分组召回**不给 read 加分**；tidy 只在进组那条 +1、同轮重复只算一次 | `test/keeper.test.js`「计分：run 给进组的每条 tidy 恰好 +1…」（假 LLM 跑一轮；每个种子都召回同一条，断言 read 全 0、tidy 与「所有单子的 memberIds 并集」逐条相符、≥2 组） |
| ⑤ split 碎片 / replace 新条 `tidyScore === 1` | `test/keeper.test.js`「计分：split 碎片 / replace 新条 tidyScore 初始 = 1…」（另钉住既有保留条不重复加） |
| ⑥ 跨 2 周 `10→10×0.98²`、`5→5×0.98²`、比例仍是 2、浮点近似、重复调用不二次衰减 | `test/maintenance.test.js`「懒衰减：跨 2 周同乘 0.98²…」（并钉住时间戳只推进整周、余数不丢） |
| ⑦ 不足一周不衰减 | 同上一例（3 天 → `decayed:false`、数值不变） |
| 附带（不是要求，但防漂移） | `test/db.test.js` 触发器收窄迁移、`test/store.test.js` 计分 API、`test/maintenance.test.js` 计分前懒衰减接线 + `storeStats.scores`、`test/panel.test.js` `/state` 透出 `scores`、`test/config.test.js` 新配置键校验 |

**取舍 1（用户点名要说明的）：`memory_search` 命中就要写一次分，怎么不拖慢检索**

做法：**同步、但只写一条 SQL**。命中后 `service.recordReads(ids)` 发一条
`UPDATE memories SET read_score = read_score + 1 WHERE id IN (?, …, ?)`（**不是 N 次单条 UPDATE**）；
写在 `searchText` 返回**之后**、失败只记日志，所以检索结果与它自报的 `tookMs` 完全不受影响。

实测（本机、`test/.tmp` 临时库、1200 条、查询命中 8 条）：

| 量 | 实测 |
|---|---|
| `searchText`（纯检索，不加分） | **1.25 ms/次**（200 次平均；自报 `tookMs` 中位 1 ms / p95 2 ms / max 2 ms） |
| `memory_search` 工具路径（检索 + 加分） | **5.08 ms/次** |
| 批量 UPDATE 8 条本身 | **3.22 ms/次** |
| 裸 UPDATE **1 行** / **8 行** / **64 行** | **3.17 / 3.22 / 3.16 ms** —— 与行数几乎无关 |
| 旧宽触发器 vs 新窄触发器（同样 8 条） | **3.45 vs 3.32 ms（≈1.04×）** |

结论与代价来源：`journal_mode=wal` + `synchronous=FULL`（PRAGMA 实测 `2`），**每条语句提交各付一次
fsync ≈ 3.2 ms**，与更新的行数无关 —— 所以「批成一条 SQL」正是唯一有效的杠杆（8 条与 64 条同价），
再往下只能靠**异步攒批**（放弃即时持久性：崩溃丢计数）或改 `synchronous`（全局降低持久性），
两者都不值：memory_search 的总开销 4–5 ms，相对一次 LLM 回合微不足道，而计数的正确性/可测性更重要。
另外把 FTS 的 UPDATE 触发器收窄成 `OF text` 后，写计分列**不再触发 FTS 删+插**。

**取舍 2：FTS 触发器收窄（超出「加两列」的 schema 变更，但必须一起做）**

`CREATE TRIGGER IF NOT EXISTS` 对已存在的触发器**什么都不做**，所以只改 DDL 定义的话，老库（含本机
那份有真实数据的库）会一直带着裸 `AFTER UPDATE`。后果有两个：① 每次计分都白做一遍 FTS 删+插；
② 更糟的是，**在「FTS 索引与主表不同步」的库上**（外部内容表 + 缺失的 'delete' 目标）会直接抛
`database disk image is malformed` —— 实测：手工造一个 `memories` 有行、FTS 空索引的 v3 库，
一条 `UPDATE ... SET read_score` 就炸。所以 `migrateFtsTriggers()` 会 drop 后重建，
**只动触发器定义、不碰数据、不重建表**；新增用例既验证了迁移，也验证了迁移后计分不再碰 FTS。
干净的库上窄触发器的性能优势很小（1.04×），**真正买的是正确性与「计分不牵连检索索引」**。

**如实边界（不谎报）**：

1. **懒衰减是「懒」的**：只在 `apply()` 启动与每次计分操作前检查。若插件长期不重启、也一次检索都不做，
   衰减会一直往后拖（拖到下次启动/计分）。这是「懒触发」的必然，不是漏算 —— 补算时会按整周数一次乘够。
2. **首次启用不打折**：第一次没有 `score.decayedAt` 时只写当前时间。所以升级后老数据的两个分值都从 0
   起步，不存在「历史数据被补乘」的场景；坏时间戳会被重置为当前时间（不会拿一个说不清的时刻乱乘）。
3. **计分列不参与排序**：`read_score` / `tidy_score` 只被记录与展示（`memory_stats.scores` / 面板一行），
   `hybridSearch` 的名次完全不受影响。
4. **计分失败会被吞掉**（只 `logger.warn`）：这是刻意的 —— 检索返回不该因为一次计分写失败而失败。
   代价是「分值少加一次」时没有用户可见的错误（日志里有）。
5. **`memory_get` 多读一次**：为了返回「加过 1 之后」的 `readScore`，handler 会再按主键读一次
   （PK 点查，微秒级）。不这么做就得自己给返回值 +1，反而更容易和库里的真实值漂移。
6. **真实库一次都没碰**：本机 `<DSH_HOME>\dsh-memory` 未被打开；迁移与计分全部在 `test/.tmp`
   临时库（手工造的 v1/v3 老库）上验证。
7. **面板只加了「概览一行 + 搜索行两个小 Tag」**：全部记忆列表行没加分值 Tag（要改 `panel.js` 的列表
   字段映射与渲染，收益很小），这是按规格里「成本高就只做概览那一行」的取舍。

### 超时修（2026-10-07 · 本轮）：默认 `120s → 240s` + **同一组自动重试一次**

**实测证据（真实库上两次运行，用户给的 job 状态原样）**：

```
组 1：失败（TimeoutError [23]: The operation was aborted due to timeout）
组 2：2 条操作
...
lastError: "3b9297d0：TimeoutError [23]: The operation was aborted due to timeout"
```

线上模型（`qwen3.8-flash`）吐 2000 token 的 JSON，**约 1/3 的组会超时**；那一组进组的 tidy **照加**、
却一行产出都没有 —— 采样机会白花。默认 `keeper.timeoutMs` 当时是 120000。

**改了什么**：

| 位置 | 改动 |
|---|---|
| `src/host/config.js` | `keeper.timeoutMs` 默认 `120000 → 240000`（+ 注释写清依据）；`test/config.test.js` 的 `EXPECTED_DEFAULTS` 同步 |
| `lib/index.js` | 新增 `isTimeoutError(error)`（`name==='TimeoutError'` 或 `code===23` —— 与 `src/host/timeout.js` 的 abort reason 同判据）；`runKeeperRun()` 里请求体只拼一次（**同一组、同一份请求**），`client.chat()` 第一次抛超时才用同一份请求再打一次；`job.retried` 累计重试次数、进 `publicKeeper()`（空 job 也给 `retried: 0`）与 `jobs.detail`；非超时错误照旧一次记失败 |
| `test/keeper.test.js` | 追加 4 例（见下） |
| `README.md` / `DESIGN.md` | 仓管节 + 故障排查 + 配置表（README）、§E.4 任务模型行（DESIGN）补「超时重试一次 / 默认 240s」 |

**口径（刻意的几个「不」）**：

1. **只重试超时**：HTTP 4xx/5xx、响应格式错重试也白搭 —— 一次都不重试，错误原文直接进 `tail` / `lastError`；
2. **只重试一次**：第二次仍失败才记该组 `failed`（tail 写「失败（超时，已重试一次）」，不会打第三次）；
3. **重试是同一组**：`recordTidy()` 在进组时已经加过，重试**不重复加**；`createKeeperPlan()` 只在拿到
   可用 ops 后调用，重试**不重复建单**（成功路径实测 `plans: 1`，不是 2）；
4. **档案 `timeoutMs` 本来就盖过 patch**：`profileToKeeper()` 的字段白名单里一直有 `timeoutMs`，
   `resolvedConfig()` / `resolvedKeeperConfig()` 的具名档案分支 `patch + profileToKeeper(档案)` 会把它合并进
   `keeper` —— 本轮**没改合并逻辑**（如实：查证后确认不需要改），只加了断言把这个性质钉住：patch 故意写 120000、
   档案写 240000，切过去后 `resolvedConfig().keeper.timeoutMs === 240000`，切回 `config` 回落 120000。

**判据（本轮实测，全部贴原文）**：

- `node --check`：`lib/index.js` / `src/host/config.js` / `test/config.test.js` / `test/keeper.test.js` **全部 OK**；
- 临时探针（临时库，**不碰真实库**）三条路径的实际输出：

```
=== 成功路径：第 1 次超时 → 重试成功 ===
chat 调用次数 : 2
failed        : 0    retried: 1    plans: 1    ops: 1
tail          : ["组 1：超时，重试一次","组 1：1 条操作"]
lastError     : null
库里 open 单数 : 1    seed.tidyScore: 1

=== 两次都超时：failed + tail 写明「已重试一次」, 不建单 ===
chat 调用次数 : 2
failed        : 1    retried: 1    plans: 0    ops: 0
tail          : ["组 1：超时，重试一次","组 1：失败（超时，已重试一次）"]
lastError     : "84377804：TimeoutError [23]: The operation was aborted due to timeout"
库里 open 单数 : 0    seed.tidyScore: 1

=== 非超时错误（HTTP 500）：不重试, 原文进 tail/lastError ===
chat 调用次数 : 1
failed        : 1    retried: 0    plans: 0    ops: 0
tail          : ["组 1：失败（Error: 仓管 LLM 请求失败：HTTP 500（https://example.com/chat/completions）—— boom）"]
lastError     : "95b1d1cc：Error: 仓管 LLM 请求失败：HTTP 500（https://example.com/chat/completions）—— boom"
库里 open 单数 : 0    seed.tidyScore: 1
```

- 定向（keeper + config + panel + db）**109 例 / fail 0**（keeper 单文件 **69 例**，修前 65）；
- **全量 265 例 / 16 文件**（基线 261 + 新增 4），**干净连跑两遍 pass 265 / fail 0**
  （删 `test/.tmp`、无残留 node 进程）；
- `node tools/check-client.mjs` **50/50**；
- 三份 md 仍是 **UTF-8 无 BOM**（前 3 字节不是 `EF BB BF`）。

**新增的 4 个用例**：

| 要求 | 落点 |
|---|---|
| ① 第一次超时、第二次合法出单 → 该组成功（`failed 0`、tail 有重试痕迹、`plans +1` 只有一张单、tidy 不重复加） | `test/keeper.test.js`「run：某组第一次超时 → 同组自动重试一次…」（断言 `calls===2` / `tail` 逐行 / `listKeeperPlans().length===1` / `tidyScore===1`） |
| ② 两次都超时 → `failed 1`、tail 写明「已重试一次」、不建单 | 「run：同一组两次都超时 → failed 并写明…」（另断言 `calls===2` 不会打第三次、`lastError` 含 `TimeoutError [23]`、tidy 仍只加一次） |
| ③ 非超时错误 → 不重试、`chat` 只调一次、`failed 1` | 「run：非超时错误**不重试**…」（HTTP 500 原文进 `tail` / `lastError`） |
| ④ 档案层：具名档案 `timeoutMs` 覆盖生效 | 「仓管档案：具名档案的 timeoutMs 真的盖过 patch…」（patch 120000 / 档案 240000 / 切回 config 回落 120000） |

**如实边界（不谎报）**：

1. **`src/host/locallm.js` 里那个内部兜底没动**（`Number(config.timeoutMs) > 0 ? … : 120_000`）：
   正常路径的配置都过 `normalizeConfig()`（`timeoutMs` 必须正整数），走不到这个兜底；
   只有直接调 `createLocalLlm()` 且不给 `timeoutMs` 才会用到它 —— 本轮范围只改默认配置，故保持原样。
2. **重试会多花一次调用**：`retried` +1 就意味着该组多打了一次线上模型（这是用采样机会白花换回来的，
   值不值由用户判断；`job.retried` 是可观测量）。
3. **重试的成功率没法离线验证**：这三条用例证明的是「逻辑分支正确」，不是「线上 1/3 超时的组重试后能成」
   —— 真实成功率得等下一次真跑（`retried` 与 `failed` 的比例会如实反映）。
4. **真实库一次都没碰**：探针与全部用例都在 `test/.tmp` / 系统临时目录的临时库上跑；
   待审区那些 `state:'open'` 的单**没有打开真实库去读**，所以本报告报不出「有几张 / 内容是什么」。

### 自主捕获加「临时事实过滤」（2026-10-07 · 本轮）

**用户原话**：「自主捕获的记忆，不能什么都录入，一些**偏临时的事实描述**是可以忽略的」。

**实测的病**（真实库 `kind='auto'` / `source='自主捕获'` 的条目；本轮**一条都没删**）：
会话态 / 任务态 / 工具协作态 / 助手自述，例如
① 「用户与助手约好用 propose 流程处理那条断在「08-14 宝宝自」的记忆：…」；
② 「用户与助手约定：助手实现完成后由助手做统一验收，验收后立刻用 propose 把…」；
③ 「用户身边另有一位 teammate（fix-keeper-chunk-selfcontained）在并行工作…」；
④ 「助手认为「效果好不好」这类判断只能由用户来做，它只负责交付真实样例供用户判断。」；
⑤ 「用户在…当前正在做 X / 这轮先 Y」。
它们不是长期事实，却会持续污染记忆库与检索。

**两道闸**：
1. **提示词**（`src/host/extract.js`）：`EXTRACT_PROMPT` / `EXTRACT_FOCUSED_PROMPT` 各加一段「不要记」清单
   （会话/任务态、工具/协作态、助手自身的立场与自述、一次性当下状态；原有「临时状态 / 公开信息 / 猜测」保留）
   与**正反例对照**（各 4–5 条）；
2. **确定性过滤**（新模块 `src/host/transient.js`，纯函数、可单测）：`looksTransient(text) -> {transient, hit}`、
   `partitionTransient(facts) -> {kept, dropped}`。**实现选择**：不做「把临时句从转录文本里剔除」那种字符串手术，
   而是让 `extractFacts()` / `stageExtraction()` 接受 `excludeTransient`（默认 true）、在**解析出 facts 之后**逐条判，
   并把 `dropped`（带命中理由）回报给调用方 —— 这样 **direct 捕获 / pending 捕获 / 手工 `memory_extract`** 三条路
   共用同一份判据，改动面最小。丢弃计数进 `capture.lastRun.droppedTransient`（单次）与 `capture.droppedTransient`
   （最近几次累计），面板「概览 → 自主捕获」写一行；配置 `capture.dropTransient`（默认 true；false = 只靠提示词）。
   ⚠️ 「抽出来的全被判临时」用 `allTransient` 与「模型什么都没抽到」区分开：前者**不建空批次、也不记进
   `capture.errors`**（direct / pending 两条路口径一致，否则待审路径会把正常过滤报成失败）。

**判据（命中即丢；保守）**：`teammate` / `subagent` / `子代理`；`本次会话` / `这轮` / `本次任务` / `接下来` / `待办`；
助手立场（`助手认为` / `我建议` / `助手打算`…）；`待审区` / `变更单` / `工具调用` / `panel`；
`重启` / `验收` / `跑通了`；`约好用…流程` / `约定：` / `由…验收`；以「已完成 / 已实现 / 跑通了」开头的纯进度汇报；
弱判据 `正在` / `刚刚` / `目前` / `暂定` / `暂时`（**只在句子里没有长期锚点时**才算临时）。

**误杀防护（本轮重点）**：句子里出现长期锚点（`喜欢 / 习惯 / 偏好 / 忌口 / 生日 / 纪念日 / 拍板 / 决定了 /
统一了 / 每年 / 住在 / 老家 / 职业 / 称呼 / 宠物 / 同事 / 朋友…`）一律**豁免**。4 条长期负例钉进
`test/transient.test.js`：「用户喜欢冰美式」「宝宝 08-12 拍板：中栏方案乙」「用户习惯凌晨睡」
「用户拍板统一了修改记忆的做法：新旧记忆进待审区，过审后才删除原记忆、录入新记忆。」

**只读实测（真实库，`node:sqlite` 的 `readOnly: true`，只 `SELECT`）**：`memories` 共 **1162** 条；
`kind='auto'` **47 条**（未软删 47 / 已软删 0）；按 `looksTransient()` 判定 **22 条为临时**（46.8%）——
按规则分布：工具协作态 6、子代理 4、助手立场 3、重启验收 3、助手动作 2、teammate 1、约定流程 1、会话任务态 1、
当下状态 1；留下 25 条。**真实库一个字节都没改**（无删、无改、无写）。

**自证（实际输出）**：
- `node --check` 全部改动的 js：**11/11 OK**；
- 定向 `capture + config + keeper + panel`：**108 例 / fail 0**；
- 干净全量（无残留 node 进程、删 `test/.tmp`、17 个测试文件展开）**连跑两遍：284 / 284 pass、fail 0**（基线 265）；
- `node tools/check-client.mjs`：**50/50**（zh / en 词典键仍成对，新增 `captureDropped`）；
- 5 条真实病样例过 `looksTransient()`：**5/5 `transient:true`**；4 条长期负例：**4/4 `transient:false`**；
- 新增用例：`test/transient.test.js` 12 条 + `test/extract.test.js` 2 条 + `test/capture.test.js` 4 条 = **18 条**。

**如实边界（不谎报）**：
1. 过滤器是**启发式**（关键词 + 句式），不看上下文：留下的 25 条里仍有一部分是漏判
   （真实库例：「用户与助手历经多轮协作，最终拿到 201/201 测试通过」、「助手坚持如实说明验证到什么程度」）；
2. 反向也有**误杀**风险：命中判据词、又没有长期锚点的长期决定会被丢掉 —— 真实库例：
   「用户采纳了助手建议的四条语义：…只出变更单、不直接改库」（命中 `变更单`）、
   「用户和助手约定仓管的所有改动先进入独立待审区」（命中 `待审区`）、
   「用户决定记忆抽取暂定由自己手动启动」（命中 `暂定`）。这类「用技术词表述的长期约定」目前**不在判据之内**，
   已写进 README「已知限制」第 18 条；真被误杀就在面板手工补录一条；
3. **待审区里的旧数据不去清理**（那要走审阅流程）：本轮过滤只对**新抽出来的**事实生效；
4. `test/capture.test.js` 原有那条「子代理会话 → 进待审区」的用例，为了让夹具（「子代理抽到的一条」本身就是工具态描述）
   继续只验路由，显式传了 `capture.dropTransient: false`；**它的断言一个字都没改**。

### 临时事实过滤器升级为**三分类**：修掉 3 条已确认的误杀 + `uncertain` 进待审区 + `propose-drop`（2026-10-07 · 本轮）

**病根（上一节自己写下的边界，这一节把它修掉）**：上一轮的过滤器是**二分类**「临时 / 不临时」，
判据里有 `变更单` / `待审区` / `暂定` 这类词，于是**用技术词表述的长期决定**被静默丢掉。
用户的口径是「**偏临时**的事实描述可以忽略」——「用技术词表述的长期决定」不是临时事实。

**用户点名的 3 条误杀（真实库 `kind='auto'` 原文照抄，旧判定 → 修后判定）**：

| # | 真实正文（截断处用 …） | 旧 `hit` | 旧判定 | 新判定（新 `hit`） |
|---|---|---|---|---|
| 1 | 用户采纳了助手建议的四条语义：无损重写分逐字无损与保要点、过期只标注、按组出单可单条勾选、研磨或消化只出变更单不直接改库。 | `工具协作态:变更单` | `transient:true` → **丢** | `durable`（`长期决策:采纳`） |
| 2 | 用户和助手约定仓管的所有改动先进入独立待审区，经 agent 或用户审阅通过后才真正改写记忆库。 | `工具协作态:待审区` | `transient:true` → **丢** | `durable`（`长期约定:约定`） |
| 3 | 用户决定记忆抽取暂定由自己手动启动，不定期进行一轮随机抽取。 | `当下状态:暂定` | `transient:true` → **丢** | `durable`（`长期决策:决定`） |

**修法（三分类 + 收窄规则）**：`looksTransient()` 改为 `-> {verdict: 'durable' | 'transient' | 'uncertain', hit}`：

1. **transient（丢）** = 纯进度 / 协作 / 会话态：`teammate` / `subagent` / `子代理`、以「助手 / 我」**作句首主语**
   的自述与动作、`本次会话` / `这轮` / `接下来` / `待办`、`正在` / `刚刚` / `目前` / `暂定` / `暂时` / `进度`、
   `跑通了 N 条`、`约好用…流程` / `约定：`（冒号清单）；**硬规则先判、不受长期信号豁免**（它们是会话状态）；
2. **durable（保留）** = 命中长期信号一律保留，**即使同句带技术词**：`决定` / `采纳` / `拍板` / `统一` /
   `约定`（须有「用户 / 宝宝 / 小屿」人称主体、且不是 `约定：` 冒号清单）/ `偏好` / `习惯` / `要求` / `记住` /
   `基准` / `长期` / 日期锚点（`2026-10-07`、`08-12`）/ 身份关系词。**技术词（`变更单` / `待审区` / `验收` /
   `重启` / `panel` / `工具`）单独出现不再构成 transient**；
3. **uncertain（拿不准）** = 既非会话态句式、又无长期锚点 → **不丢也不直存**，并进待审区。
   判定顺序 = 会话态（硬）→ 长期信号 → 弱规则（当下状态 / `约定：` 清单）→ `uncertain`。

**捕获分流（`lib/index.js` 的 `runCapture`）**：

- `durable` → 照旧**直存**（`source='自主捕获'`、`kind='auto'`，自己的会话免审）；
- `transient` → **丢弃**，计数 `droppedTransient`（字段与面板那行保留）；
- `uncertain` → 用 `store.createBatch()` **并成一个 `open` 待审批次**（`capture.lastRun.batchId`），
  计数 `deferredToReview`（`captureStatus()` 与 `memory_stats.capture` 可见；面板中英各一行 `captureDeferred`）。
  ⚠️ 这个批次**不自动审**：拿不准的东西不该由自动判定直接落库，留给人。
- pending（子代理 / 委派会话）路径：`stageExtraction()` 的批次 = `facts`（= `durable + uncertain` 原顺序），
  **只有 transient 不进批次**；`job.deferredToReview = staged.deferred.length`。
- `capture.dropTransient: false` → **三分类全部保留**（等价关闭过滤：一条不丢、三条都按原路径走）。

**「清理已录噪声」开了走审阅的通道**（用户明确要求「**删改都要进待审区**」）：新增
`MemoryService.proposeKeeperDrop({id, reason})` / 工具 `memory_keeper {action:'propose-drop', id, reason?}` ——
校验 `id` 存在且未软删 → 建一张单 op 的 `drop` 变更单（`state:'open'`，**不落库**）→ 返回 `{ok, planId}`；
过审后由 `reviewKeeperPlan()` 的 `drop` 分支 `softDeleteMemory`（软删=可恢复）+ 清向量。
`drop` 的目标行上**没有 meta 痕迹**，所以 `revertKeeper()` 改为扫**已应用变更单**（`approved` / `partial`）
里的 `drop` op、按 `targets` `restoreMemory()` 放回来（新计数 `restoredDropped`，已放回的天然跳过）。
`memory_keeper` 的 description / `action` 枚举 / 参数说明同步更新（与 `propose` 并列）。

**自证（实际输出，本轮）**：
- `node --check` 全部改动的 js（10 个文件）：**10/10 OK**；
- 定向 `transient + extract + capture + keeper + config + panel`：**139 例 / fail 0**；
- 干净全量（无残留 node 进程、先删 `test/.tmp`、`test\*.test.js` 17 文件展开）**连跑两遍：288 / 288 pass、fail 0**（上一轮基线 284，本轮 +4）；
- `node tools/check-client.mjs`：**50/50**（zh / en 词典键成对，新增 `captureDeferred`）；
- 用户点名样例逐条跑新分类器：**3 条误杀例 → 3/3 `durable`**；
  3 条 transient 真实例（`约好用…流程` / 「身边有后台子代理…」 / 「助手认为…」）→ **3/3 `transient`**；
  4 条长期负例（喜欢冰美式 / 习惯凌晨睡 / 宝宝 08-12 拍板 / 用户拍板统一了修改记忆的做法…进待审区）→ **4/4 `durable`**；
- **只读实测（真实库，`node:sqlite` 的 `readOnly: true`，只 `SELECT`；一个字节都没改）**：
  `kind='auto'` 共 **47 条**（未软删 47）→ 新分类器 **durable 16 / transient 18 / uncertain 13**（旧分类器 22 条判临时 = 46.8%）；
  被丢的 18 条逐条都有 `hit`；转待审的 13 条里包含「用户选定了「线上」档案模板…」「管理按钮改为按钮样式」这类
  没有长期锚点、也不算会话态的句子（旧分类器会留下它们 —— 现在改走人眼，这是刻意的取舍）。

**如实边界（不谎报）**：
1. 仍然是**启发式**（关键词 + 句式）、不看上下文，只是把「会丢」的两类大幅收窄、并把拿不准的送去审阅；
2. `uncertain`（13/47 = 27.7%）会**堆在待审区**等人看 —— 这是「不误杀」的代价，不是副作用；
3. 仍可能**误杀**的两处（会丢）：`约定：` 冒号清单（长期约定若写成冒号句式、句内又没有任何长期锚点会被丢，例
   「用户和助手约定：先改代码再重启」）、以「助手 / 我」作句首主语且后接动词（把「助手」当人名的罕见写法）；
4. 仍会**漏判**（落进 `uncertain`，多一道人眼、不丢）：一个判据词都没有的会话态，真实库例
   「用户与助手历经多轮协作，最终拿到 201/201 测试通过」「助手安抚用户不必担心，说明记忆数据完好」；
5. 本轮**只读**了真实库、**没有**清理那 13 条 `uncertain` / 18 条 `transient` 的历史噪声 ——
   清理要走 `propose-drop` + 审阅（这正是本轮新开的那条通道），本轮没动手；
6. direct 路径为 `uncertain` 建的待审批次**不自动审**（刻意）：所以 `deferredToReview` 涨了就得有人去面板看；
7. `partitionTransient()` 的返回形状从 `{kept, dropped}` 变成 `{kept, dropped, deferred, staged}`，
   `looksTransient()` 从 `{transient, hit}` 变成 `{verdict, hit}` —— 这是**破坏性接口变更**（本轮唯一一处），
   调用方只有 `extract.js` 与两个测试文件，已全部同步；非字符串 / 空串一律按 `durable` 放行（不丢数据）。

---

## 2026-10-07 · 「仓管待审」页把历史单当成待审（面板侧修正，`lib/client.js`）

**现象**：用户报「待审区堆积了很多内容」。真实库 `keeper_plans` 当时共 **31 张**（open 4 / approved 22 /
partial 2 / rejected 3，其中 4 张本轮审掉），但面板「仓管待审」页签把**每一张**都画成完整卡片，每张都带
「全选 / 全不选 / 驳回 / 应用勾选项」—— 27 张早已定案的单子看起来全是待办。

**根因（读码确认，不是猜）**：`src/host/panel.js` 的 `keeperPlansRoute()` **支持** `state` 查询参数、
不传即 `state: null`（`listKeeperPlans()` 不过滤 → 返回全部），而 `lib/client.js` 的 `KeeperQueueTab`
取数时 `apiJson('/keeper-plans')` **没传 state**，UI 也从不看 `plan.state` 分流。

**数据本来就安全（重点澄清）**：`reviewKeeperPlan()` 取单后第一件事就是
`if (plan.state !== 'open') return {ok:false, error:'变更单已是 ' + state + '，不能重复审阅'}`，
`reject` 走同一个守卫；所以点已定案的单子只会得到一条原文报错，记忆库一个字都不动。

**改法（只动 `lib/client.js`，服务端 / 路由零改动）**：
1. `KeeperQueueTab` 按 `state` 把列表分成 `openItems` / `doneItems`，顶部加一行 `kqCountLine`
   （「待审 {open} 张 · 已定案 {done} 张」）；
2. 已定案的单子默认收起在一颗「显示 / 收起已定案的单子（N）」按钮后面；展开后仍是同一套卡片渲染，
   但 `reviewable === false` → **勾选框、`textarea` 的 `readOnly`、「全选 / 全不选 / 驳回 / 应用」整块**
   都不渲染，换成一行 `kqDecidedHint`（「已经定案，只读展示；要再改就重新出一轮单子」）；
3. 新增词条 `kqCountLine` / `kqShowHistory` / `kqHideHistory` / `kqEmptyOpen` / `kqDecidedHint`，中英成对。

**自证（实际输出）**：
- `node --check lib/client.js`：**exit 0**；
- `node tools/check-client.mjs`：**56/56**（原 50/50，本轮 +6）。新增的 2 条是 `attempt` 包住的浅渲染
  （1 待审 + 1 已定案，历史展开 / 收起各一次），4 条断言钉住：只有 open 的单子渲染「应用 / 驳回」（各恰好
  1 个）、已定案卡片给只读说明、计数行如实、历史收起时已定案卡片不出现。做法是把 `fakeReact.__stateQueue`
  拨到 `plans.status==='ready'`（`plans` 是 `KeeperQueueTab` 的第 1 个 `useState`、`showHistory` 是第 15 个 ——
  中间没有会插队的 `useState`：`useAction()` 只用 `useRef` / `useEffect` / `useCallback`）；
- 全量 **288 例 / 288 pass、fail 0**（客户端束改动不影响宿主用例，仍全绿）。

**同轮的数据操作（走待审区，不是直改）**：4 张 open 单逐张审阅 —— 3 张原样通过；1 张（`26feabfe`）第 3 个 op
的 `split` 由仓管的 4 块改成 2 块（① — ④ 是一份 4 条解法清单，按条拆成 3 条记忆会把它切碎；「A2A 交付」那句
另立一条）。只读复核（`readOnly: true` 的 `node:sqlite`，只 `SELECT`）：活跃记忆 **1139 → 1142**
（软删 5 = 1 删 + 1 被替换 + 3 被并；新增 8 = 1 替换新条 + 7 派生块）、总行 1172、软删 30、向量 **1150**、
「活跃但无向量」 **0**；`keeper_plans` 剩 open **0** / approved 26 / partial 2 / rejected 3；
`batches` 5 批全部已裁（`state` 全为 `approved`，**没有 open**）—— 即面板「待审」页本来就是空的。

⚠️ **审计口径（本轮实测）**：手改正文只进 `keeper_plans.review.edits`，`ops[].after` 保留的是仓管原始提案；
两者都在库里，但面板卡片显示的是 `after` —— 复核「审阅时手改过的那张单到底落了什么」要看 `review.edits`。

---

## 2026-10-07 · 面板改版：六个页签 → 三个入口（`lib/client.js` 大改，宿主零改动）

**用户原话**：「现在插件的 UI 不符合我的操作习惯，不要被现有设计约束。我要直观、低认知负荷的界面，
可见的每个按钮、控件、文字都绝对不多余。」以及他对自己习惯的关键描述：
**「我来到待审页主要是来查看某轮次记忆的处理成果如何，极少数情况会动手审批」**。

**改法（只动客户端束）**：

| 原 | 现 |
|---|---|
| 概览（1466 行 / 8 张卡 / 14 处按钮调用点 / 8 处输入框调用点 / 125 条文案） | **删掉**；数字只留「待办」页顶部一行 |
| 全部记忆（188 行） | **删掉**（搜到哪条就处理哪条） |
| 待审 + 仓管待审（1278 行） | 合成一个 **待办**：按轮次读的流水；通过 / 驳回只在「等你确认」出现 |
| 设置（668 行） | 保留原样 + 新增「仓管模型」块（原「概览 → 仓管档案」的能力搬过来 —— 不搬，删概览就等于丢掉 UI 上切换模型的能力） |

**规模**：`lib/client.js` **5111 → 2676 行**（删 2435 行）；新增 38 个词条 × 中英两份。
**宿主零改动**：15 个工具、记忆库、仓管流程、29 条面板路由全没动；数据也是现成的
（变更单自带 `run_id`、抽取批次自带 `batch_id`，按轮次分组不用新造表）。

**自证（实际输出）**：

- `node --check lib/client.js`：**exit 0**；
- `node tools/check-client.mjs`：**53/53**（原 51/51：改口径 + 新增 check）。三条新口径直接钉在设计上：
  ① 只有已处理时**一个「通过 / 驳回」都不画**（用户要的「平时零可操作控件」）；
  ② 待确认的变更单只画一组按钮，批次另画「确认入库」；
  ③ 批次条目数取 `count`（列表接口不给 `items`）；
- 全量：**288 / 288 pass、fail 0**（宿主没动，用例一个没改）；
- 编码：无 BOM、无 U+FFFD。

**改版过程中自检逮到的两个真 bug（都发生在用户看到之前）**：

1. `KeeperModelBlock` 里写成了 `{ className: …, key }`（对象属性简写，但作用域里没有名为 `key` 的变量）
   → `ReferenceError`：**设置页那一块会整块炸掉**。这是「数据态浅渲染」这条 check 存在的全部意义 ——
   只跑 loading 态的浅渲染永远看不见它；
2. 批次行原本读 `batch.items.length`，而 `store.listBatches()` **只返回 `count`**（`items` 只在 `/batch` 里）——
   照原样会显示「0 条事实等你确认」。修法：条目数取 `count`，展开时才按 id 调 `/batch` 取条目（取过就缓存）；
   同时补了一条回归断言（fixture 刻意让 `count: 3` 而 `items` 只有 1 条，断言显示的是 3）。

**如实边界**：

1. **设置页还没瘦身**：它仍是原来那 668 行（嵌入档案列表 + 常驻表单 + 只读配置行 + LLM 预检 + 凭据）。
   本次只往里加了「仓管模型」块，**没有**按「点名字才展开」收它 —— 下一轮的事；
2. 词条表里留着一批**不可见的死键**（`tabOverview` / `tabList` / `tabReview` / `kq*` 等）：渲染不受影响，但没清；
3. 旧的 CSS 也有死规则（`.dshm-metrics` / `.dshm-metric*` 等）：同理没清；
4. **界面真机效果我没看过**：这台机器不让无头浏览器起子进程
   （`mojo platform_channel.cc: Check failed: 拒绝访问` + crashpad `OpenProcess: 拒绝访问`，
   连一次性 danger-full-access 放行也一样），只能靠自检的浅渲染 + 交互回调冒烟。**用户刷新面板后的实况才算最终验收**；
5. 删掉概览后，**回填 / 强制全量重算 / 一键备份 / 回滚仓管改动在面板上没有入口了**（用户明确接受这个代价），
   只能走工具或让 agent 做；手动录入 / 手动抽取同理。

---

## 2026-10-07 · 记忆自足性：一条"会过期的通则"进库之前被拦住（`transient.js` 规则 + 两条提示词）

**用户当场指出的原文**（真实库里那条待审记忆）：

> 用户日常主要只用插件的四个页签：检索、仓管待审、待审、设置

**用户的原话**：「又犯了语句残缺的问题……未来你阅读这段记忆的时候你真的能看懂吗？难道不会理解为我用插件
一律用四个页签吗？这很危险」。

**三个缺陷，逐个说清**：

1. **把会变的状态写成通则**：页签清单是**版本绑定**的事实，当天就改版成了「待办 / 查 / 设置」三个入口 ——
   这条一入库就是假的；
2. **没有锚点**：没说"截至哪天、哪一版"，后来的读者（包括 agent）只能当成永久通则 —— 这正是危险所在；
3. **缺主语 / 缺范围**：「用户日常主要只用」没有说是"看这个面板时" —— 会被读成"用户用插件一律用四个页签"。

**处理（按用户定的规矩：依原记忆改写 → 新旧对比 → 过审）**：批次 `11eb7edc` 两条**都改写后过审**，
危险原文一个字都没入库：

| 原文 | 过审后的正文 |
|---|---|
| 用户日常主要只用插件的四个页签：检索、仓管待审、待审、设置 | 用户看记忆面板的习惯（2026-10-07 说明）：日常主要只看待处理与检索这两类页面，基本不看「概览」这类仪表盘页。 |
| 用户认为插件整体 UI 可读性有待提高，控件排列不够简洁 | 用户对面板 UI 的要求（2026-10-07 提出）：直观、低认知负荷，且可见的每个按钮 / 控件 / 文字都不得多余。 |

（**易变的那半直接丢掉**：页签清单本来就是会变的；**耐用的那半留下**：用法习惯与设计要求。）

**根因与修法（两头都补）**：

1. **两条抽取提示词**（`EXTRACT_PROMPT` / `EXTRACT_FOCUSED_PROMPT`）新增「自足与时效」铁律：每条必须脱离
   上下文能读懂（主语 / 范围 / 时间）；会变的东西（界面结构、数量、配置值、端口、版本号、模型名）
   **必须带时间或版本锚点，给不出锚点就不要抽**；原文若只是"当下的使用快照"，只抽耐用的那半。
   各补一正一反例（反例就是上面那条原文）；
2. **确定性闸**（`transient.js`）：新增 `VERSION_BOUND_RE` + `COUNT_RE` + `ANCHOR_RE`，
   **界面结构词 + 数量枚举 + 无时间/版本锚点 → `uncertain`**（带命中理由 `版本绑定:缺时间锚点`，给审阅人看）。
   ⚠️ 这条**排在长期信号之前、不受豁免** —— 旧口径下「用户**要求**面板只保留四个页签」命中 `要求` 会**直接入库**，
   这才是真炸弹（走的是 direct 直存路径，不进待审区）。

**过程中自检又逮到两个真问题（都不是猜的）**：

1. **`待办 / 待处理` 误杀**：写进库的那句「用户习惯只看待办与检索页面」过一遍分类器 → 被判
   `transient:待办进度` **丢掉**。原因是硬规则 `/接下来|下一步|待办|待处理|TODO/` 把**页面名**当成了进度态。
   修法：`待办 / 待处理` 从硬规则摘出去、挪到弱规则（只有 `待办：` 清单形态才算进度），
   两个词单独出现则落 `uncertain`（不丢、交人眼）；
2. **新规则自己误报**：初版把 `入口 / 端口 / 版本 / 路径 / 目录 / 模型名` 也算"版本绑定"，全库扫描发现它把
   「用户决定采用新范式……所有落库只通过 `reviewKeeperPlan` 这**一个入口**」这类**真决定**圈了进去
   （这里的"入口"是架构写入口，不是界面）。收窄为**只收界面结构词**。

**自证（实际输出）**：`node --check` 两个改动文件 exit 0；`test/transient.test.js` **17/17**（新增 4 个用例：
版本绑定必须经人眼 / 命中理由可读 / 带锚点放行 / 不误伤）；全量 **292 例 / 292 pass、fail 0**（原 288，+4）；
只读扫全库（`readOnly: true`，只 `SELECT`）：含界面词的活跃记忆 68 条 → 命中新规则的 **1 条**（收窄前是 4 条，
其中 1 条是我自己的误报）。

**如实边界**：

1. **新闸只管新录入**：`looksTransient()` 只在捕获 / 抽取时跑，**不会回头改已入库的行**。所以这次全库扫描
   只是**报告**，不是清理；
2. 唯一残留（未动）：`ba10581a`（宫殿导入的画布设计稿，「30% 视口宽 / 40% 视口宽」）—— 它是**历史设计稿**，
   不是会被读成通则的规则，风险等级不同；想给它补锚点可以走 `propose` → 过审；
3. 判定仍然是**启发式**：`ANCHOR_RE` 认的是"有没有锚点字样"，不判断锚点是否真的贴着那句话；
4. 提示词是软约束：模型仍可能不写锚点 —— 所以确定性闸（第 2 条）才是真正的兜底。

---

## 2026-10-07 · 客户端三处缺陷：不同页签宽度不一 / 点开记录就白屏 / 设置页太乱（`lib/client.js`）

**用户报的三条**（原话）：①「不同页签的界面宽度不统一」②「点击已处理的记录会白屏」
③「设置页签的界面太乱太冗余，不够一目了然」。

### 缺陷 2（最严重，先查）：点开任何一行 → 整页白屏

**根因**：面板改版删掉旧分区时，把**只在展开态才用到的助手 `shortId()`** 连定义一起删了，
而 `planDetail()` 还在调它（`lib/client.js` 详情里画目标 id 前缀那一行）。

**为什么自检没发现**：行**折叠时不渲染详情** —— 浅渲染只走初始（收起）态，于是 53 条断言全绿、
人一点开就 `ReferenceError` → React 卸载整棵树 = 白屏。

**证据（先复现，再修）**：自检里新增展开态渲染后，改前实测输出

```
[FAIL] 展开一条**已处理**记录不抛错（白屏回归）  ← ReferenceError: shortId is not defined
[FAIL] 展开一条**待确认**记录不抛错              ← ReferenceError: shortId is not defined
```

**修法**：补回 `shortId()`（放在 `clip()` 旁边，注释里写明它被误删过）。

### 缺陷 1：不同页签宽度不一

**根因**：`max-width:1120px` 原先挂在**滚动容器** `.dshm-root`（`height:100%;overflow:auto`）上。
高页签（设置）出现纵向滚动条时内容宽被吃掉约 15px、低页签没有 → 切页签时卡片边缘左右跳。

**修法**：滚动条槽位恒定（`.dshm-root{…;scrollbar-gutter:stable}`）+ **宽度上限挪到内层内容列**
`.dshm-col{width:100%;max-width:1120px;margin:0 auto}`，三个页签的列宽只由这一层算。

**如实边界**：无头 Edge 在本机沙箱里起不来（mojo `platform_channel.cc` + crashpad `OpenProcess` 拒绝访问），
所以**这次没有截图核对**，机制是从 CSS 推的。如果跳动的真凶是**宿主外壳自己的滚动条**（不在本插件管辖内），
那就还需要一个现象才能定位 —— 届时给一张"两个页签各自的卡片右边缘"截图就够。

### 缺陷 3：设置页太乱太冗余

改前是 **6 张卡 + 5 段说明文字**，其中「只读配置」10 行里 provider / model / 维度 / 密钥引用
**与档案行重复**，编辑表单还是**另一张卡**（点一行、再看另一处）。

改后 **2 张卡 + 1 个默认收起的抽屉**：

| | 改前 | 改后 |
|---|---|---|
| 卡 | 嵌入配置档案 / 编辑表单 / LLM 预检 / 只读配置 / 写入密钥 / 仓管模型（6） | **嵌入模型** / **仓管模型**（2） |
| 编辑 | 独立一张卡，靠「选中」再跳过去 | **点名字就地展开**（收起时零编辑控件） |
| 密钥 | 独立一张卡 + 两段说明 | 并进编辑体一行：`写入密钥 · <引用名>` + 输入框 + 按钮 |
| 只读配置 / LLM 预检 / 数据目录 | 两张卡常驻 | 一个 `<details>`「诊断」（默认收起） |
| 说明文字 | 5 段 | 每张卡**一行** |
| 与档案行重复的信息 | provider / model / 维度 / 密钥引用 / 当前空间各列一遍 | 全删 |

**动作语言统一**：设置页的「嵌入模型」与「仓管模型」现在是同一套 —— 点圆点切生效、点名字改、
`＋ 新建档案`、`.dshm-fields` 竖排字段、内置档案不给「删除」（删不掉的东西不画按钮）。

### 顺带清理：字典里的 198 个死键

扫出**每个语言 198 个键**（概览 / 列表 / 待审 / 仓管待审 / 备份 / 回填等已被删掉页面的文案）
在**字典之外没有任何引用**，全部删除：每种语言 **331 → 131 键**。

**这个过程我自己踩了一个坑（记下来）**：第一版删除脚本只删 `key:` 那一行，
而长文案的值写在**下一行**（`backfillAllConfirm:` 换行 `'…'`）→ 留下孤立字符串，
`node --check` 直接报 `SyntaxError: Unexpected string`。**从备份回滚**（`dsh-memory-UI-草稿/client.三修后-77通过.js`）
后给脚本加上"续行一起吃掉"的逻辑再跑（撞到下一个键或字典收尾就停）。

### 自证（实际输出）

```
node --check lib/client.js                exit 0
tools/check-client.mjs                    77/77（原 53；新增 24 条：展开态 8 + 宽度 3 + 设置页结构 12 + 缺键 1）
node --test --test-isolation=none test/*  292/292 pass、fail 0
编码                                      四个改动文件无 BOM、U+FFFD 0 处
规模                                      lib/client.js 2749 → 2264 行（其中 438 行是死键）；设置页函数 644 → 579 行
```

**新增的 4 类断言（都是这次缺陷换来的）**：
① 展开态必须渲染（白屏回归）——折叠态渲染覆盖不到「一点就炸」；
② `max-width` 不许挂在滚动容器上 + 三个页签必须同在一个 `.dshm-col` 里；
③ 设置页结构：只剩两张卡、诊断在 `<details>`、收起时零编辑控件、内置/新建不给删除；
④ 源码里每个 `t('键')` 都必须在词典里（缺键不抛错，但会把键名原样画到界面上）。

**如实边界**：**这条只在客户端**，宿主半与 15 个工具一行未改；面板仍不提供回填 / 备份 / 回滚的入口
（用户 2026-10-07 接受的取舍），它们只在工具侧。

---

## 2026-10-07 · 设置页再收口：用户**在截图上逐条批注**（`lib/client.js`）

用户发来设置页截图 + 红笔批注，逐条落实（外加一条我自己看出来的用词不一致）：

| # | 用户原话 | 改法 |
|---|---|---|
| 1 | 「嵌入配置（档案）→ **改成：向量模型**」 | 卡片标题改为 **向量模型**（`profilesTitle`），与隔壁「仓管模型」对称 |
| 2 | 「点圆点切生效、点名字改；密钥只写进凭据库，不回显」→ **冗余，移除** | 删掉这张卡的说明行（`profileHint` 整键删除）；仓管那张的同类说明一并删除 —— 两块是同一套动作语言，留着就是同一句冗余；圆点与名字各自带悬停提示，信息没丢 |
| 3 | 红框圈住模型名 → **只保留模型名** | 行里去掉 provider Tag，只画模型名；provider 收进 `title`（同名的线上 / 局域网档案悬停仍能分清）。缺口从 `已有 1163 / 缺 0` 改成：没缺 → `1163 条`，缺了 → 红字 `缺 N 条` |
| 4 | 仓管 `config ollama — 内置 未配置` → **没看懂这是什么，你看能不能移除** | 它就是**补丁配置**（`cordis.patch.yml` 里的 `keeper.*`，宿主永远返回的兜底档案）—— 和「向量模型」卡里那个 `config` 是同一件东西。没配置就不占列表（见下一条）；另外把两张卡的标签统一成 **补丁配置**（原来一个叫「内置」、一个叫「补丁配置」） |
| 5 | `局域网-ollama ollama — 未配置` → **没配置就不要一直挂在这 这样属于冗余** | 未配置且**未生效**的档案收进一行 `未配置的档案 N 个`（`<details>`，与「诊断」同一个折叠语言）；**正在生效的那个一律显示**（哪怕没配置，否则人不知道自己在用什么） |

**为什么是「折叠」而不是「隐藏」**：直接不画，那个档案就**再也改不了、删不掉**（面板里没有别的入口）。
折叠行一个字不多占，点开照旧能改、能删 —— 这正是用户要的「不一直挂着」。

**过程中自检又逮到一个我自己的错**（这次是断言写错，不是代码错）：
`flattenTree()` 返回的是**扁平数组**，子树里的节点同时也是数组的顶层元素 —— 我一开始用
「遍历时跳过 details 节点」来区分「折叠外 / 折叠内」，结果折叠内的名字照样被算进折叠外，断言假失败。
改成 `flattenTree(details)` 取集合、再从扁平数组里**减掉**才对。

**自证（实际输出）**：`node --check` 两个文件 exit 0；`tools/check-client.mjs` **80/80**
（新增 3 条：折叠行内 / 外分别断言、生效的未配置档案必须显示、行里只画模型名 + 缺口口径）；
全量 **292/292 pass、fail 0**。

**顺带修正的文档错误**：README / REGRESSION 里把第二个入口写成「查」，面板上的真实标签是**「搜索」**
（`tabSearch: '搜索'`，用户截图里也是「搜索」）—— 已按实际文案改正。

---

## 2026-10-07 · 「诊断」这块是干什么的（用户提问）+ 客户端死代码清扫

**用户问**：指着设置页那块折叠区问「这块是干什么的」。它是我上一轮加的「诊断」抽屉，**默认收起**，
用户点开看到了六行。逐个交代 + 顺手改掉三处：

| 行 | 是什么 | 处置 |
|---|---|---|
| LLM 预检（按钮） | 真打一次最小生成请求，验宿主模型能不能用（抽取新事实 / 判新旧冲突都靠它） | **留**（出故障时的一键问清入口） |
| 密钥状态 / 来源 | 嵌入密钥配没配、从哪解析到的（如 `credentials:DASHSCOPE_API_KEY`） | **留**（报鉴权错时看） |
| 数据目录 | 库文件在哪（找库 / 备份时用） | **留** |
| 作用域 / 检索条数 | 纯静态配置 | **删**（需要时 `memory_stats` 有） |
| LLM（provider · model） | 纯静态配置，且未配置时两空值拼成 **`— · —`** —— 一行残句 | **删**（同名的 LLM 探活按钮会把真值报出来） |

另外两处：
1. **位置**：它原来夹在「向量模型」与「仓管模型」之间，看着像**第三张卡** → 现在挂在「向量模型」卡内部，
   两张模型卡挨着（自检里加了一条：details 必须在「向量模型」卡子树里）；
2. **同名标签**：原来左边一个「LLM 预检」标签、右边一个「LLM 预检」按钮 —— 同一个词画两遍 → 只留按钮。

**顺带清掉的死代码**（面板改版删页之后留下的）：

| 清掉什么 | 怎么确认它死了 |
|---|---|
| 11 个字典键：`score / kind / batches / rejectBatch / relation / reason / keeperStatLossless / relSupersede / relDuplicate / relCoexist / relUnrelated` | 字典之外**没有任何字面量引用**（在 `lib/client.js` + `lib/index.js` + `src/**` + `tools/**` + `test/**` 里全查过） |
| 旧的「关系」助手：`RELATION_KEY` / `relationLabel()` / `relationTone()`（约 30 行） | 全库无调用点；它们正是那四个 `rel*` 键的唯一引用者，跟着一起走 |
| `Metric` 指标格组件 + `.dshm-metrics / .dshm-metric*` CSS | 组件无渲染点；CSS 类在 JS 里零引用 |
| `localTime()` / `formatBytes()` | 概览页与备份卡删掉后无调用点 |
| 另外 8 组死 CSS：`.dshm-sub / .dshm-rel* / .dshm-batch* / .dshm-check / .dshm-foot / .dshm-bar* / .dshm-tail` | 类名在 JS 里零引用 |
| `test/keeper.test.js` 里那条**过期断言** | 它用「字典里还留着 `keeperStatLossless`」当「兜底切分真在累加」的**代理**——可面板早就不画那格了。改成：三个面板键**都不许复活**，而「真在累加」由同文件里 `publicKeeper().losslessFallback` 那条**跑真一轮**的断言盯着 |

**新加的常驻哨兵**：`tools/check-client.mjs` 末尾会打一行
`提示：字典里没有字面量引用的键 N 个`（启发式：键名在源码里以 `'键名'` 出现过就算活的；
`PLAN_STATE_KEY` 这类表里的值也是字面量，不会误判）。**现在 N = 0**。

**自证（实际输出）**：`node --check` 三个文件 exit 0；`tools/check-client.mjs` **80/80**；
全量 **292/292 pass、fail 0**；`lib/client.js` 2282 → 2145 行。

**如实边界**：死键清扫的第一版脚本只删 `key:` 那一行，遇到**值写在下一行**的长文案会留下孤立字符串
（`node --check` 直接报 `SyntaxError: Unexpected string`）—— 那次是**从备份回滚**后给脚本加上
「续行一起吃掉」再跑的；现在的删除脚本仍然只有这个启发式，不认更复杂的跨行表达式。

---

## 2026-10-07 · 「诊断」整块从面板移除（用户：「移除吧」）+ 我自己的两次手滑

**用户拍板**：上面那节讲完「诊断」是什么之后，用户回「移除吧」——那就**整块拿掉**，设置页只剩
「向量模型」与「仓管模型」两张卡。

**删掉的东西（客户端）**：

| 删什么 | 说明 |
|---|---|
| `<details>` 诊断块（summary + LLM 探活按钮 + 结果区 + 密钥状态/来源 + 数据目录行） | 面板不再有 `details`（自检加断言：**一个都不许有**） |
| `testLlm()` 处理函数、`llmResult` state | 唯一触发者是那个按钮 |
| `keyStatus` / `keyConfigured` 派生、`diagRows` | 唯一读者是那两行 |
| `PathLabel` 解构（`tools/check-client.mjs` 的 `PRIMITIVE_NAMES` 同步删） | 唯一用处是画数据目录 |
| 10 个字典键：`settingsDiag / keyStatus / keySource / keyConfigured / keyMissing / dataDir / llmTest / llmTesting / llmTestOk / llmTestFailed` | 删完自检末尾的「死键」提示行仍是 **0** |

**没动的东西（宿主）**：`POST /llm-test` 路由**照旧挂着**（`test/panel.test.js` 里那条路由断言也照旧过）。
理由是它仍然可用：agent 或 curl 直接调，`memory_stats {probe:true}` 走的是同一套能力。
README 的「设置」路由列里把它去掉了（面板不再调它），并写明它还在。

**我自己在这次改动里连滑两次**（都记下来，因为这是最容易复发的错）：
用 `edit` 删函数时，我把 `old_string` 写成 `const saveProfile = () => {`、`new_string` 里却**带着**
要删的那个函数 —— 方向反了，等于**又插进去一份**，第一次造成 `const testLlm` 重复声明，
第二次同样（幸好每次都被 `node --check`/grep 立刻抓住）。第三次才用
`old_string = 整块函数`、`new_string = 空`、`replace_all: true` 真正删掉。
**教训**：删函数的 `new_string` 必须是空串；要验"到底删干净没"，只看 `node --check`
不够（重复声明才报错），得再 grep 一次函数名与它的 state setter。

**自证（实际输出）**：`node --check` 两个文件 exit 0；`tools/check-client.mjs` **80/80**；
全量 **292/292 pass、fail 0**；`lib/client.js` 2145 → 2040 行；死键提示 **0**。

**顺手记一个刚踩到的坑（跑测试的方式）**：`node --test` **不给文件参数**时会**递归发现**测试文件 ——
它会把 `<DSH 工作区>/dsh-memory-data/.retired/palace/snapshot/test/*.test.js`（退役快照里的旧测试，已移出仓库）也算进来，
于是报告 **293** 而不是 292。**全量必须显式给 `test/*.test.js` 那 17 个文件**：
`node --test --test-isolation=none <17 个文件>`。这一节的所有数字都是这么跑出来的。

---

## 2026-10-07 · `config` 落成真档案「线上」+ 设置页四个批注（含一次**写库**）

**用户的第三张截图批注**（五条）：①「config → 改成『线上』」②「『补丁配置』标签 是冗余 移除」
③「添加按钮『删』」④ 仓管那张卡的「测试 → 测」「删除 → 删」⑤「『未配置的档案 2 个』→ 移除」。

### ① 为什么这不是改文案，而是一次写库

查清了三件事：`cordis.patch.yml` 里**根本没有 `embedding:` 段**（那一行 `config` 用的是
`DEFAULT_CONFIG.embedding` 的内置默认值）；库里 `embedding.profiles` / `embedding.active`
**两个键都不存在**（一个真档案都没有）；`saveEmbeddingProfile` / `deleteEmbeddingProfile`
**硬拒名字 `config``** —— 所以「叫线上 + 能删」在补丁配置上做不到，只能**落成真档案**。

**做法**：把 `DEFAULT_CONFIG.embedding` **逐字抄**成一条真档案（名字 `线上`）写进
`settings.embedding.profiles`，并把 `settings.embedding.active` 设为 `线上`。
写之前跑了三重护栏：① 当前生效空间键必须等于 `openai:qwen3.7-text-embedding:1024`；
② 不得已有同名档案；③ 写完复验向量数不变。实测输出：

```
当前生效空间 : {"key":"openai:qwen3.7-text-embedding:1024",...}
该空间向量数 : 1169      该空间还缺 : 0
写后 embedding.active : 线上     写后该空间向量数 : 1169   ← 一条都没重算
```

**回滚**（写前那两个键本来不存在）：`DELETE FROM settings WHERE key IN ('embedding.profiles','embedding.active')`。

> ⚠️ **这一步被沙箱拦过一次**：库在 `<DSH_HOME>\dsh-memory\` 下、不在会话工作区内，
> `workspace-write` 报 `attempt to write a readonly database`（`SQLITE_READONLY`）。
> 用一次性的 `danger-full-access` 单次授权（用户批的）才写成。

### ②③④⑤ 面板侧的四处改动

| 批注 | 改法 |
|---|---|
| 「补丁配置」标签冗余 | 标签删掉；补丁那颗**只在它生效时**出现一行，且那行的**名字**直接显示成「补丁配置」（悬停能看到技术名 `config`，点不动 —— 改/删都由宿主拒） |
| 添加按钮「删」 | 档案行右侧加 `删`；**自检当场逮到一个真冗余**：行上一个「删」、展开后的编辑体里还有一个「删」= 同一个动作画两遍 → 编辑体里那个删掉（与「仓管模型」那张卡的既有做法一致：**删只在行上**） |
| 测试/删除 → 测/删 | `profileTest` = `测`、`delete` = `删`（两张卡共用一个键；`keeperProfileTest` 删掉）；英文侧 `Test connection` → `Test` |
| 「未配置的档案 2 个」移除 | 折叠行整块删掉 → **没配置的档案整条不画**。**代价如实写在这**：面板里再也看不到 / 改不了 / 删不掉那些档案（要清理得让 agent 动库）。因此给「＋ 新建档案」的保存加了道校验：**模型 id 不能空**（空档案存下去会凭空消失，比报错更让人摸不着头脑） |

字典随之：删 `keeperProfileTest` / `keeperUnconfigured`，加 `keeperModelRequired`，
`profilePatchTag` 正名成 `patchProfile`（它现在是「兜底行的显示名」而不是标签）。**死键提示仍是 0**。

**用户库里那两个未配置的仓管档案**（`config`、`局域网-ollama`）**没有删**，只是不再显示 ——
要清掉出声即可（`memory_keeper {action:'delete', name}` 或我直接动库）。

**自证（实际输出）**：`node --check` 两个文件 exit 0；`tools/check-client.mjs` **80/80**；
全量 **292/292 pass、fail 0**；死键提示 **0**；库里空间键与向量数写前写后都是
`openai:qwen3.7-text-embedding:1024` / **1169**。

---

## 2026-10-07 · 配置改用**独立窗口**（用户：`Modal`），行内展开整块移除

**用户原话**：「每个模型点击后都用一个独立窗口展示对应配置 每条参数各自拥有该行的空间 互相不拥挤。
原点击展开配置的效果移除。」

### 关键一步：**先去读平台 `Modal` 的真实 props，不猜**

这是手写免构建束，props 猜错（`open` vs `visible`、`children` vs `body`）在浏览器里就是整页白屏。
`app.asar` 是归档、没解包，所以写了个脚本**直接解析 asar 头**（offset 12 是 header JSON 长度、
文件数据从 `16 + headerSize` 开始）→ 取出 `@deepseek-ai/dsh-client-ui-primitives` 的
`README.zh.md` 与 `lib/index.js` → 拿到实现：

```js
function Modal({ open, onClose, title, closeLabel, description, children, footer,
                 className, contentClassName, onKeyDownCapture, headless, backdropBlur, shortcutModal }) {
  if (!open) return null;                       // ← 关着就是 null
  return createPortal(… mask / dialog / h2(title) / close(aria-label=closeLabel)
                       / p(description) / div(body=children) / div(footer) …, document.body);
}
```

顺带确认了 README 里那句「原子组件读不到 app locale，每段面向用户的文案都必须通过 label prop 提供」
—— 所以 `closeLabel` 是**必须给的本地化文案**（`t('close')`；这个键在之前的死键清扫里被删过，重新加回）。

### 改了什么

| 之前 | 现在 |
|---|---|
| 点名字 → 在**行下面**展开一段编辑体（`.dshm-fields` 三列网格） | 点名字 → **平台 `Modal` 独立窗口**（遮罩 + 居中 + Esc / 焦点由它管） |
| 参数三列并排、互相挤 | **一行一条参数**（`.dshm-field-row`：标签定宽 7rem、控件撑满） |
| 编辑体里自己排 保存 / 取消 / 删 | 窗口 `footer` 只有 **保存 / 取消**（结构的职责：动作走 footer，不走正文） |
| 「仓管模型」那张卡的表单是另一套写法 | 两张卡**完全同一套**：同一个窗口、同一行参数、同一个 footer |
| 「新建档案」在列表底下摊开一张表单 | 新建也走**同一个窗口**（标题「档案配置」、描述为空） |

**自检又逮到一个重复**：我第一版把 `测` 同时放进了**窗口 footer** 和**行上** —— 同一个动作画两遍。
按用户上一轮「测 / 删 在行上」的批注，把窗口里那个撤掉，`测` 的结果改为显示在**卡片上并带上档案名**
（`线上 · qwen3.7-text-embedding → 返回 1024 维，耗时 84 ms`）—— 否则结果会出现在看不见的窗口里。

### 自检也要跟着改（同一个坑，第二次踩）

`Modal` 的 `footer` 与 `Card` 的 `action` / `title` 一样是 **prop、不走 children**，`countText` 看不见它。
新增三个助手：`propTree(node,key)`（展平某个 prop 子树）、`modalNode(nodes)`、`countClass(nodes,cls)`。
第一版把它们写在「设置页」那一段（第 700 行之后），而「仓管模型」的用例在第 720 行就开始用了
→ `ReferenceError: Cannot access 'modalNode' before initialization`（TDZ）。把三个助手挪到
`countText` 旁边（第 5xx 行）就好了。**教训**：自检里的公共助手要挨着其他公共助手放，别夹在用例中间。

**新增/更新的断言（合计 87 条）**：点档案**必须出现 Modal**（且 `open === true` / `title` / `closeLabel` /
`description` = 档案名）；窗口里**正好 6 行 `.dshm-field-row`**、`.dshm-fields` 为 0；footer 里
**只有 保存 / 取消**（没有 `测`）；**收起时没有任何 Modal**；新建窗口不画密钥写入；仓管窗口同样 6 行 + footer 两项。

**自证（实际输出）**：`node --check` 两个文件 exit 0；`tools/check-client.mjs` **87/87**；
全量 **292/292 pass、fail 0**；死键提示 **0**。

**如实边界**：窗口走 `createPortal(…, document.body)` —— 面板自己挂在 `main` 槽里，弹窗挂到 body
是平台 `Modal` 的既定做法（DSH 自己的对话框也这么干），没有额外层级问题；但**这一条我只有代码证据、
没有截图证据**（无头 Edge 在本机沙箱起不来），最终观感以你刷新后看到的为准。

---

## 2026-10-07 · 待办页三处：进度条 / 一轮默认收起 / 变更单说人话

**用户第四张截图的三条批注**：① 指着「正在看 0/20 · 失败 0」→**做成进度条**；
② 指着「10/7 14:19 仓管一轮 19 张单 · 通过 18 · 驳回 1」→**收起来**；
③ 另发一张待确认行的图（`删除 1 条 · 合并 2 条 → 1 条 · 拆分 1 条 → 7 块 · 拆分 1 条 → 4 块
prompt 只写「必须在画面里出现」的东西; 本来就…`）→**「这个描述太抽象，难以理解」**。

### ① 进度条

新增 `progressPercent(job)`：`total` 缺失 / 为 0 / 非数字 → **返回 0**，并且夹在 0–100；
`style.width` 永远是 `'25%'` 这种字符串，**绝不把 `NaN` 塞进去**（那是白屏与视觉错乱的经典来源）。
CSS 新增 `.dshm-progress-row` / `.dshm-progress` / `.dshm-progress-fill`（只读 `--dsw-*` token）。
计数那行**保留**、挨着条子显示：条给"还剩多少"的直觉，数字给准数。
> 讽刺的是：`.dshm-bar` / `.dshm-bar-fill` 正是我在几轮前当**死 CSS** 清掉的（那时面板不画进度条）——
> 这次按需求重新加，但用了新名字与新位置。

### ② 一轮默认收起

「已处理」里每一轮原来把 19 张单全铺开 → 现在轮次那一行自己可点（`▸` / `▾`，键 `run:<runId>`），
**默认收起**，点开才铺开这一轮的每张单。

> ⚠️ 这条改动**当场暴露了自检的一个空转断言**：老的「展开一条已处理记录不抛错（白屏回归）」
> 在收起状态下**什么都不渲染**，于是它"通过"得毫无意义（那个白屏 bug 正是只在展开态才出现）。
> 已修：`renderTodoOpen` 现在支持 `keeperJob` 参数，展开用例先给 `run:<runId>`、再给 `plan:<id>`，
> 并且补了两条新断言——「默认收起：只画轮次那行」与「点开轮次才铺开」。

### ③ 变更单说人话

新增 `planSummary(t, plan)` 取代「把 op 计数排一串」：

| | 渲染出来的样子 |
|---|---|
| 旧 | `删除 1 条 · 合并 2 条 → 1 条 · 拆分 1 条 → 7 块` +（另一个 span）`prompt 只写「必须…` |
| 新 | `删除 1 条：被删掉的正文 · 还有 1 项`（第一项 + 它动的正文开头 44 字 + 还有几项） |

两处行（待确认 / 已处理）都走同一个 `planSummary`，所以摘要口径只有一处实现。
`opPreview(op, max)` 加了 `max` 参数（默认 26，摘要里用 44），原来那个单独的预览 span 删掉了 ——
同一行里"动作"和"对象"不再分成两段彼此断开的文字。

**自证（实际输出）**：`node --check` 两个文件 exit 0；`tools/check-client.mjs` **92/92**
（新增：默认收起 / 点开铺开 / 摘要格式 / 进度条 25% / `total:0` 给 0%）；全量 **292/292 pass、fail 0**；
死键提示 **0**。

---

## 2026-10-07 · 标题阶梯拉不开 + 仓管跑一轮看不见过程（`lib/client.js` + `lib/index.js`）

**用户第五张截图两条**：①「大标题小标题样式不能一样否则分不清」；
②「仓管运行过程中 我需要能看见仓管的工作过程…以及确保它没卡住而是在正常运行」。

### ① 标题阶梯 —— 以及一次**差点改错**的排查

第一反应是「`--dsw-font-m-18-*` 这类 token 是不是我编的」：`client` 侧的 Inspect `Theme.listTokens`
只回了 **14 个颜色 token**（`--dsw-alias-*`），一个字体 token 都没有 —— 看起来像"字体 token 不存在、
`font-size` 静默失效、页面标题掉回 14px 和卡片标题一样"。

**没有直接改**，而是做了决定性检查：解析 `app.asar` 头、扫 150 个
`@deepseek-ai/dsh-client-ui-*/lib/*` 文件（用 `--dsw-alias-bg-base` 当对照）：

```
--dsw-alias-bg-base 命中 41 次（对照）
--dsw-font          命中 349 次    ← 名字是**真的**
平台里真实出现过的 --dsw-font-* 名字共 185 个
```

所以 token 没错，**错的是阶梯**：页面标题 `m-18`（18px，权重取自 token）、卡片标题只有
`font-weight:500`（字号 14px 继承）、分组标题（轮到那一行）也是 14px —— 三级挤在一起，当然分不清。

**改法（五档，全部用已核对的真实 token）**：

| 层级 | 档位 |
|---|---|
| 页面标题「本地记忆」 | `--dsw-font-l-20-*`（20px）+ `font-weight:600` |
| 卡片标题「已处理 / 向量模型 / 仓管模型」 | `--dsw-font-base-strong-16-*`（16px 强档） |
| 分组标题（一轮那一行） | 14px + **600 字重 + 主色**（与正文同字号，靠字重/颜色区分） |
| 正文 / 行文本 | `--dsw-font-s-14-*`（14px，400，次要色） |
| 字段标签 / 运行日志 | `--dsw-font-xxs-12-font-size`（12px） |

**新增常驻守卫**：自检里加了 `FONT_TOKEN_ALLOWLIST` —— 样式里出现的每个 `--dsw-font-*` 都必须在
"已核对过的白名单"里，**编一个不存在的 token 会直接失败**（编错不会抛错，只会静默失效，正是这类
"看起来没变"的问题的温床）。白名单的来源写在注释里（怎么从 asar 里核出来的）。

### ② 仓管跑一轮时看见过程

查宿主：**数据其实早就有** —— `publicKeeper()` 里有 `startedAt` / `plans` / `ops` / `skipped` /
`retried` / `lastError` / `tail`（逐组记 `组 N：M 条操作` / `组 N：超时，重试一次` / `组 N：失败（原因）`），
而面板只读了 `done/total/failed` 三个字段。

**宿主侧两处**（`lib/index.js`）：
1. `tail` 从 `slice(-5)` 放宽到 **`slice(-20)`** —— 一轮十几组也看得出节奏；
2. 每组**开始**时先记一行 `组 N：开始（M 条记忆，种子 xxxxxxxx）`：线上模型吐 2000 token 的 JSON
   实测单组可能 1–4 分钟，只记"结果"的话整组跑完前面板**一行都没有** —— 那正是"看起来卡死"的根源。

**面板侧**（`lib/client.js`）：跑的时候依次显示
① 进度条 + `正在看 5/20 · 失败 0`；② `已跑 2:05` + `已出 3 张单 / 7 条操作 · 跳过 1 · 重试 1`；
③ **逐组日志**（最后 8 行，12px 等宽，最新在下，超出可滚）；④ **心跳** `最近一次进展 8 秒前`
+ `单组可能要几分钟，超时会自动重试一次 —— 进度暂时不动是正常的。`
心跳靠"进度指纹"（`done`/`failed`/tail 行数）变化来记时，用 `useRef` 存指纹、`useState` 存时刻
（指纹只用于比较，不该触发重渲染）。

**宿主改动逼出两条测试更新**（诚实记账）：`tail` 现在第一条是"开始"行，于是
`assert.deepEqual(job.tail, [...])` 改成 `job.tail.slice(1)`（并断言第 0 行形如"组 1：开始（…）"）、
`assert.match(job.tail[0], /失败/)` 改成 `tail.find(line => line.includes('失败'))`。

**自证（实际输出）**：`node --check` 三个文件 exit 0；`tools/check-client.mjs` **98/98**
（新增：字体 token 白名单、标题阶梯、过程可见三件套、`total:0`→0%、`running:false` 不画）；
全量 **292/292 pass、fail 0**；死键提示 **0**。

**如实边界**：`tail` **只按组更新** —— 一组的 LLM 调用进行中没有新行（宿主没有组内流式进度）。
所以"心跳 + 单组可能要几分钟"这两行是必需的补充，而不是装饰；真要组内实时进度，得让宿主把
LLM 流的进度也记进 tail（那会改到 `runKeeperRun` 的调用路径，属于另一件事）。

---

## 2026-10-07 · 搜索页可改可删（改 → 送审）+ 审阅区一键通过

**用户原话**：「让搜索出来的记忆可删除或编辑，若编辑则将编辑完成的产物送入待审区。审阅区新增一键通过。」

### ① `改` 走待审区 —— 面板**不新开**改库路径

查宿主：工具侧早有 `proposeKeeperReplace({id, text, reason})`（建一张单 op 的 `replace` 单，
**只出单、不落库**），但**面板没有对应路由**。所以加了一条 `POST /propose`，handler 直接调
**同一个** service 方法：

```
搜索页 → 展开一行 → 改 → 独立窗口（textarea + footer 送审/取消）
        → POST /propose {id, text}
        → proposeKeeperReplace() 建单（state: open）
        → 「待办 → 等你确认」里出现
        → 过审 → reviewKeeperPlan() → 删旧录新
```

**口径仍然只有一条改库入口**（`reviewKeeperPlan`）：面板这一步只"提出"，不"落库"。窗口里那个按钮
刻意叫 **「送审」** 而不是「保存」—— 叫"保存"会被读成"已经改好了"。窗口里还写着一句
「送审不会立刻改库：正文进待审区，过审后才「删旧录新」」。

### ② `删` = 软删（可恢复）

走已有的 `POST /forget`（`hard` 缺省 = 软删：行与 `history` 都留着、向量顺手清掉），
带二次确认（`删除这条记忆？软删：整行与历史都保留，可从库里恢复。`），删完自动重搜一次让列表如实刷新。

### ③ 两个动作**只在展开后出现**

不把它做成每行常驻按钮：一页 20 行 × 2 个按钮 = 40 个控件，和用户"每个控件不多余"的口径冲突。
展开后屏幕上一次只有一条记忆，两个按钮就在全文下面。

### ④ 审阅区「一键通过」

「等你确认」那块右上角一个按钮，语义 = 把**当前所有**待确认项一次过掉：每张变更单按方案落库 +
每个批次确认入库。三条口径：**逐条串行**（不并发打宿主）、**先二次确认**（`通过全部 3 项？
2 张变更单按方案落库、1 个批次确认入库 —— 这一步会真的改库`）、**失败如实报数**（`通过 N 项，
M 项失败`）。按钮只在那块真有东西时出现（空了整块连按钮一起不画）。

### ⑤ 顺带：路由条数

`test/panel.test.js` 里有一条**精确条数**断言（`routes.length === 33`）与 `panel.js` 文件头的
契约注释（`33 条注册、覆盖 35 个端点`），加路由就得同时改 —— 已同步成 **34 / 36**（README 里那句
"29 条注册 / 31 个端点"本来就过期了，一并改成实测值）。同文件的路由冒烟测试用的是假 service，
所以还要给假 service 补一个 `proposeKeeperReplace`（否则新路由在冒烟里被当成"该能力待接线"而失败）。

**自证（实际输出）**：`node --check` 四个文件 exit 0；`tools/check-client.mjs` **108/108**
（新增 6 条：搜索页展开才有动作 / 窗口三件套 / 按钮叫「送审」不叫「保存」/ 一键通过存在 /
没有待确认时不画 / 有 onClick）；`test/panel.test.js` **22/22**；全量 **292/292 pass、fail 0**；
死键提示 **0**。

**如实边界**：`一键通过` 是**顺序执行**的，项多时（比如 20 张单）会一条条来、期间按钮禁用但**没有进度条**
—— 现在待确认项通常个位数，没有为它加进度；真到几十项再加。另外 `改` / `删` 都只作用于**单条**，
批量改记忆仍然走仓管那套（`run` → 出单 → 审）。

---

## 2026-10-07 · 待审区前后对比更显眼 + 仓管单组出错改走「待接手记忆」

**用户原话**：「让待审区的『改动前』『改动后』更显眼，便于审阅。」＋「仓管整理记忆时如果对某块记忆
出现报错 让仓管跳过这块记忆 并将这块待整理的记忆挂到"待接手记忆" 并让本地LLM模型接手继续整理」。

### ① 前后对比：两个灰字标签 → 两个带色条的框

改前（`planDetail`）：

```
<span class="dshm-faint">改动前</span>
<p class="dshm-item-text">…旧正文…</p>
<span class="dshm-faint">改动后</span>
<p class="dshm-item-text">…新正文…</p>
```

两处问题：**标签与正文同色同字号**（扫一眼分不清哪块是旧的），**两块之间没有任何视觉分界**
（`merge` / `split` 多项时更像一坨）。改后：

| | 容器 | 左边框 | 标签 | 正文 |
|---|---|---|---|---|
| 改动前 | `.dshm-diff-part.is-before`（`bg-base` + 圆角 + 边框，"内嵌"感） | `3px --dsw-alias-border-l2` | `.dshm-diff-label.is-before` 13px 强档 + 次要色 | 次要色（压暗 = 旧的） |
| 改动后 | `.dshm-diff-part.is-after` | `3px --dsw-alias-state-success-primary` | `.dshm-diff-label.is-after` 13px 强档 + 成功色 | 主色（正常亮度 = 新的） |

- 标签带条数：`改动前 2 条` / `改动后 3 块`（单项不加 —— 「改动前 1 条」是噪声）；
- 删除项（`after` 空）那句「这一项没有『改动后』正文：它就是删除」改成**警示色** `.dshm-diff-empty`
  （原来是最淡的 `dshm-faint`，等于把最关键的信息藏起来）；
- 只读主题 token、不写死颜色；标签字号走**已在平台包里核对过**的 `--dsw-font-xs-strong-13-*`
  （白名单同步加进 `tools/check-client.mjs`，编名字不会报错、只会静默失效）。

### ② 单组失败：四个失败口统一走 `handOffGroup()`

改前：四个失败口各自 `job.failed += 1; tail.push('组 N：失败（…）'); continue;` —— **这一组连同它
花掉的采样机会与 tidy 计分一起消失**，面板上只剩一行「失败」，人无从下手。改后：

```
组 N：失败（<原文>）                       ← 原文照旧进 tail / lastError
组 N：已挂到待接手记忆（第 A 次）            ← 写 keeper_handoffs；同一组复用那一行、attempts 累加
组 N：<接手模型标签> 接手 → M 条操作         ← 接手成功：照常建单，takenOver += 1（failed 不算）
组 N：<接手模型标签> 接手也失败（…）→ 留在待接手记忆
组 N：没有可接手的模型（<原因>）→ 留在待接手记忆
```

**接手顺序**（`resolveTakeoverClient()`）：

1. **本地 / 局域网仓管档案** —— `configured` 且端点按 `isLocalEndpoint()` 判为 `localhost`/`127.x`/
   `::1`/私有网段/`.local`，且 `provider|model|endpoint` 不等于刚失败的那个。**按地址判、不按档案名判**：
   名字是人随手起的（叫「局域网-ollama」也可以填公网地址），而"接手"的要点正是别把整块记忆送出内网。
   逐个档案 `try/catch`：某一个自己配歪了（取不到密钥 / 模型为空）**不挡住后面的候选**；
2. **宿主模型**（`ctx.llm`，与抽取 / 冲突判定同一条通道）—— 标签写成 `宿主模型 / <model>`，
   **绝不冒充本地模型**；
3. 两条都拿不到 → 如实写「没有可接手的模型（原因）→ 留在待接手记忆」。

**接手成功照样只出单**：`store.createKeeperPlan({runId, seedId, memberIds, ops})`，`runId` 沿用原来那一轮
（面板仍把它归到同一轮流水里），接手的模型与单 id 写回 `keeper_handoffs.taker` / `plan_id`。
**口径没变：接手也不改记忆正文一个字符。**

### ③ 存储：`keeper_handoffs`（schema v5，纯新建表）

```sql
CREATE TABLE IF NOT EXISTS keeper_handoffs(
  id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  state TEXT NOT NULL, seed_id TEXT, member_ids TEXT NOT NULL, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, taker TEXT, plan_id TEXT
);
```

- `member_ids` **只存 id**：正文的唯一源头仍是 `memories`，复制一份就等于两份真相（面板要预览时
  由 `listHandoffs()` 回库取，最多 3 条、每条截 80 字）；
- **同一组（`seed_id` 相同）的 `open` 行复用**：反复失败只累加 `attempts`、刷新 `error`，
  不插新行 —— 否则一轮轮跑下来这张表会无界增长；已经 `taken` / `dropped` 的行不参与复用
  （下次再失败重新挂一行）；
- `state`：`open` / `taken` / `dropped`（清掉是软状态，**行不删** —— 痕迹不可抹）；
- 因为 DDL 全是 `IF NOT EXISTS`，v5 是**纯新建表、没有迁移函数**；`SCHEMA_VERSION` 4 → 5
  （`test/db.test.js` 有两条断言同步更新）。

**真库迁移彩排**（复制线上 `memory.db` 到工作区打开一次，不是我"估计"的）：schema_version 4→5、
`keeper_handoffs` 建出、**1210 条记忆 / 34 条软删 / 1186 条向量 / 33 张变更单一字不动**、
`PRAGMA integrity_check = ok`。

### ④ 面板与工具

- 面板「待办」新增**「待接手记忆」**一块（在「等你确认」下面、「一轮流水」上面）：一组一行 =
  失败原因（警示色）+ `N 条记忆` + `试过 N 次` + 时间 + 最多 3 条成员预览；行上 `接手` / `清掉`；
  **队列空时整块不画**，超过 8 组只铺 8 行 + 一行「还有 N 项」（不把一轮流水挤出屏幕）；
- 新路由 `GET /handoffs`（默认 `state=open`，可显式给 `taken` / `dropped`）、
  `POST /handoff-takeover`、`POST /handoff-drop` → 路由表 **37 条注册 / 39 个端点**；
- 工具 `memory_keeper` 加三个动作 `handoffs` / `takeover` / `drop-handoff`（与面板同一对 service 方法，
  免得「面板能做、agent 不能做」）；
- 跑一轮时面板多一格 `待接手 N 组 · 接手回来 M 组`（只在 >0 时显示）；
- **读不到队列时不装作没有**：`/handoffs` 失败（宿主半没重载时会 404）画一个错误框 + `重试`，
  否则人只会看到"这一块不存在"，而分不清是"队列是空的"还是"路由没接上"。

### ⑤ 我自己踩到的两处

1. **改测试时把整行 `test(...)` 头删掉了**：我用「插入到哪里」做锚点做替换，把
   `test('memory_keeper 工具：run / grind / digest …', async () => {` 这一行连同锚点一起换掉了，
   剩下的函数体成了孤儿语句 —— `node --check` 立刻报错，补回那一行才对。
   **教训**：插入型编辑的 `old_string` 必须**原样包含**、`new_string` 要以同样的内容结尾。
2. **`updateHandoff` 的 `null` = 保持原值**：这条语义和 `updateKeeperPlan` 一致，所以我**不能用
   `error: null` 去清空原因**。接手成功时就没清（那一行已经 `taken`，面板只显示 `open`，留着反而是痕迹）。
   写进方法文档，免得下一个人以为 `null` 是"清空"。

**自证（实际输出）**：`node --check` 六个文件 exit 0；`tools/check-client.mjs` **120/120**
（新增 12 条：前后两个色条框 / 标签 13px 强档且前后不同色 / 条数标签 / 单项不加条数 / 删除项警示色 /
浅渲染带待接手记忆不抛错 / 待接手块画出 / 两个动作 / 空队列不画 / 只铺 8 行 / 两按钮有 onClick /
读不到队列时画错误框与重试）；
全量 **300/300 pass、fail 0**（`test/db.test.js` 34 例、`test/keeper.test.js` 76 例、
`test/panel.test.js` 24 例）；死键提示 **0**；无 BOM、U+FFFD 0 处。

**如实边界**：① 没有配本地档案时接手会落到**宿主模型**（那一组记忆会发出去）—— 想"数据不出内网"
必须自己配一个局域网 / 本机档案；② 每组失败**多打一次模型**（本地模型慢时整轮更久）；
③ 面板「接手」是**逐条串行、没有进度条**（队列通常个位数条）；④ 一条 handoff 涉及的记忆**全被删**
时点「接手」会把它自动标成 `dropped`（否则永远卡在队列里，谁也接不了）；⑤ 这一轮**没有**做
"整轮失败"的接手（`job.error` 那条路照旧只记错误）。

---

## 2026-10-07 · 删除必须先说服人 + 仓管碰不到删除 + 待审区待删记忆标红

**用户原话**：「仓管对整理记忆提出『删除』时必须附带理由 解释为什么认为要删除。」＋「仓管禁止触碰删除
功能本身。」＋「待审区中定为删除的记忆需要标红。」（另：暂时不配本地模型 —— 与代码无关，
所以"没有本地档案就落到宿主模型"这条兜底保持不动。）

### ① 三条要求其实是一条链：模型要说得出理由 → 系统才允许删 → 人在待审区一眼看见

| 层 | 落点 | 具体行为 |
|---|---|---|
| 提示词 | `PLAN_PROMPT` 的 `drop` 那一项 | `reason` 从可选变硬要求（要写到"能说服人"），并写明「**没有理由的删除，系统一律不会应用**」 |
| 生成侧 | `normalizePlanOps()` | 没写理由的 `drop` **照旧出这条 op**，但打 `reasonMissing: true` + 往 `warnings` 写 `NO_REASON_WARNING` |
| 应用侧 | `reviewKeeperPlan()` 的 `drop` 分支 | 见到 `reasonMissing` / `reason` 空白 → **跳过**（勾了也跳过），`noReason` 单独计数 |
| 留痕 | `softDrop()` 的 note | `keeper:drop（<理由>）` —— 事后查得到"当时凭什么删的" |
| 面板 | `planDetail()` + `todoApplyNoReason` | 待删那一条整块标红；每条 op 先显示「理由」；被跳过的删除如实提示 |

**为什么不把没理由的 drop 直接丢掉**：那会变成"模型想删什么，人看不到" —— 悄悄丢才是真的危险。
现在的口径是"**看得到、但谁都应用不了**"，配上面板标红，正好是用户要的三件事。

**为什么应用侧同时认标记与 `reason` 原文**：面板手改过的单、以及本功能上线前就存在的旧单，
里面没有 `reasonMissing` 这个字段；只认标记会漏，只认原文则拿不到"这条已经标过"的直接证据。

### ② 「仓管禁止触碰删除功能本身」是怎么**可验证**的

光靠一句"仓管只出单"是承诺，不是保证。所以测试里给 store 装了**监视器**：
`softDeleteMemory` / `hardDeleteMemory` / `deleteVector` / `restoreMemory` 四个方法全部包一层记录，
然后跑一轮「第一组失败 → 挂待接手 → 宿主模型接手出单（一张 merge + 一张 drop）」：

- 生成侧（run + 接手）断言 `touched` **为空数组** —— 一次删除调用都没有；
- 接着 `reviewKeeperPlan()`（人审）断言 `touched` **非空**，且正好是 `softDeleteMemory(b)`（merge 软删被并的那条）
  与 `softDeleteMemory(c)`（drop），`a` 保留并换上新正文。

**第二条断言（非空）是必需的**：只断言"空"的话，一个坏掉的监视器也能让它通过 —— 那是**空转的假闸**。

### ③ 待审区标红：认结构化事实，不认文案

`op.type === 'drop'` 是唯一判据（**绝不去猜 `warnings` 里的中文** —— 那种耦合一改字就失效）。CSS 用
后代选择器一次覆盖：`.dshm-op.is-drop` 的边框、`.dshm-op-line`（操作行）、`.dshm-diff-label`、
`.dshm-diff-text`（改动前正文）、`.dshm-warn-list li`（"没写理由"那条警告）。
另外把上一轮那个 `.dshm-diff-empty`（「这一项没有『改动后』正文：它就是删除」）从 **warn 色改成 error 色** ——
它本来就是"要删"这件事的说明。

**折叠行只在第一项是 drop 时标红**：摘要说的是"第一项做了什么 + 那条正文的开头"，第一项是 merge 却整行
染红，读的人会把合并也当成删除。混了删除的单，展开后在那一项上标红。这是本次**主动收窄**的地方
（宁可少染，不要误染），已写进自检。

### ④ 面板提示语：不能让「已通过」盖住"这一步其实没改库"

`reviewPlan()` 现在读返回值里的 `noReason`：`>0` 时提示「已通过；有 N 条删除没写理由，已跳过
（记忆一个字都没动）」，否则才是原来那句「已通过这张单子」。

### ⑤ 我这次差点写出的两个假绿

1. **`.sort()` 只排了实参**：断言 `[softDelete(b), softDelete(c)].sort()` 时，左侧排了、右侧没排，
   于是"实际 [x,y] / 期望 [y,x]"报红 —— 看起来像功能坏了，其实只是断言自己没对齐。两侧都 `.sort()`。
2. **`listHistory(id)` 不可能是空的**：`addMemory()` 自己就会写一条 `add` 历史，我一开始断言
   "一条 history 都不该写" → 必红。改成断言**没有 `keeper:` 开头的痕迹**才是真正的口径。

**自证（实际输出）**：`node --check` 六个文件 exit 0；`tools/check-client.mjs` **124/124**
（新增 4 条：待删整块标红 + 只有 drop 那条带 `is-drop` / 删除项的「它就是删除」走 error 色 /
每条 op 画「理由」且没理由不画空行 / 折叠行只在第一项是删除时标红）；
全量 **304/304 pass、fail 0**（`test/keeper.test.js` 80 例，新增 4 条：提示词硬要求 /
`normalizePlanOps` 的 `reasonMissing` 三写法 / 没理由的 drop 勾了也不应用 / 生成侧零删除调用 + 人审才删）；
死键提示 **0**；无 BOM、U+FFFD 0 处。

**如实边界**：① 只拦"空"，**不判理由质量** —— 模型写「没用」也能过，质量最终由人审看；
② `memory_keeper {action:'propose-drop'}` 是**人 / agent 的入口**，它自带默认理由「手工提出的删除」，
不受"必须解释"这条约束（那是**仓管**的口径）；③ `revertKeeper()` 仍会**真删**研磨产物
（那是回滚"仓管产物"的功能，不是删用户的记忆），本次没动它 —— 如果用户认为这也算"仓管碰删除"，
下一轮再把 revert 一并收进"只软删"。

---

## 2026-10-07 · 仓管单开一页：看得见正在处理哪些记忆 + 整理完的单在这一页审

**用户原话**：「为仓管单开一个页面 展示它正在处理的记忆是哪些 并且仓管整理完成的记忆也在该页面审阅」。

### ① 两条线物理分家（页签 3 → 4）

| 页签 | 管什么 | 落点 |
|---|---|---|
| **待办** | **抽取待审区**（新事实入库）：批次 → `确认入库` / `驳回`，卡片右上 `一键通过`（批次） | 只拉 `/pending`、`/batch`、`POST /review` |
| **仓管**（新） | **已有记忆的二次加工**：待审变更单（`通过` / `驳回` / `一键通过`）+ 待接手记忆（`接手` / `清掉`）+ 跑一轮 + 只读流水 | `/keeper-plans`、`/keeper`、`/keeper-run`、`/keeper-plan-review`、`/handoffs`、`/handoff-*` |

- 客户端里**两个组件真的分开**：`TodoTab` 只剩批次（自己的 state：batches / open / detail / pending / notice / actionError / nonce），
  `KeeperTab` 拿 `plans / handoffs / keeperJob / runBusy / open / pending / notice / actionError / nonce / progressAt`；
- 「一键通过」原来是一条**跨两条线**的动作（一次过掉变更单 + 批次），现在**两页各一个**，各管各的线；
  二次确认文案也分开：`keeperApproveAllConfirm`（按方案落库）与 `todoBatchApproveAllConfirm`（确认入库）——
  原来那句 `todoApproveAllConfirm` 里 `{plans}` / `{batches}` 的占位在只剩一条线时会渲染成「0 个批次确认入库」这种残句，所以直接删掉换两条；
- 自检加了一条**分家断言**：仓管页不含 `确认入库`，待办页不含 `通过 / 驳回` 与 `让仓管看一遍` —— 防止将来"顺手又塞回去"。

### ② 「正在处理的记忆是哪些」：宿主加 `job.current`

原来面板只有 tail 里那句 `组 5：开始（6 条记忆，种子 abcdef12）` —— 知道"有条数、有个种子"，**不知道是哪几条**。
现在 `runKeeperRun()` 在每组开始时把成员摊开：

```js
job.current = {
  groupNo, seedId, startedAt, count,
  members: members.map((m) => ({ id: m.id, text: clipText(m.text, 200) })),   // 每条截 200 字
};
```

- `publicKeeper()` 多一个 `current` 字段，随 `/keeper` 的 2 秒轮询送到面板；
- 面板在进度条下面画：`正在处理的记忆（第 N 组 · M 条）` + `种子 xxxxxxxx` + 这一组每条正文；
  **种子那条用主色**（`members[0]` 就是种子）、同组其余条用次要色；
- **组与组之间**（`current === null`）画「正在准备下一组…」—— 空着会像卡死；
- **`try/finally` 兜住整组**：这一组的 body 有三种退出方式（正常出单 / `continue` 跳过 / 抛错被外层兜住），
  只在"正常结束"清 `current` 就一定会漏。所以整段包在 `try { … } finally { job.current = null; }` 里，
  三条路都清干净（**另有专门用例**：非超时失败 → 挂待接手这条路上 `job.current` 也必须是 `null`）。

**为什么每条截 200 字**：这一块是"边跑边看"，要能认出"这一条在说什么"；一条组最多 `perGroup + 1`
（默认 6 条），整包 1–2 KB，2 秒一次完全扛得住。截断也有用例钉住（540 字的记忆 → 面板只拿到 201 字含省略号）。

### ③ 自检工具链跟着改

`tools/check-client.mjs` 里原来的 `TodoTab` 驱动被拆成两个：
`renderKeeperTab(plans, handoffs, keeperJob, open, progressAt)` 与 `renderBatches(batches, open, detail)`，
状态顺序按新组件重排（仓管 10 个 state、待办 7 个）；旧签名 `renderTodoOpen(...)` 保留成一个薄包装
（历史断言多，全部重写反而更容易出错），但它现在只驱动仓管页。同时：
- 分页断言 `3 个` → **4 个**，并钉住顺序 `todo,keeper,search,settings`；
- 新增 4 条仓管页断言（正在处理的记忆 / 种子主色 / 「正在准备下一组…」/ 没在跑时不画进度条与 current）+ 1 条分家断言 + 1 条待办页自己的一键通过。

### ④ 我这次的两个手滑

1. **名字撞车**：新写的页渲染器我起名 `renderKeeper`，而自检里早有一个 `renderKeeper(items, active, form)`
   （设置页「仓管模型」块用的）→ `SyntaxError: Identifier 'renderKeeper' has already been declared`。
   改名 `renderKeeperTab`。
2. **新测试假设了成员顺序**：我断言 `members` 的正文按录入顺序排列，可是种子是**随机抽**的
   （`sampleSize: 1`），种子是谁成员 `[0]` 就是谁 → 单独跑那个文件时它恰好抽中第一条，全量跑时抽中别的就红。
   改成**集合断言**（`sort()` 后 deepEqual）+ 只钉不变量（`members[0].id === seedId`、`count === 3`）。
   教训：**带随机采样的用例不许断言顺序**。

**自证（实际输出）**：`node --check` 三个文件 exit 0；`tools/check-client.mjs` **130/130**
（新增 6 条：分家 / 正在处理的记忆 / 种子主色 / 准备下一组 / 没在跑时不画 / 待办页自己的一键通过）；
全量 **307/307 pass、fail 0**（`test/keeper.test.js` 83 例，新增 3 条：跑的时候看得见 `current` 且
结束后清空 / 失败路径也清空 / 200 字截断）；死键提示 **0**；无 BOM、U+FFFD 0 处。

**如实边界**：① `job.current` **只在内存里**（进程重启即无，`/keeper` 回 `running:false` + `current:null`），
不写库、不做历史 —— 上一轮"当时在处理哪几条"只有 tail 日志能追；② 这一块是**整组开跑时的快照**
（成员在调模型之前就定好了，组内不会变）；③ 面板一次只显示**当前**这一组，想看"哪一轮处理过哪些组"
仍然只有流水里的单与 tail（**没有**把每轮的成员落库 —— 需要的话下轮加一张"轮次成员"表也不难，但要用户点头）。

---

## 2026-10-07 · 「转手」+ 副审阅区重头整理（含 embedding 召回）

**用户原话**：「为所有待审记忆改动新增按钮『转手』，这会将对应记忆库中记忆呈现至副审阅区（原名为
『待接手区』），由本地 LLM 模型重头对其进行记忆整理（包括使用 embedding 快速拉取相关记忆等完成流程）」。

### ① 改名：待接手记忆 → 副审阅区

面板标题、`tail` 行（`组 N：已挂到副审阅区（第 k 次）` / `组 N：… → 留在副审阅区`）、工具文案、
store / service 的报错文本（`updateHandoff：副审阅区项不存在…`）全部跟着改。
**库表名仍是 `keeper_handoffs`、字段一个没动** —— 改名是显示层的，不是 schema 的；历史段落（本文件里
早几轮那些「待接手记忆」的记录）**保持原样**，它们是当时的事实。

### ② 「转手」：待审变更单上的第三个动作

```
待审单（state: open）
  ├─ 通过  → reviewKeeperPlan()：按方案落库（唯一改库入口）
  ├─ 驳回  → reviewKeeperPlan({reject:true})：只标记，不碰记忆
  └─ 转手  → handOffPlan()：① 原单停在 handed   ② 各 op 的 targets 挂进副审阅区
                            ③ **当场**让接手模型重头整理 → 新单回「等你确认」
```

- **为什么不复用 `rejected`**：驳回是"人否掉了这个方案"，转手是"这个方案我不要，但记忆要**重做**"。
  两者后来发生的事完全不同（驳回之后什么都没有，转手之后有一张新单在等着审），所以加了终态
  `handed`（`keeper_plans.state` 的新取值，**零存储改动**），面板标签 **「已转手」**。
- **顺序不能反**：先挂副审阅区、再标记原单、最后才打模型。反过来的话，模型调用一旦抛错就会出现
  「原单已 handed、副审阅区却没有那一行」—— 那一组记忆**两头都找不到**。所以中途失败会尽量把
  已成立的步骤留住（挂队列失败 → **不动原单**，宁可整体失败）。
- **失败也停在 `handed`**：不能退回待审区 —— 否则同一张单会在"转手失败后又被审一遍"，人无从判断。

### ③ 「重头」= 真的从头跑一遍（embedding 召回是重点）

原 `takeOverGroup()` 是"把存下来的成员直接喂给模型"。用户这次明确要求「包括使用 embedding 快速拉取
相关记忆等完成流程」，所以换成 `reorganizeMemories()`：

```js
种子（活着的） → searchText(种子[0].text, limit=perGroup)  ← 用 embedding 召回相关记忆
               → 整组 = 全部种子 ∪ 召回的邻居（去重、排除软删）
               → buildPlanRequest() → 接手模型 → normalizePlanOps() → createKeeperPlan()
```

- **三个入口共用它**：run 里某组失败后的当场接手、副审阅区那一行的 `接手`、待审单的 `转手`；
- 召回的**主种子取第一条**（与跑一轮"一组一个种子"同形）；多目标（merge / drop 多 targets）时全部种子进组；
- 召回失败（`searchText` 抛错）**不致命**：退化成"只用种子"，`recallError` 随结果如实报；
- 整理完把副审阅区那一行的成员换成**真正整理的那一组**（种子 ∪ 召回）—— 面板「N 条记忆」说的才是事实。
  这条要求 `updateHandoff()` 支持 `memberIds` 补丁（**不再绕过 store 直接 `UPDATE`**：我第一版就是
  用 `store.db.prepare(...)` 直接写的，那违反"库只能经 store"的分层，已改成 store 方法 + 断言）。

### ④ 我这次的两个手滑

1. **同名常量/函数撞车**（上一轮刚犯过一次）：`takeOverGroup` 改名 `reorganizeMemories` 后，
   忘了把 `handOffGroup` 里的调用点一起改 —— 这次是**改全了**的（`grep takeOverGroup` 归零）；
2. **`updateHandoff` 的 `memberIds` 校验**：第一版对 `memberIds: 'x'` 会静默 `JSON.stringify('x')`
   写进列里（`"x"`，读回来 `['x']` 都不对）。加了 `Array.isArray` 断言 + store 用例。

**自证（实际输出）**：`node --check` 五个文件 exit 0；`tools/check-client.mjs` **134/134**
（新增 3 条：待审行多一个「转手」/ 已处理的单不给转手 / `handed` 的标签是「已转手」而非「已驳回」）；
全量 **311/311 pass、fail 0**（`test/keeper.test.js` 86 例，新增 3 条：副审阅区重做会用 embedding 召回 /
转手全流程（原单 handed + 队列行 + 新单回待审）/ 转手失败也停在 handed；`test/panel.test.js` 25 例，
新增 `/handoff-plan` 的路由用例；`test/store.test.js` 补 `updateHandoff({memberIds})` 与非法值断言）；
死键提示 **0**；无 BOM、U+FFFD 0 处。**本轮无 schema 变更**（`handed` 是既有列的新取值）。

**如实边界**：① 转手会**当场打模型**（1 次调用，可能几十秒；按钮期间禁用、**无进度条**）；
② 重头整理召回到的邻居**取决于当前检索结果**，可能与原单那一组不同（这是"重头"的应有之义，但要知道）；
③ 原单停在 `handed` 后**不能再转手 / 不能再审**（要再做得去副审阅区点 `接手`）；
④ 没有本地档案时接手方是**宿主模型** —— 用户明确说「由本地 LLM 模型」，但目前**没有配本地档案**，
   所以现在点转手实际用的是宿主模型（标签会如实写「宿主模型」）；配好局域网 / 本机档案后自动优先用它；
⑤ 「所有待审记忆改动」按 **keeper 变更单** 理解并实现：抽取待审区（新事实入库）那些**批次**没有
   "记忆库里的对应记忆"可转手，所以那一页没加这个按钮（批次仍是 `确认入库` / `驳回`）。

---

## 2026-10-07 · 接手模型「由我启动时决定」：转手只入队 + 选模型的窗口

**用户原话**：「转手后进入副审阅区 最终由什么模型接手由我启动时决定。」

### ① 先纠正上一轮的两处

1. **转手不该自动开跑**。上一轮我把「转手」实现成"入队 + 当场打模型"（因为再上一条他说「由本地 LLM 模型
   重头对其进行记忆整理」）。这一条把口径钉正：**转手 = 只入队**，`handOffPlan()` **一个字都不打模型、
   也不建单**。所以不会出现"我还没选模型，它已经用别人的模型跑完了"。
   - 代价：转手之后**没有新单立刻出现**，得去副审阅区点「接手」；面板提示语照实说：
     「已挂进副审阅区 —— 在那一行点『接手』、选好模型再开跑」。
   - 测试用**计数器**钉死这一点：`handOffPlan()` 期间 `createKeeperClient` / `createLlmClient` 的
     `chat` 一次都没被调用（不是"看结果猜"，是直接数调用次数）。
2. **区域名又变了一次**：上一轮按他的话改成「副整理区」，这一轮他写的是「**副审阅区**」。
   按**最新说法**统一成「副审阅区」，并在这条里写明中间叫过一轮「副整理区」——
   同一个地方三个名字（待接手记忆 → 副整理区 → 副审阅区）如果不写清楚，下一个人翻历史会以为改错了。
   （**如果他要的其实是「副整理区」，改回来只是文案替换** —— 已经问在报告里。）

### ② 接手模型由调用方指定（三层透传）

```
窗口里选中一个模型（或跑一轮前在下拉里选好）
  → POST /handoff-takeover {id, model}      /  POST /keeper-run {taker}
  → parseTakerChoice(model)  ← 空/'auto' → undefined（自动）；'host' → {kind:'host'}；其它 → {kind:'profile',name}
  → resolveTakeoverClient(failed, choice)
       显式给了就**只认它**：档案 → 用那个档案（没配好如实报错）；host → 宿主模型
       不给才走自动顺序（本地 / 局域网档案优先 → 宿主）
```

- `reorganizeMemories({..., taker})` 把选择透传给解析器；三个入口（run 里的当场接手、副审阅区的 `接手`）都吃它；
- `startKeeperRun({taker})` 把选择**记在 job 上**（`publicKeeper().taker`），跑一轮期间某组失败就用它；
  非法 taker（超长串）在**启动时**就拦下，不让它跑一半才炸；
- 面板：副审阅区那一行的按钮从「重试接手」改成 **「接手」**，点开一个 `Modal`（一行一个候选 + 圆点，
  当前选中带 `is-active`），footer 只有 `接手` / `取消`；候选 = 自动 + **已配好**的档案 + 宿主模型
  （宿主模型名从 `/keeper` 新增的 `hostModel` 字段来）；
- 跑一轮那块加了一个 `接手模型` 下拉，**跑着的时候禁用**（改了不影响正在跑的这一轮，免得误会）。

### ③ 我这次踩到的两个「自检假绿」

1. **假 CSS 类名写进断言**：我把「当前选中的候选」写成 `className === 'dshm-dot'` 去数候选数，
   结果选中的那个是 `'dshm-dot is-active'` → 数出来 2 个（应该是 3）。改成 `startsWith('dshm-dot')`。
2. **读错了假 React 的 children**：自检里的 `select` 候选，我先写 `flattenTree(select?.props?.children)` ——
   假 `createElement` 把 children 挂在**节点**上、不在 `props` 里，于是数出 0 个候选项，
   看着像"下拉是空的"。改成 `flattenTree(select).filter(n => n.type === 'option')`。
   **教训**：自检里的假 React 是"近似"，凡是通过 `props.children` 取子节点的地方都要按假实现来写。

**自证（实际输出）**：`node --check` 六个文件 exit 0；`tools/check-client.mjs` **138/138**
（新增 4 条：`接手` 打开的是选模型窗口 / 候选圆点按选中态 / 跑一轮那块的下拉与禁用 / 转手文案不是"已经整理好了"）；
全量 **312/312 pass、fail 0**（`test/keeper.test.js` 87 例：转手零模型调用、模型可指定（档案 / host / 不存在 /
没配好）、run 的 taker 真生效；`test/panel.test.js` 跟着改 `/keeper-run` 与 `/handoff-takeover` 的透传断言）；
死键提示 **0**；无 BOM、U+FFFD 0 处。**本轮无 schema 变更、无新路由**（`model` / `taker` 走的是既有路由的 body）。

**如实边界**：① 「自动」在**没有本地档案**时仍会落到宿主模型（不想这样就在窗口里显式选一个）；
② 选定之后**真正开跑时**才打模型（可能几十秒、无进度条）；③ 窗口里选的模型**只在本次面板会话内记住**
（没落库、刷新页面回落「自动」）；④ 自动接手（run 里某组失败）用的 taker 是**启动那一轮**时选的，
跑起来之后改下拉**不影响**这一轮 —— 这正是"启动时决定"的字面含义，但要知道它不是实时生效的。

## 2026-10-07 · 副审阅区收成一行卡片按钮 + 「启动仓管」从「已处理」里拿出来

**用户原话（在实时截图上批注）**：「这个区变成卡片按钮 不点击就不要一直展示」（箭头指向
「副审阅区 2 组」那一整块）、「按钮拿出来，并改为"启动仓管"」（箭头指向「已处理」卡片右上角
那个跑一轮的按钮）。

### ① 副审阅区：默认收起成一行卡片按钮

- 收起态 = **一整行可点**的卡片按钮：`▸ 副审阅区 N 组`（用卡片标题那档字号）+ 右侧一句
  「点开选模型接手」。**组数照旧写着** —— 收起的只是**成员预览与 `接手` / `清掉`**，不是信息本身。
- 机制不新造：`open` 里多一个键 `HANDOFF_OPEN_KEY = 'handoff'`（没有这个键 = 收起），
  与「已处理」按轮次折叠（`run:<id>`）**同一套**。
- **转手成功后自动展开**：刚挂进副审阅区的东西不该藏在收起态里（`handOffPlan` 成功 →
  `setOpen({...open, handoff: true})`）。
- 空队列仍然**整块不画**（连那一行都没有）——「没东西就不占地方」的口径没变。

### ② 「启动仓管」独立成一条控制带

- 原来这个按钮是「已处理」卡片的 `action`（右上角），而「接手模型」下拉 / 进度条 / 逐组日志
  都在那张卡片的**正文**里 —— 等于把"开一轮"这个主动作挂在**历史**卡片上。
- 现在拆成两张卡：`h('section', {className:'dshm-card'}, …)` = 控制带（`接手模型` 下拉与
  **`启动仓管`** **同一行** + 一行小字提示 + 跑时的进度 / 正在处理的记忆 / 逐组日志 / 心跳）；
  「**已处理**」卡片里**只剩流水**（自检直接断言它的子树里 0 个 `button` + `select`）。
- 控制带**不设标题**：里面没有需要被命名的内容，按钮自己就是它的名字（多一个标题只会和按钮重复）。
- 文案 `todoRun`：`让仓管看一遍` → **`启动仓管`**（en：`Ask the keeper to look` → `Start keeper`）。
- 顺带把 `notice` / `actionError`（转手 / 接手 / 清掉的结果）从「已处理」卡片正文提到**页顶**：
  那句话和那张卡片说的不是一件事。

### ③ 我这次的错：又是 TDZ（第二次）

自检里新加的「已处理卡片里没有控件」那条用了 `cardNode()` —— 它定义在文件**靠后**（1400 行附近），
而这条断言在 1080 行 → `ReferenceError: Cannot access 'cardNode' before initialization`。
**同一个坑这个项目踩过第二次**（上一轮是断言写在 `textLeaves` 定义之前）。规矩：本文件的 helper
全是 `const`，**新断言要么写在 helper 之后，要么就地 `nodes.find(...)`**。

**自证（实际输出）**：`node --check lib/client.js` exit 0；`tools/check-client.mjs` **141/141**
（+3：默认收起那一行不带成员预览与 `接手` / `清掉`、整行可点 / 点开之后成员预览与两个按钮都在且
收起提示消失 / `启动仓管` 与 `接手模型` 同一行且「已处理」子树里 0 个 button+select、全页只有一个
开跑按钮）；全量 **312/312 pass、fail 0**；死键提示 **0**。
**本轮只改客户端**（`lib/client.js` + 自检 + 文档）：**无 schema 变更、无新路由、宿主半边一个字没动**
—— 所以只要刷新页面，**不需要再重载插件**。

**如实边界**：① 收起态是**每次进面板都收起**（没落库、也没记住上次的收放）；② 收起后**看不见
"是哪几组"**，只有组数 —— 点开才有；③ 控制带仍在页面**下部**（副审阅区下面、「已处理」上面），
只是从卡片头挪进了独立卡片，**没有搬到页首**（要搬到最上面说一声）。

## 2026-10-07 · 「副仓管」独立成页 + 独立角色 · 移除「待办」页 · 「已处理」收起来

**用户原话**：「副审阅区使用独立的仓管角色 独立建立页面『副仓管』 顺便移除目前空置的『待办』页面。
『已处理』内容收起来。」

### ① 副审阅区 → 「副仓管」页 + 一个**独立的仓管角色**

- **角色是角色级的，不是每条一问**：新增 `settings.keeper.side`（与主仓管的 `keeper.active` **各存各的**），
  面板那一页顶部的下拉选一次就存库：
  - 宿主：`sideKeeperChoice()` / `setSideKeeper(model)`（`''`/`'auto'` = **删掉这个键**回落自动；
    `'host'`；否则必须是**已存在的档案名**，不存在**当场**报错，不等到点「接手」才报）；
  - 路由：`POST /keeper-side {model}`（第 39 条注册 → **39 条 / 41 个端点**）；
  - 工具：`memory_keeper {action:'side', model}`；
  - **默认语义**：`takeOverHandoff({id})` 与 `startKeeperRun({})` **省略 model / taker 时都读它**
    → 于是"某组失败时的自动接手"用的也是这个角色，跑一轮那页**不再有模型下拉**。
- **逐条选模型的弹窗删掉了**（`handoffPick*` 三个键 + 那个 `Modal`）：模型既然是角色级的，
  再弹一次就是重复提问。用户 2026-10-07 早些时候的「由我启动时决定」没有被推翻 ——
  这个选择**还在他手上**，只是从"每条一次"变成"这个角色一次"。
- 队列（原因 / `N 条记忆` / `试过 N 次` / 成员预览 + `接手` / `清掉`）**整块搬到新页**；
  独立成页之后**空队列会给一行「副仓管手上没有挂着的组」** —— 这与"同一页里没东西就不占地方"不同：
  一页空白页必须说清楚是"没有"，不是坏了。

### ② 「待办」页整页移除

- 那一页是**抽取待审区**（批次 → `确认入库`）。用户说它「空置」——**活库上 `memory_pending` 回的确实是
  `batches: []`**，所以删掉是安全的。
- 删的是**面板入口 + 组件**（`TodoTab` 约 200 行 + 只属于它的 6 个字典键：`todoBatch*`）；
  **宿主路由（`/pending`、`/batch`、`/review`）与工具（`memory_pending` / `memory_analyze` /
  `memory_review`）一个都没动**。页签从 4 个（待办 / 仓管 / 搜索 / 设置）变成
  4 个（**仓管** / 副仓管 / 搜索 / 设置），**默认页 = 仓管**。
- **代价（如实说）**：以后真跑了 `memory_extract`，待审批次**在面板上没有入口**了 ——
  只能让我（`memory_pending` / `memory_analyze` / `memory_review`）来看。要把它做回来（比如并进
  「仓管」页做一块折叠卡片）说一声。

### ③ 「已处理」收起来

- 与「副审阅区」同一套机制：`open` 里加 `DONE_OPEN_KEY = 'done'`，卡片头是一整行可点的
  `▸ 已处理` + 右侧 `N 轮`；点开才铺（点开之后**轮**还是各自默认收起，两层折叠各管各的）。
- 没有流水时**整块不画**（`runs.length === 0`）—— 原来那张空卡片写着「无」，是这一轮去掉的最后一个
  "占地方的空盒子"。

### ④ 顺手修掉一个既有 bug：工具 schema 里 `model` 定义了两遍

`memory_keeper` 的参数表里 `model` 出现了两次（`save` 用的那份在前、`takeover` 用的那份在后）——
**后者静默覆盖前者**，所以 `action=save` 的模型说明一直是错的（显示成 takeover 那句）。
两个说明合并成一条；不影响行为（都是 string），只影响 agent 读到的文档。

### ⑤ 我这次的动作方式（诚实交代）

删 `TodoTab` 那 200 行**是用一次性脚本按行号切掉的**，不是 `edit` 逐字匹配 —— 手抄 200 行
`old_string` 出错的概率比脚本高。脚本**不在文件版本守卫内**，所以切完立刻：`node --check` 三个文件、
自检、全量测试全跑一遍。边界（起止两行注释）也在脚本里断言过，找不到就直接抛错。

**自证（实际输出）**：`node --check` `lib/index.js` / `lib/client.js` / `src/host/panel.js` 全 exit 0；
`tools/check-client.mjs` **136/136**（少了「待办页」那 5 条与选模型窗口那 4 条，多了副仓管 8 条 +
「已处理收起」「仓管页没有下拉」「待办页不许复活」）；全量 **314/314 pass、fail 0**（keeper 88 例：
新增「副仓管角色」那条 —— 写入 / 名字不存在当场报错 / `takeover` 与 `run` 省略 model 都走它 /
改成 host 立刻生效 / `auto` 删键回落自动；panel 26 例：新增 `/keeper-side`）；死键 **0**。

**如实边界**：① 这一轮**宿主半变了**（新路由 + 新 setting + 默认语义）→ 必须**重载插件或重启**，
只刷新页面不够（客户端会先看到「副仓管」页，但改模型会 404）；② 抽取待审区**没有面板入口**了；
③ 「逐条选模型」这个能力**没了**（要回来得把窗口加回来）；④ 副仓管这一页的队列**永远是铺开的**
（它自己就是一页，不需要再套一层折叠）。

## 2026-10-07 · 冗余审计：删掉证明是死的，其余列清单

**用户原话**：「检查插件冗余内容」→（看过清单之后）「按你的建议执行」。

### 四轮只读扫描（方法）

1. **字典调用图**：真 `t('key')` 调用 vs 字典键；中英键差；"被调用但字典里没有"（那种会把键名直接画到界面上）；
2. **client.js 模块级标识符**引用计数（只出现一次 = 只声明没人用）；
3. **CSS 类**：先按 `className: '...'` 匹配 → **误报**（三元表达式里的类名看不见，`.dshm-current-seed` 就被误判成死的）→ 改成"整份 JSX 源码 `includes`"；
4. **面板路由 vs 客户端调用点**；**`keeperStatus()` / `publicKeeper()` 字段 vs 客户端读取**；全仓（含测试）引用计数。

### 删掉的（都验过"没人读/没人调"）

- `PAGE_SIZE = 20`（client.js，只声明没人用）；
- `.dshm-details` / `.dshm-summary`（诊断 `<details>` 早删了、CSS 留着）；
- 字典死键 `rejected`（值「批次已驳回（数据未变）。」）与 `provider`（值「提供方」）**中英各一条** + 旁边那两行"手动录入"旧注释；
- **同值键合并**：`credentialSaved`/`profileSaved`/`keeperSaved` → `saved`；`credentialFailed`/`profileSaveFailed` → `saveFailed`；`profileName` → `fieldName`。（**留了 `tabSearch`/`search` 这一对**：一个是页签名、一个是按钮，同名不同物，硬合并会把两种角色绑死。）
- `keeperStatus()` 里的 **`artifacts`**：`listKeeperArtifacts()` = **4 次全表 `LIKE` 扫**（活库实测 4.9 ms / 1436 行），而**面板一次都不读**，却在跑一轮期间**每 2 秒**被算一遍。store 那个方法**留着**（`revertKeeper()` 还在用，实测 2 处真实调用）；
- **两个没人用的旋钮** `digestMinChars` / `dedupeThreshold`：从 `keeperStatus()` **和工具 schema** 摘掉（存量档案里那两行留着不管，老档案照旧读得动）；
- `keeperStatus().openPlans` 从"读整表 + 逐张 `JSON.parse` ops"改成新的 **`store.countKeeperPlans({state})`**（`openHandoffs` 本来就是 COUNT）；
- **「待办」页那三条 HTTP 路由** `/pending`、`/batch`、`/review` + 三个 handler（页面 2026-10-07 已整页删）。能力**没动**：`memory_pending` / `memory_analyze` / `memory_review` 三个工具走同一批 service 方法。路由 **39 → 36 条注册**（端点 41 → 38），`panel.test.js` 的计数与"已知路径"表跟着改；
- **陈旧注释**：注释里「副审阅区 / 待接手记忆」统一成「副仓管」**43 处**，并修掉 4 处**说错的**（段落标题还叫"分页一：待办"、KeeperTab 的①②③结构早已变、`抽取批次的『一键通过』在待办页`、`tabItems` 文档还写旧四页签）。⚠️ **用户的原话引号一字没改** —— 批量改名一度把引号里的「副审阅区」也改了，发现后回滚 10 处（他当时说的就是「副审阅区」）。

### 自检工具的「死键」提示也修了

旧查法是 `source.includes("'key'")` —— **太宽**：这次两条真死键（`rejected` / `provider`）就是因为字面量在别处当**值**、当状态比较出现过而被漏掉。现在两条腿：**真 `t('key')` 调用** + **`*_KEY` 映射表里的值**（全文件只有 `PLAN_STATE_KEY` 一处用变量调 `t()`，所以不会误判）。

### 我**没**执行的一条（如实交代）

原建议是"至少删 7 条被取代的路由"，实际只删了 3 条。查证后发现另外 4 条**不是死的**：

- `/state`：`snapshot()` 的**唯一**入口（没有工具调它），而且**一条安全断言就挂在它上面**（「/config 与 /state 的响应里绝不出现密钥值」）—— 删了等于连那条守卫一起删；
- `/keeper-config`：`saveKeeperConfig` 的**唯一**入口（`keeper.overrides` 是活的能力，目前只能从 HTTP 写）；
- `/keeper-plan`、`/llm-test`：各有专门的测试用例。

所以"面板没有入口但保留"的路由是 **10 条**：`/state`、`/memories`、`/remember`、`/extract`、`/analyze`、
`/keeper-plan`、`/keeper-config`、`/keeper-revert`、`/backup`、`/llm-test` —— 它们是"面板不调"，
**不等于没用**（多数是工具能力的 HTTP 面）。要砍哪条说一声。

**自证（实际输出）**：`node --check` `lib/index.js` / `lib/client.js` / `src/host/panel.js` / `src/host/store.js`
全 exit 0；`tools/check-client.mjs` **136/136**（死键提示 0，且已换成严格查法）；全量 **314/314 pass、fail 0**
（`keeper.test.js` 里 8 处 `keeperStatus().artifacts.*` 断言改成 `store.listKeeperArtifacts()`，并新增
"不许再回 `artifacts` / `digestMinChars` / `dedupeThreshold`"三条防复活断言）；复核扫描：CSS 死类 **0**、
`PAGE_SIZE` 已删、status 里那三个字段都没了、`listKeeperArtifacts` 仍有 2 个真实调用者。

**如实边界**：① 面板没有入口的 10 条路由还在（上条说明）；② 存量档案里 `digestMinChars` /
`dedupeThreshold` 两行**留着没删**（只是没人读）；③ 字典里仍留 `tabSearch` / `search` 这一对同名不同物。

## 2026-10-08 · 读取侧注入：Layer 0 常驻索引 + Layer 1 按需召回

**用户原话**：「按你的默认来」——我给的三个默认是：① 「自然」按**丙**（静默索引做底，
只在"要按旧决定行事、而当前说法可能冲突"时才明说一句）；② 冻结粒度用**话题段冻结 + 热列表不受限**；
③ **现在就做最小版**（纯读、零 schema、可关）。

### 做了什么

| 层 | 挂点 | 内容 |
|---|---|---|
| Layer 0 常驻索引 | `systemPrompt.section`（order 2501） | 8 槽、`【约定】`/`【事实】` 两组、一行 ≤60 字、`[mem#xxxxxxxx]` + 归属·日期、末尾「索引只放了 N 条 / 库里共 M 条」 |
| Layer 1 按需召回 | `systemPrompt.context`（order 1000000） | 6 槽、`【刚记下】`（热列表，最多 3）+ `【相关】`（覆盖度打分） |

- **同步、零网络**：宿主只给 `(ctx) => string`，所以召回走新的 `store.searchBySubstringsSync()`
  （LIKE + JS 覆盖度打分），不打 embedding；语义检索仍留在"想起来之后"的工具路径。
- **话题段冻结**：段内 ≥3 轮、消息 ≥6 字、bigram 衔接度 < `cohesionFloor`(0.08) 才换段 → 换段才重建索引。
  依据是官方文档那条"前缀一变会全额 miss、要等公共前缀落盘"。
- **热列表**：`memory_remember` 写入后、仓管单审过之后（最多 3 条）—— 刚发生的事下一步就被引用。
- **只读**：`store.listIndexCandidatesSync()` / `searchBySubstringsSync()` 只 SELECT；单测直接钉"注入前后条数不变"。
- **可关**：`recall.enabled=false`（配置）→ 两层都返回空串。
- **可核对**：`memory_stats` 新增 `recall` 一格（本轮的 id、字节数、话题段版本、cursor、errors）+ 设置页不动。

### 相对外部评审方案，被本地数据改掉的三处

1. **日期用内容日期，不用 mtime**（`contentDate()`）：本机 1362 条的 `created_at` 全落在 10-06~07 一次批量导入，
   mtime 当新鲜度/排序是废的 —— 而且核查后确认，Claude Code 的 mtime 也只用于**过时标注**、不是排序。
2. **不复用 `memory_analyze` 做冲突标注**：它是 `createLlmClient()` + `analyzeConflicts`，**每条一次 LLM**，
   注入期用不起；改用仓管已写的 `meta.replaces` / `meta.merged`（零 LLM 的确定性"覆盖"边，待接）。
3. **整会话冻结 → 话题段冻结**：主会话已经 **100 轮**，整会话冻结会几小时看不见新记忆。

### 我自己踩的两个坑（都是单测逼出来的）

1. **ASCII 大小写 bug**：`pickTerms()` 把 ASCII 词转小写，而匹配时拿小写词去 `includes()` 原文 ——
   `reviewKeeperPlan` 这种**驼峰技术词永远匹配不上**（首版就是这么写的）。修法：匹配前把正文也转小写
   （`haystack`），显示仍用原正文。
2. **两个闸门都是拍脑袋拍错的**：
   - 首版「索引只要 ≥12 字」把 `宝宝喜欢冰美式`（7 字）这类**正牌短事实**挡在门外 → 降到 **8 字**；
   - 首版把「覆盖率 ≥0.25」当闸门，结果 12 字中文短查询会摊出 ~9 个 bigram，正确候选的覆盖率只有 **0.10**
     → 正确候选被自己丢掉。改成**命中 ≥2 个词，或一个够独特的词**（长 ≥4 且 ≤3 个候选命中）+ 覆盖率只做排序。
   教训：**中文短查询上"归一化覆盖率"不能当阈值**；它只配当排序信号。

### 缓存基线（注入前，实测）

`tools/cache-report.mjs`（新，只读）：最近 8 个会话 **命中率 99.09%**（命中 1040.05M / 未命中 9.51M，
主会话 100 轮 99.1%）。**注入后红线：不得掉出 95%**；这个脚本就是复核工具（读会话投影的
`tokenUsage.cacheReadTokens`，不改任何东西）。

**自证（实际输出）**：`node --check` `lib/index.js` / `lib/client.js` / `src/host/{recall,store,config,panel}.js` 全 exit 0；
新增 `test/recall.test.js` **17 例**；全量 **331/331 pass、fail 0**（原 314 + 17）；`check-client` **136/136**
（客户端这轮没动）；`cache-report` 跑出上面那组数字。

**如实边界**：① `context` 的落点还没在真机上确认（order=1000000 是按"尽量靠后"选的；重载后我能直接在自己
的提示词里看到它落在哪，再校）；② `cohesionFloor=0.08` 与「≥3 轮」是**拍的值**，要真跑几轮再标定；
③ 注入层**不用 embedding**（同步约束），所以同义改写/跨语种的召回弱于 `memory_search` ——
语义那条路留在工具侧；④ 索引只有 8 槽，1356 条里绝大多数永远不进索引，**这是设计不是遗漏**（索引 ≠ 全文）。

## 2026-10-08 · 上线后第一次真机核对：1 个**静默失效** + 1 处漏给子代理 + 落点定案

**用户原话**：「重启完成」。上一轮结尾我请求的正是"重载后我做三件事：看提示词里收到了什么、跑 cache-report、补去重"。

### 先确认活着的（三条硬证据）

1. **Layer 0 真的进了我的提示词**：我这轮的系统提示词里出现了 `<memory_index …>` 块，8 条 id 与
   `memory_stats.recall.engine.index.ids` **逐条对得上**（`bytes: 778`），末尾是「（索引只放了 8 条；库里共 1368 条…）」。
2. **落点定案（读宿主实现，不是猜）**：`systemPrompt.context` 注册的内容会被并进宿主自己的
   `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` 快照
   （`joinContextSections()` 用 `\n\n` 把**所有** context 段拼在一起），而该快照挂在消息尾部 →
   我的 `order: 1000000` 确实落在**动态尾部**，静态前缀不受影响。文档也写死了分工：
   section 走 `getSectionOrder(name)`、runtime-context 走 `getContextOrder(name)`；`new Error` 非有限 order 才抛。
3. **section 的 `scope` 是稳定对象，冻结真的生效**：同一话题段内两次采样，
   `index.at` **一直停在 1791421389068**（09:03:13），而 `recall.at` 前进到 `1791421633051`（09:07:17）。
   即 Layer 0 只建了一次、Layer 1 每步重算 —— 与设计完全一致（这也顺手证伪了"scope 是每步新对象"的担心）。

### 坑 1（**静默失效**，最贵的那种）：Layer 1 从来没有过查询词

- **症状**：`engine.cursor = {sessionId: null, at: 0, chars: 0}`、`sessions: 0`、`recall.ids: []`、`errors: []`
  —— 一切"正常"，只是注入块永远是空的。
- **根因**：`feedRecall` 里写成 `messageText(event)`，而宿主载荷是
  `{type:'user/message', data:{id, role, source:{kind:'user'}, content:[…]}}` —— **正文在 `event.data` 上**。
  `messageText(event)` 永远返回 `''` → `noteUserMessage(id, '')` 在 `body.trim()===''` 处早退。
- **定位依据（三个信号互锁）**：捕获那条路 `buffer.note(event)` 用的是 `messageText(event?.data)`，所以
  `capture.sessions: 1`（说明事件**确实收到了**）；同一份事件喂不进引擎（`cursor` 空）；而 `errors: []`
  说明没抛错。三点合起来只能是"取错层级拿到空串"。
- **修法**：`messageText(event?.data)`；并且把喂入**计数**暴露出来 —— `console` 不可见的东西必须有台账：
  `memory_stats.recall.feed = {fed, notHuman, foreign, disabled, noEngine, lastAt, lastChars, errors[]}`。
  以后"没注入"能一眼分成没查询词 / 被过滤 / 引擎没建起来 / 关了。

### 坑 1b（顺手补的判据）：`user/message` 是**共用信封**

同一个 `type` 底下混着：插件注入、工作区指令基线（`source.kind='agent-instructions'`）、compaction 摘要
（`{kind:'plugin', plugin:'compact'}`）、工具回灌（`kind:'tool'`）。宿主自己的渲染层就是用
`data.source.kind !== 'user'` 把它们划成 context 的。**只吃 `kind:'user'`**，否则这些正文会变成查询词。
判据取**宽**：只有**明确**标了别的来源才排除；没标来源的按人来 —— 多注一条只是尾部多一行噪音（可见可查），
少注一条是**功能静默失效**（就是上面那个坑）。两种错法代价不对称，所以往宽取。

### 坑 2（我设计时没想到）：召回块会漏进**子代理**的提示词

`systemPrompt.context` 是全局注册 → 子代理/委派会话组装提示词时也会调到同一个回调，拿到**我这边对话的
召回**（噪音 + 串台）。修法：从回调参数里取 `agent.session.header.id`，与 `cursor.sessionId` 不一致就返回空串；
**拿不到 id 时照常渲染**（同一条"不静默失效"的原则）。顺带把 `recallText(scope)` 那个**参数名与注释都是假的**
（注释说用它记"已注入过哪些"，实现里压根没用 `scope`）改成 `recallText(agentSessionId)`。

### 我自己写错的一条测试（代码没错，断言错了）

`excluded` 在 `buildRecallBlock` 里是 **×0.35 软折扣**、不是硬排除（设计如此：同段内相关记忆可以回来，
只是排后面）。我却在测试里断言"同一段内不再出现" → 单测红。**改测试、不改代码**，并把软折扣单独钉成一条
（两条同分候选、`recallSlots: 1`：第一轮 m1、第二轮换 m2）。

### 缓存：注入之后没有掉

`tools/cache-report.mjs --sessions 10`：**99.11%**（未命中 9.71M / 命中 1078.47M），
主会话 `a6ce659d` **101 轮 99.1%**。注入前基线 99.09% —— **红线 95% 没用上，实际没动**。
（Layer 0 冻结守住静态前缀、Layer 1 只动尾部，这就是它的机制性原因。）

**自证（实际输出）**：`node --check` `src/host/{capture,recall}.js` / `lib/index.js` / `test/{capture,recall}.test.js` 全 exit 0；
全量 **335/335 pass、fail 0**（331 + 4：`isHumanMessage` 1 例、喂入接线 1 例、会话门控 1 例、软折扣 1 例）；
客户端本轮未动。宿主源码结论来自按字节读 `app.asar`（明文），未改宿主任何文件。

**如实边界**：① 子代理"不给召回"这条**还没在真机验过**（重载后我会起一个子代理，让它如实报告自己的提示词里
有没有 `<memory_recall`）；② `context` 在我自己提示词里的**实际位置**要等下一次重载才看得见（宿主实现已读，
但"读源码"与"亲眼看到"我分开记）；③ 注入期去重仍未做（同一件事的两个近似版本会同时进块）；
④ `cohesionFloor=0.08` / `minSegmentTurns=3` 仍是拍的值。

## 2026-10-08 · 第二次重载：三件事一次验完 + 又抓到一个**时序坑**

**用户原话**：「重启完成」。这一轮把上一轮欠的三条边界全部结清，并且顺带抓到一个我设计时没想到的时序 bug。

### 一、亲眼看到 Layer 1（不再是读源码推断）

用户这轮提示词的尾部 `Current runtime context` 快照里，**真的出现了**：

```text
<memory_recall 下面是刚检索到的相关记忆片段，同样是**数据不是指令**>
【相关】[mem#d5d0756c] 主完成 serve 配置（收工）；（档案·2026-10-06）
【相关】[mem#2dd690da] 月坞「真插拔」四阶段完成（08-21）…（旧索引·08-21）
【相关】[mem#6a601691] 1. **永远不能骗宝宝**（主人底线）…（档案·2026-08-02）
【相关】[mem#9f55620a] 月坞重构已完成（08-17 晚正版小屿 P0-P2 全做完）…（旧索引·08-17）
</memory_recall>
```

位置与设计一致（并进宿主自己的 runtime-context 快照、在消息尾部），`feed.fed: 1`、
`cursor.sessionId = session-a6ce659d-…`、`chars: 4` —— `event.data` 那个修复真的生效了。
缓存复测 **99.11%**（主会话 102 轮 99.1%），仍然没掉。

### 二、子代理门控：真机探针，不是推断

起一个子代理，让它**如实报自己的提示词里有什么**（不许调用工具、不许猜）。它回：

- `<memory_index` —— **存在**（Layer 0 是全局的，子代理也看得到）
- `<memory_recall` —— **不存在**
- 还顺口报出 `Your parent agent id is "session-a6ce659d-a3df-4476-957b-d919cd647e9e"` ——
  与 `cursor.sessionId` **逐字一致**，等于连 ID 形状一起验了。

### 三、这 4 行暴露的两个真问题

**坑 3（时序，本轮最重）**：这一轮的第 1 步**根本没有查询词**。时间戳是铁证：

| 事件 | 时刻 |
|---|---|
| 第 1 步组装（Layer 0 与 Layer 1 同一瞬） | `09:33:46.772`（`recall.query: ""`、`ids: []`） |
| `session/event user/message` 才喂进引擎 | `09:33:46.878` |

即**宿主的 user/message 事件是在该步提示词组装之后才到插件手上的**（差 106 ms）。后果比"慢一步"更重：
一个**没有工具调用的回合只有一步** → 那个回合永远拿不到本轮的召回（而且拿到的是**上一轮**的问题，
比空着更糟）。上面那 4 行是**第 2 步**才出现的。
修法：`lastHumanMessage(session)` 直接读会话日志（`agent.session.surface.nodes` + `eventAt(seq)`，
宿主自己也是这么读的），现场那句优先、读不到才回落到事件游标；**往回最多扫 400 条**（封住成本，
也防翻出很久以前那句过期查询词）。`recall.source` 如实记账 `live` / `cursor`。

**坑 4（噪音）**：那 4 行里「永远不能骗宝宝」「主完成 serve 配置」与「重启完成」**毫不相干** ——
4 字消息摊出的 bigram 全是「完成」「重启」这类高频词，闸门（≥2 词）挡不住。
修法：`recall.minQueryChars`（默认 6）——查询词太短就**整条不注**（热列表照旧）。
真库干跑复核：「重启完成」→ `skip=short-query`、**一个字都不注**；19 字的
「副仓管用哪个模型接手，角色设定存在哪里」→ 6 行，其中 5 行切题。

### 四、注入期去重：做了，但**量化之后发现它治不了我看到的那种重复**

`dedupeFloor`（默认 0.92，比的是**模型看到的那段正文**）。实现时先踩了一个自己的坑：
起初拿**整行**比，而 `[mem#xxxxxxxx]` 标签自带 ~11 个 bigram、把分母灌水约 27% ——
算下来"同一句话只差一个句号"的两行整行 Jaccard 只有 **0.90**，用 0.92 会被整批漏掉。改成比正文。

然后**在真库上普查了一遍**（只读，全部成对比较走倒排索引，150133 个候选对）：

| 指标 | 结果 |
|---|---|
| 完全同文 | **0 组** |
| bigram Jaccard ≥ 0.92（去重阈值） | **5 对** |
| ≥ 0.80 / ≥ 0.60 / ≥ 0.40 | 6 / 14 / 71 对 |

结论要说清楚：**去重不是死代码（真有 5 对），但它抓不到我实际看到的那种重复** ——
`[mem#90dcc6e2]` 与 `[mem#9bacaa29]`（同一个「副审阅区收成一行」决定写了两遍）Jaccard 只有 **0.2 量级**，
任何文本阈值都够不着，**那是语义重复**。所以这一条的正确修法是**库级合并**
（`memory_keeper` 的 `digest` 就是偏重去重合并的），在注入期藏掉只是治标。

**自证（实际输出）**：`node --check` `src/host/{capture,recall,config}.js` / `lib/index.js` /
`test/{capture,recall,config}.test.js` 全 exit 0；全量 **339/339 pass、fail 0**（335 + 4：
`lastHumanMessage`、现场查询词与 `source` 记账、短查询闸门、去重与关得掉）；真库只读干跑 4 句真话；
真库普查 1368 条；客户端本轮未动；临时探查脚本已删，workspace 残留 0。

**如实边界**：① 本轮的时序修复**还没在真机上看到效果**（要下一次重载；我会直接读 `recall.source`，
`live` 才算真的走了新路）；② `dedupeFloor=0.92` 是**看着普查数字定的**，但它每块触发概率极低
（我 4 句真话里 0 次）；③ `minQueryChars=6` 是拍的（用户消息中位数 12 字，主要挡 3–5 字的短答）；
④ `cohesionFloor=0.08` / `minSegmentTurns=3` 仍未标定。

## 2026-10-08 · 第三次重载：读取侧闭环合上 + 第一次真跑 digest（我错了两次）

**用户原话**：「重启完成」（第三次），随后批准「先小批试跑 digest + maxGroups=2」、副仓管「暂时留着等以后加模型」、
「加硬墙钟超时」（先选 90s，在我纠正前提后改选 **480s = 2× 档案超时**）。

### 一、读取侧的最后一个缺口合上了

`memory_stats.recall.engine.recall` 的读数落定：

```json
{ "query": "重启完成", "source": "live", "skip": "short-query", "ids": [], "bytes": 0 }
```

两层证据：① `source: "live"` —— 查询词是**现场从会话日志取**的，第 1 步就有了；同一格里
`recall.at = …852`、`feed.lastAt = …959`，**渲染仍比事件早 107 ms** —— 说明那个时序坑是真的、
而这个修复是**承重的**（不是装饰）。② `skip: "short-query"` —— 4 字消息被长度闸门挡下，
所以这一轮提示词里**没有** `<memory_recall>`（上一步那 4 行噪音消失）。缓存复测 **99.11%**，没掉。
（表格里 `86a4a199 … 2.6%` 是上一轮那个探针子代理：全新 1 轮会话本来就没有可缓存前缀，不是注入造成的。）

顺带**亲眼看到**了热列表（`【刚记下】`）出现在自己提示词里 —— 也因此发现下面第四条的缺陷。

### 二、第一次真跑 digest：一个变更单都没出，但抓到一个结构性缺口

小批试跑（`sample: 2, maxGroups: 2`）：

| 组 | 结果 |
|---|---|
| 组 1 | **被 DashScope 内容审核挡下**：HTTP 400 `DataInspectionFailed: Input text data may contain inappropriate content` → 进副审阅区；**接手也失败** |
| 组 2 | 成功，**耗时 231 秒**（09:59:01 → 10:02:52），出 2 条 merge |

**缺口**：`keeper.side = 线上`，与主仓管**同一个档案** → 接手就是把同一个请求原样再发一遍，
**必然同样被挡**（tail 原文：「线上 / qwen3.8-flash 接手也失败」）。
而且审核**不稳定**：同一批记忆里那条内容，2026-10-07 用同一个模型跑成功过（旧单 `fc77e564`，种子
`71bd8a93`，已通过并落库）—— 今天是组合触发/抽风，不是"这些记忆永远过不去"。
用户拍板：**不改成 host**（会花 DeepSeek 预算，与 08-13「预算留给真正需要小屿的时刻」冲突），
**留着等以后加另一个模型**。现在副仓管挂着 3 组（今天 1 + 10-07 的 2，同属一类内容）。

### 三、我这一轮说错了两次，都当场纠正

1. **错报超时**：我说「组 2 超过配置的 240s 超时」—— 那是拿上一次采样的时间当现在用。
   `Get-Date` 一量：当时才 257 秒，而它 **231 秒就成功返回了**。判据错、结论就全错。
2. **因此把超时值推荐错了**：我推荐「90 秒硬超时」，而**这一组正常成果就要 231 秒** —— 90 秒会把
   它直接杀掉。发现后**撤回该选项并重问**，用户改选 **480s（= 2× 档案超时）**。

教训写下来：**"超过配置的超时"这种判断必须先读一次真实时钟**，不能拿上一次快照的时间戳推算。

### 四、按拍板做的两件事

**① 一组的硬墙钟安全网**（`keeper.groupTimeoutMs`，`0` = 自动 = `archive.timeoutMs × 2`）：
`timeoutMs` 只管单次请求，而一组最坏打两次（超时重试一次）+ 接手再打一次 → 能卡十几分钟。
实现：纯函数 `groupDeadlineMs()` 算预算 → 组内每次 `client.chat()` 都带 `timeoutMs: 剩余预算`
（调用级覆盖**只能收紧、不能放宽**，`min(覆盖, 档案超时)`）→ 接手那一次共用同一条预算
（到点只给 1ms，立刻失败、如实记「接手也失败」），不额外等一个档案超时。

**② 热列表只画有正文的条目**：merge / replace 过审后原条是软删的，`getMemory()` 拿不到正文 ——
出单侧却把它记进了热列表，于是提示词里出现**一行只有编号、没有内容的空话**（我在自己提示词里看到
`【刚记下】[mem#9d2ab41b]` / `[mem#47e60abe]` 两条就是这样）。两侧都挡：出单侧只记**还活着**的条，
注入侧遇到空正文跳过。

（顺带纠正一个我说错的事实：`merge` 不是"新建一条、原条全软删"，而是**保留第一条就地改写成合并结果**、
其余软删（README 231 行一直是对的，是我口述时说错了）。

### 五、落库的变更单

`b8056b8b`（组 2 的 2 条 merge，用户「两条都过」）：`8df7000b + 47e60abe + 9d2ab41b` → 一条
（检修宫殿铁律），`b1a57dba + 5bb2695e` → 一条（铁律 8/9，后者本就是前者的重复）。两条都把
「消失的片段」逐条核对过，都是同义改写、没丢事实要点。

**自证（实际输出）**：`node --check` `src/host/{keeper,locallm,config,recall}.js` / `lib/index.js` /
`test/{keeper,recall,config}.test.js` 全 exit 0；全量 **343/343 pass、fail 0**（339 + 4：
`groupDeadlineMs`、调用级超时覆盖只能收紧、卡死那组的端到端（150ms 收网、不重试、进副仓管）、
热列表空正文不画）；其中「差一条测试」是我自己造的：`recall.test.js` 那次编辑被"未读文件"挡下、
我忘了重试 —— 靠 **339+4≠342 这个算术**发现并补上；客户端本轮未动。

**如实边界**：① 硬墙钟**还没在真机上跑过**（要下一次重载；我会用 `job.tail` 看有没有「整组超过」）；
② 480s 是"2× 档案超时"的推导值，没有实测数据支撑（实测样本只有 231s 那一组）；
③ 被审核挡住的 3 组**仍然挂着**，在用户加另一个模型之前不能变；
④ 每跑一轮，被挡的组仍会**白试一次同模型接手**（我提议"接手模型与刚失败的主仓管同档案时直接跳过"，
用户本轮没表态，未做）。

## 2026-10-08 · 主副仓管独立：四条真干扰，逐条拆掉

**用户原话**：「主副仓管独立 各自的运行不能互相产生干扰」。

这句话同时**回答了我上一轮的问题**：我提议的「接手模型与刚失败的主仓管同档案 → 直接跳过」
**作废** —— 它让副仓管的行为依赖主仓管的失败状态，正好违反"独立"。所以没做，也不会做。

### 审计出的四条真干扰（都有代码位置）

| # | 干扰 | 后果 |
|---|---|---|
| 1 | `takeOverHandoff` 完全**没有运行锁** | 面板连点 / 工具重复调用能同时跑多个接手 |
| 2 | 副仓管跑完不落任何状态（只有主仓管有 `this.keeper` 槽） | 副仓管在跑时**哪都看不见**；两边没有各自的状态 |
| 3 | **同一组能被接两次**：主仓管某组失败后是「挂队列 + 当场接手」，而那一窗口里 handoff 还是 `open`、面板也看得到 → 人再点一次「接手」 | 同一组出**两张单**，两张都可能被审过 → 重复改写 |
| 4 | `this.lastTakeoverError` 是实例字段 | 两条线并发接手时，A 可能读到 B 的失败原因 |

### 拆法

1. **副仓管自己的运行槽** `this.sideJob`（与 `this.keeper` 分开），`keeperStatus()`
   同时给 `job`（主）与 `sideJob`（副）；副仓管一次只接一组，但**与主仓管的轮次无关** ——
   主仓管在跑时照样能接手，两边进度 / 计数 / tail 谁都不覆盖谁。
2. **原子认领** `store.claimHandoff(id)`：`UPDATE ... WHERE id = ? AND state = 'open'` 做比较并交换，
   两个调用方只有一个拿得到。`handOffGroup`（主仓管那条线）与 `takeOverHandoff`（副仓管那条线）
   都走它 —— 干扰 3 就这样被结构性拆掉。
3. **认领失败必须放回** `store.releaseHandoff(id)`（只在 `taking` 时回退，不踩终态）；
   进程被杀留下的僵住认领由 `store.reclaimStaleHandoffs()`（>10 分钟）自动放回 ——
   不做这一步那条会永远停在 `taking`：列表看不到（面板只列 `open`）、也接手不了，**等于悄悄丢了**。
4. `createHandoff` 的**同组复用**把 `taking` 也算进去（原来只认 `open`）—— 否则认领期间同一组
   再挂一次会插出第二行。

### 我自己在这一轮踩的两个坑（都在测试里暴露）

1. `parseTakerChoice()` 的 `undefined` 是**合法值**（= 自动顺序），我写成 `taker.name ?? …` 后
   直接 `TypeError` —— 5 条既有测试当场红。只有 `null` 才是不合法（这个区分必须留着）。
2. `reclaimStaleHandoffs()` 第一版用了 `Date.now()`，而写入时刻是 `#stamp()`（库自己的时钟）打的 ——
   测试库用假时钟，于是"刚认领的"被判成"僵住的"。**这是生产代码的真问题**（有假时钟时才暴露），
   改成走 `this.now`。

**自证（实际输出）**：`node --check` `src/host/store.js` / `lib/index.js` / `test/{store,keeper}.test.js`
全 exit 0；全量 **346/346 pass、fail 0**（343 + 3：认领/放回/僵住清扫、主副独立且互不阻塞且
sideJob 各存各的、两条线并发接同一组只有一个拿得到）；客户端本轮未动（`sideJob` 已能读，但**面板还没画**）。

**如实边界**：① 面板**还没画**副仓管自己的运行状态（`keeperStatus().sideJob` 已经能读到，
但 `lib/client.js` 没动）—— 要不要画由用户定；② 干扰 4（`lastTakeoverError` 串台）**仍在**：
它只影响一句失败原因文案，修法要改 `resolveTakeoverClient()` 的返回形状（4 个返回点）+ 可能影响
既有测试，我没在这轮动；③ **`meta.model` 归属仍可能串**：`reviewKeeperPlan` 从 `this.keeper?.model`
取模型名，而一张副仓管出的单审到这里时，`this.keeper` 是**主仓管那一轮**的模型（或 null）——
要修得把"产出这张单的模型"存下来（plan 加列 / 存进 ops / 用 `note` 字段三种，都不小），
留待用户点头再选一种。

## 2026-10-08 · 三件遗留一次结清（署名 / 面板 / 失败原因）

**用户原话**：在多选里三件全勾了。上一轮我把它们逐条列成"遗留、等你点头"，这一轮按选择做完。

### 1. `meta.model` 署名不再串台（选了「plan 加列」）

- **问题**：审阅落库时新记忆的 `meta.model` 读的是 **`this.keeper?.model`**（= 主仓管那一轮的 job）。
  一张**副仓管**接手的单审到这里，就会被盖成主仓管那一轮的模型名（或 `null`）—— 两条线互相污染。
- **修法**：`keeper_plans` 加一列 `model`（= **产出这张单的模型**）。两个产出点各署各的：
  `reorganizeMemories()` 署 `target.client.model`（接手那条线）、run 循环署 `job.model`（主仓管那条线）；
  手工 `propose` / `propose-drop` 不署（不是仓管模型产的）。审阅时 `meta.model = plan.model ?? null`。
- **迁移**：`db.js` 新增 `migratePlanModel()`（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN model TEXT`，
  与 v3→v4 计分列同一套：**纯增量、绝不重建表**）。
- **⚠️ 一个刻意的决定：不抬 `SCHEMA_VERSION`**（留在 5）。理由：加一列**可空**列不改"这份代码要求什么形状"
  —— 旧代码打开新库照样能用，只是读不到这一列。抬上去的代价是老代码一开库就被版本闸门挡住
  （用户一旦回退插件代码，库就打不开了），而它换来的只是一个署名列。为了这点评测价值不值得。
- 老单没有这一列 → 署 `null`（不知道是谁产的，**不假装**），**不借用**主仓管的模型名。

### 2. 副仓管页画自己的运行状态

- `SideTab` 多读一个 `keeperStatus().sideJob`：跑着显示「正在接手（模型）…」（跑的时候每 2 秒跟一眼，
  跑完刷新队列 —— 成功那行会变 `taken` 消失、失败会带回新原因），跑完留一句
  「上一次接手（模型）：结果」；**结果取宿主 `sideJob.tail` 的终态那一行**，拿不到退 `error`，
  都没有只给破折号（**不编一句看起来像结果的话**）。没在跑也没跑过 → **一个字都不画**。
- **踩到一个真坑**：`tools/check-client.mjs` 的浅渲染按**位置**喂 `useState`（`__stateQueue`）——
  我把 `sideJob` 插在第 2 位，把后面 4 个状态全挤错位，自检从 **136 掉到 131**（5 条副仓管断言红）。
  修法：新状态**只能往后加**（放成第 7 个），harness 与那段文档注释一起同步。
  这个约束我写进了 `SideTab` 的注释里，免得下次再踩。

### 3. 接手失败原因不再挂实例字段

`this.lastTakeoverError` 删掉，改成 `resolveTakeoverClient()` 把原因**随返回值带回来**
（`{client, label, kind, error}`；失败时 `client: null`）。两条线并发接手时，A 不会读到 B 的失败原因。
`reorganizeMemories()` 相应改成 `target == null || target.client == null`。

**自证（实际输出）**：`node --check` `src/host/{db,store}.js` / `lib/index.js` / `lib/client.js` 全 exit 0；
全量 **349/349 pass、fail 0**（346 + 3：`keeper_plans.model` 往返与空白当没给、
增量列迁移（含幂等与"老行 NULL"）、`meta.model` 署名认单子自己 + 老单署 null、失败原因随调用返回）；
客户端 `tools/check-client.mjs` **138/138**（+2 条新断言）；改 DDL 注释时踩到一次
**模板字符串里的反引号**（把 SQL 字符串截断了，`node --check` 当场报错）—— 已改。

**如实边界**：① `migratePlanModel` **还没在真库上跑过**（要下一次重载；`memory_stats.migration.planModel`
会显示 `plans-add-model`，之后应一直是 `already-has-model`）；② 副仓管页那条状态行**只在跑的时候**才有内容，
平时是空的 —— 我没给它做"上一次接手"的历史（那要再存一处状态，暂时不值）；③ `sideJob` 的 `tail` 只有最后
10 行、`taker` 在自动顺序下显示为「自动」而不是最终选中的档案（最终模型在 `model` 字段里，没画）。

## 2026-10-08 · 迁移落地 + **我声明的墙钟其实收不住** + 捕获侧补上同一道闸

**用户原话**：「重启完成」，随后拍板两件（多选）：捕获侧加 `isHumanMessage` 闸；把那两条重复合掉。

### 一、`keeper_plans.model` 迁移在真库上落地

`memory_stats.migration.planModel = {migrated: true, reason: 'plans-add-model', added: ['model']}` ——
只跑一次（下次开机应为 `already-has-model`）。**live 验证**：随后起的一组出了一张新单，
`"model": "qwen3.8-flash"` 真被填上了（不只是单测）。

### 二、我声明的「一组不超过 480s」在真机上不成立：实测 **602s**

那一组的 tail 与时间戳是完整证据：

```
组 1：开始（5 条记忆，种子 fec49d7c）      startedAt 03:26:50.493Z
组 1：超时，重试一次
组 1：失败（超时，已重试一次）
组 1：已挂到副审阅区（第 1 次）
组 1：线上 / qwen3.8-flash 接手 → 1 条操作   plan.createdAt 03:36:52.293Z（= 602s）
```

组内两次请求各 240s 就把整组预算（480s）用光了，**"接手那一次"是在预算耗尽之后才开跑的**，
却又跑了约 120s 并成功 —— 总耗时 602s > 我声明的上限。静态核对时我把整条链子（job 字段 → 预算计算 →
`budgetLeft()`/`handoffBudget()` → `reorganizeMemories` → `chat({timeoutMs})` → `locallm` 的
`min(覆盖, 档案超时)`）逐环读了一遍，**每一环都对**；单测里用桩客户端也证明"接手那一次拿到的确实是 ≤5ms"。
也就是说：**只靠"把剩余预算传给那一次请求"这条路，在真机上不足以保证上限**（我没法从外部观测
真实 fetch 对那个 1ms 信号的反应）。所以我不再依赖它，改成**我们自己的代码说了算**。

**修法**：整组到点 → **不自动接手**，留在副审阅区等人接手（用户的口径本来就是"留着等"）；
没到点的失败照旧当场接手（那条救回路径不变，且那一次的预算仍受剩余整组预算约束）。
**顺带修掉我新引入的一个缺陷**：跳过接手时必须把**认领放回** `open`（否则那一条卡在 `taking` ——
面板只列 `open`，10 分钟看不见也接不了 = 悄悄丢了）。

### 三、捕获侧补上读取侧早就有的那道闸

**根因（写侧）**：`ConversationBuffer.note()` 只看 `event.type === 'user/message'`、**不看 `source`**。
而 `user/message` 是共用信封：插件注入 / 工作区指令基线 / **compaction 摘要**都走它。后果两条：
① `minChars`（"用户正文累计多少字"）被非人类文本灌满 → 捕获被无关触发；② 转录里出现
「用户：&lt;摘要&gt;」→ 抽取器把**派生文本**当成用户亲口说的。

**真机证据**：同一条拍板被捕获两遍（`2da9cd4a` 10:25:51 / `96a95c85` 10:57:40，措辞略异、都是派生措辞）。

**修法**：`note()` 里对 `user/message` 先过 `isHumanMessage(event)`（与读取侧同一判据，判据取宽：
没标 source 的老形状照旧按人来）。附带效果：捕获触发会变少（之前被灌水了）—— 这是**修正**不是退化。

### 四、那两条重复：出了两张单等审

用户拍板"propose 一条 + propose-drop 另一条"（只出单、不落库）：

- `1de0a592`（replace `2da9cd4a`）：合并后的正文 =
  「用户于 2026-10-08 拍板：被内容审核拦下的那些记忆重组先不做改动，**留在副仓管区**，
  等他以后接入另一个模型时再处理。」（把出处"留在副仓管区"从他自己的原话里补进去）
- `135f980a`（drop `96a95c85`）：同一条拍板的第二遍。

另外**我验证时跑的那一组也留了一张开着单** `04e1bb20`（把碎片"互动模式与剧本\n恋爱里程碑"
并进完整的 08-29 剔除整理那条），一并等用户定夺。

**自证（实际输出）**：`node --check` `src/host/capture.js` / `lib/index.js` / `test/{capture,keeper}.test.js`
全 exit 0；全量 **352/352 pass、fail 0**（349 + 3：转录缓冲只收人说的话、到点不自动接手、
没到点的失败照旧接手且受剩余预算约束）；客户端 `check-client` **138/138**（本轮未动客户端）。

**如实边界**：① "到点不自动接手"**还没在真机上跑过**（要下一次重载；看 tail 那行与 `openHandoffs`）；
② 我**没能**解释清楚"接手那次为什么突破了预算"——只做到"不依赖它"；真正的根因（真实 fetch 对
1ms 信号的处置）我没有可观测手段，不编；③ 捕获侧闸门让触发变少，**会不会漏掉本该记的**要跑几天才知道；
④ 那三张单都还开着，等用户逐条过。

## 2026-10-08 · 捕获闸生效了，但**残渣还在**：抽取器仍从「助手：」行挖事实

**用户原话**：「重启完成」。

### 一、重载后先看到的：一次触发写了 4 条，而第 4 条是**我的措辞**

`03:45:29Z` 那一笔捕获落了 4 条（`761016f7` / `79e0aba5` / `7ea00b7b` / `ca9deaa1`）。前三条的措辞能
逐条对上**用户自己在提问里的选择**（「合：propose 一条 + propose-drop 另一条」/「加（与读取侧同一个判据）」
/ 之前那条「留在副仓管区」），内容准确 —— 说明 `isHumanMessage` 那道闸**确实在起作用**（不再拿压缩摘要
当"用户的话"，计数也不被灌水）。

**但第 4 条 `761016f7` 的正文与我在上一轮汇报里写的那句合并正文一字不差** —— 也就是说：**抽取器仍然把
「助手：」行当素材**，把我说的话写成「用户于…拍板」。这次它挖得准（那句话本来就是用户拍板的内容），
但机制上是危险的：**我提过而被否掉的建议，同样可能被记成用户的拍板**（上一轮那条"同档案就跳过"就是
被否掉的）。

### 二、于是补了提示词里缺的那一条（不新增机制，只把已有的原则写准确）

`EXTRACT_PROMPT` / `EXTRACT_FOCUSED_PROMPT` 早就写了「不记助手自身的立场与自述」，但那条拦不住
"从我的话里反推用户的决定"。补的是一条**更精确的**：

> **从助手的话里反推本人的拍板**：转录里「助手：」开头的行**只是上下文**。要记成「用户/本人拍板…」，
> 必须能从「用户：」行里读到本人自己的话；助手汇报里转述过、提议过的，一律不算本人说过。

单测直接钉住这两个措辞（`/助手的话里反推/`、`/只是上下文/`）。写的时候踩了**同一个坑第二次**：
提示词是模板字符串，我在里面写了反引号（``` `助手：` ```）→ `node --check` 当场报错，改成「助手：」。

### 三、合并方案改了（多出来的第三份让它更简单了）

第三次捕获让同一件事有了三份：`2da9cd4a`（10:25）/ `96a95c85`（10:57）/ `761016f7`（11:45）。
原来我给的是"replace `2da9cd4a` 成合并文本 + drop `96a95c85`"，但那会造成**两条同文**（replace 出的新条
与 `761016f7` 一模一样）。改成更干净的：**留最完整的那份当唯一幸存者，把两份旧版删掉** ——

| 单 | 动作 |
|---|---|
| `135f980a` | drop `96a95c85` |
| `ee8de4f3`（新出） | drop `2da9cd4a` |
| `1de0a592` | **建议驳回**（不再需要 replace；它的合并文本已经被 `761016f7` 覆盖了） |
| `04e1bb20` | 我验证时跑出来的那张 merge，独立于本条，等用户定夺 |

**自证（实际输出）**：`node --check` `src/host/extract.js` exit 0；全量 **352/352 pass、fail 0**
（新断言加在既有的提示词测试里，条数不变）；客户端未动。

**如实边界**：① 提示词是**尽力而为**，不是保证 —— 模型仍可能把转述当拍板（真机已见过一次）；
真要堵死得改成"只把「用户：」行喂给抽取器"，那会削弱上下文（助手行能帮它读懂指代），是个取舍，
**留待用户定**；② 那 4 条新记忆内容都准确，我没有为了"少几条"去删它们；
③ 三张单（+1 张验证残留）仍在待审区，等用户过。