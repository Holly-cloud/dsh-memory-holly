/**
 * dsh-memory · Phase 2：抽取 —— 把一段文本变成「值得长期记住的事实」候选。
 *
 * 设计要点（Phase 3–5 直接依赖）：
 * - 本模块**纯函数为主**（`buildExtractRequest` / `parseFacts` 无副作用），
 *   唯一的异步函数 `extractFacts` 只依赖注入的 `llm.chat`，不联网、不碰数据库；
 * - `parseFacts` 必须对模型的脏输出免疫：代码块围栏、前后解释文字、非法 JSON、
 *   非字符串元素、重复项，一律降级处理而**绝不抛错**（原项目实测踩过的坑）；
 * - 抽到的只是候选，**落库由审阅门（review.js）负责**，本模块一行都不写库。
 *
 * @module dsh-memory/host/extract
 */

import { partitionTransient } from './transient.js';

/**
 * 注入的 LLM 接口：`chat()` 返回模型输出的纯文本。
 *
 * @typedef {{ chat(request: { messages: { role: string, content: string }[], temperature?: number,
 *   maxTokens?: number }): Promise<string> }} LlmClient
 */

/** 通用抽取提示词：从文本里抽长期有效的事实。 */
export const EXTRACT_PROMPT = `你是记忆抽取器。请从给定文本里抽出「值得长期记住的事实」。

只抽这些（长期有效、以后还用得上的）：
- 身份与称呼：我是谁、怎么称呼对方、角色、所在地；
- 稳定偏好与习惯：口味、饮食、作息、爱好、审美、忌口；
- 重要关系：家人、朋友、同事、宠物，以及他们和本人的关系；
- 承诺与决定：本人拍板定下来的事、约定、目标、长期计划；
- 重要经历与日期：一起做过的事、纪念日、里程碑。

**不要记**（下面这几类一个字都不要抽，它们是**本次会话**的临时状态，不是长期事实）：
- 会话/任务态：本次对话的安排、分工、约定、待办、「接下来要做什么」、进度汇报；
- 工具/协作态：某个 teammate / subagent / 进程正在做什么、工具调用结果、待审区 / 变更单里在等什么、某个功能刚改完 / 待重启 / 待验收；
- 助手自身的立场与自述（「助手认为…」「我建议…」「它只负责…」）；
- **从助手的话里反推本人的拍板**：转录里「助手：」开头的行**只是上下文**。要记成「用户/本人拍板…」，
  必须能从「用户：」行里读到本人自己的话；助手汇报里转述过、提议过的，一律不算本人说过
  （真机 2026-10-08：助手在汇报里写的合并正文，被抓成「用户于…拍板」记进了库）；
- 一次性、当下有效的状态（「目前」「正在」「刚刚」「这轮」「暂定」）；
- 临时状态、公开信息、你自己的猜测（这条一直在）。

正例（该记）与反例（**不要记**）对照：
- ✅ 用户喜欢冰美式，忌口香菜 —— ❌ 用户与助手约好用 propose 流程处理这条记忆；
- ✅ 宝宝 08-12 拍板：中栏方案乙 —— ❌ 用户与助手约定：由助手做统一验收，验收后立刻重启；
- ✅ 用户习惯凌晨睡 —— ❌ 身边另有一位 teammate 在并行工作；
- ✅ 用户拍板统一了修改记忆的做法 —— ❌ 助手认为「效果好不好」只能由用户判断；
- ✅ 用户每年纪念日都去露营 —— ❌ 这轮先改代码，接下来再补测试。
- ✅ 用户看面板的习惯（2026-10-07）：只看待处理与检索，不看仪表盘页 —— ❌ 用户日常只用插件的四个页签：检索、仓管待审、待审、设置（既没锚点，页签清单本身还会变，将来会被当成永久通则）。

明确忽略：
- 元指令（「记住这个」「忘掉那个」「重复一遍」这类对你说的话）；
- 寒暄、客套、语气词、过程性闲聊；
- 一次性的技术操作细节（端口、路径、配置、报错、API、模型名）。

**自足与时效（违反这条比不记还危险）**：
- 每条都必须**脱离上下文也能读懂**：主语是谁、说的是什么范围、什么时候的事，全都要落在句子里；
- **会变的东西不许写成通则**：界面结构（几个页签 / 有哪些按钮 / 卡片怎么排）、数量、配置值、端口、版本号、
  模型名 —— 这类事实**必须带时间或版本锚点**（「截至 2026-10-07」「当时那版」）；给不出锚点就**不要抽**；
- 原文若只是**当下的使用快照**（「我最近只用…」），只抽其中**耐用的那半**（偏好 / 要求 / 习惯），
  把易变的那半（清单、数量、当前状态）丢掉。

输出要求：
1. 每条事实写成一句能独立看懂的中文陈述，不要编号、不要前缀、不要分类标签；
2. 不要复述原文，也不要把一句话拆成好几条；
3. 如果文本里没有任何值得长期记住的信息（例如纯寒暄、纯报错排查），**返回空数组 []**；
4. **只输出 JSON 数组**，例如 ["宝宝喜欢喝冰美式咖啡","周末打算去露营"]；
   不要输出任何解释、不要 Markdown 代码块围栏、不要在数组之外写任何一个字。`;

/** 聚焦抽取提示词：只抽「关于人」的信息，最多 8 条。 */
export const EXTRACT_FOCUSED_PROMPT = `你是记忆抽取器，这一轮只关心「人」，不关心技术细节。

请从给定文本里，只抽出下面 5 类事实：
- 关系：谁和谁是什么关系、怎么称呼、身边有谁；
- 情感：情绪、在意的事、喜欢或讨厌的感受；
- 偏好：口味、饮食、作息、习惯、审美等稳定偏好；
- 决策：本人拍板定下来的事（「就这个了」「决定了」「以后都用它」）；
- 共同经历：一起做过的事、约定、纪念日、里程碑。

明确排除（一条都不要抽）：
- 命令与操作指令（安装、重启、删除、部署之类）；
- 端口、路径、文件名、目录、配置项、环境变量；
- 报错信息、日志、堆栈；
- API、函数名、参数、模型名、版本号、依赖包名这类技术细节。

**不要记**（这几类与上面同等重要，**不要记**；它们是**本次会话**的临时状态）：
- 会话/任务态：本次对话的安排、分工、约定、待办、「接下来要做什么」、进度汇报；
- 工具/协作态：某个 teammate / subagent / 进程正在做什么、工具调用结果、待审区 / 变更单里在等什么、某个功能刚改完 / 待重启 / 待验收；
- 助手自身的立场与自述（「助手认为…」「我建议…」「它只负责…」）；
- **从助手的话里反推本人的拍板**：转录里「助手：」开头的行**只是上下文**。要记成「用户/本人拍板…」，
  必须能从「用户：」行里读到本人自己的话；助手汇报里转述过、提议过的，一律不算本人说过
  （真机 2026-10-08：助手在汇报里写的合并正文，被抓成「用户于…拍板」记进了库）；
- 一次性、当下有效的状态（「目前」「正在」「刚刚」「这轮」「暂定」）；
- 临时状态、公开信息、你自己的猜测。

正例（该记）与反例（**不要记**）对照：
- ✅ 用户喜欢冰美式 —— ❌ 用户与助手约定：先改代码再重启；
- ✅ 宝宝 08-12 拍板：中栏方案乙 —— ❌ 由助手做统一验收；
- ✅ 用户习惯凌晨睡 —— ❌ 另有一位 teammate 在并行工作；
- ✅ 用户拍板统一了修改记忆的做法 —— ❌ 助手认为「效果好不好」只能由用户判断。
- ✅ 用户对面板 UI 的要求（2026-10-07）：直观、每个可见控件都不多余 —— ❌ 插件面板只有三个页签（会随版本变，且没锚点）。

**自足与时效（违反这条比不记还危险）**：
- 每条都必须**脱离上下文也能读懂**：主语是谁、说的是什么范围、什么时候的事，全都要落在句子里；
- **会变的东西不许写成通则**：界面结构（几个页签 / 有哪些按钮 / 卡片怎么排）、数量、配置值、端口、版本号、
  模型名 —— 这类事实**必须带时间或版本锚点**（「截至 2026-10-07」「当时那版」）；给不出锚点就**不要抽**；
- 原文若只是**当下的使用快照**（「我最近只用…」），只抽其中**耐用的那半**（偏好 / 要求 / 习惯），
  把易变的那半（清单、数量、当前状态）丢掉。

输出要求：
1. **最多 8 条**，宁缺毋滥，按重要性从高到低排列；
2. 每条写成一句能独立看懂的中文陈述，不要编号、不要解释；
3. 文本里没有「关于人」的信息时，**返回空数组 []**；
4. **只输出 JSON 数组**，不要 Markdown 代码块围栏、不要任何多余文字。`;

/**
 * 组装一次抽取请求。
 *
 * 一律 `temperature: 0`：抽取是判定任务，要的是稳定可复现，不是文采。
 *
 * @param {{ text?: string, focused?: boolean, maxTokens?: number }} [input] 输入
 * @returns {{ messages: { role: string, content: string }[], temperature: number, maxTokens: number }} 请求
 */
export function buildExtractRequest({ text = '', focused = false, maxTokens = 2000 } = {}) {
  const system = focused ? EXTRACT_FOCUSED_PROMPT : EXTRACT_PROMPT;
  const limit = Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : 2000;
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(text ?? '') },
    ],
    temperature: 0,
    maxTokens: limit,
  };
}

/**
 * 从模型输出里解析事实数组。**绝不抛错**。
 *
 * 容错顺序：
 * 1. 非字符串输入 → `[]`；
 * 2. 用 `/\[[\s\S]*\]/` 取**第一个** `[` 到**最后一个** `]` 之间的片段
 *    （因此代码块围栏、前后解释文字都能被剥掉）；
 * 3. `JSON.parse` 失败或结果不是数组 → `[]`；
 * 4. 只保留字符串元素，逐条 `trim()`，丢弃空串；
 * 5. 按出现顺序去重（保留第一次出现的位置）。
 *
 * @param {unknown} raw 模型输出的纯文本
 * @returns {string[]} 事实数组（可能为空）
 */
export function parseFacts(raw) {
  if (typeof raw !== 'string') return [];

  const match = raw.match(/\[[\s\S]*\]/);
  if (match == null) return [];

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  /** @type {string[]} */
  const facts = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text.length === 0) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    facts.push(text);
  }
  return facts;
}

/**
 * 把未知异常折成一句话。
 *
 * @param {unknown} err 异常
 * @returns {string} 描述
 */
function describeError(err) {
  if (err == null) return '未知错误';
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

/**
 * 调用一次 LLM 抽取事实。
 *
 * 失败一律返回 `ok: false` 并把原因放进 `error`（**不抛错**，调用方靠 `ok` 分支即可）。
 * `text` 为空/全空白时**不调用模型**，直接失败返回。
 *
 * ## 第二道闸（`excludeTransient`，默认开）：三分类
 * 提示词里写了「不要记」清单，但**提示词不是保证**：模型照样会吐会话态 / 工具态 / 助手自述。
 * 所以解析出的事实还要过 `partitionTransient()`（`src/host/transient.js`）那道**确定性**分类
 * （2026-10-07 起是**三分类**，不再是「临时 / 不临时」二分类）：
 * - `durable`（长期信号）→ 进 `durable`（也是 `facts` 的一部分）；
 * - `transient`（会话 / 工具 / 进度态）→ 进 `dropped`（带命中理由），由调用方计数后**丢弃**；
 * - `uncertain`（拿不准）→ 进 `deferred`，由调用方**并进待审区**，**不丢**。
 *
 * `facts` 是 `durable + uncertain` 的**原顺序**合并（即「过了临时闸、还留在手上的条」），
 * 待审路径直接拿它建批次；直存路径按 `durable` / `deferred` 分流。
 * 这是**启发式、宁漏不误杀**（判据与边界见 `transient.js` 的文件注释）。
 * 传 `excludeTransient: false` 可只靠提示词（配置 `capture.dropTransient: false` 走这条路）。
 *
 * @param {{ llm?: LlmClient | null, text?: string, focused?: boolean, maxTokens?: number,
 *   excludeTransient?: boolean }} input 输入
 * @returns {Promise<{ ok: boolean, facts: string[], durable: string[], raw: string,
 *   dropped: { text: string, hit: string }[], deferred: { text: string, hit: string }[],
 *   error: string | null }>} 结果
 */
export async function extractFacts({ llm, text, focused = false, maxTokens = 2000, excludeTransient = true } = {}) {
  if (llm == null || typeof llm.chat !== 'function') {
    return { ok: false, facts: [], durable: [], raw: '', dropped: [], deferred: [], error: '缺少 llm 接口：需要注入带有 chat() 的客户端' };
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, facts: [], durable: [], raw: '', dropped: [], deferred: [], error: 'text 为空或全是空白，没有可抽取的内容' };
  }

  let raw;
  try {
    raw = await llm.chat(buildExtractRequest({ text, focused, maxTokens }));
  } catch (err) {
    return { ok: false, facts: [], durable: [], raw: '', dropped: [], deferred: [], error: `调用模型失败：${describeError(err)}` };
  }

  const rawText = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const parsed = parseFacts(rawText);
  if (excludeTransient === false) {
    return { ok: true, facts: parsed, durable: parsed, raw: rawText, dropped: [], deferred: [], error: null };
  }
  const { kept, dropped, deferred, staged } = partitionTransient(parsed);
  return {
    ok: true,
    facts: /** @type {string[]} */ (staged),
    durable: /** @type {string[]} */ (kept),
    raw: rawText,
    dropped,
    deferred,
    error: null,
  };
}
