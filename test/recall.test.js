/**
 * 读取侧注入测试（Layer 0 常驻索引 + Layer 1 按需召回）。
 *
 * 这里钉的都是**确定性 + 只读**这两条底线：
 *   * 同一份库 + 同一个版本号 → 同一段文本（排序不抖，前缀缓存才稳）；
 *   * 注入**一个字都不写库**（跑了注入前后，条数与正文必须一模一样）；
 *   * 同步（不起 embedding、不发网络请求）—— 单测里根本没有网络可用，跑通本身就证明这一点。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/host/db.js';
import { MemoryStore } from '../src/host/store.js';
import {
  RecallEngine,
  buildIndexBlock,
  buildRecallBlock,
  clipLine,
  cohesion,
  contentDate,
  pickTerms,
} from '../src/host/recall.js';
import { cleanupTmpDir, freshTmpDir, makeClock } from './util.js';

const TMP = freshTmpDir('recall');

after(() => cleanupTmpDir(TMP));

/** 造一个内存库 + 固定时钟的 store（与 store.test.js 同款）。 */
function makeStore() {
  const db = openDatabase(':memory:');
  return { store: new MemoryStore(db, { now: makeClock() }), db };
}

/** 默认打开的 recall 配置（最小版：8 槽索引 / 6 槽召回 / 60 字一行）。 */
function makeCfg(overrides = {}) {
  return {
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
    ...overrides,
  };
}

/** 一条假候选（假 store 用）。 */
function row(id, text, extra = {}) {
  return { id, text, kind: 'auto', source: '自主捕获', readScore: 0, createdAt: '2026-10-07T00:00:00.000Z', ...extra };
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────

test('clipLine：先取第一个句子，再按字数硬截（换行压平、开头的标记去掉）', () => {
  assert.equal(clipLine('宝宝喜欢冰美式。后面这句不该出现。'), '宝宝喜欢冰美式。');
  assert.equal(clipLine('\n# 标题\n正文'), '标题 正文');
  assert.equal(clipLine('长'.repeat(80), 20), `${'长'.repeat(19)}…`);
  assert.equal(clipLine('短句', 60), '短句');
});

test('contentDate：正文里的日期优先，没有才用入库时间（本库 created_at 全是导入时间）', () => {
  assert.equal(contentDate('（08-21 宝宝说的）', '2026-10-07T00:00:00.000Z'), '08-21');
  assert.equal(contentDate('定案于 2026-03-14 那天', '2026-10-07T00:00:00.000Z'), '2026-03-14');
  assert.equal(contentDate('没有任何日期', '2026-10-07T00:00:00.000Z'), '2026-10-07');
  assert.equal(contentDate('没有日期也没有入库时间'), '');
});

test('pickTerms：CJK 取 bigram、ASCII 取词，去停用词、按长度降序', () => {
  const terms = pickTerms('宝宝喜欢喝 冰美式 coffee 吗');
  assert.ok(terms.includes('coffee'), 'ASCII 词要进来');
  assert.ok(terms.includes('冰美'), 'CJK bigram 要进来');
  assert.ok(!terms.includes('的吗'), '停用词要滤掉');
  assert.equal(pickTerms('宝宝喜欢喝冰美式咖啡', 3).length, 3, '限量生效');
});

test('cohesion：没有基准时不判切换；完全不相干时接近 0', () => {
  assert.equal(cohesion(new Set(), new Set(['冰美'])), 1);
  assert.ok(cohesion(new Set(['冰美', '美式']), new Set(['部署', '署用'])) === 0);
});

// ── Layer 0：常驻索引 ─────────────────────────────────────────────────────────

test('buildIndexBlock：人写的/旧基线/pin 先占槽，其余按 read_score 补，【约定】与【事实】分开', () => {
  const pinned = [row('p1', '改库唯一入口是 reviewKeeperPlan，这是硬约定', { kind: 'manual', source: '手动写入' })];
  const recent = [
    row('r1', '宝宝喜欢冰美式，早上必喝一杯，带糖', { readScore: 3 }),
    row('r2', '项目 dsh-memory 的面板分四页：仓管 / 副仓管 / 搜索 / 设置', { readScore: 1 }),
  ];
  const built = buildIndexBlock({ pinned, recent, total: 1356, slots: 3, pinnedCap: 4, charLimit: 60 });
  assert.equal(built.ids.length, 3, '三个槽都填满');
  assert.equal(built.ids[0], 'p1', 'pinned 排第一');
  assert.ok(built.lines[0].startsWith('【约定】'), '含"唯一/约定"的进【约定】组');
  assert.ok(built.lines[1].startsWith('【事实】'), '陈述句进【事实】组');
  const entryLines = built.lines.filter((line) => !line.startsWith('（'));
  assert.ok(entryLines.every((line) => line.includes('[mem#')), '每条记忆都带可回指的编号');
  assert.ok(built.lines.at(-1).includes('库里共 1356 条'), '「截断要可见」：说清只放了几条');
});

test('buildIndexBlock：8 字以下 / 200 字以上 / meta.excludeFromIndex 的都不进索引', () => {
  const recent = [
    row('short', '太短了'),
    row('long', '长'.repeat(201)),
    row('hidden', '这条被显式排除在索引之外，不该出现', { meta: { excludeFromIndex: true } }),
    row('ok', '这条长度合适，应该进索引'),
  ];
  const built = buildIndexBlock({ pinned: [], recent, total: 4, slots: 8, pinnedCap: 4, charLimit: 60 });
  assert.deepEqual(built.ids, ['ok']);
});

test('buildIndexBlock：同一份输入跑两次，逐字节一致（前缀缓存的前提）', () => {
  const pinned = [row('p1', '硬约定：删除必须带理由', { kind: 'manual' })];
  const recent = [row('r1', '宝宝喜欢冰美式'), row('r2', '面板分四页')];
  const a = buildIndexBlock({ pinned, recent, total: 3, slots: 3, pinnedCap: 4, charLimit: 60 });
  const b = buildIndexBlock({ pinned, recent, total: 3, slots: 3, pinnedCap: 4, charLimit: 60 });
  assert.deepEqual(a, b);
});

// ── Layer 1：按需召回 ─────────────────────────────────────────────────────────

test('buildRecallBlock：覆盖度决定顺序；已在索引/已注入过的被降权而不是硬删', () => {
  const candidates = [
    row('hit', '冰美式是宝宝的日常，早上必喝一杯，带糖'),
    row('half', '冰美式相关的一条边角料，也提到冰美式'),
    row('noise', '完全不相关的一条：茶与咖啡机'),
  ];
  const built = buildRecallBlock({ candidates, terms: ['冰美', '美式'], slots: 2, charLimit: 60 });
  assert.equal(built.ids[0], 'hit', '命中更全的排第一');
  assert.ok(!built.ids.includes('noise'), '一个词都没命中的不该进来');
  const discounted = buildRecallBlock({ candidates, terms: ['冰美', '美式'], slots: 1, charLimit: 60, excludeIds: ['hit'] });
  assert.deepEqual(discounted.ids, ['half'], '排第一的被"已注入"降权后让位（不是硬删）');
});

test('buildRecallBlock：闸门 —— 只蹭一个高频短词（如"喜欢"）的候选直接丢掉', () => {
  const weak = [row('weak', '这条只是碰巧含喜欢两个字，其实不相关')];
  assert.deepEqual(buildRecallBlock({ candidates: weak, terms: ['喜欢'] }).ids, [], '高频短词不算相关');
  // 但"够独特"的词（长 + 极少候选命中）一个人也能开门，比如技术词。
  const tech = [row('tech', '改库唯一入口是 reviewKeeperPlan，这条是硬约定')];
  assert.deepEqual(buildRecallBlock({ candidates: tech, terms: ['reviewkeeperplan'] }).ids, ['tech'], '独特词单独命中要放行');
});

test('buildRecallBlock：没有查询词 / 没有候选时返回空（不画空围栏）', () => {
  assert.deepEqual(buildRecallBlock({ candidates: [row('a', '冰美式')], terms: [] }), { lines: [], ids: [], deduped: 0 });
  assert.deepEqual(buildRecallBlock({ candidates: [], terms: ['冰美'] }), { lines: [], ids: [], deduped: 0 });
});

// ── 引擎：冻结 / 话题段 / 热列表 / 只读 ────────────────────────────────────────

/** 假 store：只实现引擎要用的两个同步查询。 */
function fakeStore({ pinned = [], recent = [], candidates = [], total = 0 } = {}) {
  return {
    listIndexCandidatesSync: () => ({ pinned, recent, total }),
    searchBySubstringsSync: () => candidates,
  };
}

test('引擎：索引块按 scope 冻结 —— 同一段话题内逐字节不变，换话题才 +1 版本重建', () => {
  const store = fakeStore({
    pinned: [],
    recent: [row('r1', '宝宝喜欢冰美式咖啡，早上必喝一杯，带糖', { readScore: 2 })],
    total: 1,
  });
  const engine = new RecallEngine({ store, cfg: makeCfg() });
  const scope = {};
  const first = engine.indexText(scope);
  assert.ok(first.includes('<memory_index'));
  assert.ok(first.includes('[mem#r1'));
  assert.equal(engine.indexText(scope), first, '同 scope 同版本 → 同一段文本');
  const version = engine.indexVersion;

  // 连续 3 条不相干消息 → 话题段切换 → 版本 +1（重建索引）
  engine.noteUserMessage('s1', '宝宝喜欢喝冰美式咖啡');
  engine.noteUserMessage('s1', '继续聊冰美式的糖量');
  engine.noteUserMessage('s1', '部署到服务器的端口和证书怎么配置');
  engine.noteUserMessage('s1', 'nginx 反向代理的配置文件在哪里');
  assert.ok(engine.indexVersion > version, '换话题后版本号要涨');
  assert.equal(engine.indexText(scope), engine.indexText(scope), '重建之后仍然稳定');
});

test('引擎：短消息（顺口一问）不触发话题切换', () => {
  const engine = new RecallEngine({ store: fakeStore(), cfg: makeCfg({ minSegmentTurns: 2 }) });
  engine.noteUserMessage('s1', '宝宝喜欢喝冰美式咖啡');
  const before = engine.indexVersion;
  engine.noteUserMessage('s1', '几点');
  assert.equal(engine.indexVersion, before, '「几点」这种短消息不切段');
});

test('引擎：召回用最近一条**主会话**消息当查询，热列表排在最前且不受冻结影响', () => {
  const candidates = [
    row('m1', '冰美式：早上必喝一杯，带糖'),
    row('m2', '茶的偏好：喜欢乌龙'),
  ];
  const engine = new RecallEngine({
    store: fakeStore({ candidates, recent: [row('i1', '常驻索引里的一条')], total: 2 }),
    cfg: makeCfg(),
  });
  engine.noteUserMessage('s1', '宝宝喜欢喝冰美式咖啡');
  engine.noteHot('hot1', '刚拍板：删除必须带理由');
  const text = engine.recallText();
  assert.ok(text.includes('<memory_recall'));
  assert.ok(text.includes('【刚记下】[mem#hot1]'), '热列表排最前');
  assert.ok(text.includes('[mem#m1]'), '按查询词召回到冰美式那条');
  assert.ok(!text.includes('[mem#m2]'), '不相关的茶那条不进来');
  assert.ok(engine.status().recall.ids.includes('m1'));
});

test('引擎：热条目没有正文就不画那一行（只剩编号 = 零信息，纯噪音）', () => {
  const engine = new RecallEngine({ store: fakeStore({ candidates: [], recent: [], total: 0 }), cfg: makeCfg() });
  engine.noteHot('dead1'); // 真机里就是 merge 之后被软删的原条：拿不到正文
  engine.noteHot('live1', '刚拍板：删除必须带理由');
  const text = engine.recallText('s1', '删除必须带理由这条规矩是谁定的');
  assert.ok(text.includes('【刚记下】[mem#live1]'), '有正文的照画');
  assert.ok(!text.includes('dead1'), '没正文的热条目不画');
});

test('引擎：召回只给喂过查询词的那个会话（子代理组装提示词时不给）', () => {
  const engine = new RecallEngine({
    store: fakeStore({ candidates: [row('m1', '副仓管接手模型由启动者决定')], recent: [], total: 1 }),
    cfg: makeCfg(),
  });
  engine.noteUserMessage('s1', '副仓管用哪个模型接手');
  assert.equal(engine.recallText('sub-agent-7'), '', '别的会话（子代理 / 委派）不给');
  assert.match(engine.recallText(null), /mem#m1/, '拿不到会话 id 时照常给（不静默失效）');
});

test('引擎：查询词优先用现场取到的那条人话（事件慢一步时的补救），并记账 source', () => {
  const engine = new RecallEngine({
    store: fakeStore({ candidates: [row('m1', '副仓管接手模型由启动者决定')], recent: [], total: 1 }),
    cfg: makeCfg(),
  });
  // 事件还没喂进来（cursor 空）—— 现场那句仍要生效，这就是"第 1 步也有召回"
  const text = engine.recallText('s1', '副仓管用哪个模型接手');
  assert.match(text, /mem#m1/);
  assert.equal(engine.status().recall.source, 'live');
  assert.equal(engine.status().recall.query, '副仓管用哪个模型接手');

  // 懒函数形式：只有过了闸门才会被求值（别的会话连日志都不扫）
  engine.noteUserMessage('s1', '副仓管用哪个模型接手');
  let asked = 0;
  engine.recallText('s1', () => { asked += 1; return '副仓管用哪个模型接手'; });
  assert.equal(asked, 1);
  asked = 0;
  engine.recallText('sub-agent-7', () => { asked += 1; return '别的会话'; });
  assert.equal(asked, 0, '别的会话连日志都不该扫');
});

test('引擎：查询词太短就整条不注（只留热列表），并记 skip=short-query', () => {
  const engine = new RecallEngine({
    store: fakeStore({ candidates: [row('m1', '永远不能骗宝宝：看图必须先确认看到')], recent: [], total: 1 }),
    cfg: makeCfg(),
  });
  engine.noteUserMessage('s1', '重启完成');
  engine.noteHot('hot1', '刚拍板：删除必须带理由');
  const short = engine.recallText('s1');
  assert.ok(short.includes('【刚记下】[mem#hot1]'), '热列表照旧（它与查询无关）');
  assert.ok(!short.includes('[mem#m1]'), '4 字消息不注召回（真机实测那 4 行里有 2 行完全无关）');
  assert.equal(engine.status().recall.skip, 'short-query');

  // 闸门认「长度」，不是「没词」：够长的现场查询照旧召回
  const long = engine.recallText('s1', '永远不能骗宝宝这条底线是什么');
  assert.match(long, /mem#m1/);
  assert.equal(engine.status().recall.skip, '');
});

test('引擎：同一块里近似重复的行只留一条（dedupeFloor）', () => {
  const near = [
    row('m1', '副审阅区收成一行卡片按钮，点击才展开'),
    row('m2', '副审阅区收成一行卡片按钮，点击才展开'),
  ];
  const engine = new RecallEngine({ store: fakeStore({ candidates: near, recent: [], total: 2 }), cfg: makeCfg() });
  const text = engine.recallText('s1', '副审阅区为什么收成一行');
  assert.match(text, /mem#m1/);
  assert.ok(!text.includes('mem#m2'), '近似重复的那条被丢掉');
  assert.equal(engine.status().recall.deduped, 1);

  // dedupeFloor=0 = 关：两条都留下
  const off = new RecallEngine({ store: fakeStore({ candidates: near, recent: [], total: 2 }), cfg: makeCfg({ dedupeFloor: 0 }) });
  const both = off.recallText('s1', '副审阅区为什么收成一行');
  assert.ok(both.includes('mem#m1') && both.includes('mem#m2'), '关掉去重后两条都在');
});

test('引擎：同一话题段内已注入过的条会被压到后面（软折扣，不是硬排除）', () => {
  const same = '冰美式：早上必喝一杯，带糖';
  const engine = new RecallEngine({
    store: fakeStore({ candidates: [row('m1', same), row('m2', same)], recent: [], total: 2 }),
    cfg: makeCfg({ recallSlots: 1 }),
  });
  engine.noteUserMessage('s1', '宝宝喜欢喝冰美式咖啡');
  assert.match(engine.recallText(), /mem#m1/, '第一轮：更新的那条排最前');
  assert.match(engine.recallText(), /mem#m2/, '第二轮换新的那条 —— 已注入的 m1 被 0.35 折扣压下去');
});

test('引擎：关闭（enabled:false）时两层都返回空串 —— 关得掉才算"可关"', () => {
  const engine = new RecallEngine({ store: fakeStore({ recent: [row('r1', '宝宝喜欢冰美式')], total: 1 }), cfg: makeCfg({ enabled: false }) });
  engine.noteUserMessage('s1', '宝宝喜欢喝冰美式咖啡');
  assert.equal(engine.indexText({}), '');
  assert.equal(engine.recallText(), '');
  assert.equal(engine.status().enabled, false);
});

test('引擎：store 抛错时吞掉并如实记进 status().errors（注入失败不能让 prompt 组装炸掉）', () => {
  const engine = new RecallEngine({
    store: {
      listIndexCandidatesSync: () => {
        throw new Error('库没了');
      },
      searchBySubstringsSync: () => {
        throw new Error('库没了');
      },
    },
    cfg: makeCfg(),
  });
  // 必须喂一条**够长**的查询：短查询会在碰 store 之前就被闸门挡下（那样只会有 1 条错误）
  engine.noteUserMessage('s1', '宝宝喜欢喝冰美式咖啡');
  assert.equal(engine.indexText({}), '');
  assert.equal(engine.recallText(), '');
  assert.equal(engine.status().errors.length, 2);
  assert.match(String(engine.status().errors[0].error), /库没了/);
});

// ── 与真库接口串起来（只读） ───────────────────────────────────────────────────

test('真 store：listIndexCandidatesSync 把「人写的 / 旧基线」挑进 pinned，并按活条数报 total', () => {
  const { store } = makeStore();
  store.addMemory({ text: '手工写下的硬约定：删除必须带理由', kind: 'manual', source: '手动写入' });
  store.addMemory({ text: '旧基线里的一条：宝宝喜欢冰美式', kind: 'palace', source: '热区基线/USER.md' });
  store.addMemory({ text: '一条普通的自动捕获记忆，内容够长了', kind: 'auto', source: '自主捕获' });
  const deleted = store.addMemory({ text: '这条会被软删，不该进候选' });
  store.softDeleteMemory(deleted.id);

  const { pinned, recent, total } = store.listIndexCandidatesSync({ pinnedLimit: 20, recentLimit: 20 });
  assert.equal(total, 3, 'total 只数活着的');
  assert.deepEqual(pinned.map((r) => r.kind).sort(), ['manual', 'palace']);
  assert.ok(recent.every((r) => r.deleted_at == null), '候选里不该出现软删的');
});

test('真 store：searchBySubstringsSync 命中、按新→旧、并且**不写库**', () => {
  const { store } = makeStore();
  store.addMemory({ text: '宝宝喜欢冰美式，早上必喝一杯' });
  store.addMemory({ text: '宝宝喜欢乌龙茶' });
  const before = store.countMemories();
  const hits = store.searchBySubstringsSync(['冰美'], { limit: 10 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /冰美式/);
  assert.equal(store.searchBySubstringsSync(['不存在的词'], { limit: 10 }).length, 0);
  assert.equal(store.countMemories(), before, '注入路径一个字都不许写库');
});

// ── 注入台账（面板「最近几步」的数据源） ──────────────────────────────────────

