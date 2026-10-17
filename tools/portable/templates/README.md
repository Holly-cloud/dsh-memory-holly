# dsh-memory 便携包 · {{LABEL}}

> 给**任何设备上的 DSH**：装好插件 + 还原全部个人记忆，然后接着开发。
> 打于 {{DATETIME}}，源提交 `{{COMMIT}}`。

---

## 一分钟看懂

这个包分**两大部分**，互不依赖地表述了两件事：

| 部分 | 里面是什么 | 换机器要不要带走 |
|---|---|---|
| `1-plugin/dsh-memory/` | 插件**本体**：代码、测试、工具、设计文档、`.git`。打包时它本身就能跑、能改、能提交 | 要（也能从 GitHub 重新 clone） |
| `2-personal-data/` | **个人数据**：记忆库快照 + 文本包 + 待审阅条目 + 变更单 + 设置，外加一个一键还原脚本 | **必须**（这是不可再生的东西） |

**数据包里没有任何密钥**（嵌入/仓管的 key 在 DSH 凭据库里，永远不进包）。密钥要在新设备的
面板「设置」里重新填一次 —— 不填也能用，只是语义检索与 LLM 抽取不可用。

---

## 最省事的三步

```bash
# 0) 解压后，cd 到本包根目录；用 DSH 自带的 node（≥ 24，见 INSTALL.md §1）
node 2-personal-data/tools/restore.mjs        # ① 先把个人数据落好（全新机器=落快照）
node 1-plugin/dsh-memory/tools/install.mjs    # ② 把插件装进 DSH 的 profile patch
# ③ 完全退出并重启 DSH → 左栏出现「记忆」图标
```

**顺序很重要**：先还原数据、再装插件。全新机器上插件第一次启动会直接打开已经落好的库，
省掉「先建空库、再想办法替换」的麻烦（也避开 DSH 正开着库时不能替换文件的问题）。

装完再补两件事（面板里点，不用命令）：
1. **设置 → 嵌入配置 → 粘贴密钥 → 保存**（没 key 就只做关键词检索，其余都正常）；
2. **概览 → 补齐**（把向量按新机器当前的嵌入模型算出来）。

---

## 这个包自证过什么

打包器出包前自己跑完这套检查（任何一项不过就拒绝出包）：

- 快照能打开，记忆 **{{MEMORIES_ACTIVE}}** 条（含已删共 {{MEMORIES_TOTAL}}）/ 向量 {{VECTORS}} / 待审批次 {{BATCHES}} / 待审条目 {{BATCH_ITEMS}} / 变更单 {{PLANS}} / 副审阅区 {{HANDOFFS}} 与活库一致；
- 文本包能导进**全新空库**且 `added = 包内条数`、`skipped = 0`、`failed = 0`（无损）；
- 包里所有 `src/host/*.js` 都能被 Node 直接 `import`（语法与相对依赖没坏）；
- zip 回读每个条目内容一致；
- 设置与文档里扫不到 `sk-…` / `apiKey` / token 这类字面量。

想自己复核：`node 2-personal-data/tools/restore.mjs --mode verify`（只读，不写一个字节）。

---

## 目录

```
{{LABEL}}/
├─ README.md                  ← 你正在看的这份
├─ INSTALL.md                 ← **部署手册**（给 agent 的执行清单，含验收与排障）
├─ AGENT-HANDOFF.md           ← **开发交接**（项目现状、架构、铁律、下一步）
├─ MANIFEST.json              ← 全量文件清单 + sha256 + 计数
├─ 1-plugin/dsh-memory/       ← 插件本体（含 .git，可直接继续开发）
│  ├─ lib/                    ← 宿主入口 + 客户端面板（无构建，手写 bundle）
│  ├─ src/host/               ← 18 个宿主模块
│  ├─ test/                   ← 372 个用例（node:test）
│  ├─ tools/                  ← 安装器 / 自检 / 迁移包 / 本打包器
│  ├─ README.md DESIGN.md MIGRATION.md PHASE0.md REGRESSION.md
│  └─ package.json .gitignore
└─ 2-personal-data/
   ├─ README.md               ← 数据包说明 + 还原验收 + 故障处置
   ├─ data/
   │  ├─ counts.json          ← 期望数字 + 包内每个文件的 sha256
   │  ├─ memory.db            ← 库快照（{{DB_MB}} MB，含向量/历史/待审/变更单/设置）
   │  ├─ pack/                ← 文本包（memories.jsonl 是真源；readable.md 给人看）
   │  └─ sidecars/            ← 待审批次 / 变更单 / 副审阅区 / 设置（merge 用）
   └─ tools/restore.mjs       ← 一键还原（快照 or 合并，自动选）
```

---

## 边界

- **数据是私密的**：`2-personal-data/` 里是真实记忆正文，别推向公开仓库；`.gitignore`
  已经把 `*.db / *.jsonl / .migration / .import` 这类名字挡在仓库外，插件仓库本身从不含记忆。
- **包不是备份策略的替代**：日常还有插件内「一键备份」（`<dataDir>/备份/`，SQLite
  在线快照 + 文本包），本包是「搬家/交付」用的整包。
- **上游**：<https://github.com/Holly-cloud/dsh-memory-holly>（{{BRANCH}} 分支，提交 `{{COMMIT}}`）。

---

## 版本

| 项 | 值 |
|---|---|
| 包标签 | `{{LABEL}}` |
| 打包时间 | {{DATETIME}} |
| 源提交 | `{{COMMIT}}` {{COMMIT_SUBJECT}} |
| 数据库 schema | v{{SCHEMA}} |
| 插件文件数 | {{PLUGIN_FILES}}（含 `.git`） |
| 工具数 | {{TOOL_COUNT}} 个常驻 |
| 个人数据 | 记忆 {{MEMORIES_ACTIVE}} 条 / 待审条目 {{BATCH_ITEMS}} 条 / 变更单 {{PLANS}} 张 / 副审阅区 {{HANDOFFS}} 组 |
