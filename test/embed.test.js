/**
 * embed.js 测试：本地哈希向量、远程请求形状、维度校验、分批与顺序。
 *
 * 全部用**假 fetch**，一个网络包都不发。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmbedder, localHashVector } from '../src/host/embed.js';
import { jsonResponse, makeFakeFetch } from './util.js';

/** openai 兼容端点用的基准配置。 */
const OPENAI = {
  provider: 'openai',
  baseUrl: 'https://example.invalid/compatible-mode/v1',
  model: 'qwen3.7-text-embedding',
  dimensions: 4,
  apiKeyRef: 'DASHSCOPE_API_KEY',
  batchSize: 2,
  timeoutMs: 60000,
  ollamaUrl: 'http://127.0.0.1:11434',
  localDims: 8,
};

test('localHashVector：确定性、L2 归一化、维度正确、零向量边界', () => {
  const a = localHashVector('宝宝喜欢喝冰美式咖啡', 64);
  const b = localHashVector('宝宝喜欢喝冰美式咖啡', 64);

  assert.ok(a instanceof Float32Array);
  assert.equal(a.length, 64);
  assert.deepEqual([...a], [...b], '同输入必须同输出');

  const norm = Math.hypot(...a);
  assert.ok(Math.abs(norm - 1) < 1e-6, `模长应约为 1，实际 ${norm}`);

  assert.notDeepEqual([...a], [...localHashVector('宝宝喜欢喝热拿铁', 64)]);
  assert.equal(localHashVector('abc', 32).length, 32);
  assert.equal(localHashVector('abc', 100).length, 100);

  const empty = localHashVector('', 16);
  assert.deepEqual([...empty], new Array(16).fill(0), '空文本给全零向量');

  // 单字符（没有 2-gram）也必须得到非零向量
  const single = localHashVector('冰', 16);
  assert.ok(Math.hypot(...single) > 0.99);

  assert.throws(() => localHashVector('x', 0), /dims/);
  assert.throws(() => localHashVector('x', 1.5), /dims/);
});

test('createEmbedder(local-hash)：不联网、不需密钥、维度取自 localDims', async () => {
  let called = false;
  const embedder = createEmbedder(
    { ...OPENAI, provider: 'local-hash' },
    {
      apiKey: null,
      fetchImpl: () => {
        called = true;
        throw new Error('local-hash 不应该发起网络请求');
      },
    },
  );

  assert.equal(embedder.provider, 'local-hash');
  assert.equal(embedder.dims, 8);
  assert.equal(embedder.fingerprint, 'local-hash:qwen3.7-text-embedding:8');

  const vectors = await embedder.embed(['冰美式', '拿铁']);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.ok(vector instanceof Float32Array);
    assert.equal(vector.length, 8);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6);
  }
  assert.deepEqual([...vectors[0]], [...localHashVector('冰美式', 8)]);
  assert.equal(called, false);
  assert.deepEqual(await embedder.embed([]), []);
});

test('createEmbedder(openai)：URL / 方法 / 头 / body 形状与响应解析', async () => {
  const fetchImpl = makeFakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ data: body.input.map((text) => ({ embedding: [Number(text), 1, 2, 3] })) });
  });

  const embedder = createEmbedder(OPENAI, { fetchImpl, apiKey: 'sk-test' });
  assert.equal(embedder.fingerprint, 'openai:qwen3.7-text-embedding:4');

  const vectors = await embedder.embed(['0', '1']);
  assert.equal(vectors.length, 2);
  assert.deepEqual([...vectors[0]], [0, 1, 2, 3]);
  assert.deepEqual([...vectors[1]], [1, 1, 2, 3]);

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://example.invalid/compatible-mode/v1/embeddings');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(call.init.headers.authorization, 'Bearer sk-test');
  assert.ok(call.init.signal instanceof AbortSignal, '必须挂 AbortSignal.timeout');
  assert.deepEqual(JSON.parse(call.init.body), { model: 'qwen3.7-text-embedding', input: ['0', '1'], dimensions: 4 });
});

test('createEmbedder(openai)：baseUrl 结尾斜杠被规范化', async () => {
  const fetchImpl = makeFakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ data: body.input.map(() => ({ embedding: [1, 2, 3, 4] })) });
  });
  const embedder = createEmbedder({ ...OPENAI, baseUrl: 'https://example.invalid/v1///' }, { fetchImpl, apiKey: 'k' });
  await embedder.embed(['x']);
  assert.equal(fetchImpl.calls[0].url, 'https://example.invalid/v1/embeddings');
});

test('createEmbedder(ollama)：URL / body / 响应字段（无鉴权头）', async () => {
  const fetchImpl = makeFakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ embeddings: body.input.map((text) => [Number(text), 0, 0, 5]) });
  });

  const embedder = createEmbedder(
    { ...OPENAI, provider: 'ollama', model: 'bge-m3', ollamaUrl: 'http://127.0.0.1:11434/' },
    { fetchImpl },
  );
  assert.equal(embedder.fingerprint, 'ollama:bge-m3:4');

  const vectors = await embedder.embed(['7']);
  assert.deepEqual([...vectors[0]], [7, 0, 0, 5]);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:11434/api/embed');
  assert.equal(call.init.headers.authorization, undefined, 'ollama 不需要鉴权头');
  assert.deepEqual(JSON.parse(call.init.body), { model: 'bge-m3', input: ['7'] });
});

test('分批：按 batchSize 请求，次数正确，结果顺序与入参一致', async () => {
  const fetchImpl = makeFakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ data: body.input.map((text) => ({ embedding: [Number(text), 0, 0, 0] })) });
  });

  const embedder = createEmbedder({ ...OPENAI, batchSize: 2 }, { fetchImpl, apiKey: 'k' });
  const vectors = await embedder.embed(['0', '1', '2', '3', '4']);

  assert.equal(fetchImpl.calls.length, 3, '5 条 / 每批 2 条 = 3 次请求');
  assert.deepEqual(fetchImpl.calls.map((call) => JSON.parse(call.init.body).input.length), [2, 2, 1]);
  assert.deepEqual(vectors.map((vector) => vector[0]), [0, 1, 2, 3, 4], '顺序必须与入参一致');
});

test('维度不匹配必须抛错，且错误信息含期望 / 实际维度与模型名', async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse({ data: [{ embedding: [1, 2, 3] }] }));
  const embedder = createEmbedder(OPENAI, { fetchImpl, apiKey: 'k' });

  await assert.rejects(
    () => embedder.embed(['x']),
    (err) => {
      assert.match(err.message, /期望 4 维/);
      assert.match(err.message, /返回 3 维/);
      assert.match(err.message, /qwen3.7-text-embedding/);
      return true;
    },
  );

  // 第二条向量维度不对也要被发现
  const secondBad = makeFakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ data: body.input.map((_, index) => ({ embedding: index === 0 ? [1, 2, 3, 4] : [1, 2] })) });
  });
  const embedder2 = createEmbedder(OPENAI, { fetchImpl: secondBad, apiKey: 'k' });
  await assert.rejects(() => embedder2.embed(['a', 'b']), /期望 4 维、模型返回 2 维/);
});

test('缺密钥 / 缺 provider / HTTP 非 2xx / 响应形状错误的报错', async () => {
  assert.throws(
    () => createEmbedder(OPENAI, { fetchImpl: async () => jsonResponse({}), apiKey: null }),
    /缺少密钥引用 DASHSCOPE_API_KEY/,
  );
  assert.throws(() => createEmbedder({ ...OPENAI, provider: 'zzz' }, { apiKey: 'k' }), /embedding\.provider/);
  assert.throws(() => createEmbedder({ ...OPENAI, model: '' }, { apiKey: 'k' }), /model/);
  assert.throws(() => createEmbedder({ ...OPENAI, dimensions: 0 }, { apiKey: 'k' }), /dimensions/);

  const failing = makeFakeFetch(() => ({
    ok: false,
    status: 401,
    async text() {
      return `{"error":{"message":"${'x'.repeat(400)}"}}`;
    },
  }));
  const embedder = createEmbedder(OPENAI, { fetchImpl: failing, apiKey: 'bad' });
  await assert.rejects(
    () => embedder.embed(['x']),
    (err) => {
      assert.match(err.message, /HTTP 401/);
      assert.ok(err.message.includes('x'.repeat(250)), '应带上前 300 字响应体');
      assert.ok(!err.message.includes('x'.repeat(350)), '响应体必须被截断到 300 字');
      return true;
    },
  );

  const wrongShape = makeFakeFetch(() => jsonResponse({ result: [] }));
  const embedder2 = createEmbedder(OPENAI, { fetchImpl: wrongShape, apiKey: 'k' });
  await assert.rejects(() => embedder2.embed(['x']), /响应里没有可用的向量数组/);

  const wrongCount = makeFakeFetch(() => jsonResponse({ data: [{ embedding: [1, 2, 3, 4] }] }));
  const embedder3 = createEmbedder({ ...OPENAI, batchSize: 8 }, { fetchImpl: wrongCount, apiKey: 'k' });
  await assert.rejects(() => embedder3.embed(['a', 'b']), /请求 2 条、返回 1 条/);
});

test('超时：AbortSignal.timeout 被真正接上', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });

  const embedder = createEmbedder({ ...OPENAI, timeoutMs: 20 }, { fetchImpl, apiKey: 'k' });
  await assert.rejects(() => embedder.embed(['x']), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
});
