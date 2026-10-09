/**
 * 仓管（Keeper）测试。
 *
 * 四块：
 *   1. `locallm.js`：自带 LLM 通道的校验与两种端点的请求/响应（用假 fetch，不联网）；
 *   2. `keeper.js`：覆盖率（子序列）与确定性切分 —— ⚠️ 本轮起 `coverageOf()` 只剩「核对工具」身份、
 *      `losslessSplit()` 只剩「模型没给可用碎片时的兜底」身份，都不再是 `split` 的硬判据；
 *   3. `keeper-plan.js` + 服务层：**新范式**（仓管只出变更单，人审才落库）——
 *      出单不动库、`split` 跑「①每块自足 ②不丢内容 ③不新增信息」三条证据
 *      （旧承诺「split 逐字无损 / 子序列 ≥98%」已作废，见 REGRESSION.md）、
 *      `replace` / `merge` **允许**缩写 / 去冗余 / 优化语序 / 同义换词（`replace` 是**唯一修改操作**：
 *      过审后删旧录新；旧模型输出里的 `rewrite` 一律按它处理），
 *      `factCheck()` 只给**证据**（丢了 N 个数字 / 消失的片段 / 压缩到 X% / 缺主语 / 新增片段）
 *      而**不做违规判定**、reject 不写库、只勾选部分 op 时其余不动且 state=partial、
 *      merge 软删其余条、replace 删旧录新（原条软删可恢复）、落库后向量被重排；
 *   4. 仓管档案（线上 / 局域网 / 本机）+ 工具动作（run / plans / plan / review / propose）。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryService } from '../lib/index.js';
import { createLocalLlm } from '../src/host/locallm.js';
import {
  buildGrindRequest,
  coverageOf,
  grindCandidate,
  groupDeadlineMs,
  losslessSplit,
  parseDedupe,
  parseFragments,
} from '../src/host/keeper.js';
import {
  addedTerms,
  anchorsOf,
  buildPlanRequest,
  factCheck,
  factWarnings,
  normalizePlanOps,
  parsePlanOps,
  planWarnings,
  selfContained,
  NO_REASON_WARNING,
  PLAN_PROMPT,
} from '../src/host/keeper-plan.js';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('keeper');

const closers = [];
after(() => {
  for (const close of closers.splice(0)) close();
  cleanupTmpDir(TMP);
});

/** 造一个记录请求的假 fetch。 */
function fakeFetch({ status = 200, payload = {}, body = '' } = {}) {
  const calls = [];
  const impl = async (endpoint, init) => {
    calls.push({ endpoint, init, json: init?.body == null ? null : JSON.parse(String(init.body)) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

// ── 1. 自带的本地 LLM 通道 ────────────────────────────────────────────────────

test('createLocalLlm：配置不完整时给出能照着改的报错', () => {
  assert.throws(() => createLocalLlm({ provider: 'nope', model: 'm' }), /provider 只能是/);
  assert.throws(() => createLocalLlm({ provider: 'ollama', model: '' }), /model 必须是非空字符串/);
  assert.throws(() => createLocalLlm({ provider: 'ollama', model: 'm' }), /必须配 ollamaUrl/);
  assert.throws(() => createLocalLlm({ provider: 'ollama', model: 'm', ollamaUrl: '<局域网 IP>:11434' }), /http:\/\//);
  assert.throws(
    () => createLocalLlm({ provider: 'openai', model: 'm', baseUrl: 'http://<局域网 IP>:8000/v1' }),
    /需要 API 密钥/,
  );
});

test('createLocalLlm：ollama 说 /api/chat，openai 说 /chat/completions（含鉴权头）', async () => {
  const ollama = fakeFetch({ payload: { message: { content: '可用' } } });
  const a = createLocalLlm(
    { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: 'http://<局域网 IP>:11434/' },
    { fetchImpl: ollama },
  );
  assert.equal(a.endpoint, 'http://<局域网 IP>:11434/api/chat', '尾斜杠要归一');
  assert.equal(await a.chat({ messages: [{ role: 'user', content: '在吗' }] }), '可用');
  assert.equal(ollama.calls[0].json.stream, false, '批量加工要完整回答，不用流式');
  assert.equal(ollama.calls[0].json.options.num_ctx, 32768, 'Ollama 默认 num_ctx 太小，要显式调大');
  assert.equal(ollama.calls[0].init.headers.authorization, undefined);

  const openai = fakeFetch({ payload: { choices: [{ message: { content: '可用' } }] } });
  const b = createLocalLlm(
    { provider: 'openai', model: 'qwen2.5', baseUrl: 'http://<局域网 IP>:8000/v1' },
    { fetchImpl: openai, apiKey: 'LAN_KEY' },
  );
  assert.equal(b.endpoint, 'http://<局域网 IP>:8000/v1/chat/completions');
  assert.equal(await b.chat({ messages: [{ role: 'user', content: '在吗' }], maxTokens: 64 }), '可用');
  assert.equal(openai.calls[0].init.headers.authorization, 'Bearer LAN_KEY');
  assert.equal(openai.calls[0].json.max_tokens, 64);
});

test('createLocalLlm：HTTP 失败 / 响应格式不对都报原文，不吞', async () => {
  const bad = fakeFetch({ status: 500, body: 'model not found: qwen3:99b' });
  const client = createLocalLlm({ provider: 'ollama', model: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434' }, { fetchImpl: bad });
  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'x' }] }), /HTTP 500.*model not found/s);

  const weird = fakeFetch({ payload: { nope: true } });
  const client2 = createLocalLlm({ provider: 'ollama', model: 'm', ollamaUrl: 'http://127.0.0.1:11434' }, { fetchImpl: weird });
  await assert.rejects(() => client2.chat({ messages: [{ role: 'user', content: 'x' }] }), /响应格式错误/);
});

// ── 2. 覆盖率核对与保底切分（⚠️ 本轮起都不再是 split 的硬判据）─────────────────────

test('coverageOf：原样切分 = 100%；改写/丢字立刻掉下来', () => {
  const original = '宝宝喜欢冰美式。她习惯凌晨睡。周三要去医院复查。';
  assert.equal(coverageOf(original, ['宝宝喜欢冰美式。', '她习惯凌晨睡。', '周三要去医院复查。']).ok, true);
  assert.equal(coverageOf(original, ['宝宝喜欢冰美式。', '她习惯凌晨睡。', '周三要去医院复查。']).ratio, 1);

  const lossy = coverageOf(original, ['宝宝喜欢冰美式。', '她习惯晚睡。', '要去医院复查。']);
  assert.equal(lossy.ok, false, '改了一个字就不算无损');
  assert.ok(lossy.ratio < 0.98);

  assert.equal(coverageOf('', []).ok, true, '空文本视为无损');
  assert.equal(coverageOf('甲乙丙丁', []).ok, false);
});

test('losslessSplit：按构造无损（一个字符都不丢）且尊重单块上限', () => {
  const original = '第一件事讲清楚一点。'.repeat(12) + '最后一句';
  const pieces = losslessSplit(original, { maxChars: 40 });
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.length <= 40, `单块超限：${piece.length}`);
  assert.equal(coverageOf(original, pieces).ratio, 1, '确定性切分必须 100% 无损');

  const tiny = '很短一句。';
  assert.deepEqual(losslessSplit(tiny, { maxChars: 400 }), [tiny]);
  assert.deepEqual(losslessSplit('   ', {}), []);
});

test('parseFragments / parseDedupe / grindCandidate', () => {
  assert.deepEqual(parseFragments('好的，结果：["甲","乙","甲",""]'), ['甲', '乙']);
  assert.deepEqual(parseFragments('没有数组'), []);
  assert.deepEqual(parseFragments('["截断'), []);

  assert.deepEqual(parseDedupe('{"same":true,"keep":"b","reason":"B 更全"}'), { same: true, keep: 'b', reason: 'B 更全', ok: true });
  assert.equal(parseDedupe('{"same":false}').same, false);
  assert.equal(parseDedupe('乱说').ok, false);
  assert.equal(parseDedupe('{"same":true,"keep":"c"}').keep, null, '非法 keep 归 null');

  assert.equal(grindCandidate({ text: '甲'.repeat(300), meta: {} }, { minChars: 240 }).candidate, true);
  assert.equal(grindCandidate({ text: '短', meta: {} }, { minChars: 240 }).candidate, false);
  assert.equal(
    grindCandidate({ text: '甲'.repeat(300), meta: { keeper: { grind: { at: 'x' } } } }, { minChars: 240 }).candidate,
    false,
    '加工过的不再重做',
  );
  assert.equal(
    grindCandidate({ text: '甲'.repeat(300), meta: { keeper: { grind: {} } } }, { minChars: 240, redo: true }).candidate,
    true,
    'redo 时重做',
  );
  assert.equal(grindCandidate({ text: '甲'.repeat(300), meta: { derivedFrom: 'x' } }, { minChars: 240 }).candidate, false);
});

test('buildGrindRequest：把「不许改写」写进提示词，并把原文夹在标记里', () => {
  const request = buildGrindRequest({ text: '原文内容', maxChars: 400 });
  assert.match(request.messages[0].content, /一个字都不能丢/);
  assert.match(request.messages[1].content, /<原文>\n原文内容\n<\/原文>/);
  assert.equal(request.temperature, 0);
});

// ── 3. 新范式：变更单（keeper-plan.js 纯逻辑 + 服务层 run / review） ───────────

test('factCheck：只产证据 —— 数字是硬信号，消失的片段（引号原话 / emoji 优先）与压缩比是线索', () => {
  const before = '宝宝在 2026-03 复查，指标 3.5，端口 8080，版本 v1.2。她习惯凌晨睡。';
  assert.deepEqual(factCheck(before, before), { ok: true, lengthRatio: 1, missingNumbers: [], missingTerms: [] });

  // 只挪空白不算改动
  assert.deepEqual(factCheck('她习惯凌晨睡', '她习惯\n凌晨睡').missingTerms, []);

  // 同义换词（改成 → 改为）：**允许**，ok 仍是 true，只留一条中性证据
  const synonym = factCheck('把这条记忆改成干练的写法。', '把这条记忆改为干练的写法。');
  assert.equal(synonym.ok, true, '同义改写不是错误');
  assert.deepEqual(synonym.missingTerms, ['把这条记忆改成干练的写法'], '消失的是原来那句话（可读的片段级证据）');
  assert.equal(synonym.lengthRatio, 1, '长度没变就不该有压缩比');

  // 改错别字（按部就分 → 按部就班）同样允许
  const typo = factCheck('他做事按部就分。', '他做事按部就班。');
  assert.equal(typo.ok, true);
  assert.deepEqual(typo.missingTerms, ['他做事按部就分']);

  // 加字（补括注）：不丢任何片段 —— 代码不做「新增」判定，那由提示词 + 人审负责
  const inserted = factCheck('宝宝喜欢冰美式。', '宝宝喜欢冰美式（已确认）。');
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.missingTerms, []);
  assert.equal(inserted.lengthRatio > 1, true);

  // 丢数字 / 日期 → 硬信号：ok:false，数字一个不落列出来
  const dropped = factCheck('宝宝在 2026-03 复查，指标 3.5，端口 8080。', '宝宝在复查，指标，端口。');
  assert.equal(dropped.ok, false, '丢了数字就是硬信号');
  assert.deepEqual(dropped.missingNumbers, ['2026-03', '3.5', '8080'], '带年月日 / 小数 / 端口都要抓出来');
  assert.equal(dropped.missingTerms.length <= 20, true, '片段证据有上限，不能刷屏');

  // 引号原话 / emoji 标签优先列在普通片段前面
  const quoted = factCheck('医生说「记得带报告」，她习惯凌晨睡。', '她习惯熬夜。');
  assert.deepEqual(quoted.missingTerms, ['「记得带报告」', '医生说', '她习惯凌晨睡'], '引号原话排最前，且连引号一起显示');
  const emoji = factCheck('复查 🎥 拍了片子，另外她习惯凌晨睡。', '复查拍了片子，她习惯熬夜。');
  assert.equal(emoji.missingTerms[0], '🎥', 'emoji 是代理对，既不能被切成半个字符、也要排最前');

  // 纯填充词（其实 / 就是）整段消失不算「内容片段」，不刷警告
  assert.deepEqual(factCheck('但是这个可以', '但是可以').missingTerms, []);
  // 原文为空时比率视为 1
  assert.equal(factCheck('', '随便').lengthRatio, 1);
});

test('factWarnings / planWarnings：中性措辞（丢数字 / 消失的片段 / 压缩比 / 缺主语），不出现「违规」定性', () => {
  const warnings = factWarnings('宝宝在 2026-03 复查，指标 3.5，端口 8080，版本 v1.2。', '宝宝复查。');
  // ⚠️ 本轮（用户 2026-10-07「每块必须自足」）新增第 4 条证据：after 把原文锚点（2026-03 / 3.5 / 8080 / v1.2）
  // 全丢了 → 「这块可能缺主语」。断言从 3 条改成 4 条，前三条的语义与顺序一个都没动。
  assert.equal(warnings.length, 4, '丢数字 + 消失片段 + 压缩到极低 + 缺主语，四条都要出');
  assert.equal(warnings[0], '丢了 4 个数字：2026-03 / 3.5 / 8080 / 1.2');
  assert.match(warnings[1], /^消失的片段：/);
  assert.match(warnings[1], /v1\.2/, '带数字的片段（版本号）也要优先列');
  assert.match(warnings[2], /^压缩到 13%（留意是否过度缩写）$/);
  assert.match(warnings[3], /^这块可能缺主语：宝宝复查。（脱离上下文会被读成全局）$/);

  // 同义改写：只有一条中性证据，绝不出现「违规 / 不是纯删除 / 只准删」这类定性。
  // 也顺带钉住新证据不会乱报：原文提不出锚点 → 不报缺主语；只差一个「为」字（没有连续新字）→ 不报新增。
  const synonym = factWarnings('把这条记忆改成干练的写法。', '把这条记忆改为干练的写法。');
  assert.deepEqual(synonym, ['消失的片段：把这条记忆改成干练的写法']);
  assert.equal(synonym.some((line) => /违规|不是纯删除|只准删|不许改/.test(line)), false, '不允许的措辞一个都不许留');

  // 正常去冗余变短 → 有压缩比、但**没有**「留意过度缩写」
  const normal = factWarnings('宝宝喜欢喝冰美式，早上起来必喝一杯，就是每天都喝。', '宝宝喜欢喝冰美式，早上必喝一杯。');
  assert.deepEqual(normal, ['消失的片段：早上起来必喝一杯 / 就是每天都喝', '压缩到 64%']);
  assert.equal(normal.some((line) => line.includes('留意')), false, '正常变短不报警');

  // 压得极狠（< 40%）才附「留意是否过度缩写」
  const heavy = factWarnings('宝宝在 2026-03 复查，指标 3.5，端口 8080，医生说要复查三次。', '宝宝复查。');
  assert.equal(heavy.some((line) => /压缩到 \d+%（留意是否过度缩写）/.test(line)), true);

  // 一字不动的改写 = 零噪音
  assert.deepEqual(factWarnings('原文一字不动', '原文一字不动'), []);

  assert.deepEqual(
    planWarnings([
      { idx: 0, warnings: ['丢了 2 个数字：3.5 / 2026-03'] },
      { idx: 1, warnings: ['兜底切分（模型输出覆盖率 71%）'] },
      { idx: 2 },
    ]),
    ['#1 丢了 2 个数字：3.5 / 2026-03', '#2 兜底切分（模型输出覆盖率 71%）'],
  );
});

test('buildPlanRequest：四种操作与「过期=加时间锚」写进提示词，并点出哪些是大段', () => {
  const long = '第一件事讲清楚。'.repeat(30);
  const request = buildPlanRequest({
    members: [
      { id: 'm1', text: long },
      { id: 'm2', text: '短的一条' },
    ],
    minChars: 240,
    splitChars: 120,
  });
  assert.match(request.messages[0].content, /只出单，不落库/);
  assert.match(request.messages[0].content, /split：把一条大段记忆拆成若干原子事实/);
  assert.match(request.messages[0].content, /只能切分/);
  assert.match(request.messages[0].content, /replace/);
  assert.match(request.messages[0].content, /过审后删除原记忆、录入这条新记忆/);
  assert.match(request.messages[0].content, /merge/);
  assert.match(request.messages[0].content, /drop/);
  // 统一修改语义：修改类只有 replace，旧的 rewrite 类型不再出现在提示词里
  assert.equal(
    /"type"\s*:\s*"rewrite"/.test(request.messages[0].content),
    false,
    '旧 rewrite 类型必须从提示词里清干净（不留「原地改写」这条老路径）',
  );
  assert.match(request.messages[0].content, /过期 ≠ 删除/);
  assert.match(request.messages[0].content, /（2026-10 前）/, '要给模型一个时间锚的写法示例');
  // 最终语义（用户原话「灵活一些 让LLM视情况决策 缩写、去冗余、优化语序 都是被允许的」）
  assert.match(request.messages[0].content, /缩写、去掉重复啰嗦、优化语序/);
  assert.match(request.messages[0].content, /事实要点一个都不许丢/);
  assert.match(request.messages[0].content, /引号里的原话/, '引号原话是硬要点');
  assert.match(request.messages[0].content, /emoji 与标签符号/, 'emoji / 标签符号是硬要点');
  assert.match(request.messages[0].content, /不许新增/);
  assert.match(request.messages[0].content, /不许把不确定的写成确定的/);
  assert.equal(
    /只准删|不准改|after 必须是原文的子序列|标红/.test(request.messages[0].content),
    false,
    '过严那版的口径（只准删 / 子序列 / 标红）必须清干净',
  );
  assert.match(request.messages[1].content, /\[m1\]/, '正文要带 id 交给模型');
  const hintLine = request.messages[1].content.split('\n')[0];
  assert.match(hintLine, /大段/);
  assert.match(hintLine, /m1/);
  assert.equal(hintLine.includes('m2'), false, '短的那条不该被点名');
  assert.equal(request.temperature, 0);
});

test('parsePlanOps / normalizePlanOps：非法项丢弃；split 有损不再兜底抹平（改成证据）；旧 rewrite 归一成 replace；merge 单目标 = replace', () => {
  assert.deepEqual(parsePlanOps('没有数组'), []);
  assert.deepEqual(parsePlanOps('["字符串数组"]'), []);
  assert.deepEqual(
    parsePlanOps('[{"type":"REWRITE","targets":"m1","after":"新","reason":"r"},{"type":"乱写","targets":["m1"]}]').map((op) => [
      op.type,
      op.targets,
    ]),
    [['rewrite', ['m1']]],
    'type 归一成小写，非法 type 丢掉，单个 targets 也能收',
  );

  const members = [
    { id: 'm1', text: '甲'.repeat(150) + '。' + '乙'.repeat(150) + '。' + '丙'.repeat(150) },
    { id: 'm2', text: '宝宝在 2026-03 复查，指标 3.5。' },
    { id: 'm3', text: '宝宝在 2026-03 复查，指标 3.5。' },
  ];

  // 模型「总结」成两句话（有损）→ **原样采信**，损失与缺主语照报成证据。
  // ⚠️ 旧断言（`warnings[0]` 必须是「兜底切分（模型输出覆盖率 N%）」+ `coverageOf(...).ratio === 1`）
  // 随「split 逐字无损 / 子序列 ≥98%」这条旧承诺一起作废：为了每块自足要允许重复主语词，
  // 重复出来的字符天然不是子序列，再按覆盖率兜底就会把想要的输出丢掉（见 REGRESSION.md 本轮）。
  const splitOps = normalizePlanOps(
    JSON.stringify([{ type: 'split', targets: ['m1'], after: ['甲很多。', '乙也不少。'], reason: '拆细' }]),
    { members, splitChars: 200 },
  );
  assert.equal(splitOps.length, 1);
  assert.equal(splitOps[0].type, 'split');
  assert.equal(splitOps[0].idx, 0);
  assert.deepEqual(splitOps[0].after, ['甲很多。', '乙也不少。'], '模型给什么就收什么，不再冒充逐字无损');
  assert.equal(splitOps[0].warnings.some((line) => /^这块可能缺主语：/.test(line)), true, '两块都没带锚点 → 逐块报缺主语');
  assert.equal(splitOps[0].warnings.some((line) => /^新增了原文没有的片段：/.test(line)), true, '「很多 / 不少」是原文字典里没有的新字');
  assert.equal(splitOps[0].warnings.some((line) => /^消失的片段：/.test(line)), true, '不丢内容这条证据照旧');
  assert.deepEqual(splitOps[0].before, [{ id: 'm1', text: members[0].text }]);

  // 模型输出本来就无损（逐块也带着原文的锚点）→ 原样采信，零警告
  const exact = normalizePlanOps(
    JSON.stringify([{ type: 'split', targets: ['m1'], after: ['甲'.repeat(150) + '。', '乙'.repeat(150) + '。' + '丙'.repeat(150)] }]),
    { members, splitChars: 200 },
  );
  assert.equal(exact.length, 1);
  assert.deepEqual(exact[0].warnings, []);
  assert.equal(coverageOf(members[0].text, exact[0].after).ratio, 1);

  // 拆不开（兜底切分也只有一块）→ 不出这条 op
  assert.deepEqual(
    normalizePlanOps(JSON.stringify([{ type: 'split', targets: ['t1'], after: ['就是这条'] }]), {
      members: [{ id: 't1', text: '就是这一条短记忆' }],
    }),
    [],
  );

  // merge 只有一条目标 → 按「纯修改」`replace` 处理；两条 → 真 merge，且事实校验拿两条原文的并集比
  const single = normalizePlanOps(JSON.stringify([{ type: 'merge', targets: ['m2'], after: '宝宝 2026-03 复查，指标 3.5。' }]), { members });
  assert.equal(single[0].type, 'replace');
  assert.deepEqual(single[0].targets, ['m2']);

  const merged = normalizePlanOps(
    JSON.stringify([{ type: 'merge', targets: ['m2', 'm3'], after: '宝宝复查过，指标还行。' }]),
    { members },
  );
  assert.equal(merged[0].type, 'merge');
  assert.deepEqual(merged[0].targets, ['m2', 'm3']);
  assert.equal(merged[0].before.length, 2, 'merge 的 before 要含全部被并的条');
  // ⚠️ 本轮新增两条证据（缺主语 / 新增片段）：after「宝宝复查过，指标还行。」既把原文锚点
  // （2026-03 / 3.5）全丢了，又造出原文没有的「还行」—— 断言从 3 条改成 5 条，前三条不变。
  assert.equal(merged[0].warnings.length, 5, '丢数字 + 消失的片段 + 压缩比 + 缺主语 + 新增片段，五条证据都要出');
  assert.equal(merged[0].warnings[0], '丢了 2 个数字：2026-03 / 3.5');
  assert.match(merged[0].warnings[1], /^消失的片段：/);
  assert.match(merged[0].warnings[2], /^压缩到 \d+%（留意是否过度缩写）$/, 'merge 拿并集当分母，多路合并天然压得很狠');
  assert.match(merged[0].warnings[3], /^这块可能缺主语：/);
  assert.match(merged[0].warnings[4], /^新增了原文没有的片段：/);
  assert.equal(merged[0].warnings.some((line) => /违规|不是纯删除|只准删/.test(line)), false);

  // merge 的 after 给成数组时，实现口径是**按换行 join 成串**（`normalizePlanOps` 里那支 join），
  // 不是原样收数组 —— 面板/工具读到的 op.after 永远是字符串。
  const joinedAfter = normalizePlanOps(
    JSON.stringify([{ type: 'merge', targets: ['m2', 'm3'], after: [members[1].text, '（2026-03 复查，指标 3.5）'] }]),
    { members },
  );
  assert.equal(joinedAfter[0].type, 'merge');
  assert.equal(joinedAfter[0].after, `${members[1].text}\n（2026-03 复查，指标 3.5）`, '数组 after 按 \\n join 成串');
  assert.equal(typeof joinedAfter[0].after, 'string');
  assert.equal(joinedAfter[0].warnings.some((line) => /违规|不是纯删除|只准删/.test(line)), false);

  // 旧 `rewrite` 一样的收法（after 数组走同一支 join），但**归一成 `replace`** ——
  // 统一修改语义是「删旧录新」，系统里没有「原地改写同一条」这条路径。
  const replaceArray = normalizePlanOps(
    JSON.stringify([{ type: 'rewrite', targets: ['m2'], after: [members[1].text + '（已确认）'] }]),
    { members },
  );
  assert.equal(replaceArray[0].type, 'replace', '旧 rewrite 一律归一到 replace');
  assert.equal(replaceArray[0].after, members[1].text + '（已确认）');

  // 与原文一字不差（抹掉空白后相同）的 replace 不出 op：没有变更就不是变更
  assert.deepEqual(
    normalizePlanOps(JSON.stringify([{ type: 'replace', targets: ['m2'], after: members[1].text }]), { members }),
    [],
    '新正文与原文相同 → 不出这条 op',
  );

  // drop 与「目标不存在 / after 为空」的丢弃
  const dropped = normalizePlanOps(JSON.stringify([{ type: 'drop', targets: ['m3'], reason: '完全重复' }]), { members });
  assert.equal(dropped[0].type, 'drop');
  assert.equal(dropped[0].after, '');
  assert.deepEqual(normalizePlanOps(JSON.stringify([{ type: 'drop', targets: ['不存在'] }]), { members }), []);
  assert.deepEqual(normalizePlanOps(JSON.stringify([{ type: 'rewrite', targets: ['m2'], after: '   ' }]), { members }), []);
});

/**
 * 造服务 + 假仓管客户端。
 *
 * `searchText` 默认被换成一个可控的桩（返回 `neighbors` 指定的邻居）：
 * run 的「语义召回」不该在单元测试里真去打嵌入端点。
 *
 * @param {object} [options] 选项（`dataDir` 可复用同一个库目录、`ensure:false` 可让实例**先不开库**，
 *   用来模拟「重启后第一次打开面板」）
 * @returns {{service: MemoryService, store: object|null, client: object, replies: string[], calls: object[], close: () => void}} 组合
 */
function makeService({ keeper = {}, replies = [], neighbors = () => [], dataDir = null, ensure = true } = {}) {
  const calls = [];
  const disposers = [];
  const client = {
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://127.0.0.1:11434/api/chat',
    async chat(input) {
      calls.push(input);
      const next = replies.length > 0 ? replies.shift() : '[]';
      if (typeof next === 'string') return next;
      throw next;
    },
  };
  const ctx = {
    effect(cb) {
      const dispose = cb();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    on() {
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get: () => undefined,
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  /** 关掉这个实例的库句柄（幂等：disposers 取走就空了）。 */
  const close = () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  // 每个用例都要关掉自己的库句柄，否则 Windows 上清临时目录会 EPERM
  closers.push(close);
  const service = new MemoryService(ctx, {
    dataDir: dataDir ?? join(TMP, `data-${Math.random().toString(36).slice(2, 8)}`),
    keeper: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', model: 'fake-keeper', ...keeper },
  });
  service.createKeeperClient = async () => client;
  const store = ensure === true ? service.ensureStore() : null;
  service.searchText = async ({ query }) => ({ ok: true, items: neighbors(String(query)) });
  return { service, store, client, replies, calls, close };
}

/**
 * 等仓管任务跑完。
 *
 * @param {MemoryService} service 服务
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} 最终状态
 */
async function waitKeeper(service, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (service.publicKeeper().running === true) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('仓管任务超时未结束');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return service.publicKeeper();
}

/**
 * 把库里的记忆拍成快照串（用于断言「出单阶段一个字都没改」）。
 *
 * @param {object} store 仓储
 * @returns {string[]} 快照
 */
function memorySnapshot(store) {
  return store
    .listMemories({ limit: 500, includeDeleted: true })
    .items.map((row) => `${row.id}|${row.text}|${row.updated_at}|${row.revision}|${row.deleted_at ?? ''}|${JSON.stringify(row.meta)}`)
    .sort();
}

/**
 * 造一个「照着提示词里的 id 出 op」的假仓管客户端（种子是随机抽的，不能写死 id）。
 *
 * @param {object} store 仓储
 * @param {(id: string, text: string) => object} makeOp 由 id 造一条 op
 * @returns {object} 客户端
 */
function echoingClient(store, makeOp) {
  return {
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    async chat(input) {
      const ids = [...String(input?.messages?.[1]?.content ?? '').matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]);
      const id = ids[0];
      return JSON.stringify([makeOp(id, store.getMemory(id)?.text ?? '')]);
    },
  };
}

test('run：出单阶段**一个字都不写记忆库**，只多一张 open 变更单', async () => {
  const { service, store } = makeService({
    keeper: { minChars: 10, sampleSize: 1, perGroup: 2 },
    // 邻居用「除了自己以外的两条」造出来（真实实现是 embedding 召回）
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text, vectorScore: 0.9 })),
  });
  const a = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。', kind: 'manual', meta: { note: '原始' } });
  const b = store.addMemory({ text: '她习惯凌晨睡，闹钟设在 7:30。' });
  const c = store.addMemory({ text: '周三要去医院复查，指标 3.5 要带上。' });
  const before = memorySnapshot(store);
  const vectorsBefore = store.countVectors();

  service.createKeeperClient = async () =>
    echoingClient(store, (id, text) => ({ type: 'rewrite', targets: [id], after: `${text}（已确认）`, reason: '更干练' }));

  const started = await service.startKeeperRun({ sample: 1, perGroup: 2 });
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.equal(typeof started.runId, 'string');
  assert.equal(started.planned, 1);
  assert.equal(started.keeper.mode, 'run');
  // 面板靠这个字段决定要不要开始轮询：启动响应里的 job 是**摊平**在 `keeper` 上的
  // （`/state` 与 GET `/keeper` 那份才在 `keeper.job` 下），没有 `keeper.job.running` 这一层。
  assert.equal(started.keeper.running, true, '启动响应要带 keeper.running');
  assert.equal(started.keeper.job, undefined, '启动响应没有 keeper.job 这一层');
  // 而 `/state` 与 GET `/keeper` 那份（keeperStatus()）是**包在 `keeper.job` 下**的：
  // 面板刚打开时靠 `data.keeper.job.running` 决定要不要开始轮询（见 lib/client.js）。
  assert.equal(service.keeperStatus().job.running, true, '/state 那份在 keeper.job 下');

  const job = await waitKeeper(service);
  assert.equal(job.running, false);
  assert.equal(job.mode, 'run');
  assert.equal(job.error, null);
  assert.equal(job.tail.length >= 1, true);
  assert.match(job.tail[job.tail.length - 1], /^组 1：\d+ 条操作/, 'tail 里要写「组 N：M 条操作」');

  // 记忆库：文本 / meta / updated_at / revision / deleted_at 全部原样
  // （计分列不在快照里：run 会按需求给「进组」的条目 tidy +1，那条口径由专门的计分用例钉住）
  assert.deepEqual(memorySnapshot(store), before, '出单阶段一个字段都不许改');
  assert.equal(store.countVectors(), vectorsBefore, '也不该动向量');
  assert.equal(store.countMemories(), 3);
  // 出单阶段不留任何「仓管痕迹」：没有 derivedFrom 产物、没有 meta.keeper 标记、没有替换凭据
  assert.deepEqual(store.listKeeperArtifacts(), { derived: [], rewritten: [], merged: [], replaced: [] });
  assert.equal(store.getMemory(a.id).meta.keeper, undefined, '改写的痕迹只在落库后才该出现');
  assert.equal(store.getMemory(a.id).meta.derivedFrom, undefined);

  // 只多了一张 open 变更单（另有 jobs 表里一条审计，属于刻意记录）
  const plans = store.listKeeperPlans();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].state, 'open');
  assert.equal(plans[0].runId, started.runId);
  assert.equal(plans[0].reviewedAt, null);
  assert.equal(plans[0].memberIds.length >= 1, true);
  assert.ok([a.id, b.id, c.id].includes(plans[0].seedId));
  assert.equal(store.getJob(started.runId).kind, 'keeper:run', 'runId 同时是审计任务 id');

  // 审阅之前，变更单永远不会自己生效
  const readBack = service.listKeeperPlans({ state: 'open' });
  assert.equal(readBack.ok, true);
  assert.equal(readBack.plans.length, 1);
  assert.deepEqual(readBack.plans[0].ops[0].before.map((row) => row.id), plans[0].ops[0].targets);
});

test('run：没有可用变更时不出单，且 group/种子参数如实进状态', async () => {
  const { service, store } = makeService({ replies: ['[]'] });
  store.addMemory({ text: '第一条记忆正文。' });
  store.addMemory({ text: '第二条记忆正文。' });

  const started = await service.startKeeperRun({ sample: 2, perGroup: 3 });
  assert.equal(started.planned, 2);
  assert.equal(service.publicKeeper().running, true);
  const job = await waitKeeper(service);
  assert.equal(job.plans, 0, '模型没给出操作就不该有单');
  assert.equal(job.skipped, 2);
  assert.deepEqual(store.listKeeperPlans(), []);

  // maxGroups 截断
  const limited = await service.startKeeperRun({ sample: 2, perGroup: 3, maxGroups: 1 });
  assert.equal(limited.planned, 1);
  await waitKeeper(service);
  assert.deepEqual(store.listKeeperPlans(), []);
});

test("run：mode='digest' → 提示词偏重去重合并，'grind' / 省略 → 全部手段（两次调用的提示词真的不同）", async () => {
  const { service, store, calls } = makeService({ replies: ['[]', '[]', '[]'] });
  store.addMemory({ text: '第一条记忆正文。' });
  store.addMemory({ text: '第二条记忆正文。' });

  const digest = await service.startKeeperRun({ mode: 'digest', sample: 1 });
  assert.equal(digest.keeper.emphasis, 'dedupe', '启动响应的 keeper.emphasis 要如实');
  await waitKeeper(service);

  const grind = await service.startKeeperRun({ mode: 'grind', sample: 1 });
  assert.equal(grind.keeper.emphasis, 'all', "'grind' = 全部手段");
  await waitKeeper(service);

  const omitted = await service.startKeeperRun({ sample: 1 });
  assert.equal(omitted.keeper.emphasis, 'all', '省略 mode = 全部手段');
  const job = await waitKeeper(service);

  assert.equal(calls.length, 3, '三轮 run 各一次 LLM 调用');
  const system = (index) => String(calls[index]?.messages?.[0]?.content ?? '');
  assert.match(system(0), /偏重去重合并/, "mode:'digest' 的提示词必须带侧重引导");
  assert.equal(/偏重去重合并/.test(system(1)), false, "mode:'grind' 不带侧重引导");
  assert.equal(/偏重去重合并/.test(system(2)), false, '省略 mode 也不带侧重引导');
  assert.notEqual(system(0), system(1), '两次调用产出的提示词必须不同（否则两个按钮就是在做同一件事）');
  // 侧重不是第二种任务：job 的旧形状（mode 恒为 'run'）没被破坏，侧重另记在 emphasis 上。
  assert.equal(job.mode, 'run');
  assert.equal(job.emphasis, 'all');
  assert.equal(store.listKeeperPlans().length, 0, '三类侧重都只出单，没有 op 就不落单');
});

test('run：已被前面的组覆盖过的种子不再单开一组', async () => {
  const { service, store } = makeService({
    // 第一组的种子会把另外两条都召回成邻居；轮到它们时应该直接跳过
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text })),
  });
  store.addMemory({ text: '甲组一号记忆正文。' });
  store.addMemory({ text: '甲组二号记忆正文。' });
  store.addMemory({ text: '甲组三号记忆正文。' });
  service.createKeeperClient = async () =>
    echoingClient(store, (id, text) => ({ type: 'rewrite', targets: [id], after: `${text}（组内改写）`, reason: 'r' }));

  await service.startKeeperRun({ sample: 3, perGroup: 5 });
  const job = await waitKeeper(service);
  assert.equal(job.total, 3, '三个种子都要过一遍');
  assert.equal(job.plans, 1, '只有第一组真的出了一张单');
  assert.equal(job.skipped, 2, '后两个种子被第一组覆盖 → 跳过');
  assert.equal(job.tail.filter((line) => line.includes('跳过')).length, 2);
  assert.equal(store.listKeeperPlans().length, 1);
  assert.equal(store.listKeeperPlans()[0].memberIds.length, 3, '第一组应当把三条都收进来');
});

test('split 落库：第 1 块改写原文、其余带 derivedFrom 入库（模型有损不再被兜底掩盖，损失照报）', async () => {
  const original = '甲'.repeat(150) + '。' + '乙'.repeat(150) + '。' + '丙'.repeat(150);
  const { service, store } = makeService({ keeper: { minChars: 10, splitChars: 200 } });
  const row = store.addMemory({ text: original, meta: { keep: 'me' } });
  // 模型偷懒「总结」——旧行为是丢掉它、兜底成 100% 无损；现在**原样收下**并把损失报成证据
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'split', targets: [row.id], after: ['甲很多。', '乙也不少。'], reason: '拆细' }]),
  });

  const started = await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);

  const plan = store.getKeeperPlan(store.listKeeperPlans()[0].id);
  const op = plan.ops[0];
  assert.equal(op.type, 'split');
  // ⚠️ 旧断言（`warnings.length === 1` + 「兜底切分（覆盖率 N%）」+ `coverageOf(...).ratio === 1`）
  // 随「split 逐字无损」旧承诺作废：允许为自足重复主语词之后，子序列覆盖率不再是判据。
  assert.deepEqual(op.after, ['甲很多。', '乙也不少。'], '模型给的两块原样采信');
  assert.equal(op.warnings.some((line) => /^这块可能缺主语：/.test(line)), true, '两块都没带锚点 → 缺主语证据');
  assert.equal(op.warnings.some((line) => /^消失的片段：/.test(line)), true, '丢掉的内容照样有人话证据');
  assert.ok(coverageOf(original, op.after).ratio < 1, '有损就是有损：不再用兜底把它抹平成 1.0');

  const reviewed = await service.reviewKeeperPlan({ id: plan.id });
  assert.equal(reviewed.ok, true);
  assert.deepEqual(reviewed.applied, { replace: 0, split: 1, merge: 0, drop: 0 });
  assert.equal(reviewed.state, 'approved');

  const kept = store.getMemory(row.id);
  const derived = store.listKeeperArtifacts().derived.map((item) => item.text);
  assert.deepEqual([kept.text, ...derived], ['甲很多。', '乙也不少。'], '第 1 块改写原文、其余带 derivedFrom 入库');
  assert.equal(kept.meta.keep, 'me', '原有 meta 不能被冲掉');
  assert.equal(derived.length >= 1, true);
  assert.equal(store.getKeeperPlan(plan.id).state, 'approved');
  assert.equal(typeof store.getKeeperPlan(plan.id).reviewedAt, 'string');
  assert.equal(started.runId, plan.runId);
});

test('replace 落库：丢数字 / 消失的片段写成 op 证据；过审后删旧录新（原条软删、新条新 id）', async () => {
  const { service, store } = makeService();
  const original = '宝宝在 2026-03 复查，指标 3.5，端口 8080。';
  const row = store.addMemory({ text: original });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    // 旧提示词时期的 `rewrite` 输出**也一律按 `replace` 处理**（不留「原地改写同一条」老路径）
    chat: async () => JSON.stringify([{ type: 'rewrite', targets: [row.id], after: '宝宝复查过，指标还行。', reason: '更干练' }]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);

  const plan = store.getKeeperPlan(store.listKeeperPlans()[0].id);
  assert.equal(plan.ops[0].type, 'replace', "旧的 'rewrite' 一律归一成 'replace'");
  assert.deepEqual(plan.ops[0].warnings, [
    '丢了 3 个数字：2026-03 / 3.5 / 8080',
    '消失的片段：宝宝在 / 端口',
    '压缩到 37%（留意是否过度缩写）',
    // 本轮新增两条自足性证据：锚点（2026-03 / 3.5 / 8080）全丢 → 缺主语；「还行」原文里没有 → 新增片段
    '这块可能缺主语：宝宝复查过，指标还行。（脱离上下文会被读成全局）',
    '新增了原文没有的片段：宝宝复查过，指标还行。（可能是模型自己加的）',
  ]);
  assert.equal(
    service.getKeeperPlan(plan.id).plan.warnings.includes(`#1 ${plan.ops[0].warnings[0]}`),
    true,
    '单级 warnings 也要带出来',
  );

  const reviewed = await service.reviewKeeperPlan({ id: plan.id });
  assert.equal(reviewed.applied.replace, 1, '证据不改判：人点通过就落库');
  assert.equal(reviewed.applied.rewrite, undefined, '旧的 rewrite 计数键必须去掉');
  const newId = reviewed.replaced[0].to;
  // 旧条：软删（行仍在、可恢复），原文完整留在 history
  assert.equal(store.getMemory(row.id), null, '原记忆从可见记忆里消失');
  assert.equal(store.getMemory(row.id, { includeDeleted: true }).text, original, '软删 = 行仍在、正文一个字没动');
  assert.equal(store.listHistory(row.id)[0].op, 'delete');
  assert.equal(store.listHistory(row.id)[0].note, 'keeper:replace');
  // 新条：新 id、正文 = after、meta.replaces 指向原条
  assert.notEqual(newId, row.id, '新记忆必须是新 id');
  assert.equal(store.getMemory(newId).text, '宝宝复查过，指标还行。');
  assert.equal(store.getMemory(newId).meta.replaces, row.id);
  assert.equal(store.listHistory(newId)[0].op, 'add');
  assert.equal(store.getKeeperPlan(plan.id).ops[0].newId, newId, '新 id 写回 op（面板显示「新记忆 id」）');
});

test('计分：run 给进组的每条 tidy 恰好 +1（同轮不重复）；分组召回绝不给 read 加分', async () => {
  /** 被反复召回的那一条（所有种子都召回它，验证「同轮只算一次」）。 */
  let target = null;
  const { service, store } = makeService({
    keeper: { minChars: 5, sampleSize: 4, perGroup: 1 },
    // 每次都召回同一条：它必然进某一组，之后被 `covered` 挡住，绝不该被加第二次。
    neighbors: () => (target === null ? [] : [{ id: target.id, text: target.text, vectorScore: 0.9 }]),
  });
  const rows = [];
  for (let i = 1; i <= 6; i += 1) rows.push(store.addMemory({ text: `第 ${i} 条：足够长的记忆内容。` }));
  target = rows[0];

  service.createKeeperClient = async () =>
    echoingClient(store, (id) => ({ type: 'drop', targets: [id], reason: '测试用的空操作' }));

  await service.startKeeperRun({ sample: 4, perGroup: 1 });
  const job = await waitKeeper(service);
  assert.equal(job.error, null);
  assert.ok(job.plans >= 2, `至少两组才谈得上「同轮重复」（实际 ${job.plans} 组）`);

  const plans = store.listKeeperPlans();
  const memberUnion = new Set(plans.flatMap((plan) => plan.memberIds));
  assert.ok(memberUnion.size >= 3, '进组的 id 应当不止一两个');

  for (const row of store.listMemories({ limit: 20 }).items) {
    assert.equal(
      row.readScore,
      0,
      `仓管分组召回不是「被 agent 正常读取」→ read 必须保持 0（${row.text}）`,
    );
    assert.equal(
      row.tidyScore,
      memberUnion.has(row.id) ? 1 : 0,
      `tidy 只在「进过组」的条目上 +1、且同轮只算一次（${row.text}）`,
    );
  }
  assert.equal(store.getMemory(target.id).tidyScore, 1, '被反复召回的那条也只 +1');
});

test('计分：split 碎片 / replace 新条 tidyScore 初始 = 1；既有保留条不重复加', async () => {
  const { service, store } = makeService();
  const splitSource = store.addMemory({ text: '甲'.repeat(30) + '。' + '乙'.repeat(30) + '。' });
  const replaceSource = store.addMemory({ text: '宝宝在 2026-03 复查，指标 3.5。' });
  const mergeKeep = store.addMemory({ text: '宝宝喜欢喝冰美式。' });
  const mergeDrop = store.addMemory({ text: '宝宝早上必喝一杯冰美式。' });

  // 手工造一张单（不经 run）：run 的计分路径已由上一个用例钉住，这里只看落库时的新记忆初始分。
  const plan = store.createKeeperPlan({
    runId: 'run-scores',
    seedId: splitSource.id,
    memberIds: [splitSource.id, replaceSource.id, mergeKeep.id, mergeDrop.id],
    ops: [
      {
        idx: 0,
        type: 'split',
        targets: [splitSource.id],
        before: [{ id: splitSource.id, text: splitSource.text }],
        after: ['甲块一。', '甲块二。'],
        reason: '拆细',
        warnings: [],
      },
      {
        idx: 1,
        type: 'replace',
        targets: [replaceSource.id],
        before: [{ id: replaceSource.id, text: replaceSource.text }],
        after: '宝宝复查过，指标还行。',
        reason: '更干练',
        warnings: [],
      },
      {
        idx: 2,
        type: 'merge',
        targets: [mergeKeep.id, mergeDrop.id],
        before: [],
        after: '宝宝喜欢喝冰美式，早上必喝一杯。',
        reason: '同一件事',
        warnings: [],
      },
    ],
  });

  const reviewed = await service.reviewKeeperPlan({ id: plan.id });
  assert.equal(reviewed.ok, true);
  assert.deepEqual(reviewed.applied, { replace: 1, split: 1, merge: 1, drop: 0 });

  // split 派生的碎片：新记忆 → tidy 初始 = 1。
  const derived = store.listKeeperArtifacts().derived.filter((row) => row.meta.derivedFrom === splitSource.id);
  assert.equal(derived.length, 1, 'split 只派生出一条碎片');
  assert.equal(derived[0].tidyScore, 1, 'split 碎片初始整理指数 = 1');
  // split 的第 1 块走 updateMemoryText —— 那是**既有行**，不该在这里凭空加初始分。
  assert.equal(store.getMemory(splitSource.id).tidyScore, 0);

  // replace 的新条：tidy 初始 = 1；原条软删。
  const newId = reviewed.replaced[0].to;
  assert.notEqual(newId, replaceSource.id);
  assert.equal(store.getMemory(newId).tidyScore, 1, 'replace 新条初始整理指数 = 1');
  assert.equal(store.getMemory(newId).readScore, 0);
  assert.equal(store.getMemory(replaceSource.id), null, '原条已软删');

  // merge 的保留条是既有行：不加初始分（它只在进组时被加过，本单是手工造的 → 仍是 0）。
  assert.equal(store.getMemory(mergeKeep.id).tidyScore, 0);
  assert.equal(store.getMemory(mergeKeep.id, { includeDeleted: true }).meta.merged.length, 1);
});

test('reject：整单驳回只标记，记忆库一个字都不碰', async () => {
  const { service, store } = makeService();
  const row = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'drop', targets: [row.id], reason: '没用' }]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);
  const plan = store.listKeeperPlans()[0];
  const before = memorySnapshot(store);

  const rejected = await service.reviewKeeperPlan({ id: plan.id, reject: true });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.applied, { replace: 0, split: 0, merge: 0, drop: 0 });
  assert.deepEqual(rejected.replaced, [], '驳回没有「删旧录新」');
  assert.deepEqual(memorySnapshot(store), before, '驳回绝不能碰记忆库');
  assert.equal(store.getKeeperPlan(plan.id).state, 'rejected');
  assert.equal(store.getKeeperPlan(plan.id).review.reject, true);

  // 已经审过的单不能再审一次（避免「驳回之后又被当成 open 应用掉」）
  const again = await service.reviewKeeperPlan({ id: plan.id });
  assert.equal(again.ok, false);
  assert.match(String(again.error), /不能重复审阅/);
  const missing = await service.reviewKeeperPlan({ id: '不存在' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这张变更单/);
  assert.equal((await service.reviewKeeperPlan({ id: '' })).ok, false);
});

test('只勾选部分 op：其余一个字都不动，状态记 partial', async () => {
  const { service, store } = makeService({
    // 两条互为邻居，才能落到同一张单里
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text })),
  });
  const a = store.addMemory({ text: '第一条：宝宝喜欢冰美式。' });
  const b = store.addMemory({ text: '第二条：她习惯凌晨睡。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () =>
      JSON.stringify([
        { type: 'rewrite', targets: [a.id], after: '宝宝喜欢冰美式（早上）。', reason: '加限定' },
        { type: 'rewrite', targets: [b.id], after: '她习惯凌晨睡（工作日）。', reason: '加限定' },
      ]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);
  const plan = store.listKeeperPlans()[0];
  assert.equal(plan.ops.length, 2);

  const bBefore = memorySnapshot(store).find((line) => line.startsWith(`${b.id}|`));
  const reviewed = await service.reviewKeeperPlan({ id: plan.id, keep: [0] });
  assert.equal(reviewed.ok, true);
  assert.deepEqual(reviewed.applied, { replace: 1, split: 0, merge: 0, drop: 0 });
  assert.equal(reviewed.skipped, 1);
  assert.equal(reviewed.state, 'partial', '有跳过就是 partial');

  // 勾选的那条走「删旧录新」：原条软删、新条（新 id）带着改后的正文
  assert.equal(store.getMemory(a.id), null, '原条被（软）删掉');
  assert.equal(store.getMemory(reviewed.replaced[0].to).text, '宝宝喜欢冰美式（早上）。');
  assert.equal(
    memorySnapshot(store).find((line) => line.startsWith(`${b.id}|`)),
    bBefore,
    '没勾选的那条一个字段都不许动',
  );

  // 全勾选 → approved
  const second = makeService();
  second.store.addMemory({ text: '只有一条，随手改写。' });
  second.service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'rewrite', targets: [second.store.listMemories().items[0].id], after: '改好了。' }]),
  });
  await second.service.startKeeperRun({ sample: 1 });
  await waitKeeper(second.service);
  const all = await second.service.reviewKeeperPlan({ id: second.store.listKeeperPlans()[0].id });
  assert.equal(all.state, 'approved');
  assert.equal(all.skipped, 0);
});

test('review 的 edits：能把 op 的 after 换成审阅者自己写的正文（replace 走删旧录新）', async () => {
  const { service, store } = makeService();
  const row = store.addMemory({ text: '原始正文，带 3.5 这个数字。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'replace', targets: [row.id], after: '模型修改（丢了数字）。', reason: 'r' }]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);
  const plan = store.listKeeperPlans()[0];
  const reviewed = await service.reviewKeeperPlan({ id: plan.id, edits: { 0: '人改的正文，3.5 还在。' } });
  assert.equal(reviewed.state, 'approved');
  assert.equal(store.getMemory(reviewed.replaced[0].to).text, '人改的正文，3.5 还在。', 'edits 手改的就是新记忆正文');
  assert.equal(store.getMemory(row.id), null, '原条按统一语义删除（软删）');
});

test('review 的 edits 类型按实现口径：split 收**字符串数组**、merge 收**字符串**', async () => {
  const { service, store } = makeService();
  const original = '甲'.repeat(120) + '。' + '乙'.repeat(120);
  const splitRow = store.addMemory({ text: original });
  // ⚠ 两条正文必须不同：addMemory 按正文 hash 去重，同文会回同一个 id，
  // merge 的 targets[0] 与被并条就成了同一行，看不出「保留一条、软删另一条」。
  // ⚠ addMemory 回的是 `{id, created}`，不是记忆行 —— 正文要自己留一份。
  const firstText = '宝宝在 2026-03 复查，指标 3.5。';
  const secondText = '宝宝 2026-03 复查，指标也是 3.5。';
  const first = store.addMemory({ text: firstText });
  const second = store.addMemory({ text: secondText });

  // 直接建单：这里要钉的是 review 的 edits 分支（类型口径），不是出单链路
  const plan = store.createKeeperPlan({
    runId: 'r-edits',
    seedId: splitRow.id,
    memberIds: [splitRow.id, first.id, second.id],
    ops: [
      { idx: 0, type: 'split', targets: [splitRow.id], before: [{ id: splitRow.id, text: original }], after: ['占位一', '占位二'], reason: '拆细', warnings: [] },
      { idx: 1, type: 'merge', targets: [first.id, second.id], before: [{ id: first.id, text: firstText }, { id: second.id, text: secondText }], after: '占位合并', reason: '同一件事', warnings: [] },
    ],
  });

  const reviewed = await service.reviewKeeperPlan({
    id: plan.id,
    edits: {
      // split：字符串数组（审阅者手写的分块）
      0: ['甲'.repeat(120) + '。', '乙'.repeat(120)],
      // merge：字符串（合并后的整段正文）
      1: '宝宝在 2026-03 复查，指标 3.5。',
    },
  });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.state, 'approved');
  assert.deepEqual(reviewed.applied, { replace: 0, split: 1, merge: 1, drop: 0 });

  // split：第 1 块改写原文，其余块带 derivedFrom 入库。
  // ⚠️ 这里两份正文是**审阅者用 `edits` 手给的**，「拼起来 100% 无损」说的是这手改结果本身；
  // 系统**不再**对 split 承诺逐字无损（旧承诺已作废），所以这条断言只是核对手改内容。
  assert.equal(store.getMemory(splitRow.id).text, '甲'.repeat(120) + '。');
  const derived = store.listKeeperArtifacts().derived;
  assert.deepEqual(derived.map((item) => item.text), ['乙'.repeat(120)]);
  assert.equal(derived[0].meta.derivedFrom, splitRow.id);
  assert.equal(coverageOf(original, [store.getMemory(splitRow.id).text, ...derived.map((item) => item.text)]).ratio, 1);

  // merge：保留 targets[0]（正文 = edits 给的那串）、其余软删
  assert.equal(store.getMemory(first.id).text, '宝宝在 2026-03 复查，指标 3.5。');
  assert.notEqual(store.getMemory(second.id, { includeDeleted: true }).deleted_at, null);
});

test('merge 落库：保留 targets[0]、其余软删（可恢复）且旧向量被清掉', async () => {
  const { service, store } = makeService({
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text })),
  });
  const a = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。' });
  const b = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。带糖。' });
  // 给被并掉的那条塞一条向量，验证落库时会被删（否则检索里会出现 text:null 的幽灵项）
  const space = service.embeddingSpace(service.resolvedConfig()).key;
  store.putVector({ memoryId: b.id, space, provider: 'ollama', model: 'x', dims: 2, vector: new Float32Array([1, 0]) });
  assert.equal(store.countVectors(space), 1);

  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () =>
      JSON.stringify([
        { type: 'merge', targets: [a.id, b.id], after: '宝宝喜欢冰美式，早上必喝一杯（带糖）。', reason: '同一件事' },
      ]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);
  const plan = store.listKeeperPlans()[0];
  assert.equal(plan.ops[0].type, 'merge');

  const reviewed = await service.reviewKeeperPlan({ id: plan.id });
  assert.deepEqual(reviewed.applied, { replace: 0, split: 0, merge: 1, drop: 0 });
  assert.equal(reviewed.state, 'approved');
  assert.equal(store.getMemory(a.id).text, '宝宝喜欢冰美式，早上必喝一杯（带糖）。');
  assert.equal(store.getMemory(a.id, { includeDeleted: true }).deleted_at, null, '保留条还在');
  assert.notEqual(store.getMemory(b.id, { includeDeleted: true }).deleted_at, null, '被并的条软删（不是真删）');
  assert.equal(store.countVectors(space), 0, '被软删那条的旧向量必须清掉');
  assert.equal(store.listHistory(b.id)[0].note, 'keeper:merge');
  assert.equal(store.listHistory(a.id)[0].note, 'keeper:merge');

  // 软删可恢复：这是「合并」敢自动执行的前提
  assert.equal(store.restoreMemory(b.id), true);
  assert.equal(store.getMemory(b.id).text, '宝宝喜欢冰美式，早上必喝一杯。带糖。');
});

test('drop 落库：软删（可恢复），不是真删；理由随 history 留痕', async () => {
  const { service, store } = makeService();
  const row = store.addMemory({ text: '这条完全重复，可以软删。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'drop', targets: [row.id], reason: '与 a1b2 一字不差，纯重复' }]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);
  const reviewed = await service.reviewKeeperPlan({ id: store.listKeeperPlans()[0].id });
  assert.deepEqual(reviewed.applied, { replace: 0, split: 0, merge: 0, drop: 1 });
  assert.equal(reviewed.noReason, 0);
  assert.equal(store.getMemory(row.id), null);
  assert.notEqual(store.getMemory(row.id, { includeDeleted: true }).deleted_at, null);
  // 理由跟着 history 走：事后能查到「当时凭什么删的」。
  assert.equal(store.listHistory(row.id)[0].note, 'keeper:drop（与 a1b2 一字不差，纯重复）');
});

test('PLAN_PROMPT / buildPlanRequest：删除必须写理由，并写明「没理由的删除一律不应用」', () => {
  assert.match(PLAN_PROMPT, /reason 必须写、而且要写到"能说服人"/);
  assert.match(PLAN_PROMPT, /没有理由的删除，系统一律不会应用/);
  const members = [{ id: 'm1', text: '甲'.repeat(60) }];
  const all = buildPlanRequest({ members, minChars: 10, splitChars: 120 });
  const dedupe = buildPlanRequest({ members, minChars: 10, splitChars: 120, emphasis: 'dedupe' });
  assert.match(String(all.messages[0].content), /没有理由的删除，系统一律不会应用/, '全部手段这轮也要写');
  assert.match(String(dedupe.messages[0].content), /没有理由的删除，系统一律不会应用/, '偏重去重合并那轮同样');
});

test('normalizePlanOps：没写理由的删除**照出 op**、但打 reasonMissing + 一条警告（证据可见）', () => {
  const members = [
    { id: 'm1', text: '第一条正文' },
    { id: 'm3', text: '第三条正文' },
  ];
  // 有理由：正常一条 drop、无警告。
  const withReason = normalizePlanOps(JSON.stringify([{ type: 'drop', targets: ['m3'], reason: '与 m1 一字不差' }]), { members });
  assert.equal(withReason.length, 1);
  assert.equal(withReason[0].reasonMissing, false);
  assert.deepEqual(withReason[0].warnings, []);

  // 没理由（字段缺 / 空串 / 纯空白三种写法一样）：op 照出、reasonMissing=true、警告原文一致。
  for (const op of [
    { type: 'drop', targets: ['m3'] },
    { type: 'drop', targets: ['m3'], reason: '' },
    { type: 'drop', targets: ['m3'], reason: '   ' },
  ]) {
    const ops = normalizePlanOps(JSON.stringify([op]), { members });
    assert.equal(ops.length, 1, '不丢掉这条 op：人要看得见模型想删什么');
    assert.equal(ops[0].type, 'drop');
    assert.equal(ops[0].reason, '');
    assert.equal(ops[0].reasonMissing, true);
    assert.deepEqual(ops[0].warnings, [NO_REASON_WARNING]);
    assert.deepEqual(planWarnings(ops), ['#1 ' + NO_REASON_WARNING], '拍平警告里也要带上（工具/面板都读它）');
  }
});

test('删除必须先说服人：没写理由的 drop —— 面板上勾了也不应用，记忆一个字都不动', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const row = store.addMemory({ text: '它想删这条，却没给理由。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'drop', targets: [row.id] }]),
  });

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  await waitKeeper(service);

  const plan = service.listKeeperPlans().plans[0];
  assert.equal(plan.ops[0].type, 'drop');
  assert.equal(plan.ops[0].reasonMissing, true, '结构化标记要写进单里（面板/服务认它）');
  assert.equal(plan.ops[0].reason, '');
  assert.deepEqual(plan.warnings, ['#1 ' + NO_REASON_WARNING]);

  // **显式勾选**这一条：仍然不应用（这就是「没理由的删除永远不会生效」）。
  const reviewed = await service.reviewKeeperPlan({ id: plan.id, keep: [0] });
  assert.deepEqual(reviewed.applied, { replace: 0, split: 0, merge: 0, drop: 0 });
  assert.equal(reviewed.skipped, 1);
  assert.equal(reviewed.noReason, 1, '要能把它和普通 skipped 分开报');
  assert.equal(reviewed.state, 'partial');
  assert.notEqual(store.getMemory(row.id), null, '记忆还在');
  assert.equal(
    store.listHistory(row.id).some((entry) => String(entry.note ?? '').startsWith('keeper:')),
    false,
    '连一条 keeper 痕迹都不该写（history 里只剩 addMemory 那一条）',
  );
  assert.equal(store.getMemory(row.id).deleted_at, null);
});

test('仓管禁止触碰删除：run 与接手全程零删除调用 —— 删除只发生在**人审**那一步', async () => {
  let a;
  let b;
  let c;
  const { service, store } = makeService({
    keeper: { minChars: 5, sampleSize: 1, perGroup: 5 },
    neighbors: () => [a, b, c].filter(Boolean).map((row) => ({ id: row.id })),
  });
  a = store.addMemory({ text: '第一条：接口地址在 config，端口 8377。' });
  b = store.addMemory({ text: '第二条：同样是 8377 那个端口。' });
  c = store.addMemory({ text: '第三条：与第一条完全重复。' });

  // 装监视器：仓管的任何一步都不许碰这四个方法（软删 / 真删 / 清向量 / 放回）。
  const touched = [];
  for (const name of ['softDeleteMemory', 'hardDeleteMemory', 'deleteVector', 'restoreMemory']) {
    const original = store[name].bind(store);
    store[name] = (...args) => {
      touched.push(`${name}(${String(args[0])})`);
      return original(...args);
    };
  }

  const planJson = JSON.stringify([
    { type: 'merge', targets: [a.id, b.id], after: '接口地址在 config，端口 8377（两条并一条）。', reason: '同一件事，两条各自说了一半' },
    { type: 'drop', targets: [c.id], reason: '与第一条一字不差，纯重复' },
  ]);
  // 仓管那一组先失败（非超时 → 不重试）→ 挂待接手 → 宿主模型接手出单。两条路都不许删东西。
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => {
      throw new Error('仓管 LLM 请求失败：HTTP 500 —— boom');
    },
  });
  service.createLlmClient = () => ({ chat: async () => planJson });

  await service.startKeeperRun({ sample: 1, perGroup: 5, maxGroups: 1 });
  const job = await waitKeeper(service);
  assert.equal(job.takenOver, 1, '前提：这一组是被接手模型救回来的');
  assert.equal(job.failed, 0);
  assert.deepEqual(touched, [], 'run / 接手这一路一次删除调用都不能有');
  assert.equal(store.listMemories({ limit: 100 }).items.length, 3, '出单阶段三条都在');

  // 人审通过之后才允许删 —— 这正是「仓管不碰删除、删除只由 reviewKeeperPlan 执行」的落点。
  const plan = service.listKeeperPlans().plans[0];
  assert.deepEqual(plan.ops.map((op) => op.type), ['merge', 'drop']);
  const reviewed = await service.reviewKeeperPlan({ id: plan.id });
  assert.deepEqual(reviewed.applied, { replace: 0, split: 0, merge: 1, drop: 1 });
  assert.equal(reviewed.noReason, 0);
  assert.ok(touched.length > 0, '删除发生在人审这一步（监视器不该是空转的假闸）');
  assert.deepEqual(
    touched.filter((line) => line.startsWith('softDeleteMemory')).sort(),
    [`softDeleteMemory(${b.id})`, `softDeleteMemory(${c.id})`].sort(),
  );
  assert.equal(store.getMemory(c.id), null, 'drop 生效了（人审通过）');
  assert.equal(store.getMemory(b.id), null, 'merge 把被并的那条软删了');
  assert.equal(store.getMemory(a.id).text, '接口地址在 config，端口 8377（两条并一条）。');
});

test('replace 落库后向量被重排：新记忆重新排队，原条旧向量作废清掉', async () => {
  const { service, store } = makeService();
  const row = store.addMemory({ text: '宝宝喜欢冰美式，2026-03 复查。' });
  const cfg = service.resolvedConfig();
  const space = service.embeddingSpace(cfg).key;
  store.putVector({ memoryId: row.id, space, provider: 'ollama', model: 'x', dims: 2, vector: new Float32Array([1, 0]) });
  assert.equal(store.countMissingVectors(space), 0);

  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'replace', targets: [row.id], after: '宝宝喜欢冰美式，2026-03 复查（已确认）。', reason: 'r' }]),
  });
  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);

  // 拦下自动补向量，专心验证「有没有被排进队列」
  const queued = [];
  service.scheduleEmbed = (id) => queued.push(String(id));
  const reviewed = await service.reviewKeeperPlan({ id: store.listKeeperPlans()[0].id });
  assert.equal(reviewed.state, 'approved');
  const newId = reviewed.replaced[0].to;
  assert.deepEqual(queued, [newId], '新记忆必须重新排进嵌入队列');
  assert.equal(store.countVectors(space), 0, '原条被软删，它的旧向量必须清掉（否则检索里会出现幽灵命中）');
  assert.equal(store.countMissingVectors(space), 1, '新记忆缺向量，等补齐');
});

test('revertKeeper：仍能清理**历史遗留**的直改痕迹（产物真删、原文按 history 恢复）', async () => {
  // 新范式不再产生这类痕迹，但老库里有；revertKeeper 保留就是为它们服务的。
  const { service, store } = makeService();
  const original = '一。二。三。'.repeat(20);
  const kept = store.addMemory({ text: original, meta: { keep: 'me' } });
  // 手工造一条「旧研磨」痕迹：改写原文 + meta.keeper + history.note = keeper:grind
  store.updateMemoryText(kept.id, original.slice(0, 35), {
    note: 'keeper:grind',
    meta: { keep: 'me', keeper: { grind: { at: '2026-10-06T00:00:00.000Z', parts: 4, source: 'model' } } },
  });
  const derivedIds = [];
  for (const piece of [original.slice(35, 70), original.slice(70)]) {
    derivedIds.push(store.addMemory({ text: piece, source: '仓管研磨', kind: 'keeper', meta: { derivedFrom: kept.id } }).id);
  }

  const before = store.listKeeperArtifacts();
  assert.equal(before.derived.length, 2);
  assert.equal(before.rewritten.length, 1);

  const result = service.revertKeeper();
  assert.equal(result.ok, true);
  assert.equal(result.removedDerived, 2);
  assert.equal(result.restored, 1);
  assert.deepEqual(result.remaining, { derived: 0, rewritten: 0, merged: 0, replaced: 0 });
  assert.equal(store.countMemories(), 1, '产物真删了，只剩原文');
  assert.equal(store.getMemory(kept.id).text, original, '原文按 history 完整恢复');
  assert.equal(store.getMemory(kept.id).meta.keep, 'me');
  assert.equal(store.getMemory(kept.id).meta.keeper, undefined, '仓管标记清掉');
  assert.equal(store.getMemory(derivedIds[0], { includeDeleted: true }), null);
});

test('revertKeeper：历史遗留的合并痕迹也放得回来（meta.merged → 被软删的条恢复）', () => {
  // 老库里 `dedupePass` 留下的 `meta.merged` 直接改写痕迹——这条分支至今没变。
  // ⚠️ 2026-10-07 本轮起，**新范式的 `merge` 落库也会写同一个 `meta.merged`**（见文末第 10 节），
  // 所以这条分支现在同时吃两代数据；本用例继续钉「手写的老痕迹」那条路径。
  const { service, store } = makeService();
  const keptText = '合并后保留的那条。';
  const kept = store.addMemory({ text: keptText });
  const eaten = store.addMemory({ text: '被并掉的那条（软删，可恢复）。' });
  store.softDeleteMemory(eaten.id, { note: 'keeper:digest' });
  store.updateMemoryText(kept.id, keptText, {
    note: 'keeper:digest',
    meta: { merged: [{ from: eaten.id, at: '2026-10-06T00:00:00.000Z' }] },
  });

  assert.equal(store.listKeeperArtifacts().merged.length, 1);
  const result = service.revertKeeper();
  assert.equal(result.ok, true);
  assert.equal(result.revived, 1, '被并掉的那条要放回来');
  assert.equal(store.getMemory(eaten.id).text, '被并掉的那条（软删，可恢复）。');
  assert.equal(store.getMemory(kept.id).meta.merged, undefined, '合并标记清掉');
  assert.deepEqual(result.remaining, { derived: 0, rewritten: 0, merged: 0, replaced: 0 });
});

test('仓管未配置时不硬来：明确报「未配置模型」并给出该改哪里', async () => {
  const { service } = makeService({ keeper: { model: null } });
  // 撤掉测试桩：这里要验的是**真实的** createKeeperClient（配置缺模型时必须如实报错）
  delete service.createKeeperClient;
  const status = service.keeperStatus();
  assert.equal(status.configured, false);
  assert.match(String(status.hint), /keeper\.model/);
  assert.equal(status.sampleSize, 20, '默认抽 20 个种子');
  assert.equal(status.perGroup, 5, '默认每组召回 5 个邻居');
  assert.equal(status.openPlans, 0);
  // 「现存痕迹」那格、以及它背后每 2 秒一跑的 4 次全表扫，已经从 `keeperStatus()` 里摘掉
  // （面板没人读；要看痕迹直接调 `store.listKeeperArtifacts()`）。
  assert.equal('artifacts' in status, false, 'keeperStatus() 不许再回 artifacts（热路径上没人读的全表扫）');
  // 没人用的两个旋钮也从 status / 工具 schema 摘掉（存量档案里那两行留着不管）。
  assert.equal('digestMinChars' in status, false, '没人用的旋钮不许再回 status');
  assert.equal('dedupeThreshold' in status, false, '没人用的旋钮不许再回 status');

  const started = await service.startKeeperRun({});
  assert.equal(started.ok, false);
  assert.match(String(started.error), /keeper\.model/);

  const test1 = await service.keeperTest();
  assert.equal(test1.ok, false);
  assert.match(String(test1.error), /keeper\.model/);
});

test('run 正在跑时不允许再起一轮（如实回当前进度）', async () => {
  const { service, store } = makeService({ keeper: { sampleSize: 1 } });
  store.addMemory({ text: '随便一条记忆正文。' });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => {
      await gate;
      return '[]';
    },
  });

  const first = await service.startKeeperRun({ sample: 1 });
  assert.equal(first.ok, true);
  const second = await service.startKeeperRun({ sample: 1 });
  assert.equal(second.ok, false);
  assert.match(String(second.error), /仓管正在跑/);
  assert.equal(second.keeper.running, true);
  release();
  await waitKeeper(service);
});

// ── 4. 仓管档案：多档案（线上 / 局域网 / 本机）+ 主动切换 ───────────────────────

/**
 * 造一个「有 tools 服务」的服务，抓住注册进去的 `memory_keeper` 工具定义。
 *
 * 仓管 LLM 默认换成一个可脚本化的假客户端（`service.keeperReplies` 排队消费），
 * 这样工具层的 run / review 用例不必联网、也不必真配模型。
 *
 * @param {object} [keeper] patch 里的 keeper 覆盖
 * @returns {{service: MemoryService, keeperTool: object, calls: object[], store: object}} 服务、工具定义与调用记录
 */
function makeKeeperToolService(keeper = {}) {
  const captured = [];
  const disposers = [];
  const calls = [];
  const tools = {
    register: (definition) => {
      captured.push(definition);
      return () => {};
    },
    get: () => undefined,
    schemas: () => captured,
  };
  const ctx = {
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    on() {
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get: (name) => (name === 'tools' ? tools : undefined),
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  closers.push(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const service = new MemoryService(ctx, {
    dataDir: join(TMP, `data-${Math.random().toString(36).slice(2, 8)}`),
    keeper: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', model: null, ...keeper },
  });
  const store = service.ensureStore();
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async (input) => {
      calls.push(input);
      const replies = service.keeperReplies ?? [];
      return replies.length > 0 ? replies.shift() : '[]';
    },
  });
  // 邻居召回的桩（run 不该在单测里真打嵌入端点）
  service.searchText = async ({ query }) => ({
    ok: true,
    items: store
      .listMemories({ limit: 10 })
      .items.filter((row) => row.text !== query)
      .map((row) => ({ id: row.id, text: row.text })),
  });
  const keeperTool = captured.find((definition) => definition.name === 'memory_keeper');
  assert.ok(keeperTool, '工具目录里应该有 memory_keeper');
  return { service, keeperTool, calls, store };
}

test('仓管档案：首批种子只播一次；内置 config 排第一、只读不可删', () => {
  const { service } = makeService({ keeper: { model: null, ollamaUrl: null } });

  const first = service.listKeeperProfiles();
  assert.equal(first.ok, true);
  assert.deepEqual(first.profiles.map((item) => item.name), ['config', '线上', '局域网-ollama']);
  assert.equal(first.active, 'config', '缺省生效的就是内置 config');
  assert.equal(first.profiles[0].builtin, true);
  assert.equal(first.profiles[0].active, true);
  assert.equal(first.profiles[1].builtin, false);
  assert.equal(first.profiles[1].provider, 'openai');
  assert.equal(first.profiles[1].endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(first.profiles[1].model, 'qwen-plus');
  assert.equal(first.profiles[1].apiKeyRef, 'DASHSCOPE_API_KEY');
  assert.equal(first.profiles[1].configured, true);
  assert.equal(first.profiles[2].provider, 'ollama');
  assert.equal(first.profiles[2].configured, false, '局域网那条留空，如实报「未配置」而不是拿本机默认值乱连');

  // 「首次写入，之后不再覆盖」：改过的种子不会被下一次 list 冲掉
  assert.equal(service.saveKeeperProfile({ name: '线上', model: 'qwen-max' }).ok, true);
  assert.equal(service.listKeeperProfiles().profiles.find((item) => item.name === '线上').model, 'qwen-max');

  // 删光自定义档案后再 list，也不该被塞回来（播种判据是「键不存在」）
  service.deleteKeeperProfile('线上');
  service.deleteKeeperProfile('局域网-ollama');
  assert.deepEqual(service.listKeeperProfiles().profiles.map((item) => item.name), ['config']);

  const bad = service.deleteKeeperProfile('config');
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /不能删/);
  assert.equal(service.listKeeperProfiles().profiles.some((item) => item.name === 'config'), true);
});

test('保存档案：非法 provider 当场报错、不落库；空串/null = 删掉该键', () => {
  const { service } = makeService({ keeper: { model: null, ollamaUrl: null } });
  service.listKeeperProfiles(); // 播种

  const bad = service.saveKeeperProfile({ name: '乱写', provider: 'gemini' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /keeper\.provider/);
  assert.match(String(bad.error), /收到 "gemini"/, '错误里要带实际收到的值，人才知道怎么改');
  assert.equal(
    service.listKeeperProfiles().profiles.some((item) => item.name === '乱写'),
    false,
    '非法配置绝不落库',
  );

  assert.equal(service.saveKeeperProfile({ name: '' }).ok, false, '档案名必填');
  assert.equal(service.saveKeeperProfile({ name: 'config', model: 'x' }).ok, false, 'config 是保留名');

  // 填好局域网那条；再过一次「空串 = 删掉该键」→ 回落 patch（patch 里是 null）
  service.saveKeeperProfile({ name: '局域网-ollama', ollamaUrl: 'http://<局域网 IP>:11434', model: 'qwen3:8b' });
  assert.equal(
    service.listKeeperProfiles().profiles.find((item) => item.name === '局域网-ollama').configured,
    true,
  );
  // upsert 语义：只改一个字段不会把同档案的其它字段抹掉
  service.saveKeeperProfile({ name: '局域网-ollama', minChars: 300 });
  const kept = service.listKeeperProfiles().profiles.find((item) => item.name === '局域网-ollama');
  assert.equal(kept.model, 'qwen3:8b');
  assert.equal(kept.fields.minChars, 300);

  service.saveKeeperProfile({ name: '局域网-ollama', model: '' });
  assert.equal(
    service.listKeeperProfiles().profiles.find((item) => item.name === '局域网-ollama').configured,
    false,
    '空串 = 删掉 model → 回落 patch 的 null',
  );
});

test('切到「线上」立刻生效：resolvedConfig().keeper 变成 openai + DashScope（不用重启）', () => {
  const { service } = makeService({ keeper: { model: null, ollamaUrl: null } });
  service.listKeeperProfiles(); // 播种

  const before = service.resolvedConfig().keeper;
  assert.equal(before.provider, 'ollama');
  assert.equal(before.model, null);

  const activated = service.activateKeeperProfile('线上');
  assert.equal(activated.ok, true);
  assert.equal(activated.active, '线上');
  assert.equal(activated.status.active, '线上');

  const keeper = service.resolvedConfig().keeper;
  assert.equal(keeper.provider, 'openai');
  assert.equal(keeper.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(keeper.model, 'qwen-plus');
  assert.equal(keeper.apiKeyRef, 'DASHSCOPE_API_KEY');
  assert.equal(service.keeperStatus().active, '线上');
  assert.equal(service.keeperStatus().configured, true);

  // 生效档案不是 config 时，上一轮那套 keeper.overrides 不参与合并
  service.activateKeeperProfile('config');
  service.saveKeeperConfig({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', model: '面板改的' });
  assert.equal(service.resolvedConfig().keeper.model, '面板改的', 'config 时 overrides 生效（上一轮的语义没被破坏）');
  service.activateKeeperProfile('线上');
  assert.equal(service.resolvedConfig().keeper.model, 'qwen-plus', '切到别的档案后 overrides 不参与合并');

  const missing = service.activateKeeperProfile('不存在的档案');
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这个档案/);
});

test('切回 config 回落 patch；删掉生效档案也自动回落 config', () => {
  const { service, store } = makeService({ keeper: { model: null, ollamaUrl: null } });
  service.listKeeperProfiles();

  service.activateKeeperProfile('线上');
  assert.equal(service.resolvedConfig().keeper.provider, 'openai');

  const back = service.activateKeeperProfile('config');
  assert.equal(back.ok, true);
  assert.equal(back.active, 'config');
  assert.equal(store.getSetting('keeper.active', null), null, '切回 config = 删掉这个 setting（缺省即 config）');
  assert.equal(service.resolvedConfig().keeper.provider, 'ollama', '回落 patch');
  assert.equal(service.resolvedConfig().keeper.model, null);

  // 删掉生效档案 → 自动回落 config
  service.activateKeeperProfile('线上');
  const removed = service.deleteKeeperProfile('线上');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.wasActive, true);
  assert.equal(store.getSetting('keeper.active', null), null);
  assert.equal(service.listKeeperProfiles().active, 'config');
  assert.equal(service.listKeeperProfiles().profiles.some((item) => item.name === '线上'), false);
  assert.equal(service.resolvedConfig().keeper.provider, 'ollama');

  const missing = service.deleteKeeperProfile('不存在的档案');
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这个档案/);
  assert.equal(service.deleteKeeperProfile('').ok, false);
});

test('keeperTest({name})：只测那个档案，绝不改 active', async () => {
  const { service } = makeService({ keeper: { model: null, ollamaUrl: null } });
  service.listKeeperProfiles();

  const calls = [];
  service.createKeeperClient = async (cfg) => {
    calls.push(cfg);
    return { provider: cfg.keeper.provider, model: cfg.keeper.model, endpoint: 'http://fake', chat: async () => '可用' };
  };

  const result = await service.keeperTest({ name: '线上' });
  assert.equal(result.ok, true);
  assert.equal(result.profile, '线上');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'qwen-plus');
  assert.equal(calls[0].keeper.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(service.keeperStatus().active, 'config', '测试别的档案不该切换 active');

  // 不传 name = 测当前生效的那份
  service.activateKeeperProfile('线上');
  assert.equal((await service.keeperTest()).profile, '线上');
  assert.equal((await service.keeperTest({})).profile, '线上', '空对象参数 = 不传 name');

  const missing = await service.keeperTest({ name: '不存在的档案' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这个档案/);
});

test('memory_keeper 工具：profiles / save / delete / activate / test(name) 都接到服务方法上', async () => {
  const { service, keeperTool } = makeKeeperToolService();

  const listed = await keeperTool.execute({ action: 'profiles' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.profiles.map((item) => item.name), ['config', '线上', '局域网-ollama']);

  const saved = await keeperTool.execute({
    action: 'save',
    name: '局域网-ollama',
    ollamaUrl: 'http://<局域网 IP>:11434',
    model: 'qwen3:8b',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.name, '局域网-ollama');
  assert.deepEqual(
    saved.profile,
    { provider: 'ollama', ollamaUrl: 'http://<局域网 IP>:11434', model: 'qwen3:8b', name: '局域网-ollama' },
    '`action` 之类非档案字段绝不能被写进档案',
  );

  const activated = await keeperTool.execute({ action: 'activate', name: '局域网-ollama' });
  assert.equal(activated.ok, true);
  assert.equal(activated.active, '局域网-ollama');
  assert.equal(service.resolvedConfig().keeper.model, 'qwen3:8b');

  let seen = null;
  service.createKeeperClient = async (cfg) => {
    seen = cfg;
    return { provider: cfg.keeper.provider, model: cfg.keeper.model, endpoint: 'http://fake', chat: async () => '可用' };
  };
  const probed = await keeperTool.execute({ action: 'test', name: '线上' });
  assert.equal(probed.ok, true);
  assert.equal(probed.profile, '线上');
  assert.equal(seen.keeper.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(service.keeperStatus().active, '局域网-ollama', '只测不切换');

  const removed = await keeperTool.execute({ action: 'delete', name: '局域网-ollama' });
  assert.equal(removed.ok, true);
  assert.equal(removed.wasActive, true);
  assert.equal(service.resolvedConfig().keeper.model, null, '删掉生效档案自动回落 patch');

  const bad = await keeperTool.execute({ action: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /action 只能是/);
});

test('线上档案取密钥：Bearer 里必须是信封里的 value（不能是整个信封）', async () => {
  // 这条例外重要：`resolveKey()` 回的是 `{source, value, described}`，塞错就会变成
  // `Bearer [object Object]` —— 线上端点只回 401 invalid_api_key，而**同一把凭据嵌入却是通的**，
  // 极难从现象上想到原因。真机踩过一次（嵌入 test 通过、仓管 test 401），所以钉死它。
  const seen = [];
  const fetchImpl = async (endpoint, init) => {
    seen.push({ endpoint, authorization: init?.headers?.authorization, body: JSON.parse(String(init.body)) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '可用' } }] }),
      text: async () => '',
    };
  };
  const disposers = [];
  const ctx = {
    effect(cb) {
      const dispose = cb();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    on() {
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get(name) {
      if (name === 'credentials') {
        return { resolve: async (ref) => ({ value: String(ref) === 'DASHSCOPE_API_KEY' ? 'SECRET_KEY' : null }) };
      }
      return undefined;
    },
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  closers.push(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const service = new MemoryService(ctx, {
    dataDir: join(TMP, `data-bearer-${Math.random().toString(36).slice(2, 8)}`),
  });
  service.fetchImpl = fetchImpl;

  assert.equal(service.listKeeperProfiles().profiles.some((item) => item.name === '线上'), true, '种子应在');
  const activated = service.activateKeeperProfile('线上');
  assert.equal(activated.ok, true, JSON.stringify(activated));

  const probed = await service.keeperTest();
  assert.equal(probed.ok, true, JSON.stringify(probed));
  assert.equal(probed.profile, '线上');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(seen[0].authorization, 'Bearer SECRET_KEY');
  assert.equal(String(seen[0].authorization).includes('[object Object]'), false);
  assert.equal(seen[0].body.model, 'qwen-plus', '模型名取自档案');
});

test('重启后第一件事就「按名字测档案」：不能因为种子还没播就说「没有这个档案」', async () => {
  // 复现实测：新进程里直接 `test {name:'线上'}`，此时没人调过 listKeeperProfiles()。
  // 修法：那条路径自己先走一次会播种的 listKeeperProfiles()。
  const fresh = makeService(); // 全新库：keeper.profiles 这个键从没写过
  let seen = null;
  fresh.service.createKeeperClient = async (cfg) => {
    seen = cfg;
    return { provider: cfg.keeper.provider, model: cfg.keeper.model, endpoint: 'http://fake', chat: async () => '可用' };
  };

  const result = await fresh.service.keeperTest({ name: '线上' });
  assert.equal(result.ok, true, `不该报「没有这个档案」：${JSON.stringify(result)}`);
  assert.equal(result.profile, '线上');
  assert.equal(seen.keeper.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(fresh.service.keeperStatus().active, 'config', '只测不切换');
});

test('线上档案但凭据库里没有密钥：明确报「取不到密钥」而不是发一个坏请求', async () => {
  const disposers = [];
  const ctx = {
    effect(cb) {
      const dispose = cb();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    on() {
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: null }) };
      return undefined;
    },
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  closers.push(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-nokey-${Math.random().toString(36).slice(2, 8)}`) });
  service.fetchImpl = async () => {
    throw new Error('不该发出请求');
  };
  service.listKeeperProfiles();
  service.activateKeeperProfile('线上');
  const probed = await service.keeperTest();
  assert.equal(probed.ok, false);
  assert.match(String(probed.error), /取不到密钥/);
});

// ── 5. 工具动作：run / plans / plan / review（旧 grind / digest 只是别名） ──────

test('待接手记忆：列表给预览（最多 3 条 / 每条 80 字）· 手工重试接手 · 清掉是软状态', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5 } });
  const long = '很长的记忆正文'.repeat(12);
  const a = store.addMemory({ text: long });
  const b = store.addMemory({ text: '第二条' });
  const c = store.addMemory({ text: '第三条' });
  const d = store.addMemory({ text: '第四条' });
  const row = store.createHandoff({ runId: 'run-9', seedId: a.id, memberIds: [a.id, b.id, c.id, d.id], error: 'Error: 第一次失败' });

  // 列表：正文只有库里那一份，接口给的是**预览**（最多 3 条、每条截 80 字 + 省略号）。
  const listed = service.listHandoffs();
  assert.equal(listed.ok, true);
  assert.equal(listed.open, 1);
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.handoffs[0].id, row.id);
  assert.equal(listed.handoffs[0].runId, 'run-9');
  assert.equal(listed.handoffs[0].count, 4, 'count 是成员总数（预览只给 3 条）');
  assert.equal(listed.handoffs[0].members.length, 3);
  assert.equal(listed.handoffs[0].members[0].id, a.id);
  assert.equal(listed.handoffs[0].members[0].text.length, 81, '80 字 + 省略号');
  assert.equal(listed.handoffs[0].members[0].text.endsWith('…'), true);
  assert.equal(listed.handoffs[0].attempts, 1);

  // 手工重试接手：宿主模型成功 → 出单、那一行变 taken（同一轮的单仍归原来的 runId）
  service.createLlmClient = () => ({
    chat: async () => JSON.stringify([{ type: 'merge', targets: [a.id, b.id], after: '合并后的正文' }]),
  });
  const taken = await service.takeOverHandoff({ id: row.id });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.handoff.state, 'taken');
  assert.equal(taken.handoff.taker, '宿主模型', '没配 llm.model 时标签就是「宿主模型」，不带斜杠');
  assert.equal(taken.ops, 1);
  const plan = store.getKeeperPlan(taken.planId);
  assert.equal(plan.runId, 'run-9', '接手出的单仍归原来那一轮');
  assert.deepEqual(plan.memberIds, [a.id, b.id, c.id, d.id], '整组成员都进单');
  assert.equal(service.listHandoffs().open, 0);

  // 已经处理过的行不能再接（否则同一组会被反复出单）
  const again = await service.takeOverHandoff({ id: row.id });
  assert.equal(again.ok, false);
  assert.match(String(again.error), /已经处理过/);

  // 接手失败：留在 open，attempts +1，error 换成这一次的原因（面板照它显示「为什么还在这儿」）
  const row2 = store.createHandoff({ seedId: b.id, memberIds: [b.id], error: 'Error: 第一次失败' });
  service.createLlmClient = () => ({
    chat: async () => {
      throw new Error('boom');
    },
  });
  const failed = await service.takeOverHandoff({ id: row2.id });
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /boom/);
  const after = store.getHandoff(row2.id);
  assert.equal(after.state, 'open');
  assert.equal(after.attempts, 2);
  assert.match(String(after.error), /boom/);

  // 涉及的记忆全删了 → 自动清掉（否则它永远卡在队列里，谁也接不了）
  const row3 = store.createHandoff({ seedId: c.id, memberIds: [c.id], error: 'x' });
  store.softDeleteMemory(c.id, { note: '测试：先删掉' });
  const gone = await service.takeOverHandoff({ id: row3.id });
  assert.equal(gone.ok, true);
  assert.equal(gone.handoff.state, 'dropped');
  assert.match(String(gone.handoff.error), /都已删除/);

  // 清掉：软状态，行还在（痕迹不可抹）
  const row4 = store.createHandoff({ seedId: d.id, memberIds: [d.id], error: 'x' });
  const dropped = service.dropHandoff({ id: row4.id });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.handoff.state, 'dropped');
  assert.notEqual(store.getHandoff(row4.id), null, '清掉只是软状态，行还在');

  // 参数校验：缺 id / 没有这一项都如实报错
  assert.equal(service.dropHandoff({ id: '' }).ok, false);
  assert.equal(service.dropHandoff({ id: 'nope' }).ok, false);
  assert.equal((await service.takeOverHandoff({ id: 'nope' })).ok, false);
  assert.equal((await service.takeOverHandoff({ id: '' })).ok, false);
});

test('副审阅区重做是「重头」：拿存下来的成员当**种子**，用 embedding 再召回一次相关记忆', async () => {
  let a;
  let b;
  let c;
  const { service, store } = makeService({
    keeper: { minChars: 5, perGroup: 5 },
    // 召回桩：查询任何种子都回 [b, c]（b/c 是"相关记忆"）。
    neighbors: () => [b, c].filter(Boolean).map((row) => ({ id: row.id })),
  });
  a = store.addMemory({ text: '主记忆：接口地址写在 config 里。' });
  b = store.addMemory({ text: '相关记忆之一：端口 8377。' });
  c = store.addMemory({ text: '相关记忆之二：同一台机器。' });

  const row = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: 'Error: 出错过' });
  service.createLlmClient = () => ({
    chat: async () => JSON.stringify([{ type: 'merge', targets: [a.id, b.id], after: '合并后的正文。', reason: '同一件事' }]),
  });

  const taken = await service.takeOverHandoff({ id: row.id });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.recalled, 2, 'embedding 召回了 2 条相关记忆');
  // 新单的成员 = 种子 ∪ 召回的邻居（顺序：种子在前）。
  const plan = store.getKeeperPlan(taken.planId);
  assert.deepEqual(plan.memberIds, [a.id, b.id, c.id]);
  assert.equal(plan.seedId, a.id);
  // 那一行的成员也换成"这次真正整理的那一组"——面板「N 条记忆」说的才是事实。
  assert.deepEqual(store.getHandoff(row.id).memberIds, [a.id, b.id, c.id]);
});

test('转手：一张待审变更单只**入队** —— 原单停在 handed，副审阅区多一行，**不打模型、不出新单**', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, perGroup: 5 } });
  const a = store.addMemory({ text: '要被转手的记忆：甲方案地址在 config。' });

  const plan = store.createKeeperPlan({
    runId: 'run-77',
    seedId: a.id,
    memberIds: [a.id],
    ops: [
      {
        idx: 0,
        type: 'replace',
        targets: [a.id],
        before: [{ id: a.id, text: '要被转手的记忆：甲方案地址在 config。' }],
        after: '原来那个不太好的改法。',
        reason: '初版',
        warnings: [],
      },
    ],
  });
  // 谁在这时候调模型，这条测试就会炸 —— 用户 2026-10-07：「由我启动时决定」，转手不该自动开跑。
  let modelCalls = 0;
  service.createLlmClient = () => ({
    chat: async () => {
      modelCalls += 1;
      return '[]';
    },
  });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => {
      modelCalls += 1;
      return '[]';
    },
  });

  const result = await service.handOffPlan({ id: plan.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.queued, true);
  assert.equal(result.seeds, 1, '转手的是这条改动要动的记忆');
  assert.equal(result.planId, undefined, '转手不出单');
  assert.equal(modelCalls, 0, '转手这一步一次模型调用都不能有');

  // ① 原单停在终态 handed：**不是** approved（没按那方案落库），也**不是** rejected（人没否掉）。
  const handed = store.getKeeperPlan(plan.id);
  assert.equal(handed.state, 'handed');
  assert.equal(handed.review.handedOff, true);
  assert.equal(handed.review.handoffId, result.handoff.id);
  assert.equal(handed.ops[0].after, '原来那个不太好的改法。', '原单一个字段都没被改（只是换了状态）');

  // ② 副审阅区那一行：成员 = 原单的 targets，**还是 open**（等人选模型开跑）。
  const row = store.getHandoff(result.handoff.id);
  assert.equal(row.state, 'open');
  assert.deepEqual(row.memberIds, [a.id]);
  assert.equal(row.taker, null, '还没接手过');
  assert.match(String(row.error), /等你选模型接手/, '这一行为什么在这儿：写清楚是转手过来的');
  assert.equal(store.countOpenHandoffs(), 1);

  // ③ 没有新单：待审区里一张单都没有了（原来那张已经 handed，不算 open）。
  assert.deepEqual(store.listKeeperPlans({ state: 'open' }), []);
  // 记忆正文一个字都没动。
  assert.equal(store.getMemory(a.id).text, '要被转手的记忆：甲方案地址在 config。');

  // 参数校验：已转手的单不能再转一次；不存在 / 缺 id / 没有 targets 都如实报错。
  const again = await service.handOffPlan({ id: plan.id });
  assert.equal(again.ok, false);
  assert.match(String(again.error), /已经是 handed/);
  assert.equal((await service.handOffPlan({ id: 'nope' })).ok, false);
  assert.equal((await service.handOffPlan({ id: '' })).ok, false);
  const emptyPlan = store.createKeeperPlan({ seedId: a.id, memberIds: [], ops: [] });
  const empty = await service.handOffPlan({ id: emptyPlan.id });
  assert.equal(empty.ok, false);
  assert.match(String(empty.error), /没有可转手的记忆/);
});

test('接手：**模型由调用方指定**（档案名 / host / 省略 = 副仓管角色，角色没设就是自动）；档案没配好就如实报错、不偷偷换人', async () => {
  let a;
  let b;
  const { service, store } = makeService({
    keeper: { minChars: 5, perGroup: 5 },
    neighbors: () => [b].filter(Boolean).map((row) => ({ id: row.id })),
  });
  a = store.addMemory({ text: '要被接手的记忆：甲方案地址在 config。' });
  b = store.addMemory({ text: '相关记忆：端口 8377。' });

  // 两个档案：一个配好的「线上」（公网），一个没配好的「局域网-ollama」。
  const used = [];
  service.listKeeperProfiles(); // 播种（线上 / 局域网-ollama）
  service.createKeeperClient = async (cfg) => {
    used.push(`${cfg?.keeper?.provider}|${cfg?.keeper?.model}`);
    return {
      provider: cfg?.keeper?.provider,
      model: cfg?.keeper?.model ?? '(空)',
      endpoint: 'http://fake',
      chat: async () => JSON.stringify([{ type: 'merge', targets: [a.id, b.id], after: '被指定模型整理出来的正文。', reason: '同一件事' }]),
    };
  };
  service.createLlmClient = () => ({
    chat: async () => JSON.stringify([{ type: 'merge', targets: [a.id, b.id], after: '宿主模型整理的正文。', reason: '同一件事' }]),
  });

  // ① 显式指定档案「线上」→ 用的就是它（不接受自动挑）。
  const row1 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '出错过' });
  const byProfile = await service.takeOverHandoff({ id: row1.id, model: '线上' });
  assert.equal(byProfile.ok, true, JSON.stringify(byProfile));
  assert.equal(byProfile.taker, '线上 / qwen-plus');
  assert.deepEqual(used, ['openai|qwen-plus'], '建的正是「线上」那个档案的客户端');
  assert.equal(store.getKeeperPlan(byProfile.planId).ops[0].after, '被指定模型整理出来的正文。');

  // ② 显式指定宿主模型。
  const row2 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '又出错过' });
  const byHost = await service.takeOverHandoff({ id: row2.id, model: 'host' });
  assert.equal(byHost.ok, true, JSON.stringify(byHost));
  assert.equal(byHost.taker, '宿主模型');
  assert.equal(store.getKeeperPlan(byHost.planId).ops[0].after, '宿主模型整理的正文。');

  // ③ 指定一个**没配好**的档案：如实报错，**不**偷偷换成宿主模型（那正是用户要避免的）。
  const row3 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '第三次' });
  const notReady = await service.takeOverHandoff({ id: row3.id, model: '局域网-ollama' });
  assert.equal(notReady.ok, false);
  assert.match(String(notReady.error), /还没配齐/);
  assert.equal(store.getHandoff(row3.id).state, 'open', '失败留在队列里，等人换一个模型');
  assert.equal(store.getKeeperPlan(notReady.planId ?? 'x'), null, '一张单都没出');

  // ④ 不存在的档案名 / 省略（= auto：本地优先 → 宿主）。
  const missing = await service.takeOverHandoff({ id: row3.id, model: '没有这个档案' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这个仓管档案/);
  const auto = await service.takeOverHandoff({ id: row3.id });
  assert.equal(auto.ok, true, JSON.stringify(auto));
  assert.equal(auto.taker, '宿主模型', 'auto 在没配本地档案时落到宿主模型（并如实写出来）');
});

test('副仓管角色：`setSideKeeper()` 只写一行 setting，takeover / run 省略 model（taker）时就走它', async () => {
  let a;
  let b;
  const { service, store } = makeService({
    keeper: { minChars: 5, perGroup: 5, sampleSize: 1 },
    neighbors: () => [b].filter(Boolean).map((row) => ({ id: row.id })),
  });
  a = store.addMemory({ text: '副仓管这个角色要接手的记忆：地址在 config。' });
  b = store.addMemory({ text: '相关记忆：端口 8377。' });
  service.listKeeperProfiles(); // 播种（线上 / 局域网-ollama）

  const used = [];
  service.createKeeperClient = async (cfg) => {
    used.push(`${cfg?.keeper?.provider}|${cfg?.keeper?.model}`);
    return {
      provider: cfg?.keeper?.provider,
      model: cfg?.keeper?.model ?? '(空)',
      endpoint: 'http://fake',
      chat: async () =>
        JSON.stringify([
          {
            type: 'merge',
            targets: [a.id, b.id],
            after: `副仓管角色（${cfg?.keeper?.model ?? '(空)'}）整理的正文。`,
            reason: '同一件事',
          },
        ]),
    };
  };
  service.createLlmClient = () => ({
    chat: async () =>
      JSON.stringify([{ type: 'merge', targets: [a.id, b.id], after: '宿主模型整理的正文。', reason: '同一件事' }]),
  });

  // ① 默认：这个键没写过 → `side` 是 null（= 自动），status 里也如实是 null。
  assert.equal(service.keeperStatus().side, null);
  assert.equal(service.sideKeeperChoice(), null);

  // ② 名字不存在 → **当场**报错、不写库（不是等人点了「接手」才报）。
  const missing = service.setSideKeeper('没有这个档案');
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这个档案/);
  assert.equal(store.getSetting('keeper.side', null), null);

  // ③ 设成档案「线上」：只写一行 setting —— 主仓管的 `keeper.active` 一个字不动。
  const activeBefore = store.getSetting('keeper.active', null);
  const set = service.setSideKeeper('线上');
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.side, '线上');
  assert.equal(store.getSetting('keeper.side', null), '线上');
  assert.equal(store.getSetting('keeper.active', null), activeBefore, '副仓管与主仓管各存各的');

  // ④ takeover 省略 model → 用的就是副仓管选的那个档案（不是自动挑的）。
  const row1 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '出错过' });
  const taken = await service.takeOverHandoff({ id: row1.id });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.taker, '线上 / qwen-plus');
  assert.deepEqual(used, ['openai|qwen-plus']);
  assert.equal(store.getKeeperPlan(taken.planId).ops[0].after, '副仓管角色（qwen-plus）整理的正文。');

  // ⑤ run 省略 taker → 本轮"某组失败时自动接手"用的也是副仓管那个角色。
  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(service.publicKeeper().taker, { kind: 'profile', name: '线上' }, 'run 带着副仓管角色');
  await waitKeeper(service);

  // ⑥ 改成宿主模型 → 省略 model 的 takeover 立刻跟着换。
  assert.equal(service.setSideKeeper('host').side, 'host');
  const row2 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '又出错过' });
  const byHost = await service.takeOverHandoff({ id: row2.id });
  assert.equal(byHost.taker, '宿主模型');
  assert.equal(store.getKeeperPlan(byHost.planId).ops[0].after, '宿主模型整理的正文。');

  // ⑦ 'auto' / 空 → 删掉这个键（不是写个 'auto' 进去），回到自动顺序。
  const cleared = service.setSideKeeper('auto');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.side, null);
  assert.equal(store.getSetting('keeper.side', null), null);
  assert.equal(service.keeperStatus().side, null);
  const row3 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '第三次' });
  const auto = await service.takeOverHandoff({ id: row3.id });
  assert.equal(auto.taker, '宿主模型', '自动顺序：库里没有本地档案 → 宿主模型');
});

test('主副仓管独立：副仓管在接手时，主仓管照样能起一轮，两边的状态谁也不覆盖谁', async () => {
  // 用户 2026-10-08：「主副仓管独立，各自的运行不能互相产生干扰」。
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const a = store.addMemory({ text: `一条要接手的记忆：${'甲'.repeat(40)}` });
  const handoff = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '出错过' });

  let release = null;
  let hangs = true;
  service.createKeeperClient = async () => ({
    provider: 'p',
    model: 'm',
    endpoint: 'http://fake',
    // 第一次（= 副仓管那次接手）挂着不回来，后面的（主仓管那一轮）立刻返回空方案。
    chat: () => {
      if (hangs) {
        hangs = false;
        return new Promise((resolve) => {
          release = () => resolve('[]');
        });
      }
      return Promise.resolve('[]');
    },
  });

  const pending = service.takeOverHandoff({ id: handoff.id, model: '线上' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const during = service.keeperStatus();
  assert.equal(during.sideJob.running, true, '副仓管自己那条线在跑（`sideJob`）');
  assert.equal(during.job.running, false, '主仓管那一轮的状态**不受影响**');
  assert.equal(during.sideJob.handoffId, handoff.id);

  // ① 主仓管不被副仓管挡住（各自一条线）
  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  assert.equal(started.ok, true, `主仓管不该被副仓管挡住：${JSON.stringify(started)}`);

  // ② 副仓管跑到一半再点一次接手 → 被**自己**那条线挡住（不是被主仓管挡）
  const second = await service.takeOverHandoff({ id: handoff.id, model: '线上' });
  assert.equal(second.ok, false);
  assert.match(String(second.error), /副仓管正在接手另一组/);

  release();
  const done = await pending;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(service.keeperStatus().sideJob.running, false, '做完就熄灯');
  await waitKeeper(service);
});

test('同一组不被接两次：两条运行线并发接手同一组，只有一个拿得到（原子认领）', async () => {
  // 主仓管某组失败后是「挂队列 + 当场接手」，那一窗口里面板也看得到那一行 ——
  // 不做原子认领就会出两张单（用户 2026-10-08 的口径要求两条线互不干扰）。
  const dataDir = join(TMP, `data-independent-${Math.random().toString(36).slice(2, 8)}`);
  const first = makeService({ keeper: { minChars: 5 }, dataDir, ensure: false });
  const second = makeService({ keeper: { minChars: 5 }, dataDir, ensure: false });
  const store = first.service.ensureStore();
  second.service.ensureStore();
  const a = store.addMemory({ text: `同一条要被两条线接手的记忆${'乙'.repeat(30)}` });
  const handoff = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: '出错过' });

  let release = null;
  first.service.createKeeperClient = async () => ({
    provider: 'p',
    model: 'm',
    endpoint: 'http://fake',
    chat: () => new Promise((resolve) => { release = () => resolve('[]'); }),
  });

  const pending = first.service.takeOverHandoff({ id: handoff.id, model: '线上' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const blocked = await second.service.takeOverHandoff({ id: handoff.id, model: '线上' });
  assert.equal(blocked.ok, false, '第二个必须被挡住（那一组已经在别人手上）');
  assert.match(String(blocked.error), /已经处理过了|刚被另一个接手拿走/);
  assert.equal(store.listHandoffs().length, 1, '不该多出一行');
  assert.equal(store.listHandoffs({ state: 'open' }).length, 0, '认领期间它不在"待接手"里（面板点不到）');

  release();
  assert.equal((await pending).ok, true);
  assert.equal(store.getHandoff(handoff.id).state, 'taken');
});

test('meta.model 署名认**这张单自己**的模型（副仓管出的单不会被盖成主仓管的模型名）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5 } });
  const before = '要被改写的记忆正文。';
  const row = store.addMemory({ text: before });
  const plan = store.createKeeperPlan({
    seedId: row.id,
    memberIds: [row.id],
    model: 'taker-9', // ← 单子由「副仓管 / taker-9」产出
    ops: [
      { idx: 0, type: 'replace', targets: [row.id], before: [{ id: row.id, text: before }], after: '改写后的正文。', reason: '测试', warnings: [] },
    ],
  });
  // 串台条件：主仓管那一轮（job）上挂着**另一个**模型名
  service.keeper = { running: false, mode: 'run', model: '主仓管的模型', done: 1, total: 1, tail: [] };

  const reviewed = await service.reviewKeeperPlan({ id: plan.id });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const newId = reviewed.replaced[0].to;
  assert.equal(store.getMemory(newId).meta.model, 'taker-9', '必须署产出这张单的模型');
  assert.equal(String(store.getMemory(newId).meta.model).includes('主仓管'), false, '不能是主仓管那一轮的模型');

  // 老单（`model` 为 null = 不知道谁产的）→ 署 null，**不借用**主仓管的模型名
  const legacy = store.createKeeperPlan({
    seedId: row.id,
    memberIds: [newId],
    ops: [{ idx: 0, type: 'replace', targets: [newId], before: [{ id: newId, text: '改写后的正文。' }], after: '再改一次。', reason: '测试', warnings: [] }],
  });
  assert.equal(store.getKeeperPlan(legacy.id).model, null);
  const again = await service.reviewKeeperPlan({ id: legacy.id });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(store.getMemory(again.replaced[0].to).meta.model, null, '老单署 null');
});

test('resolveTakeoverClient：失败原因**随调用返回**，不挂实例字段（两条线并发接手不会读串）', async () => {
  const { service } = makeService({});
  assert.equal('lastTakeoverError' in service, false, '这个实例字段必须已经删掉');
  const a = await service.resolveTakeoverClient(null, { kind: 'profile', name: '没有档案甲' });
  assert.equal(a.client, null);
  assert.match(String(a.error), /没有这个仓管档案：没有档案甲/);
  const b = await service.resolveTakeoverClient(null, { kind: 'profile', name: '没有档案乙' });
  assert.match(String(b.error), /没有档案乙/);
  assert.equal(String(b.error).includes('没有档案甲'), false, '拿到的必须是**这一次**的失败原因');
  assert.equal(String(a.error).includes('没有档案乙'), false, '上一次的返回对象也不受影响');
});

test('一组彻底不回来：整组墙钟到点就挂副审阅区，不重试、不拖住这一轮', async () => {
  // 真机背景（2026-10-08）：`timeoutMs` 只管**单次请求**，一组最坏打两次（超时重试）+ 接手再打一次。
  // 这里把档案超时设成 60 秒（测试不会真等），只靠整组墙钟 150ms 收网。
  const { service, store } = makeService({
    keeper: { minChars: 5, sampleSize: 1, perGroup: 1, timeoutMs: 60000, groupTimeoutMs: 150 },
  });
  store.addMemory({ text: `一组会卡死的记忆：${'甲'.repeat(200)}` });
  const seen = [];
  service.createKeeperClient = async () => ({
    provider: 'p',
    model: 'm',
    endpoint: 'http://fake',
    // 假客户端**按调用时给的预算超时**：既能模拟"卡死"，也顺带验证预算真的传下来了。
    chat: (_request, options = {}) => {
      const budget = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
      seen.push(budget);
      return new Promise((_resolve, reject) => {
        const err = new Error('stub timeout');
        err.name = 'TimeoutError';
        setTimeout(() => reject(err), budget);
      });
    },
  });

  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  const job = await waitKeeper(service, 5000);

  assert.equal(seen.length >= 1, true);
  assert.ok(seen[0] <= 150, `第一次调用必须被整组预算收紧（收到 ${seen[0]}）`);
  assert.equal(job.retried, 0, '超时后预算已用完 → 不该再打重试那一次');
  assert.ok(
    job.tail.some((line) => line.includes('整组超过') || line.includes('无整组预算')),
    `tail 必须说清是整组超时：${JSON.stringify(job.tail)}`,
  );
  assert.equal(service.keeperStatus().openHandoffs >= 1, true, '这一组必须留在副审阅区等人接手');
  if (seen.length > 1) assert.ok(seen[1] <= 5, `接手那一次也不该再等一个档案超时（收到 ${seen[1]}）`);
});

test('整组墙钟：到点后**不自动接手**（接手那次请求不会在预算外继续跑）+ 留在队列里看得见', async () => {
  // 真机（2026-10-08）：整组墙钟声明 480s，实际一组跑到 **602s** —— 组内两次超时（480s）之后，
  // "接手那一次"是在预算耗尽后才开跑的，仅靠 `timeoutMs` 收不住（真机 tail 里它跑了 1 条操作）。
  // 修法：到点就**我们自己说了算**，不自动接手、留在副审阅区等人。这条钉死那个行为。
  const { service, store } = makeService({
    keeper: { minChars: 5, sampleSize: 1, perGroup: 1, timeoutMs: 200, groupTimeoutMs: 400 },
  });
  store.addMemory({ text: `一组会超时的记忆：${'甲'.repeat(200)}` });
  const seen = [];
  service.createKeeperClient = async () => ({
    provider: 'p',
    model: 'm',
    endpoint: 'http://fake',
    chat: (_request, options = {}) => {
      seen.push(Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 999999);
      return new Promise((_resolve, reject) => {
        const err = new Error('stub timeout');
        err.name = 'TimeoutError';
        setTimeout(() => reject(err), 400);
      });
    },
  });

  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1, taker: '线上' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const job = await waitKeeper(service, 8000);

  assert.equal(job.handedOff, 1);
  assert.equal(job.takenOver, 0, `到点后不该自动接手：${JSON.stringify(job.tail)}`);
  assert.equal(seen.length, 1, `只该打组内那一次，实际 ${seen.length} 次`);
  assert.ok(
    job.tail.some((line) => line.includes('不自动接手')),
    `tail 要说清"没自动接手"：${JSON.stringify(job.tail)}`,
  );
  // 认领必须被放回 `open`：否则面板（只列 open）10 分钟看不见这一组 = 悄悄丢了。
  assert.equal(service.keeperStatus().openHandoffs, 1, '要留在待接手列表里');
  assert.equal(store.listHandoffs({ state: 'open' }).length, 1);
});

test('整组墙钟：**没到点**的失败照旧当场接手，且接手那次预算不超剩余整组预算', async () => {
  // 反向：报错不是超时（HTTP 500）→ 组内只打一次、还在预算内 → 自动接手照跑，
  // 但那一次的预算必须是**剩余**（≤ 整组 400ms），不能又放宽回档案超时。
  const { service, store } = makeService({
    keeper: { minChars: 5, sampleSize: 1, perGroup: 1, timeoutMs: 200, groupTimeoutMs: 400 },
  });
  store.addMemory({ text: `一组会报错的记忆：${'乙'.repeat(200)}` });
  const seen = [];
  service.createKeeperClient = async () => ({
    provider: 'p',
    model: 'm',
    endpoint: 'http://fake',
    chat: (_request, options = {}) => {
      seen.push(Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 999999);
      if (seen.length === 1) return Promise.reject(new Error('HTTP 500'));
      return Promise.resolve('[]');
    },
  });

  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1, taker: '线上' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const job = await waitKeeper(service, 8000);

  assert.equal(job.handedOff, 1);
  assert.ok(
    job.tail.some((line) => line.includes('接手 → 0 条操作')),
    `没到点的失败该当场接手：${JSON.stringify(job.tail)}`,
  );
  assert.equal(seen.length, 2, '组内一次 + 接手一次');
  assert.ok(seen[1] <= 400 && seen[1] > 0, `接手那次必须受剩余预算约束（收到 ${seen[1]}）`);
});

test('run：启动时选的接手模型，会在某组失败时真正生效（不是系统自己挑的）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  store.addMemory({ text: '这一组会失败，按启动时选的模型接手。' });
  service.listKeeperProfiles();
  // 仓管那一组直接失败（非超时 → 不重试 → 挂副审阅区 → 当场接手）。
  service.createKeeperClient = async (cfg) => {
    // auto 时才会走这里挑本地档案；显式指定「线上」时也走这里 —— 用 chat 的行为区分不了，
    // 所以这一条只断言"接手用了我指定的那个档案"，靠 `used` 记录。
    if (String(cfg?.keeper?.model ?? '') === 'qwen-plus') {
      return {
        provider: 'openai',
        model: 'qwen-plus',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        chat: async () => JSON.stringify([{ type: 'drop', targets: [store.listMemories({ limit: 1 }).items[0].id], reason: '被指定模型判定重复' }]),
      };
    }
    return {
      provider: 'ollama',
      model: 'fake-keeper',
      endpoint: 'http://fake',
      chat: async () => {
        throw new Error('仓管 LLM 请求失败：HTTP 500 —— boom');
      },
    };
  };

  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1, taker: '线上' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(service.publicKeeper().taker, { kind: 'profile', name: '线上' }, 'run 上带着启动时选的接手模型');
  const job = await waitKeeper(service);

  assert.equal(job.failed, 0, '接手成功 → 这一组不算失败');
  assert.equal(job.takenOver, 1);
  assert.equal(
    job.tail[job.tail.length - 1],
    '组 1：线上 / qwen-plus 接手 → 1 条操作',
    JSON.stringify(job.tail),
  );
  // 参数校验：非法 taker 直接拦下（别让它跑一半才发现）。
  const bad = await service.startKeeperRun({ sample: 1, taker: 'x'.repeat(80) });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /接手模型只能填/);
});

test('memory_keeper 工具：handoffs / takeover / drop-handoff 三个动作接到服务方法上', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const a = store.addMemory({ text: '工具层接手这一组记忆。' });
  const row = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: 'Error: 出过错' });

  const listed = await keeperTool.execute({ action: 'handoffs' });
  assert.equal(listed.ok, true);
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.handoffs[0].members[0].text, '工具层接手这一组记忆。');

  service.createLlmClient = () => ({
    chat: async () => JSON.stringify([{ type: 'drop', targets: [a.id] }]),
  });
  const taken = await keeperTool.execute({ action: 'takeover', id: row.id });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.handoff.state, 'taken');
  assert.equal(taken.ops, 1);

  const row2 = store.createHandoff({ seedId: a.id, memberIds: [a.id], error: 'Error: 又出过错' });
  const dropped = await keeperTool.execute({ action: 'drop-handoff', id: row2.id });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.handoff.state, 'dropped');
  assert.equal((await keeperTool.execute({ action: 'handoffs' })).handoffs.length, 0, '默认只看 open');

  // 转手：把一张待审单交给副审阅区（**只入队**，工具层与面板走同一个 service 方法）。
  const plan = store.createKeeperPlan({
    seedId: a.id,
    memberIds: [a.id],
    ops: [{ idx: 0, type: 'drop', targets: [a.id], before: [{ id: a.id, text: 'x' }], after: '', reason: '重复', warnings: [] }],
  });
  const handed = await keeperTool.execute({ action: 'handoff', id: plan.id, reason: '不太满意这版' });
  assert.equal(handed.ok, true, JSON.stringify(handed));
  assert.equal(handed.queued, true, '转手只入队');
  assert.equal(store.getKeeperPlan(plan.id).state, 'handed');
  assert.equal(store.getHandoff(handed.handoff.id).state, 'open', '那一行等人选模型开跑');
  // 接着由调用方**指定模型**接手（工具层同样能指定）。
  const started = await keeperTool.execute({ action: 'takeover', id: handed.handoff.id, model: 'host' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.taker, '宿主模型');
  assert.equal(store.getKeeperPlan(started.planId).state, 'open', '新单回到待审区');

  // 工具 schema 里也必须列得出这些动作（否则 agent 根本不知道有这条路）
  const actionDoc = String(keeperTool.parameters.properties?.action?.description ?? '');
  assert.match(actionDoc, /handoffs/);
  assert.match(actionDoc, /takeover/);
  assert.match(actionDoc, /drop-handoff/);
  assert.match(actionDoc, /handoff\b/);
});

test('memory_keeper 工具：run / grind / digest 都只出单，记忆库一个字都不改', async () => {
  const { service, keeperTool, calls, store } = makeKeeperToolService({ minChars: 5 });
  const row = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。' });
  // 三个 action 各一轮，各消费一条回复
  service.keeperReplies = [
    JSON.stringify([{ type: 'rewrite', targets: [row.id], after: '宝宝爱喝冰美式。', reason: '更干练' }]),
    JSON.stringify([{ type: 'rewrite', targets: [row.id], after: '宝宝爱喝冰美式（早）。', reason: '更干练' }]),
    JSON.stringify([{ type: 'rewrite', targets: [row.id], after: '宝宝爱喝冰美式（早上）。', reason: '更干练' }]),
  ];
  const before = memorySnapshot(store);

  for (const action of ['run', 'grind', 'digest']) {
    const started = await keeperTool.execute({ action, sample: 1, perGroup: 2, maxGroups: 1 });
    assert.equal(started.ok, true, `${action} 应当启动成功：${JSON.stringify(started)}`);
    assert.equal(started.started, true);
    assert.equal(typeof started.runId, 'string');
    await waitKeeper(service);
  }

  assert.deepEqual(memorySnapshot(store), before, 'run / grind / digest 都不许写记忆库');
  const plans = store.listKeeperPlans();
  assert.equal(plans.length, 3, '三轮各出一张单');
  assert.deepEqual(plans.map((plan) => plan.state), ['open', 'open', 'open'], '没审阅的单永远是 open');
  assert.equal(store.getMemory(row.id).text, '宝宝喜欢冰美式，早上必喝一杯。');

  // 工具的 schema 里不该再留旧的直改库旋钮
  const properties = keeperTool.parameters.properties ?? {};
  assert.equal('limit' in properties, false, 'limit 是旧「直接改库」的旋钮，已删');
  assert.equal('redo' in properties, false, 'redo 是旧「直接改库」的旋钮，已删');
  for (const key of ['sample', 'perGroup', 'maxGroups', 'id', 'keep', 'state', 'reject', 'text', 'reason']) {
    assert.equal(key in properties, true, `工具 schema 缺 ${key}`);
  }
  assert.match(keeperTool.description, /只出「变更单」，不改库/);
  // `digest` 不是旧「直接改库」的别名，而是**提示词偏重去重合并**（run / grind 都是全部手段）。
  assert.match(keeperTool.description, /action=digest 同样\*\*只出单、不改库\*\*/);
  assert.match(keeperTool.description, /偏重去重合并/);
  assert.match(keeperTool.description, /不是另一种任务/);
  // 工具层把 action 接成 mode：digest 那轮的提示词必须真的带侧重段，另两轮不带。
  const systemOf = (index) => String(calls[index]?.messages?.[0]?.content ?? '');
  assert.equal(calls.length, 3, '三个 action 各一次 LLM 调用');
  assert.equal(/偏重去重合并/.test(systemOf(0)), false, 'run = 全部手段');
  assert.equal(/偏重去重合并/.test(systemOf(1)), false, 'grind = 全部手段');
  assert.match(systemOf(2), /偏重去重合并/, 'digest = 偏重去重合并');
  assert.notEqual(systemOf(1), systemOf(2), 'grind 与 digest 的提示词必须不同');
});

test('memory_keeper 工具：plans / plan / review 走通；reject 只标记不写库', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const row = store.addMemory({ text: '宝宝喜欢冰美式，2026-03 复查。' });
  service.keeperReplies = [
    JSON.stringify([{ type: 'rewrite', targets: [row.id], after: '宝宝喜欢冰美式（已确认）。', reason: 'r' }]),
  ];

  await keeperTool.execute({ action: 'run', sample: 1 });
  await waitKeeper(service);

  const listed = await keeperTool.execute({ action: 'plans' });
  assert.equal(listed.ok, true);
  assert.equal(listed.plans.length, 1);
  assert.equal(listed.plans[0].state, 'open');
  assert.equal(Array.isArray(listed.plans[0].warnings), true, '单级 warnings 要拍平给调用方');

  const openOnly = await keeperTool.execute({ action: 'plans', state: 'approved' });
  assert.equal(openOnly.plans.length, 0);
  const openFiltered = await keeperTool.execute({ action: 'plans', state: 'open' });
  assert.equal(openFiltered.plans.length, 1);

  const one = await keeperTool.execute({ action: 'plan', id: listed.plans[0].id });
  assert.equal(one.ok, true);
  assert.equal(one.plan.id, listed.plans[0].id);
  const nope = await keeperTool.execute({ action: 'plan', id: '没有这张单' });
  assert.equal(nope.ok, false);
  assert.match(String(nope.error), /没有这张变更单/);

  const reviewed = await keeperTool.execute({ action: 'review', id: one.plan.id });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.state, 'approved', '这单只有一条 op，全勾选 → approved');
  assert.equal(reviewed.applied.replace, 1);
  assert.equal(store.getMemory(reviewed.replaced[0].to).text, '宝宝喜欢冰美式（已确认）。');
  assert.equal(store.getMemory(row.id), null, '统一修改语义：原条被（软）删');

  // 第二轮：驳回 → 只标记，记忆库原样
  // ⚠️ 第一轮的 replace 已经把原条软删，所以这一轮的 op 只能靶向**当前活着**的那条。
  const liveId = store.listMemories({ limit: 10 }).items[0].id;
  service.keeperReplies.push(JSON.stringify([{ type: 'drop', targets: [liveId], reason: '没用' }]));
  await keeperTool.execute({ action: 'run', sample: 1 });
  await waitKeeper(service);
  const second = (await keeperTool.execute({ action: 'plans', state: 'open' })).plans[0];
  const before = memorySnapshot(store);
  const rejected = await keeperTool.execute({ action: 'review', id: second.id, reject: true });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(memorySnapshot(store), before, 'reject 不写库');
  assert.equal(store.getKeeperPlan(second.id).state, 'rejected');

  const bad = await keeperTool.execute({ action: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /action 只能是/);
});

test('memory_keeper 工具：review 的 keep 只应用被勾选的那条（其余一个字节都不动）', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const a = store.addMemory({ text: '第一条：宝宝喜欢冰美式。' });
  const b = store.addMemory({ text: '第二条：她习惯凌晨睡。' });
  service.keeperReplies = [
    JSON.stringify([
      { type: 'rewrite', targets: [a.id], after: '宝宝喜欢冰美式（早上）。', reason: 'r' },
      { type: 'rewrite', targets: [b.id], after: '她习惯凌晨睡（工作日）。', reason: 'r' },
    ]),
  ];

  await keeperTool.execute({ action: 'run', sample: 1, perGroup: 2, maxGroups: 1 });
  await waitKeeper(service);
  const plan = (await keeperTool.execute({ action: 'plans', state: 'open' })).plans[0];
  assert.equal(plan.ops.length, 2, '两条 replace 要落进同一张单');

  const bBefore = memorySnapshot(store).find((line) => line.startsWith(`${b.id}|`));
  const reviewed = await keeperTool.execute({ action: 'review', id: plan.id, keep: [0] });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.state, 'partial', '只勾一条 → partial');
  assert.deepEqual(reviewed.applied, { replace: 1, split: 0, merge: 0, drop: 0 });
  assert.equal(reviewed.skipped, 1);
  assert.equal(store.getMemory(a.id), null, '勾选的那条原记忆被（软）删');
  assert.equal(store.getMemory(reviewed.replaced[0].to).text, '宝宝喜欢冰美式（早上）。');
  assert.equal(
    memorySnapshot(store).find((line) => line.startsWith(`${b.id}|`)),
    bBefore,
    '没勾选的那条一个字段都不许动',
  );

  // 工具层的 review 现在**能**就地改字：schema 里必须有 edits（键是 op 的 idx 字符串，
  // split 给字符串数组、replace / merge 给字符串）—— 否则 agent 审阅时只能照抄仓管的 after。
  const properties = keeperTool.parameters.properties ?? {};
  assert.equal('edits' in properties, true, '工具层必须有 edits 参数');
  assert.equal(properties.edits.type, 'object', 'edits 必须是对象（键是 op 的 idx 字符串）');
});

// ── 6. 工具层 edits：agent 审阅时就地改字（2026-10-07 收尾补的缺口） ────────────

test('memory_keeper 工具：review 带 edits → 落库文本就是手改后的文本（split 收数组）', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const rewriteRow = store.addMemory({ text: '原始正文，带 3.5 这个数字。' });
  const original = `${'甲'.repeat(60)}。${'乙'.repeat(60)}`;
  const splitRow = store.addMemory({ text: original });
  const dropRow = store.addMemory({ text: '这条是纯重复，建议删掉。' });
  const cut = original.indexOf('。') + 1;

  service.keeperReplies = [
    JSON.stringify([
      { type: 'rewrite', targets: [rewriteRow.id], after: '模型改的（丢了数字 3.5）。', reason: 'r' },
      { type: 'split', targets: [splitRow.id], after: [original.slice(0, cut), original.slice(cut)], reason: 's' },
      { type: 'drop', targets: [dropRow.id], reason: 'd' },
    ]),
  ];

  await keeperTool.execute({ action: 'run', sample: 1, perGroup: 5, maxGroups: 1 });
  await waitKeeper(service);
  const plan = (await keeperTool.execute({ action: 'plans', state: 'open' })).plans[0];
  assert.deepEqual(plan.ops.map((op) => op.type), ['replace', 'split', 'drop'], '三张 op 要落在同一张单里');

  const reviewed = await keeperTool.execute({
    action: 'review',
    id: plan.id,
    // 键是 op 的 idx 字符串：replace / merge 给字符串，split 给字符串数组，drop 忽略
    edits: { 0: '人改的正文，3.5 还在。', 1: ['甲段（人改）', '乙段（人改）'], 2: '这条是 drop，edits 给了也忽略' },
  });
  assert.equal(reviewed.ok, true, `工具层 review 应当成功：${JSON.stringify(reviewed)}`);
  assert.equal(reviewed.state, 'approved');
  assert.deepEqual(reviewed.applied, { replace: 1, split: 1, merge: 0, drop: 1 });

  // replace：手改后的正文作为**新记忆**录入，原条按统一语义删除（软删、可恢复）
  assert.equal(reviewed.replaced[0].from, rewriteRow.id);
  assert.equal(store.getMemory(reviewed.replaced[0].to).text, '人改的正文，3.5 还在。', 'replace 落的是手改后的正文，不是仓管的 after');
  assert.equal(store.getMemory(rewriteRow.id), null, '原条被（软）删');
  assert.equal(store.getMemory(splitRow.id).text, '甲段（人改）', 'split 第 1 块覆盖原文');
  assert.deepEqual(
    store.listKeeperArtifacts().derived.map((row) => row.text),
    ['乙段（人改）'],
    'split 其余块作为派生条入库',
  );
  assert.equal(store.getMemory(dropRow.id), null, 'drop 照旧软删（edits 对它没有意义）');
});

test('memory_keeper 工具：edits 类型不合 → ok:false 报原文，且一个字都不落库', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const rewriteRow = store.addMemory({ text: '原始正文，带 3.5。' });
  const original = `${'丙'.repeat(60)}。${'丁'.repeat(60)}`;
  const splitRow = store.addMemory({ text: original });
  const cut = original.indexOf('。') + 1;

  service.keeperReplies = [
    JSON.stringify([
      { type: 'rewrite', targets: [rewriteRow.id], after: '模型改的。', reason: 'r' },
      { type: 'split', targets: [splitRow.id], after: [original.slice(0, cut), original.slice(cut)], reason: 's' },
    ]),
  ];
  await keeperTool.execute({ action: 'run', sample: 1, perGroup: 5, maxGroups: 1 });
  await waitKeeper(service);
  const planId = (await keeperTool.execute({ action: 'plans', state: 'open' })).plans[0].id;
  const before = memorySnapshot(store);

  /** @type {[string, unknown, RegExp][]} [说明, edits, 期望报错] */
  const cases = [
    ['edits 不是对象（字符串）', '不是对象', /edits 必须是对象/],
    ['edits 不是对象（数组）', ['0', '改'], /edits 必须是对象/],
    ['replace 收到数组', { 0: ['应当是字符串'] }, /op 是 replace，值必须是字符串/],
    ['split 收到字符串', { 1: '应当是数组' }, /op 是 split，值必须是字符串数组/],
    ['split 收到空数组', { 1: [] }, /数组是空的/],
    ['split 的块是空串', { 1: ['好的', '   '] }, /有一块是空串/],
    ['replace 收到空串', { 0: '   ' }, /是空串/],
    ['下标越界', { 9: '改' }, /不是这张单里的 op 下标/],
    ['reject 与 edits 同时给', { 0: '改' }, /不该再给 edits/],
  ];

  for (const [label, edits, pattern] of cases) {
    const args = label.includes('reject') ? { action: 'review', id: planId, edits, reject: true } : { action: 'review', id: planId, edits };
    const bad = await keeperTool.execute(args);
    assert.equal(bad.ok, false, `${label}：应当报错`);
    assert.match(String(bad.error), pattern, `${label}：报错原文要对得上（实际 ${String(bad.error)}）`);
  }

  assert.deepEqual(memorySnapshot(store), before, '非法 edits 一个字都不许落库');
  assert.equal(store.getKeeperPlan(planId).state, 'open', '非法 edits 不该把单子推进成 approved / partial');
  assert.equal(store.getMemory(rewriteRow.id).text, '原始正文，带 3.5。');

  // 合法 edits 仍然照常落库（证明上面失败的是校验、不是「review 坏了」）
  const good = await keeperTool.execute({ action: 'review', id: planId, edits: { 0: '人手写的正文。', 1: ['丙块', '丁块'] } });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(store.getMemory(good.replaced[0].to).text, '人手写的正文。');
});

// ── 6b. 手工提出修改（propose）：用户定的统一修改语义 = 删旧录新 ─────────────────
//
// 用户原话（2026-10-07）：「修改记忆的做法是 **依照原记忆编写修改后的记忆** → **新旧记忆展示在待审区**
// → **过审后删除原记忆、录入新记忆**」。`propose` 是这条规范的手工入口：**只出单、不落库**。

test('memory_keeper {action:propose}：建一张单 op 的 replace 单（只出单不落库）；id / text 校验', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const original = '宝宝自 08-14 断在这里';
  const row = store.addMemory({ text: original, source: '04-环境与事实/新家系统.md', kind: 'palace' });

  const empty = await keeperTool.execute({ action: 'propose', id: row.id, text: '   ' });
  assert.equal(empty.ok, false);
  assert.match(String(empty.error), /text 不能为空/);

  const same = await keeperTool.execute({ action: 'propose', id: row.id, text: original });
  assert.equal(same.ok, false);
  assert.match(String(same.error), /一字不差/);

  const missing = await keeperTool.execute({ action: 'propose', id: '没有这条', text: '换一条正文' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这条记忆/);

  assert.deepEqual(store.listKeeperPlans(), [], '校验不通过时一张单都不该建');

  const proposed = await keeperTool.execute({ action: 'propose', id: row.id, text: '宝宝自 08-14 起……', reason: '正文断句补全' });
  assert.equal(proposed.ok, true);
  assert.equal(typeof proposed.planId, 'string');
  const plan = store.getKeeperPlan(proposed.planId);
  assert.equal(plan.state, 'open');
  assert.equal(plan.ops.length, 1, '单 op 变更单');
  assert.equal(plan.ops[0].type, 'replace');
  assert.deepEqual(plan.ops[0].targets, [row.id]);
  assert.deepEqual(plan.ops[0].before, [{ id: row.id, text: original }], '待审区要能看到新旧对比');
  assert.equal(plan.ops[0].after, '宝宝自 08-14 起……');
  assert.equal(plan.ops[0].reason, '正文断句补全');
  // 出单阶段：记忆库一个字段都不动
  assert.equal(store.countMemories(), 1);
  assert.equal(store.getMemory(row.id).text, original);
  assert.equal(store.getMemory(row.id).deleted_at, null);

  // 已软删的记忆不能作为 propose 目标（`getMemory()` 默认看不到软删行）
  store.softDeleteMemory(row.id);
  const deleted = await keeperTool.execute({ action: 'propose', id: row.id, text: '再换一条正文' });
  assert.equal(deleted.ok, false);
  assert.match(String(deleted.error), /没有这条记忆/);
});

test('replace 落库不继承仓管的回滚凭据（derivedFrom / keeper / merged），出处类 meta 照旧带过去', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const row = store.addMemory({
    text: '原始正文（带仓管回滚凭据）。',
    source: '04-环境与事实/新家系统.md',
    kind: 'palace',
    meta: {
      sync: 'palace',
      srcHash: 'h1',
      derivedFrom: '某条不该继承',
      keeper: { grind: { at: '2026-10-06T00:00:00.000Z' } },
      merged: [{ from: '某条不该继承' }],
    },
  });
  const proposed = await keeperTool.execute({ action: 'propose', id: row.id, text: '原始正文（带仓管回滚凭据）。已补全。' });
  assert.equal(proposed.ok, true);
  const reviewed = await service.reviewKeeperPlan({ id: proposed.planId });
  const newRow = store.getMemory(reviewed.replaced[0].to);
  assert.equal(newRow.meta.sync, 'palace', '出处类 meta 要带过去');
  assert.equal(newRow.meta.srcHash, 'h1');
  assert.equal(newRow.meta.derivedFrom, undefined, '继承它会被 revert 当成研磨产物再删一次');
  assert.equal(newRow.meta.keeper, undefined, '继承它会被 revert 当成「被改写的原文」');
  assert.equal(newRow.meta.merged, undefined, '继承它会被 revert 当成合并保留条');
});

test('离线端到端：propose → 待审（未落库）→ review → 删旧录新 → revert 放回', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const space = service.embeddingSpace(service.resolvedConfig()).key;
  const originalText = '宝宝自 08-14 宝宝自';
  const original = store.addMemory({
    text: originalText,
    source: '04-环境与事实/新家系统.md',
    kind: 'palace',
    meta: { sync: 'palace' },
  });
  // 给原条塞一条向量：落库时它必须被清掉（否则软删的行还能被语义搜到 = 幽灵命中）
  store.putVector({ memoryId: original.id, space, provider: 'ollama', model: 'x', dims: 2, vector: new Float32Array([1, 0]) });
  assert.equal(store.countMemories(), 1);
  assert.equal(store.countVectors(space), 1);

  const after = '宝宝自 08-14 起，作息如下：……（完整正文）';
  const proposed = await keeperTool.execute({ action: 'propose', id: original.id, text: after, reason: '正文断句补全' });
  assert.equal(proposed.ok, true);

  // ① 落库之前：库里**只有原来的 1 条**，单子是 open
  assert.equal(store.countMemories(), 1, 'propose 绝不落库');
  assert.equal(store.getMemory(original.id).text, originalText, '原条正文没动');
  assert.equal(store.getKeeperPlan(proposed.planId).state, 'open');

  // 拦下自动补向量，专心验「谁被排进队列」
  const queued = [];
  service.scheduleEmbed = (id) => queued.push(String(id));

  // ② 过审 → 删旧录新
  const reviewed = await service.reviewKeeperPlan({ id: proposed.planId });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.state, 'approved');
  assert.deepEqual(reviewed.applied, { replace: 1, split: 0, merge: 0, drop: 0 });
  const newId = reviewed.replaced[0].to;

  const oldRow = store.getMemory(original.id, { includeDeleted: true });
  assert.notEqual(oldRow.deleted_at, null, '① 原条 deleted_at != null（软删 = 系统默认的「删除」，可恢复）');
  assert.equal(oldRow.text, originalText, '软删的行与正文都还在（不是真删）');

  assert.notEqual(newId, original.id, '② 新条 id 是新的');
  const newRow = store.getMemory(newId);
  assert.equal(newRow.meta.replaces, original.id, '② meta.replaces = 原 id');
  assert.equal(typeof newRow.meta.replacedAt, 'string', '② meta.replacedAt 是落库时间戳');
  assert.equal(newRow.meta.sync, 'palace', '出处类 meta 照旧带上');
  assert.equal(newRow.source, '04-环境与事实/新家系统.md', 'source 照抄原条');
  assert.equal(newRow.kind, 'palace', 'kind 照抄原条');
  assert.equal(newRow.scope, store.getMemory(original.id, { includeDeleted: true }).scope, 'scope 照抄原条');
  assert.equal(newRow.text, after, '③ 新条正文 = after');
  assert.equal(store.countMemories(), 1, '④ 删旧录新 → 可见条数仍是 1');
  assert.equal(store.countVectors(space), 0, '⑤ 原条向量被清');
  assert.deepEqual(queued, [newId], '⑥ 新条被排进嵌入队列');
  assert.equal(store.countMissingVectors(space), 1, '⑥ 于是它算「缺向量」，等补齐');
  assert.equal(store.listKeeperArtifacts().replaced.length, 1, '「现存痕迹 · 替换」数得到它');
  assert.equal(store.getKeeperPlan(proposed.planId).ops[0].newId, newId, 'newId 写回 op（面板显示「新记忆 id」）');

  // ③ revertKeeper：新条真删、原条放回、条数回到 1
  const reverted = service.revertKeeper();
  assert.equal(reverted.ok, true);
  assert.equal(reverted.removedReplaced, 1, '本轮产出的新记忆真删');
  assert.equal(reverted.restoredOriginal, 1, '原记忆放回');
  assert.equal(store.getMemory(newId, { includeDeleted: true }), null, '新记忆真删（它本来就是本轮产物）');
  assert.equal(store.getMemory(original.id).text, originalText, '原记忆放回、正文一个字没动');
  assert.equal(store.getMemory(original.id).deleted_at, null, '原条不再是软删');
  assert.equal(store.countMemories(), 1, '条数回到 1');
  assert.equal(store.listKeeperArtifacts().replaced.length, 0, '替换痕迹归零');
  assert.deepEqual(reverted.remaining, { derived: 0, rewritten: 0, merged: 0, replaced: 0 });
});

// ── 6c. 手工提出删除（propose-drop）：删改都要进待审区 ────────────────────────────
//
// 用户 2026-10-07 明确「**删改都要进待审区**」：库里已录的噪声（会话态 / 工具态）以前只能直删。
// `propose-drop` 与 `propose` 并列，是删除的**唯一**手工入口：**只出单、不落库**；
// 过审才软删（可恢复），`revertKeeper()` 从已应用变更单的 `drop` op 把它放回来。

test('memory_keeper {action:propose-drop}：建一张单 op 的 drop 单（只出单不落库）；id 校验', async () => {
  const { keeperTool, store } = makeKeeperToolService();
  const text = '助手认为「效果好不好」这类判断只能由用户来做（该清的会话态噪声）';
  const row = store.addMemory({ text, source: '自主捕获', kind: 'auto' });

  const empty = await keeperTool.execute({ action: 'propose-drop' });
  assert.equal(empty.ok, false);
  assert.match(String(empty.error), /缺少 id/);

  const missing = await keeperTool.execute({ action: 'propose-drop', id: '没有这条' });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /没有这条记忆/);
  assert.deepEqual(store.listKeeperPlans(), [], '校验不通过时一张单都不该建');

  const before = memorySnapshot(store);
  const proposed = await keeperTool.execute({ action: 'propose-drop', id: row.id, reason: '会话态噪声' });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(typeof proposed.planId, 'string');
  const plan = store.getKeeperPlan(proposed.planId);
  assert.equal(plan.state, 'open');
  assert.equal(plan.ops.length, 1, '单 op 变更单');
  assert.equal(plan.ops[0].type, 'drop');
  assert.deepEqual(plan.ops[0].targets, [row.id]);
  assert.deepEqual(plan.ops[0].before, [{ id: row.id, text }], '待审区要能看到待删的正文');
  assert.equal(plan.ops[0].after, null);
  assert.equal(plan.ops[0].reason, '会话态噪声');
  assert.deepEqual(plan.ops[0].warnings, []);
  assert.deepEqual(memorySnapshot(store), before, '出单阶段一个字都不改记忆库');

  // 已软删的记忆不能作为 propose-drop 目标（`getMemory()` 默认看不到软删行）
  store.softDeleteMemory(row.id);
  const deleted = await keeperTool.execute({ action: 'propose-drop', id: row.id });
  assert.equal(deleted.ok, false);
  assert.match(String(deleted.error), /没有这条记忆/);
});

test('propose-drop 端到端：出单不落库 → review 软删（行还在）→ revertKeeper 放回', async () => {
  const { service, keeperTool, store } = makeKeeperToolService();
  const space = service.embeddingSpace(service.resolvedConfig()).key;
  const text = '助手安抚用户不必担心，说明记忆数据完好，只是面板前端渲染挂了。';
  const row = store.addMemory({ text, source: '自主捕获', kind: 'auto' });
  // 给它一条向量：软删时它必须被清掉（否则软删的行还能被语义搜到 = 幽灵命中）。
  store.putVector({ memoryId: row.id, space, provider: 'ollama', model: 'x', dims: 2, vector: new Float32Array([1, 0]) });
  assert.equal(store.countMemories(), 1);
  assert.equal(store.countVectors(space), 1);

  const proposed = await keeperTool.execute({ action: 'propose-drop', id: row.id, reason: '会话态噪声' });
  assert.equal(proposed.ok, true);

  // ① 落库之前：条数不变、单子 open
  assert.equal(store.countMemories(), 1, 'propose-drop 绝不落库');
  assert.equal(store.getMemory(row.id).deleted_at, null);
  assert.equal(store.getKeeperPlan(proposed.planId).state, 'open');

  /** @type {string[]} */
  const queued = [];
  service.scheduleEmbed = (id) => queued.push(String(id));

  // ② 过审 → 软删
  const reviewed = await keeperTool.execute({ action: 'review', id: proposed.planId });
  assert.equal(reviewed.ok, true);
  assert.deepEqual(reviewed.applied, { replace: 0, split: 0, merge: 0, drop: 1 });
  assert.equal(reviewed.state, 'approved');
  assert.equal(store.countMemories(), 0, 'drop 落库后不可见');
  assert.equal(store.getMemory(row.id), null, 'getMemory 默认看不到软删行');
  const dropped = store.getMemory(row.id, { includeDeleted: true });
  assert.notEqual(dropped.deleted_at, null, '是**软删**（行仍在、可恢复），不是真删');
  assert.equal(dropped.text, text, '正文一个字没动');
  assert.equal(store.countVectors(space), 0, '软删要顺手清向量');

  // ③ revertKeeper：按已应用变更单里的 drop op 放回
  const reverted = service.revertKeeper();
  assert.equal(reverted.ok, true);
  assert.equal(reverted.restoredDropped, 1, '回滚统计要能看到放回几条');
  assert.equal(store.getMemory(row.id).deleted_at, null, '放回来了');
  assert.equal(store.getMemory(row.id).text, text, '正文一个字没动');
  assert.equal(store.countMemories(), 1, '条数回到 1');
  assert.deepEqual(queued, [row.id], '放回后重新排队补向量（软删时清掉了）');

  // 幂等：再回滚一次不会重复计数（已经放回来的 restoreMemory 回 false）
  assert.equal(service.revertKeeper().restoredDropped, 0);
});

test('createLocalLlm：自建超时信号仍是 TimeoutError（换掉 AbortSignal.timeout 后语义不变）', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const client = createLocalLlm(
    { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434', timeoutMs: 20 },
    { fetchImpl },
  );

  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: '在吗' }] }), (err) => {
    assert.equal(err.name, 'TimeoutError', 'reason 必须还是 TimeoutError（与 AbortSignal.timeout 一致）');
    return true;
  });

  // 请求正常结束时不 abort：`clear()` 撤掉定时器，信号保持未触发。
  let seen = null;
  const ok = createLocalLlm(
    { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434', timeoutMs: 20 },
    {
      fetchImpl: async (url, init) => {
        seen = init.signal;
        return { ok: true, status: 200, json: async () => ({ message: { content: '可用' } }) };
      },
    },
  );
  assert.equal(await ok.chat({ messages: [{ role: 'user', content: '在吗' }] }), '可用');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.aborted, false, '请求已结束 → clear() 之后不该再被超时 abort');
});

test('createLocalLlm：单次 timeoutMs 覆盖只能收紧，不能放宽（整组预算靠它分给每一次请求）', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  // 档案超时 5 秒，这一次只给 20ms → 20ms 就超时（收紧生效）
  const tight = createLocalLlm(
    { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434', timeoutMs: 5000 },
    { fetchImpl },
  );
  const startedAt = Date.now();
  await assert.rejects(() => tight.chat({ messages: [{ role: 'user', content: '在吗' }], timeoutMs: 20 }), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
  assert.ok(Date.now() - startedAt < 1000, '必须按 20ms 的覆盖值超时，而不是等档案的 5 秒');

  // 反向：档案 20ms、这一次给 5 秒 → 仍然按档案的 20ms（覆盖值**不能放宽**）
  const loose = createLocalLlm(
    { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: 'http://127.0.0.1:11434', timeoutMs: 20 },
    { fetchImpl },
  );
  const started2 = Date.now();
  await assert.rejects(() => loose.chat({ messages: [{ role: 'user', content: '在吗' }], timeoutMs: 5000 }), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
  assert.ok(Date.now() - started2 < 1000, '覆盖值不能把档案超时放宽到 5 秒');
});

test('groupDeadlineMs：默认取档案超时的 2 倍，显式值优先，两边都没有就不设上限', () => {
  // 真机实测：正常一组跑了 231 秒才成功 → 安全网必须在这之上（240s × 2 = 480s）
  assert.equal(groupDeadlineMs({ groupTimeoutMs: 0, requestTimeoutMs: 240000 }), 480000);
  assert.equal(groupDeadlineMs({ requestTimeoutMs: 240000 }), 480000, '默认 factor=2');
  assert.equal(groupDeadlineMs({ groupTimeoutMs: 90000, requestTimeoutMs: 240000 }), 90000, '显式值优先（可以比 2× 小）');
  assert.equal(groupDeadlineMs({ groupTimeoutMs: 0, requestTimeoutMs: 0 }), 0, '都没给 = 不设上限');
  assert.equal(groupDeadlineMs({}), 0);
  assert.equal(groupDeadlineMs({ groupTimeoutMs: -1, requestTimeoutMs: -5 }), 0, '负数一律当没给');
  assert.equal(groupDeadlineMs({ groupTimeoutMs: 1.9, requestTimeoutMs: 0 }), 1, '取整');
});

// ── 7. 用户最终语义（2026-10-07）：replace / merge「允许改写，只钉事实要点」 ───────
//
// 用户原话：「灵活一些 让LLM视情况决策 缩写、去冗余、优化语序 都是被允许的」。
// 判据：`factCheck()` **只产证据**（丢了 N 个数字 / 消失的片段 / 压缩到 X%），
// 措辞中性、不做「违规 / 不是纯删除」定性；唯一的不变量是事实要点不许丢、不许新增、
// 不许把不确定的写成确定的。
//
// ⚠️ 同一轮追加（用户：「整理后的记忆块要完整，这很危险」）：`split` 的旧强保证
// 「逐字无损 / 子序列 ≥98%」**作废** —— 为了每块自足允许重复原文主语词，重复出来的字符
// 天然不是子序列。第 8 节把三条新规则（每块自足 / 不丢内容 / 不新增）逐条钉住。

test('PLAN_PROMPT：明确允许缩写 / 去冗余 / 优化语序，并钉住三条不变量', () => {
  const prompt = buildPlanRequest({ members: [{ id: 'm1', text: '短' }] }).messages[0].content;
  assert.match(prompt, /改写是允许的，请视情况灵活决策/);
  assert.match(prompt, /缩写、去掉重复啰嗦、优化语序/);
  assert.match(prompt, /换同义说法/, '同义换词也放行');
  assert.match(prompt, /改错别字/, '必要时改错别字也放行');
  assert.match(prompt, /事实要点一个都不许丢/);
  assert.match(prompt, /引号里的原话/);
  assert.match(prompt, /emoji 与标签符号/);
  assert.match(prompt, /不许新增/);
  assert.match(prompt, /不许把不确定的写成确定的/);
  // 本轮的自足铁律（旧的「split 必须逐字无损 / 子序列 ≥98%」一个都不许留 —— 见 REGRESSION.md）
  assert.match(prompt, /每一块 \/ 每条整理结果都必须自足/);
  assert.match(prompt, /可以重复原文中的主语词/);
  assert.match(prompt, /禁止产出「边界=…」/);
  assert.equal(
    /逐字无损|子序列|不能增删一个字/.test(prompt),
    false,
    '旧的「split 逐字无损」承诺必须清干净（它与「允许重复主语」直接冲突）',
  );
  // 过严那版的口径必须清干净（不留两套）
  assert.equal(
    /只准删|不准改|after 必须是原文的子序列|不是纯删除|标红/.test(prompt),
    false,
    '过严口径（只准删 / 子序列 / 标红）一个都不许留',
  );
});

test('buildPlanRequest：emphasis=dedupe 追加「偏重去重合并」引导；all / 省略都不带', () => {
  const members = [
    { id: 'm1', text: '第一条记忆正文。' },
    { id: 'm2', text: '第二条记忆正文。' },
  ];
  const all = buildPlanRequest({ members, emphasis: 'all' });
  const omitted = buildPlanRequest({ members });
  const dedupe = buildPlanRequest({ members, emphasis: 'dedupe' });

  assert.equal(/偏重去重合并/.test(all.messages[0].content), false, "emphasis:'all' 不该带侧重段");
  assert.equal(/偏重去重合并/.test(omitted.messages[0].content), false, '省略 emphasis = all');
  assert.match(dedupe.messages[0].content, /偏重去重合并/, "emphasis:'dedupe' 必须带那段引导");
  assert.match(dedupe.messages[0].content, /优先找「同一件事被拆成多条」的情况并给出 merge/);
  assert.match(dedupe.messages[0].content, /不要为了拆而拆/);
  assert.match(dedupe.messages[0].content, /不鼓励无边界的 split/);
  // 侧重只是补充：自足铁律与「事实要点一个都不许丢」一个字都不能被顶掉
  assert.match(dedupe.messages[0].content, /事实要点一个都不许丢/);
  assert.match(dedupe.messages[0].content, /每一块 \/ 每条整理结果都必须自足/);
  assert.equal(
    /逐字无损|子序列/.test(dedupe.messages[0].content),
    false,
    '侧重段里也不许留旧的「逐字无损」承诺',
  );

  // 用户消息也如实反映侧重：大段那句从「优先 split」换成「别为了拆而拆」。
  const long = '第一件事讲清楚。'.repeat(30);
  const dedupeLong = buildPlanRequest({ members: [{ id: 'm1', text: long }], minChars: 240, emphasis: 'dedupe' });
  assert.match(dedupeLong.messages[1].content, /别为了拆而拆/);
  const allLong = buildPlanRequest({ members: [{ id: 'm1', text: long }], minChars: 240 });
  assert.match(allLong.messages[1].content, /优先考虑 split/);
  assert.equal(/别为了拆而拆/.test(allLong.messages[1].content), false, '默认侧重不出现 dedupe 的措辞');
});

test('replace（旧 rewrite 输入）：同义换词 / 改错别字 → 允许出单，证据是「消失的片段」，没有「违规」字样', () => {
  const members = [
    { id: 'm1', text: '把这条记忆改成干练的写法。' },
    { id: 'm2', text: '他做事按部就分，从来不马虎。' },
  ];
  const ops = normalizePlanOps(
    JSON.stringify([
      { type: 'rewrite', targets: ['m1'], after: '把这条记忆改为干练的写法。' },
      { type: 'rewrite', targets: ['m2'], after: '他做事按部就班，从来不马虎。' },
    ]),
    { members },
  );
  assert.equal(ops.length, 2, '改写过的 op 照样出单');
  assert.deepEqual(ops[0].warnings, ['消失的片段：把这条记忆改成干练的写法']);
  assert.deepEqual(ops[1].warnings, ['消失的片段：他做事按部就分']);
  assert.equal(factCheck(members[0].text, ops[0].after).ok, true, '同义改写不是「不 ok」');
  assert.equal(planWarnings(ops).some((line) => /违规|不是纯删除|只准删/.test(line)), false);
});

test('replace（旧 rewrite 输入）：只优化语序 / 缩写而要点齐全 → 零警告（这是允许的正常改写）', () => {
  const members = [{ id: 'm1', text: '周三要去医院复查，指标 3.5，医生说「记得带报告」。' }];
  const reordered = normalizePlanOps(
    JSON.stringify([
      { type: 'rewrite', targets: ['m1'], after: '医生说「记得带报告」；周三要去医院复查，指标 3.5。', reason: '理顺语序' },
    ]),
    { members },
  );
  assert.equal(reordered.length, 1);
  assert.deepEqual(reordered[0].warnings, [], '语序变了但没丢任何要点 → 不该有噪音');

  // 换一种引号样式、原话还在 → 也不算丢
  const requoted = normalizePlanOps(
    JSON.stringify([{ type: 'rewrite', targets: ['m1'], after: '医生说“记得带报告”；周三要去医院复查，指标 3.5。' }]),
    { members },
  );
  assert.deepEqual(requoted[0].warnings, [], '只是引号样式变了，原话还在');
});

test('merge：拿各条原文的并集当证据基准 —— 事实要点丢没丢，一眼能看到', () => {
  const members = [
    { id: 'm1', text: '宝宝喜欢喝冰美式，早上起来必喝一杯，就是每天都喝。' },
    { id: 'm2', text: '宝宝喜欢喝冰美式，早上起来必喝一杯，其实是每天都喝。' },
  ];
  const merged = normalizePlanOps(
    JSON.stringify([
      { type: 'merge', targets: ['m1', 'm2'], after: '宝宝喜欢喝冰美式，早上起来必喝一杯。', reason: '同一件事' },
    ]),
    { members },
  );
  assert.equal(merged[0].type, 'merge');
  assert.deepEqual(merged[0].warnings, [
    '消失的片段：就是每天都喝 / 其实是每天都喝',
    '压缩到 35%（留意是否过度缩写）',
  ]);
  assert.equal(factCheck(merged[0].before.map((row) => row.text).join('\n'), merged[0].after).ok, true, '没丢数字');

  // 并集里的数字丢了 → 硬信号照常出现（merge 也拿并集比）
  const withNumbers = normalizePlanOps(
    JSON.stringify([
      { type: 'merge', targets: ['m3', 'm4'], after: '宝宝复查过，指标还行。', reason: '同一件事' },
    ]),
    { members: [{ id: 'm3', text: '宝宝在 2026-03 复查，指标 3.5。' }, { id: 'm4', text: '宝宝 2026-03 复查，指标 3.5。' }] },
  );
  assert.match(withNumbers[0].warnings[0], /^丢了 2 个数字：2026-03 \/ 3\.5$/);
});

test('压缩比：极低才附「留意是否过度缩写」，正常去冗余变短不报警', () => {
  // 正常去冗余：压到 64%，有中性压缩比、没有「留意」
  const normal = factWarnings('宝宝喜欢喝冰美式，早上起来必喝一杯，就是每天都喝。', '宝宝喜欢喝冰美式，早上必喝一杯。');
  assert.deepEqual(normal, ['消失的片段：早上起来必喝一杯 / 就是每天都喝', '压缩到 64%']);
  assert.equal(normal.some((line) => line.includes('留意')), false);

  // 极低（< 40%）：才附提醒
  const heavy = factWarnings('宝宝在 2026-03 复查，指标 3.5，端口 8080，医生说要复查三次。', '宝宝复查。');
  assert.equal(heavy.some((line) => /^压缩到 \d+%（留意是否过度缩写）$/.test(line)), true);
  assert.equal(factWarnings('宝宝在 2026-03 复查。', '宝宝在 2026-03 复查。').length, 0, '什么都没变就没警告');
});

test('split：有损输出不再被兜底抹平（旧「逐字无损」承诺作废）；losslessSplit 只在没给可用碎片时兜底', () => {
  const original = '甲'.repeat(150) + '。' + '乙'.repeat(150) + '。' + '丙'.repeat(150);
  const members = [{ id: 'm1', text: original }];

  // 模型「总结」成两句话（有损）：**原样采信**，损失与缺主语照报成证据。
  // 旧行为是丢掉模型输出、兜底成「覆盖率 1.0」——那条强保证已随本轮新规则作废。
  const lossy = normalizePlanOps(
    JSON.stringify([{ type: 'split', targets: ['m1'], after: ['甲很多。', '乙也不少。'] }]),
    { members, splitChars: 200 },
  );
  assert.equal(lossy.length, 1);
  assert.equal(lossy[0].type, 'split');
  assert.deepEqual(lossy[0].after, ['甲很多。', '乙也不少。']);
  assert.equal(lossy[0].warnings.some((line) => /^这块可能缺主语：/.test(line)), true);
  assert.equal(lossy[0].warnings.some((line) => /^消失的片段：/.test(line)), true);
  assert.ok(coverageOf(original, lossy[0].after).ratio < 0.98, '不再有「必须 ≥98% 子序列」这条硬校验');

  // `losslessSplit()` 兜底是它**唯一**还保留的角色：模型压根没给可用碎片时
  const empty = normalizePlanOps(JSON.stringify([{ type: 'split', targets: ['m1'], after: [] }]), {
    members,
    splitChars: 200,
  });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].warnings[0], '兜底切分（模型没给可用碎片）');
  assert.equal(coverageOf(original, empty[0].after).ratio, 1, '确定性兜底切分按构造不丢字');

  // 模型本来就把原文切开（逐块也带锚点）→ 原样采信，零警告
  const exact = normalizePlanOps(
    JSON.stringify([
      { type: 'split', targets: ['m1'], after: ['甲'.repeat(150) + '。', '乙'.repeat(150) + '。' + '丙'.repeat(150)] },
    ]),
    { members, splitChars: 200 },
  );
  assert.deepEqual(exact[0].warnings, []);
  assert.equal(coverageOf(original, exact[0].after).ratio, 1);
});

test('keeperStatus：顶层 configured/provider/endpoint/model 必须来自**生效档案**（重启后第一次问也一样）', async () => {
  const dataDir = join(TMP, `data-status-${Math.random().toString(36).slice(2, 8)}`);
  // patch 里什么都不配（和真实环境一样：只有具名档案「线上」是可用的）
  const first = makeService({ keeper: { model: null, ollamaUrl: null }, dataDir });
  first.service.listKeeperProfiles(); // 播种
  assert.equal(first.service.activateKeeperProfile('线上').ok, true);
  const warm = first.service.keeperStatus();
  assert.equal(warm.configured, true, '库开着时本来就是对的（这条是哨兵，不是回归点）');
  assert.equal(warm.model, 'qwen-plus');
  first.close(); // 关库：模拟进程结束

  // 重启后第一次打开面板：库还没开，keeperStatus() 也必须按生效档案解析
  const second = makeService({ keeper: { model: null, ollamaUrl: null }, dataDir, ensure: false });
  assert.equal(second.service.store, null, '这一实例还没开库（这才是「第一次问」的样子）');
  const cold = second.service.keeperStatus();
  assert.equal(cold.active, '线上');
  assert.equal(cold.configured, true, 'active 是「线上」，顶层就不能报「未配置」');
  assert.equal(cold.provider, 'openai');
  assert.equal(cold.model, 'qwen-plus');
  assert.equal(cold.endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(cold.hint, undefined, '配置齐了就不该再提示去写 keeper.model');
  // 和「真正会跑的那份配置」逐项一致（同一套生效档案解析）
  const effective = second.service.resolvedKeeperConfig().keeper;
  assert.equal(cold.model, effective.model);
  assert.equal(cold.provider, effective.provider);

  // 同一套解析还要覆盖另外两个入口：`keeperTest()`（不带 name = 测当前生效档案）与
  // `startKeeperRun()` —— 冷启动时它们也必须按生效档案走，而不是退回 patch。
  // 这里把 fetch 换成「一打就抛」的桩：既证明它**确实**解析到了「线上」（否则会先报
  // 「仓管未配置模型」），又保证测试绝不发真实网络请求。
  second.service.fetchImpl = async () => {
    throw new Error('测试禁止真实网络请求');
  };
  // 撤掉 makeService 的假客户端桩：这里要验的正是**真实的** createKeeperClient 解析路径
  delete second.service.createKeeperClient;
  const probe = await second.service.keeperTest();
  assert.equal(probe.ok, false);
  assert.equal(
    /未配置模型/.test(String(probe.error)),
    false,
    `冷启动的 keeperTest() 也要按生效档案解析，实际：${JSON.stringify(probe)}`,
  );

  const seenCfg = [];
  const cold2 = makeService({ keeper: { model: null, ollamaUrl: null }, dataDir, ensure: false });
  cold2.service.createKeeperClient = async (cfg) => {
    seenCfg.push(cfg);
    return { provider: 'fake', model: 'fake', endpoint: 'http://fake', chat: async () => '[]' };
  };
  await cold2.service.startKeeperRun({ sample: 1 });
  await waitKeeper(cold2.service);
  assert.equal(seenCfg.length, 1);
  assert.equal(seenCfg[0].keeper.model, 'qwen-plus', '冷启动第一轮 run 也不能拿 patch 的 model:null 去建客户端');

  // 具名档案没配齐时，hint 要指向**那个档案**（面板「仓管 → 档案」），
  // 而不是让人去改 patch 的 keeper.model —— 后者在 active ≠ config 时根本不参与合并。
  assert.equal(second.service.activateKeeperProfile('局域网-ollama').ok, true);
  const unset = second.service.keeperStatus();
  assert.equal(unset.active, '局域网-ollama');
  assert.equal(unset.configured, false);
  assert.match(String(unset.hint), /局域网-ollama/, 'hint 要点名生效档案');
  assert.equal(/keeper\.model/.test(String(unset.hint)), false, '别再指 patch 的键');
  second.close();
  cold2.close();
});

test('真实数据回归（离线）：3 条重复表述出单 —— 允许同义改写，证据只列「消失的片段」', async () => {
  const { service, store } = makeService({
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text })),
  });
  const a = store.addMemory({ text: '宝宝喜欢喝冰美式，早上起来必喝一杯，就是每天都喝。' });
  const b = store.addMemory({ text: '宝宝喜欢喝冰美式，早上起来必喝一杯，其实是每天都喝。' });
  const c = store.addMemory({ text: '宝宝喜欢喝冰美式，早上起来必喝一杯。' });
  const before = memorySnapshot(store);

  /**
   * 换一个「照抄固定 after」的假仓管 LLM（不联网）。
   *
   * @param {string} text 模型给出的合并正文
   */
  const keeperReplying = (text) => {
    service.createKeeperClient = async () => ({
      provider: 'ollama',
      model: 'fake-keeper',
      endpoint: 'http://fake',
      chat: async () =>
        JSON.stringify([{ type: 'merge', targets: [a.id, b.id, c.id], after: text, reason: '三条在说同一件事' }]),
    });
  };

  // 第一轮：模型把「就是 / 其实是」换成了「爱」—— 同义改写**允许**，只给中性证据
  keeperReplying('宝宝喜欢喝冰美式，早上起来必喝一杯，每天都爱喝。');
  const first = await service.startKeeperRun({ sample: 1, perGroup: 5, maxGroups: 1 });
  await waitKeeper(service);
  const firstPlan = store.listKeeperPlans({ state: 'open' }).find((plan) => plan.runId === first.runId);
  assert.equal(firstPlan.ops[0].type, 'merge');
  assert.equal(firstPlan.ops[0].before.length, 3, '三条都要作为 before 进单');
  assert.deepEqual(firstPlan.ops[0].warnings, [
    '消失的片段：就是每天都喝 / 其实是每天都喝',
    '压缩到 34%（留意是否过度缩写）',
  ]);
  assert.equal(
    service.getKeeperPlan(firstPlan.id).plan.warnings.includes(`#1 ${firstPlan.ops[0].warnings[0]}`),
    true,
    '单级 warnings 也要带出来',
  );
  assert.equal(
    JSON.stringify(firstPlan.ops[0].warnings).includes('违规'),
    false,
    '同义改写不该被定性成违规',
  );
  assert.deepEqual(memorySnapshot(store), before, '出单阶段记忆库一个字都不许改');

  // 第二轮：做成完全一致的正文 → 只剩「消失的片段」+ 压缩比，没有别的噪音
  keeperReplying('宝宝喜欢喝冰美式，早上起来必喝一杯。');
  const second = await service.startKeeperRun({ sample: 1, perGroup: 5, maxGroups: 1 });
  await waitKeeper(service);
  const secondPlan = store.listKeeperPlans({ state: 'open' }).find((plan) => plan.runId === second.runId);
  assert.deepEqual(secondPlan.ops[0].warnings, [
    '消失的片段：就是每天都喝 / 其实是每天都喝',
    '压缩到 25%（留意是否过度缩写）',
  ]);
  assert.deepEqual(memorySnapshot(store), before, '出单阶段记忆库一个字都不许改');
  assert.equal(store.listKeeperPlans({ state: 'open' }).length, 2, '两轮各出一张 open 单');
});

// ── 8. 每块自足（用户 2026-10-07：「这很危险，因此整理后的记忆块要完整」）────────────
//
// 三条规则一起钉：①每块自足（缺主语必须报；为此**允许重复原文主语词**）
// ②不丢内容（数字 / 引号原话 / emoji 的丢失证据照旧）③不凭空加信息（「允许重复，禁止发明」）。
// 三条都**只产证据、不改判**：op 照出，人自己拍板。
// ⚠️ 旧承诺「split 逐字无损（子序列 ≥98%）」已作废 —— 重复主语词天然不是子序列。

/** 用户那条真实形态的样例：主语是「Nemotron 免费劳工」，其中一块只讲「边界」。 */
const NEMOTRON_MEMORY =
  'Nemotron 免费劳工授权（08-13 宝宝拍板）：小屿可以调度 Nemotron 免费劳工干重活，不用花自己的额度；' +
  '边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人；' +
  '免费额度用完之后要停手，不许花钱买额度。';

test('anchorsOf / selfContained：锚点来自专有名词 / 英文与数字标识 / 高频主题词；缺主语判得出来', () => {
  const anchors = anchorsOf([NEMOTRON_MEMORY]);
  assert.ok(anchors.length > 0);
  assert.equal(anchors.includes('Nemotron'), true, '英文专有名词是最硬的锚点');
  assert.equal(anchors.includes('08-13'), true, '数字标识也是锚点');

  // 缺主语：只剩「边界=…」，脱离上下文会被读成一条全局边界
  const orphan = selfContained('边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。', anchors);
  assert.equal(orphan.ok, false, '一个锚点都没命中 → 判缺主语');
  assert.equal(orphan.hit, null);

  // 允许重复主语：把「Nemotron 免费劳工」重复一遍（重复不算冗余）→ 自足
  const kept = selfContained(
    'Nemotron 免费劳工：边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。',
    anchors,
  );
  assert.equal(kept.ok, true);
  assert.equal(kept.hit, 'Nemotron');

  // 提不出锚点时**不判缺主语**（没有基准就不给人扣帽子）
  assert.deepEqual(selfContained('随便一句短话。', anchorsOf(['随便一句短话。'])), { ok: true, hit: null });
  assert.deepEqual(selfContained('随便一句短话。', []), { ok: true, hit: null });
});

test('addedTerms：允许重复，禁止发明', () => {
  // 只重复原文主语词 → 一个新片段都没有
  const repeated = 'Nemotron 免费劳工：边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。';
  assert.deepEqual(addedTerms(NEMOTRON_MEMORY, repeated), [], '重复原文里的词是允许的');

  // 模型自己发明（原文根本没有「全局」「通行」）
  const invented = 'Nemotron 免费劳工：边界=全局通行，可以覆盖任何规则。';
  const added = addedTerms(NEMOTRON_MEMORY, invented);
  assert.equal(added.length > 0, true, '原文里没有的词必须报出来');
  assert.equal(added.join('').includes('全局'), true);

  // 纯去冗余 / 优化语序 / 同义换词不带新字 → 不报（免得天天狼来了）
  assert.deepEqual(addedTerms('把这条记忆改成干练的写法。', '把这条记忆改为干练的写法。'), []);
  assert.deepEqual(addedTerms('宝宝喜欢喝冰美式，早上起来必喝一杯。', '宝宝喜欢喝冰美式，早上必喝一杯。'), []);
  assert.deepEqual(addedTerms('医生说要复查。', '医生说“要复查”。'), [], '引号样式变了不算新增');
});

test('split：只有「边界=…」的块 → 报缺主语；每块都补回锚点（重复主语）→ 不再报', () => {
  const members = [{ id: 'm1', text: NEMOTRON_MEMORY }];
  const orphanPieces = [
    'Nemotron 免费劳工授权（08-13 宝宝拍板）：小屿可以调度 Nemotron 免费劳工干重活，不用花自己的额度。',
    '边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。',
    '免费额度用完之后要停手，不许花钱买额度。',
  ];
  const keptPieces = [
    'Nemotron 免费劳工授权（08-13 宝宝拍板）：小屿可以调度 Nemotron 免费劳工干重活，不用花自己的额度。',
    'Nemotron 免费劳工：边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。',
    'Nemotron 免费劳工：免费额度用完之后要停手，不许花钱买额度。',
  ];

  const orphanOp = normalizePlanOps(JSON.stringify([{ type: 'split', targets: ['m1'], after: orphanPieces }]), {
    members,
  })[0];
  assert.equal(
    orphanOp.warnings.some((line) => /^这块可能缺主语：边界=只做体力活/.test(line)),
    true,
    '第二块丢主语 → 必须有 warning',
  );
  assert.equal(orphanOp.warnings.some((line) => line.includes('脱离上下文会被读成全局')), true, 'warning 要说清危险在哪');

  const keptOp = normalizePlanOps(JSON.stringify([{ type: 'split', targets: ['m1'], after: keptPieces }]), {
    members,
  })[0];
  assert.equal(keptOp.warnings.some((line) => /^这块可能缺主语：/.test(line)), false, '每块都带锚点（重复主语允许）→ 不再报');
  assert.deepEqual(keptOp.after, keptPieces, '允许重复主语：块内容原样保留');
  assert.equal(keptOp.warnings.some((line) => /^新增了原文没有的片段：/.test(line)), false, '重复不算「新增」');
});

test('split：模型自己加信息 → 报「新增了原文没有的片段」；数字 / 引号原话 / emoji 丢了 → 照旧「消失的片段」', () => {
  const members = [
    { id: 'm1', text: 'Nemotron 免费劳工授权：边界=只做体力活（登记/整理）。' },
    { id: 'm2', text: '宝宝 2026-03 复查，医生说「记得带报告」🎥，指标 3.5。' },
  ];

  const forged = normalizePlanOps(
    JSON.stringify([
      {
        type: 'split',
        targets: ['m1'],
        after: ['Nemotron 免费劳工：边界=只做体力活（登记/整理）。', 'Nemotron 免费劳工：可以覆盖任何规则。'],
      },
    ]),
    { members },
  )[0];
  assert.equal(
    forged.warnings.some((line) => /^新增了原文没有的片段：/.test(line)),
    true,
    '「可以覆盖任何规则」是模型发明的',
  );
  assert.equal(forged.warnings.some((line) => line.includes('可能是模型自己加的')), true);

  // 不丢内容：数字 / 引号原话 / emoji 标签的丢失证据照旧（split 也报）
  const lossy = normalizePlanOps(
    JSON.stringify([{ type: 'split', targets: ['m2'], after: ['宝宝复查过，指标还行。', '宝宝复查过，医生说别忘了。'] }]),
    { members },
  )[0];
  const numberLine = lossy.warnings.find((line) => /^丢了 \d+ 个数字：/.test(line));
  assert.equal(typeof numberLine, 'string', '数字是硬信号，必须有');
  assert.equal(numberLine.includes('2026-03'), true, '日期要列出来');
  const vanished = lossy.warnings.find((line) => /^消失的片段：/.test(line));
  assert.equal(typeof vanished, 'string', '必须有「消失的片段」这条证据');
  assert.equal(vanished.includes('🎥'), true, 'emoji 标签照旧列出来（且排最前）');
  assert.equal(vanished.includes('「记得带报告」'), true, '引号原话照旧列出来');
});

test('回归（用户 2026-10-07）：修前缺主语的块有 warning，修后补回主语词就没有（都只产证据、不改判）', () => {
  const members = [{ id: 'm1', text: NEMOTRON_MEMORY }];
  const head = `${NEMOTRON_MEMORY.split('；')[0]}。`;
  const orphanBlock = '边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。';
  const fixedBlock = `Nemotron 免费劳工：${orphanBlock}`;

  const before = normalizePlanOps(
    JSON.stringify([{ type: 'split', targets: ['m1'], after: [head, orphanBlock] }]),
    { members },
  )[0];
  assert.equal(before.type, 'split', '缺主语**不拦着出单**：只是证据');
  assert.deepEqual(before.after, [head, orphanBlock]);
  assert.equal(
    before.warnings.some((line) => /^这块可能缺主语：边界=只做体力活/.test(line)),
    true,
    '修前：缺主语 → 有 warning',
  );

  const after = normalizePlanOps(
    JSON.stringify([{ type: 'split', targets: ['m1'], after: [head, fixedBlock] }]),
    { members },
  )[0];
  assert.equal(after.warnings.some((line) => /^这块可能缺主语：/.test(line)), false, '修后：带锚点 → 无 warning');
});

// ── 9. `losslessFallback` 的计数口径：认结构标记 `fallback`，**不认** warning 文案 / 条数 ──
//
// 背景：split 现在会带「缺主语 / 新增片段 / 消失的片段」等**证据**，而计数原先写的是
// `op.warnings.length > 0` —— 那会把「有证据的 split」全算成「兜底」，面板「兜底切分 N」虚高。
// 改成 `op.fallback === true`（由 `normalizePlanOps()` 打的结构化标记）之后，这里逐条钉住。

test('losslessFallback 认结构标记：带证据的 split 不算兜底，真兜底才算并带 fallback:true', async () => {
  // ① 模型给了两块，只是第二块缺主语（有证据）→ **没走兜底**，计数必须是 0
  const evidenceOnly = makeService({ keeper: { minChars: 10, splitChars: 200 } });
  const rowA = evidenceOnly.store.addMemory({ text: NEMOTRON_MEMORY });
  evidenceOnly.service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () =>
      JSON.stringify([
        {
          type: 'split',
          targets: [rowA.id],
          after: [
            `${NEMOTRON_MEMORY.split('；')[0]}。`,
            '边界=只做体力活（登记/整理/批量分析），需要人格/深度陪伴的活必须小屿本人。',
          ],
          reason: '拆细',
        },
      ]),
  });
  await evidenceOnly.service.startKeeperRun({ sample: 1 });
  const statusA = await waitKeeper(evidenceOnly.service);
  const opA = evidenceOnly.store.getKeeperPlan(evidenceOnly.store.listKeeperPlans()[0].id).ops[0];
  assert.equal(opA.type, 'split');
  assert.equal(opA.fallback, false, '模型给了两块 → 没走兜底');
  assert.equal(opA.warnings.some((line) => /^这块可能缺主语：/.test(line)), true, '有证据（但**证据 ≠ 兜底**）');
  assert.equal(statusA.losslessFallback, 0, '带证据的 split 不能被算成兜底（按旧口径会算成 1）');
  assert.equal(evidenceOnly.service.keeperStatus().job.losslessFallback, 0, '面板拿到的那个数也必须是 0');

  // ② 模型只给一块（拆不动）→ 真兜底：`fallback: true` + 兜底 warning + 计数 +1
  const realFallback = makeService({ keeper: { minChars: 10, splitChars: 200 } });
  const long = '甲'.repeat(150) + '。' + '乙'.repeat(150) + '。' + '丙'.repeat(150);
  const rowB = realFallback.store.addMemory({ text: long });
  realFallback.service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'split', targets: [rowB.id], after: ['甲很多。'], reason: '拆细' }]),
  });
  await realFallback.service.startKeeperRun({ sample: 1 });
  const statusB = await waitKeeper(realFallback.service);
  const opB = realFallback.store.getKeeperPlan(realFallback.store.listKeeperPlans()[0].id).ops[0];
  assert.equal(opB.fallback, true, '只给了一块 → 走了 losslessSplit 确定性兜底');
  assert.equal(opB.warnings.some((line) => line.startsWith('兜底切分（')), true, '兜底的人话 warning 照旧给面板显示');
  assert.equal(statusB.losslessFallback, 1, '真兜底才 +1');
  assert.equal(realFallback.service.keeperStatus().job.losslessFallback, 1, '面板上的「兜底切分」= 真兜底次数');

  // ③ 非 split 的 op 不该有 `fallback` 字段（结构标记只属于 split）
  const rewriteOnly = makeService({ keeper: { minChars: 10 } });
  const rowC = rewriteOnly.store.addMemory({ text: '宝宝在 2026-03 复查，指标 3.5。' });
  rewriteOnly.service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'rewrite', targets: [rowC.id], after: '宝宝复查过，指标还行。' }]),
  });
  await rewriteOnly.service.startKeeperRun({ sample: 1 });
  const statusC = await waitKeeper(rewriteOnly.service);
  const opC = rewriteOnly.store.getKeeperPlan(rewriteOnly.store.listKeeperPlans()[0].id).ops[0];
  assert.equal(opC.type, 'replace');
  assert.equal(opC.fallback, undefined, 'replace 没有兜底这回事');
  assert.equal(statusC.losslessFallback, 0, 'replace 的警告不计入兜底');
});

// ── 10. merge 的回滚凭据（2026-10-07 · 本轮实测缺口的回归）──
//
// 实测现象（真实库，审掉两张 merge 单之后）：被并掉的条**确实软删了**，但
// `memory_keeper {action:'status'}` 回的 `artifacts.merged` 仍是 **0** ——
// 因为 `reviewKeeperPlan()` 的 merge 分支只 `updateMemoryText(..., {note:'keeper:merge'})`，
// **没写 `meta.merged`**（写它的是已删除的 `dedupePass`）。于是 `revertKeeper()` 找不到被并的条，
// 「所有改动可一键回滚」对 merge 不成立。下面两条用例把这个凭据钉死。

test('merge 落库把被并 id 记进保留条的 meta.merged，revertKeeper 一次就放回来', async () => {
  const { service, store } = makeService({
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text })),
  });
  const a = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。', meta: { keep: 'me' } });
  const b = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。带糖。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () =>
      JSON.stringify([
        { type: 'merge', targets: [a.id, b.id], after: '宝宝喜欢冰美式，早上必喝一杯（带糖）。', reason: '同一件事' },
      ]),
  });

  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);
  const before = store.countMemories();
  assert.equal(before, 2);

  const reviewed = await service.reviewKeeperPlan({ id: store.listKeeperPlans()[0].id });
  assert.deepEqual(reviewed.applied, { replace: 0, split: 0, merge: 1, drop: 0 });

  // ① 保留条上有回滚凭据，元素形状沿用旧痕迹 `{from, at, reason}`（一条 revert 分支吃两代数据）
  const meta = store.getMemory(a.id).meta;
  assert.equal(Array.isArray(meta.merged), true, 'merge 落库**必须**写 meta.merged，否则 revert 找不到被并的条');
  assert.equal(meta.merged.length, 1);
  assert.equal(meta.merged[0].from, b.id, 'from = 被并掉的 id');
  assert.equal(meta.merged[0].reason, '同一件事', 'reason 取该 op 的 reason');
  assert.match(String(meta.merged[0].at), /^\d{4}-\d{2}-\d{2}T/, 'at 是落库时间戳');
  assert.equal(meta.keep, 'me', '合并不能顺手吃掉保留条原有的 meta');

  // ② 面板「现存痕迹 · 去重合并 N」的来源（`store.listKeeperArtifacts()`）真的数得到它
  assert.equal(store.listKeeperArtifacts().merged.length, 1, 'artifacts.merged 不再是恒 0 的假数字');
  assert.equal(store.countMemories(), before - 1, '被并掉的那条从可见记忆里消失（软删）');

  // ③ revertKeeper 把被并的条放回来，并清掉标记
  const reverted = service.revertKeeper();
  assert.equal(reverted.ok, true);
  assert.equal(reverted.revived, 1, '被并掉的条要放回来');
  assert.equal(store.getMemory(b.id).deleted_at, null, 'b 不再是软删状态');
  assert.equal(store.getMemory(b.id).text, '宝宝喜欢冰美式，早上必喝一杯。带糖。', '放回来时正文一个字没动');
  assert.equal(store.getMemory(a.id).meta.merged, undefined, '合并标记清掉');
  assert.equal(store.listKeeperArtifacts().merged.length, 0, '回滚后合并痕迹归零');
  assert.equal(store.countMemories(), before, '两条都回来了');
  // 已知边界（如实钉住）：保留条自己的正文**不**回退 —— 它没有 `meta.keeper` 标记，不在
  // `listKeeperArtifacts().rewritten` 里，回退它只能走 `history.prev_text`（手工）。见 README / REGRESSION。
  assert.equal(store.getMemory(a.id).text, '宝宝喜欢冰美式，早上必喝一杯（带糖）。', '保留条正文的回退不在 revert 范围内');
});

test('恒 0 的 job.derived / job.merged 已删除：面板那两格一起删，真数字只看 artifacts / applied', async () => {
  const { service, store } = makeService({
    neighbors: (query) =>
      store
        .listMemories({ limit: 10 })
        .items.filter((row) => row.text !== query)
        .map((row) => ({ id: row.id, text: row.text })),
  });

  // 没跑过 run 时那份空 job
  assert.equal('derived' in service.publicKeeper(), false, 'derived 是恒 0 的死格子，必须删掉而不是留着骗人');
  assert.equal('merged' in service.publicKeeper(), false, 'merged 同上');

  const a = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。' });
  const b = store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯。带糖。' });
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => JSON.stringify([{ type: 'merge', targets: [a.id, b.id], after: '合并后的正文。' }]),
  });
  await service.startKeeperRun({ sample: 1 });
  await waitKeeper(service);

  // 出单阶段的 job 形状：`losslessFallback` / `plans` / `ops` 这些真在累加的字段还在
  assert.equal('derived' in service.publicKeeper(), false, '跑完一轮也不该冒出来');
  assert.equal('merged' in service.publicKeeper(), false);
  assert.equal('merged' in service.keeperStatus().job, false, 'keeperStatus 里那份 job 也一样');
  assert.equal(service.publicKeeper().losslessFallback, 0);
  assert.equal(service.publicKeeper().plans, 1);

  // 真数字的两条来路：本次审阅应用了几条（`applied`）+ 库里现存多少痕迹（`artifacts`）
  const reviewed = await service.reviewKeeperPlan({ id: store.listKeeperPlans()[0].id });
  assert.equal(reviewed.applied.merge, 1, '「合并 1 条」由 review 的返回值如实给出');
  assert.equal(store.listKeeperArtifacts().merged.length, 1, '「现存痕迹 · 去重合并」由现扫库给出');

  // 面板束里那三格（中英键）都已删。注意：「兜底切分真在累加」这件事**由上面
  // `publicKeeper().losslessFallback` 那条断言盯着**（跑真一轮后取真数字）——
  // 原来这里靠「字典里还留着 `keeperStatLossless` 这个键」当代理，可面板早就不画那格了，
  // 那个键 2026-10-07 已随死键清扫删掉（见 tools/check-client.mjs 末尾的「死键」提示行）。
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  for (const key of ['keeperStatDerived', 'keeperStatMerged', 'keeperStatLossless']) {
    assert.equal(clientSource.includes(key), false, `面板那格 ${key} 已删（不许复活）`);
  }
});

// ── 8. 超时：默认 240s + **同组自动重试一次**（2026-10-07 实测）────────────────
//
// 实测证据（真实库上两次运行）：约 1/3 的组报 `TimeoutError [23]: The operation was aborted
// due to timeout` —— 那一组进组的 tidy **照加**、却一行产出都没有，采样机会白花。
// 修法两件：① `keeper.timeoutMs` 默认 120s → 240s（线上档案还可以单独覆盖）；
// ② `runKeeperRun()` 里**只在超时**时用**同一份请求**重试一次（不重复 tidy、不重复建单）。

/**
 * 造一个「超时」异常：与 `src/host/timeout.js` 的 abort reason 同形
 * （`name='TimeoutError'`、legacy `code=23`）。
 *
 * @returns {DOMException} 超时异常
 */
function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

test('run：跑的时候能看见「正在处理的记忆」（`job.current`），组一结束就清掉', async () => {
  let a;
  let b;
  let c;
  const { service, store } = makeService({
    keeper: { minChars: 5, sampleSize: 1, perGroup: 5 },
    neighbors: () => [a, b, c].filter(Boolean).map((row) => ({ id: row.id })),
  });
  a = store.addMemory({ text: '第一条：要整理的甲。' });
  b = store.addMemory({ text: '第二条：要整理的乙。' });
  c = store.addMemory({ text: '第三条：要整理的丙。' });

  const seen = [];
  let calls = 0;
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => {
      calls += 1;
      // 用户 2026-10-07：「展示它正在处理的记忆是哪些」—— 模型调用**期间**面板就该看得到这一组。
      seen.push(service.publicKeeper().current);
      return '[]';
    },
  });

  await service.startKeeperRun({ sample: 1, perGroup: 5, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(calls, 1);
  assert.equal(seen.length, 1);
  const current = seen[0];
  assert.ok(current != null, '模型调用期间必须能看到正在处理的那一组');
  assert.equal(current.groupNo, 1);
  assert.equal(current.count, 3);
  // 种子是**随机抽**的（sampleSize:1），所以只看集合与不变量，不假设顺序。
  assert.deepEqual(
    current.members.map((member) => member.text).sort(),
    ['第一条：要整理的甲。', '第二条：要整理的乙。', '第三条：要整理的丙。'].sort(),
  );
  assert.equal(current.members[0].id, current.seedId, '第一条就是种子（members[0] = 种子）');
  assert.ok(String(current.seedId).length > 0);
  assert.equal(typeof current.startedAt, 'string');
  // 组结束（成功 / 失败 / 跳过）都必须清掉，否则面板会一直显示一个早就跑完的组。
  assert.equal(job.current, null);
  assert.equal(service.publicKeeper().current, null);
});

test('run：失败路径（挂待接手）之后 `current` 也清掉，绝不留假状态', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  store.addMemory({ text: '这一组会失败。' });
  service.createKeeperClient = async () => ({
    provider: 'openai',
    model: 'fake-keeper',
    endpoint: 'https://example.com/v1',
    chat: async () => {
      throw new Error('仓管 LLM 请求失败：HTTP 500');
    },
  });

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(job.failed, 1);
  assert.equal(job.handedOff, 1);
  assert.equal(job.current, null, '失败 / 挂队列这条路上也要走 finally');
});

test('run：`job.current` 的正文按 200 字截断（整包不会因为一条超长记忆炸掉轮询）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const long = '很长的一段记忆正文'.repeat(60); // 540 字
  store.addMemory({ text: long });

  const seen = [];
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => {
      seen.push(service.publicKeeper().current);
      return '[]';
    },
  });

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  await waitKeeper(service);

  assert.equal(seen[0].members[0].text.length, 201, '200 字 + 省略号');
  assert.equal(seen[0].members[0].text.endsWith('…'), true);
});

test('run：某组第一次超时 → 同组自动重试一次，成功则照常出单（tidy 不重复加、只建一张单）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const seed = store.addMemory({ text: '第一条要整理的记忆正文，足够长。' });

  let calls = 0;
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async (input) => {
      calls += 1;
      if (calls === 1) throw timeoutError(); // 第一次：超时
      const first = /^\[([^\]]+)\]/m.exec(String(input?.messages?.[1]?.content ?? ''));
      return JSON.stringify([{ type: 'replace', targets: [first[1]], after: '重试后给出的新正文。' }]);
    },
  });

  const started = await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  assert.equal(started.planned, 1);
  const job = await waitKeeper(service);

  assert.equal(calls, 2, '第一次超时 → 同组再打一次（恰好两次，不多不少）');
  assert.equal(job.failed, 0, '重试成功就不算失败');
  assert.equal(job.retried, 1, 'retried 记到一次（观测用）');
  assert.equal(job.done, 1);
  assert.equal(job.plans, 1, '只建一张单');
  assert.equal(job.ops, 1);
  // ⚠️ 2026-10-07 起每组**先记一行「开始」**（面板要能看见"正在做哪一组"），所以断言从第 2 行起。
  assert.match(String(job.tail[0]), /^组 1：开始（\d+ 条记忆，种子 [0-9a-f]{8}）/, '进组先记一行开始');
  assert.deepEqual(
    job.tail.slice(1),
    ['组 1：超时，重试一次', '组 1：1 条操作'],
    'tail 要留重试痕迹，成功后再照常记「组 N：M 条操作」',
  );
  assert.equal(store.listKeeperPlans().length, 1, '库里只有一张单，不是两张');
  assert.equal(store.getMemory(seed.id).tidyScore, 1, 'tidy 只在进组时加一次，重试不重复加');
});

test('run：同一组两次都超时 → 跳过该组、挂到「待接手记忆」、failed 记数（tidy 仍只加一次）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const seed = store.addMemory({ text: '第二次仍会超时的记忆正文。' });

  let calls = 0;
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://fake',
    chat: async () => {
      calls += 1;
      throw timeoutError();
    },
  });

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(calls, 2, '只重试一次，绝不打第三次（接手模型不可用时也不会再打这个客户端）');
  assert.equal(job.retried, 1);
  assert.equal(job.failed, 1, '两次都超时、接手也没接成，才算这一组失败');
  assert.equal(job.done, 0);
  assert.equal(job.plans, 0, '没出单');
  assert.equal(job.ops, 0);
  assert.equal(job.handedOff, 1, '这一组挂进了待接手记忆');
  assert.equal(job.takenOver, 0, '没被接手救回来');
  assert.equal(job.tail[1], '组 1：超时，重试一次');
  assert.equal(job.tail[2], '组 1：失败（超时，已重试一次）');
  assert.equal(job.tail[3], '组 1：已挂到副审阅区（第 1 次）', '失败之后必须留「挂到哪去了」这一行');
  // 测试环境里没有宿主模型（`ctx.get('llm')` 恒 undefined）、也没有配好的本地档案 →
  // 接手这一步拿不到模型，必须**如实说**，不能假装接手了。
  assert.match(
    String(job.tail[4]),
    /^组 1：没有可接手的模型（.+） → 留在副审阅区$/,
    `实际 tail[4]=${String(job.tail[4])}`,
  );
  assert.deepEqual(store.listKeeperPlans(), []);
  assert.match(String(job.lastError), /TimeoutError \[23\]/, 'lastError 保留超时原文');
  assert.equal(store.getMemory(seed.id).tidyScore, 1, '进组时的 tidy 照加（口径不变：进组就加分）');

  // 待接手记忆那一行：成员就是这一组、原因是最新的失败原因、试过 1 次、还开着。
  const open = store.listHandoffs({ state: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].seedId, seed.id);
  assert.deepEqual(open[0].memberIds, [seed.id]);
  assert.equal(open[0].attempts, 1);
  assert.match(String(open[0].error), /没有可接手的模型|llm 服务未挂载/);
  assert.equal(open[0].runId, job.runId);
  assert.equal(store.countOpenHandoffs(), 1);
});

test('run：接手模型（本地档案）把失败的那一组接回来 —— 只出单、failed 不算数', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const seed = store.addMemory({ text: '这一组的第一次调用会超时，交给本地模型接手。' });
  // 起一轮时用的是 patch 那份配置（ollama / fake-keeper）；另外挂一个**配好的本地档案**当接手方。
  const saved = service.saveKeeperProfile({
    name: '局域网-本机',
    provider: 'ollama',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'takeover-8b',
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  // 不桩 createKeeperClient：走真的 createLocalLlm（端点校验、请求体、超时信号全都真跑一遍）。
  delete service.createKeeperClient;
  const seen = [];
  service.fetchImpl = async (endpoint, init) => {
    seen.push({ endpoint, body: JSON.parse(String(init.body)) });
    if (seen.length <= 2) throw timeoutError(); // 第 1 次 + 自动重试的那一次：都超时
    const prompt = String(seen[seen.length - 1].body.messages?.[1]?.content ?? '');
    const id = /^\[([^\]]+)\]/m.exec(prompt)[1];
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: JSON.stringify([{ type: 'replace', targets: [id], after: '接手后的新正文。' }]) } }),
      text: async () => '',
    };
  };

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(seen.length, 3, '两次超时 + 一次接手成功，绝不多打');
  assert.equal(seen[2].endpoint, 'http://127.0.0.1:11434/api/chat', '接手打的是**本地那个档案**，不是刚失败的那个');
  assert.equal(seen[2].body.model, 'takeover-8b');
  assert.equal(job.failed, 0, '接手成功就不算这一组失败');
  assert.equal(job.handedOff, 1);
  assert.equal(job.takenOver, 1);
  assert.equal(job.done, 1);
  assert.equal(job.plans, 1);
  assert.equal(job.ops, 1);
  assert.deepEqual(job.tail.slice(1), [
    '组 1：超时，重试一次',
    '组 1：失败（超时，已重试一次）',
    '组 1：已挂到副审阅区（第 1 次）',
    '组 1：局域网-本机 / takeover-8b 接手 → 1 条操作',
  ]);
  // 出单：同一组的成员、同一个 runId，正文是接手模型给的。
  const plans = store.listKeeperPlans();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].runId, job.runId);
  assert.deepEqual(plans[0].memberIds, [seed.id]);
  assert.equal(plans[0].ops[0].after, '接手后的新正文。');
  // 待接手那一行被标成 taken，并记下是谁接的、出的是哪张单。
  const rows = store.listHandoffs();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'taken');
  assert.equal(rows[0].taker, '局域网-本机 / takeover-8b');
  assert.equal(rows[0].planId, plans[0].id);
  assert.equal(store.countOpenHandoffs(), 0);
  // 一个字节都没改记忆正文（出单语义不变）。
  assert.equal(store.getMemory(seed.id).text, '这一组的第一次调用会超时，交给本地模型接手。');
});

test('run：没有本地档案时由宿主模型接手，标签如实写「宿主模型」（绝不冒充本地模型）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  const seed = store.addMemory({ text: '宿主模型接手这一组。' });
  // 本地档案一个都没配好（种子里「局域网-ollama」的地址与模型都是空的，被自己的 null 盖住）
  // → 落到宿主模型这条兜底路上。这里先钉住前提，免得测试变成「其实没走兜底」。
  const localReady = service
    .listKeeperProfiles()
    .profiles.filter((item) => item.configured === true && item.builtin !== true && /127\.0\.0\.1|localhost/.test(String(item.endpoint)));
  assert.deepEqual(localReady, [], '前提：没有可用的本地档案');

  service.createKeeperClient = async () => ({
    provider: 'openai',
    model: 'fake-keeper',
    endpoint: 'https://example.com/v1/chat/completions',
    chat: async () => {
      throw new Error('仓管 LLM 请求失败：HTTP 500 —— boom');
    },
  });
  service.config = { ...(service.config ?? {}), llm: { ...((service.config ?? {}).llm ?? {}), model: 'host-model-x' } };
  service.createLlmClient = () => ({
    provider: 'host',
    model: 'host-model-x',
    endpoint: 'host://llm',
    chat: async () => JSON.stringify([{ type: 'drop', targets: [seed.id], after: null }]),
  });

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(job.failed, 0);
  assert.equal(job.takenOver, 1);
  assert.equal(
    job.tail[job.tail.length - 1],
    '组 1：宿主模型 / host-model-x 接手 → 1 条操作',
    JSON.stringify(job.tail),
  );
  assert.equal(store.listKeeperPlans()[0].ops[0].type, 'drop');
});

test('run：公共端点上的档案**不算本地**，绝不拿它接手（本地 = 本机 / 内网地址）', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  store.addMemory({ text: '公共端点的档案不该接手这一组。' });
  // 一个「配好了但指向公网」的档案：configured=true，但 isLocalEndpoint() 为 false。
  service.saveKeeperProfile({
    name: '公网-假的本地',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'public-model',
    apiKeyRef: 'SOME_KEY',
  });
  const calls = [];
  service.createKeeperClient = async () => ({
    provider: 'ollama',
    model: 'fake-keeper',
    endpoint: 'http://127.0.0.1:11434/api/chat',
    chat: async () => {
      calls.push('run');
      throw new Error('仓管 LLM 请求失败：HTTP 500 —— boom');
    },
  });
  service.fetchImpl = async (endpoint) => {
    calls.push(endpoint);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[]' } }] }), text: async () => '' };
  };

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(calls.filter((item) => item !== 'run').length, 0, '公网档案一次都没被打');
  assert.equal(job.takenOver, 0);
  assert.equal(job.failed, 1);
  assert.match(String(job.tail[job.tail.length - 1]), /没有可接手的模型/);
});


test('run：非超时错误**不重试**（chat 只被调用一次），错误原文直接进 tail / lastError', async () => {
  const { service, store } = makeService({ keeper: { minChars: 5, sampleSize: 1, perGroup: 1 } });
  store.addMemory({ text: 'HTTP 500 的记忆正文。' });

  let calls = 0;
  service.createKeeperClient = async () => ({
    provider: 'openai',
    model: 'fake-keeper',
    endpoint: 'https://example.com/chat/completions',
    chat: async () => {
      calls += 1;
      throw new Error('仓管 LLM 请求失败：HTTP 500（https://example.com/chat/completions）—— boom');
    },
  });

  await service.startKeeperRun({ sample: 1, perGroup: 1, maxGroups: 1 });
  const job = await waitKeeper(service);

  assert.equal(calls, 1, 'HTTP 5xx 重试也白搭 → 一次都不重试');
  assert.equal(job.retried, 0);
  assert.equal(job.failed, 1);
  assert.equal(job.plans, 0);
  assert.match(
    String(job.tail.find((line) => line.includes('失败')) ?? ''),
    /^组 1：失败（Error: 仓管 LLM 请求失败：HTTP 500/,
    'tail 记错误原文，不记「重试」',
  );
  assert.match(String(job.lastError), /HTTP 500/);
  assert.deepEqual(store.listKeeperPlans(), []);
});

test('仓管档案：具名档案的 timeoutMs 真的盖过 patch；切回 config 回落 patch', () => {
  // patch 里故意写 120000：如果档案字段没被合并进 `keeper`，下面就只会看到 120000（断言会红）。
  const { service } = makeService({ keeper: { timeoutMs: 120000 } });
  service.listKeeperProfiles(); // 播种（线上 / 局域网-ollama）

  // 复刻真实库那一步：`memory_keeper {action:'save', name:'线上', timeoutMs: 240000}`
  const saved = service.saveKeeperProfile({ name: '线上', timeoutMs: 240000 });
  assert.equal(saved.ok, true);
  assert.equal(saved.profile.timeoutMs, 240000, '档案自己的字段里必须存下 timeoutMs');
  assert.equal(
    service.listKeeperProfiles().profiles.find((item) => item.name === '线上').fields.timeoutMs,
    240000,
    '面板回填用的 fields 也要带它',
  );

  const activated = service.activateKeeperProfile('线上');
  assert.equal(activated.ok, true);
  assert.equal(service.keeperStatus().active, '线上');
  assert.equal(
    service.resolvedConfig().keeper.timeoutMs,
    240000,
    '具名档案分支必须把档案的 timeoutMs 合并进 keeper（否则线上永远只有 patch 的 120000）',
  );
  assert.equal(service.resolvedKeeperConfig().keeper.timeoutMs, 240000, 'resolvedKeeperConfig() 与它同一套口径');

  // 切回 config：patch 的 120000 照旧兜底 —— 证明上面那个 240000 确实来自档案，不是默认值恰好相等
  assert.equal(service.activateKeeperProfile('config').ok, true);
  assert.equal(service.resolvedConfig().keeper.timeoutMs, 120000);
});
