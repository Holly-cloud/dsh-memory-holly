/**
 * 自主捕获测试：跟随 agent 运行的后台抽取 + 归属规则 + agent 审阅。
 *
 * 归属规则（用户 2026-10-06 定）：
 * - **连入记忆系统的那个 agent 自己**的会话 → 抽出来**免审直接入库**；
 * - 其他来源（子代理 / 被委派会话）→ 进待审区，再由这个 agent 审阅（`review.agent`）。
 *
 * 纯逻辑部分（`src/host/capture.js`）单独测；服务层用假 ctx + 假 LLM 跑完整链路。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { MemoryService } from '../lib/index.js';
import { ConversationBuffer, isForeignSession, isHumanMessage, lastHumanMessage, messageText, shouldCapture } from '../src/host/capture.js';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('capture');

const closers = [];
after(() => {
  for (const close of closers.splice(0)) close();
  cleanupTmpDir(TMP);
});

// ── 纯逻辑 ────────────────────────────────────────────────────────────────────

test('messageText：只取 text 块，reasoning / tool-call 一律不要', () => {
  assert.equal(messageText({ content: '就是一段字符串' }), '就是一段字符串');
  assert.equal(
    messageText({
      content: [
        { type: 'reasoning', text: '我要先想一想' },
        { type: 'text', text: '答案' },
        { type: 'tool-call', name: 'memory_search', arguments: '{}' },
        { type: 'text', text: '第二段' },
      ],
    }),
    '答案\n第二段',
  );
  assert.equal(messageText({ content: [{ type: 'reasoning', text: '只有思考' }] }), '');
  assert.equal(messageText(null), '');
  assert.equal(messageText({}), '');
  assert.equal(messageText({ content: [{ type: 'text' }] }), '');
});

test('isHumanMessage：只认「人说的话」，注入物一律不算', () => {
  // 真机载荷形状（宿主：`{type,seq,time,data:{id,role,source:{kind:"user"},content}}`）
  const human = {
    type: 'user/message',
    seq: 12,
    time: 0,
    data: {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '副仓管用哪个模型接手' }],
    },
  };
  assert.equal(isHumanMessage(human), true);
  assert.equal(messageText(human.data), '副仓管用哪个模型接手', '正文在 data 上');
  // 回归：取错层级曾经让 Layer 1 永远拿到空串、且**不报错**（静默失效，最难查的那种）
  assert.equal(messageText(human), '', 'event 上没有 content —— 取错层级就是空串');

  // `user/message` 是共用信封：以下全都不是人说的话
  assert.equal(isHumanMessage({ ...human, data: { ...human.data, source: { kind: 'agent-instructions' } } }), false);
  assert.equal(isHumanMessage({ ...human, data: { ...human.data, source: { kind: 'plugin', plugin: 'compact' } } }), false);
  assert.equal(isHumanMessage({ ...human, data: { ...human.data, source: { kind: 'tool' } } }), false);
  assert.equal(isHumanMessage({ type: 'assistant/message', data: { ...human.data } }), false);
  assert.equal(isHumanMessage({ type: 'turn/end' }), false);
  // 判据取宽：没标来源 / 标了来源但没标 kind → 按人来（少注一条 = 功能静默失效，代价更大）
  assert.equal(isHumanMessage({ type: 'user/message', data: { content: '没有 source' } }), true);
  assert.equal(isHumanMessage({ ...human, data: { ...human.data, source: {} } }), true);
  assert.equal(isHumanMessage(null), false);
});

test('isForeignSession：子代理 / 委派会话算「其他来源」', () => {
  assert.equal(isForeignSession({ header: { id: 's1' } }), false, '普通会话 = 连入的那个 agent 自己');
  assert.equal(isForeignSession({ header: { origin: 'subagent' } }), true);
  assert.equal(isForeignSession({ header: { parentSession: 'p1' } }), true);
  assert.equal(isForeignSession({ header: { delegationDepth: 1 } }), true);
  assert.equal(isForeignSession({ header: { delegationDepth: 0 } }), false);
  assert.equal(isForeignSession(null), false, '拿不到 header 时按「自己」处理（宁可抽也不漏）');
});

test('转录缓冲：插件注入 / 工作区指令 / compaction 摘要都不算「用户说的话」', () => {
  // 真机（2026-10-08）：同一条拍板被捕获了两遍、措辞都是**派生文本**的措辞 —— 因为 `note()` 只看
  // `type === 'user/message'`、不看 `source`：compaction 摘要被当成「用户：…」计进 `minChars`
  // 又喂给抽取器。读取侧早有 `isHumanMessage`，捕获侧现在跟它同一个判据。
  const buffer = new ConversationBuffer({});
  const human = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '人说的第一句' }] } };
  const compacted = {
    type: 'user/message',
    data: { source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: '压缩摘要'.repeat(40) }] },
  };
  const instructions = {
    type: 'user/message',
    data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '工作区指令'.repeat(40) }] },
  };
  const assistant = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手说的一句' }] } } };

  assert.equal(buffer.note(human).added, true);
  assert.equal(buffer.note(compacted).added, false, 'compaction 摘要不算用户正文');
  assert.equal(buffer.note(instructions).added, false, '工作区指令不算用户正文');
  assert.equal(buffer.note(assistant).added, true, '助手的话照旧收（作为抽取的上下文，原有设计）');
  assert.equal(buffer.note(compacted).userChars, '人说的第一句'.length, '计数里只有人说的话');

  const { text, userChars } = buffer.take();
  assert.ok(text.includes('用户：人说的第一句'));
  assert.equal(text.includes('压缩摘要'), false, '摘要不能以「用户：」的身份进转录');
  assert.equal(text.includes('工作区指令'), false, '指令同理');
  assert.ok(text.includes('助手：助手说的一句'), '助手那句还在（只削掉冒充用户的那些）');
  assert.equal(userChars, '人说的第一句'.length);
  // 没有 source 的老形状照旧按人来（判据取宽，不静默失效）
  assert.equal(new ConversationBuffer({}).note({ type: 'user/message', data: { content: '没标来源' } }).added, true);
});

test('lastHumanMessage：从会话日志里取最近一条人话（读不到就交回空串，让调用方回落）', () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '工作区指令基线' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句人话' }] } },
    { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: '压缩摘要' }] } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二句人话' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收尾' }] } } },
  ];
  const session = { surface: { nodes: events.map((_, index) => index) }, eventAt: (seq) => events[seq] };
  assert.equal(lastHumanMessage(session), '第二句人话', '倒着找、最近的优先，注入物不算');

  // 拿不到宿主内部结构 → 空串（调用方回落到事件游标，绝不抛）
  assert.equal(lastHumanMessage({}), '');
  assert.equal(lastHumanMessage(null), '');
  assert.equal(lastHumanMessage({ surface: { nodes: [0] } }), '', '没有 eventAt 就当读不到');
  assert.equal(lastHumanMessage({ surface: { nodes: [0] }, eventAt: () => { throw new Error('日志坏了'); } }), '', '读取抛错必须吞掉');
  assert.equal(
    lastHumanMessage({ surface: { nodes: new Set([0, 1]) }, eventAt: (seq) => [null, { type: 'user/message', data: { source: { kind: 'user' }, content: '人话' } }][seq] }),
    '人话',
    'nodes 是 Set 也要能走',
  );

  // 扫描上限：最近 400 条里一句人话都没有时不翻旧账（过期的查询词比空着更糟）
  const old = [{ type: 'user/message', data: { source: { kind: 'user' }, content: '很久以前那句' } }];
  const filler = Array.from({ length: 400 }, () => ({ type: 'assistant/message', data: { message: { content: '嗯' } } }));
  const stale = [...old, ...filler];
  assert.equal(lastHumanMessage({ surface: { nodes: stale.map((_, index) => index) }, eventAt: (seq) => stale[seq] }), '', '超上限就交回空串');
});

test('shouldCapture：阈值与冷却各挡各的', () => {
  assert.equal(shouldCapture({ userChars: 10, minChars: 120 }).capture, false);
  assert.match(shouldCapture({ userChars: 10, minChars: 120 }).reason, /未到阈值/);

  assert.equal(shouldCapture({ userChars: 200, minChars: 120, now: 1_000_000 }).capture, true);

  const cooling = shouldCapture({ userChars: 200, minChars: 120, lastCaptureAt: 1_000_000, now: 1_030_000, cooldownMs: 120_000 });
  assert.equal(cooling.capture, false);
  assert.match(cooling.reason, /冷却中/);

  const ready = shouldCapture({ userChars: 200, minChars: 120, lastCaptureAt: 1_000_000, now: 1_200_000, cooldownMs: 120_000 });
  assert.equal(ready.capture, true);
});

test('ConversationBuffer：只累计用户正文、take 后清空、超限丢最旧', () => {
  const buffer = new ConversationBuffer({ maxChars: 300 });

  assert.deepEqual(buffer.note({ type: 'turn/start', data: { turn: 1 } }), { userChars: 0, added: false });
  assert.equal(buffer.note({ type: 'user/message', data: { content: '甲'.repeat(100) } }).userChars, 100);
  assert.equal(
    buffer.note({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到' }] } } }).userChars,
    100,
    '助手正文不增加这个数（但也不会清零）',
  );
  assert.equal(buffer.note({ type: 'user/message', data: { content: '乙'.repeat(50) } }).userChars, 150);

  const taken = buffer.take();
  assert.match(taken.text, /^用户：甲+/);
  assert.match(taken.text, /助手：收到/);
  assert.equal(taken.userChars, 150);
  assert.equal(buffer.pendingUserChars, 0, 'take 之后必须清空，否则会重复抽');
  assert.equal(buffer.take().text, '');

  // 超限丢最旧：塞满很多行后总量要降到上限以内，且最近的一行还在
  const small = new ConversationBuffer({ maxChars: 200 });
  for (let i = 0; i < 20; i += 1) small.note({ type: 'user/message', data: { content: `第${i}条`.repeat(10) } });
  small.note({ type: 'user/message', data: { content: '最后一条' } });
  const text = small.take().text;
  assert.ok(text.includes('最后一条'), '最近的内容必须保住');
  assert.ok(text.length <= 240, `总量应被压到上限附近，实际 ${text.length}`);
  assert.equal(small.take().text, '');
});

// ── 服务层：跟随 agent 运行的完整链路 ──────────────────────────────────────────

/**
 * 造一个假 LLM：按提示词内容决定回什么（抽取 / 冲突判定两条路都要服务）。
 *
 * @param {{facts?: string[], relation?: string}} [options] 返回内容
 * @returns {object} 假 llm 服务（`{stream}`）
 */
function makeFakeLlm({ facts = ['事实甲', '事实乙'], relation = 'coexist' } = {}) {
  return {
    async *stream(options) {
      const prompt = JSON.stringify(options?.messages ?? []);
      const isConflict = prompt.includes('冲突判定器');
      const text = isConflict ? JSON.stringify([{ index: 1, relation, reason: '测试判定' }]) : JSON.stringify(facts);
      yield { kind: 'reasoning-delta', text: '先想一想（必须被丢弃）' };
      yield { kind: 'text-delta', text };
      yield { kind: 'finish' };
    },
  };
}

/**
 * 造服务 + 记录事件监听器。
 *
 * @param {{config?: object, facts?: string[], relation?: string}} [options] 选项
 * @returns {{service: MemoryService, store: object, listeners: Map<string, Function>}} 组合
 */
function makeService({ config = {}, facts, relation } = {}) {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    on(name, listener) {
      listeners.set(String(name), listener);
      return () => listeners.delete(String(name));
    },
    connection: { fetch: { register: () => () => {} } },
    get(name) {
      if (name === 'llm') return makeFakeLlm({ facts, relation });
      return undefined;
    },
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  closers.push(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const service = new MemoryService(ctx, {
    dataDir: join(TMP, `data-${listeners.size}-${Math.random().toString(36).slice(2, 8)}`),
    llm: { provider: 'p', model: 'm' },
    ...config,
  });
  return { service, store: service.ensureStore(), listeners };
}

/**
 * 等条件成立（后台捕获是 `void` 异步跑的）。
 *
 * @param {() => boolean} predicate 条件
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<void>} 成立即返回
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 造一条会话对象。 */
const session = (id, header = {}) => ({ id, header: { id, ...header } });

/** 喂一段用户正文 + 助手回话 + 回合结束。 */
function feedTurn(listener, target, userText, { turn = 1 } = {}) {
  listener(target, { type: 'user/message', data: { content: [{ type: 'text', text: userText }] } });
  listener(target, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } });
  listener(target, { type: 'turn/end', data: { turn } });
}

test('读取侧喂入：人的消息进 cursor，注入物 / 子代理不进（回归：载荷层级 + 来源判据）', () => {
  const { service, listeners } = makeService();
  const listener = listeners.get('session/event');
  const ask = (text) => ({
    type: 'user/message',
    data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
  const text = '副仓管用哪个模型接手';

  listener(session('s1'), ask(text));
  let status = service.recallStatus();
  assert.equal(status.feed.fed, 1, '人的消息必须喂进引擎');
  assert.equal(status.engine.cursor.sessionId, 's1');
  assert.equal(status.engine.cursor.chars, text.length, '查询词 = 人的原话，且取的是 data.content');
  assert.equal(status.engine.sessions, 1);

  // 共用信封的注入物（工作区指令 / compaction / 工具回灌）不是查询词
  listener(session('s1'), {
    type: 'user/message',
    data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '这里是工作区指令' }] },
  });
  status = service.recallStatus();
  assert.equal(status.feed.notHuman, 1);
  assert.equal(status.engine.cursor.chars, text.length, 'cursor 不该被注入物改写');

  // 子代理会话转述的话，不算我这边的话题
  listener(session('sub', { origin: 'subagent' }), ask('子代理那边的活'));
  status = service.recallStatus();
  assert.equal(status.feed.foreign, 1);
  assert.equal(status.engine.cursor.sessionId, 's1', '主会话的 cursor 不被子代理挤掉');
  assert.equal(status.engine.sessions, 1);
});

test('自主捕获：连入的 agent 自己的会话 → 抽出来免审直接入库', async () => {
  const { service, store, listeners } = makeService({ facts: ['宝宝喜欢冰美式', '宝宝习惯凌晨睡'] });
  const listener = listeners.get('session/event');
  assert.equal(typeof listener, 'function', '必须挂上了 session/event');

  feedTurn(listener, session('s1'), '甲'.repeat(130));
  await waitFor(() => store.countMemories() === 2);

  assert.equal(store.pendingBatches?.length ?? 0, 0);
  assert.equal(service.pendingBatches().batches.length, 0, '免审路径不该留待审批次');
  const rows = store.listMemories({ limit: 10 }).items;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.source, '自主捕获');
    assert.equal(row.kind, 'auto');
    assert.equal(row.meta.capturedFrom, 's1');
  }

  const status = service.captureStatus();
  assert.equal(status.subscribed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'direct');
  assert.equal(status.lastRun.mode, 'direct');
  assert.equal(status.lastRun.added, 2);
  assert.equal(status.lastRun.error, null);
  assert.equal(status.lastRun.elapsedMs >= 0, true);
});

test('自主捕获：子代理会话 → 进待审区，再由 agent 审阅后入库', async () => {
  // 本条只验「来源归属 → 待审 → agent 审阅」这条路由，所以关掉新加的第二道闸
  // （`capture.dropTransient`）：夹具文本「子代理抽到的一条」在语义上正是会被过滤器丢掉的
  // 工具态描述，开着它就到不了待审区（过滤器自己的行为由后面两条新用例覆盖）。
  const { service, store, listeners } = makeService({
    config: { capture: { dropTransient: false } },
    facts: ['子代理抽到的一条'],
    relation: 'coexist',
  });
  const listener = listeners.get('session/event');

  feedTurn(listener, session('sub1', { origin: 'subagent' }), '乙'.repeat(200));
  await waitFor(() => store.countMemories() === 1);

  // 免审规则**只**给连入的那个 agent：子代理的东西必须过待审 + agent 审阅
  const status = service.captureStatus();
  assert.equal(status.lastRun.mode, 'pending', '子代理会话要走待审路径');
  assert.equal(status.lastRun.foreign, true);
  assert.equal(status.lastRun.batchId !== null, true);
  assert.equal(status.reviewAgent, true);
  assert.equal(status.lastRun.reviewed.ok, true, 'agent 审阅应当跑过');

  const rows = store.listMemories({ limit: 10 }).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '子代理抽到的一条');
  assert.equal(rows[0].kind, 'extracted', '经审阅入库的是 extracted（走 reviewBatch）');
  const batches = store.listBatches({});
  assert.equal(batches.length, 1);
  assert.equal(batches[0].state, 'approved', '批次应已关闭');
});

test('自主捕获：阈值不够 / 冷却中 / 关掉开关 → 一条都不抽', async () => {
  const off = makeService({ config: { capture: { enabled: false } } });
  const offListener = off.listeners.get('session/event');
  feedTurn(offListener, session('s-off'), '丙'.repeat(300));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(off.store.countMemories(), 0, 'enabled=false 时不该抽');
  assert.equal(off.service.captureStatus().enabled, false);

  const on = makeService({ facts: ['用户习惯凌晨睡'] });
  const listener = on.listeners.get('session/event');
  feedTurn(listener, session('s-1'), '丁'.repeat(50), { turn: 1 }); // 未到 120 字阈值
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(on.store.countMemories(), 0);
  assert.equal(on.service.captureStatus().skipped >= 1, true, '未到阈值要计入 skipped');

  feedTurn(listener, session('s-1'), '戊'.repeat(200), { turn: 2 });
  await waitFor(() => on.store.countMemories() === 1);
  // 立刻再来一轮：冷却期内不该再抽
  feedTurn(listener, session('s-1'), '己'.repeat(200), { turn: 3 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(on.store.countMemories(), 1, '冷却期内不该再抽一次');
});

test('自主捕获：抽出来的事实过三分类 → durable 直存、transient 丢掉、uncertain 并进待审区', async () => {
  const durable = '用户采纳了「只出变更单、不直接改库」这条语义。';
  const transient = '用户与助手约好用 propose 流程处理那条记忆。';
  const uncertain = '这条事实现在还躺在待审区。';
  const { service, store, listeners } = makeService({ facts: [durable, transient, uncertain] });
  const listener = listeners.get('session/event');
  feedTurn(listener, session('s-filter'), '辛'.repeat(200));
  await waitFor(() => store.countMemories() === 1);

  const rows = store.listMemories({ limit: 10 }).items;
  assert.equal(rows.length, 1, '库里只能有 durable 那一条');
  assert.equal(rows[0].text, durable, '长期决定不许被技术词误杀');
  assert.equal(rows[0].kind, 'auto');

  const status = service.captureStatus();
  assert.equal(status.dropTransient, true, '第二道闸默认开');
  assert.equal(status.lastRun.facts, 2, 'facts = 过闸后留在手上的（durable + uncertain）');
  assert.equal(status.lastRun.added, 1, '只有 durable 直存');
  assert.equal(status.lastRun.droppedTransient, 1, '单次运行要能看到丢掉几条');
  assert.equal(status.droppedTransient, 1, 'capture 状态里的累计计数');
  assert.equal(status.lastRun.deferredToReview, 1, '单次运行要能看到转待审几条');
  assert.equal(status.deferredToReview, 1, 'capture 状态里的累计计数');

  // uncertain 不丢：并进一个待审批次，等人 / 后续审阅（**不自动落库**）
  const batches = service.pendingBatches().batches;
  assert.equal(batches.length, 1, 'uncertain 必须进待审区');
  assert.equal(batches[0].id, status.lastRun.batchId);
  assert.equal(batches[0].state, 'open', '直存路径的 uncertain 批次留给人审，不自动应用');
  const batch = store.getBatch(batches[0].id);
  assert.deepEqual(batch.items.map((item) => item.text), [uncertain], '批次里恰好是那条 uncertain');
});

test('自主捕获：capture.dropTransient=false → 三分类全部保留，三条都按原路径直存', async () => {
  const durable = '用户喜欢冰美式';
  const transient = '用户与助手约定：先改代码再重启';
  const uncertain = '这条事实现在还躺在待审区';
  const { service, store, listeners } = makeService({
    config: { capture: { dropTransient: false } },
    facts: [durable, transient, uncertain],
  });
  const listener = listeners.get('session/event');
  feedTurn(listener, session('s-nofilter'), '壬'.repeat(200));
  await waitFor(() => store.countMemories() === 3);

  assert.deepEqual(
    store.listMemories({ limit: 10 }).items.map((row) => row.text).sort(),
    [durable, transient, uncertain].sort(),
    '关掉三分类后三条都直存（等价于不过闸）',
  );
  const status = service.captureStatus();
  assert.equal(status.dropTransient, false);
  assert.equal(status.lastRun.droppedTransient, 0);
  assert.equal(status.lastRun.deferredToReview, 0);
  assert.equal(status.lastRun.facts, 3);
  assert.equal(status.lastRun.batchId, null, '不过闸就不该有多余批次');
  assert.equal(service.pendingBatches().batches.length, 0);
});

test('自主捕获：待审路径同样过三分类 —— 只有 transient 不进批次，uncertain 照常进待审区', async () => {
  const durable = '用户习惯凌晨睡';
  const transient = '用户与助手约定：先改代码再重启';
  const uncertain = '这条事实现在还躺在待审区。';
  const { service, store, listeners } = makeService({
    facts: [transient, durable, uncertain],
    relation: 'coexist',
  });
  const listener = listeners.get('session/event');
  feedTurn(listener, session('sub-filter', { origin: 'subagent' }), '癸'.repeat(200));
  await waitFor(() => store.countMemories() === 2);

  const status = service.captureStatus();
  assert.equal(status.lastRun.mode, 'pending');
  assert.equal(status.lastRun.droppedTransient, 1);
  assert.equal(status.lastRun.deferredToReview, 1, 'pending 路径的 uncertain 并进同一批次');
  assert.equal(status.lastRun.facts, 2, 'facts = 真正进待审区的条数（durable + uncertain）');

  const batches = store.listBatches({});
  assert.equal(batches.length, 1);
  const batch = store.getBatch(batches[0].id);
  assert.deepEqual(
    batch.items.map((item) => item.text),
    [durable, uncertain],
    '被丢掉的 transient 不许进批次；uncertain 必须进',
  );
  assert.deepEqual(
    store.listMemories({ limit: 10 }).items.map((row) => row.text).sort(),
    [durable, uncertain].sort(),
    'agent 审阅后 durable 与 uncertain 都入库（都经审阅门，不是直存）',
  );
});

test('自主捕获：抽出来的全被判临时 → 一条不落、也不算失败（direct 与 pending 口径一致）', async () => {
  const direct = makeService({ facts: ['用户与助手约定：先改代码再重启'] });
  feedTurn(direct.listeners.get('session/event'), session('s-all-direct'), '子'.repeat(200));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(direct.store.countMemories(), 0, '全被判临时时一条都不落库');
  const directStatus = direct.service.captureStatus();
  assert.equal(directStatus.lastRun.droppedTransient, 1);
  assert.equal(directStatus.lastRun.error, null, 'direct：全被判临时不算失败');

  const pending = makeService({ facts: ['用户与助手约定：先改代码再重启'] });
  feedTurn(pending.listeners.get('session/event'), session('sub-all', { origin: 'subagent' }), '丑'.repeat(200));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(pending.store.countMemories(), 0);
  assert.equal(pending.store.listBatches({}).length, 0, '不建空批次');
  const pendingStatus = pending.service.captureStatus();
  assert.equal(pendingStatus.lastRun.droppedTransient, 1);
  assert.equal(pendingStatus.lastRun.error, null, 'pending：全被判临时同样不记成错误');
  assert.equal(pendingStatus.errors, undefined, 'capture.errors 里也不该出现这条');
});

test('agent 审阅：判定 supersede → 只改旧记忆、不新增；留 history', async () => {
  const { service, store, listeners } = makeService({ facts: ['端口改成 11434'], relation: 'supersede' });
  const old = store.addMemory({ text: '端口是 8080', kind: 'manual', source: '手工' });
  // 冲突判定得先「看得见」旧记忆：给它一个可检索的向量（离线 local-hash，不联网）。
  service.saveEmbeddingProfile({ name: 'local', provider: 'local-hash', model: 't', localDims: 8 });
  service.activateEmbeddingProfile('local');
  await service.startBackfill({});
  await waitFor(() => service.publicBackfill().running !== true);

  const listener = listeners.get('session/event');
  feedTurn(listener, session('sub2', { origin: 'subagent' }), '庚'.repeat(200));
  await waitFor(() => store.getMemory(old.id)?.text === '端口改成 11434');

  assert.equal(store.getMemory(old.id).revision, 2, '旧记忆被改写');
  assert.equal(store.countMemories(), 1, 'supersede 不新增记忆');
  assert.equal(store.listHistory(old.id)[0].op, 'supersede');
  assert.equal(service.captureStatus().lastRun.reviewed.updated, 1);
});
