# 部署手册（给执行部署的 agent）

> **你的任务**：在这台设备上把 `dsh-memory` 插件装好，把个人数据**一字不差**恢复，
> 并让项目处于「可继续开发」的状态。按 §0 → §6 顺序做；每一步都给了**怎么确认成功**。
> 任何一步的输出与预期不符，先看 §7 排障表，**不要硬往下走**。

包信息：`{{LABEL}}` · 打于 {{DATETIME}} · 源提交 `{{COMMIT}}` · schema v{{SCHEMA}} ·
数据：记忆 {{MEMORIES_ACTIVE}} 条 / 待审条目 {{BATCH_ITEMS}} 条 / 变更单 {{PLANS}} 张 / 副审阅区 {{HANDOFFS}} 组。

## 命令写法（先看这段，能省掉一半排障）

下文命令块统一用 **Windows PowerShell** 写法。两条规则：

1. **变量当命令必须加调用运算符 `&`**：

   ```powershell
   $NODE = 'C:\Users\你\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
   & $NODE VERIFY.mjs          # ✅ PowerShell
   $NODE -v                    # ❌ 报 Unexpected token '-v'
   ```

2. **环境变量是 `$env:DSH_HOME`**（不是 `$DSH_HOME`；后者在 PowerShell 里是空字符串，检查会静默失败）。

Linux / macOS 下把 `& $NODE` 换成 `"$NODE"`（或直接 `node`），把 `$env:DSH_HOME` 换成 `"$DSH_HOME"` 即可。

---

## §0 先判定你属于哪种情况（30 秒）

| 情况 | 判定方法 | 你该走 |
|---|---|---|
| **A. 全新部署**（最常见） | 目标设备**没装过** dsh-memory | 全走 §1–§6 |
| **B. 已装过插件，库是空的** | patch 里有 `id: memory`，但面板里 0 条记忆 | §1 → §2（**DSH 完全退出**时脚本才选 snapshot）→ §3 跳过 → §4 |
| **C. 已装过插件，且用户已有自己的记忆** | 面板里已有记忆 | §1 → §2.3 **merge**（只增不改，绝不覆盖）→ §3 跳过 → §4 |

> 决定「能不能用快照覆盖」的只有一条：**库是不是空的、有没有被 DSH 打开**。
> 还原脚本自己会判断，`--mode auto` 默认就是安全的；不确定时先跑 `--dry-run`。
> ⚠️ 情况 B 如果 **DSH 正开着**（存在 `-wal/-shm`），auto 会退化成 **merge**：记忆条数对，
> 但向量为 0、需要 §5.2 补齐。想要「开箱零缺失」，就先完全退出 DSH 再还原。

---

## §1 前置检查

### 1.1 找到一个带 `node:sqlite` 的 Node（≥ 24）

本包所有脚本只用 Node 内置模块（`node:sqlite` 需要 Node ≥ 22.5，**推荐 24**）。
先试系统里的：

```powershell
node -v          # 期望 v24.x（v22.5+ 也行，但 v24 最稳）
```

没有或不达标时，**DSH 自带的运行时里一定有**：

```powershell
# Windows PowerShell
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe"
```

```bash
# Linux / macOS
ls ~/.dsh/dsh-runtimes/*/dependencies/node/bin/node
```

把找到的完整路径赋给 `$NODE`（PowerShell 见文首「命令写法」；下文一律写 `& $NODE`）。

### 1.2 确认 DSH 已装好、并**至少启动过一次**

```powershell
# DSH_HOME 默认：Windows %USERPROFILE%\.dsh；Linux/macOS ~/.dsh；设了 DSH_HOME 就用它
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Get-ChildItem "$DSH_HOME\profiles"                                  # 期望有 desktop / default / web … 之一
Test-Path "$DSH_HOME\profiles\desktop\cordis.patch.yml"             # 期望 True（profile 名按实际替换）
```

`cordis.patch.yml` 不存在 = DSH 还没初始化 profile：**先启动一次 DSH**（它会自己建），再回来。

### 1.3 校验包完整性（只读，不写一个字节）

```powershell
& $NODE VERIFY.mjs                                       # ① 整包核对：文件清单 + 快照库自洽
& $NODE 2-personal-data/tools/restore.mjs --mode verify  # ② 看目标机器现状与期望数字
```

预期：

```
包：<包根目录>/2-personal-data
  导出于 …，标签 …（…）
  期望：记忆 {{MEMORIES_ACTIVE}} 条（含已删共 {{MEMORIES_TOTAL}}）· 向量 {{VECTORS}} · 待审批次 {{BATCHES}} · 待审条目 {{BATCH_ITEMS}} · 变更单 {{PLANS}} · 副审阅区 {{HANDOFFS}}
  完整性：OK（n 个文件）
  目标库：<DSH_HOME>/dsh-memory/memory.db
    不存在（全新部署）        ← 或显示目标现状
```

完整性不是 OK 就**停**：包在传输中坏了，让对方重发，别自行修补。

---

## §2 还原个人数据（本包最不可替代的部分）

### 2.1 先看一眼它打算做什么（可选但推荐）

```powershell
& $NODE 2-personal-data/tools/restore.mjs --dry-run
```

### 2.2 正式还原

```powershell
& $NODE 2-personal-data/tools/restore.mjs
```

预期输出（全新设备）：

```
✓ 包完整性 OK（n 个文件 sha256 全部一致）
· 目标数据目录：<DSH_HOME>/dsh-memory
· 还原模式：snapshot（目标库不存在：直接落快照，最完整）
· 目标现状：库还不存在（全新部署）
✓ 快照已落盘：<DSH_HOME>/dsh-memory/memory.db

✓ 还原完成（snapshot）
  记忆 {{MEMORIES_ACTIVE}} 条 · 向量 {{VECTORS}} · 待审批次 {{BATCHES}}（待审条目 {{BATCH_ITEMS}}）· 变更单 {{PLANS}} · 副审阅区 {{HANDOFFS}} · 设置 {{SETTINGS}}
```

**数量必须与上面这份一致**（脚本自己会对比，不一致会直接报 `VERIFY_FAILED` 并非零退出）。

> 为什么先还原、后装插件：插件一装好就会打开 `<dataDir>/memory.db`。趁它还没打开，
> 把快照直接落到位置最干净 —— 不用「先建空库、再想办法替换」，也不用重算 {{VECTORS}} 条向量。

### 2.3 三种模式（脚本会自动选，也可显式指定）

| 模式 | 做什么 | 什么时候用 | 风险 |
|---|---|---|---|
| `auto`（默认） | 库不存在或空且没被打开 → snapshot；否则 → merge | 永远先试它 | 无 |
| `snapshot` | 用快照**整体替换**目标库（含向量/历史/原 id） | 全新设备、空库 | 覆盖非空库要 `--force`；DSH 开着会报 `DB_OPEN` |
| `merge` | 只把记忆正文 + 待审条目 + 变更单 + 副审阅区 **合并**进现有库（按正文 sha256 判重） | 用户已有记忆、或 DSH 开着不方便退 | 记忆会换新 id、向量要重算 |

几条硬规则：

- **目标库非空**：`snapshot` 会拒绝（`TARGET_NOT_EMPTY`）；确实要覆盖就
  `--mode snapshot --force`（脚本会先把旧库备份成 `memory.db.before-restore-<时间戳>`，
  然后再替换；备份就在数据目录里，随时能拷回去）。
- **报 `DB_OPEN`**：说明 DSH 正开着库（存在 `-wal/-shm`）。要么**完全退出 DSH** 再跑，
  要么用 `--mode merge`（合并可以在 DSH 运行时做）。
- **dataDir 不是默认路径**：脚本只读 patch 里 **dsh-memory 自己那块** 的 `dataDir` 自动跟随
  （别的插件的 `dataDir` 不会被误认）；也可 `--data-dir <路径>` 显式给。

### 2.4 目标 dataDir 与安装器保持一致

若你用了 `--data-dir` 自定义路径，**§3 装插件时必须传同一个**：

```powershell
& $NODE 1-plugin/dsh-memory/tools/install.mjs --data-dir <同一个路径>
```

---

## §3 安装插件

### 3.1 一条命令

```powershell
& $NODE 1-plugin/dsh-memory/tools/install.mjs
```

预期：

```
✓ 已写入 patch
  patch   : <DSH_HOME>/profiles/<profile>/cordis.patch.yml
  profile : desktop
  entry   : <包根目录>/1-plugin/dsh-memory/lib/index.js
  dataDir : <DSH_HOME>/dsh-memory
  backup  : …cordis.patch.yml.bak-<时间戳>
```

- **幂等**：重复跑只刷新那一块，不会出现两条同 id 的 row；
- **原子写 + 自动备份**：写前先备份，写到临时文件再改名，改坏不了 profile；
- **换行**：patch 若原本是 CRLF，安装/卸载后会统一归一为 LF（内容不变，语义不变；
  若你在 git 里看到整文件 diff，是换行差异）；
- 多个 profile 时用 `--profile <名字>` 指定；只想看会改什么用 `--dry-run --print`；
- Windows 也可以用老脚本 `install.ps1`：两者**格式相同、互相认得、可互相覆盖/卸载**
  （marker 注释文案不同，切换时会触发一次重写，有备份，无害）：
  ```powershell
  powershell -ExecutionPolicy Bypass -File 1-plugin\dsh-memory\tools\install.ps1
  ```
- 卸载：`& $NODE 1-plugin/dsh-memory/tools/install.mjs --uninstall`（只删块，不动插件文件与数据）。

### 3.2 确认 patch 内容

打开 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`，末尾应出现：

```yaml
# dsh-memory -- managed block (written by tools/install.mjs; do not edit by hand).
- insert:
    - id: memory
      name: '<包根目录>/1-plugin/dsh-memory/lib/index.js'
      config:
        dataDir: '<DSH_HOME>/dsh-memory'
```

`name` 必须是**绝对路径、正斜杠**。若路径里带空格/非 ASCII，YAML 已用单引号包好，不用改。

### 3.3 完全退出并重启 DSH

**不是刷新页面**。桌面版退出进程、web 版重启 `dsh web` 那个进程。
（部分版本 patch 层会热生效，但重启最稳；插件是宿主半模块，必须重新加载。）

### 3.4 Windows 解压注意

- 用资源管理器「全部解压」或 `Expand-Archive` 都行；`.git` 是普通目录，不会丢；
- 不要把包解到 `C:\Program Files\...`（写 patch 与数据目录都不需要管理员权限）。

---

## §4 验收（4 条全过才算部署完成）

| # | 检查 | 预期 |
|---|---|---|
| 1 | agent 侧 `plugin_manager(list_plugins)` | 能看到 `id=memory`，`fiberPhase=active`，`name` 指向包内 `lib/index.js` |
| 2 | 面板 | 左栏出现「记忆」图标；点开有 4 个页签：**仓管 / 副仓管 / 搜索 / 设置**，且「概览」能正常加载（说明宿主路由与客户端 bundle 都注册成功） |
| 3 | `memory_stats` | `memories` = **{{MEMORIES_ACTIVE}}**；嵌入配置与包一致时，`activeSpace.missing` 应为 0 |
| 4 | 面板「搜索」页 | 「最近入库」有内容；随便搜一个词（中文建议 ≥3 字）能出结果 |

> 不要用「不带 Cookie 请求 `/api/dsh-memory/state` 返回 401」当验收：DSH 在**路由之前**统一鉴权，
> 任意 `/api/*`（包括不存在的）都会 401，它只能证明鉴权栅栏在工作，证明不了路由已注册。
> 要看路由确实在，就用**带登录 Cookie** 的请求拿 200 JSON，或者直接看面板能不能正常加载。

---

## §5 恢复密钥 + 补齐向量（面板里做，不用命令）

1. **面板 → 设置 → 嵌入配置**：选中档案（包里带了 `{{SETTINGS}}` 个设置项，含档案定义与 `apiKeyRef` 引用名），
   粘贴密钥 → **保存**（走 `ctx.credentials.set`，只进 DSH 凭据库，不落本包任何文件）。
2. 回**概览**看「当前空间缺多少条」：
   - `missing = 0` → 什么都不用做（快照里带着向量，且模型/维度一致）；
   - `missing > 0` → 点**补齐**（merge 模式一定是这个情况：合并不搬向量，按当前模型重算）。
3. **LLM 预检**：抽取与仓管用的是**宿主已配置的模型**，不是本插件的 key。新设备上确保 DSH 自己
   有可用模型（面板设置页有「LLM 预检」可以一键确认）。
4. 若新设备的密钥引用名与包里的 `apiKeyRef` 不同（比如换成了 `OPENAI_API_KEY`），在设置里改档案的
   `apiKeyRef` 后保存即可 —— 旧名不影响已恢复的数据。

---

## §6 收尾：把「继续开发」接上

1. **读 `AGENT-HANDOFF.md`** —— 项目现状、架构地图、铁律、下一步都在里面；
2. 确认 git 可用（包内带 `.git`）：
   ```powershell
   cd 1-plugin/dsh-memory
   git log --oneline -3     # 期望 HEAD = {{COMMIT}}
   git status               # 期望干净（若你在外部改过文件会有差异）
   ```
3. 跑一遍回归，确认这台设备上能开发（**在插件目录里跑**）：
   ```powershell
   & $NODE tools/run-tests.mjs --client
   ```
   预期 `pass 373 / fail 0` + 客户端自检全部通过。（`node --test test/` 在受限环境会因
   `spawn EPERM` 失败 —— 那是环境限制，不是项目坏了；用这个包装脚本。）
4. 把部署结果报告给用户：插件 active、数据条数、密钥/向量状态、以及**这台设备上还没做的事**
   （通常是向量补齐、密钥）。

---

## §7 排障表

| 现象 | 原因 / 处置 |
|---|---|
| `Unexpected token '-v'` / `$NODE : 无法识别` | PowerShell 里变量不能直接当命令：写成 `& $NODE ...`（见文首「命令写法」） |
| `$DSH_HOME` 检查永远 False | PowerShell 里要用 `$env:DSH_HOME`，或先 `$DSH_HOME = $env:DSH_HOME` |
| `Invoke-WebRequest : 找不到参数 -SkipHttpErrorCheck` | 那是 PowerShell 7 的参数，Windows 自带 5.1 没有；改用带 Cookie 的 200 校验或面板验收 |
| `✗ 还原失败（DB_OPEN）` | DSH 正开着库（`-wal/-shm` 存在）。完全退出 DSH 后重跑；或 `--mode merge` |
| `✗ 还原失败（TARGET_NOT_EMPTY）` | 目标库已有记忆。用 `--mode merge` 合并；确认要覆盖才加 `--force` |
| `✗ 还原失败（PACKAGE_CORRUPT）` | 包传输损坏。让对方重发，别自己修文件 |
| `✗ 还原失败（VERIFY_FAILED）` | 还原后数字与包内期望不符。先 `--mode verify` 看目标现状；若目标被并发改过就重来 |
| `✗ 还原失败（NO_PLUGIN）` | merge 模式找不到插件源码。确认 `1-plugin/dsh-memory/` 在包里，或 `--plugin <路径>` |
| 装了插件左栏没有「记忆」 | patch 块在不在（§3.2）；DSH 是否**完全重启**；`plugin_manager(list_plugins)` 有没有 `id=memory` |
| 有 active 但面板打不开 | 浏览器 F5；看 DSH 控制台有无 `client-modules` 报错；`lib/client.js` 是否随包完整 |
| 面板里记忆是 0 | 还原时的 `--data-dir` 与 patch 里的 `dataDir` 是否**同一个**（§2.4）；patch 里别的手工行有没有覆盖 |
| 搜索只能关键词命中 | 向量没补齐（§5.2）或 `missing > 0`；中文查询建议 ≥3 字 |
| 抽取总是 0 条 | 宿主 LLM 不可用（§5.3）；或没有可用模型 |
| `node:sqlite` 报错 / `DatabaseSync is not a constructor` | Node 版本太低。换 DSH 自带运行时（§1.1） |
| 想临时开诊断路由 | `install.mjs --diagnostics`。⚠️ 那条路由**无鉴权**、能读文件/写凭据/改数据，排完必须 `--uninstall` 再装回来关掉 |

---

## 附录 A：不跑脚本时的手动安装（等价做法）

在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` **末尾**追加 §3.2 那段 YAML，
把 `name` 换成包内 `lib/index.js` 的绝对路径（正斜杠），`dataDir` 换成你想要的绝对路径。
改完**完全退出并重启 DSH**。卸载 = 删掉那一段。

## 附录 B：包的边界

- `1-plugin/dsh-memory/` 是完整仓库（可 `git pull` 跟进上游、可改、可提交、可再打包）；
- `2-personal-data/` 是私密数据，**不要**提交到任何公开仓库，也**不要**贴到聊天里；
- 包里**没有密钥**。凭据只在 DSH 凭据库（`<DSH_HOME>/.credentials.yaml`），本包不读它；
- 本包不是日常备份：日常用插件内「概览 → 一键备份」（`<dataDir>/备份/`）。本包用于搬家/交付。
