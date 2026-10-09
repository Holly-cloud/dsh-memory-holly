/**
 * dsh-memory · 仓管 LLM：插件**自带**的一条本地 / 局域网 LLM 通道。
 *
 * 与宿主的 `ctx.llm` 完全独立 —— 直接打 HTTP，只认两种端点：
 * - `ollama`：`POST {ollamaUrl}/api/chat`（本机或局域网 Ollama；局域网写 `http://192.168.x.x:11434`）
 * - `openai`：`POST {baseUrl}/chat/completions`（任何 OpenAI 兼容端点，含局域网 vLLM / llama.cpp / LM Studio）
 *
 * 为什么单独一条：仓管要做的是**全库批量二次加工**（上千条 × 每条一次调用），
 * 用宿主的模型既贵又可能把整库正文发给云 API。这条通道默认指向局域网，数据不出内网。
 *
 * @module dsh-memory/host/locallm
 */

import { timeoutSignal } from './timeout.js';

/** 支持的 provider。 */
export const LOCAL_LLM_PROVIDERS = ['ollama', 'openai'];

/**
 * 去掉尾斜杠。
 *
 * @param {string} value 原始串
 * @returns {string} 规范化后的串
 */
function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/**
 * 把 HTTP 失败折成一句带端点的错误。
 *
 * @param {number} status 状态码
 * @param {string} body 响应体片段
 * @param {string} endpoint 端点
 * @returns {Error} 错误
 */
function httpError(status, body, endpoint) {
  const snippet = String(body ?? '').slice(0, 300).replace(/\s+/g, ' ').trim();
  return new Error(`仓管 LLM 请求失败：HTTP ${status}（${endpoint}）${snippet === '' ? '' : ` —— ${snippet}`}`);
}

/**
 * 造一个仓管 LLM 客户端。
 *
 * @param {{provider?: string, ollamaUrl?: string|null, baseUrl?: string|null, model?: string,
 *   timeoutMs?: number, maxTokens?: number, temperature?: number}} config 仓管配置
 * @param {{fetchImpl?: typeof fetch, apiKey?: string | null}} [options] 依赖注入（测试用假 fetch）
 * @returns {{provider: string, model: string, endpoint: string,
 *   chat: (input: {messages: {role: string, content: string}[], temperature?: number, maxTokens?: number}) => Promise<string>}} 客户端
 */
export function createLocalLlm(config = {}, { fetchImpl = globalThis.fetch, apiKey = null } = {}) {
  const provider = String(config.provider ?? '');
  if (!LOCAL_LLM_PROVIDERS.includes(provider)) {
    throw new Error(`createLocalLlm：provider 只能是 ${LOCAL_LLM_PROVIDERS.join(' / ')}（收到 ${provider || '(空)'}）`);
  }
  const model = String(config.model ?? '').trim();
  if (model === '') throw new Error('createLocalLlm：model 必须是非空字符串');

  const rawUrl = provider === 'ollama' ? config.ollamaUrl : config.baseUrl;
  const base = trimSlash(rawUrl ?? '');
  if (base === '') {
    const field = provider === 'ollama' ? 'ollamaUrl' : 'baseUrl';
    throw new Error(`createLocalLlm：provider=${provider} 时必须配 ${field}（本机写 127.0.0.1，局域网写内网地址）`);
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`createLocalLlm：${provider === 'ollama' ? 'ollamaUrl' : 'baseUrl'} 必须以 http:// 或 https:// 开头（收到 ${base}）`);
  }
  if (provider === 'openai' && (apiKey == null || String(apiKey).length === 0)) {
    throw new Error('createLocalLlm：provider=openai 需要 API 密钥（把 apiKeyRef 指到凭据库里的一条，或换成 ollama）');
  }
  if (typeof fetchImpl !== 'function') throw new Error('createLocalLlm：缺少 fetch 实现（请注入 fetchImpl）');

  const endpoint = provider === 'ollama' ? `${base}/api/chat` : `${base}/chat/completions`;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 120_000;
  const defaultMaxTokens = Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 2000;
  const defaultTemperature = Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0;

  return {
    provider,
    model,
    endpoint,
    /**
     * 一轮对话，返回助手正文（**不用流式**：批量加工要的是完整性，不是首字延迟）。
     *
     * @param {{messages: {role: string, content: string}[], temperature?: number, maxTokens?: number,
     *   timeoutMs?: number}} input 请求（`timeoutMs` 是**这一次调用**的覆盖值，用于把整组预算分给某一次请求）
     * @returns {Promise<string>} 助手文本
     */
    async chat({ messages, temperature = defaultTemperature, maxTokens = defaultMaxTokens, timeoutMs: callTimeoutMs } = {}) {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('仓管 LLM：messages 必须是非空数组');
      }
      const list = messages.map((message) => ({ role: String(message?.role ?? 'user'), content: String(message?.content ?? '') }));
      const max = Number(maxTokens) > 0 ? Number(maxTokens) : defaultMaxTokens;
      // 单次覆盖：调用方（run 的每组）按**整组剩余预算**收紧这一次请求。它只能**收紧**、不能放宽
      // （`min(覆盖, 档案超时)`）—— 它是"分预算"，不是"加预算"；不给就沿用档案超时。
      const override = Number(callTimeoutMs) > 0 ? Number(callTimeoutMs) : 0;
      const budgetMs = override > 0 ? Math.min(override, timeoutMs) : timeoutMs;
      // 自建可 unref 的超时信号（`AbortSignal.timeout` 的定时器不 unref，会把进程钉住 ~timeoutMs）。
      const { signal, clear } = timeoutSignal(budgetMs);
      try {
        /** @type {RequestInit} */
        const init =
          provider === 'ollama'
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  model,
                  messages: list,
                  stream: false,
                  // Ollama 默认 num_ctx 只有 4096，整块记忆 + 提示词容易超；显式给大一点（原版血泪坑 #5）。
                  options: { temperature: Number(temperature) || 0, num_predict: max, num_ctx: 32768 },
                }),
                signal,
              }
            : {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model, messages: list, temperature: Number(temperature) || 0, max_tokens: max, stream: false }),
                signal,
              };

        const response = await fetchImpl(endpoint, init);
        const status = Number(response?.status ?? 0);
        if (response == null || response.ok !== true) {
          let body = '';
          try {
            body = typeof response?.text === 'function' ? await response.text() : String(response?.body ?? '');
          } catch {
            body = '';
          }
          throw httpError(status, body, endpoint);
        }

        let payload;
        if (typeof response.json === 'function') payload = await response.json();
        else payload = JSON.parse(await response.text());

        const content = provider === 'ollama' ? payload?.message?.content : payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error(
            `仓管 LLM 响应格式错误：${model} 的响应里没有助手正文（provider=${provider}，端点 ${endpoint}）`,
          );
        }
        return content;
      } finally {
        // 成功 / 失败 / 抛错都要撤掉定时器：留着它就等于留着「120 秒后才放的句柄」。
        clear();
      }
    },
  };
}
