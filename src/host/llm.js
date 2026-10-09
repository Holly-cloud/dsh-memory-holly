/**
 * dsh-memory · LLM 适配层（**纯逻辑、可测、不碰 ctx**）。
 *
 * 本模块是 `lib/index.js` 里 `createLlmClient()` 的可测抽离：那边依赖 `ctx.get('llm')` /
 * `ctx.get('agentDefaultModel')`，无法离线测试；这里把「怎么拼流」「怎么解析 provider/model」
 * 变成注入式的纯函数，于是 `test/llm.test.js` 能用假流覆盖每一条语义。
 *
 * 它守护的是**本项目最难查的一类静默故障**（DESIGN §F、REGRESSION 血泪坑 #2）：
 *
 * - `ctx.llm.stream()` 产出的是 token 级 chunk，`reasoning-delta` 是模型**思考过程**，
 *   `text-delta` 才是答案。两者一旦拼在一起，抽取/冲突判定拿到的就是
 *   「我们需要回答用户…」，JSON 解析必然失败 → 永远抽出 0 条事实，
 *   而表面上「LLM 正常返回了」。
 * - 推理模型的 token 预算会先被思考吃掉：可能整条流**一个 `text-delta` 都没有**。
 *   因此保留「无 `text-delta` 时用兜底池拼接」的兼容路径（别的 provider 可能不吐 text-delta）。
 *
 * 契约见 `DESIGN.md` §F 与 `REGRESSION.md` 待补清单第 2 条。
 *
 * @module dsh-memory/host/llm
 */

/**
 * 注入的流式 LLM 服务（宿主 `ctx.llm` 的形状，只取用得到的那一个方法）。
 *
 * @typedef {{ stream: (options: object) => Promise<AsyncIterable<object>> }} LlmStreamService
 */

/**
 * 注入的 fallback 选择器：拿不到配置里的 provider/model 时向宿主问一次当前模型。
 *
 * @typedef {() => ({ provider?: string | null, model?: string | null } | undefined | null)} FallbackSelection
 */

/**
 * 并入**答案**的 chunk kind（`text` 是少数 provider 的写法）。
 *
 * @type {Set<string>}
 */
const ANSWER_KINDS = new Set(['text-delta', 'text']);

/**
 * 模型的**思考过程** kind：一律丢弃，绝不并入答案。
 *
 * @type {Set<string>}
 */
const REASONING_KINDS = new Set(['reasoning-delta', 'reasoning']);

/**
 * 从 chunk 里取文本片段：依次看 `text` / `delta` / `content`，取第一个是字符串的。
 *
 * 不做任何猜测式的字段名假设之外的事：三个字段都不是字符串就当作没有文本。
 *
 * @param {object} chunk 流式 chunk。
 * @returns {string} 文本片段（可能为空串）。
 */
function pieceOf(chunk) {
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  if (typeof chunk.content === 'string') return chunk.content;
  return '';
}

/**
 * 从流式 chunk 序列里拼出**答案文本**。
 *
 * 语义（每一条都有对应测试）：
 * 1. 只有 `kind === 'text-delta'`（或 `'text'`）的 chunk 并入答案；
 * 2. `reasoning-delta` / `reasoning` 一律丢弃 —— 思考过程绝不能进答案；
 * 3. 其它未知 kind（含 `block-start` / `usage` / `finish`）里带字符串片段的，
 *    进「兜底池」；
 * 4. **只有整条流一个 `text-delta` 都没出现过**，才用兜底池拼接；一旦出现过，兜底池作废
 *    （所以 `block-start` 之类重复吐全文的 chunk 不会把答案翻倍）；
 * 5. `kind === 'finish'` 且带 `failure` → 记进返回值，由调用方决定怎么抛；
 * 6. 记下出现过的 kind（**去重、保持首次出现顺序**），供 `/llm-probe` 用测量代替猜测。
 *
 * 注意「出现过 `text-delta`」的判定：**带非空文本的** `text-delta` 才算数。
 * 空文本的 `text-delta` 不构成答案，此时仍允许兜底（与 `lib/index.js` 原有行为一致）。
 *
 * @param {AsyncIterable<object>|Iterable<object>} chunks 流式 chunk 序列。
 * @returns {Promise<{text: string, chunkCount: number, kinds: string[], failure: object|null}>} 拼装结果。
 */
export async function collectAnswerText(chunks) {
  /** @type {string[]} 出现过的 kind（去重、保持首次出现顺序） */
  const kinds = [];
  /** @type {Set<string>} kinds 的查重表 */
  const seenKinds = new Set();
  /** @type {string[]} 非答案 chunk 的兜底片段 */
  const fallback = [];

  let text = '';
  let chunkCount = 0;
  let sawTextDelta = false;
  /** @type {object|null} */
  let failure = null;

  if (chunks != null) {
    // for await 对同步可迭代对象同样成立，所以 AsyncIterable 与 Iterable 都能吃。
    for await (const chunk of chunks) {
      // 计数在 null 检查之前：chunkCount 是「流里到底吐了多少个 chunk」的观测量，
      // 推理模型把预算全烧在思考上时，这个数字是唯一能看出异常的线索。
      chunkCount += 1;
      if (chunk == null) continue;

      const kind = String(chunk.kind ?? chunk.type ?? 'unknown');
      if (!seenKinds.has(kind)) {
        seenKinds.add(kind);
        kinds.push(kind);
      }

      const piece = pieceOf(chunk);

      if (ANSWER_KINDS.has(kind)) {
        if (piece.length > 0) {
          text += piece;
          sawTextDelta = true;
        }
        continue;
      }

      if (REASONING_KINDS.has(kind)) {
        // 思考过程：**绝不**并入答案。抽取/冲突判定要的是最终 JSON，
        // 混进推理文本会让解析器拿到一堆「我们需要回答用户…」而抽出 0 条。
        continue;
      }

      if (piece.length > 0) fallback.push(piece);
      if (kind === 'finish' && chunk.failure) failure = chunk.failure;
    }
  }

  // 兼容别的 provider：一次 text-delta 都没见过时，才退而求其次用兜底池。
  if (!sawTextDelta && fallback.length > 0) text = fallback.join('');

  return { text, chunkCount, kinds, failure };
}

/**
 * 把未知异常折成一句话（兜底池的 failure 可能不是 Error）。
 *
 * @param {unknown} value 任意值。
 * @returns {string} 可读文本。
 */
function describeFailure(value) {
  if (value == null) return '未知失败';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // 循环引用等：JSON.stringify 会抛，退回 String()，绝不因为「打印失败」而吞掉错误。
    return String(value);
  }
}

/**
 * 造一个只有 `chat()` 的 LLM 客户端（适配 Phase 2 的 `LlmClient` 契约）。
 *
 * provider/model 解析顺序（三级）：
 *   1. `options.provider` / `options.model`；
 *   2. 缺哪个就用 `options.fallbackSelection()` 返回的同名字段补哪个；
 *   3. 仍拿不到 → 抛错，信息里点明「没有可用的 LLM」。
 *
 * 请求进入 `llm.stream` 前会把 messages 整形成宿主约定的
 * `[{ role, content: [{ type: 'text', text }] }]` 形状 —— 宿主只认这种 content 数组。
 *
 * `options.sink` 给了就写入 `provider` / `model` / `chunkCount` / `textLength`；
 * 若 `sink.kinds` 是 Set 或数组，还会把去重后的 kind 列表并进去
 * （兼容 `/llm-probe` 的观测量，见 DESIGN §F 的「自证通道」）。
 * `chat({ sink })` 还能**按次覆盖**它（`lib/index.js` 的 `/llm-probe` 就是每次新建一个 sink）。
 *
 * @param {LlmStreamService} llm 形如 `ctx.llm` 的对象（只要求 `stream()`）。
 * @param {{provider?: string|null, model?: string|null, sink?: object|null,
 *   fallbackSelection?: FallbackSelection}} [options] 配置。
 * @returns {{chat: (req: {messages: unknown[], temperature?: number, maxTokens?: number,
 *   sink?: object|null}) => Promise<string>}} LLM 客户端。
 */
export function createLlmClient(llm, options = {}) {
  const defaultSink = options.sink != null && typeof options.sink === 'object' ? options.sink : null;
  const fallbackSelection =
    typeof options.fallbackSelection === 'function' ? options.fallbackSelection : null;

  return {
    /**
     * 跑一次对话，返回拼好的**答案全文**。
     *
     * 任何失败（provider/model 缺失、stream 抛错、`finish.failure`）一律**抛错**：
     * 调用方（`extract.js` / `conflict.js`）会把它收进 `ok:false` 信封，
     * 在这里吞掉只会制造「LLM 正常返回了空结果」的假象。
     *
     * @param {{messages: unknown[], temperature?: number, maxTokens?: number, sink?: object|null}} req 请求。
     * @returns {Promise<string>} 答案文本。
     */
    async chat({ messages, temperature = 0, maxTokens = 2000, sink: callSink = null } = {}) {
      const sink = callSink != null && typeof callSink === 'object' ? callSink : defaultSink;
      if (llm == null || typeof llm.stream !== 'function') {
        throw new Error('llm 服务不可用：需要一个带 stream() 的对象');
      }

      let provider = options.provider ?? null;
      let model = options.model ?? null;
      if ((provider == null || model == null) && fallbackSelection !== null) {
        const fallback = fallbackSelection();
        provider = provider ?? fallback?.provider ?? null;
        model = model ?? fallback?.model ?? null;
      }
      if (provider == null || model == null) {
        throw new Error('没有可用的 LLM：provider/model 既没给出，fallbackSelection() 也没返回');
      }

      const stream = await llm.stream({
        provider,
        model,
        // 宿主只认 content 数组形状；content 一律 String() 兜底，避免 null/数字炸在这里。
        messages: (Array.isArray(messages) ? messages : []).map((m) => ({
          role: m?.role,
          content: [{ type: 'text', text: String(m?.content ?? '') }],
        })),
        temperature,
        maxTokens,
      });

      const result = await collectAnswerText(stream);

      if (sink !== null) {
        sink.provider = provider;
        sink.model = model;
        sink.chunkCount = result.chunkCount;
        sink.textLength = result.text.length;
        if (sink.kinds instanceof Set) {
          for (const kind of result.kinds) sink.kinds.add(kind);
        } else if (Array.isArray(sink.kinds)) {
          for (const kind of result.kinds) if (!sink.kinds.includes(kind)) sink.kinds.push(kind);
        }
      }

      if (result.failure) {
        const code = result.failure.code ?? '';
        const message = result.failure.message ?? describeFailure(result.failure);
        // 错误信息必须同时含 code 与 message：只给其中一个，排查时就得回去翻日志。
        throw new Error(`LLM 失败：${code} ${message}`.trim());
      }

      return result.text;
    },
  };
}
