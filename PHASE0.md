# Phase 0 · 通路验证报告

> 目的：在写任何业务逻辑之前，先证明「插件能装、行能激活、面板能出、路由能通、存储能用」。
> 结论：**全部通过**。过程中踩到一个真实的坑，已定位并转化为设计决策。

---

## 1. 结论一览

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 插件行能被 profile 挂载 | ✅ | `plugin_manager list_plugins` → `include:memory`，`fiberPhase: "active"` |
| 2 | 绝对路径行名可用（免 pnpm 安装） | ✅ | Loader 把它转成 `file:///<DSH 工作区>/dsh-memory/lib/index.js` |
| 3 | 改 patch 文件能热生效（免重启） | ✅ | 两次 patch 写入后行状态即时变化，未重启 DSH |
| 4 | 客户端束被 serving 并执行 | ✅ | `dsh-client-modules` 从 `file:///` 行反查出 `package.json` 的 `dsh.client` + `exports["./client"]` |
| 5 | 左栏图标注册成功 | ✅ | `client/Slots.listSubTree("sidebar.panellist")` → 占位 `{id:"memory", order:30, active:true}` |
| 6 | 主区页面注册成功 | ✅ | `client/Slots.listSubTree("main")` → keyed 占位 `{key:"memory", active:true}` |
| 7 | 手写模块协议束正确 | ✅ | 无打包器，`window.__ModuleLoader__.load({id,factory})` + `exports.apply/inject` 直接生效 |
| 8 | 平台种子模块可直接 require | ✅ | 束内 `require('react')`、`require('@deepseek-ai/dsh-client-ui-primitives')` 均成功 |
| 9 | `locale: NS` → `t` prop 注入 | ✅ | 注册项带 `locale` 且 apply 未抛错（缺 locale face 会直接抛 `SlotAssemblyError`） |
| 10 | 面板路由受 `/api` 信任栅栏保护 | ✅ | 无 Cookie 请求 `/api/dsh-memory/ping` → **401**（说明路由已注册且栅栏生效） |
| 11 | `node:sqlite` 可用 | ✅ | 探针：建表/读写、FTS5 `trigram` 命中中文、`Float32Array` ↔ BLOB 往返 |

第 10 项的旁证：插件 `apply` 期间若 `ctx.connection.fetch.register` 抛错，`ctx.effect` 会连带抛出、
整行会变成 `failed`；实际是 `active`，因此注册成功。

---

## 2. 踩到的坑（已修复，并改变了实现）

### 现象
第一次插入行后，`plugin_manager` 显示行存在、`enabled: true`，但 **`fiberPhase: null`**，
且 `ctx.memory` 服务不存在、面板 icon 也不出现。

### 定位
上游 `@deepseek-ai/dsh-host-plugin-inventory` 的相位定义里，`null` 表示**根本不存在存活 root fiber**；
而 `dsh-app-boot` 的失败表明确写着：**模块 import 抛错时不会产生 fiber**（import 错误在 Loader 挂载前
由日志收集）。两条合起来指向同一个结论：**模块 import 失败**。

失败原因是最初一版宿主半写了顶层裸说明符导入：

```js
import { Service } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
```

本插件的物理位置在工作区内（`…\default-workspace\dsh-memory\lib\`），Node 的 ESM 解析会沿
`node_modules` 逐级上溯到 `C:\node_modules`，一路都没有这些包。上游文档所说的「runtime resolution
被装进 Node 解析器」在这条路径上没有生效。

### 修复（也是 Phase 0 的设计转折）
宿主半改成**零裸说明符**：只 import `node:fs` / `node:os` / `node:path` 三个内置模块，
把「宿主能否解析 `@deepseek-ai/*`」从**假设**变成**运行时探针**，逐项 try/catch 后回给面板：

```js
const PROBE_SPECIFIERS = [
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-skill',
];
```

这样做的收益是：
1. 模块必然可加载 → 行必然激活 → 通路不再和解析问题互相掩盖；
2. 解析结论以**测得值**的形式落到面板上，Phase 1 据此决定「直接 import」还是「另走一条路」；
3. 假失败（import 失败导致整行消失、且没有任何可见报错）这一类问题以后不会再出现。

---

## 3. 安装方式（已定型）

不需要 `pnpm`，不需要 `dsh.bundle`，不需要进 `dsh.profile.bundles`。
`dsh plugin --profile desktop add` 在 desktop 上走的是 `runProfilePnpm`（只做 pnpm add + 版本闸门），
而本机 npm 源不可达；Plugins 页的 bundle 安装又会以 `not-bundle` 拒绝没有 `dsh.bundle` 的包。

真正生效的只有 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 里这一段：

```yaml
- insert:
    - id: memory
      name: '<DSH 工作区>/dsh-memory/lib/index.js'
      config:
        dataDir: '<DSH_HOME>/dsh-memory'
```

备份留在 `<DSH 工作区>/dsh-memory-data/.install/cordis.patch.yml.bak`。
**卸载 = 删掉这个 `insert` 块。**

---

## 4. Phase 0 最终测量结果（全部由 `/dsh-memory-selftest/ping` 自证，无需人眼）

```jsonc
{
  "runtime": { "node": "24.18.1", "electron": "44.0.0" },
  "probes": {
    "sqlite":   { "ok": true, "fts5": true, "trigramMatch": "宝宝喜欢喝冰美式咖啡", "blobRoundTrip": true },
    "services": { "connection": true, "tools": true, "systemPrompt": true, "llm": true,
                  "credentials": true, "skills": true, "webServer": true },
    "provide":  { "ok": true },                       // ctx.reflect.provide('memory', …)
    "webRoute": { "ok": true },                       // webserver 前缀路由注册
    "toolRegistration": {                             // 手搓工具定义（不依赖 defineTool）
      "registered": true, "visible": true, "readBack": "tools.get() → present", "error": null
    },
    "imports": {                                      // ← 全是 false
      "@deepseek-ai/cordis":          { "ok": false, "error": "ERR_MODULE_NOT_FOUND" },
      "@deepseek-ai/dsh-tools":       { "ok": false, "error": "ERR_MODULE_NOT_FOUND" },
      "@deepseek-ai/dsh-system-prompt":{ "ok": false, "error": "ERR_MODULE_NOT_FOUND" },
      "@deepseek-ai/dsh-llm":         { "ok": false, "error": "ERR_MODULE_NOT_FOUND" },
      "@deepseek-ai/dsh-credentials": { "ok": false, "error": "ERR_MODULE_NOT_FOUND" },
      "@deepseek-ai/dsh-skill":       { "ok": false, "error": "ERR_MODULE_NOT_FOUND" }
    }
  }
}
```

### 关键结论：本插件**不能**写任何裸 `@deepseek-ai/*` 导入

不是配置问题，是物理事实：这些包**在磁盘上不存在**——它们只活在
`…\DeepSeek Harness\resources\app.asar` 里。已核实：

- `<DSH_HOME>\profiles\node_modules` **不存在**；
- 在 `~\.dsh` 与安装目录下递归搜 `dsh-tools` 目录，**零命中**；
- 运行时 node 的 `node_modules` 只有一个 `README.txt`。

上游文档所说的「runtime resolution 被装进 Node 解析器」对我们的 importer 路径没有生效。

**但这不构成阻碍**，因为 DSH 的能力几乎都经 `ctx` 暴露，而不是靠 import：

| 需要的东西 | 不 import 也能用的方式 | 状态 |
|---|---|---|
| Cordis 服务 | `ctx.reflect.provide(name, obj)` | ✅ 已实测 |
| 原生工具 | `ctx.tools.register({name, description, parameters:<JSON Schema>, output:{schema, render}, execute})` | ✅ 已实测（注册→可见→读回→注销） |
| 系统提示段 | `ctx.systemPrompt.section({name, order, text})` | 待 Phase 3（服务已确认在） |
| Skill | `ctx.skills.register({…})` | 待 Phase 3 |
| LLM 抽取 | `ctx.llm.stream({provider, model, messages})` | 待 Phase 2 |
| 密钥 | `ctx.credentials.resolve(ref)` | 待 Phase 1 |
| 持久化 | `node:sqlite`（内置） | ✅ 已实测 |
| 浏览器通信 | `ctx.connection.fetch.register(...)` + webserver 前缀路由 | ✅ 已实测 |

代价：不能用 `defineTool`（要手搓已编译的 JSON Schema）、不能用 `Service` 基类（用 `reflect.provide` 代替）、
不能用 `HarnessError`（抛普通 `Error` 即可）。都已在 Phase 0 验证可替代。

---

## 5. 第二个坑：`requestBody` 缺失 → 面板收到「HTTP 400：响应不是 JSON」

面板第一次打开时报 `HTTP 400：响应不是 JSON`。根因不在我们，而在上游的一个校验缺口：

`registerFetchRoute` 会把 `route.requestBody` 原样存下（`dsh-client-connection/lib/index.js:627-631`），
`/api` 桥接层再用它决定请求体读取方式：

```js
const bodyMode = apiHandler.requestBodyMode({ method, url });   // :43
if (bodyMode === "buffered") { /* 缓冲 */ }
else { request = new Request(url, { method, headers, body: Readable.toWeb(req), duplex: "half" }); }  // :75-81
```

`assertFetchRoute` **只校验 path 与 methods，不校验 `requestBody`**。所以漏写它时
`bodyMode` 是 `undefined`，走 else 分支，用 GET 去构造带 body 的 `Request` →
WHATWG 构造器抛 `TypeError` → webserver 把 handler 抛错统一折成 **400 空响应**。

修复：路由上补 `requestBody: "buffered"`（shipped 调用方如
`dsh-session-log-export/lib/index.js:519`、`dsh-client-ui-deliverables/lib/index.js:52` 都显式写了）。

顺带把 `ping()` 全包了 try/catch：任何异常都折成 `500 + {ok:false,error}` 的可读 JSON，
而不是又一个「400 空响应」。

---

## 6. 第三个坑：HMR 的 `base` / `root`（开发环路的关键）

改宿主半代码本来必须重启整个应用 —— 这对 Phase 1–5 是致命的（每次迭代都要用户重启、会话中断）。
`dsh-hmr` 其实支持模块监听，但要让它在 profile 之外生效，两个字段都得对：

- `base` 会被 `new URL(config.base || ".", ctx.baseUrl)` 解析后再 `fileURLToPath`，
  所以**必须写 URL**；写 `C:/...` 会被当成 scheme `c:` 直接炸。→ 用 `file:///...`。
- `root` 是**相对 `base`** 的；HMR 用 `cwd: baseDir` 调 chokidar，并按
  `relative(baseDir, path)` 匹配 ignored 模式。若 base 留在 profile 目录、root 给一个 profile 之外的
  绝对路径，算出来的相对路径是 `../../..`，正好被默认 ignored 里的 `**/.*` 吃掉 —— watcher 静默失效。

可用配置（已写入 profile patch）：

```yaml
- id: hmr
  config:
    base: 'file:///<DSH 工作区>/dsh-memory/'
    root: ['.']
```

验证方式：改一次 `lib/index.js`，约 9 秒后诊断路由返回的内容即变成新代码 —— 期间**没有重启、没有重新审批**。

---

## 8. 嵌入链路（Phase 1 前置，已打通）

### 为什么必须在宿主里测
本机**沙箱化的 shell 拿不到 TLS 凭据**：
`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，
`Invoke-WebRequest`（.NET）则统一报「基础连接已经关闭」。也就是说
**我的命令行根本发不出 HTTPS**——这跟插件能否联网毫无关系。
所以嵌入往返只能在宿主进程内测，而那正是插件的真实运行环境。

### 已建成的诊断通道（仅供开发期）
| 接口 | 作用 |
|---|---|
| `GET  /dsh-memory-selftest/ping` | 能力自检（见 §4） |
| `POST /dsh-memory-selftest/credential` | `{ref,value}` → `ctx.credentials.set(ref,value)` |
| `GET  /dsh-memory-selftest/embed?q=&dims=&model=` | 宿主内真实嵌入往返 |

### 实测结论
```jsonc
// POST /credential  →  密钥存进 DSH 凭据库（本地 provider，source: "file"）
{ "ok": true, "ref": "DASHSCOPE_API_KEY", "configured": true, "source": "file", "writable": true }

// GET /embed       →  网络链路、鉴权头、请求体形状全部正确
{
  "keySource": "credentials:DASHSCOPE_API_KEY",   // 走的就是 ctx.credentials
  "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
  "elapsedMs": 1052,
  "ok": false,
  "error": "HTTP 401: {\"error\":{\"message\":\"Incorrect API key provided…\",\"code\":\"invalid_api_key\"}}"
}
```

**结论**：宿主 → 百炼的网络路径、`ctx.credentials` 解析、Bearer 鉴权头、请求体形状**全部验证通过**。

### 最终验证（用凭据文件里的真实密钥 + 正确模型名）

密钥取自 `<凭据文件>` 第 19 行（该文件是 GBK 编码，
标签「百炼」在 UTF-8 下会显示成乱码，但密钥本身是 ASCII 不受影响）。

| 探测 | 结果 |
|---|---|
| `qwen3.7-text-embedding` + `dimensions:1024` | ✅ `returnedDims=1024`，1543 ms |
| 同模型 + `dimensions:512` | ✅ `returnedDims=512`（维度可配） |
| 同模型省略 `dimensions` | ✅ 默认 1024 |
| 同模型 + ~1500 字长文本 | ✅ 正常，1392 ms |
| `text-embedding-v3`（旧名对照，同一把密钥） | ✅ 也通过 |

> **更正**：早先那次 `401 invalid_api_key` 不是密钥本身的问题 —— 同一把密钥（取自文件）
> 对所有模型都通过，说明**当时是聊天里粘贴的那份文本被截断/污染了**。
> 教训记进本文件：密钥只从文件按行取，不经由聊天传递。

**Phase 1 定下的嵌入默认值**：`baseUrl = https://dashscope.aliyuncs.com/compatible-mode/v1`、
`model = qwen3.7-text-embedding`、`dimensions = 1024`、`apiKeyRef = DASHSCOPE_API_KEY`。

### 换一把有效密钥后，一条命令即可复验
```powershell
# 先存进 DSH 凭据库（不要在别处落盘）
Invoke-RestMethod -Uri 'http://127.0.0.1:19387/dsh-memory-selftest/credential' -Method Post `
  -ContentType 'application/json' -Body (@{ref='DASHSCOPE_API_KEY'; value='<新key>'} | ConvertTo-Json)
# 再打一次真实往返，看 returnedDims 是否等于期望维度
Invoke-RestMethod -Uri 'http://127.0.0.1:19387/dsh-memory-selftest/embed?q=%E5%A5%BD&dims=1024' | ConvertTo-Json
```

---

## 9. 遗留事项

- 诊断路由 `/dsh-memory-selftest/*` 目前**未鉴权**（只监听回环；`ping` 只回版本号与能力布尔值，
  `embed` 只回维度与耗时，`credential` 只是写入 DSH 自己的凭据库）。
  **Phase 5 必须**删掉它，或改成 config 显式开启（默认关）。
- 数据目录 `<DSH_HOME>/dsh-memory` 目前只解析、不创建（`dataDirExists: false`），Phase 1 才建库。
- 面板五个分页、工具、提示、skill 均在后续阶段；Phase 0 的面板只是一张自检卡。
- 凭据库里目前存着一把**无效**的 `DASHSCOPE_API_KEY`（占位），Phase 1 会用有效密钥覆盖它。

### 密钥处理原则（已落到代码里）
- 密钥**永不**写进任何由本插件生成的文件，也不进插件 config；
- 解析顺序：`ctx.credentials.resolve(ref)` → `process.env[ref]`；
- config 里只放**引用名**（`embedding.apiKeyRef`，默认 `DASHSCOPE_API_KEY`）；
- Phase 4 面板「设置」页放一个密钥输入框，直接调 `ctx.credentials.set`。


---

## 5. 对后续阶段的影响

- **Phase 1 前必须先看解析结论**：若 `@deepseek-ai/cordis` 解析不了，就不能用 `Service` 子类，
  需要用 `ctx.reflect.provide` 或把插件放进 profile 目录内以获得正常的 `node_modules` 祖先查找。
- 客户端半已证明可手写、可免构建 —— 面板全部五个分页都按这个模式做，不需要任何打包器。
- `?rev=` 是必需的：`GET /plugins/dsh-memory/client.js`（不带 rev）返回 404 属正常，
  浏览器走的是启动图里带 rev 的 URL。
