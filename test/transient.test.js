/**
 * 事实三分类器测试（`src/host/transient.js`）。
 *
 * 这一组用例的重点**不是**「能丢多少」，而是**别误杀长期事实**：
 * 2026-10-07 二分类 → 三分类的起因就是三条**真实误杀**（用户在库里点名的 3 条长期决定
 * 被旧的 `looksTransient()` 判成 `transient:true`、会被静默丢掉）—— 本文件第 1 组用例
 * 就是那 3 条**原样照抄真实库正文**的例子，逐条必须 `durable`。
 *
 * 三分类语义（判据与已知边界见 `transient.js` 文件注释）：
 * - `durable`：长期信号，**即使同时出现技术词也保留**；
 * - `transient`：纯会话 / 工具 / 进度态（没有长期事实主体）→ 丢；
 * - `uncertain`：拿不准 → **不丢**，交审阅。
 *
 * 纯函数、零依赖、不碰库、不调 LLM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { looksTransient, partitionTransient } from '../src/host/transient.js';

/**
 * 断言一批文本的三分类结论。
 *
 * @param {{text: string, verdict: 'durable'|'transient'|'uncertain'}[]} cases 用例
 * @returns {void}
 */
function assertVerdicts(cases) {
  for (const entry of cases) {
    const verdict = looksTransient(entry.text);
    assert.equal(
      verdict.verdict,
      entry.verdict,
      `${JSON.stringify(entry.text)} 期望 verdict=${entry.verdict}，实际 ${JSON.stringify(verdict)}`,
    );
    // uncertain **可以**带命中理由（例如「版本绑定:缺时间锚点」）—— 那是给审阅人看的证据，不是错误。
    if (entry.verdict !== 'uncertain') assert.ok(verdict.hit.length > 0, '判 transient / durable 时都必须给出命中理由');
  }
}

// ── 0. 误杀回归（本轮最重要）：用户点名的 3 条真实记忆必须 durable ────────────────
//
// 三条正文**照抄真实库**（`kind='auto'`）：旧分类器分别被 `工具协作态:变更单`、
// `工具协作态:待审区`、`当下状态:暂定` 命中 → `transient:true` → 静默丢掉。

test('防误杀（本轮最重要）：用户点名的 3 条被误杀的长期决定 → 必须 durable', () => {
  assertVerdicts([
    {
      text: '用户采纳了助手建议的四条语义：无损重写分逐字无损与保要点、过期只标注、按组出单可单条勾选、研磨或消化只出变更单不直接改库。',
      verdict: 'durable',
    },
    {
      text: '用户和助手约定仓管的所有改动先进入独立待审区，经 agent 或用户审阅通过后才真正改写记忆库。',
      verdict: 'durable',
    },
    {
      text: '用户决定记忆抽取暂定由自己手动启动，不定期进行一轮随机抽取。',
      verdict: 'durable',
    },
  ]);
});

test('长期信号即使带技术词也保留：变更单 / 待审区 / 验收 / 重启 / panel / 工具 单独出现不再构成 transient', () => {
  assertVerdicts([
    // 「变更单」是技术词，但 `采纳` 是长期决策 → 保留
    { text: '用户采纳了「只出变更单、不直接改库」这条语义。', verdict: 'durable' },
    // 「待审区」是技术词，但 `拍板 / 统一` 是长期决策 → 保留
    { text: '用户拍板统一了修改记忆的做法：新旧记忆进待审区，过审后才删除原记忆、录入新记忆。', verdict: 'durable' },
    // 「暂定」是弱规则状态词，但 `决定` 是长期决策 → 保留
    { text: '用户决定记忆抽取暂定由自己手动启动。', verdict: 'durable' },
    // 日期锚点
    { text: '宝宝 08-12 拍板：中栏方案乙', verdict: 'durable' },
    { text: '用户在 2026-10-07 定下长期基准：只出变更单', verdict: 'durable' },
  ]);
});

// ── 1. 长期事实负例（一条都不许杀）─────────────────────────────────────────────

test('长期事实负例（偏好 / 习惯 / 约定 / 身份 / 关系）→ durable', () => {
  assertVerdicts([
    { text: '用户喜欢冰美式', verdict: 'durable' },
    { text: '用户习惯凌晨睡', verdict: 'durable' },
    { text: '用户忌口香菜', verdict: 'durable' },
    { text: '用户的老家在绍兴', verdict: 'durable' },
    { text: '用户每年纪念日都去露营', verdict: 'durable' },
    { text: '小张是用户的同事，也是室友', verdict: 'durable' },
    { text: '用户养了一只叫团子的猫', verdict: 'durable' },
    { text: '用户和宝宝约定每年生日都一起拍一张合照', verdict: 'durable' },
    { text: '用户目前住在杭州，职业是产品经理', verdict: 'durable' },
  ]);
});

// ── 2. transient：每一类会话 / 工具 / 进度态各一例 ─────────────────────────────

test('transient：teammate / subagent / 子代理 这类工具协作态', () => {
  assertVerdicts([
    { text: '用户身边另有 teammate 在并行工作', verdict: 'transient' },
    { text: '用户身边有后台子代理在并行干活，子代理干完不一定留结束消息。', verdict: 'transient' },
    { text: '这个 subagent 正在跑回归，等它结束再改代码', verdict: 'transient' },
  ]);
});

test('transient：助手自身的立场与动作（主语是助手的自述）', () => {
  assertVerdicts([
    { text: '助手认为「效果好不好」这类判断只能由用户来做，它只负责交付真实样例供用户判断。', verdict: 'transient' },
    { text: '助手打算在子代理收敛后自己核验四件事，再把结果告诉用户。', verdict: 'transient' },
    { text: '我建议先把过滤器做成纯函数，方便单测。', verdict: 'transient' },
  ]);
});

test('transient：本次会话 / 这轮 / 接下来 / 待办清单 这类会话任务态', () => {
  assertVerdicts([
    { text: '本次会话先不动 Keeper 那块代码，只加过滤器', verdict: 'transient' },
    { text: '这轮先把提示词改完，代码下一轮再说', verdict: 'transient' },
    { text: '接下来还要把 README 的配置表补上', verdict: 'transient' },
    { text: '剩余待办：跑一遍全量测试、核对编码', verdict: 'transient' },
  ]);
});

test('transient：协作安排（约好用…流程 / 约定：清单）与进度汇报', () => {
  assertVerdicts([
    {
      text: '用户与助手约好用 propose 流程处理那条断在「08-14 宝宝自」的记忆：用户补上后半句，助手出一版方案，用户在待审区对比后决定是否通过。',
      verdict: 'transient',
    },
    { text: '用户与助手约定：先改代码再重启', verdict: 'transient' },
    { text: '约定：先改代码，再更新文档，最后跑测试', verdict: 'transient' },
    { text: '跑通了 265 例全量测试', verdict: 'transient' },
    { text: '已完成过滤器的实现', verdict: 'transient' },
    { text: '已实现按关键词丢临时事实', verdict: 'transient' },
  ]);
});

test('transient：正在 / 刚刚 / 目前 / 暂定 / 暂时 这类当下状态（无长期锚点时）', () => {
  assertVerdicts([
    { text: '正在把 lib/index.js 里的 runCapture 改掉', verdict: 'transient' },
    { text: '刚刚把提取提示词加了一段不要记清单', verdict: 'transient' },
    { text: '目前库里有 300 多条 kind=auto 的记忆', verdict: 'transient' },
    { text: '暂定明天再处理审阅那部分', verdict: 'transient' },
    { text: '暂时先不碰真实库', verdict: 'transient' },
  ]);
});

// ── 3. uncertain：拿不准 → 不丢、交审阅 ───────────────────────────────────────

test('uncertain：既非会话态句式、又无长期锚点（技术词单独出现的句子落在这里，而不是被丢掉）', () => {
  assertVerdicts([
    // 旧分类器把这两条判成 transient（命中 `待审区` / `变更单`）—— 现在技术词单独出现不再构成
    // transient，但它们也没有长期信号 → uncertain（进待审区等人看，绝不静默丢）
    { text: '这条事实现在还躺在待审区，等人点通过。', verdict: 'uncertain' },
    { text: '仓管为这组记忆出了一张变更单，还没审。', verdict: 'uncertain' },
    { text: '这次工具调用返回了 0 条结果。', verdict: 'uncertain' },
    { text: 'panel 上的那个开关改完要重新加载页面', verdict: 'uncertain' },
    { text: '过滤器已经写完，改完记得重启插件', verdict: 'uncertain' },
    { text: '资产清单里记录了 3 台服务器', verdict: 'uncertain' },
  ]);
});

// ── 3b. 版本绑定：会变的东西没有时间 / 版本锚点 → 一律 uncertain ────────────────
//
// 用户 2026-10-07 亲自点出这个危险：「用户日常只用四个页签」这类句子，将来读它的人（包括 agent）
// 会当成永久通则，而页签清单本身随时会变。更危险的是**它会命中长期信号**（要求 / 决定 / 偏好），
// 旧口径直接入库 —— 所以这条规则**排在长期信号之前、不受它豁免**。

test('版本绑定：界面结构 + 数量枚举，就算带长期信号也必须先经人眼（不许直存）', () => {
  assertVerdicts([
    // 用户当场指出的那条真实记忆（原文照抄）
    { text: '用户日常主要只用插件的四个页签：检索、仓管待审、待审、设置', verdict: 'uncertain' },
    // 下面三条都命中长期信号（要求 / 决定 / 偏好）—— 旧口径会**直接入库**，改版后就是假话
    { text: '用户要求面板只保留四个页签', verdict: 'uncertain' },
    { text: '用户决定以后界面只留三个按钮', verdict: 'uncertain' },
    { text: '用户偏好：记忆卡片只显示 2 行', verdict: 'uncertain' },
  ]);
});

test('版本绑定：命中理由可读（不是一句「uncertain」）', () => {
  assert.equal(looksTransient('用户要求面板只保留四个页签').hit, '版本绑定:缺时间锚点');
});

test('版本绑定：带上时间 / 版本锚点就放行（锚点是允许谈界面的前提，不是禁止谈）', () => {
  assertVerdicts([
    { text: '用户看面板的习惯（2026-10-07）：只看待处理与检索，不看仪表盘页', verdict: 'durable' },
    { text: '用户要求：截至 2026-10-07，界面只留三个入口', verdict: 'durable' },
    { text: '用户习惯：改版前那版面板有 6 个页签，他基本不看概览', verdict: 'durable' },
  ]);
});

test('版本绑定：不误伤 —— 没有数量枚举的句子照旧走原规则', () => {
  assertVerdicts([
    { text: '用户喜欢冰美式', verdict: 'durable' },
    { text: '用户习惯凌晨睡', verdict: 'durable' },
    // 「待办」在面板里是页面名：这句话是用户的用法习惯，不该被当成进度态丢掉
    { text: '用户习惯只看待办与检索页面', verdict: 'durable' },
    { text: '管理按钮改为按钮样式', verdict: 'uncertain' },
  ]);
});

// ── 4. 形状与批量 ─────────────────────────────────────────────────────────────

test('looksTransient：非字符串 / 空串一律放行（过滤器不为别的输入背锅）', () => {
  for (const value of ['', '   ', null, undefined, 42, {}, [], true]) {
    const verdict = looksTransient(value);
    assert.equal(verdict.verdict, 'durable', `${JSON.stringify(value)} 应当放行`);
    assert.equal(verdict.hit, '');
  }
});

test('partitionTransient：durable / transient / uncertain 三分桶，staged 保持原顺序', () => {
  const durable = '用户喜欢冰美式';
  const transient = '用户与助手约定：先改代码再重启';
  const uncertain = '这条事实现在还躺在待审区';
  const { kept, dropped, deferred, staged } = partitionTransient([
    durable,
    transient,
    uncertain,
    '用户习惯凌晨睡',
    42,
  ]);

  assert.deepEqual(kept, [durable, '用户习惯凌晨睡', 42], 'durable 与原顺序，非字符串原样留下');
  assert.deepEqual(dropped.map((entry) => entry.text), [transient]);
  assert.deepEqual(deferred.map((entry) => entry.text), [uncertain]);
  assert.deepEqual(staged, [durable, uncertain, '用户习惯凌晨睡', 42], 'staged = durable + uncertain 的原顺序合并');
  for (const entry of dropped) assert.ok(entry.hit.length > 0, '每条丢掉的都要能说出命中理由');
});

test('partitionTransient：staged = durable + uncertain，且保持**原顺序**；transient 不进 staged', () => {
  const { staged, dropped } = partitionTransient([
    '这条事实现在还躺在待审区', // uncertain（第 1）
    '用户与助手约定：先改代码再重启', // transient → 丢
    '用户喜欢冰美式', // durable（第 3）
    '仓管出了一张变更单', // uncertain（第 4）
  ]);

  assert.deepEqual(staged, ['这条事实现在还躺在待审区', '用户喜欢冰美式', '仓管出了一张变更单']);
  assert.deepEqual(dropped.map((entry) => entry.text), ['用户与助手约定：先改代码再重启']);
});

test('partitionTransient：空数组 / 非数组输入不抛错', () => {
  assert.deepEqual(partitionTransient([]), { kept: [], dropped: [], deferred: [], staged: [] });
  assert.deepEqual(partitionTransient(null), { kept: [], dropped: [], deferred: [], staged: [] });
  assert.deepEqual(partitionTransient('不是数组'), { kept: [], dropped: [], deferred: [], staged: [] });
});
