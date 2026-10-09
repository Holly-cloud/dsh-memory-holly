/**
 * dsh-memory · Phase 1：嵌入器。
 *
 * 两种形态：
 * - `localHashVector`：**离线**的确定性哈希向量（字符 n-gram → 分桶累加 → L2 归一化），
 *   `provider === 'local-hash'` 时用它，完全不联网、不需要密钥；
 * - `createEmbedder`：`openai` 兼容端点 / `ollama` 的远程嵌入器，**必须支持注入 `fetchImpl`**，
 *   因此测试可以完全离线地验证请求形状与响应解析。
 *
 * 本文件最容易致命的地方是**维度不匹配**：模型返回的维度和配置不一致时，
 * 静默存库会让整个向量库变成垃圾。所以这里对每一批、每一个向量都显式校验并抛错。
 *
 * @module dsh-memory/host/embed
 */

import { timeoutSignal } from './timeout.js';

/** 允许的嵌入 provider。 */
export const EMBEDDING_PROVIDERS = ['openai', 'ollama', 'local-hash'];

/**
 * 32 位 FNV-1a 哈希（纯函数，跨进程可复现）。
 *
 * @param {string} str 输入
 * @returns {number} 无符号 32 位整数
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 本地哈希向量：确定性、可复现、L2 归一化。
 *
 * 做法：对字符 2-gram 与 3-gram 分别哈希，用低位决定落到哪一维、
 * 用高位决定累加的正负号（低位/高位互相独立，避免「同一个桶永远同号」的系统性偏差）。
 * 短文（长度 1）退化用 1-gram，保证非空文本不会得到全零向量。
 *
 * 同一输入永远得到同一输出；`dims` 参与取模，因此换维度是**重新分桶**而不是截断。
 *
 * @param {string} text 原文
 * @param {number} dims 维度（正整数）
 * @returns {Float32Array} 归一化向量（零向量时原样返回全零）
 */
export function localHashVector(text, dims) {
  const dimsN = Number(dims);
  if (!Number.isInteger(dimsN) || dimsN <= 0) {
    throw new Error(`localHashVector：dims 必须是正整数（收到 ${dims}）`);
  }
  const source = String(text ?? '');
  const vec = new Float32Array(dimsN);
  if (source.length === 0) return vec;

  const minN = source.length >= 2 ? 2 : 1;
  for (let n = minN; n <= Math.min(3, source.length); n++) {
    for (let i = 0; i + n <= source.length; i++) {
      const gram = source.slice(i, i + n);
      const hash = fnv1a(gram);
      const bucket = hash % dimsN;
      const sign = ((hash >>> 16) & 1) === 0 ? 1 : -1;
      vec[bucket] += sign / n; // 长 n-gram 权重略低，避免长文本把小片段淹没
    }
  }
  return normalizeInPlace(vec);
}

/**
 * 就地 L2 归一化。
 *
 * @param {Float32Array} vec 向量
 * @returns {Float32Array} 同一个对象
 */
function normalizeInPlace(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  if (norm === 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

/**
 * 去掉结尾斜杠。
 *
 * @param {unknown} value 原始 URL
 * @returns {string} 规范化后的 URL
 */
function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/**
 * 构造 HTTP 失败错误（带状态码与前 300 字响应体）。
 *
 * @param {number} status HTTP 状态码
 * @param {string} body 响应体
 * @param {string} endpoint 端点
 * @returns {Error} 错误
 */
function httpError(status, body, endpoint) {
  const snippet = String(body ?? '').slice(0, 300);
  return new Error(`嵌入请求失败：HTTP ${status} ${endpoint} → ${snippet}`);
}

/**
 * 校验一批返回的向量维度。
 *
 * @param {unknown} vector 模型返回的向量
 * @param {number} dims 期望维度
 * @param {string} model 模型名
 * @param {number} index 批内序号
 * @returns {Float32Array} 向量
 */
function coerceVector(vector, dims, model, index) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    throw new Error(
      `嵌入响应格式错误：期望 ${dims} 维、模型 ${model} 返回的第 ${index} 个向量不是数组`,
    );
  }
  const got = vector.length;
  if (got !== dims) {
    throw new Error(
      `嵌入维度不匹配：期望 ${dims} 维、模型返回 ${got} 维、模型名 ${model}（第 ${index} 个向量）。` +
        '请检查 embedding.dimensions 与模型是否匹配，或清空并重建向量库。',
    );
  }
  return vector instanceof Float32Array ? vector : Float32Array.from(vector);
}

/**
 * 创建嵌入器。
 *
 * @param {{ provider: string, baseUrl?: string, model: string, dimensions?: number, apiKeyRef?: string | null,
 *   batchSize?: number, timeoutMs?: number, ollamaUrl?: string, localDims?: number }} embeddingConfig 嵌入配置
 * @param {{ fetchImpl?: typeof fetch, apiKey?: string | null }} [options] 依赖注入（测试用假 fetch）
 * @returns {{ provider: string, model: string, dims: number, fingerprint: string,
 *   embed: (texts: string[]) => Promise<Float32Array[]> }} 嵌入器
 */
export function createEmbedder(embeddingConfig, { fetchImpl = globalThis.fetch, apiKey = null } = {}) {
  const config = embeddingConfig ?? {};
  const provider = String(config.provider ?? '');
  if (!EMBEDDING_PROVIDERS.includes(provider)) {
    throw new Error(`createEmbedder：embedding.provider 只能是 ${EMBEDDING_PROVIDERS.join(' / ')}（收到 ${provider || '(空)'}）`);
  }

  const model = String(config.model ?? '');
  if (model.length === 0) throw new Error('createEmbedder：embedding.model 必须是非空字符串');

  const dims = Number(provider === 'local-hash' ? config.localDims : config.dimensions);
  if (!Number.isInteger(dims) || dims <= 0) {
    const field = provider === 'local-hash' ? 'localDims' : 'dimensions';
    throw new Error(`createEmbedder：embedding.${field} 必须是正整数（收到 ${provider === 'local-hash' ? config.localDims : config.dimensions}）`);
  }

  const batchSize = Number.isInteger(Number(config.batchSize)) && Number(config.batchSize) > 0 ? Number(config.batchSize) : 16;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 60000;
  const apiKeyRef = config.apiKeyRef == null ? null : String(config.apiKeyRef);

  const needsKey = provider === 'openai';
  const resolvedKey = apiKey ?? null;
  if (needsKey && (resolvedKey == null || String(resolvedKey).length === 0)) {
    throw new Error(
      `缺少密钥引用 ${apiKeyRef ?? '(未配置)'}：provider '${provider}' 需要 API 密钥。` +
        '请通过 ctx.credentials 配置该引用，或把 embedding.provider 改成 local-hash 走离线嵌入。',
    );
  }
  if (provider !== 'local-hash' && typeof fetchImpl !== 'function') {
    throw new Error('createEmbedder：缺少 fetch 实现（请注入 fetchImpl）');
  }

  const fingerprint = `${provider}:${model}:${dims}`;

  /**
   * 切批次。
   *
   * @param {string[]} texts 全部输入
   * @returns {string[][]} 批次数组
   */
  const batchesOf = (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) out.push(texts.slice(i, i + batchSize));
    return out;
  };

  /**
   * 一次远程请求。
   *
   * @param {string[]} batch 本批文本
   * @returns {Promise<Float32Array[]>} 本批向量
   */
  const requestBatch = async (batch) => {
    // 自建可 unref 的超时信号（`AbortSignal.timeout` 的定时器不 unref，请求结束后还会把进程钉住 ~timeoutMs）。
    const { signal, clear } = timeoutSignal(timeoutMs);
    try {
      let endpoint;
      /** @type {RequestInit} */
      let init;

      if (provider === 'openai') {
        endpoint = `${trimSlash(config.baseUrl ?? '')}/embeddings`;
        init = {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${resolvedKey}` },
          body: JSON.stringify({ model, input: batch, dimensions: dims }),
          signal,
        };
      } else {
        endpoint = `${trimSlash(config.ollamaUrl ?? '')}/api/embed`;
        init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: batch }),
          signal,
        };
      }

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

      const raw = provider === 'openai' ? payload?.data?.map((item) => item?.embedding) : payload?.embeddings;
      if (!Array.isArray(raw)) {
        throw new Error(
          `嵌入响应格式错误：模型 ${model} 的响应里没有可用的向量数组（provider=${provider}，端点 ${endpoint}）`,
        );
      }
      if (raw.length !== batch.length) {
        throw new Error(
          `嵌入响应条数不匹配：模型 ${model} 请求 ${batch.length} 条、返回 ${raw.length} 条（端点 ${endpoint}）`,
        );
      }
      return raw.map((vector, index) => coerceVector(vector, dims, model, index));
    } finally {
      // 成功 / 失败 / 抛错都要撤掉定时器：留着它就等于留着「一个还没放掉的句柄」。
      clear();
    }
  };

  return {
    provider,
    model,
    dims,
    fingerprint,
    /**
     * 把一批文本嵌入成向量。返回顺序**严格等于**入参顺序。
     *
     * @param {string[]} texts 文本数组
     * @returns {Promise<Float32Array[]>} 向量数组
     */
    async embed(texts) {
      if (!Array.isArray(texts)) throw new Error('embed：入参必须是字符串数组');
      const list = texts.map((text) => String(text));
      if (list.length === 0) return [];

      if (provider === 'local-hash') {
        // 本地嵌入不联网，但仍然按 batchSize 分批（保持与其他 provider 一致的行为）。
        const out = [];
        for (const batch of batchesOf(list)) {
          for (const text of batch) out.push(localHashVector(text, dims));
        }
        return out;
      }

      const out = [];
      for (const batch of batchesOf(list)) {
        const vectors = await requestBatch(batch);
        for (const vector of vectors) out.push(vector);
      }
      return out;
    },
  };
}
