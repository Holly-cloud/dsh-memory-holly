# 个人数据包（私密）

> 这是 `{{LABEL}}` 的**第二部分**：个人数据。包里是真实记忆正文 —— **不要**提交到公开仓库、
> 不要贴到聊天里、不要放进任何会被同步到公共位置的地方。

打包时间 {{DATETIME}} · 源提交 `{{COMMIT}}` · 数据库 schema v{{SCHEMA}}。

> **命令写法**：下文用 Windows PowerShell 写法（`& $NODE` 表示用你找到的 Node 完整路径执行脚本，
> 例如 `& 'C:\...\node.exe' 2-personal-data/tools/restore.mjs`）。PowerShell 里变量不能直接当命令，
> 必须加 `&`；Linux/macOS 把 `& $NODE` 换成 `"$NODE"`。详见包根 `INSTALL.md` 开头的「命令写法」。

---

## 1. 一条命令还原（在**包根目录**执行）

```powershell
& $NODE 2-personal-data/tools/restore.mjs
```

- 默认动作（`--mode auto`）：**目标库不存在 → 落快照**（最完整）；**目标已有数据或正被 DSH 打开 → 合并**
  （只增不改，按正文 sha256 判重）；
- 写完自证：数字与 `data/counts.json` 里的期望对不上就非零退出，不会留一个「看起来成功」的半成品；
- 目标目录默认取 `$env:DSH_HOME/dsh-memory`；若 patch 里已有 dsh-memory 块，会跟随块里的 `dataDir`
  （**只认 dsh-memory 自己那块**，别的插件的 `dataDir` 不会被误认）。

**推荐顺序**：先跑它、再装插件（插件一装就会打开库；趁没打开时落快照最干净）。

---

## 2. 包里有什么

| 文件 | 内容 | 还原时 |
|---|---|---|
| `data/memory.db` | **库快照**：{{MEMORIES_ACTIVE}} 条记忆（含已删共 {{MEMORIES_TOTAL}}）+ {{VECTORS}} 条向量 + 历史 + 待审批次 + 变更单 + 副审阅区 + 设置 | snapshot 模式：整体替换目标库 |
| `data/pack/memories.jsonl` | **文本真源**：每条一行 `{id, text, metadata}`（不含向量） | merge 模式：按全文 hash 导入 |
| `data/pack/readable.md` | 同一批记忆的人读版（按来源分组） | 不参与还原，给人看/检索 |
| `data/pack/RESTORE.md` | 通用还原说明（走 agent 工具 `memory_import` 的那条路） | 备查 |
| `data/sidecars/batches.json` | **待审阅的记忆条目**：{{BATCHES}} 个待批批次、{{BATCH_ITEMS}} 条 pending 条目（含抽取时的原文上下文） | merge 模式：按原 id 写回 |
| `data/sidecars/keeper-plans.json` | **待处理变更单**：{{PLANS}} 张（state = open / handed） | merge 模式：写回并把记忆 id 映射到新 id |
| `data/sidecars/keeper-handoffs.json` | **副审阅区**：{{HANDOFFS}} 组待接手 | merge 模式：写回 |
| `data/sidecars/settings.json` | {{SETTINGS}} 个设置项：嵌入档案、仓管档案、活动空间等 | merge 模式：**只补缺的键**，不覆盖目标已有配置 |
| `data/counts.json` | 期望数字 + 包内每个文件的 sha256 | 还原前完整性校验 |
| `tools/restore.mjs` / `restore-core.mjs` | 还原脚本 | 就是你在用的 |

> **包里没有任何密钥。** 设置里只有 `apiKeyRef`（引用名，如 `DASHSCOPE_API_KEY`），真 key 在 DSH
> 凭据库里。没有 key 也能还原：关键词检索、浏览、审阅都正常，只有语义检索与 LLM 抽取不可用。

---

## 3. 两种还原模式的区别（重要）

| | `snapshot`（快照替换） | `merge`（合并导入） |
|---|---|---|
| 记忆 id | **原样保留** | 新 id（原 id 记在 `meta.originalId`） |
| 向量 | **原样保留**（同模型同维度时开箱即用） | 不搬，按当前模型重算（面板「补齐」） |
| 历史 / 已删记忆 | 保留 | 不搬（只搬未删除的正文） |
| 待审条目 / 变更单 / 副审阅区 | 保留 | 保留（按原 id 写回；变更单里的记忆 id 会映射到新 id） |
| 目标已有数据 | **会被覆盖**（需 `--force`，且替换前自动备份旧库） | 只增不改，绝不覆盖 |
| DSH 运行中能不能做 | **不能**（必须完全退出） | 能 |

自动选择逻辑：

```
库不存在                 → snapshot
库为空 且 没被 DSH 打开   → snapshot
其余                     → merge
```

想强行指定：`--mode snapshot` / `--mode merge`；非空库要覆盖：
`--mode snapshot --force`（旧库先备份成 `memory.db.before-restore-<时间戳>`）。

---

## 4. 先看再做 / 只校验不写（在包根目录执行）

```powershell
& $NODE 2-personal-data/tools/restore.mjs --dry-run         # 报告将做什么，不写一个字节
& $NODE 2-personal-data/tools/restore.mjs --mode verify     # 只校验包完整性 + 看目标现状
& $NODE 2-personal-data/tools/restore.mjs --json            # 机器可读结果（给 agent 解析）
& $NODE VERIFY.mjs                                          # 整包核对：清单 sha256 + 快照库自洽
```

`--mode verify` 预期输出里：**完整性 OK**，且「期望」一行与下面一致：

```
期望：记忆 {{MEMORIES_ACTIVE}} 条（含已删共 {{MEMORIES_TOTAL}}）· 向量 {{VECTORS}} · 待审批次 {{BATCHES}} ·
      待审条目 {{BATCH_ITEMS}} · 变更单 {{PLANS}} · 副审阅区 {{HANDOFFS}}
```

---

## 5. 验收

还原脚本自己会核对数字；装完插件后再做这几条人工验收：

1. 面板「概览」：记忆条数 = **{{MEMORIES_ACTIVE}}**；
2. 面板「搜索」：搜一条你记得的记忆的开头几个字 → 能命中；
3. 面板「副仓管」：有 **{{HANDOFFS}}** 组待接手（若包里有）；
4. `memory_stats`：`activeSpace.missing` 应为 0（snapshot 模式且密钥/模型与包一致时）；
5. 挑一条记忆点开看正文 —— 与旧机器上一致（一字不差）。

---

## 6. 常见问题

| 现象 | 处置 |
|---|---|
| `DB_OPEN` | DSH 正开着库。**完全退出 DSH** 再跑；或改用 `--mode merge`（可运行中做） |
| `TARGET_NOT_EMPTY` | 目标库已有记忆。用 `--mode merge`；确认要覆盖才 `--mode snapshot --force`（会先备份旧库再替换） |
| `PACKAGE_CORRUPT` | 包在传输/解压中坏了：让对方重发。别自己改 `memories.jsonl` |
| `VERIFY_FAILED` | 还原后数字对不上。先 `--mode verify` 看目标；若目标是全新设备，重解压再还原一次 |
| `NO_PLUGIN`（merge 模式） | 找不到插件源码：确认 `../1-plugin/dsh-memory/` 在包里，或 `--plugin <路径>` |
| 还原后搜不到（只有关键词） | 向量没补齐：概览页看 `missing`，点「补齐」 |
| 想把数据也导回旧机器 | 同一个包，旧机器上 `--mode merge`（id 不同不影响检索；`meta.originalId` 可追溯） |
| 待审条目/变更单没回来 | 只有 merge 会搬这些（按原 id 写回）；snapshot 是全库替换，本来就在 |

---

## 7. 这个包是怎么生成的（可重现，在**插件仓库根目录**执行）

```powershell
& $NODE tools/make-portable-pack.mjs                    # 生成 ../release/<label>/ + .zip
& $NODE tools/make-portable-pack.mjs --no-git --no-zip  # 不上 .git、不打压缩包
```

打包器出包前会自证：快照可读且数字与活库一致、文本包能无损导入空库、附属表计数一致、
`src/host/*.js` 全部可 import、zip 回读一致、包里没有疑似密钥、快照旁没有 `-wal/-shm`
（出包前强制 checkpoint 并切回 `journal_mode=delete`）。任何一项不过就**拒绝出包**。

日常备份（不是这个包）：面板「概览 → 一键备份」→ `<dataDir>/备份/backup-<时间戳>/`（SQLite 在线快照 + 文本包）。
