/**
 * llm.js 测试：流式 chunk 拼装（只取 text-delta、丢弃 reasoning-delta、无 text-delta 时兜底、
 * finish.failure、kinds 去重有序）与 `createLlmClient` 的 provider/model 三级解析、
 * messages 形状转换、sink 字段、失败抛错。
 *
 * 全程不联网、不写临时文件：用 async generator 造假流。
 *
 * 这些用例守护的是 DESIGN §F / REGRESSION 血泪坑 #2：把模型思考拼进答案会**静默**让
 * 抽取结果恒为 0 条，而表面上「LLM 正常返回了」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAnswerText, createLlmClient } from '../src/host/llm.js';

/**
 * 把 chunk 数组包成异步生成器（模拟 `ctx.llm.stream()` 的返回）。
 *
 * @param {unknown[]} chunks chunk 列表。
 * @returns {AsyncGenerator<unknown>} 假流。
 */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk;
}

/**
 * 造一个假 `ctx.llm`：记录 stream 的入参，返回给定 chunk 序列。
 *
 * @param {unknown[]} chunks 要吐出的 chunk。
 * @returns {{stream: (options: object) => Promise<AsyncGenerator<unknown>>, calls: object[]}} 假服务。
 */
function makeFakeStreamService(chunks) {
  /** @type {object[]} */
  const calls = [];
  return {
    calls,
    async stream(options) {
      calls.push(options);
      return streamOf(chunks);
    },
  };
}

// ── collectAnswerText ────────────────────────────────────────────────────────

test('collectAnswerText：只把 text-delta 并入答案，其它 kind 一律不算', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'block-start' },
      { kind: 'text-delta', text: '宝宝' },
      { kind: 'usage', text: '不该出现' },
      { kind: 'text-delta', text: '喜欢冰美式' },
      { kind: 'finish' },
    ]),
  );

  assert.equal(result.text, '宝宝喜欢冰美式');
  assert.equal(result.chunkCount, 5);
  assert.equal(result.failure, null);
  assert.deepEqual(result.kinds, ['block-start', 'text-delta', 'usage', 'finish']);
});

test('collectAnswerText：kind 为 "text" 的 chunk 也算答案（别家 provider 的写法）', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'text', text: '甲' },
      { kind: 'text-delta', text: '乙' },
    ]),
  );
  assert.equal(result.text, '甲乙');
});

test('collectAnswerText：文本字段依次取 text / delta / content', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'text-delta', text: '甲' },
      { kind: 'text-delta', delta: '乙' },
      { kind: 'text-delta', content: '丙' },
      { kind: 'text-delta', text: 42, delta: '丁' },
      { kind: 'text-delta' },
    ]),
  );
  // 第四条：text 是数字（非字符串）→ 往下取 delta；第五条：三个字段都没有 → 空片段。
  assert.equal(result.text, '甲乙丙丁');
});

test('collectAnswerText：**87 个 reasoning-delta + 2 个 text-delta** → 答案恰好是那 2 个字', async () => {
  /** @type {object[]} */
  const chunks = [];
  for (let i = 0; i < 87; i += 1) {
    chunks.push({ kind: 'reasoning-delta', text: `我们需要回答用户第${i}步：先分析再输出 JSON。` });
  }
  chunks.push({ kind: 'text-delta', text: '好' });
  chunks.push({ kind: 'text-delta', text: '的' });

  const result = await collectAnswerText(streamOf(chunks));

  assert.equal(result.text, '好的', '思考过程一个字都不能进答案');
  assert.equal(result.text.length, 2);
  assert.equal(result.chunkCount, 89);
  assert.deepEqual(result.kinds, ['reasoning-delta', 'text-delta']);
  assert.ok(!result.text.includes('我们需要回答用户'));
});

test('collectAnswerText：kind 为 "reasoning" 的 chunk 同样丢弃', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'reasoning', content: '先看看用户想要什么' },
      { kind: 'finish' },
    ]),
  );
  assert.equal(result.text, '', '整条流没有 text-delta，且思考不进兜底池');
});

test('collectAnswerText：整条流没有 text-delta 时，才用兜底池拼接', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'block-start', text: '甲' },
      { kind: 'unknown-kind', content: '乙' },
      { kind: 'finish' },
    ]),
  );
  assert.equal(result.text, '甲乙');
  assert.deepEqual(result.kinds, ['block-start', 'unknown-kind', 'finish']);
});

test('collectAnswerText：出现过 text-delta 后兜底池作废（block-start 重复吐全文也不翻倍）', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'block-start', text: '整段全文' },
      { kind: 'text-delta', text: '答案' },
      { kind: 'unknown-kind', text: '兜底片段' },
      { kind: 'finish' },
    ]),
  );
  assert.equal(result.text, '答案', '未知 kind 进了兜底池，但被 text-delta 一票否决');
});

test('collectAnswerText：finish 带 failure 时原样记下来（不抛错）', async () => {
  const failure = { code: 'rate_limited', message: '请求过于频繁' };
  const result = await collectAnswerText(
    streamOf([
      { kind: 'text-delta', text: '半句' },
      { kind: 'finish', failure },
    ]),
  );
  assert.equal(result.text, '半句');
  assert.deepEqual(result.failure, failure);
});

test('collectAnswerText：kinds 去重且保持首次出现顺序', async () => {
  const result = await collectAnswerText(
    streamOf([
      { kind: 'block-start' },
      { kind: 'text-delta', text: '甲' },
      { kind: 'block-start' },
      { kind: 'usage' },
      { kind: 'text-delta', text: '乙' },
      { kind: 'usage' },
      { kind: 'finish' },
    ]),
  );
  assert.deepEqual(result.kinds, ['block-start', 'text-delta', 'usage', 'finish']);
});

test('collectAnswerText：kind 缺失时回落到 type，两者都缺失算 unknown', async () => {
  const result = await collectAnswerText(
    streamOf([
      { type: 'text-delta', text: '甲' },
      { text: '乙' },
      null,
      undefined,
      { kind: 'finish' },
    ]),
  );
  assert.equal(result.text, '甲', '没有 kind/type 的 chunk 不进答案');
  assert.deepEqual(result.kinds, ['text-delta', 'unknown', 'finish']);
  assert.equal(result.chunkCount, 5, 'null/undefined chunk 也计入 chunkCount');
});

test('collectAnswerText：同步可迭代对象（数组）同样可用', async () => {
  const result = await collectAnswerText([{ kind: 'text-delta', text: '数组' }]);
  assert.equal(result.text, '数组');
  assert.equal(result.chunkCount, 1);
});

test('collectAnswerText：空流返回空结果且不抛', async () => {
  const result = await collectAnswerText(streamOf([]));
  assert.deepEqual(result, { text: '', chunkCount: 0, kinds: [], failure: null });
});

// ── createLlmClient · provider/model 三级解析 ────────────────────────────────

test('createLlmClient：provider/model 取 options（第一级），不调用 fallbackSelection', async () => {
  const llm = makeFakeStreamService([{ kind: 'text-delta', text: 'ok' }]);
  let asked = 0;
  const client = createLlmClient(llm, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    fallbackSelection: () => {
      asked += 1;
      return { provider: '不该用', model: '不该用' };
    },
  });

  assert.equal(await client.chat({ messages: [{ role: 'user', content: 'hi' }] }), 'ok');
  assert.equal(asked, 0, '配置齐全时不该去问宿主默认模型');
  assert.equal(llm.calls[0].provider, 'deepseek-official');
  assert.equal(llm.calls[0].model, 'deepseek-flash');
});

test('createLlmClient：options 缺 provider/model 时用 fallbackSelection（第二级）', async () => {
  const llm = makeFakeStreamService([{ kind: 'text-delta', text: 'ok' }]);
  const client = createLlmClient(llm, {
    fallbackSelection: () => ({ provider: 'agent-default', model: 'agent-model' }),
  });

  await client.chat({ messages: [] });
  assert.equal(llm.calls[0].provider, 'agent-default');
  assert.equal(llm.calls[0].model, 'agent-model');
});

test('createLlmClient：只缺一半时，缺的那个才用 fallback 补', async () => {
  const llm = makeFakeStreamService([{ kind: 'text-delta', text: 'ok' }]);
  const client = createLlmClient(llm, {
    provider: 'config-provider',
    fallbackSelection: () => ({ provider: 'agent-provider', model: 'agent-model' }),
  });

  await client.chat({ messages: [] });
  assert.equal(llm.calls[0].provider, 'config-provider', '已给的 provider 不被覆盖');
  assert.equal(llm.calls[0].model, 'agent-model');
});

test('createLlmClient：三级都拿不到 provider/model → 抛错且点明「没有可用的 LLM」', async () => {
  const llm = makeFakeStreamService([]);
  for (const options of [
    {},
    { fallbackSelection: () => ({}) },
    { fallbackSelection: () => undefined },
    { provider: 'p' },
    { model: 'm' },
  ]) {
    const client = createLlmClient(llm, options);
    await assert.rejects(
      () => client.chat({ messages: [] }),
      (error) => {
        assert.match(error.message, /没有可用的 LLM/);
        return true;
      },
    );
  }
  assert.equal(llm.calls.length, 0, '解析不出 provider/model 时绝不发起请求');
});

test('createLlmClient：llm 缺失或没有 stream() → 抛错', async () => {
  for (const llm of [null, undefined, {}, { stream: 'not-a-function' }]) {
    const client = createLlmClient(llm, { provider: 'p', model: 'm' });
    await assert.rejects(() => client.chat({ messages: [] }), /llm 服务不可用/);
  }
});

// ── createLlmClient · 请求组装 ───────────────────────────────────────────────

test('createLlmClient：messages 转成 [{role, content:[{type:"text", text}]}]，content 用 String() 兜底', async () => {
  const llm = makeFakeStreamService([{ kind: 'text-delta', text: 'ok' }]);
  const client = createLlmClient(llm, { provider: 'p', model: 'm' });

  await client.chat({
    messages: [
      { role: 'system', content: '你是抽取器' },
      { role: 'user', content: 42 },
      { role: 'user' },
    ],
    temperature: 0.7,
    maxTokens: 512,
  });

  assert.deepEqual(llm.calls[0].messages, [
    { role: 'system', content: [{ type: 'text', text: '你是抽取器' }] },
    { role: 'user', content: [{ type: 'text', text: '42' }] },
    { role: 'user', content: [{ type: 'text', text: '' }] },
  ]);
  assert.equal(llm.calls[0].temperature, 0.7);
  assert.equal(llm.calls[0].maxTokens, 512);
});

test('createLlmClient：temperature / maxTokens 缺省为 0 / 2000，messages 缺失也不炸', async () => {
  const llm = makeFakeStreamService([{ kind: 'text-delta', text: 'ok' }]);
  const client = createLlmClient(llm, { provider: 'p', model: 'm' });

  await client.chat({});
  assert.equal(llm.calls[0].temperature, 0);
  assert.equal(llm.calls[0].maxTokens, 2000);
  assert.deepEqual(llm.calls[0].messages, []);
});

// ── createLlmClient · 返回值与 sink ──────────────────────────────────────────

test('createLlmClient：端到端丢弃 reasoning-delta，只返回答案', async () => {
  const llm = makeFakeStreamService([
    { kind: 'reasoning-delta', text: '我们需要回答用户……' },
    { kind: 'text-delta', text: '["宝宝喜欢冰美式"]' },
    { kind: 'finish' },
  ]);
  const client = createLlmClient(llm, { provider: 'p', model: 'm' });

  const answer = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(answer, '["宝宝喜欢冰美式"]');
});

test('createLlmClient：sink 写入 provider / model / chunkCount / textLength', async () => {
  const llm = makeFakeStreamService([
    { kind: 'reasoning-delta', text: '思考' },
    { kind: 'text-delta', text: '答案' },
    { kind: 'finish' },
  ]);
  const sink = { kinds: new Set() };
  const client = createLlmClient(llm, { provider: 'p', model: 'm', sink });

  await client.chat({ messages: [] });

  assert.equal(sink.provider, 'p');
  assert.equal(sink.model, 'm');
  assert.equal(sink.chunkCount, 3);
  assert.equal(sink.textLength, 2);
  assert.deepEqual([...sink.kinds], ['reasoning-delta', 'text-delta', 'finish']);
});

test('createLlmClient：sink 也可按次传入，req.sink 优先于 options.sink', async () => {
  const llm = makeFakeStreamService([{ kind: 'text-delta', text: '答案' }]);
  const factorySink = {};
  const callSink = { kinds: [] };
  const client = createLlmClient(llm, { provider: 'p', model: 'm', sink: factorySink });

  await client.chat({ messages: [], sink: callSink });

  assert.equal(callSink.chunkCount, 1);
  assert.equal(callSink.textLength, 2);
  assert.deepEqual(callSink.kinds, ['text-delta'], 'sink.kinds 是数组时按去重追加');
  assert.equal(factorySink.chunkCount, undefined, '按次传入时不该再写 factory 级 sink');
});

test('createLlmClient：finish.failure → chat 抛错，信息同时含 code 与 message', async () => {
  const llm = makeFakeStreamService([
    { kind: 'reasoning-delta', text: '思考' },
    { kind: 'finish', failure: { code: 'content_filter', message: '被安全策略拦截' } },
  ]);
  const client = createLlmClient(llm, { provider: 'p', model: 'm' });

  await assert.rejects(
    () => client.chat({ messages: [] }),
    (error) => {
      assert.match(error.message, /LLM 失败/);
      assert.match(error.message, /content_filter/);
      assert.match(error.message, /被安全策略拦截/);
      return true;
    },
  );
});
