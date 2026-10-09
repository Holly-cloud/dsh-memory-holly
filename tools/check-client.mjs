/**
 * dsh-memory · 客户端束执行自检（**不是**单元测试，刻意不放在 `test/` 下：
 * `node --test test/` 会把 test/ 里所有文件当用例跑，这份脚本不该混进那 98 个用例里）。
 *
 * ## 它解决什么问题
 * `node --check lib/client.js` 只能证明「语法能被解析」。手写束最容易炸的地方全在运行时：
 *   * `window.__ModuleLoader__.load` 的 id 写错 → 模块表键、启动图行 id、路由 id 全对不上；
 *   * `factory` 忘了 `return module.exports` → 插件静默不激活；
 *   * 自注入 <style> 少了 `data-plugin*` → 卸载/HMR 时框架清不掉，样式越叠越多；
 *   * require 了冻结平台表之外的裸包 → 浏览器里直接 `Cannot find module`；
 *   * 忘记用 `--dsw-*` token 而写死颜色 → 深色主题下面板瞎掉。
 *
 * 所以这里用 vm 造一个最小的浏览器/模块环境，**真正把 lib/client.js 执行一遍**，
 * 再注入假 ctx 调 `apply`，最后把六个分页与主页面都函数式浅渲染一遍（只构造元素、不跑 effect）。
 *
 * 用法：`node tools/check-client.mjs`（退出码 0 = 全通过）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');
const source = readFileSync(clientPath, 'utf8');

/** 冻结平台表：客户端束只允许 require 这些种子模块（DESIGN §F）。 */
const FROZEN_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/** primitives 里本面板用到的导出（与 lib/client.js 顶部的解构一一对应）。 */
const PRIMITIVE_NAMES = [
  'Button',
  'StateDot',
  'Tag',
  'Input',
  'SegmentedTabs',
  'Checkbox',
  'Modal',
  'IconDatabaseOutlineRegular',
  'IconRefreshOutlineRegular',
  'IconSearchOutlineRegular',
  'IconPlusOutlineRegular',
  'IconTrashOutlineRegular',
  'IconCheckOutlineRegular',
  'IconWarningOutlineRegular',
  'IconClockOutlineRegular',
  'IconSettingsOutlineRegular',
  'IconLoadingOutlineRegular',
];

/** 结果收集。 */
const results = [];
/**
 * 记一条断言。
 * @param {string} name 断言名。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 失败细节。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true, detail });
}
/**
 * 跑一段可能抛错的代码，把异常变成一条断言结果。
 * @param {string} name 断言名。
 * @param {() => unknown} run 待跑代码。
 * @returns {unknown} 返回值（抛错时返回 `undefined`）。
 */
function attempt(name, run) {
  try {
    const value = run();
    check(name, true);
    return value;
  } catch (error) {
    check(name, false, `${error?.name ?? 'Error'}: ${error?.message ?? error}`);
    return undefined;
  }
}

// ── 静态检查：require 的实参必须都在冻结平台表里 ───────────────────────────────
const requiredSpecifiers = [...source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
check(
  'require() 只使用冻结平台表',
  requiredSpecifiers.every((spec) => FROZEN_MODULES.includes(spec)),
  `实际用到：${requiredSpecifiers.join(', ')}`,
);
check('取数只用同源相对路径（无裸 http(s) fetch）', !/fetch\(\s*['"]https?:/i.test(source));
check('面板接口前缀是 /api/dsh-memory', source.includes("'/api/dsh-memory'"));

// ── 假 document：只实现客户端束真正用到的三个能力 ────────────────────────────
/** @type {{dataset: Record<string, string>, textContent: string, tagName: string}[]} */
const insertedStyles = [];
const fakeDocument = {
  /**
   * 只支持 `style[data-plugin-css="…"]` 这一种选择器（去重查询用）。
   * @param {string} selector 选择器。
   * @returns {object|null} 命中的节点。
   */
  querySelector(selector) {
    const match = /data-plugin-css="([^"]+)"/.exec(selector);
    if (match === null) return null;
    return insertedStyles.find((node) => node.dataset.pluginCss === match[1]) ?? null;
  },
  /**
   * 造一个极简元素（只要 dataset / textContent）。
   * @param {string} tagName 标签名。
   * @returns {object} 元素。
   */
  createElement(tagName) {
    return { tagName, dataset: {}, textContent: '' };
  },
  head: {
    /**
     * 记录被插入的 <style>。
     * @param {object} node 节点。
     */
    appendChild(node) {
      insertedStyles.push(node);
    },
  },
};

// ── 假 React：模块加载阶段只用到 createElement 等构造器 ───────────────────────
// 浅渲染时 useState/useEffect/useRef/useCallback 必须存在；useEffect 刻意**不执行**回调，
// 这样渲染是纯构造，不会真的发 fetch。
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('react.fragment'),
  /**
   * 状态队列：浅渲染时把想要的初始状态先塞进来，就能让 `useState` 交出指定值。
   * MemoryPage 只有一个 `useState`（当前分页），所以这里可以精确地「切分页」。
   */
  __stateQueue: [],
  useState(initial) {
    const seeded = fakeReact.__stateQueue.shift();
    return [seeded === undefined ? (typeof initial === 'function' ? initial() : initial) : seeded, () => {}];
  },
  useEffect: () => {},
  useRef: (initial) => ({ current: initial ?? null }),
  useCallback: (fn) => fn,
};

/** 假 primitives：每个导出都是一个可被 createElement 引用的组件函数。 */
const fakePrimitives = {};
for (const name of PRIMITIVE_NAMES) fakePrimitives[name] = () => null;

/** 记录被 require 的模块，便于断言。 */
const requireLog = [];
/**
 * 假 require：只发冻结平台表里的模块，别的直接抛（模拟浏览器里的解析失败）。
 * @param {string} spec 模块名。
 * @returns {object} 模块。
 */
function fakeRequire(spec) {
  requireLog.push(spec);
  if (!FROZEN_MODULES.includes(spec)) throw new Error(`Cannot find module '${spec}'`);
  if (spec === 'react') return fakeReact;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives;
  throw new Error(`冻结表里有、但本自检没有提供替身的模块：${spec}`);
}

// ── 真正执行 lib/client.js ───────────────────────────────────────────────────
/** @type {{id?: string, factory?: Function}|null} */
let loaded = null;
let fetchCalls = 0;
const sandbox = {
  window: {
    __ModuleLoader__: {
      /**
       * 捕获模块协议调用。
       * @param {{id: string, factory: Function}} spec 模块描述。
       */
      load(spec) {
        loaded = spec;
      },
    },
  },
  document: fakeDocument,
  console,
  AbortController,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  /**
   * 加载阶段不该有任何网络行为；真发了就记下来。
   * @returns {Promise<Response>} 永不返回。
   */
  fetch() {
    fetchCalls += 1;
    return Promise.reject(new Error('自检禁止真实网络请求'));
  },
};
const context = createContext(sandbox);

attempt('lib/client.js 在最小浏览器环境里执行', () => runInContext(source, context, { filename: clientPath }));
check('调用了 window.__ModuleLoader__.load()', loaded !== null);
const spec = loaded ?? {};
check("模块 id === 'dsh-memory'（必须等于 package.json 的 name）", spec.id === 'dsh-memory', `实际 ${String(spec.id)}`);
check('load 收到 factory 函数', typeof spec.factory === 'function');
check('加载阶段没有发任何 fetch', fetchCalls === 0, `实际 ${fetchCalls} 次`);

// ── factory(require) 的返回值就是 exports ────────────────────────────────────
const exportsObject = typeof spec.factory === 'function' ? attempt('factory(require) 执行', () => spec.factory(fakeRequire)) : undefined;
check('factory 返回值是对象（不能省 return module.exports）', exportsObject !== null && typeof exportsObject === 'object');
check('exports.apply 是函数', typeof exportsObject?.apply === 'function');
check(
  "exports.inject 含 'slots' 与 'locale'（浏览器端服务名）",
  Array.isArray(exportsObject?.inject) &&
    exportsObject.inject.includes('slots') &&
    exportsObject.inject.includes('locale'),
  `实际 ${JSON.stringify(exportsObject?.inject ?? null)}`,
);
check('exports 标了 Symbol.toStringTag = Module', exportsObject?.[Symbol.toStringTag] === 'Module');
check(
  'factory 里的 require 只发了冻结平台表',
  requireLog.every((entry) => FROZEN_MODULES.includes(entry)),
  requireLog.join(', '),
);

// ── <style> 自注入 ───────────────────────────────────────────────────────────
check('插入了恰好一个 <style>', insertedStyles.length === 1, `实际 ${insertedStyles.length} 个`);
const styleNode = insertedStyles[0] ?? { dataset: {}, textContent: '' };
check("style[data-plugin] === 'dsh-memory'", styleNode.dataset.plugin === 'dsh-memory', String(styleNode.dataset.plugin));
check(
  "style[data-plugin-css] === 'dsh-memory/panel.css'",
  styleNode.dataset.pluginCss === 'dsh-memory/panel.css',
  String(styleNode.dataset.pluginCss),
);
check('样式只读 --dsw-* token', styleNode.textContent.includes('--dsw-'));
check(
  '样式里没有写死颜色（#hex / rgb() / hsl()）',
  !/#[0-9a-f]{3,8}\b/i.test(styleNode.textContent) &&
    !/\brgba?\(/i.test(styleNode.textContent) &&
    !/\bhsla?\(/i.test(styleNode.textContent),
);
check('去重查询：再调一次 factory 不会插第二个 <style>', (() => {
  const before = insertedStyles.length;
  if (typeof spec.factory === 'function') spec.factory(fakeRequire);
  return insertedStyles.length === before;
})());

// ── 注入假 ctx 调 apply ──────────────────────────────────────────────────────
const registrations = [];
const injectedSlots = [];
const effects = [];
const localeNamespaces = new Map();
/** @type {Function|null} */
let boundT = null;

const fakeCtx = {
  /**
   * cordis effect：立即执行并收下注销器（真实运行时也是立刻跑一次）。
   * @param {() => unknown} callback 回调。
   * @param {string} [label] 名称。
   * @returns {void}
   */
  effect(callback, label) {
    const dispose = callback();
    effects.push({ label, dispose });
  },
  locale: {
    /**
     * 注册语言包。
     * @param {string} ns 命名空间。
     * @param {object} dictionaries 词典。
     * @returns {() => void} 注销器。
     */
    register(ns, dictionaries) {
      localeNamespaces.set(ns, dictionaries);
      return () => localeNamespaces.delete(ns);
    },
    /**
     * 绑定翻译函数。
     * @param {string} ns 命名空间。
     * @returns {(key: string) => string} t。
     */
    bind(ns) {
      boundT = (key) => {
        const dictionaries = localeNamespaces.get(ns) ?? {};
        return dictionaries.zh?.[key] ?? key;
      };
      return boundT;
    },
  },
  slots: {
    /**
     * 槽注入：槽由别的包声明，这里立刻回调（模拟槽已就绪）。
     * @param {string} name 槽名。
     * @param {() => unknown} callback 注册回调。
     * @returns {void}
     */
    inject(name, callback) {
      injectedSlots.push(name);
      callback();
    },
    /**
     * 槽注册。
     * @param {object} definition 注册项。
     * @param {Function} component 组件。
     * @returns {() => void} 注销器。
     */
    register(definition, component) {
      registrations.push({ definition, component });
      return () => {
        const at = registrations.findIndex((entry) => entry.definition === definition);
        if (at >= 0) registrations.splice(at, 1);
      };
    },
  },
};

attempt('apply(ctx) 不抛错', () => exportsObject?.apply(fakeCtx));
check('注入了 sidebar.panellist 与 main 两个槽', injectedSlots.includes('sidebar.panellist') && injectedSlots.includes('main'), injectedSlots.join(', '));
check('注册了 2 个槽位条目', registrations.length === 2, `实际 ${registrations.length}`);

const sidebar = registrations.find((entry) => entry.definition?.name === 'sidebar.panellist');
const main = registrations.find((entry) => entry.definition?.name === 'main');
check("sidebar.panellist 注册项 id === 'memory' 且 order === 30", sidebar?.definition?.id === 'memory' && sidebar?.definition?.order === 30);
check("sidebar.panellist 带 locale: 'memory'", sidebar?.definition?.locale === 'memory');
check('sidebar label 回调返回面板名', typeof sidebar?.definition?.label === 'function' && sidebar.definition.label() === '记忆');
check("main 注册 key === 'memory' 且带 locale", main?.definition?.key === 'memory' && main?.definition?.locale === 'memory');
check('两个组件都是函数', typeof sidebar?.component === 'function' && typeof main?.component === 'function');

check("注册了语言命名空间 'memory'", localeNamespaces.has('memory'));
const dictionaries = localeNamespaces.get('memory') ?? {};
const zhKeys = Object.keys(dictionaries.zh ?? {}).sort();
const enKeys = Object.keys(dictionaries.en ?? {}).sort();
check('zh / en 词典非空', zhKeys.length > 0 && enKeys.length > 0, `zh ${zhKeys.length} 键 / en ${enKeys.length} 键`);
check('zh / en 词典键集合一致（缺一个就会回落到原文）', JSON.stringify(zhKeys) === JSON.stringify(enKeys));
check('绑定出的 t 能取到中文文案', boundT !== null && boundT('panel') === '记忆', String(boundT?.('panel')));
/** 源码里以字面量出现的键（`t(动态键)` 抓不到，那类由 PLAN_STATE_KEY 之类的表统一管）。 */
const literalKeys = [
  ...new Set([...source.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g)].map((match) => match[1])),
];
const missingKeys = literalKeys.filter(
  (key) => !Object.prototype.hasOwnProperty.call(dictionaries.zh ?? {}, key),
);
check(
  "源码里每个 t('键') 都在词典里（缺键不抛错，但会把键名原样画到界面上）",
  missingKeys.length === 0,
  missingKeys.join(', '),
);

// effect 的注销器必须可调用：卸载/HMR 时框架会挨个调。
check(
  '所有 effect 都返回了可调用的注销器',
  effects.length >= 1 && effects.every((entry) => typeof entry.dispose === 'function'),
  effects.map((entry) => String(entry.label)).join(', '),
);

// ── 浅渲染冒烟：六个分页 + 主页面都要能构造出元素树 ───────────────────────────
// 只调函数组件构造元素（`useEffect` 是 no-op，因此不会触发任何 fetch）。
// 这一步能抓住「渲染分支里写错字段名」「用了 undefined 的 primitive」这类只在渲染时炸的问题。
const t = boundT ?? ((key) => key);

/**
 * 展平一棵元素树（含数组 children 与 null 兄弟）。
 * @param {unknown} node 根节点。
 * @returns {object[]} 所有元素节点。
 */
function flattenTree(node) {
  const out = [];
  (function walk(current) {
    if (current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current !== 'object' || current.type === undefined) return;
    out.push(current);
    for (const child of current.children ?? []) walk(child);
  })(node);
  return out;
}

/** 主页面在最外层注册表里（`main` 槽），拿它去驱动分页。 */
const MainComponent = main?.component;

/**
 * 用一个指定的分页渲染主页面，并把该分页组件也真的调一遍。
 * @param {string} tabValue 分页值（overview/search/list/review/keeperQueue/settings）。
 * @returns {{tree: object, nodes: object[], panelComponent: Function|null}} 渲染产物。
 */
function renderTab(tabValue) {
  fakeReact.__stateQueue = [tabValue];
  const tree = MainComponent({ t });
  const nodes = flattenTree(tree);
  const panel = nodes.find((node) => node.props?.role === 'tabpanel');
  const child = (panel?.children ?? []).find((node) => node !== null && typeof node === 'object' && typeof node.type === 'function');
  // 分页组件此刻再单独调一次：这时状态队列已空，它用自己的初始状态渲染。
  const rendered = child === undefined ? null : child.type(child.props);
  return { tree, nodes, tabNodes: flattenTree(rendered), panelComponent: child === undefined ? null : child.type };
}

const tabValues = ['keeper', 'side', 'search', 'settings'];
const renderedTabs = {};
for (const tabValue of tabValues) {
  attempt(`浅渲染分页「${tabValue}」不抛错`, () => {
    renderedTabs[tabValue] = renderTab(tabValue);
  });
}
check('四个分页都拿到了组件（待办页已按用户要求移除）', tabValues.every((value) => typeof renderedTabs[value]?.panelComponent === 'function'));

const mainRender = renderedTabs.keeper ?? { nodes: [], tree: null };
const types = mainRender.nodes.map((node) => node.type);
check('主页面用了 SegmentedTabs（受控分页）', types.includes(fakePrimitives.SegmentedTabs));
const tabsProps = mainRender.nodes.find((node) => node.type === fakePrimitives.SegmentedTabs)?.props ?? {};
check(
  'SegmentedTabs 有 4 个分页（仓管 / 副仓管 / 搜索 / 设置）、value/onChange 齐全，且**没有「待办」**',
  Array.isArray(tabsProps.items) &&
    tabsProps.items.length === 4 &&
    tabsProps.items.map((item) => item.value).join(',') === 'keeper,side,search,settings' &&
    !tabsProps.items.some((item) => String(item.label).includes('待办')) &&
    typeof tabsProps.onChange === 'function' &&
    tabsProps.value === 'keeper',
  `items=${Array.isArray(tabsProps.items) ? tabsProps.items.map((i) => i.value).join(',') : 'n/a'} value=${String(tabsProps.value)}`,
);
check(
  '分页面板 id / role / aria 标注齐全',
  tabValues.every((value) => renderedTabs[value]?.nodes.some((node) => node.props?.role === 'tabpanel' && node.props?.id === 'dshm-panel-' + value)),
);
/**
 * 本插件用到的 `--dsw-font-*` token 白名单。
 *
 * ⚠️ 这些名字是**从平台 UI 包里逐字核对过**的（解析 `app.asar` 头、扫 150 个
 * `@deepseek-ai/dsh-client-ui-*` 文件，`--dsw-font-*` 共 185 个真实名字）。
 * 加新名字前请同样核对一次 —— **编一个不存在的 token 不会报错，只会静默失效**
 * （`font-size:var(--dsw-font-typo-99)` 整条声明失效、字号悄悄继承父级，这正是
 * 「大标题小标题长得一样」那类问题的来源）。
 */
const FONT_TOKEN_ALLOWLIST = [
  '--dsw-font-family',
  '--dsw-font-xxs-12-font-size',
  '--dsw-font-s-14-font-family',
  '--dsw-font-s-14-font-size',
  '--dsw-font-s-14-line-height',
  '--dsw-font-l-20-font-family',
  '--dsw-font-l-20-font-size',
  '--dsw-font-l-20-line-height',
  '--dsw-font-base-strong-16-font-family',
  '--dsw-font-base-strong-16-font-size',
  '--dsw-font-base-strong-16-line-height',
  '--dsw-font-base-strong-16-font-weight',
  '--dsw-font-xs-strong-13-font-family',
  '--dsw-font-xs-strong-13-font-size',
  '--dsw-font-xs-strong-13-line-height',
  '--dsw-font-xs-strong-13-font-weight',
];
const usedFontTokens = [...new Set([...styleNode.textContent.matchAll(/--dsw-font[A-Za-z0-9-]*/g)].map((m) => m[0]))];
check(
  '样式里的 --dsw-font-* 全在已核对的白名单里（编名字不会报错，只会静默失效）',
  usedFontTokens.every((token) => FONT_TOKEN_ALLOWLIST.includes(token)),
  usedFontTokens.filter((token) => !FONT_TOKEN_ALLOWLIST.includes(token)).join(', '),
);
check(
  '标题阶梯拉得开：页面标题 20px/600 · 卡片标题 16px 强档 · 分组标题 600 + 主色',
  /\.dshm-title\{[^}]*font-size:var\(--dsw-font-l-20-font-size\)/.test(styleNode.textContent) &&
    /\.dshm-title\{[^}]*font-weight:600/.test(styleNode.textContent) &&
    /\.dshm-cardtitle\{[^}]*font-size:var\(--dsw-font-base-strong-16-font-size\)/.test(styleNode.textContent) &&
    /\.dshm-group-title\{[^}]*font-weight:600/.test(styleNode.textContent) &&
    // 旧写法（页面标题用 m-18、卡片标题只给 font-weight）已经不再出现。
    !/\.dshm-title\{[^}]*font-size:var\(--dsw-font-m-18/.test(styleNode.textContent) &&
    !/\.dshm-cardtitle\{font-weight:500\}/.test(styleNode.textContent),
);
check(
  '默认页是「仓管」；「指标格」这种东西整块不存在（组件与 CSS 都已删，不许复活）',
  (() => {
    const tabNodes = renderedTabs.keeper?.tabNodes ?? [];
    const hasMetricsGrid = tabNodes.some((node) => node.props?.className === 'dshm-metrics');
    return tabNodes.length > 0 && !hasMetricsGrid && !/dshm-metric/.test(styleNode.textContent);
  })(),
);

// ── 宽度：三个页签必须一样宽（用户报「不同页签的界面宽度不统一」） ─────────────
// 机制：`max-width` 原来挂在**滚动容器** `.dshm-root` 上。高页签（设置）出现纵向滚动条时
// 内容宽被吃掉约 15px，低页签没有 → 切页签时卡片边缘左右跳。
// 现在：滚动条槽位恒定（`scrollbar-gutter:stable`）+ 宽度上限挪到内层 `.dshm-col`。
check(
  '滚动容器不再挂 max-width，且滚动条槽位恒定（切页签宽度不再跳）',
  /\.dshm-root\{[^}]*scrollbar-gutter:stable/.test(styleNode.textContent) &&
    !/\.dshm-root\{[^}]*max-width/.test(styleNode.textContent),
);
check('宽度上限挂在内容列 .dshm-col 上', /\.dshm-col\{[^}]*max-width:1120px/.test(styleNode.textContent));
check(
  '三个页签都渲染在同一个 .dshm-col 内容列里',
  tabValues.every((value) => {
    const nodes = renderedTabs[value]?.nodes ?? [];
    const col = nodes.find((node) => node.props?.className === 'dshm-col');
    return col !== undefined && flattenTree(col).some((node) => node.props?.role === 'tabpanel');
  }),
);

// 交互回调冒烟：把每个节点的 onClick/onChange/onKeyDown 都同步调一遍。
// 浅渲染不会执行这些函数（它们只在人点的时候跑），而最常见的「渲染没事、一点就炸」
// 就是回调里写错变量名。取数回调会走到沙箱里的假 fetch（返回 rejected Promise 并被
// 组件自己的错误分支接住），因此这里只断言「同步调用不抛」。
for (const tabValue of tabValues) {
  attempt(`分页「${tabValue}」的交互回调同步调用不抛错`, () => {
    for (const node of renderedTabs[tabValue]?.tabNodes ?? []) {
      for (const name of ['onClick', 'onChange', 'onKeyDown']) {
        const handler = node.props?.[name];
        if (typeof handler !== 'function') continue;
        if (name === 'onChange') handler({ target: { value: 'probe', checked: true } });
        else if (name === 'onKeyDown') handler({ key: 'Enter' });
        else handler();
      }
    }
  });
}

// ── 仓管页数据态：默认是「读流水」，只有待确认的行才出现按钮 ─────────────
// 这一页的设计口径（用户当面定的）：平时零可操作控件；通过 / 驳回 只在「等你确认」出现。
// （原来那页「待办」（抽取待审区）已按用户要求整页移除，所以这里只剩仓管 + 副仓管这两页的探针。）
const TODO_DONE_PLAN = {
  id: '11111111-1111-1111-1111-111111111111',
  state: 'approved',
  runId: 'run-probe-1',
  seedId: 'aaaaaaaa-0000-0000-0000-000000000001',
  createdAt: '2026-10-07T05:15:00.000Z',
  memberIds: ['bbbbbbbb-0000-0000-0000-000000000001'],
  ops: [
    {
      idx: 0,
      type: 'merge',
      targets: ['bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'],
      before: [{ id: 'bbbbbbbb-0000-0000-0000-000000000001', text: '原文一' }],
      after: '合并后的正文',
      reason: '探针',
      warnings: [],
    },
  ],
};
const TODO_OPEN_PLAN = { ...TODO_DONE_PLAN, id: '22222222-2222-2222-2222-222222222222', state: 'open' };

// 两页各有一个组件：`keeper` = 仓管（变更单 / 跑一轮 / 已处理流水），
// `side` = **副仓管**（原副审阅区：队列 + 那个独立角色用哪个模型）。
// 原来那页 `todo`（抽取待审区）已按用户要求**整页移除** —— 宿主路由与工具都还在。
const sideTab = renderedTabs.side?.panelComponent ?? null;
const keeperTab = renderedTabs.keeper?.panelComponent ?? null;

/** 浅渲染时用的「副仓管模型」候选（与 /keeper 的 profiles + hostModel 现算出来的那份同形）。 */
const SIDE_OPTIONS = [
  { value: 'auto', label: t('takerAuto') },
  { value: '线上', label: '线上 / qwen-plus' },
  { value: 'host', label: t('takerHost') + ' / host-x' },
];

/**
 * 浅渲染**仓管页**。
 * 状态顺序（`useState` 的先后）：1 plans / 2 keeperJob / 3 runBusy / 4 open /
 * 5 pending / 6 notice / 7 actionError / 8 nonce / 9 progressAt。
 * @param {object[]} plans 变更单列表。
 * @param {object|null} [keeperJob] 仓管任务进度。
 * @param {object} [open] 展开态（键 `plan:<id>` / `run:<runId>` / `done`）。
 * @param {number} [progressAt] 最近一次进展的时刻。
 * @returns {object[]} 展平后的元素节点。
 */
function renderKeeperTab(plans, keeperJob = null, open = {}, progressAt = 0) {
  const queue = [{ status: 'ready', items: plans }, keeperJob, false, open];
  while (queue.length < 9) queue.push(undefined);
  queue[8] = progressAt;
  fakeReact.__stateQueue = queue;
  return flattenTree(keeperTab({ t }));
}

/**
 * 浅渲染**副仓管页**。
 * 状态顺序（`useState` 的先后）：1 keeper / 2 handoffs / 3 pending / 4 notice / 5 actionError /
 * 6 nonce / 7 sideJob。
 * @param {object[]|object} [handoffs] 队列（或直接给状态对象验错误分支）。
 * @param {object|null} [keeper] `/keeper` 的响应（含 `side` / `options`）—— 省略 = 用默认那份。
 * @param {object|null} [sideJob] 副仓管自己的运行状态（`keeperStatus().sideJob`）。
 * @returns {object[]} 展平后的元素节点。
 */
function renderSideTab(handoffs = [], keeper = null, sideJob = null) {
  const body = keeper ?? { status: 'ready', side: null, options: SIDE_OPTIONS, hostModel: 'host-x', profiles: [] };
  const queue = [
    body,
    Array.isArray(handoffs) ? { status: 'ready', items: handoffs } : handoffs,
    '',
    '',
    '',
    0,
    sideJob,
  ];
  fakeReact.__stateQueue = queue;
  return flattenTree(sideTab({ t }));
}

/** 数一数「children 里正好有这个文案」的节点有几个。 */
const countText = (nodes, label) =>
  nodes.filter((node) => (node.children ?? []).some((child) => child === label)).length;
/**
 * `Modal` 的 `footer` 与 `Card` 的 `action` / `title` 一样是 **prop**、不走 children，
 * 所以 `countText` 看不见它们 —— 要单独展平。（`Modal` 是假 primitive：元素节点本身
 * 就在树里，它的 children 会被 `flattenTree` 走到，但 footer 不会。）
 * @param {object|undefined} node 元素节点。
 * @param {string} key prop 名。
 * @returns {object[]} 那棵 prop 子树展平后的节点。
 */
const propTree = (node, key) => flattenTree(node?.props?.[key] ?? null);
/** 找弹窗节点。 */
const modalNode = (nodes) => nodes.find((node) => node.type === fakePrimitives.Modal);
/** 数一数某类元素有几个（如弹窗里的「一行参数」）。 */
const countClass = (nodes, className) => nodes.filter((node) => node.props?.className === className).length;
/** 「已处理」那一块在 `open` 里的键（与 client.js 的 `DONE_OPEN_KEY` 同值）。 */
const DONE_KEY = 'done';

const keeperIdle =
  attempt('浅渲染仓管页（只有已处理）不抛错', () => (keeperTab === null ? [] : renderKeeperTab([TODO_DONE_PLAN]))) ?? [];
check(
  '仓管页：只有已处理时，一个「通过 / 驳回」都不画（平时零可操作控件）',
  countText(keeperIdle, t('todoPass')) === 0 && countText(keeperIdle, t('todoReject')) === 0,
  `pass=${countText(keeperIdle, t('todoPass'))} reject=${countText(keeperIdle, t('todoReject'))}`,
);
// 用户 2026-10-07：「『已处理』内容收起来」——默认只占一行卡片按钮，轮数写在那一行上。
check(
  '仓管页：「已处理」默认**收成一行卡片按钮**（轮数在那一行；流水一行都不铺）',
  (() => {
    // ⚠️ `textLeaves()` 定义在本文件靠后（TDZ）——这里就地取字符串叶子，别调它。
    const leaves = keeperIdle.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string');
    const toggle = keeperIdle.find((node) => node.props?.className === 'dshm-cardtoggle');
    return (
      leaves.includes(t('todoDone')) &&
      leaves.includes(t('todoDoneRounds').replace('{n}', '1')) &&
      !leaves.some((text) => text.includes('1 张单')) &&
      typeof toggle?.props?.onClick === 'function'
    );
  })(),
  (() => {
    const leaves = keeperIdle.flatMap((node) => node.children ?? []).filter((child) => typeof child === 'string');
    return JSON.stringify(leaves.slice(0, 6));
  })(),
);
const keeperDoneOpenList =
  attempt('浅渲染仓管页（「已处理」点开）不抛错', () =>
    keeperTab === null ? [] : renderKeeperTab([TODO_DONE_PLAN], null, { done: true }),
  ) ?? [];
check(
  '仓管页：点开「已处理」之后，流水按轮次给出摘要（几张单 · 通过 / 驳回）',
  keeperDoneOpenList.some((node) => (node.children ?? []).some((child) => typeof child === 'string' && child.indexOf('1 张单') >= 0)),
);
const keeperWaiting =
  attempt('浅渲染仓管页（1 张待确认）不抛错', () =>
    keeperTab === null ? [] : renderKeeperTab([TODO_OPEN_PLAN, TODO_DONE_PLAN]),
  ) ?? [];
check(
  '仓管页：待确认的变更单只画一组「通过 / 驳回」',
  countText(keeperWaiting, t('todoPass')) === 1 && countText(keeperWaiting, t('todoReject')) === 1,
  `pass=${countText(keeperWaiting, t('todoPass'))} reject=${countText(keeperWaiting, t('todoReject'))}`,
);
// 用户 2026-10-07：「为所有待审记忆改动新增按钮『转手』」—— 每个待审行都要有，且只在待审行上。
check(
  '仓管页：每张**待审**变更单多一个「转手」（通过 / 驳回 / 转手 三个动作，都有 onClick）',
  (() => {
    const buttons = keeperWaiting.filter((node) => (node.children ?? []).some((child) => child === t('planHandoff')));
    return (
      buttons.length === 1 &&
      buttons.every((node) => typeof node.props?.onClick === 'function') &&
      countText(keeperWaiting, t('todoPass')) === 1
    );
  })(),
  `handoff=${keeperWaiting.filter((node) => (node.children ?? []).some((c) => c === t('planHandoff'))).length}`,
);
check(
  '仓管页：已处理的单不再给「转手」（那是待审动作）',
  countText(keeperIdle, t('planHandoff')) === 0,
);
// 用户 2026-10-07：「副审阅区…独立建立页面『副仓管』」——队列整块搬到那一页去了。
check(
  '分家：仓管页不画副仓管的队列（接手 / 清掉 / 副仓管模型 都不在这一页）',
  countText(keeperWaiting, t('handoffStart')) === 0 &&
    countText(keeperWaiting, t('handoffDrop')) === 0 &&
    countText(keeperWaiting, t('sideModelLabel')) === 0,
);

// ── 展开态：点开一行必须能出详情（这里曾经整页白屏） ─────────────────────────
// 背景（2026-10-07 用户报「点击已处理的记录会白屏」）：改版时把旧的 `shortId` 定义
// 连同旧分区一起删了，`planDetail` 却还在调它。行**折叠时不渲染详情** → 自检全绿；
// 人一点开 → ReferenceError → React 卸载整棵树 = 白屏。
// 教训：只渲染初始（收起）态的自检，抓不到「一点就炸」。这里专门渲染展开态。
const TODO_DETAIL_PLAN = {
  ...TODO_DONE_PLAN,
  ops: [
    {
      idx: 0,
      type: 'merge',
      targets: ['bbbbbbbb-0000-0000-0000-000000000001'],
      before: [{ id: 'bbbbbbbb-0000-0000-0000-000000000001', text: '合并前的原文' }],
      after: '合并后的正文',
      warnings: ['丢了 1 个数字'],
    },
    { idx: 1, type: 'drop', targets: ['cccccccc-0000-0000-0000-000000000002'], before: [{ id: 'c', text: '被删掉的原文' }], after: null, reason: '与另一条一字不差，纯重复', warnings: [] },
    { idx: 2, type: 'split', targets: ['dddddddd-0000-0000-0000-000000000003'], before: [{ id: 'd', text: '待拆的原文' }], after: ['块一', '块二'], warnings: [] },
  ],
};

/** 展平树里所有字符串叶子（断言详情正文有没有真的画出来）。 */
const textLeaves = (nodes) => {
  const out = [];
  for (const node of nodes) {
    for (const child of node.children ?? []) if (typeof child === 'string') out.push(child);
  }
  return out;
};

const keeperDoneOpen =
  attempt('展开一条**已处理**记录不抛错（白屏回归）', () =>
    keeperTab === null
      ? []
      : renderKeeperTab([TODO_DETAIL_PLAN], null, {
          // 「已处理」整块**默认收起**（比一轮流水更外面一层），所以要先展开它、再展开这一轮、再展开这张单。
          [DONE_KEY]: true,
          ['run:' + TODO_DETAIL_PLAN.runId]: true,
          ['plan:' + TODO_DETAIL_PLAN.id]: true,
        }),
  ) ?? [];
/** 旧签名的包装（`renderTodoOpen(plans, batches, open, detail, keeperJob, progressAt, handoffs, pick)`）——
 * 仓管页不再管批次，也不再管副仓管队列；这里只把 `open` / `keeperJob` / `progressAt` 传给新签名。 */
function renderTodoOpen(plans, batches, open, detail, keeperJob = null, progressAt = undefined) {
  // 「已处理」这一整块现在**默认收起**；这些历史调用点看的都是它里面的东西，所以在包装里替它们展开。
  return renderKeeperTab(plans, keeperJob, { [DONE_KEY]: true, ...(open ?? {}) }, progressAt ?? 0);
}
check(
  '展开已处理记录：改动前 / 改动后 / 机器提示都画出来了',
  ['合并前的原文', '合并后的正文', t('kqBefore'), t('kqAfter'), '丢了 1 个数字', '被删掉的原文', '块一', '块二'].every(
    (label) => textLeaves(keeperDoneOpen).includes(label),
  ),
);
check(
  '展开已处理记录：目标 id 缩到 8 位（`shortId` 曾经被删掉，只有展开态才用到）',
  ['bbbbbbbb', 'cccccccc', 'dddddddd'].every((prefix) => textLeaves(keeperDoneOpen).includes(prefix)) &&
    !textLeaves(keeperDoneOpen).some((text) => text.includes('-0000-0000')),
  JSON.stringify(textLeaves(keeperDoneOpen)),
);
// 用户 2026-10-07：「为所有待审记忆改动新增按钮『转手』」——转手之后原单停在终态 `handed`。
check(
  '仓管页：转手之后原单的终态文案是「已转手」（不是「已驳回」——那会读成人否掉了方案）',
  (() => {
    // 流水默认收起：先把「已处理」整块和这一轮都展开，才看得到单行上的状态标签。
    const plan = { ...TODO_DONE_PLAN, state: 'handed' };
    const nodes = keeperTab === null ? [] : renderKeeperTab([plan], null, { [DONE_KEY]: true, ['run:' + plan.runId]: true });
    const leaves = textLeaves(nodes);
    return leaves.includes(t('todoHanded')) && !leaves.includes(t('todoRejected'));
  })(),
);
// 用户 2026-10-07：「让待审区的『改动前』『改动后』更显眼，便于审阅」。
// 旧写法是两个灰字标签 + 同一种正文样式，扫一眼分不清哪块是旧的、哪块是新的。
check(
  '待审区：改动前 / 改动后各自一个带色条的框（不是两个灰字标签）',
  (() => {
    const parts = keeperDoneOpen.filter((node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dshm-diff-part'));
    const classes = parts.map((node) => node.props.className);
    return classes.filter((value) => value === 'dshm-diff-part is-before').length === 3 &&
      classes.filter((value) => value === 'dshm-diff-part is-after').length === 3;
  })(),
  JSON.stringify(keeperDoneOpen.filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('dshm-diff')).map((n) => n.props.className)),
);
check(
  '待审区：两个标签是 13px 强档、前后不同色（后 = 成功色，前 = 次要色）',
  /\.dshm-diff-label\.is-before\{color:var\(--dsw-alias-label-secondary\)\}/.test(styleNode.textContent) &&
    /\.dshm-diff-label\.is-after\{color:var\(--dsw-alias-state-success-primary\)\}/.test(styleNode.textContent) &&
    /\.dshm-diff-part\.is-before\{border-left:3px solid/.test(styleNode.textContent) &&
    /\.dshm-diff-part\.is-after\{border-left:3px solid/.test(styleNode.textContent) &&
    /\.dshm-diff-label\{[^}]*font-size:var\(--dsw-font-xs-strong-13-font-size\)/.test(styleNode.textContent),
);
check(
  '待审区：标签带条数（改动前 2 条 / 改动后 3 块），多项 op 不必再数段落',
  (() => {
    const plan = {
      ...TODO_OPEN_PLAN,
      ops: [
        {
          idx: 0,
          type: 'merge',
          targets: ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'],
          before: [
            { id: 'a', text: '并前的第一条' },
            { id: 'b', text: '并前的第二条' },
          ],
          after: '并后的正文',
          warnings: [],
        },
        { idx: 1, type: 'split', targets: ['cccccccc-0000-0000-0000-000000000003'], before: [{ id: 'c', text: '待拆的正文' }], after: ['块一', '块二', '块三'], warnings: [] },
      ],
    };
    const leaves = textLeaves(keeperTab === null ? [] : renderTodoOpen([plan], [], { ['plan:' + TODO_OPEN_PLAN.id]: true }));
    return leaves.includes(t('kqBeforeN').replace('{n}', '2')) && leaves.includes(t('kqAfterN').replace('{n}', '3'));
  })(),
);
check(
  '待审区：单项 op 不加条数（「改动前 1 条」是噪声）',
  !textLeaves(keeperDoneOpen).some((text) => text === t('kqBeforeN').replace('{n}', '1') || text === t('kqAfterN').replace('{n}', '1')),
);
check(
  '待审区：定为删除的记忆**整块标红**（op 卡 / 操作行 / 改动前正文 / 标签 / 警示语全走 error 色）',
  /\.dshm-op\.is-drop\{border-color:var\(--dsw-alias-state-error-primary\)\}/.test(styleNode.textContent) &&
    /\.dshm-op\.is-drop \.dshm-op-line\{color:var\(--dsw-alias-state-error-primary\)\}/.test(styleNode.textContent) &&
    /\.dshm-op\.is-drop \.dshm-diff-text\{color:var\(--dsw-alias-state-error-primary\)\}/.test(styleNode.textContent) &&
    /\.dshm-op\.is-drop \.dshm-diff-label\{color:var\(--dsw-alias-state-error-primary\)\}/.test(styleNode.textContent) &&
    /\.dshm-diff-empty\{color:var\(--dsw-alias-state-error-primary\)\}/.test(styleNode.textContent) &&
    // 结构上真的挂上了：TODO_DETAIL_PLAN 三条 op 里只有 drop 那条带 is-drop。
    keeperDoneOpen.filter((node) => node.props?.className === 'dshm-op is-drop').length === 1 &&
    keeperDoneOpen.filter((node) => node.props?.className === 'dshm-op').length === 2,
);
check(
  '待审区：删除项的「它就是删除」用 error 色写出来（不再是最淡的灰）',
  keeperDoneOpen.some((node) => node.props?.className === 'dshm-diff-empty' && (node.children ?? []).includes(t('kqAfterEmpty'))),
);
check(
  '待审区：每条的「理由」都画出来（仓管提删除时必须解释为什么）',
  (() => {
    const leaves = textLeaves(keeperDoneOpen);
    return (
      leaves.includes(t('kqReason')) &&
      leaves.includes('与另一条一字不差，纯重复') &&
      keeperDoneOpen.filter((node) => node.props?.className === 'dshm-op-reason').length === 1
    );
  })(),
  JSON.stringify(textLeaves(keeperDoneOpen)),
);
check(
  '待审区：没写理由的删除 —— 挂 is-drop 标红 + 把「不会应用」当警告写出来',
  (() => {
    const plan = {
      ...TODO_OPEN_PLAN,
      ops: [
        {
          idx: 0,
          type: 'drop',
          targets: ['zzzzzzzz-0000-0000-0000-000000000009'],
          before: [{ id: 'z', text: '想删但没给理由的正文' }],
          after: null,
          reason: '',
          reasonMissing: true,
          warnings: ['这条删除没写理由：按口径一律不应用（要删就得说清楚为什么）'],
        },
      ],
    };
    const nodes = keeperTab === null ? [] : renderTodoOpen([plan], [], { ['plan:' + TODO_OPEN_PLAN.id]: true });
    return (
      nodes.some((node) => node.props?.className === 'dshm-op is-drop') &&
      textLeaves(nodes).includes('这条删除没写理由：按口径一律不应用（要删就得说清楚为什么）') &&
      // 没有理由就不画「理由」那一行（空行是噪声）。
      nodes.filter((node) => node.props?.className === 'dshm-op-reason').length === 0 &&
      /\.dshm-op\.is-drop \.dshm-warn-list li\{color:var\(--dsw-alias-state-error-primary\)\}/.test(styleNode.textContent)
    );
  })(),
);
check(
  '待审区：折叠行只有在**第一项就是删除**时才标红（混合单不染，免得把 merge 也说成删除）',
  (() => {
    const dropFirst = {
      ...TODO_OPEN_PLAN,
      ops: [{ idx: 0, type: 'drop', targets: ['x'], before: [{ id: 'x', text: '待删正文' }], after: null, reason: '重复', warnings: [] }],
    };
    const mergeFirst = {
      ...TODO_OPEN_PLAN,
      ops: [
        { idx: 0, type: 'merge', targets: ['a', 'b'], before: [{ id: 'a', text: '合并前' }], after: '合并后', reason: '同一件事', warnings: [] },
        { idx: 1, type: 'drop', targets: ['c'], before: [{ id: 'c', text: '待删' }], after: null, reason: '重复', warnings: [] },
      ],
    };
    const redRow = (keeperTab === null ? [] : renderKeeperTab([dropFirst])).some((node) => node.props?.className === 'dshm-op-line is-drop');
    const plainRow = (keeperTab === null ? [] : renderKeeperTab([mergeFirst])).some((node) => node.props?.className === 'dshm-op-line is-drop');
    return redRow === true && plainRow === false;
  })(),
);
// 「副仓管」（原「副审阅区」）：仓管某一组出错、或人把待审单转手过来时，那一组挂到**独立的一页**，
// 用**这个角色自己选的模型**重头整理（用户 2026-10-07：「副审阅区使用独立的仓管角色 独立建立页面『副仓管』」）。
const HANDOFF_ROW = {
  id: 'e1e1e1e1-0000-0000-0000-000000000001',
  createdAt: '2026-10-07T12:00:00.000Z',
  state: 'open',
  seedId: 'ffffffff-0000-0000-0000-000000000009',
  count: 3,
  members: [
    { id: 'm1', text: '卡住的第一条记忆' },
    { id: 'm2', text: '卡住的第二条记忆' },
  ],
  error: 'TimeoutError: 仓管 LLM 请求超时',
  attempts: 2,
  taker: null,
  planId: null,
};
const sideQueue =
  attempt('浅渲染副仓管页（队列里有 1 组）不抛错', () => (sideTab === null ? [] : renderSideTab([HANDOFF_ROW]))) ?? [];
check(
  '副仓管：队列一行一件事（卡片标题带组数、失败原因、条数、试过几次、成员预览）',
  (() => {
    const leaves = textLeaves(sideQueue);
    // 卡片标题是 `Card` 的 prop（不走 children），要单独看。
    const titled = sideQueue.some((node) => node.props?.title === t('sideQueueTitle').replace('{n}', '1'));
    return (
      titled &&
      leaves.includes('TimeoutError: 仓管 LLM 请求超时') &&
      leaves.includes('卡住的第一条记忆') &&
      leaves.includes(t('handoffCount').replace('{n}', '3')) &&
      leaves.includes(t('handoffTried').replace('{n}', '2'))
    );
  })(),
  JSON.stringify(textLeaves(sideQueue)),
);
check(
  '副仓管：一组一行两个动作 —— 接手 / 清掉，两个都接了 onClick',
  (() => {
    const buttons = sideQueue.filter((node) =>
      (node.children ?? []).some((child) => child === t('handoffStart') || child === t('handoffDrop')));
    return buttons.length === 2 && buttons.every((node) => typeof node.props?.onClick === 'function');
  })(),
  `take=${countText(sideQueue, t('handoffStart'))} drop=${countText(sideQueue, t('handoffDrop'))}`,
);
check(
  '副仓管：模型是**这一页选一次**的角色设定（下拉 = 自动 / 已配好的档案 / 宿主模型 + 一行说明）',
  (() => {
    const select = sideQueue.find((node) => node.type === 'select' && node.props?.className === 'dshm-select');
    const values = flattenTree(select).filter((node) => node.type === 'option').map((node) => node.props?.value);
    return (
      select !== undefined &&
      select.props.value === 'auto' &&
      select.props.disabled === false &&
      typeof select.props.onChange === 'function' &&
      values.join(',') === SIDE_OPTIONS.map((option) => option.value).join(',') &&
      textLeaves(sideQueue).includes(t('sideModelLabel')) &&
      textLeaves(sideQueue).includes(t('sideHint'))
    );
  })(),
  (() => {
    const select = sideQueue.find((node) => node.type === 'select');
    return JSON.stringify({
      value: select?.props?.value,
      options: flattenTree(select).filter((node) => node.type === 'option').map((node) => node.props?.value),
    });
  })(),
);
// 用户 2026-10-07：「最终由什么模型接手由我启动时决定」→ 这一轮升级成"这个角色有自己的一份设定"：
// 逐条弹窗**已经删掉**（模型在这一页选一次），所以这里盯住"没有窗口"。
check(
  '副仓管：**不再逐条弹窗问模型**（那个 `Modal` 已经不存在）',
  sideQueue.every((node) => node.type !== fakePrimitives.Modal) &&
    !textLeaves(sideQueue).includes(t('sideModelLabel') + '？'),
);
check(
  '副仓管：下拉显示的就是这个角色存下来的选择（`side` = 档案名 / `host` / 没设 = 自动）',
  (() => {
    const valueOf = (side) => {
      const nodes = renderSideTab([HANDOFF_ROW], { status: 'ready', side, options: SIDE_OPTIONS, hostModel: 'host-x' });
      return nodes.find((node) => node.type === 'select')?.props?.value;
    };
    return valueOf('线上') === '线上' && valueOf('host') === 'host' && valueOf(null) === 'auto';
  })(),
);
check(
  '副仓管：队列空时给一行「手上没有挂着的组」（独立成页，空白要说清是"没有"）',
  (() => {
    const nodes = sideTab === null ? [] : renderSideTab([]);
    // `Empty` 是函数组件，浅渲染不会展开它 —— 断言它**被挂出去了**（props 里有文案）。
    return (
      nodes.some((node) => node.props?.text === t('sideEmpty')) &&
      countText(nodes, t('handoffStart')) === 0 &&
      countText(nodes, t('handoffDrop')) === 0
    );
  })(),
);
check(
  '副仓管：列多了只铺 8 行 + 一行「还有 N 项」（不把这一页撑爆）',
  (() => {
    const many = Array.from({ length: 11 }, (_, index) => ({ ...HANDOFF_ROW, id: 'h' + String(index) }));
    const nodes = sideTab === null ? [] : renderSideTab(many);
    return (
      countText(nodes, t('handoffStart')) === 8 &&
      textLeaves(nodes).includes(t('todoMoreOps').replace('{n}', '3'))
    );
  })(),
);
check(
  '副仓管：队列读不到（宿主半没重载 / 路由 404）时不装作没有 —— 画错误框与重试',
  (() => {
    const nodes = sideTab === null ? [] : renderSideTab({ status: 'error', message: 'HTTP 404' });
    const box = nodes.find((node) => node.props?.text === 'HTTP 404');
    return box !== undefined && typeof box.props?.onRetry === 'function' && box.props?.retryLabel === t('retry');
  })(),
);
check(
  '副仓管：连 `/keeper` 都读不到（拿不到档案与 `side` 设定）时也画错误框，不静默',
  (() => {
    const nodes = sideTab === null ? [] : renderSideTab([], { status: 'error', message: 'HTTP 500' });
    return nodes.some((node) => node.props?.text === 'HTTP 500') && countText(nodes, t('handoffStart')) === 0;
  })(),
);
check(
  '副仓管：**自己的运行状态**画在这一页 —— 跑着说在跑（带接手模型），跑完留一句「上一次接手（模型）：结果」',
  (() => {
    if (sideTab === null) return false;
    const running = textLeaves(renderSideTab([HANDOFF_ROW], null, { running: true, taker: '线上', tail: ['接手 abc（3 条记忆）'] }));
    const done = textLeaves(renderSideTab([HANDOFF_ROW], null, { running: false, taker: '线上', finishedAt: '2026-10-08T02:00:00.000Z', tail: ['完成：2 条操作'] }));
    return (
      running.includes(t('sideRunning').replace('{taker}', '线上')) &&
      done.includes(t('sideLastRun').replace('{taker}', '线上').replace('{result}', '完成：2 条操作'))
    );
  })(),
);
check(
  '副仓管：没在跑也没跑过时**一个字都不画**（空状态不占位）',
  (() => {
    if (sideTab === null) return false;
    const lines = textLeaves(renderSideTab([HANDOFF_ROW]));
    // 用「前缀」而不是整句（整句里的 {taker} 换成空串会得到恒不命中的串 = 断言恒真，等于没测）。
    const runningPrefix = t('sideRunning').split('{taker}')[0];
    const lastPrefix = t('sideLastRun').split('{taker}')[0];
    return !lines.some((line) => line.includes(runningPrefix) || line.includes(lastPrefix));
  })(),
);
check(
  '仓管页：跑一轮那条控制带上**没有**「接手模型」下拉（模型归副仓管那页），全页只有一个「启动仓管」',
  (() => {
    const nodes = keeperTab === null ? [] : renderKeeperTab([TODO_DONE_PLAN]);
    const selects = nodes.filter((node) => node.type === 'select');
    const buttons = nodes.filter((node) => node.type === fakePrimitives.Button);
    return (
      t('todoRun') === '启动仓管' &&
      selects.length === 0 &&
      countText(nodes, t('todoRun')) === 1 &&
      buttons.length === 1 &&
      typeof buttons[0].props?.onClick === 'function' &&
      textLeaves(nodes).includes(t('keeperSideHint'))
    );
  })(),
  (() => {
    const nodes = keeperTab === null ? [] : renderKeeperTab([TODO_DONE_PLAN]);
    return JSON.stringify({
      runText: t('todoRun'),
      selects: nodes.filter((node) => node.type === 'select').length,
      buttons: nodes.filter((node) => node.type === fakePrimitives.Button).length,
      runCount: countText(nodes, t('todoRun')),
    });
  })(),
);
check(
  '转手之后文案说的是「去副仓管页点接手」（不是"已经重头整理好了"）',
  t('planHandoffOk').includes('副仓管') && t('planHandoffOk').includes('接手') && !t('planHandoffOk').includes('已重头整理'),
);
attempt('展开一条**待确认**记录不抛错', () =>
  keeperTab === null
    ? []
    : renderTodoOpen([{ ...TODO_DETAIL_PLAN, state: 'open' }], [], {
        ['plan:' + TODO_DETAIL_PLAN.id]: true,
      }),
);
// 「已处理」默认**收起来**（用户 2026-10-07：「收起来」）：平时一轮只占一行。
check(
  '待办页：已处理的流水默认收起 —— 只画轮次那一行，不铺开每一张单',
  (() => {
    const nodes = keeperTab === null ? [] : renderTodoOpen([TODO_DONE_PLAN], [], {});
    const leaves = textLeaves(nodes);
    return (
      leaves.includes('▸') &&
      nodes.some((node) => typeof node.children?.some === 'function' && node.children.some((c) => c === '1 张单 · 通过 1 · 驳回 0')) &&
      // 张单的摘要（带正文预览）在收起状态**不该**出现。
      !leaves.some((text) => typeof text === 'string' && text.includes('合并前的原文'))
    );
  })(),
);
check(
  '待办页：点开轮次才铺开这一轮的单（▾ + 单行出现）',
  (() => {
    const nodes = keeperTab === null ? [] : renderTodoOpen([TODO_DONE_PLAN], [], { ['run:' + TODO_DONE_PLAN.runId]: true });
    const leaves = textLeaves(nodes);
    return leaves.includes('▾') && leaves.includes('合并 2 条 → 1 条：原文一');
  })(),
);
// 用户 2026-10-07 指着待确认那一行说「这个描述太抽象，难以理解」：
// 旧的写法是把 op 计数排一串（删除 1 条 · 合并 2 条 → 1 条 …），读的人不知道要改什么。
check(
  '待办页：变更单摘要先说「动什么」—— 第一项 + 它动的正文开头 + 还有 N 项',
  (() => {
    const plan = {
      ...TODO_OPEN_PLAN,
      ops: [
        { idx: 0, type: 'drop', targets: ['xxxxxxxx-0000-0000-0000-000000000001'], before: [{ id: 'x', text: '被删掉的正文' }], after: null, warnings: [] },
        { idx: 1, type: 'split', targets: ['yyyyyyyy-0000-0000-0000-000000000001'], before: [{ id: 'y', text: '待拆的正文' }], after: ['块一'], warnings: [] },
      ],
    };
    const leaves = textLeaves(keeperTab === null ? [] : renderTodoOpen([plan], [], {}));
    return leaves.includes('删除 1 条：被删掉的正文 · 还有 1 项');
  })(),
);
check(
  '待办页：跑一轮的进度是**进度条**（宽度 = 完成百分比），计数跟条子并排',
  (() => {
    const nodes = keeperTab === null ? [] : renderTodoOpen([], [], {}, {}, { running: true, done: 5, total: 20, failed: 0 });
    const fill = nodes.find((node) => node.props?.className === 'dshm-progress-fill');
    return (
      fill !== undefined &&
      fill.props.style.width === '25%' &&
      textLeaves(nodes).includes(
        t('todoProgress').replace('{done}', '5').replace('{total}', '20').replace('{failed}', '0'),
      )
    );
  })(),
);
check(
  '待办页：`total` 为 0 / 缺字段时进度条宽度给 0%（绝不把 NaN 塞进 style）',
  (() => {
    const nodes = keeperTab === null ? [] : renderTodoOpen([], [], {}, {}, { running: true, done: 0, total: 0, failed: 0 });
    const fill = nodes.find((node) => node.props?.className === 'dshm-progress-fill');
    return fill !== undefined && fill.props.style.width === '0%';
  })(),
);
// 用户 2026-10-07：「仓管运行过程中 我需要能看见仓管的工作过程…以及确保它没卡住而是在正常运行」。
const keeperRunning =
  attempt('浅渲染仓管页（仓管跑着，带逐组日志）不抛错', () =>
    keeperTab === null
      ? []
      : renderTodoOpen([], [], {}, {}, {
          running: true,
          done: 5,
          total: 20,
          failed: 0,
          plans: 3,
          ops: 7,
          skipped: 1,
          retried: 1,
          startedAt: new Date(Date.now() - 125000).toISOString(),
          model: 'qwen3.8-flash',
          tail: ['组 4：开始（6 条记忆，种子 abcdef12）', '组 5：超时，重试一次', '组 5：2 条操作'],
          current: {
            groupNo: 5,
            seedId: 'abcdef12-0000-0000-0000-000000000001',
            count: 3,
            members: [
              { id: 'abcdef12-0000-0000-0000-000000000001', text: '正在处理的种子那条记忆。' },
              { id: 'beefbeef-0000-0000-0000-000000000002', text: '同组召回的第一条。' },
              { id: 'cafecafe-0000-0000-0000-000000000003', text: '同组召回的第三条。' },
            ],
          },
        }, Date.now()),
  ) ?? [];
const todoRunning = keeperRunning;
check(
  '仓管页：跑一轮时看得见过程 —— 已跑时长 + 本轮产出 + 逐组日志（最新在下）',
  textLeaves(keeperRunning).includes(t('todoElapsed').replace('{time}', '2:05')) &&
    textLeaves(keeperRunning).includes(
      t('todoRunStats').replace('{plans}', '3').replace('{ops}', '7').replace('{skipped}', '1').replace('{retried}', '1'),
    ) &&
    textLeaves(keeperRunning).includes('组 4：开始（6 条记忆，种子 abcdef12）') &&
    textLeaves(keeperRunning).includes('组 5：超时，重试一次') &&
    textLeaves(keeperRunning).includes('组 5：2 条操作'),
  JSON.stringify(textLeaves(keeperRunning).slice(0, 12)),
);
// 用户 2026-10-07：「展示它正在处理的记忆是哪些」—— tail 只有条数与种子前 8 位，这里要有正文。
check(
  '仓管页：跑一轮时列出**正在处理的记忆**（组号 / 条数 / 种子 / 成员正文全在）',
  (() => {
    const leaves = textLeaves(keeperRunning);
    return (
      leaves.includes(t('keeperCurrentTitle').replace('{n}', '5').replace('{count}', '3')) &&
      leaves.includes(t('keeperCurrentSeed') + ' abcdef12') &&
      leaves.includes('正在处理的种子那条记忆。') &&
      leaves.includes('同组召回的第一条。') &&
      leaves.includes('同组召回的第三条。')
    );
  })(),
  JSON.stringify(textLeaves(keeperRunning)),
);
check(
  '仓管页：正在处理的记忆里，种子那一条用主色（`dshm-current-seed`）与同组其余条分开',
  (() => {
    const seedNode = keeperRunning.find(
      (node) => node.props?.className === 'dshm-item-text dshm-current-seed',
    );
    const others = keeperRunning.filter((node) => node.props?.className === 'dshm-item-text dshm-muted');
    return (
      seedNode !== undefined &&
      (seedNode.children ?? []).includes('正在处理的种子那条记忆。') &&
      others.some((node) => (node.children ?? []).includes('同组召回的第一条。'))
    );
  })(),
  JSON.stringify(keeperRunning.filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('dshm-current')).map((n) => n.props.className)),
);
check(
  '仓管页：组与组之间（`current === null`）画「正在准备下一组…」，不是空着',
  (() => {
    const nodes = keeperTab === null ? [] : renderTodoOpen([], [], {}, {}, { running: true, done: 1, total: 3, current: null });
    return textLeaves(nodes).includes(t('keeperCurrentPending'));
  })(),
);
check(
  '仓管页：宿主半**没有** `current` 字段（没重载）时整块不画 —— 不替宿主撒谎说"正在准备下一组"',
  (() => {
    // 老宿主的 job 里连这个键都没有；`current: null` 才是"组与组之间"，两者必须分开。
    const oldHost = keeperTab === null ? [] : renderTodoOpen([], [], {}, {}, { running: true, done: 1, total: 3, tail: [] });
    const hasBlock = countClass(oldHost, 'dshm-current') > 0;
    const claimsPending = textLeaves(oldHost).includes(t('keeperCurrentPending'));
    const newHost = keeperTab === null ? [] : renderTodoOpen([], [], {}, {}, { running: true, done: 1, total: 3, current: null });
    const newHostPending = textLeaves(newHost).includes(t('keeperCurrentPending'));
    return hasBlock === false && claimsPending === false && newHostPending === true;
  })(),
);
check(
  '仓管页：有「心跳」—— 最近一次进展几秒前 + 一句「单组可能要几分钟」的说明（否则进度不动=像卡死）',
  textLeaves(keeperRunning).includes(t('todoLastProgress').replace('{sec}', '0')) &&
    textLeaves(keeperRunning).includes(t('todoStuckHint')),
  JSON.stringify(textLeaves(keeperRunning).slice(-3)),
);
check(
  '仓管页：没在跑的时候不画进度条 / 日志 / 正在处理的记忆（`running:false`）',
  (() => {
    const nodes = keeperTab === null ? [] : renderTodoOpen([], [], {}, {}, { running: false, done: 20, total: 20, tail: ['组 1：2 条操作'], current: null });
    return (
      nodes.every((node) => node.props?.className !== 'dshm-progress-fill') &&
      countClass(nodes, 'dshm-current') === 0 &&
      !textLeaves(nodes).includes('组 1：2 条操作')
    );
  })(),
);
// ── 设置页里的「仓管模型」：数据态浅渲染（档案行 + 内置不可删） ─────────────
// 它是 MemoryPage 里第二个函数子节点（表盘面板的子节点顺序 = SettingsTab、KeeperModelBlock）。
const keeperBlock = (() => {
  fakeReact.__stateQueue = ['settings'];
  const tree = MainComponent({ t });
  const panel = flattenTree(tree).find((node) => node.props?.role === 'tabpanel');
  const kids = (panel?.children ?? []).filter(
    (node) => node !== null && typeof node === 'object' && typeof node.type === 'function',
  );
  return kids.length >= 2 ? kids[1].type : null;
})();
/** 内置补丁配置（没配置模型、也不在生效）。 */
const KEEPER_PATCH_PROFILE = { name: 'config', builtin: true, configured: false, fields: { provider: 'ollama', model: null } };
/** 已配置并生效的档案。 */
const KEEPER_ONLINE_PROFILE = { name: '线上', builtin: false, configured: true, fields: { provider: 'openai', model: 'qwen3.8-flash' } };
/** 人自己建过、但没填完的档案（用户指着它说「没配置就不要一直挂着」）。 */
const KEEPER_LOCAL_PROFILE = { name: '局域网-ollama', builtin: false, configured: false, fields: { provider: 'ollama', model: null } };

/**
 * 用指定的档案渲染「仓管模型」块。
 * @param {object[]} items 档案列表。
 * @param {string} active 生效档案名。
 * @returns {object[]} 展平后的元素节点。
 */
function renderKeeper(items, active, form = null) {
  if (keeperBlock === null) return [];
  const queue = [{ status: 'ready', items, active }, form];
  while (queue.length < 6) queue.push(undefined);
  fakeReact.__stateQueue = queue;
  return flattenTree(keeperBlock({ t }));
}

const keeperNodes = attempt('浅渲染「仓管模型」块不抛错', () => renderKeeper([KEEPER_PATCH_PROFILE, KEEPER_ONLINE_PROFILE], '线上')) ?? [];
check(
  '设置页：仓管模型只画能用的档案（已配置 + 生效），补丁配置不给「删」',
  textLeaves(keeperNodes).includes('线上') &&
    countText(keeperNodes, t('delete')) === 1 &&
    // 未配置的补丁配置连行都不画（用户 2026-10-07：「移除」那行折叠）。
    !textLeaves(keeperNodes).includes(t('patchProfile')),
  `删除=${countText(keeperNodes, t('delete'))} leaves=${JSON.stringify(textLeaves(keeperNodes).slice(0, 8))}`,
);
check(
  '设置页：未配置的档案**整条不画**（连折叠行都没有了）',
  (() => {
    const nodes = renderKeeper([KEEPER_PATCH_PROFILE, KEEPER_LOCAL_PROFILE, KEEPER_ONLINE_PROFILE], '线上');
    return (
      nodes.every((node) => node.type !== 'details') &&
      textLeaves(nodes).includes('线上') &&
      !textLeaves(nodes).includes('局域网-ollama') &&
      !textLeaves(nodes).includes(t('patchProfile'))
    );
  })(),
  JSON.stringify(textLeaves(renderKeeper([KEEPER_PATCH_PROFILE, KEEPER_LOCAL_PROFILE, KEEPER_ONLINE_PROFILE], '线上')).slice(0, 10)),
);
check(
  '设置页：正在生效的档案一律显示 —— 哪怕它没配置（否则人不知道自己在用什么）',
  (() => {
    // 这里补丁配置**生效**了：它就该出现（且显示成「补丁配置」，不是技术名 config）。
    const nodes = renderKeeper([KEEPER_PATCH_PROFILE, KEEPER_ONLINE_PROFILE], 'config');
    return textLeaves(nodes).includes(t('patchProfile')) && !textLeaves(nodes).includes('config');
  })(),
);

// 「仓管模型」和「向量模型」是同一套交互：点名字开窗口、每条参数独占一行。
const KEEPER_EDIT_FORM = { name: '线上', provider: 'openai', baseUrl: '', model: 'qwen3.8-flash', apiKeyRef: '', ollamaUrl: '', timeoutMs: '', isNew: false };
const keeperFormNodes =
  attempt('浅渲染「仓管模型」的档案窗口不抛错', () => renderKeeper([KEEPER_ONLINE_PROFILE], '线上', KEEPER_EDIT_FORM)) ?? [];
check(
  '设置页：仓管档案同样用独立窗口 —— 6 行参数 + footer 里的 保存 / 取消',
  modalNode(keeperFormNodes) !== undefined &&
    countClass(keeperFormNodes, 'dshm-field-row') === 6 &&
    countText(propTree(modalNode(keeperFormNodes), 'footer'), t('save')) === 1 &&
    countText(propTree(modalNode(keeperFormNodes), 'footer'), t('cancel')) === 1 &&
    countText(propTree(modalNode(keeperFormNodes), 'footer'), t('profileTest')) === 0 &&
    modalNode(keeperFormNodes).props.description === '线上',
  `rows=${countClass(keeperFormNodes, 'dshm-field-row')}`,
);
check(
  '设置页：没在编辑时不渲染窗口',
  modalNode(keeperNodes) === undefined,
);
const keeperNewNodes =
  attempt('浅渲染「仓管模型」的新建窗口不抛错', () =>
    renderKeeper([KEEPER_ONLINE_PROFILE], '线上', { ...KEEPER_EDIT_FORM, name: '', model: '', isNew: true }),
  ) ?? [];
check(
  '设置页：仓管新建窗口不给「测」（名字还没写，宿主不认识它）',
  modalNode(keeperNewNodes) !== undefined &&
    countText(propTree(modalNode(keeperNewNodes), 'footer'), t('profileTest')) === 0,
  JSON.stringify(propTree(modalNode(keeperNewNodes), 'footer').flatMap((n) => n.children ?? [])),
);

// ── 设置页：两张卡 + 收起式诊断（用户报「太乱太冗余，不够一目了然」） ─────────
// 口径：编辑体内联在档案行里（收起时一个编辑控件都不画）、密钥写进编辑体、
// 只读配置 / LLM 预检 / 数据目录收进一个默认收起的 <details>。
const settingsTab = renderedTabs.settings?.panelComponent ?? null;
const SETTINGS_CONFIG = {
  status: 'ready',
  data: {
    ok: true,
    keyStatus: { ref: 'EMB_REF', configured: true, source: 'credential' },
    config: {
      embedding: { provider: 'openai', model: 'text-embedding-v4', apiKeyRef: 'EMB_REF' },
      scope: 'default',
      search: { defaultLimit: 20, maxLimit: 50 },
      llm: { provider: 'deepseek', model: 'flash' },
      dataDir: 'C:/data',
    },
  },
};
const SETTINGS_PROFILES = {
  status: 'ready',
  active: '线上',
  profiles: [
    // 补丁配置（宿主不许改也不许删）：只在它生效时才该占一行。
    { name: 'config', source: 'config', embedding: { provider: 'openai', model: 'text-embedding-v4', apiKeyRef: 'EMB_REF' }, space: { key: 'openai:text-embedding-v4:1024' }, vectors: 0, missing: 1100 },
    { name: '线上', source: 'db', embedding: { provider: 'openai', model: 'text-embedding-v4', apiKeyRef: 'EMB_REF' }, space: { key: 'openai:text-embedding-v4:1024' }, vectors: 1100, missing: 0 },
    // 第二个真档案带着缺口 —— 覆盖「缺 N 条」那个分支。
    { name: '本地', source: 'db', embedding: { provider: 'ollama', model: 'bge-m3', apiKeyRef: null }, space: { key: 'ollama:bge-m3:1024' }, vectors: 42, missing: 7 },
  ],
};
/** 生效档案 = 补丁配置时的档案列表（补丁那一行这时才该出现）。 */
const SETTINGS_PROFILES_PATCH_ACTIVE = {
  ...SETTINGS_PROFILES,
  active: 'config',
};
const EMPTY_FORM = { name: '', provider: 'openai', baseUrl: '', model: '', dimensions: '', apiKeyRef: '', ollamaUrl: '', localDims: '' };

/**
 * 浅渲染设置页。状态顺序（`useState` 的先后）：1 state / 2 profiles / 3 nonce / 4 value /
 * 5 busy / 6 pendingAction / 7 editing / 8 form / 9 testResult / 10 credentialNotice /
 * 11 notice / 12 formError / 13 actionError。
 * @param {{editing?: string|null, form?: object, profiles?: object}} [extra] 覆盖第 2、7、8 个状态。
 * @returns {object[]} 展平后的元素节点。
 */
function renderSettings(extra = {}) {
  const queue = [
    SETTINGS_CONFIG,
    extra.profiles === undefined ? SETTINGS_PROFILES : extra.profiles,
    0,
    '',
    false,
    '',
    extra.editing === undefined ? null : extra.editing,
    extra.form === undefined ? EMPTY_FORM : extra.form,
  ];
  while (queue.length < 13) queue.push(undefined);
  fakeReact.__stateQueue = queue;
  return settingsTab === null ? [] : flattenTree(settingsTab({ t }));
}

const settingsIdle = attempt('浅渲染设置页（收起态）不抛错', () => renderSettings()) ?? [];
/**
 * `Card` 的标题与右上角动作是 **props**（`title` / `action`），不走 children，
 * 所以 `countText` 看不见它们 —— 这里单独取（否则会误判成「卡片没渲染」）。
 * @param {object[]} nodes 展平后的节点。
 * @param {string} title 卡片标题。
 * @returns {object|undefined} 那张卡的节点。
 */
const cardNode = (nodes, title) => nodes.find((node) => node.props?.title === title);
/** 取一张卡右上角动作子树里的文本叶子。 */
const cardActionText = (nodes, title) =>
  flattenTree(cardNode(nodes, title)?.props?.action ?? null)
    .flatMap((node) => node.children ?? [])
    .filter((child) => typeof child === 'string');

check(
  '设置页：只剩「向量模型」一张设置卡（旧的只读配置 / 写入密钥卡没了），且**没有**诊断块',
  cardNode(settingsIdle, t('profilesTitle')) !== undefined &&
    // 用户 2026-10-07 看过之后拍板：整个「诊断」块从面板移除 → 一个 <details> 都不该有。
    !settingsIdle.some((node) => node.type === 'details') &&
    !textLeaves(settingsIdle).includes('写入嵌入密钥') &&
    !textLeaves(settingsIdle).includes('LLM 预检') &&
    !textLeaves(settingsIdle).includes('密钥状态') &&
    !textLeaves(settingsIdle).includes('数据目录'),
  `卡片=${cardNode(settingsIdle, t('profilesTitle')) === undefined ? 0 : 1} details=${settingsIdle.filter((node) => node.type === 'details').length}`,
);
check(
  '设置页：卡片叫「向量模型」+「＋ 新建档案」，没有说明文字，收起时没有编辑控件（只有行上的 测 / 删）',
  t('profilesTitle') === '向量模型' &&
    cardActionText(settingsIdle, t('profilesTitle')).includes(t('profileNew')) &&
    countText(settingsIdle, t('save')) === 0 &&
    countText(settingsIdle, t('cancel')) === 0 &&
    // 两个真档案各一个「删」；补丁配置那一行不出现（没生效）。
    countText(settingsIdle, t('delete')) === 2,
  `title=${t('profilesTitle')} action=${JSON.stringify(cardActionText(settingsIdle, t('profilesTitle')))} delete=${countText(settingsIdle, t('delete'))}`,
);
check(
  '设置页：档案行只画模型名（provider 收进 title）；不缺口给条数、缺口给「缺 N 条」',
  textLeaves(settingsIdle).includes('text-embedding-v4') &&
    !textLeaves(settingsIdle).includes('openai') &&
    textLeaves(settingsIdle).includes(t('profileVectors').replace('{vectors}', '1100')) &&
    textLeaves(settingsIdle).includes(t('profileMissing').replace('{missing}', '7')),
  JSON.stringify(textLeaves(settingsIdle).slice(0, 12)),
);
check(
  '设置页：等待中不显示、生效中显示 —— 补丁配置（不许改 / 不许删）平时不占一行',
  !textLeaves(settingsIdle).includes(t('patchProfile')) &&
    !textLeaves(settingsIdle).includes('config') &&
    textLeaves(settingsIdle).includes('线上') &&
    textLeaves(settingsIdle).includes('本地'),
  JSON.stringify(textLeaves(settingsIdle).slice(0, 12)),
);
check(
  '设置页：补丁配置**生效时**显示成「补丁配置」（不是技术名 config），且不给「删」',
  (() => {
    const nodes = renderSettings({ profiles: SETTINGS_PROFILES_PATCH_ACTIVE });
    return (
      textLeaves(nodes).includes(t('patchProfile')) &&
      !textLeaves(nodes).includes('config') &&
      // 两个真档案各一个「删」；补丁配置那一行没有。
      countText(nodes, t('delete')) === 2
    );
  })(),
);
check(
  '设置页：每个档案一行都带「测」，切生效只靠圆点',
  countText(settingsIdle, t('profileTest')) === 2 &&
    !textLeaves(settingsIdle).includes('测试连接') &&
    settingsIdle.some((node) => typeof node.props?.className === 'string' && node.props.className.includes('dshm-dot')),
  `test=${countText(settingsIdle, t('profileTest'))}`,
);
check(
  '设置页：诊断那几样都不在面板上（LLM 探活 / 密钥状态 / 数据目录走工具与 /config）',
  textLeaves(settingsIdle).every((text) => !['LLM 预检', '密钥状态', '数据目录', '作用域', '检索条数', 'LLM'].includes(text)) &&
    !settingsIdle.some((node) => node.type === 'details'),
  JSON.stringify(textLeaves(settingsIdle).slice(-6)),
);

const OPEN_FORM = { name: '线上', provider: 'openai', baseUrl: 'https://x/v1', model: 'text-embedding-v4', dimensions: '1024', apiKeyRef: 'EMB_REF', ollamaUrl: '', localDims: '' };
const settingsOpen = attempt('浅渲染设置页（点开一个档案）不抛错', () =>
  renderSettings({ editing: '线上', form: OPEN_FORM }),
) ?? [];
check(
  '设置页：点档案**开一个独立窗口**（Modal），标题 / 关闭 label / 描述（档案名）齐全',
  (() => {
    const modal = modalNode(settingsOpen);
    return (
      modal !== undefined &&
      modal.props.title === t('profileConfigTitle') &&
      modal.props.closeLabel === t('close') &&
      modal.props.open === true &&
      modal.props.description === '线上' &&
      typeof modal.props.onClose === 'function'
    );
  })(),
  JSON.stringify(modalNode(settingsOpen)?.props ?? null),
);
check(
  '设置页：窗口里**每条参数独占一行**（6 行 .dshm-field-row），不再挤成三列网格',
  countClass(settingsOpen, 'dshm-field-row') === 6 && countClass(settingsOpen, 'dshm-fields') === 0,
  `rows=${countClass(settingsOpen, 'dshm-field-row')} grid=${countClass(settingsOpen, 'dshm-fields')}`,
);
check(
  '设置页：窗口 footer 只有 保存 / 取消（「测」在行上，不重复画）；「写入密钥（引用名）」在窗口正文里',
  countText(propTree(modalNode(settingsOpen), 'footer'), t('save')) === 1 &&
    countText(propTree(modalNode(settingsOpen), 'footer'), t('cancel')) === 1 &&
    countText(propTree(modalNode(settingsOpen), 'footer'), t('profileTest')) === 0 &&
    textLeaves(settingsOpen).includes(t('keyWrite') + ' · EMB_REF'),
  JSON.stringify(propTree(modalNode(settingsOpen), 'footer').flatMap((n) => n.children ?? [])),
);
check(
  '设置页：收起时**没有窗口**（原来那套行内展开已经整块移除）',
  modalNode(settingsIdle) === undefined && !settingsIdle.some((node) => node.type === 'details'),
);

const settingsNew = attempt('浅渲染设置页（新建窗口）不抛错', () => renderSettings({ editing: '', form: EMPTY_FORM })) ?? [];
check(
  '设置页：新建窗口里不给「测」（还不知道名字），也没有密钥写入（档案还没有引用名）',
  modalNode(settingsNew) !== undefined &&
    countText(propTree(modalNode(settingsNew), 'footer'), t('profileTest')) === 0 &&
    countText(propTree(modalNode(settingsNew), 'footer'), t('save')) === 1 &&
    !textLeaves(settingsNew).some((text) => text.startsWith(t('keyWrite'))),
  JSON.stringify(propTree(modalNode(settingsNew), 'footer').flatMap((n) => n.children ?? [])),
);

// ── 搜索页：展开后能改（送审）能删；待办：一键通过 ─────────────────────────────
// 用户 2026-10-07：「让搜索出来的记忆可删除或编辑，若编辑则将编辑完成的产物送入待审区。
// 审阅区新增一键通过。」
const searchTab = renderedTabs.search?.panelComponent ?? null;
const SEARCH_ITEM = {
  id: 'mem-1',
  score: 0.91,
  source: 'agent',
  text: '一条被搜出来的记忆',
  keywordScore: 1,
  vectorScore: 0.9,
};

/**
 * 浅渲染搜索页。状态顺序：1 draft / 2 submitted / 3 state / 4 openId / 5 openState /
 * 6 editing / 7 editDraft / 8 editBusy / 9 editError / 10 notice / 11 actionError /
 * 12 recent（「最近入库」，**排在最后**是为了不打乱前 11 个的下标）。
 * @param {object} [overrides] 覆盖任意状态。
 * @returns {object[]} 展平后的元素节点。
 */
function renderSearch(overrides = {}) {
  fakeReact.__stateQueue = [
    overrides.draft ?? '',
    overrides.submitted ?? null,
    overrides.state ?? { status: 'idle' },
    overrides.openId ?? null,
    overrides.openState ?? { status: 'idle' },
    overrides.editing ?? null,
    overrides.editDraft ?? '',
    overrides.editBusy ?? false,
    overrides.editError ?? '',
    overrides.notice ?? '',
    overrides.actionError ?? '',
    overrides.recent ?? { status: 'loading' },
  ];
  return searchTab === null ? [] : flattenTree(searchTab({ t }));
}

const searchCollapsed = attempt('浅渲染搜索页（有结果、未展开）不抛错', () =>
  renderSearch({ state: { status: 'ready', data: { items: [SEARCH_ITEM], count: 1, tookMs: 3 } } }),
) ?? [];
check(
  '搜索页：没展开时不给「改 / 删」（一页 20 行 × 2 个按钮就是 40 个控件，不许常驻）',
  countText(searchCollapsed, t('searchEdit')) === 0 && countText(searchCollapsed, t('delete')) === 0,
);
const searchExpanded = attempt('浅渲染搜索页（展开、全文已取回）不抛错', () =>
  renderSearch({
    state: { status: 'ready', data: { items: [SEARCH_ITEM], count: 1, tookMs: 3 } },
    openId: 'mem-1',
    openState: { status: 'ready', memory: { id: 'mem-1', text: '一条被搜出来的记忆' } },
  }),
) ?? [];
check(
  '搜索页：展开且全文取回后，出现「改 / 删」两个动作',
  countText(searchExpanded, t('searchEdit')) === 1 && countText(searchExpanded, t('delete')) === 1,
  JSON.stringify(textLeaves(searchExpanded).slice(-4)),
);
const searchEditing = attempt('浅渲染搜索页（改写窗口）不抛错', () =>
  renderSearch({
    state: { status: 'ready', data: { items: [SEARCH_ITEM], count: 1, tookMs: 3 } },
    openId: 'mem-1',
    openState: { status: 'ready', memory: { id: 'mem-1', text: '一条被搜出来的记忆' } },
    editing: { id: 'mem-1' },
    editDraft: '改过之后的正文',
  }),
) ?? [];
check(
  '搜索页：「改」开的是独立窗口 —— 标题 + 正文 textarea + footer 只有 送审 / 取消',
  (() => {
    const modal = modalNode(searchEditing);
    const footer = propTree(modal, 'footer');
    return (
      modal !== undefined &&
      modal.props.title === t('searchEditTitle') &&
      modal.props.closeLabel === t('close') &&
      modal.props.description === 'mem-1' &&
      textLeaves(searchEditing).includes(t('memEditHint')) &&
      countText(footer, t('memEditSubmit')) === 1 &&
      countText(footer, t('cancel')) === 1 &&
      // 送审 ≠ 直接改库的那句话必须在窗口里说清楚。
      textLeaves(searchEditing).includes(t('memEditHint'))
    );
  })(),
  JSON.stringify(modalNode(searchEditing)?.props ?? null),
);
check(
  '搜索页：送审窗口里那个按钮叫「送审」而不是「保存」（保存容易被读成"已经改库了"）',
  textLeaves(searchEditing).every((text) => text !== t('save')),
);

// ── 搜索页：新增的「最近入库」块 ───────────────────────────────────────────────
// 口径：最近被记进库的 10 条（created_at 倒序）。它**没有检索分**，所以
// 「关键词分 / 向量分」「读取 / 整理」那些 Tag 一个都不许出现 —— 硬画就是 0 或 NaN。
const RECENT_ITEMS = [
  { id: 'rec-1', text: '刚记进来的一条', source: 'agent', createdAt: '2026-10-09T12:00:00.000Z', truncated: false },
  { id: 'rec-2', text: '更早一点的一条', source: null, createdAt: '2026-10-08T09:30:00.000Z', truncated: false },
];
const recentCardNode = (nodes) => nodes.find((node) => node.props?.title === t('recentTitle'));
/**
 * 递归取一棵（可能含函数组件的）元素树的**全部文本叶子**。
 *
 * 不能直接用 `textLeaves`：它只剥一层；而 `Card` / `Empty` / `Row` 这些函数组件是
 * 以 `{type: fn, children: [...]}` 的形状留在树里的，文案在它们的孙子层。
 * `props.action`（卡片右上角）**不算正文**，所以只走 `children`。
 * @param {unknown} node 根节点。
 * @returns {string[]} 文本叶子。
 */
function deepText(node) {
  const out = [];
  (function walk(current) {
    if (current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current === 'string' || typeof current === 'number') {
      out.push(String(current));
      return;
    }
    if (typeof current !== 'object') return;
    for (const child of current.children ?? []) walk(child);
  })(node);
  return out;
}
/** 一张卡正文里的文本叶子（不含右上角 action）。 */
const cardText = (card) => (card === undefined ? [] : deepText(card.children));
/**
 * 递归收集元素节点（含函数组件本身）。
 * `flattenTree` 只走 `children`，但遇到**函数组件**时会把组件节点留在结果里 ——
 * 要检查「某个局部组件有没有被挂上」，就用这个。
 * @param {unknown} node 根节点。
 * @returns {object[]} 元素节点。
 */
function deepNodes(node) {
  const out = [];
  (function walk(current) {
    if (current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current !== 'object') return;
    out.push(current);
    for (const child of current.children ?? []) walk(child);
  })(node);
  return out;
}
/** 在元素树里递归数某个文案（含函数组件内部）。 */
const deepCountText = (node, label) => deepText(node).filter((text) => text === label).length;
/**
 * 在一张卡**正文**里数某段文案（不含右上角 `action`）。
 * @param {object|undefined} card 卡片节点。
 * @param {string} text 要数的文案。
 * @returns {number} 出现次数。
 */
const cardCountText = (card, text) => deepCountText(card?.children ?? null, text);
/** 在元素树里递归数某类 className 的节点（含函数组件内部）。 */
const deepCountClass = (node, className) => {
  const out = [];
  (function walk(current) {
    if (current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current !== 'object') return;
    if (current.props?.className === className) out.push(current);
    for (const child of current.children ?? []) walk(child);
  })(node);
  return out.length;
};
const recentCollapsed =
  attempt('浅渲染搜索页（最近入库：未展开）不抛错', () =>
    renderSearch({ recent: { status: 'ready', data: { ok: true, limit: 10, count: 2, items: RECENT_ITEMS } } }),
  ) ?? [];
check(
  '搜索页：「最近入库」块按 10 条的口径画出来 —— 卡标题 + 条数说明 + 每行一条',
  (() => {
    const card = recentCardNode(recentCollapsed);
    return (
      card !== undefined &&
      cardText(card).includes(t('recentHint').replace('{count}', '2')) &&
      deepCountClass(card, 'dshm-item is-clickable') === 2 &&
      cardText(card).includes('刚记进来的一条') &&
      cardText(card).includes('更早一点的一条')
    );
  })(),
  JSON.stringify(cardText(recentCardNode(recentCollapsed))),
);
check(
  '搜索页：「最近入库」行不许画检索分（关键词分 / 向量分 / 读取 / 整理）—— 这里没有分数，画了就是 0 或 NaN',
  (() => {
    const card = recentCardNode(recentCollapsed);
    if (card === undefined) return false;
    const texts = cardText(card);
    return (
      cardCountText(card, t('keywordScore')) === 0 &&
      cardCountText(card, t('vectorScore')) === 0 &&
      !texts.some((text) => String(text).indexOf(t('scoreReadTag').replace('{count}', '')) === 0) &&
      !texts.some((text) => String(text).indexOf(t('scoreTidyTag').replace('{count}', '')) === 0)
    );
  })(),
  JSON.stringify(recentCardNode(recentCollapsed) === undefined ? null : cardText(recentCardNode(recentCollapsed)).slice(0, 8)),
);
check(
  '搜索页：「最近入库」行带**入库时刻**（否则「最近」两个字无从判断）',
  (() => {
    const card = recentCardNode(recentCollapsed);
    if (card === undefined) return false;
    // localDateTime 的结果随系统时区变，所以只断言「不是原始 ISO 串、也不是空」。
    return cardText(card).some((text) => typeof text === 'string' && text !== '' && text !== '2026-10-09T12:00:00.000Z' && /2026/.test(text));
  })(),
  JSON.stringify(cardText(recentCardNode(recentCollapsed) ?? []).slice(0, 6)),
);
check(
  '搜索页：「最近入库」块带一个「刷新」（它是只读快照，删完 / 想看最新时要能手动重取）',
  countText(propTree(recentCardNode(recentCollapsed), 'action'), t('recentRefresh')) === 1,
);
check(
  '搜索页：「最近入库」等待中只画「加载中」，不画空态（还没拿到就说"库里没有"是假信息）',
  (() => {
    const card = recentCardNode(renderSearch({ recent: { status: 'loading' } }));
    return card !== undefined && cardText(card).includes(t('loading')) && cardCountText(card, t('recentEmpty')) === 0;
  })(),
);
check(
  // ⚠️ `Empty` 是 lib/client.js 里的**局部组件**（不是平台 primitive），浅渲染看不见它内部的文案。
  // 所以这里能测的是「空态真的挂了 Empty，且文案是空态那句」；文案本身在实机 / 真库上验。
  '搜索页：「最近入库」库真空时挂上空态（拿到的不是"加载中"，也不是空列表）',
  (() => {
    const card = recentCardNode(renderSearch({ recent: { status: 'ready', data: { ok: true, count: 0, items: [] } } }));
    const emptyEl = deepNodes(card?.children ?? null).find((node) => typeof node.type === 'function' && node.type.name === 'Empty');
    return card !== undefined && emptyEl !== undefined && emptyEl.props.text === t('recentEmpty');
  })(),
);
check(
  '搜索页：「最近入库」取不到时**如实显示原因**（不静默、不假装成空库）',
  (() => {
    const card = recentCardNode(renderSearch({ recent: { status: 'error', message: 'HTTP 500：响应不是 JSON' } }));
    return card !== undefined && cardText(card).some((text) => String(text).includes('HTTP 500'));
  })(),
);
check(
  '搜索页：「最近入库」的行同样**不常驻按钮**，展开且全文取回后才给「改 / 删」',
  (() => {
    const collapsed = recentCardNode(recentCollapsed);
    const expanded = recentCardNode(
      renderSearch({
        recent: { status: 'ready', data: { ok: true, count: 2, items: RECENT_ITEMS } },
        openId: 'rec-1',
        openState: { status: 'ready', memory: { id: 'rec-1', text: '刚记进来的一条' } },
      }),
    );
    if (collapsed === undefined || expanded === undefined) return false;
    return (
      cardCountText(collapsed, t('searchEdit')) === 0 &&
      cardCountText(collapsed, t('delete')) === 0 &&
      cardCountText(expanded, t('searchEdit')) === 1 &&
      cardCountText(expanded, t('delete')) === 1
    );
  })(),
);

// 两页各有自己的「一键通过」（只在真有东西时出现）：
//  * 仓管页 = 变更单（`keeperApproveAllConfirm`：按方案落库）；
//  * 待办页 = 抽取批次（`todoBatchApproveAllConfirm`：确认入库）。
check(
  '仓管页：等你确认那块带「一键通过」按钮（卡片右上角的 action 是 prop，要单独取）',
  (() => {
    const card = keeperWaiting.find(
      (node) => typeof node.props?.title === 'string' && node.props.title.indexOf('等你确认') === 0,
    );
    return card !== undefined && countText(propTree(card, 'action'), t('todoApproveAll')) === 1;
  })(),
);
check(
  '仓管页：没有待确认的变更单时，连卡片带按钮一起不画',
  keeperIdle.every((node) => typeof node.props?.title !== 'string' || node.props.title.indexOf('等你确认') !== 0),
);
check(
  '仓管页：一键通过会**先二次确认**（这一步真的改库）',
  (() => {
    const card = keeperWaiting.find(
      (node) => typeof node.props?.title === 'string' && node.props.title.indexOf('等你确认') === 0,
    );
    const button = propTree(card, 'action').find((node) => (node.children ?? []).includes(t('todoApproveAll')));
    return button !== undefined && typeof button.props.onClick === 'function';
  })(),
);
// 用户 2026-10-07：「移除目前空置的『待办』页面」—— 那一页（抽取待审区）**整页删掉了**，
// 所以这里反过来盯住"它不许复活"：组件与那批字典键都不该再出现在客户端束里。
check(
  '待办页（抽取待审区）已按用户要求整页移除：组件、页签与那批字典键都不许复活',
  !source.includes('function TodoTab') &&
    !source.includes("value: 'todo'") &&
    !source.includes('todoBatchConfirm') &&
    !source.includes('todoBatchItems') &&
    !source.includes('todoBatchCount'),
);

// ── 输出 ─────────────────────────────────────────────────────────────────────
let passed = 0;
for (const entry of results) {
  if (entry.ok) passed += 1;
  const mark = entry.ok ? 'PASS' : 'FAIL';
  const suffix = entry.ok || entry.detail === '' ? '' : `  ← ${entry.detail}`;
  console.log(`[${mark}] ${entry.name}${suffix}`);
}
console.log('');
console.log(`dsh-memory 客户端束自检：${passed}/${results.length} 通过（文件 ${clientPath}）`);
// 只做**提示**、不算失败：字典里没人引用的键（死键）。
//
// ⚠️ 旧查法是「键名以字面量出现过就算活」（`source.includes("'key'")`）——**太宽**：
// 2026-10-07 那轮审计里 `rejected`（值 '批次已驳回…'）与 `provider`（值 '提供方'）两个真死键
// 就是因为 `'rejected'` / `'provider'` 在别处（当**值**、当状态比较）出现过而被漏掉。
// 现在两条腿：① 真的被 `t('key')` 调用；② 出现在某个 `*_KEY` 映射表的值里
// （`PLAN_STATE_KEY` 那种动态查表 —— 全文件只有它一处用变量调 `t()`，见 `t(PLAN_STATE_KEY[state])`）。
const calledDictKeys = new Set([...source.matchAll(/\bt\('([A-Za-z_$][\w$]*)'\)/g)].map((m) => m[1]));
const tableDictKeys = new Set();
for (const table of source.matchAll(/const [A-Z_]+_KEY = \{([^}]*)\}/g)) {
  for (const item of table[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)) tableDictKeys.add(item[1]);
}
const deadDictKeys = Object.keys(dictionaries.zh ?? {}).filter(
  (key) => !calledDictKeys.has(key) && !tableDictKeys.has(key),
);
console.log(
  `提示：字典里没有字面量引用的键 ${deadDictKeys.length} 个${deadDictKeys.length === 0 ? '' : '：' + deadDictKeys.join(', ')}`,
);
const failed = results.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.log('');
  console.log('失败项：');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail === '' ? '' : `：${entry.detail}`}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
