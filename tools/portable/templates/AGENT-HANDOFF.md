# 开发交接（给接手这个项目的 agent）

> 读完这份，你应该知道：这个项目是什么、代码怎么摆、哪些红线不能碰、怎么验证改动、下一步该做什么。
> 权威细节在仓库自己的文档里（`1-plugin/dsh-memory/README.md`、`DESIGN.md`、`REGRESSION.md`）——
> 本文件只做**入口与现状**，不重复它们。

---

## 1. 一句话

**dsh-memory 是 DSH 的原生本地记忆插件**：SQLite（FTS5 trigram 关键词 + 余弦向量语义，RRF 融合检索）
+ 自带 Web 面板 + agent 侧 16 个工具 + 库外审阅门（抽取 → 待审 → 过审才落库）+ 仓管/副仓管两条整理线。
零第三方依赖、不联网也能跑（除嵌入/LLM 调用）。

## 2. 当前状态（打包时）

| 项 | 值 |
|---|---|
| 源提交 | `{{COMMIT}}` {{COMMIT_SUBJECT}}（分支 `{{BRANCH}}`） |
| 上游 | <https://github.com/Holly-cloud/dsh-memory-holly> |
| schema | v{{SCHEMA}}（当前代码的 `SCHEMA_VERSION`；老库自动迁移） |
| 插件文件 | {{PLUGIN_FILES}} 个（含 `.git`）· 仓库跟踪 51 个文件 |
| host 模块 | 18 个（`src/host/*.js`） |
| 工具 | {{TOOL_COUNT}} 个常驻（`lib/index.js` 里注册；{{TOOL_PROBE}}） |
| 面板路由 | 37 条（`src/host/panel.js` 表驱动，覆盖 39 个端点） |
| 回归测试 | 19 个文件 / **372** 个用例（`node:test`，全过） |
| 客户端自检 | **169** 条断言（`tools/check-client.mjs`，浅渲染，全过） |
| 个人数据（本包） | 记忆 {{MEMORIES_ACTIVE}} 条（含已删共 {{MEMORIES_TOTAL}}）· 向量 {{VECTORS}} · 待审条目 {{BATCH_ITEMS}} · 变更单 {{PLANS}} · 副审阅区 {{HANDOFFS}} |

> 上面的测试数字是打包时的；你改完代码请自己重跑并以实际结果为准，并更新 `REGRESSION.md`。

## 3. 代码地图

```
lib/index.js        宿主入口：注册 16 个工具 + 面板路由 + 注入（Layer 0 常驻索引 / Layer 1 召回）
lib/client.js       Web 面板（手写、无构建的浏览器 bundle：h = React.createElement）
src/host/db.js      node:sqlite 打开库 + DDL + schema 迁移（v1→v5）+ FTS5 触发器
src/host/store.js   MemoryStore：记忆/向量/历史/批次/变更单/副审阅区/设置 的全部读写
src/host/search.js  混合检索（FTS5 + 余弦 + RRF）
src/host/recall.js  注入侧：常驻索引 L0 + 按需召回 L1
src/host/config.js  配置归一 + 嵌入指纹（space = provider:model:dims）
src/host/embed.js   嵌入（线上 OpenAI 兼容 / 局域网 ollama / 本地 hash）+ 补齐队列
src/host/llm.js     宿主 LLM 通道（抽取/仓管默认用它）
src/host/locallm.js 局域网/本机 LLM（仓管档案可切）
src/host/extract.js 事实抽取 → stageExtraction（只进待审区）
src/host/review.js  待审批次审阅/驳回（过审才写 memories）
src/host/conflict.js 与旧记忆冲突判定（supersede/duplicate/coexist/unrelated）
src/host/transient.js 确定性三分类（transient 丢弃 / uncertain 进待审 / durable 保留）
src/host/capture.js 自主捕获（对话缓冲、会话/人类消息识别）
src/host/keeper.js  仓管：种子+召回分组、调度
src/host/keeper-plan.js 变更单：提示词、ops 归一、证据 warnings
src/host/panel.js   面板 HTTP 路由（表驱动；requestBody: 'buffered'；37 条）
src/host/portability.js 导出包 / 导入（按全文 hash 判重；文本是本体）
src/host/timeout.js 超时包装
tools/              安装器 / 自检 / 迁移包 / **便携打包器** / 测试 runner
test/               19 个 node:test 文件（372 用例）
```

## 4. 铁律（改代码前先背下来）

1. **记忆数据永不进仓库**。`.gitignore` 挡死 `*.db / *.db-wal / *.db-shm / *.jsonl / .migration/ / .import/ / .retired/ / .install/`。
   数据住在仓库外（本机 `<DSH_HOME>/dsh-memory`，备份在 `dsh-memory-data/`）。
2. **文本是本体，向量是派生物**。任何一套向量都可以整表删掉重算；导出包里从不带向量。
3. **零第三方依赖**。宿主只用 `node:*`；客户端是手写 bundle，没有构建步骤。
4. **UTF-8 无 BOM**。所有 `.js/.md` 必须无 BOM、无 U+FFFD；中文注释不许被 GBK 转坏
   （在 PowerShell 5.1 里**别用字符串替换改文件**，用 Node 脚本或编辑器）。
5. **界面直观、每个可见控件/文字都不得多余**（低认知负荷）。能删的字就删，不能解释自己的控件就别加。
6. **颜色只用主题 token**：`--dsw-alias-*`（14 个）与已验证的字体/圆角 token；不许写死颜色。
7. **删除必须先说服人**：仓管 `drop` 无 `reason` 时审阅**永远跳过**；仓管在代码里没有任何删除能力。
8. **修改记忆只有一条路**：依照原记忆写新记忆 → 新旧进待审区 → 过审后删旧录新（`replace`）。
9. **数据与代码解耦**：包里 `1-plugin/`（可公开）与 `2-personal-data/`（私密）**分开交付**，
   任何脚本/文档都不许把两者混在一起，也不许把密钥写进任何文件。

## 5. 常用命令

```bash
NODE=$(command -v node || ls ~/.dsh/dsh-runtimes/*/dependencies/node/bin/node | head -1)

$NODE tools/run-tests.mjs --client     # 全量回归 + 客户端自检（同进程，无子进程）
$NODE tools/check-client.mjs           # 只跑面板自检（169 条断言）
$NODE --check lib/client.js            # 语法
$NODE --check lib/index.js
$NODE tools/install.mjs --dry-run      # 看安装会写什么
$NODE tools/make-portable-pack.mjs     # 重新打便携包（默认 ../release/<label>/）
$NODE tools/make-migration-pack.mjs    # 重新生成迁移包（文本包 + 冷备份）
```

> ⚠️ 不要用 `node --test test/`：它会起子进程，在受限环境（DSH 沙箱/某些 Windows 策略）里
> 会 `spawn EPERM`。`tools/run-tests.mjs` 就是为这个准备的，结果等价。

## 6. 改动的标准流程

1. 改代码（宿主 `src/host/*.js`；客户端面板 `lib/client.js`）；
2. `node --check` 改过的文件；
3. **加/改用例**：行为变更必须补测试（`test/*.test.js`）；UI 变更必须补 `tools/check-client.mjs` 断言；
4. `$NODE tools/run-tests.mjs --client` 全绿；
5. 在 `REGRESSION.md` 追加一节：**为什么改 / 证据（命令+数字）/ 边界（没做什么）**；
6. 编码检查：无 BOM、无 U+FFFD、无 mojibake；
7. 提交（`git add -A && git commit`）；提交信息写「用户口径 → 改法 → 证据」。
8. 要发布便携包时再跑 `tools/make-portable-pack.mjs`。

## 7. 常见改法

**加一个 agent 工具**：`lib/index.js` 里按现有工具的结构注册（`name: 'memory_xxx'` + `parameters` + handler），
handler 只调 `src/host/*` 的纯函数/Store 方法；补测试；更新 README「工具」一节与 `{{TOOL_COUNT}}` 相关数字。

**加一个面板路由**：`src/host/panel.js` 的 `memoryPanelRoutes` 数组加一条（path 唯一、`requestBody: 'buffered'`），
面板里用 `fetch('/api/dsh-memory/...')`；补 `test/panel.test.js`（路由数 + 行为）。

**加一个页签**：`lib/client.js` 的 `tabItems()` + 页面组件；中英字典键成对加（`zh` + `en`）；
`tools/check-client.mjs` 的 `renderSearch`/浅渲染队列要同步；补断言。

**换嵌入模型**：不用改代码 —— 面板「设置 → 嵌入配置」新建档案 → 测试连接 → 切换（旧空间保留）→ 补齐缺的。

## 8. 已知限制（诚实版，详见仓库 README「已知限制」）

- 向量按空间保留：每个空间各占一份存储（1024 维 ≈ 4 KB/条）；换模型不会删旧空间，要手动清理；
- 语义检索依赖嵌入服务可用；不可用时**明确降级为关键词**，不会拿别模型的向量硬凑；
- 抽取/仓管依赖宿主 LLM；宿主没配模型时这两条线不可用（面板会提示）；
- 中文 FTS5 trigram：查询建议 ≥3 字，短词会走 LIKE 兜底（慢一些）；
- 面板「最近入库」是按 **入库时刻**（`created_at DESC`）倒序；导入的老记忆会挤在同一时刻；
- `history` 是审计与手工恢复依据，没有「一键回滚」按钮；
- 便携包的 merge 模式不搬向量、不改原记忆 id（快照模式才是一字不差）。

## 9. 下一步（打包时还没做的）

1. **面板「最近入库」在没有任何功能启动时是否常显** —— 用户还没拍板，当前默认保留（见包内数据/仓库 README）；
2. 端口/权限：诊断路由默认关闭，只在 `--diagnostics` 时打开；如需长期观测要另做鉴权设计；
3. 更多嵌入档案的「空间清理」入口（现在只能手工 `DROP`/删表行）；
4. 本便携包的**还原**目前只有 CLI（`restore.mjs`）；若要给非技术用户，可考虑在面板加「导入数据包」按钮
   （走同一套 `restore-core` 逻辑，注意快照替换要求 DSH 释放库）。

> 不确定的口径先问用户，别自己拍板 —— 这个项目的很多细节是用户逐条截图批注定下来的，
> 仓库文档与 `REGRESSION.md` 里有原话与理由。
