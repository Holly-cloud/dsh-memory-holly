/**
 * extract.js 测试：提示词内容、请求组装、脏输出解析（围栏/解释文字/非法 JSON/去重）、
 * 空文本不调用 LLM、模型抛错被捕获。
 *
 * 全程不联网：所有 LLM 交互都由本地假实现承担。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTRACT_PROMPT,
  EXTRACT_FOCUSED_PROMPT,
  buildExtractRequest,
  parseFacts,
  extractFacts,
} from '../src/host/extract.js';

/**
 * 造一个假 LLM：记录每次请求，按需返回固定文本或抛错。
 *
 * @param {string | ((request: unknown, callIndex: number) => string)} reply 回复（或回复工厂）
 * @param {{ throwError?: Error | null }} [options] 是否抛错
 * @returns {{ chat: (request: unknown) => Promise<string>, calls: unknown[] }} 假客户端
 */
function makeFakeLlm(reply, { throwError = null } = {}) {
  /** @type {unknown[]} */
  const calls = [];
  return {
    calls,
    async chat(request) {
      calls.push(request);
      if (throwError != null) throw throwError;
      return typeof reply === 'function' ? reply(request, calls.length) : reply;
    },
  };
}

test('两个提示词都是中文、都要求只输出 JSON 数组，聚焦版还限制 8 条并排除技术细节', () => {
  assert.equal(typeof EXTRACT_PROMPT, 'string');
  assert.equal(typeof EXTRACT_FOCUSED_PROMPT, 'string');
  assert.notEqual(EXTRACT_PROMPT, EXTRACT_FOCUSED_PROMPT);

  for (const prompt of [EXTRACT_PROMPT, EXTRACT_FOCUSED_PROMPT]) {
    assert.match(prompt, /JSON 数组/);
    assert.match(prompt, /\[\]/);
    assert.match(prompt, /不要.*代码块围栏/);
  }

  // 通用版：忽略元指令与寒暄、无信息量返回空数组。
  assert.match(EXTRACT_PROMPT, /元指令/);
  assert.match(EXTRACT_PROMPT, /寒暄/);

  // 聚焦版：五类人相关事实、最多 8 条、排除技术细节。
  assert.match(EXTRACT_FOCUSED_PROMPT, /最多 8 条/);
  for (const word of ['关系', '情感', '偏好', '决策', '共同经历']) {
    assert.match(EXTRACT_FOCUSED_PROMPT, new RegExp(word));
  }
  for (const word of ['端口', '路径', '配置', '报错', 'API', '模型名']) {
    assert.match(EXTRACT_FOCUSED_PROMPT, new RegExp(word));
  }
});

test('两个提示词都写死了「不要记」清单与正反例（会话态 / 工具态 / 助手自述 / 当下状态）', () => {
  for (const prompt of [EXTRACT_PROMPT, EXTRACT_FOCUSED_PROMPT]) {
    assert.match(prompt, /不要记/, '必须有「不要记」清单');
    assert.match(prompt, /会话/, '必须点名会话/任务态');
    assert.match(prompt, /teammate/, '必须点名 teammate / subagent 这类工具协作态');
    assert.match(prompt, /助手/, '必须点名助手自身的立场与自述');
    assert.match(prompt, /正在/, '必须点名「目前 / 正在 / 刚刚」这类当下状态');
    assert.match(prompt, /正例/, '必须有正例');
    assert.match(prompt, /反例/, '必须有反例');
    assert.match(prompt, /待审区|变更单/, '必须点名待审区 / 变更单这类协作态');
    // 2026-10-08 补的一条：**不得从助手的话里反推本人的拍板**。真机就是这么漏的 ——
    // 助手在汇报里写的合并正文，被抽取器当成「用户于…拍板」记进了库（同一件事因此出现第三份）。
    assert.match(prompt, /助手的话里反推/, '必须禁止"从助手行反推用户拍板"');
    assert.match(prompt, /只是上下文/, '要说明 `助手：` 行只是上下文');
  }
});

test('extractFacts：抽出来的事实再过一道确定性三分类（默认开，dropped 带命中理由）', async () => {
  const llm = makeFakeLlm(JSON.stringify(['用户与助手约定：先改代码再重启', '用户喜欢冰美式']));
  const result = await extractFacts({ llm, text: '有内容的文本' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, ['用户喜欢冰美式'], '临时事实不许进 facts');
  assert.deepEqual(result.durable, ['用户喜欢冰美式']);
  assert.deepEqual(result.deferred, [], '这一批没有拿不准的');
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].text, '用户与助手约定：先改代码再重启');
  assert.ok(result.dropped[0].hit.length > 0, '丢掉时必须说得出命中理由');
});

test('extractFacts：三分类各走各的 —— durable 进 durable、uncertain 进 deferred、transient 进 dropped', async () => {
  const durable = '用户采纳了「只出变更单、不直接改库」这条语义。';
  const transient = '用户与助手约好用 propose 流程处理那条记忆。';
  const uncertain = '这条事实现在还躺在待审区。';
  const llm = makeFakeLlm(JSON.stringify([durable, transient, uncertain]));
  const result = await extractFacts({ llm, text: '有内容的文本' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.durable, [durable], '长期决定不许被技术词误杀');
  assert.deepEqual(result.deferred.map((entry) => entry.text), [uncertain], '拿不准的交审阅、不丢');
  assert.deepEqual(result.dropped.map((entry) => entry.text), [transient]);
  assert.deepEqual(result.facts, [durable, uncertain], 'facts = durable + uncertain 的原顺序（待审路径直接用它建批次）');
});

test('extractFacts：excludeTransient=false 时只靠提示词，不做确定性分类', async () => {
  const llm = makeFakeLlm(JSON.stringify(['用户与助手约定：先改代码再重启', '用户喜欢冰美式']));
  const result = await extractFacts({ llm, text: '有内容的文本', excludeTransient: false });

  assert.equal(result.ok, true);
  assert.equal(result.facts.length, 2, '关掉过滤器后两条都留下');
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.durable, result.facts, '关掉三分类后全部按 durable 走（等价于不过闸）');
});

test('buildExtractRequest：默认走通用提示词，focused 走聚焦提示词，temperature 恒为 0', () => {
  const plain = buildExtractRequest({ text: '今天聊了聊咖啡。' });
  assert.equal(plain.temperature, 0);
  assert.equal(plain.maxTokens, 2000);
  assert.equal(plain.messages.length, 2);
  assert.equal(plain.messages[0].role, 'system');
  assert.equal(plain.messages[0].content, EXTRACT_PROMPT);
  assert.equal(plain.messages[1].role, 'user');
  assert.equal(plain.messages[1].content, '今天聊了聊咖啡。');

  const focused = buildExtractRequest({ text: 'x', focused: true });
  assert.equal(focused.messages[0].content, EXTRACT_FOCUSED_PROMPT);
  assert.equal(focused.temperature, 0);

  const custom = buildExtractRequest({ text: 'x', maxTokens: 512 });
  assert.equal(custom.maxTokens, 512);

  // 非法 maxTokens 退回默认值，并且 text 缺失也不炸。
  assert.equal(buildExtractRequest({ text: 'x', maxTokens: 0 }).maxTokens, 2000);
  assert.equal(buildExtractRequest({ text: 'x', maxTokens: 'abc' }).maxTokens, 2000);
  assert.equal(buildExtractRequest({}).messages[1].content, '');
});

test('parseFacts：剥掉 ```json 代码块围栏', () => {
  const raw = '```json\n["宝宝喜欢喝冰美式咖啡", "周末想去露营"]\n```';
  assert.deepEqual(parseFacts(raw), ['宝宝喜欢喝冰美式咖啡', '周末想去露营']);
});

test('parseFacts：前后带解释文字也能取到第一个数组', () => {
  const raw = '好的，我抽出了这些事实：\n["宝宝是程序员", "养了一只叫团子的猫"]\n希望对你有帮助。';
  assert.deepEqual(parseFacts(raw), ['宝宝是程序员', '养了一只叫团子的猫']);

  const fenced = '以下是结果：\n```json\n["只有一条"]\n```\n完毕。';
  assert.deepEqual(parseFacts(fenced), ['只有一条']);
});

test('parseFacts：非法 JSON / 非数组 / 没有数组 一律返回 []，且不抛错', () => {
  assert.deepEqual(parseFacts('["没闭合的数组"'), []);
  assert.deepEqual(parseFacts('[这不是 JSON]'), []);
  assert.deepEqual(parseFacts('{"a": 1}'), [], '没有数组，解析不出来');
  // 「取第一个 [...]」是契约规定的宽松行为：对象里嵌着的数组也会被挖出来。
  // （因此 JSON.parse 的「非数组」分支是纯防御性代码，正常路径走不到。）
  assert.deepEqual(parseFacts('{"facts": ["甲"]}'), ['甲']);
  assert.deepEqual(parseFacts('我什么都没抽到。'), []);
  assert.deepEqual(parseFacts(''), []);
  assert.deepEqual(parseFacts('[]'), []);
  assert.deepEqual(parseFacts('```json\n[]\n```'), []);
  assert.deepEqual(parseFacts(null), []);
  assert.deepEqual(parseFacts(undefined), []);
  assert.deepEqual(parseFacts(42), []);
  assert.deepEqual(parseFacts({ facts: [] }), []);
  assert.doesNotThrow(() => parseFacts('[1, 2'));
});

test('parseFacts：丢弃非字符串元素、trim、丢弃空串', () => {
  const raw = '["  宝宝喜欢喝冰美式  ", 42, null, {"a":1}, ["嵌套"], "", "   ", true, "另一条"]';
  assert.deepEqual(parseFacts(raw), ['宝宝喜欢喝冰美式', '另一条']);
});

test('parseFacts：按出现顺序去重（保留第一次出现的位置）', () => {
  const raw = '["乙", "甲", "乙", " 甲 ", "丙"]';
  assert.deepEqual(parseFacts(raw), ['乙', '甲', '丙']);
});

test('extractFacts：成功时返回 facts 与 raw，并把 focused 透到提示词', async () => {
  const llm = makeFakeLlm('```json\n["宝宝喜欢喝冰美式咖啡"]\n```');
  const result = await extractFacts({ llm, text: '随便聊聊', focused: true, maxTokens: 300 });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.facts, ['宝宝喜欢喝冰美式咖啡']);
  assert.equal(result.raw, '```json\n["宝宝喜欢喝冰美式咖啡"]\n```');
  assert.equal(llm.calls.length, 1);
  const request = /** @type {{ messages: { role: string, content: string }[], temperature: number, maxTokens: number }} */ (
    llm.calls[0]
  );
  assert.equal(request.messages[0].content, EXTRACT_FOCUSED_PROMPT);
  assert.equal(request.messages[1].content, '随便聊聊');
  assert.equal(request.temperature, 0);
  assert.equal(request.maxTokens, 300);
});

test('extractFacts：模型输出不可解析时 ok 仍为 true，但 facts 为空', async () => {
  const llm = makeFakeLlm('我不知道该抽什么。');
  const result = await extractFacts({ llm, text: '有内容的文本' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, []);
  assert.equal(result.error, null);
});

test('extractFacts：text 为空/全空白时**不调用 LLM**', async () => {
  const llm = makeFakeLlm('["不该被用到"]');

  for (const text of ['', '   ', '\n\t ', undefined, null, 123]) {
    const result = await extractFacts({ llm, text });
    assert.equal(result.ok, false, `text=${JSON.stringify(text)} 应当失败`);
    assert.deepEqual(result.facts, []);
    assert.equal(result.raw, '');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  }

  assert.equal(llm.calls.length, 0, '一次模型调用都不该发生');
});

test('extractFacts：llm.chat 抛错时返回 ok:false 且**不向外抛**', async () => {
  const llm = makeFakeLlm('', { throwError: new Error('模型服务 500') });
  const result = await extractFacts({ llm, text: '有内容的文本' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.facts, []);
  assert.equal(result.raw, '');
  assert.match(result.error, /模型服务 500/);
  assert.equal(llm.calls.length, 1);
});

test('extractFacts：llm 缺失或不是对象时返回 ok:false', async () => {
  for (const llm of [undefined, null, {}, { chat: 'not-a-function' }]) {
    const result = await extractFacts({ llm, text: '有内容的文本' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.facts, []);
    assert.match(result.error, /llm/);
  }
});
