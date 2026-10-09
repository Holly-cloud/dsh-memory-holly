/**
 * conflict.js 测试：分类学提示词、批量判定请求、脏输出解析（1-based↔0-based/越界/非法值/
 * 重复 index）、未判到候选的保守兜底、LLM 失败时绝不 supersede。
 *
 * 全程不联网：所有 LLM 交互都由本地假实现承担。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELATIONS,
  CONFLICT_PROMPT,
  UNJUDGED_REASON,
  buildConflictRequest,
  parseRelations,
  suggestionFor,
  analyzeConflicts,
} from '../src/host/conflict.js';

/**
 * 造一个假 LLM：记录每次请求，按需返回固定文本或抛错。
 *
 * @param {string} reply 回复
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
      return reply;
    },
  };
}

/** 两个候选（模拟调用方按相似度取好的 top-k）。 */
const CANDIDATES = [
  { id: 'm1', text: '服务端口是 8080', score: 0.91 },
  { id: 'm2', text: '宝宝喜欢喝冰美式咖啡', score: 0.42 },
];

test('CONFLICT_PROMPT：写全四种关系，并显式声明「具体事件/经历/里程碑算 coexist」的铁律', () => {
  for (const relation of RELATIONS) {
    assert.match(CONFLICT_PROMPT, new RegExp(relation));
  }
  assert.match(CONFLICT_PROMPT, /铁律/);
  assert.match(CONFLICT_PROMPT, /事件、经历、里程碑/);
  assert.match(CONFLICT_PROMPT, /coexist/);
  assert.match(CONFLICT_PROMPT, /发生过的事永远是真的/);
  assert.match(CONFLICT_PROMPT, /只输出 JSON 数组/);
  assert.match(CONFLICT_PROMPT, /"index"/);
});

test('RELATIONS：四个关系，顺序固定', () => {
  assert.deepEqual(RELATIONS, ['supersede', 'duplicate', 'coexist', 'unrelated']);
});

test('buildConflictRequest：温度 0、候选从 1 开始编号、system 是冲突提示词', () => {
  const request = buildConflictRequest({ newText: '服务端口换成 9090', candidates: CANDIDATES });

  assert.equal(request.temperature, 0);
  assert.equal(request.maxTokens, 1500);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, CONFLICT_PROMPT);

  const body = request.messages[1].content;
  assert.match(body, /服务端口换成 9090/);
  assert.match(body, /1\. （相似度 0\.910）服务端口是 8080/);
  assert.match(body, /2\. （相似度 0\.420）宝宝喜欢喝冰美式咖啡/);
  assert.match(body, /2 条候选/);

  assert.equal(buildConflictRequest({ newText: 'x', candidates: CANDIDATES, maxTokens: 99 }).maxTokens, 99);
  assert.equal(buildConflictRequest({ newText: 'x', candidates: CANDIDATES, maxTokens: -1 }).maxTokens, 1500);
  assert.match(buildConflictRequest({ newText: 'x' }).messages[1].content, /没有候选/);
  // 相似度缺失/非法时不能抛错。
  const odd = buildConflictRequest({ newText: 'x', candidates: [{ id: 'a', text: 't' }] });
  assert.match(odd.messages[1].content, /相似度 未知/);
});

test('parseRelations：index 是 1-based，输出转成 0-based 并按 index 升序', () => {
  const raw = '[{"index": 2, "relation": "coexist", "reason": "乙"}, {"index": 1, "relation": "supersede", "reason": "甲"}]';
  assert.deepEqual(parseRelations(raw, 2), [
    { index: 0, relation: 'supersede', reason: '甲' },
    { index: 1, relation: 'coexist', reason: '乙' },
  ]);
});

test('parseRelations：越界 / 非整数 index 一律丢弃', () => {
  const raw = JSON.stringify([
    { index: 0, relation: 'unrelated', reason: '0 → 越界' },
    { index: 3, relation: 'unrelated', reason: '3 → 越界' },
    { index: 1.5, relation: 'unrelated', reason: '非整数' },
    { index: '2', relation: 'unrelated', reason: '字符串不是整数' },
    { index: null, relation: 'unrelated', reason: 'null' },
    { relation: 'unrelated', reason: '缺 index' },
    { index: 2, relation: 'duplicate', reason: '唯一合法' },
    'not-an-object',
    null,
  ]);
  assert.deepEqual(parseRelations(raw, 2), [{ index: 1, relation: 'duplicate', reason: '唯一合法' }]);
});

test('parseRelations：非法 relation 归为 unrelated，reason 截断到 200 字', () => {
  const raw = JSON.stringify([
    { index: 1, relation: 'update', reason: '没见过的关系' },
    { index: 2, relation: 'supersede', reason: '很'.repeat(300) },
  ]);
  const parsed = parseRelations(raw, 2);
  assert.equal(parsed[0].relation, 'unrelated');
  assert.equal(parsed[1].relation, 'supersede');
  assert.equal(parsed[1].reason.length, 200);
  assert.equal(parseRelations(JSON.stringify([{ index: 1 }]), 1)[0].relation, 'unrelated');
  assert.equal(parseRelations(JSON.stringify([{ index: 1, relation: 'coexist' }]), 1)[0].reason, '');
});

test('parseRelations：同一 index 重复出现以第一条为准', () => {
  const raw = JSON.stringify([
    { index: 1, relation: 'supersede', reason: '第一条' },
    { index: 1, relation: 'coexist', reason: '第二条' },
  ]);
  assert.deepEqual(parseRelations(raw, 2), [{ index: 0, relation: 'supersede', reason: '第一条' }]);
});

test('parseRelations：非法 JSON / 非数组 / 候选数为 0 时返回 []，且不抛错', () => {
  assert.deepEqual(parseRelations('[{"index":1,"relation":"coexist"', 2), []);
  assert.deepEqual(parseRelations('不是 JSON', 2), []);
  assert.deepEqual(parseRelations('{"index":1}', 2), []);
  assert.deepEqual(parseRelations('[1,2]', 2), [], '元素不是对象');
  assert.deepEqual(parseRelations('[{"index":1,"relation":"coexist"}]', 0), []);
  assert.deepEqual(parseRelations('[{"index":1,"relation":"coexist"}]'), []);
  assert.deepEqual(parseRelations(null, 2), []);
  assert.deepEqual(parseRelations(undefined, 2), []);
  assert.doesNotThrow(() => parseRelations(null, -1));
});

test('parseRelations：代码块围栏与前后解释文字都能被剥掉', () => {
  const raw = '分析如下：\n```json\n[{"index":1,"relation":"duplicate","reason":"重复"}]\n```\n以上。';
  assert.deepEqual(parseRelations(raw, 1), [{ index: 0, relation: 'duplicate', reason: '重复' }]);
});

test('suggestionFor：三个分支 + 未知值兜底', () => {
  assert.equal(suggestionFor('supersede'), '改写这条旧记忆');
  assert.equal(suggestionFor('duplicate'), '重复，不用存');
  assert.equal(suggestionFor('coexist'), '并存');
  assert.equal(suggestionFor('unrelated'), '并存');
  assert.equal(suggestionFor('乱写'), '并存');
  assert.equal(suggestionFor(undefined), '并存');
});

test('analyzeConflicts：判到的候选带关系与建议，顺序与候选一一对应', async () => {
  const llm = makeFakeLlm(
    '[{"index": 1, "relation": "supersede", "reason": "端口已改"}, {"index": 2, "relation": "coexist", "reason": "不同时期"}]',
  );
  const result = await analyzeConflicts({ llm, newText: '服务端口换成 9090，宝宝还在喝冰美式', candidates: CANDIDATES });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    id: 'm1',
    text: '服务端口是 8080',
    score: 0.91,
    relation: 'supersede',
    reason: '端口已改',
    suggestion: '改写这条旧记忆',
  });
  assert.equal(result.items[1].relation, 'coexist');
  assert.equal(result.items[1].suggestion, '并存');
  assert.equal(llm.calls.length, 1, '一次调用批量判定');
});

test('analyzeConflicts：没被判到的候选补 unrelated（按不动处理）', async () => {
  const llm = makeFakeLlm('[{"index": 2, "relation": "duplicate", "reason": "一回事"}]');
  const result = await analyzeConflicts({ llm, newText: '新记忆', candidates: CANDIDATES });

  assert.equal(result.ok, true);
  assert.equal(result.items[0].relation, 'unrelated');
  assert.equal(result.items[0].reason, UNJUDGED_REASON);
  assert.equal(result.items[0].suggestion, '并存');
  assert.equal(result.items[1].relation, 'duplicate');
  assert.equal(result.items[1].suggestion, '重复，不用存');
});

test('analyzeConflicts：LLM 抛错 → 全部 unrelated，绝不 supersede，原因进 error', async () => {
  const llm = makeFakeLlm('', { throwError: new Error('网关超时') });
  const result = await analyzeConflicts({ llm, newText: '新记忆', candidates: CANDIDATES });

  assert.equal(result.ok, false);
  assert.equal(result.raw, '');
  assert.match(result.error, /网关超时/);
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.relation, 'unrelated');
    assert.notEqual(item.relation, 'supersede');
    assert.equal(item.reason, UNJUDGED_REASON);
    assert.equal(item.suggestion, '并存');
  }
  // id / text / score 原样带回，调用方仍能对位展示。
  assert.deepEqual(result.items.map((item) => item.id), ['m1', 'm2']);
  assert.deepEqual(result.items.map((item) => item.text), ['服务端口是 8080', '宝宝喜欢喝冰美式咖啡']);
  assert.deepEqual(result.items.map((item) => item.score), [0.91, 0.42]);
});

test('analyzeConflicts：llm 缺失 / newText 为空 → 全部 unrelated，且不调用模型', async () => {
  const missing = await analyzeConflicts({ newText: '新记忆', candidates: CANDIDATES });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /llm/);
  assert.deepEqual([...new Set(missing.items.map((item) => item.relation))], ['unrelated']);

  const llm = makeFakeLlm('[{"index":1,"relation":"supersede","reason":"x"}]');
  for (const newText of ['', '   ', undefined, null]) {
    const result = await analyzeConflicts({ llm, newText, candidates: CANDIDATES });
    assert.equal(result.ok, false);
    assert.match(result.error, /newText/);
    assert.deepEqual([...new Set(result.items.map((item) => item.relation))], ['unrelated']);
  }
  assert.equal(llm.calls.length, 0, '输入不合法时不该调用模型');
});

test('analyzeConflicts：模型输出无法解析时算「没判到」，仍然全是 unrelated 且 ok:true', async () => {
  const llm = makeFakeLlm('我觉得都还好。');
  const result = await analyzeConflicts({ llm, newText: '新记忆', candidates: CANDIDATES });

  assert.equal(result.ok, true, '模型有响应，只是没解析出判定');
  assert.equal(result.raw, '我觉得都还好。');
  assert.equal(result.error, null);
  for (const item of result.items) {
    assert.equal(item.relation, 'unrelated');
    assert.equal(item.reason, UNJUDGED_REASON);
  }
});

test('analyzeConflicts：没有候选时直接成功返回，且不调用模型', async () => {
  const llm = makeFakeLlm('[{"index":1,"relation":"supersede","reason":"不该被用到"}]');
  const result = await analyzeConflicts({ llm, newText: '新记忆', candidates: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.raw, '');
  assert.equal(result.error, null);
  assert.equal(llm.calls.length, 0);

  const odd = await analyzeConflicts({ llm, newText: '新记忆', candidates: null });
  assert.equal(odd.ok, true);
  assert.deepEqual(odd.items, []);
});
