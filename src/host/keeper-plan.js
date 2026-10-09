/**
 * dsh-memory · 仓管「变更单」的纯逻辑：事实要点证据、出单提示词、出单解析与整形。
 *
 * ## 为什么要这一层（用户 2026-10-07 拍板的范式升级）
 * 旧仓管是**直接改库**的：跑一轮就把原文改写、把余块入库、把重复项软删。风险在于
 * 「模型一次判断错，一千条记忆就已经变了」，而人只能在事后用 `revertKeeper()` 回滚。
 * 新范式把它拆成两段：
 *
 *   1. **出单**（本模块 + `MemoryService.startKeeperRun`）：仓管只产出变更单，
 *      **一个字都不写记忆库**（只写 `keeper_plans` 表）；
 *   2. **审阅落库**（`MemoryService.reviewKeeperPlan`）：人整单通过 / 驳回，或只勾选其中几条。
 *
 * ## `replace` / `merge` 的唯一不变量是「事实要点不丢」（用户 2026-10-07 的最终语义）
 *
 * 用户原话：「**灵活一些 让LLM视情况决策 缩写、去冗余、优化语序 都是被允许的**」。
 * 所以这一层**刻意不做「违规」判定**，也没有「不许改写」的硬校验：
 *
 * - **允许**：缩写、去冗余、优化语序、同义换词、把句子理顺、合并、必要时改错别字；
 * - **不许**：丢事实要点（人物 / 时间 / 决定 / 数值 / **引号里的原话** / emoji 与标签符号）、
 *   **新增**原文没有的事实、**把不确定的写成确定的**（「可能 / 大概」不能变成断言）。
 *
 * `factCheck()` 只为上面这条不变量**产出证据** ——
 * 丢了哪些数字、哪些**内容片段消失**了、压缩到原来的百分之多少 —— 它**不改判、不自动拒绝**；
 * `factWarnings()` 把证据翻成人话写进 op 的 `warnings[]`，措辞中性（没有「违规」、没有
 * 「不是纯删除」），决定权始终在人（审阅时可以用 `edits` 手改，或整单 `reject`）。
 *
 * 证据按**内容片段**（引号原话 / emoji 标签 / 汉字串 / 拉丁词）比对，而不是逐字对齐：
 * 优化语序会让逐字对齐切出一堆读不通的碎渣，片段级证据才是人能一眼看懂的。
 *
 * ## 统一修改语义：`replace` = 删旧 + 录新（用户 2026-10-07 拍板）
 *
 * 用户原话：「修改记忆的做法是 **依照原记忆编写修改后的记忆** → **新旧记忆展示在待审区** →
 * **过审后删除原记忆、录入新记忆**」。
 *
 * 所以**修改类操作只有一个类型** `replace`，**没有「原地改写同一条」这条路径**：
 * - 出单侧：模型输出 `type:'replace'`（见 `PLAN_PROMPT`）；
 * - 兼容读入：旧提示词时期留下的 `'rewrite'` **一律按 `replace` 解析**（`parsePlanOps()` 收下、
 *   `normalizePlanOps()` 归一成 `replace`），落库侧也照 `replace` 走 —— 不留老路径；
 * - `after` 就是**新记忆的正文**（`edits` 手改的也是它）；`before` 是原记忆，给审阅者做对比；
 * - 因为过审后**原记忆会被删掉**，after 必须**完整自足**（这也是「每块自足」铁律对它的要求）。
 *
 * ## 整理后的**每一块都必须自足**（用户 2026-10-07 发现，同一轮的追加铁律）
 *
 * 用户原话：「整理后的记忆丢失语句成分的情况，比如第二块是指劳工边界，可它只说边界，
 * 这样会被理解为某个全局边界，**这很危险**，因此整理后的记忆块要完整」。
 * 所以三条新规则**同时**成立（对 `split` 的每一块、以及 `replace` / `merge` 的 after 都算）：
 *
 * 1. **每块自足**：产出块必须带主语 / 对象 / 时间锚，能脱离上下文被正确理解；
 *    **为此允许重复原文里的主语词**（重复不算冗余，缺主语才是问题）；
 * 2. **不丢内容**：各块合起来仍要覆盖原文（`factCheck()` 的 `missingNumbers` /
 *    `missingTerms` 照旧是证据）；
 * 3. **不凭空加信息**：after（或 split 的每一块）里**新增的片段必须能在原文里找到** ——
 *    口径就是「**允许重复，禁止发明**」。
 *
 * ## ⚠️ `split` 的旧承诺「逐字无损 / 子序列 ≥98%」**作废**
 *
 * 规则 1 与子序列判定天然冲突：为了补回主语而重复的词，是**新增**的字符，
 * 拼起来当然不再是原文的子序列。所以 `split` 不再跑 `coverageOf()` 的硬校验
 * （`keeper.js` 里那两个函数**保留**：`coverageOf()` 仍是可用的核对工具，
 * `losslessSplit()` 仍作**兜底**手段 —— 只在模型没给出可用碎片时用它确定性切分）。
 * `split` 现在跑的是三条证据：①每块自足 ②不丢内容 ③不新增信息。
 *
 * 这批新证据（`anchorsOf()` / `selfContained()` / `addedTerms()`）**仍然只产证据、不替人决定**：
 * 缺主语、新增片段都写进 `warnings[]`（人话、中性措辞），op **照出**，由审阅者拍板。
 *
 * @module dsh-memory/host/keeper-plan
 */

// ⚠️ 这里**刻意不再 import `coverageOf`**：它是「逐字无损 / 子序列」那套旧判据的工具，
// `split` 已不跑它（见文件头）。`losslessSplit()` 仍要 import —— 它只作为**兜底**手段。
import { DEFAULT_SPLIT_CHARS, grindCandidate, losslessSplit } from './keeper.js';

/**
 * 「删除没给理由」那条警告的原文（`normalizePlanOps()` 写进 op 的 `warnings`、`planWarnings()` 会带上它）。
 *
 * 导出是为了让测试与面板文案口径一致（用户 2026-10-07：「删除必须附带理由」＋「仓管禁止触碰删除功能本身」）。
 */
export const NO_REASON_WARNING = '这条删除没写理由：按口径一律不应用（要删就得说清楚为什么）';

/** 数字 / 日期 / 端口 / 版本号的识别式（`3.5`、`2026-03`、`2026/3/5`、`8080`、`v1.2` 里的 `1.2`）。 */
export const NUMBER_RE = /\d+(?:[.\-/]\d+)*/g;

/** `NUMBER_RE` 的非全局版 —— 全局正则的 `test()` 会带 `lastIndex` 状态，判定时不能用它。 */
const NUMBER_TEST_RE = /\d+(?:[.\-/]\d+)*/;

/** 引号原话的标记（片段里含这些字符，就算「像原话」）。 */
export const QUOTE_MARKS = /[「」『』“”‘’【】]/;

/** emoji / 图形符号（`🎞️🎥📍💬🔊` 之类：片段里含这些，就算「像标签」）。 */
export const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/** 配对引号的识别式（中英文引号各一套；只取引号**里面**的原话作为候选片段）。 */
const QUOTE_PATTERNS = [
  /「([^」]{1,200})」/g,
  /『([^』]{1,200})』/g,
  /“([^”]{1,200})”/g,
  /"([^"\n]{1,200})"/g,
  /‘([^’]{1,200})’/g,
];

/**
 * emoji / 标签符号簇。
 *
 * 变异选择符（U+FE0F）与 ZWJ 连接算**同一个**片段（`🎞️` 是一个标签，不是两个字符）；
 * 因此这里按「图形字符」而不是按 UTF-16 码元切，绝不会出现半个 emoji 的乱码。
 */
const EMOJI_CLUSTER_RE = /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

/** 汉字串 / 拉丁词（`v1.2`、`qwen-plus` 这类连字符词也算一个片段）。 */
const WORD_RE = /[\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9_.-]*/g;

/** `missingTerms` 的上限（警告是给人看的，刷屏等于没有）。 */
export const TERM_LIMIT = 20;

/** 单个片段在警告里的显示上限（超出就截断，免得整段长文糊在一条 warning 里）。 */
export const TERM_PREVIEW_CHARS = 30;

/**
 * 「压缩得太狠」的提醒阈值：**只在极低时**附一句「留意是否过度缩写」。
 *
 * 正常去冗余变短**不报警** —— 去冗余本来就会变短；这条阈值只是给人一个「回头看一眼」的线索。
 */
export const LOW_LENGTH_RATIO = 0.4;

/**
 * 停用词表：这些片段本身不承载事实，缺了不值得进 `missingTerms`。
 *
 * 只用来**减少噪音**（否则「其实」「就是」这类填充词会把警告刷满），不参与任何判定。
 * 判定口径见 `isStopFragment()`：只有「整段都是虚词 / 标点」才丢。
 */
export const STOP_WORDS = [
  // 多字填充词
  '就是', '但是', '因为', '所以', '然后', '其实', '我觉得', '我们', '他们', '这个', '那个', '可以', '还是',
  // 单字虚词
  '的', '了', '着', '在', '是', '和', '与', '就', '都', '也', '把', '被', '给', '对', '从', '让', '有',
  '不', '要', '会', '能', '个', '我', '你', '他', '她', '它', '们', '这', '那', '一', '上', '下', '里',
  '中', '后', '前', '时', '而', '并', '或', '等', '很', '还', '又', '再', '说',
];

/**
 * 出单提示词。
 *
 * 最显眼处是**自足铁律**（用户 2026-10-07 的追加要求：整理后的每一块都必须自足）；
 * `replace` / `merge` 明确**允许**缩写 / 去冗余 / 优化语序，只钉住「事实要点不许丢、不许新增、
 * 不许把不确定写成确定」；`replace` 是唯一修改操作（过审后删旧录新，所以 after 必须完整自足）；
 * `split` 不再承诺「逐字无损 / 子序列」，改成「每块自足 + 不丢内容 + 不新增」。
 */
export const PLAN_PROMPT = `你是记忆仓管。用户会给一组**语义相关**的记忆（每条都带 id），请产出一份「变更单」（若干条操作）。

最要紧的一条铁律（先说）：**每一块 / 每条整理结果都必须自足** —— 带上主语、对象、时间锚，能脱离上下文被正确理解；为此**可以重复原文中的主语词**（重复是允许的，缺主语不是）。禁止产出「边界=…」「索引已更新」「已剔除」这类脱离上下文会被误读成全局的碎片。

铁律：
1. **你只出单，不落库**：系统会等人审阅，没被勾选的操作一个字都不会写进记忆库，所以你尽可以给出建议、但不要假设它已经生效；
2. **只许用给出的 id**，不许编造、不许改写 id；
3. **改写是允许的，请视情况灵活决策**：缩写、去掉重复啰嗦、优化语序、把几句话理顺、换同义说法、必要时改错别字，都可以 —— 读起来更清楚、更干练就算好；
4. **但事实要点一个都不许丢**：人物、时间、决定、数值（数字 / 日期 / 版本号 / 端口）、**引号里的原话**、emoji 与标签符号（🎞️🎥📍💬🔊 之类）必须原样保留；
5. **不许新增**原文没有的事实，**不许把不确定的写成确定的**（「可能 / 大概 / 听说」不能变成断言）；
6. 四种操作：
   - split：把一条大段记忆拆成若干原子事实。**原则是只能切分**（不总结、不润色、不丢内容），但为了**每一块都自足**，该重复的主语 / 对象 / 时间锚就**重复出来**（例如给「边界=…」那块补回「…（Nemotron 免费劳工）」）；**不许新增原文里没有的信息**；after 是字符串数组；
   - replace：把一条记忆改成新的正文，**这是唯一的修改操作**（缩写 / 去冗余 / 优化语序都行），但事实要点必须全部保留、整条读起来仍然自足；after 是字符串。⚠️ 系统会在**过审后删除原记忆、录入这条新记忆**（原条软删、可恢复），所以 after 必须是**完整自足的新正文** —— 原条会被删掉，读的人拿不到它的上下文，**不要**只写「补了个时间」这类片段；
   - merge：几条在说同一件事的记忆合成一条，保留 targets 里的第一条（其余的会被软删、可恢复）；after 是合并后的正文（字符串），同样要自足；
   - drop：某条完全是重复或毫无价值，建议软删（可恢复）；不需要 after，但 **reason 必须写、而且要写到"能说服人"** —— 跟哪条重复 / 为什么毫无价值 / 删掉会不会丢事实，说清楚。⚠️ **没有理由的删除，系统一律不会应用**（人在面板上勾了也没用、这一条会记成"跳过"），所以别把 reason 写成「没用」「重复」这种一句话交差；
7. **过期 ≠ 删除**：如果只是某部分过时了，改写时给它加时间锚（如「…（2026-10 前）…」），**不要**把那部分内容直接删掉；
8. 没有值得做的变更就输出空数组 []；
9. 只输出一个 JSON 数组，每项形如下面四种之一，不要输出任何其它文字：
   {"type":"split","targets":["id"],"after":["第一块","第二块"],"reason":"一句话理由"}
   {"type":"replace","targets":["id"],"after":"修改后的新正文","reason":"一句话理由"}
   {"type":"merge","targets":["id1","id2"],"after":"合并后的正文","reason":"一句话理由"}
   {"type":"drop","targets":["id"],"reason":"一句话理由"}`;

/**
 * `buildPlanRequest()` 的两种**侧重**（`emphasis`）。
 *
 * ⚠️ 这不是「两种不同任务」：出单流程、四种 op、自足与要点校验**完全一样**，
 * 区别只在系统提示词里多不多那一段引导 —— 两个按钮都只出变更单，一个字都不写记忆库。
 */
export const EMPHASIS_ALL = 'all';
export const EMPHASIS_DEDUPE = 'dedupe';

/**
 * `emphasis:'dedupe'` 时追加到 `PLAN_PROMPT` 后面的那段引导：**偏重去重合并**。
 *
 * 只加引导、不加约束：`replace` / `drop` 照旧可给，`split` 也没有被禁（确实又长又该拆的仍可拆），
 * 只是明确「不为了拆而拆」—— 这一轮想让模型先看「同一件事被拆成多条」的情况。
 */
export const DEDUPE_EMPHASIS_PROMPT = `补充侧重（本轮）：**偏重去重合并**。
- 优先找「同一件事被拆成多条」的情况并给出 merge：几条明显在讲同一件事的记忆合成一条，保留说得最全的那条；
- **不要为了拆而拆**：这一轮不鼓励无边界的 split（确实又长又该拆的仍可拆）；replace / drop 照旧可给，但都不是本轮重点；
- 上面「每块 / 每条都必须自足」的要求与 1–9 条铁律（尤其「事实要点一个都不许丢」「不许新增」）**一条都没有放松**。`;

/**
 * 取数组里的去重值（保序）。
 *
 * @param {unknown[]} values 值
 * @returns {string[]} 去重后的字符串数组
 */
function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '');
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 抹掉空白：换行 / 空格位置变了不算改动。
 *
 * @param {unknown} text 文本
 * @returns {string} 去空白后的文本
 */
function stripSpace(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 单个片段压成一行（超长截断）。
 *
 * @param {string} text 片段
 * @returns {string} 预览片段
 */
function shorten(text) {
  const value = String(text);
  return value.length > TERM_PREVIEW_CHARS ? `${value.slice(0, TERM_PREVIEW_CHARS)}…` : value;
}

/**
 * 把列表压成一行预览（最多 5 项，超长截断，其余用「等 N 个」收口）。
 *
 * @param {string[]} list 列表
 * @returns {string} 预览
 */
function previewList(list) {
  const head = list.slice(0, 5).map((item) => shorten(item)).join(' / ');
  return list.length > 5 ? `${head} 等 ${list.length} 个` : head;
}

/**
 * 把一段正文切成**内容片段**（引号原话 → emoji 标签 → 汉字串 / 拉丁词，顺序即优先级）。
 *
 * 为什么按片段而不是逐字：优化语序之后，逐字对齐会把原文切成一堆读不通的碎渣；
 * 「这一整段内容不见了」才是审阅者一眼能看懂的证据。
 *
 * 引号片段**连引号一起**留着（`「记得带报告」`）—— 那是「原话」最直观的标记。
 *
 * @param {string} text 正文
 * @returns {string[]} 候选片段（保序、去重）
 */
function segmentsOf(text) {
  const src = String(text ?? '');
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} 引号**里面**的原话：它们已由引号片段代表，别再重复出一个裸片段。 */
  const quoted = new Set();
  for (const re of QUOTE_PATTERNS) {
    re.lastIndex = 0; // 共享正则：防上一轮留下的 lastIndex 影响 matchAll
    for (const found of src.matchAll(re)) {
      const whole = String(found[0] ?? '').trim();
      const inner = String(found[1] ?? '').trim();
      if (inner !== '') quoted.add(inner);
      if (whole !== '') out.push(whole);
    }
  }
  for (const found of src.matchAll(EMOJI_CLUSTER_RE)) out.push(found[0]);
  for (const found of src.matchAll(WORD_RE)) {
    if (found[0].length >= 2 && !quoted.has(found[0])) out.push(found[0]);
  }
  return uniqueStrings(out);
}

/**
 * 这个片段像不像「事实」：数字 / 日期、引号原话、emoji 标签。
 *
 * 它们是最该被人看一眼的东西，所以排在 `missingTerms` 最前面（判据是「像」，不是「是」）。
 *
 * @param {string} fragment 片段
 * @returns {boolean} 是否像事实
 */
function isFactFragment(fragment) {
  const text = String(fragment);
  return NUMBER_TEST_RE.test(text) === true || QUOTE_MARKS.test(text) === true || EMOJI_RE.test(text) === true;
}

/**
 * 片段的排序权重：事实类优先，其次是有字/数字的内容，最后是纯标点。
 *
 * @param {string} fragment 片段
 * @returns {0|1|2} 权重（小的排前面）
 */
function fragmentRank(fragment) {
  if (isFactFragment(fragment)) return 0;
  return /[\p{L}\p{N}]/u.test(String(fragment)) ? 1 : 2;
}

/**
 * 这个片段是不是「纯填充词」（去掉全部停用词后什么都不剩）。
 *
 * 只有「整段都是虚词 / 标点」才丢 —— 单个实义字（「成」「班」）**不丢**，
 * 它是「这里换过词」的最小证据；数字 / 引号原话 / emoji 一律不当停用词。
 *
 * @param {string} fragment 片段
 * @returns {boolean} 是否可忽略
 */
function isStopFragment(fragment) {
  const text = String(fragment);
  if (isFactFragment(text)) return false;
  let rest = text;
  for (const word of STOP_WORDS) rest = rest.split(word).join('');
  return rest.replace(/[\s\p{P}]/gu, '').length === 0;
}

/**
 * 改后文本里还找得到这个片段吗？
 *
 * 两种「换了皮不算丢」：
 * - 引号样式变了（`「原话」` → `“原话”`）但**原话还在** → 不算消失；
 * - emoji 的变异选择符（U+FE0F）差异（`🎞️` 与 `🎞`）→ 视为同一个标签。
 *
 * @param {string} term 片段
 * @param {string} dstFlat 改后文本（已去空白）
 * @returns {boolean} 是否还在
 */
function containsTerm(term, dstFlat) {
  const text = String(term);
  if (dstFlat.includes(text)) return true;
  const inner = text.replace(/^[「『“‘"]+/, '').replace(/[」』”’"]+$/, '');
  if (inner !== text && inner !== '' && dstFlat.includes(inner)) return true;
  const bare = text.replace(/\uFE0F/g, '');
  return bare !== text && dstFlat.replace(/\uFE0F/g, '').includes(bare);
}

// ── 自足 / 不新增：锚点与「新增片段」证据（用户 2026-10-07 的追加铁律）──────────────

/** `anchorsOf()` 返回的锚点上限（证据是给人看的，刷屏等于没有）。 */
export const ANCHOR_LIMIT = 60;

/** 2 字窗成为锚点所需的出现次数 —— 2 字组合太常见，门槛抬高才不至于把功能词当锚点。 */
export const ANCHOR_BIGRAM_MIN_COUNT = 3;

/** 3–4 字窗成为锚点所需的出现次数。 */
export const ANCHOR_WORD_MIN_COUNT = 2;

/** 主题词窗口的长度范围（用户定的口径：2–4 字）。 */
const ANCHOR_WINDOW_SIZES = [2, 3, 4];

/** 引号原话 / 英文 / 数字标识这类「一眼就是专有名词」的权重（直接越过频次门槛）。 */
const STRONG_ANCHOR_WEIGHT = 99;

/** `addedTerms()` 里「这段内容原文里本来就有」所需的最短连续匹配长度。 */
export const ADDED_MATCH_RUN = 4;

/** `addedTerms()` 报「新内容」所需的最短连续新字数（单字差异多为同义换词 / 语序，不报）。 */
export const ADDED_MIN_CHARS = 2;

/** 单次最长匹配的扫描上限（只判断「这段原文里有」，不必一路比到底）。 */
const ADDED_MATCH_CAP = 64;

/** 英文词 / 数字标识（`Nemotron`、`qwen-plus`、`v1.2`、`08-13`、`8080`）。 */
const ANCHOR_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9_.-]{1,}|\d+(?:[.\-/]\d+)*/g;

/** 汉字串（用来切 2–4 字主题词窗）。 */
const HAN_RUN_RE = /[\u4e00-\u9fff]+/g;

/**
 * 比对用的规范化文本：抹掉空白，并把中英文引号统一成 `"`。
 *
 * 为什么连引号一起统一：`「原话」` → `“原话”` 只是引号样式变了（`containsTerm()` 也是这么认的），
 * 不该在 `addedTerms()` 里被当成「新增了 `“` 这个片段」。
 *
 * @param {unknown} text 文本
 * @returns {string} 规范化后的文本
 */
function canonicalText(text) {
  return stripSpace(text).replace(/[「」『』“”‘’【】]/g, '"');
}

/**
 * 从一组原文里提取**锚点词**（判断「这块自足吗」的基准）。
 *
 * 四类锚点（用户口径：专有名词、引号内术语、英文 / 数字标识、出现频次高的 2–4 字主题词）：
 * - **引号里的原话**、**英文词 / 数字标识**：一眼就是专有名词，给高权重直接入选；
 * - **2–4 字汉字主题词**：按**出现频次**筛（2 字窗要 ≥3 次、3–4 字窗要 ≥2 次 ——
 *   2 字组合太容易撞上「只做」「可以」这类功能词，门槛必须更高），并用 `isStopFragment()` 去虚词。
 *
 * 提取不到锚点时返回空数组 —— 调用方（`selfContained()`）对空锚点**不判缺主语**，
 * 不能因为「找不出锚点」就给每条记忆都扣一顶帽子。
 *
 * @param {unknown} texts 一段正文，或一组正文
 * @returns {string[]} 锚点词（长的、频次高的排前面，上限 `ANCHOR_LIMIT`）
 */
export function anchorsOf(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? ''));
  /** @type {Map<string, number>} */
  const counts = new Map();
  /**
   * 记一次出现。
   *
   * @param {string} word 锚点词
   * @param {number} [weight] 权重
   * @returns {void}
   */
  const bump = (word, weight = 1) => {
    if (word === '') return;
    counts.set(word, (counts.get(word) ?? 0) + weight);
  };

  for (const text of list) {
    for (const re of QUOTE_PATTERNS) {
      re.lastIndex = 0;
      for (const found of text.matchAll(re)) {
        const inner = String(found[1] ?? '').trim();
        if (inner.length >= 2) bump(inner, STRONG_ANCHOR_WEIGHT);
      }
    }
    for (const found of text.matchAll(ANCHOR_IDENTIFIER_RE)) {
      if (found[0].length >= 2 && !isStopFragment(found[0])) bump(found[0], STRONG_ANCHOR_WEIGHT);
    }
    for (const found of text.matchAll(HAN_RUN_RE)) {
      const run = found[0];
      for (const size of ANCHOR_WINDOW_SIZES) {
        for (let i = 0; i + size <= run.length; i += 1) bump(run.slice(i, i + size));
      }
    }
  }

  const out = [];
  for (const [word, count] of counts) {
    const floor = word.length === 2 ? ANCHOR_BIGRAM_MIN_COUNT : ANCHOR_WORD_MIN_COUNT;
    if (count < floor) continue;
    if (isStopFragment(word)) continue;
    out.push(word);
  }
  out.sort(
    (left, right) =>
      right.length - left.length || (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || (left < right ? -1 : 1),
  );
  return out.slice(0, ANCHOR_LIMIT);
}

/**
 * 这块**自足**吗：至少命中一个锚点（主语 / 对象 / 时间锚）就算自足。
 *
 * `anchors` 为空（原文里提不出锚点）时**判 ok** —— 没有基准就不给人扣帽子。
 *
 * @param {unknown} text 待判的块
 * @param {Iterable<string>|string[]} [anchors] `anchorsOf()` 的结果
 * @returns {{ok: boolean, hit: string|null}} 结论（`hit` 是命中的那个锚点）
 */
export function selfContained(text, anchors = []) {
  const body = canonicalText(text);
  if (body === '') return { ok: true, hit: null };
  const list = anchors instanceof Set ? [...anchors] : Array.isArray(anchors) ? anchors : [];
  // 一个锚点都提不出来 → **不判缺主语**（没有基准就不给人扣帽子）。
  if (list.length === 0) return { ok: true, hit: null };
  for (const anchor of list) {
    const word = canonicalText(anchor);
    if (word !== '' && body.includes(word)) return { ok: true, hit: String(anchor) };
  }
  return { ok: false, hit: null };
}

/**
 * 从 `start` 起，`dst` 能在 `src` 里找到的**最长**前缀长度（上限 `ADDED_MATCH_CAP`）。
 *
 * 只用它判断「这一段原文里本来就有」：短于 `ADDED_MATCH_RUN` 的一律不算命中，
 * 免得两三个字的巧合把真正的「新增片段」掩盖掉。
 *
 * @param {string} dst 规范化后的 after
 * @param {number} start 起点
 * @param {string} src 规范化后的 before
 * @returns {number} 匹配长度（0 = 没命中「已有内容」）
 */
function matchedRunLength(dst, start, src) {
  const cap = Math.min(dst.length - start, ADDED_MATCH_CAP);
  if (cap < ADDED_MATCH_RUN) return 0;
  if (!src.includes(dst.slice(start, start + ADDED_MATCH_RUN))) return 0;
  let len = ADDED_MATCH_RUN;
  while (len < cap && src.includes(dst.slice(start, start + len + 1))) len += 1;
  return len;
}

/**
 * 收一段「新增片段」：必须含 ≥ `ADDED_MIN_CHARS` 个**连续**、且 `before` 里根本没出现过的字。
 *
 * 为什么要「连续新字」这道闸：纯粹去冗余 / 优化语序 / 同义换词（`改成`→`改为`）会让贪心比对
 * 留下一点没对齐的碎渣，但它们**没有带进任何新字**，不该报「模型自己加信息」。
 * 真正危险的是「全局」「还行」这种原文字典里没有的词。
 *
 * @param {string} run 贪心比对剩下的未对齐片段
 * @param {Set<string>} srcChars `before` 里出现过的全部字符
 * @param {string[]} out 收集数组
 * @returns {void}
 */
function collectAdded(run, srcChars, out) {
  if (run === '') return;
  let streak = 0;
  for (const ch of run) {
    if (srcChars.has(ch)) streak = 0;
    else {
      streak += 1;
      if (streak >= ADDED_MIN_CHARS) {
        out.push(run);
        return;
      }
    }
  }
}

/**
 * after 里**新增**的、在 before 里找不到的片段（「**允许重复，禁止发明**」的判据）。
 *
 * 判法：先在 after 上按「最长可命中 before 的连续前缀」贪心前移，命中 ≥ `ADDED_MATCH_RUN`
 * 的部分算「原文里本来就有」；剩下的未对齐片段再按 `collectAdded()` 过一道「必须带新字」的闸。
 * 于是：
 * - 只重复原文主语词的块 → 全部命中 → **返回空数组**（重复是允许的）；
 * - 「边界=全局」这种模型自己加的词 → 带上新字 → **返回 `['边界=全局']`**。
 *
 * @param {string} before 原文（`merge` 时是多条原文的并集）
 * @param {string} after 改后文本（`split` 时是各块拼起来的并集）
 * @returns {string[]} 新增片段（保序、去重，上限 `TERM_LIMIT`）
 */
export function addedTerms(before, after) {
  const src = canonicalText(before);
  const dst = canonicalText(after);
  if (dst === '') return [];
  const srcChars = new Set(src);
  /** @type {string[]} */
  const out = [];
  let run = '';
  let i = 0;
  while (i < dst.length) {
    const matched = matchedRunLength(dst, i, src);
    if (matched >= ADDED_MATCH_RUN) {
      collectAdded(run, srcChars, out);
      run = '';
      i += matched;
      continue;
    }
    run += dst[i];
    i += 1;
  }
  collectAdded(run, srcChars, out);
  return uniqueStrings(out).slice(0, TERM_LIMIT);
}

/**
 * 事实要点证据：`before` → `after` 之后，硬信号（数字 / 日期）还在不在、
 * 有哪些**内容片段消失**了、压到了原来的百分之多少。
 *
 * **它只产出证据，不替人做决定**：`ok:false` 也不代表这条操作必须被拒 ——
 * 由 `factWarnings()` 把它翻成人话写进 op 的 `warnings[]`，让审阅者一眼看到再自己拍板。
 *
 * 注意口径：缩写、去冗余、优化语序、同义换词都是**允许**的，所以
 * 「有片段消失」本身**不是**错误，只是给人看线索；`ok` 只反映**硬信号**（数字 / 日期）有没有丢。
 *
 * @param {string} before 原文（`merge` 时是多条原文用 `\n` 连起来的并集）
 * @param {string} after 改后文本
 * @returns {{ok: boolean, lengthRatio: number, missingNumbers: string[], missingTerms: string[]}} 证据
 */
export function factCheck(before, after) {
  const src = String(before ?? '');
  const dst = String(after ?? '');
  // 片段比对前把空白抹掉：换行 / 空格位置变化不算「丢了」。
  const dstFlat = stripSpace(dst);

  const dstNumbers = new Set(dst.match(NUMBER_RE) ?? []);
  const missingNumbers = uniqueStrings(src.match(NUMBER_RE) ?? []).filter((item) => !dstNumbers.has(item));

  // 消失的片段：只保留「具体内容」，事实类（引号原话 / emoji / 带数字的词）排最前。
  const missingTerms = segmentsOf(src)
    .filter((term) => !isStopFragment(term))
    .filter((term) => !containsTerm(term, dstFlat))
    .sort((left, right) => fragmentRank(left) - fragmentRank(right))
    .slice(0, TERM_LIMIT);

  const lengthRatio = src.length === 0 ? 1 : dst.length / src.length;
  return {
    ok: missingNumbers.length === 0,
    lengthRatio,
    missingNumbers,
    missingTerms,
  };
}

/**
 * 把 `factCheck()` 的结论翻成人话警告（`ok:true` 也可能有片段级警告 —— 那也是证据）。
 *
 * 措辞刻意**中性**：没有「违规」、没有「不是纯删除」——同义改写与语序优化是正常且允许的。
 *
 * 除事实要点（数字 / 消失的片段 / 压缩比）外，这一轮还补两条**自足性**证据
 * （用户 2026-10-07：「整理后的记忆块要完整」）：
 * - **这块可能缺主语**：after 命中不了原文任何锚点（主语 / 对象 / 时间锚全丢，例如只剩「边界=…」）；
 * - **新增了原文没有的片段**：after 里出现了原文字典里没有的连续新字（「允许重复，禁止发明」）。
 *
 * 两条都**只产证据、不改判**：op 照出，人自己看。
 *
 * @param {string} before 原文
 * @param {string} after 改后文本
 * @returns {string[]} 警告（人话）
 */
export function factWarnings(before, after) {
  const check = factCheck(before, after);
  /** @type {string[]} */
  const warnings = [];
  if (check.missingNumbers.length > 0) {
    warnings.push(`丢了 ${check.missingNumbers.length} 个数字：${previewList(check.missingNumbers)}`);
  }
  if (check.missingTerms.length > 0) {
    warnings.push(`消失的片段：${previewList(check.missingTerms)}`);
  }
  if (check.lengthRatio < 1) {
    const percent = Math.round(check.lengthRatio * 100);
    // 正常去冗余变短不报警；只有压得极狠时才附一句提醒。
    // ⚠ 这里**不能 return**：下面还有自足 / 新增片段两条证据要追加。
    if (percent < 100) {
      warnings.push(check.lengthRatio < LOW_LENGTH_RATIO ? `压缩到 ${percent}%（留意是否过度缩写）` : `压缩到 ${percent}%`);
    }
  }
  if (selfContained(after, anchorsOf([before])).ok !== true) warnings.push(missingSubjectWarning(after));
  const added = addedTerms(before, after);
  if (added.length > 0) warnings.push(addedTermsWarning(added));
  return warnings;
}

/**
 * 「这块可能缺主语」的人话警告（用户原话：「会被理解为某个全局边界，这很危险」）。
 *
 * @param {unknown} text 待判的块
 * @returns {string} 警告文案
 */
function missingSubjectWarning(text) {
  return `这块可能缺主语：${shorten(String(text ?? ''))}（脱离上下文会被读成全局）`;
}

/**
 * 「新增了原文没有的片段」的人话警告（「允许重复，禁止发明」）。
 *
 * @param {string[]} added 新增片段
 * @returns {string} 警告文案
 */
function addedTermsWarning(added) {
  return `新增了原文没有的片段：${previewList(added)}（可能是模型自己加的）`;
}

/**
 * 拼「一组记忆 → 一张变更单」的请求。
 *
 * 提示词里会点出这一组里哪些是「大段」（`grindCandidate` 判定，与旧研磨同一口径），
 * 让模型优先考虑 `split`，而不是让它在长文上自由发挥。
 *
 * `emphasis` 只决定**提示词的侧重**（见 `EMPHASIS_ALL` / `EMPHASIS_DEDUPE`），不改变 op 的种类、
 * 校验口径或任何落库语义：`'dedupe'` 时把 `DEDUPE_EMPHASIS_PROMPT` 追加到系统提示词末尾，
 * 并把「大段」那句提示从「优先 split」改成「偏重合并、不为了拆而拆」。省略 = `'all'`（现状）。
 *
 * @param {{members?: {id: string, text: string}[], minChars?: number, splitChars?: number, emphasis?: 'all'|'dedupe'}} [input] 一组记忆 + 侧重
 * @returns {{messages: {role: string, content: string}[], temperature: number, maxTokens: number}} 请求
 */
export function buildPlanRequest({ members = [], minChars = 240, splitChars = DEFAULT_SPLIT_CHARS, emphasis = EMPHASIS_ALL } = {}) {
  const list = (Array.isArray(members) ? members : []).map((member) => ({
    id: String(member?.id ?? ''),
    text: String(member?.text ?? ''),
  }));
  const limit = Math.max(20, Number(splitChars) || DEFAULT_SPLIT_CHARS);
  const threshold = Math.max(1, Number(minChars) || 1);
  const big = list
    .filter((member) => grindCandidate({ text: member.text, meta: {} }, { minChars: threshold, redo: true }).candidate === true)
    .map((member) => member.id);

  const dedupe = emphasis === EMPHASIS_DEDUPE;
  const body = list.map((member) => `[${member.id}] ${member.text}`).join('\n');
  const hint =
    big.length === 0
      ? '这一组里没有明显的大段记忆。'
      : dedupe
        ? `其中「大段」（≥ ${threshold} 字）的是：${big.join('、')} —— 本轮偏重去重合并，**别为了拆而拆**（确实又长又该拆的才拆），单块尽量不超过 ${limit} 字。`
        : `其中「大段」（≥ ${threshold} 字）的是：${big.join('、')} —— 优先考虑 split，单块尽量不超过 ${limit} 字。`;
  return {
    messages: [
      { role: 'system', content: dedupe ? `${PLAN_PROMPT}\n\n${DEDUPE_EMPHASIS_PROMPT}` : PLAN_PROMPT },
      {
        role: 'user',
        content: `下面是这一组记忆（共 ${list.length} 条）。${hint}\n<记忆>\n${body}\n</记忆>`,
      },
    ],
    temperature: 0,
    maxTokens: 2000,
  };
}

/**
 * 从模型输出里抠出变更单操作数组（其余文字一律忽略，非法项丢弃）。
 *
 * 只做**形状**校验（type / targets / after），不做 id 归属与无损核对 —— 那是
 * `normalizePlanOps()` 的事。
 *
 * ⚠️ **兼容旧输出**：`'rewrite'` 是旧提示词时期的类型，这里**照收**，由 `normalizePlanOps()`
 * 一律归一成 `'replace'`（「删旧录新」）—— 系统里**没有**「原地改写同一条」这条路径。
 *
 * @param {unknown} raw 模型输出
 * @returns {{type: string, targets: string[], after: unknown, reason: string}[]} 原始操作
 */
export function parsePlanOps(raw) {
  if (typeof raw !== 'string') return [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (match == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  /** @type {{type: string, targets: string[], after: unknown, reason: string}[]} */
  const out = [];
  for (const item of parsed) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = String(item.type ?? '').trim().toLowerCase();
    if (!['split', 'replace', 'rewrite', 'merge', 'drop'].includes(type)) continue;
    const targets = uniqueStrings(Array.isArray(item.targets) ? item.targets : [item.targets ?? item.id]);
    if (targets.length === 0) continue;
    out.push({
      type,
      targets,
      after: item.after,
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    });
  }
  return out;
}

/**
 * 把原始操作整形为**可审阅的 op**：补 `before` 正文、跑证据（自足 / 不丢内容 / 不新增）、写 `warnings`。
 *
 * 规则（与用户拍板的语义一一对应）：
 * - `targets` 只保留这一组里真实存在的 id；
 * - `split` 只认单条目标，跑三条证据：①每块自足（`anchorsOf()` + `selfContained()`）
 *   ②不丢内容（`factCheck()` 的数字 / 消失片段）③不新增信息（`addedTerms()`）；
 *   **不再要求「逐字无损 / 子序列」**（为了自足而重复主语词天然不是子序列）；
 *   `losslessSplit()` 只在模型没给可用碎片 / 只给了一块时**兜底**（该 op 带 `fallback: true`
 *   这个**结构化标记**，供服务计数 / 面板判定；**别拿 `warnings.length` 去判兜底** ——
 *   缺主语 / 新增片段 / 消失的片段都只是证据）；拆不开（只剩一块）**不出这条 op**；
 * - `replace`（**唯一修改操作**，旧的 `rewrite` 一律归一到它）跑 `factWarnings()`：丢数字 /
 *   消失的片段 / 压缩比 / 缺主语 / 新增片段写成警告 —— **不改判**，缩写、去冗余、优化语序、
 *   同义换词都不算问题，op 照样出；after 与原文**一字不差**（抹掉空白后相同）的 replace 直接丢弃
 *   （没有变更就不是变更；落库侧也靠这一口径避免「新正文撞上原条 hash」）；
 * - `merge` 只有一条目标时按 `replace` 处理（"纯修改"）；
 * - `after` 为空的 replace / merge 直接丢弃（没有内容就不是变更）；
 * - **`drop` 必须带理由**：`reason` 为空 / 空白的删除**照出这条 op**、但打上 `reasonMissing: true`，
 *   并把「没写理由」写进 `warnings` —— 立即可见的证据，且**应用侧一律跳过它**（见 `reviewKeeperPlan()`）。
 *   为什么不直接丢掉这条 op：人要看得到"模型想删什么、却没给理由"，悄悄丢掉才是真的危险。
 *
 * @param {unknown} raw 模型输出
 * @param {{members?: {id: string, text: string}[], splitChars?: number, minChars?: number}} [options] 这一组的成员
 * @returns {object[]} 操作数组（`{idx, type, targets, before, after, reason, warnings}`；**split 另有 `fallback`、drop 另有 `reasonMissing`**）
 */
export function normalizePlanOps(raw, { members = [], splitChars = DEFAULT_SPLIT_CHARS, minChars = 240 } = {}) {
  const byId = new Map(
    (Array.isArray(members) ? members : []).map((member) => [String(member?.id ?? ''), String(member?.text ?? '')]),
  );
  byId.delete('');
  const limit = Math.max(20, Number(splitChars) || DEFAULT_SPLIT_CHARS);

  /** @type {object[]} */
  const ops = [];
  for (const item of parsePlanOps(raw)) {
    const targets = item.targets.filter((id) => byId.has(id));
    if (targets.length === 0) continue;

    if (item.type === 'drop') {
      const reason = String(item.reason ?? '').trim();
      ops.push({
        idx: ops.length,
        type: 'drop',
        targets,
        before: targets.map((id) => ({ id, text: byId.get(id) })),
        after: '',
        reason,
        // 用户 2026-10-07：「仓管对整理记忆提出『删除』时必须附带理由」「仓管禁止触碰删除功能本身」。
        // 两句合起来就是这条口径：**没理由的删除不是"少写一句话"，而是一条永远不会生效的建议** ——
        // 这里打上结构化标记（服务/面板认它，别去猜 warnings 文案），`reviewKeeperPlan()` 的 drop
        // 分支见到它就跳过（人在面板上勾了也跳过，如实记 skipped）。
        reasonMissing: reason === '',
        warnings: reason === '' ? [NO_REASON_WARNING] : [],
      });
      continue;
    }

    if (item.type === 'replace' || item.type === 'rewrite' || item.type === 'merge') {
      const after = typeof item.after === 'string'
        ? item.after.trim()
        : Array.isArray(item.after)
          ? item.after.map((piece) => String(piece ?? '').trim()).filter((piece) => piece !== '').join('\n')
          : '';
      if (after === '') continue;
      // 「merge 也可能只有一条 targets，那是纯修改」；旧 `rewrite` 也归一到 `replace` ——
      // 用户定的统一修改语义是**删旧录新**，系统里没有「原地改写同一条」这条路径。
      const type = item.type === 'merge' && targets.length >= 2 ? 'merge' : 'replace';
      const kept = type === 'merge' ? targets : [targets[0]];
      const before = kept.map((id) => ({ id, text: byId.get(id) }));
      // merge 的要点来自**每一条**被并的记忆，所以事实证据拿它们的并集比。
      const beforeText = type === 'merge' ? before.map((row) => row.text).join('\n') : before[0].text;
      // 与原文一字不差（抹掉空白后相同）= 没有变更：不出这条 op。
      // 这也是落库侧的安全前提 —— `addMemory` 按正文 hash 去重，若 after 撞上原条 hash，
      // 会回原条 id，接着「软删原条 + 用原条 id 当新记忆」就成了自删事故。
      if (stripSpace(after) === stripSpace(beforeText)) continue;
      ops.push({
        idx: ops.length,
        type,
        targets: kept,
        before,
        after,
        reason: item.reason,
        warnings: factWarnings(beforeText, after),
      });
      continue;
    }

    // split：只认单条目标。**不再跑「子序列覆盖率 ≥98%」的硬校验** ——
    // 每块自足允许重复原文主语词，重复出来的字符天然不是子序列。
    // 现在跑的是三条证据：①每块自足 ②不丢内容 ③不新增信息。
    const id = targets[0];
    const original = byId.get(id);
    const proposed = Array.isArray(item.after)
      ? item.after.map((piece) => String(piece ?? '').trim()).filter((piece) => piece !== '')
      : typeof item.after === 'string' && item.after.trim() !== ''
        ? [item.after.trim()]
        : [];
    /** @type {string[]} */
    const warnings = [];
    let fragments = proposed;
    // ⚠️ `fallback` 是给上层（服务计数 / 面板）用的**结构化标记**：split 现在还会带
    // 「缺主语 / 新增片段 / 消失的片段」等证据，按 `warnings.length` 判「有没有兜底」会全部误算。
    let fallback = false;
    // `losslessSplit()` 只作**兜底**：模型没给可用碎片、或只给了一块（拆不动）时才用。
    // 它是确定性切分，按构造不丢字、不新增；代价是它**不会补主语**，所以块可能缺主语 —— 那也会照报。
    if (proposed.length < 2) {
      const fallbackPieces = losslessSplit(original, { maxChars: limit });
      if (fallbackPieces.length > proposed.length) {
        fragments = fallbackPieces;
        fallback = true;
        warnings.push(`兜底切分（模型${proposed.length === 0 ? '没给可用碎片' : '只给了一块'}）`);
      }
    }
    if (fragments.length < 2) continue; // 拆不开：不出这条 op（免得变成一次无意义的改写）

    // ①每块自足：锚点取自**原文整条**（主语 / 对象 / 时间锚），逐块判。
    const anchors = anchorsOf([original]);
    for (const fragment of fragments) {
      if (selfContained(fragment, anchors).ok !== true) warnings.push(missingSubjectWarning(fragment));
    }
    // ③不新增：整份产出 vs 原文。允许重复原文里的词，禁止凭空造词。
    const joined = fragments.join('\n');
    const added = addedTerms(original, joined);
    if (added.length > 0) warnings.push(addedTermsWarning(added));
    // ②不丢内容：数字 / 内容片段照旧是证据（split 不报压缩比：重复主语会让总长变长，比对没意义）。
    const loss = factCheck(original, joined);
    if (loss.missingNumbers.length > 0) {
      warnings.push(`丢了 ${loss.missingNumbers.length} 个数字：${previewList(loss.missingNumbers)}`);
    }
    if (loss.missingTerms.length > 0) warnings.push(`消失的片段：${previewList(loss.missingTerms)}`);
    ops.push({
      idx: ops.length,
      type: 'split',
      targets: [id],
      before: [{ id, text: original }],
      after: fragments,
      reason: item.reason,
      warnings,
      fallback,
    });
  }
  return ops;
}

/**
 * 一张变更单里的全部警告（拍平成人话，带 `#序号` 前缀，供面板与工具直接显示）。
 *
 * @param {object[]} ops 操作数组
 * @returns {string[]} 警告列表
 */
export function planWarnings(ops) {
  /** @type {string[]} */
  const out = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    for (const warning of Array.isArray(op?.warnings) ? op.warnings : []) {
      out.push(`#${Number(op?.idx ?? 0) + 1} ${warning}`);
    }
  }
  return out;
}
