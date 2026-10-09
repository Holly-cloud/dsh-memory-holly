# 换机器 / 重置系统 —— 完整迁移手册

> 目标：新系统上装好插件，**1087 条记忆一条不少、正文一字不改**地导回来。
> 包里只有**文本**，向量到新系统按当前模型重算 —— 所以换了嵌入模型也能搬。

---

## 0. 迁移需要带走的三样东西

| 带走什么 | 在哪 | 为什么 |
|---|---|---|
| **整个 `dsh-memory` 目录** | `<DSH 工作区>\dsh-memory\` | 插件本体（代码 + 文档）。可再生，但带着最省事 |
| **记忆数据目录** | `<DSH 工作区>\dsh-memory-data\` | **这是唯一不可再生的东西**：记忆包 + 库冷备份都在这里（已与仓库解耦，**不进 git**） |
| **记忆包** | `<DSH 工作区>\dsh-memory-data\.migration\memory-pack\` | `memories.jsonl` 是记忆正文的真源；`readable.md` 是人看的 |
| 🔑 **嵌入密钥** | `<凭据文件>` 第 19 行 | **重置会清掉 `~\.dsh`（凭据库），密钥必须自己留一份** |

`dsh-memory-data\.migration\memory.db`（10.7 MB）是**冷备份**，含向量。可不带 —— 向量是派生物，导包时会重算；带着能省一次全量嵌入。

> ⚠️ **强烈建议**：把 `dsh-memory-data` 整个目录拷到 U 盘或网盘再重置（`dsh-memory` 本体也一并带上）。桌面和用户目录都可能被清掉。
> ⚠️ **不要把密钥写进 `dsh-memory` / `dsh-memory-data` 目录里的任何文件** —— 那个目录是要拷来拷去的。

---

## 1. 重置前：生成/复核迁移包

包已经生成好了（`dsh-memory-data\.migration\memory-pack\`，1087 条）。任何时候想重新生成，跑：

```powershell
$node = '<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node dsh-memory\tools\make-migration-pack.mjs
```

它会**自己证明无损**：把包导进一个全新的空库，断言
`added == 库里条数`、`skipped == 0`、`failed == 0`，任何一项不符就非零退出。
看到 `✅ 无损自证通过` 才用这个包。

---

## 2. 重置后：安装插件

### 2.1 先打开一次 DSH
它会初始化 `~\.dsh\profiles\desktop\`。没这一步，profile 目录还不存在，装不了。

### 2.2 恢复目录
把 `dsh-memory` 放回，例如 `<DSH 工作区>\dsh-memory\`。
**放哪都行** —— 安装脚本会从自身位置推导绝对路径。

### 2.3 跑安装脚本
```powershell
powershell -ExecutionPolicy Bypass -File <dsh-memory目录>\tools\install.ps1
```

它只做一件事：在 `~\.dsh\profiles\desktop\cordis.patch.yml` 里写一个 `insert` 行。

- **不需要 pnpm、不需要网络、不需要 `dsh.bundle`** —— 行名用绝对路径，patch 加载器自动转 file URL；
- **幂等**：重复跑只会刷新那一行，不会写重；
- **原子写 + 自动备份**：先写临时文件再改名，改坏不了 profile；每次都会留 `cordis.patch.yml.bak-<时间戳>`；
- 卸载：`install.ps1 -Uninstall`（只删那一行，不动插件目录与数据）。

### 2.4 完全退出并重启 DSH
新模块需要重新加载。重启后左栏应出现**「记忆」**图标。

---

## 3. 恢复密钥

`~\.dsh` 被清掉后凭据库是空的。**没有密钥时插件仍能用**（关键词检索、浏览、软删都正常），
但**语义检索、LLM 抽取、自主捕获的抽取**都不行 —— 后两者用的是**宿主已配置的模型**
（不在本插件的密钥里），所以新机器上除了嵌入密钥，还要确保 DSH 自己有可用模型
（面板「设置 → LLM 预检」可以一键确认）。

恢复方式：**面板 → 记忆 → 设置 → 粘贴密钥 → 保存**
（走 `ctx.credentials.set`，密钥只进 DSH 凭据库，不落本插件的任何文件。）

> 密钥是**按档案**存的：每个嵌入档案（线上 / 局域网 / 离线）有自己的 `apiKeyRef`，
> 在「设置」里选中哪个档案，保存就是写给哪个引用名。所以「线上一个 key、局域网另一个 key」互不干扰。

保存后回到「概览」，看**当前空间缺多少条**（`missing`），点**补齐**即可 —— 只算缺的，不重算已有的。

---

## 3.5 换嵌入模型 / 换到局域网模型（不用重来）

现在向量是**按空间保留**的，换模型不再需要全量重算：

1. **设置 → 嵌入配置**：新建一个档案，填 `provider` / `baseUrl`（局域网就写 `http://192.168.x.x:port/v1`）/
   `model` / `dimensions` / `apiKeyRef`；
2. 点**测试连接**（真打一次请求）→ 确认返回维度与 `dimensions` 一致；不一致就按实际值改；
3. 点**切换**：旧空间一行都不动；「概览」显示新空间「缺 N 条」；
4. 点**补齐** → 只算缺的（第一次换模型就是全量 N 条，2–4 分钟量级）；
5. 之后**切回原来的档案** → 只补「离开期间新增的」那几条，老的直接复用。

> 每个空间各占一份存储（1024 维 ≈ 4 KB/条）。不要的空间可以删，
> 见 `README.md`「已知限制」第 9 条。

---

## 3.6 老库升级（v1 → v2）

如果 `memory.db` 来自**这个改动之前**的版本（schema v1：一条记忆只能有一套向量），
首次打开会自动原地升级：老表改名 `vectors_v1` 留底 → 新表按 `(memory_id, space)` 建 →
逐行搬过去（空间键用**行自己的** model/dims 拼）。**记忆与向量条数不变**，
「概览」与日志里会显示升级结果。确认无误后可 `DROP TABLE vectors_v1` 回收空间。

---

## 4. 导入记忆

在对话里让 agent 做，它有一条 `memory_import` 工具：

> 「把 `<DSH 工作区>\dsh-memory-data\.migration\memory-pack` 导进记忆库」

对应参数：`dir` = 包目录（含 `memories.jsonl`）、`dryRun` 可先演练。

**判重规则**：按**全文 hash**。所以：
- 反复导不会重复入库（第二次会全部 `skipped`）；
- 导入后新记忆**自动排进嵌入队列**，无需手工回填。

导入完成核对：`memory_stats` 应显示 `memories: 1087`，且 `activeSpace.missing` 随后归零
（1087 条约需 2–4 分钟，看 `embedQueued` 是否归零；导入只会往**当前那个空间**补）。

---

## 5. 为什么这个包是无损的（以及一个已经修掉的坑）

导出包只存文本（`memories.jsonl` 每行 `{id, text, metadata}`），**不存向量** —— 这正是
「文本是本体，向量是派生物」那条设计不变量。

但生成包时发现了一个会**静默丢数据**的问题，已修：

> 早先做过一次清洗（剥掉正文开头重复的分节标题）。副作用是 **7 条来自不同分区的 `索引.md`**
> 记录，正文是同一句 29 字模版话、原本**靠分节标题区分**，剥掉标题后正文完全撞车。
> 而导入按全文判重 → 直接导会把这 7 条合成 1 条，丢掉 6 条的 `source`/`section`。
>
> `make-migration-pack.mjs` 对这 7 条从 `history.prev_text` 取回清洗前原文，恢复唯一性。
> 于是「库里 1087 条 → 包内 1087 条不同正文 → 导回 1087 条、skipped 0」。

而且 `history` 表里有全部改写留痕（`prev_text`），任何一次清洗都可追溯、可回滚。

---

## 6. 故障排查

| 现象 | 先看什么 |
|---|---|
| 左栏没有「记忆」图标 | `cordis.patch.yml` 里那行在不在；`install.ps1` 是否报错；DSH 是否**完全重启**过（不是刷新页面） |
| 图标在、面板打不开 | 浏览器 F5；再看 DSH 控制台有无 `client-modules` 相关报错 |
| 导入后条数不对 | 先 `dryRun: true` 看 `added/skipped`；`skipped > 0` 说明包内有撞车（用 `make-migration-pack.mjs` 重新生成） |
| 检索不到东西 | 概览页看 `vectors` 是否落后；`embedQueued > 0` 说明还在补；中文查询**建议 ≥3 字** |
| 抽取总是 0 条 | 密钥是否配好；`llm` 是否可用（面板设置页会显示）；抽取依赖宿主已配置的模型 |
| 想临时开诊断路由 | `install.ps1 -Diagnostics`。⚠️ 那条路由**无鉴权**且能读文件/写凭据/改数据，排查完必须关掉并重启 |

---

## 7. 日常备份（重置之外）

**插件内一键备份**（推荐，含库本体）：

```powershell
# 工具侧
memory_backup {}                     # → <dataDir>/备份/backup-<时间戳>/{memory.db, pack/}
# 或面板「概览 → 一键备份」
```

- `memory.db` 是 `VACUUM INTO` 出来的**在线一致性快照**（含向量与 history），直接拷回去就能整库回滚；
- `pack/` 是可读文本包（不含向量，导入时重算）；
- 默认只留最近 5 份。

导出包随时可再生成：

```powershell
& $node dsh-memory\tools\make-migration-pack.mjs --out D:\backup\memory
```

`dsh-memory-data\.migration\memory.db` 也可直接拷走；它是标准 SQLite，用任何 SQLite 工具都能打开。

