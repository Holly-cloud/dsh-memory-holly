/**
 * dsh-memory · 跟随 agent 运行的自主捕获：把「会话事件流」变成「值得抽取的转录片段」。
 *
 * 本模块是**纯逻辑**：不碰 ctx、不碰 store、不调 LLM —— 所以能直接单测。
 * 三件事：
 *   1. `messageText()`：从消息内容块里取纯文本（**只取 text 块**，忽略 reasoning / tool-call）；
 *   2. `ConversationBuffer`：按会话累积「用户说了什么 + 助手回了什么」，并在取走时清空；
 *   3. `shouldCapture()` / `isForeignSession()`：什么时候该抽、这段会话算不算「连入的那个 agent 自己」。
 *
 * 为什么要缓冲而不是每条消息都抽：抽取是一次 LLM 调用。攒够一定用户正文（`minChars`）
 * 再抽，既省钱又给模型足够上下文。触发点取 `turn/end`（durable 的回合结束事件）。
 *
 * @module dsh-memory/host/capture
 */

/** 触发抽取的默认最小新增用户字数。 */
export const DEFAULT_MIN_CHARS = 120;

/** 转录片段默认上限（字）。超出丢最旧的，保住最近上下文。 */
export const DEFAULT_MAX_CHARS = 4000;

/** 默认冷却（毫秒）：两次捕获之间至少间隔这么久。 */
export const DEFAULT_COOLDOWN_MS = 120_000;

/**
 * 从一条消息里取纯文本。
 *
 * 内容形状在不同版本/来源下可能是字符串或内容块数组，所以两种都认；
 * 只收 `type === 'text'` 的块 —— **reasoning（思考）与 tool-call 一律不要**：
 * 思考过程进转录会把抽取带偏（原版血泪坑 #2 的同一类问题）。
 *
 * @param {unknown} message 消息对象（`{content}`）或已解出的内容
 * @returns {string} 纯文本（可能是空串）
 */
export function messageText(message) {
  const content = message != null && typeof message === 'object' && 'content' in message ? message.content : message;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue;
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n').trim();
}

/**
 * 这条会话是不是「别的 agent」的（子代理 / 委派 / 团队里的其它会话）。
 *
 * 归属规则（用户 2026-10-06 明确）：
 * - **连入记忆系统的那个 agent 自己**的会话 → 抽出来的记忆**免审，直接入库**；
 * - 其他来源（子代理、被委派的会话）→ 进待审区，等那个 agent 审阅。
 *
 * @param {unknown} session 会话对象（读 `header`）
 * @returns {boolean} 是否「非连入方」
 */
export function isForeignSession(session) {
  const header = session != null && typeof session === 'object' ? session.header : null;
  if (header == null || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  if (header.parentSession != null) return true;
  const depth = Number(header.delegationDepth);
  return Number.isFinite(depth) && depth > 0;
}

/**
 * 这条事件是不是**人**说的话（`user/message` 且来源不是别人）。
 *
 * 为什么不能只看 `type`：`user/message` 是个**共用信封**，插件注入、工作区指令基线、
 * compaction 摘要、工具回灌全都走它，靠 `data.source.kind` 区分（宿主的渲染层用的是同一个判据：
 * `source.kind !== 'user'` 的一律当 context 展示）。读取侧拿它当查询词，所以必须只吃人的话。
 *
 * 判据取**宽**（2026-10-08 真机踩坑后定）：只有**明确**标了别的来源才排除；没标来源的按人来。
 * 因为两种错法的代价不对称 —— 多注一条最多是尾部多一行噪音（可见、可查），
 * 而少注一条是**功能静默失效**（Layer 1 空着、不报错，最难查的那种）。
 * 喂入计数见 `MemoryService.recallFeed`（`memory_stats.recall.feed`）。
 *
 * @param {{ type?: string, data?: any }} event 会话事件
 * @returns {boolean} 是否人的消息
 */
export function isHumanMessage(event) {
  if (String(event?.type ?? '') !== 'user/message') return false;
  const source = event?.data?.source;
  if (source == null || typeof source !== 'object') return true;
  return source.kind === 'user' || source.kind == null;
}

/** 往回扫多少条会话事件找最近那句人话（封住每步成本，也防翻出过期的那句）。 */
const HUMAN_SCAN_LIMIT = 400;

/**
 * 从**会话日志**里直接取最近一条人说的话（读取侧当查询词用）。
 *
 * 为什么要绕开 `session/event`（2026-10-08 真机实测）：宿主的 `user/message` 事件是在该步的
 * 提示词组装**之后**才发到插件手上的（实测：第 1 步组装 `09:33:46.772`、喂入 `09:33:46.878`），
 * 只靠事件会永远**慢一步** —— 第 1 步没有查询词，而"没有工具调用的回合"只有一步，
 * 于是那个回合永远拿不到本轮的召回（而拿到的是上一轮的问题，比空着更糟）。
 * 会话日志里的事件本来就在，这里只是**读**（宿主自己也是这么读的：`agent.session.surface.nodes`
 * + `agent.session.eventAt(seq)`）—— 拿不到内部结构就返回空串，调用方回落到事件游标。
 *
 * @param {unknown} session 会话对象（读 `surface.nodes` 与 `eventAt`）
 * @returns {string} 最近一条人话的正文（取不到 = 空串）
 */
export function lastHumanMessage(session) {
  try {
    if (session == null || typeof session !== 'object') return '';
    if (typeof session.eventAt !== 'function') return '';
    const nodes = session.surface?.nodes;
    if (nodes == null) return '';
    const seqs = Array.isArray(nodes) ? nodes : typeof nodes[Symbol.iterator] === 'function' ? Array.from(nodes) : [];
    // 倒着找：最新的一条通常在最后，命中即返回（不用扫全史）。**扫描有上限**：
    // 一是把每步的成本封住，二是防"最近 400 条里一句人话都没有"时翻出很久以前那句
    // （那是**过期的查询词**，比空着更糟）；真到那种状态就交回空串，由调用方回落到事件游标。
    const from = Math.max(0, seqs.length - HUMAN_SCAN_LIMIT);
    for (let index = seqs.length - 1; index >= from; index -= 1) {
      let event = null;
      try {
        event = session.eventAt(seqs[index]);
      } catch {
        continue;
      }
      if (!isHumanMessage(event)) continue;
      const text = messageText(event?.data);
      if (text !== '') return text;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 该不该在这一刻触发抽取。
 *
 * @param {{ userChars: number, minChars?: number, lastCaptureAt?: number, now?: number, cooldownMs?: number }} input 判定输入
 * @returns {{ capture: boolean, reason: string }} 判定结果（`reason` 用于诊断，别丢）
 */
export function shouldCapture({
  userChars,
  minChars = DEFAULT_MIN_CHARS,
  lastCaptureAt = 0,
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  const chars = Number(userChars) || 0;
  if (chars < Math.max(1, Number(minChars) || DEFAULT_MIN_CHARS)) {
    return { capture: false, reason: `用户正文新增 ${chars} 字，未到阈值 ${minChars}` };
  }
  const elapsed = Number(now) - Number(lastCaptureAt || 0);
  if (Number(lastCaptureAt) > 0 && elapsed < Math.max(0, Number(cooldownMs) || 0)) {
    return { capture: false, reason: `距上次捕获 ${Math.round(elapsed / 1000)}s，冷却中` };
  }
  return { capture: true, reason: `用户正文新增 ${chars} 字` };
}

/**
 * 一个会话的转录缓冲。
 *
 * 只累积两种事件：`user/message`（计入触发字数）与 `assistant/message`（只作为上下文）。
 * `take()` 取走之后缓存清空 —— 所以「只补离开期间新增的」这条增量语义在这里也成立。
 */
export class ConversationBuffer {
  /**
   * @param {{ maxChars?: number }} [options] 选项
   */
  constructor({ maxChars = DEFAULT_MAX_CHARS } = {}) {
    this.maxChars = Math.max(200, Number(maxChars) || DEFAULT_MAX_CHARS);
    /** @type {string[]} */
    this.lines = [];
    this.pendingUserChars = 0;
    this.totalUserChars = 0;
  }

  /**
   * 收一条会话事件。
   *
   * 返回的 `userChars` 是**缓冲里还没被抽走的用户正文字数**（不是本次事件的字数）——
   * 触发点 `turn/end` 本身不携带正文，阈值判定必须看累计值，否则永远抽不起来。
   *
   * @param {{ type?: string, data?: any }} event 会话事件
   * @returns {{ userChars: number, added: boolean }} 累计未抽取的用户字数、本次是否收进内容
   */
  note(event) {
    const type = String(event?.type ?? '');
    if (type === 'user/message') {
      // **只收人说的话**（与读取侧同一个判据 `isHumanMessage`）：`user/message` 是共用信封 ——
      // 插件注入 / 工作区指令基线 / **compaction 摘要**都走它。不看 `source` 的后果是真机实测出来的：
      //   ① `minChars`（"用户正文累计多少字"）被非人类文本灌满 → 捕获被无关触发；
      //   ② 转录里出现「用户：<摘要>」，抽取器就把**派生文本**当成用户亲口说的 ——
      //      同一条拍板因此被捕获了两遍（`2da9cd4a` / `96a95c85`，措辞还都是派生文本的措辞）。
      if (!isHumanMessage(event)) return { userChars: this.pendingUserChars, added: false };
      const text = messageText(event?.data);
      if (text === '') return { userChars: this.pendingUserChars, added: false };
      this.lines.push(`用户：${text}`);
      this.pendingUserChars += text.length;
      this.totalUserChars += text.length;
      this.#trim();
      return { userChars: this.pendingUserChars, added: true };
    }
    if (type === 'assistant/message') {
      const text = messageText(event?.data?.message ?? event?.data);
      if (text === '') return { userChars: this.pendingUserChars, added: false };
      this.lines.push(`助手：${text}`);
      this.#trim();
      return { userChars: this.pendingUserChars, added: true };
    }
    return { userChars: this.pendingUserChars, added: false };
  }

  /**
   * 取走当前转录并清空（增量语义）。
   *
   * @returns {{ text: string, userChars: number }} 转录与本次累计的用户字数
   */
  take() {
    const text = this.lines.join('\n\n').trim();
    const userChars = this.pendingUserChars;
    this.lines = [];
    this.pendingUserChars = 0;
    return { text, userChars };
  }

  /** 丢掉缓冲（会话结束 / 出错时用）。 */
  clear() {
    this.lines = [];
    this.pendingUserChars = 0;
  }

  /** 超出上限时丢最旧的整行（保住最近上下文）。 */
  #trim() {
    let total = this.lines.reduce((sum, line) => sum + line.length + 2, 0);
    while (total > this.maxChars && this.lines.length > 1) {
      const removed = this.lines.shift();
      total -= String(removed).length + 2;
    }
  }
}
