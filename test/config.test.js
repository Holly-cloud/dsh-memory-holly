/**
 * config.js 测试：默认值、深合并、非法值报错、Standard Schema 校验两种返回形状。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Config, DEFAULT_CONFIG, embeddingFingerprint, normalizeConfig } from '../src/host/config.js';

/** 契约里约定的出厂默认值（逐字段抄一遍，改坏了会立刻红）。 */
const EXPECTED_DEFAULTS = {
  dataDir: null,
  scope: 'default',
  // 诊断路由开关：**必须默认 false**。它挂在 webserver 前缀表上、不经 /api，
  // 因此无鉴权，而上面有 /import、/credential、/clean、/search。
  // 这条断言就是防止有人图省事把它改成 true。
  diagnostics: false,
  embedding: {
    provider: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-text-embedding',
    dimensions: 1024,
    apiKeyRef: 'DASHSCOPE_API_KEY',
    batchSize: 16,
    timeoutMs: 60000,
    ollamaUrl: 'http://127.0.0.1:11434',
    localDims: 1024,
  },
  search: { defaultLimit: 8, maxLimit: 100, minScore: 0, keywordWeight: 1, vectorWeight: 1, rrfK: 60 },
  llm: { provider: null, model: null, extractMaxTokens: 2000, conflictMaxTokens: 1500, temperature: 0 },
  capture: {
    enabled: true,
    mode: 'direct',
    focused: true,
    minChars: 120,
    maxChars: 4000,
    cooldownMs: 120000,
    // 第二道闸默认开：抽出来的临时事实（会话/工具/进度态）不写库、不入待审区
    dropTransient: true,
  },
  review: { agent: true, topK: 3 },
  // 两个行为计数器的每周衰减系数（**必须严格在 (0,1) 内**：1 = 不衰减、0 = 一次归零）
  score: { weeklyDecay: 0.98 },
  // 读取侧注入（Layer 0 常驻索引 + Layer 1 按需召回）的默认值；两层都是派生视图、只读。
  recall: {
    enabled: true,
    indexSlots: 8,
    indexPinnedCap: 4,
    recallSlots: 6,
    charLimit: 60,
    minSegmentTurns: 3,
    cohesionFloor: 0.08,
    candidateLimit: 400,
    terms: 14,
    minQueryChars: 6,
    dedupeFloor: 0.92,
  },
  keeper: {
    provider: 'ollama',
    ollamaUrl: null,
    baseUrl: null,
    model: null,
    apiKeyRef: null,
    // 240s（原 120s）：线上模型吐 2000 token 的 JSON 实测可能过 2 分钟，
    // 120s 会让约 1/3 的组超时；同组超时另有「自动重试一次」兜底（见 lib/index.js）。
    timeoutMs: 240000,
    // 0 = 自动 = timeoutMs × 2（一组最坏打两次请求，单次超时管不到"整组"）
    groupTimeoutMs: 0,
    maxTokens: 2000,
    temperature: 0,
    minChars: 240,
    digestMinChars: 120,
    splitChars: 400,
    dedupeThreshold: 0.86,
    // 新范式（只出变更单）的两项：一轮抽多少种子 / 每个种子召回多少邻居
    sampleSize: 20,
    perGroup: 5,
  },
};

test('默认值：DEFAULT_CONFIG 与契约逐字段一致，normalizeConfig() 返回深拷贝', () => {
  assert.deepEqual(DEFAULT_CONFIG, EXPECTED_DEFAULTS);

  const a = normalizeConfig();
  assert.deepEqual(a, EXPECTED_DEFAULTS);
  assert.notEqual(a, DEFAULT_CONFIG);
  assert.notEqual(a.embedding, DEFAULT_CONFIG.embedding);

  a.embedding.dimensions = 1;
  a.search.defaultLimit = 999;
  assert.equal(DEFAULT_CONFIG.embedding.dimensions, 1024, '不能污染 DEFAULT_CONFIG');
  assert.equal(DEFAULT_CONFIG.search.defaultLimit, 8);

  assert.deepEqual(normalizeConfig(null), EXPECTED_DEFAULTS);
  assert.deepEqual(normalizeConfig(undefined), EXPECTED_DEFAULTS);
});

test('深合并：只覆盖给到的字段，其余保持默认', () => {
  const merged = normalizeConfig({
    scope: 'work',
    embedding: { dimensions: 512, provider: 'ollama', model: 'bge-m3' },
    search: { defaultLimit: 3 },
  });

  assert.equal(merged.scope, 'work');
  assert.equal(merged.embedding.dimensions, 512);
  assert.equal(merged.embedding.provider, 'ollama');
  assert.equal(merged.embedding.model, 'bge-m3');
  assert.equal(merged.embedding.baseUrl, EXPECTED_DEFAULTS.embedding.baseUrl, '未给的字段应保持默认');
  assert.equal(merged.embedding.batchSize, 16);
  assert.equal(merged.search.defaultLimit, 3);
  assert.equal(merged.search.maxLimit, 100);
  assert.deepEqual(merged.llm, EXPECTED_DEFAULTS.llm);

  // 未定义的字段不应把默认值抹成 undefined
  assert.equal(normalizeConfig({ embedding: { dimensions: undefined } }).embedding.dimensions, 1024);
});

test('非法值逐项抛错，错误信息点名字段', () => {
  assert.throws(() => normalizeConfig({ embedding: { provider: 'zzz' } }), /embedding\.provider/);
  assert.throws(() => normalizeConfig({ embedding: { dimensions: 0 } }), /embedding\.dimensions/);
  assert.throws(() => normalizeConfig({ embedding: { dimensions: 1.5 } }), /embedding\.dimensions/);
  assert.throws(() => normalizeConfig({ embedding: { localDims: -1 } }), /embedding\.localDims/);
  assert.throws(() => normalizeConfig({ embedding: { batchSize: 0 } }), /embedding\.batchSize/);
  assert.throws(() => normalizeConfig({ embedding: { timeoutMs: 0 } }), /embedding\.timeoutMs/);
  assert.throws(() => normalizeConfig({ embedding: { model: '' } }), /embedding\.model/);
  assert.throws(() => normalizeConfig({ embedding: { baseUrl: 7 } }), /embedding\.baseUrl/);
  assert.throws(() => normalizeConfig({ embedding: { apiKeyRef: 7 } }), /embedding\.apiKeyRef/);
  assert.throws(() => normalizeConfig({ scope: '' }), /scope/);
  assert.throws(() => normalizeConfig({ dataDir: 7 }), /dataDir/);
  assert.throws(() => normalizeConfig({ search: { defaultLimit: 0 } }), /search\.defaultLimit/);
  assert.throws(() => normalizeConfig({ search: { maxLimit: -3 } }), /search\.maxLimit/);
  assert.throws(() => normalizeConfig({ search: { rrfK: 0 } }), /search\.rrfK/);
  assert.throws(() => normalizeConfig({ search: { keywordWeight: -1 } }), /search\.keywordWeight/);
  assert.throws(() => normalizeConfig({ search: { vectorWeight: 'x' } }), /search\.vectorWeight/);
  assert.throws(() => normalizeConfig({ search: { minScore: Number.NaN } }), /search\.minScore/);
  assert.throws(() => normalizeConfig({ search: { defaultLimit: 50, maxLimit: 10 } }), /search\.defaultLimit/);
  assert.throws(() => normalizeConfig({ llm: { extractMaxTokens: 0 } }), /llm\.extractMaxTokens/);
  assert.throws(() => normalizeConfig({ llm: { conflictMaxTokens: 0 } }), /llm\.conflictMaxTokens/);
  assert.throws(() => normalizeConfig({ llm: { temperature: -1 } }), /llm\.temperature/);
  assert.throws(() => normalizeConfig({ llm: { provider: 5 } }), /llm\.provider/);
  assert.throws(() => normalizeConfig({ embedding: 'not-an-object' }), /embedding\./);

  // 自主捕获的第二道闸（确定性三分类 durable / transient / uncertain）：必须是布尔，默认 true
  assert.throws(() => normalizeConfig({ capture: { dropTransient: 'yes' } }), /capture\.dropTransient/);
  assert.throws(() => normalizeConfig({ capture: { dropTransient: 1 } }), /capture\.dropTransient/);
  assert.equal(normalizeConfig({ capture: { dropTransient: false } }).capture.dropTransient, false);
  assert.equal(normalizeConfig({}).capture.dropTransient, true);

  // 仓管新范式那两项：必须是正整数（0 / 小数 / 字符串都要当场报错，别等跑一轮才炸）
  assert.throws(() => normalizeConfig({ keeper: { sampleSize: 0 } }), /keeper\.sampleSize/);
  assert.throws(() => normalizeConfig({ keeper: { perGroup: -1 } }), /keeper\.perGroup/);
  assert.throws(() => normalizeConfig({ keeper: { sampleSize: 2.5 } }), /keeper\.sampleSize/);
  assert.throws(() => normalizeConfig({ keeper: { perGroup: '5' } }), /keeper\.perGroup/);
  assert.equal(normalizeConfig({ keeper: { sampleSize: 3, perGroup: 1 } }).keeper.sampleSize, 3);
  // 一组的硬墙钟：0 = 自动（timeoutMs × 2）合法；负数 / 非数字不合法
  assert.throws(() => normalizeConfig({ keeper: { groupTimeoutMs: -1 } }), /keeper\.groupTimeoutMs/);
  assert.throws(() => normalizeConfig({ keeper: { groupTimeoutMs: 'long' } }), /keeper\.groupTimeoutMs/);
  assert.equal(normalizeConfig({ keeper: { groupTimeoutMs: 0 } }).keeper.groupTimeoutMs, 0);
  assert.equal(normalizeConfig({ keeper: { groupTimeoutMs: 480000 } }).keeper.groupTimeoutMs, 480000);

  // 合法边界值不应抛错
  assert.doesNotThrow(() => normalizeConfig({ embedding: { dimensions: 1, batchSize: 1, timeoutMs: 1 } }));
  assert.doesNotThrow(() => normalizeConfig({ embedding: { provider: 'local-hash', localDims: 3 } }));
  assert.doesNotThrow(() => normalizeConfig({ search: { defaultLimit: 100, maxLimit: 100 } }));

  // 衰减系数：必须严格在 (0,1) 开区间内（1 会放任数值膨胀、0 会一次归零）
  assert.throws(() => normalizeConfig({ score: { weeklyDecay: 1 } }), /score\.weeklyDecay/);
  assert.throws(() => normalizeConfig({ score: { weeklyDecay: 0 } }), /score\.weeklyDecay/);
  assert.throws(() => normalizeConfig({ score: { weeklyDecay: 1.2 } }), /score\.weeklyDecay/);
  assert.throws(() => normalizeConfig({ score: { weeklyDecay: -0.1 } }), /score\.weeklyDecay/);
  assert.throws(() => normalizeConfig({ score: { weeklyDecay: '0.98' } }), /score\.weeklyDecay/);
  assert.throws(() => normalizeConfig({ score: { weeklyDecay: Number.NaN } }), /score\.weeklyDecay/);
  assert.equal(normalizeConfig({ score: { weeklyDecay: 0.5 } }).score.weeklyDecay, 0.5);

  // recall：槽位/字数必须是正整数，indexPinnedCap 不能超过 indexSlots，cohesionFloor 必须 ≥ 0。
  assert.throws(() => normalizeConfig({ recall: { indexSlots: 0 } }), /recall\.indexSlots/);
  assert.throws(() => normalizeConfig({ recall: { charLimit: 2.5 } }), /recall\.charLimit/);
  assert.throws(() => normalizeConfig({ recall: { indexSlots: 4, indexPinnedCap: 5 } }), /recall\.indexPinnedCap/);
  assert.throws(() => normalizeConfig({ recall: { cohesionFloor: -0.1 } }), /recall\.cohesionFloor/);
  assert.throws(() => normalizeConfig({ recall: { enabled: 'yes' } }), /recall\.enabled/);
  assert.throws(() => normalizeConfig({ recall: { minQueryChars: 0 } }), /recall\.minQueryChars/);
  assert.throws(() => normalizeConfig({ recall: { dedupeFloor: -1 } }), /recall\.dedupeFloor/);
  assert.throws(() => normalizeConfig({ recall: { dedupeFloor: 'high' } }), /recall\.dedupeFloor/);
  // 0 是合法值：关掉注入期去重
  assert.equal(normalizeConfig({ recall: { dedupeFloor: 0 } }).recall.dedupeFloor, 0);
  assert.equal(normalizeConfig({ recall: { minQueryChars: 4 } }).recall.minQueryChars, 4);
  assert.equal(normalizeConfig({ recall: { enabled: false, recallSlots: 3 } }).recall.recallSlots, 3);
});

test("Config['~standard'].validate：成功给 { value }，失败给 { issues: [{ message, path }] }", () => {
  assert.equal(Config['~standard'].version, 1);
  assert.equal(Config['~standard'].vendor, 'dsh-memory');

  const ok = Config['~standard'].validate({ embedding: { dimensions: 256 } });
  assert.ok(!('issues' in ok), '成功结果不应带 issues');
  assert.equal(ok.value.embedding.dimensions, 256);
  assert.deepEqual(ok.value.search, EXPECTED_DEFAULTS.search);

  const bad = Config['~standard'].validate({ embedding: { dimensions: 0, provider: 'nope' } });
  assert.ok(Array.isArray(bad.issues));
  assert.ok(!('value' in bad));
  assert.equal(bad.issues.length, 2);
  for (const item of bad.issues) {
    assert.equal(typeof item.message, 'string');
    assert.ok(Array.isArray(item.path));
  }
  assert.deepEqual(bad.issues.map((item) => item.path), [['embedding', 'provider'], ['embedding', 'dimensions']]);
  assert.match(bad.issues[0].message, /embedding\.provider/);

  const notObject = Config['~standard'].validate('nope');
  assert.equal(notObject.issues.length, 1);
  assert.deepEqual(notObject.issues[0].path, ['config']);

  assert.deepEqual(Config['~standard'].validate(undefined), { value: EXPECTED_DEFAULTS });
});

test('embeddingFingerprint：provider:model:dims，local-hash 用 localDims', () => {
  assert.equal(embeddingFingerprint(DEFAULT_CONFIG.embedding), 'openai:qwen3.7-text-embedding:1024');
  assert.equal(
    embeddingFingerprint({ provider: 'local-hash', model: 'local', localDims: 64, dimensions: 1024 }),
    'local-hash:local:64',
  );
  assert.equal(
    embeddingFingerprint({ provider: 'ollama', model: 'bge-m3', dimensions: 512 }),
    'ollama:bge-m3:512',
  );
  assert.throws(() => embeddingFingerprint({ provider: 'zzz' }), /embedding\.provider/);
});
