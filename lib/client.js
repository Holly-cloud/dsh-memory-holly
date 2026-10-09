// dsh-memory — 客户端半边（浏览器）：DSH 原生记忆面板。
//
// 本文件是**手写的模块协议束**，没有打包器参与：dsh-client-modules 把包里的
// `exports["./client"]` 作为 `/plugins/dsh-memory/client.js` 直接发给浏览器，文件必须是
// 一段经典脚本，唯一动作是调用 window.__ModuleLoader__.load({ id, factory })。
//
// 契约要点（见 DESIGN.md §F，逐条对照 shipped 束核实过）：
//   * `id` 必须等于 package.json 的 name —— 它同时是模块表键、启动图行 id 与路由 id。
//   * `factory(require)` 的**返回值**就是模块导出对象，不能省 `return module.exports`。
//   * `exports.apply(ctx)` 是插件体；`exports.inject` 是**浏览器端 cordis 服务名**数组
//     （注意与 package.json 里 `dsh.client.inject` 的**包名**数组不是一回事）。
//   * 只能 require 冻结平台表里的模块：react、react/jsx-runtime、react-dom、
//     react-dom/client、@deepseek-ai/cordis、-dsh-client-store、-dsh-client-ui-slots、
//     -dsh-client-ui-primitives、-dsh-client-ui-dockkit。
//   * 自注入的 <style> 必须带 data-plugin=<模块 id>（框架按它做卸载/HMR 清理）
//     与 data-plugin-css=<稳定唯一键>（去重键）。
//
// 面板取数一律走**同源 fetch 的相对路径**（`/api/dsh-memory/*`）。不走 Remote/Typert：
// 第三方插件拿不到那些类型的解析路径（DESIGN §A）。
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const {
      Button,
      StateDot,
      Tag,
      Input,
      SegmentedTabs,
      Checkbox,
      Modal,
    } = primitives;

    /** createElement 的短别名：本文件不用 JSX（没有打包器/转译器）。 */
    const h = React.createElement;

    // ── 1. 样式：只读主题 token，不定义任何颜色，浅色/深色自动跟随 ────────────────
    //
    // 为什么用 `document.querySelector` 去重：HMR 会重复执行整个模块，不去重就会叠出
    // 几十个 <style>。`data-plugin` / `data-plugin-css` 是框架卸载清理的钩子，必须有。
    const CSS_ID = 'dsh-memory/panel.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-memory';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        '.dshm-root{box-sizing:border-box;height:100%;overflow:auto;scrollbar-gutter:stable;padding:20px 24px;',
        'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
        'font-family:var(--dsw-font-s-14-font-family);font-size:var(--dsw-font-s-14-font-size);',
        'line-height:var(--dsw-font-s-14-line-height)}',
        // 内容列：**宽度上限挂在这一层，不挂在滚动容器上**。
        // 用户报过「不同页签宽度不统一」：滚动容器上挂 `max-width` + `overflow:auto` 时，
        // 高页签出现纵向滚动条会吃掉 ~15px 内容宽、低页签没有 → 切页签时卡片边缘左右跳。
        // 现在滚动条槽位恒定（`scrollbar-gutter:stable`），列宽只由这一层算，三个页签一致。
        '.dshm-col{box-sizing:border-box;width:100%;max-width:1120px;margin:0 auto}',
        '.dshm-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}',
        // 标题阶梯（用户 2026-10-07：「大标题小标题样式不能一样否则分不清」）：
        //   页面标题 20px/600 ← l-20 档；卡片标题 16px ← base-strong-16 档；
        //   分组标题 14px/600（同字号靠字重与颜色区分）；正文 14px；字段标签/日志 12px。
        // 这些 token 名字**逐一在平台 UI 包里核对过**（`--dsw-font-*` 共 185 个真实名字）。
        '.dshm-title{margin:0;font-family:var(--dsw-font-l-20-font-family);',
        'font-size:var(--dsw-font-l-20-font-size);line-height:var(--dsw-font-l-20-line-height);font-weight:600}',
        '.dshm-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);',
        'border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);',
        'padding:12px 14px}',
        '.dshm-cardhead{display:flex;align-items:center;justify-content:space-between;',
        'gap:12px;margin-bottom:10px}',
        '.dshm-cardtitle{font-family:var(--dsw-font-base-strong-16-font-family);',
        'font-size:var(--dsw-font-base-strong-16-font-size);line-height:var(--dsw-font-base-strong-16-line-height);',
        'font-weight:var(--dsw-font-base-strong-16-font-weight)}',
        // 分组标题（如「一轮」那一行）：与正文同字号，靠**字重 + 主色**与行文本分开。
        '.dshm-group-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.dshm-panel{margin-top:16px;display:flex;flex-direction:column;gap:14px}',
        '.dshm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshm-toolbar>.dshm-grow{flex:1 1 14rem;min-width:0}',
        '.dshm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshm-list{display:flex;flex-direction:column;gap:8px}',
        // 跑一轮的进度条（用户 2026-10-07：「正在看 0/20」做成进度条）：条给直觉，数字给准数。
        '.dshm-progress-row{display:flex;align-items:center;gap:10px;margin-top:10px}',
        '.dshm-progress{flex:1 1 auto;min-width:0;height:6px;border-radius:999px;overflow:hidden;',
        'background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l1)}',
        '.dshm-progress-fill{height:100%;background:var(--dsw-alias-label-primary);transition:width .2s ease}',
        // 运行日志（仓管逐组在做的事）：等宽、12px、次要色；最多十来行，超出可滚。
        '.dshm-log{margin-top:6px;display:flex;flex-direction:column;gap:2px;max-height:11rem;overflow:auto}',
        '.dshm-log-line{font-family:var(--dsw-font-family);font-size:var(--dsw-font-xxs-12-font-size);',
        'color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
        '.dshm-item{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);',
        'padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}',
        '.dshm-item.is-clickable{cursor:pointer}',
        '.dshm-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshm-item-text{margin:0;white-space:pre-wrap;word-break:break-word}',
        '.dshm-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
        'color:var(--dsw-alias-label-tertiary)}',
        '.dshm-mono{font-family:var(--dsw-font-family)}',
        '.dshm-muted{color:var(--dsw-alias-label-secondary)}',
        '.dshm-faint{color:var(--dsw-alias-label-tertiary)}',
        '.dshm-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;',
        'word-break:break-word;font-family:var(--dsw-font-family)}',
        '.dshm-warn{color:var(--dsw-alias-state-error-primary)}',
        '.dshm-empty{color:var(--dsw-alias-label-tertiary);padding:10px 2px}',
        '.dshm-textarea{box-sizing:border-box;width:100%;min-height:4.5rem;resize:vertical;',
        'padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);',
        'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);',
        'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);',
        'font-size:var(--dsw-font-s-14-font-size);line-height:var(--dsw-font-s-14-line-height)}',
        '.dshm-select{box-sizing:border-box;width:100%;padding:8px 10px;',
        'border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);',
        'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
        'font-family:var(--dsw-font-family);font-size:var(--dsw-font-s-14-font-size)}',
        '.dshm-item.is-active{border-color:var(--dsw-alias-label-secondary)}',
        // 仓管档案列表：没配好的整行压暗（只降透明度，不写死颜色），右侧那排按钮推到行尾。
        '.dshm-dim{opacity:.55}',
        '.dshm-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}',
        // 仓管待审：一张变更单里的单条 op（框住一条决定），改动前是可折叠块（长文本别撑爆页面）。
        '.dshm-ops{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
        '.dshm-op{display:flex;flex-direction:column;gap:6px;min-width:0;',
        'border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:10px 12px}',
        '.dshm-block{display:flex;flex-direction:column;gap:4px;min-width:0}',
        // 待审区的「改动前 / 改动后」：这两块是**审阅时真正要看的东西**，所以给它们独立的框、
        // 左侧色条与标签（用户 2026-10-07：「让待审区的改动前/改动后更显眼，便于审阅」）。
        // 前 = 中性灰条（旧值、压暗），后 = 成功色条（新值、正常亮度）—— 只用主题 token，跟深浅色。
        '.dshm-diff{display:flex;flex-direction:column;gap:8px;margin-top:2px;min-width:0}',
        '.dshm-diff-part{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;min-width:0;',
        'border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);',
        'padding:8px 10px 8px 12px;background:var(--dsw-alias-bg-base)}',
        '.dshm-diff-part.is-before{border-left:3px solid var(--dsw-alias-border-l2)}',
        '.dshm-diff-part.is-after{border-left:3px solid var(--dsw-alias-state-success-primary)}',
        '.dshm-diff-label{display:inline-flex;align-items:baseline;gap:6px;',
        'font-family:var(--dsw-font-xs-strong-13-font-family);font-size:var(--dsw-font-xs-strong-13-font-size);',
        'line-height:var(--dsw-font-xs-strong-13-line-height);font-weight:var(--dsw-font-xs-strong-13-font-weight)}',
        '.dshm-diff-label.is-before{color:var(--dsw-alias-label-secondary)}',
        '.dshm-diff-label.is-after{color:var(--dsw-alias-state-success-primary)}',
        '.dshm-diff-count{font-weight:400;color:var(--dsw-alias-label-tertiary);',
        'font-size:var(--dsw-font-xxs-12-font-size)}',
        '.dshm-diff-text{margin:0;white-space:pre-wrap;word-break:break-word}',
        '.dshm-diff-text.is-before{color:var(--dsw-alias-label-secondary)}',
        '.dshm-diff-text.is-after{color:var(--dsw-alias-label-primary)}',
        '.dshm-diff-empty{color:var(--dsw-alias-state-error-primary)}',
        // 定为删除的记忆**整块标红**（用户 2026-10-07：「待审区中定为删除的记忆需要标红」）：
        // 认 `op.type === 'drop'` 这个结构化事实（.dshm-op.is-drop），**不去猜 warnings 文案**。
        // 前框的色条、正文、标签、以及那条「没写理由」的警告，全部走 error 色。
        '.dshm-op-line{color:var(--dsw-alias-label-secondary)}',
        '.dshm-op-reason{display:flex;gap:6px;min-width:0}',
        '.dshm-op-reason-text{color:var(--dsw-alias-label-secondary);word-break:break-word}',
        '.dshm-op.is-drop{border-color:var(--dsw-alias-state-error-primary)}',
        '.dshm-op.is-drop .dshm-op-line{color:var(--dsw-alias-state-error-primary)}',
        '.dshm-op.is-drop .dshm-diff-part{border-left-color:var(--dsw-alias-state-error-primary)}',
        '.dshm-op.is-drop .dshm-diff-label{color:var(--dsw-alias-state-error-primary)}',
        '.dshm-op.is-drop .dshm-diff-text{color:var(--dsw-alias-state-error-primary)}',
        '.dshm-op.is-drop .dshm-warn-list li{color:var(--dsw-alias-state-error-primary)}',
        // 折叠行：**第一项就是删除**时，摘要说的正是那条待删记忆 → 整行摘要标红（混合单不染，
        // 否则会把 merge / replace 也说成删除）。
        '.dshm-op-line.is-drop{color:var(--dsw-alias-state-error-primary)}',
        // 「正在处理的记忆」：跑一轮时贴在进度条下面，给这一组的成员正文（宿主每条截 200 字）。
        // 盒子用 bg-base + 边框与「改动前/后」同族；种子那一条用主色标出来（组是围绕它召回的）。
        '.dshm-current{display:flex;flex-direction:column;gap:4px;min-width:0;margin-top:10px;',
        'border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);',
        'background:var(--dsw-alias-bg-base);padding:8px 10px}',
        '.dshm-current-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.dshm-current-seed{color:var(--dsw-alias-label-primary)}',
        '.dshm-warn-list{display:flex;flex-direction:column;gap:2px;margin:4px 0 0;padding-left:1.2rem}',
        // 配置弹窗里的**一行一条参数**：标签定宽、控件撑满 —— 参数之间互不拥挤
        // （用户 2026-10-07：配置改用独立窗口展示，每条参数各自拥有该行的空间）。
        '.dshm-field-row{display:flex;align-items:center;gap:10px;min-width:0}',
        '.dshm-field-row+.dshm-field-row{margin-top:10px}',
        '.dshm-field-row>.dshm-field-label{flex:0 0 7rem}',
        '.dshm-field-label{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dshm-dot{width:10px;height:10px;flex:0 0 auto;border-radius:50%;cursor:pointer;',
        'border:.5px solid var(--dsw-alias-border-l1)}',
        '.dshm-dot.is-active{background:var(--dsw-alias-label-primary);',
        'border-color:var(--dsw-alias-label-primary)}',
        '.dshm-item-head>.dshm-grow{flex:1 1 auto;min-width:0}',
        '.dshm-item.is-row{padding:6px 10px;gap:4px}',
        // 折叠卡片按钮（副仓管收起来那一行）：整行可点 —— 箭头 + 卡片标题 + 右侧一句"点开能干什么"。
        '.dshm-cardtoggle{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex-wrap:wrap}',
        '.dshm-cardtoggle>.dshm-grow{flex:1 1 auto;min-width:0}',
      ].join('');
      document.head.appendChild(tag);
    }

    /** 本插件拥有的语言命名空间（注册项上的 `locale` 会让框架注入 `t` prop）。 */
    const NS = 'memory';

    /** 左栏一行与它打开的 `main` 键共用同一个 id。 */
    const PANEL_ID = 'memory';

    /** 面板专用接口前缀。落在 `/api` 之下，由 connection 统一做信任栅栏与鉴权。 */
    const API = '/api/dsh-memory';

    /** 回填进度轮询间隔（毫秒）。 */
    const POLL_MS = 2000;

    /** 搜索结果里正文的展示截断长度（全文点开单条再取）。 */
    const SEARCH_TEXT_LIMIT = 240;

    /** 搜索页「最近入库」块取几条（与宿主 `RECENT_LIMIT_DEFAULT` 同值：10）。 */
    const RECENT_LIMIT = 10;

    /**
     * 「副仓管」最多铺几行（多了改用一行「还有 N 项」）。队列里通常个位数，
     * 但仓管整轮失败时可能有十几组 —— 不能让它把「一轮流水」挤出屏幕。
     */
    const HANDOFF_SHOWN = 8;

    /** 「已处理」那一块在 `open` 状态里的键（收起 = 不铺流水）。 */
    const DONE_OPEN_KEY = 'done';

    // ── 2. 图标 ──────────────────────────────────────────────────────────────────
    //
    // 用查表而不是解构：万一某个图标名不在当前 primitives 版本里，解构得到 undefined，
    // 交给 createElement 会直接抛错并白屏整页。这里退化成 null（少个图标，面板还能用）。
    /**
     * 取一个图标节点。
     * @param {string} name primitives 里的图标导出名。
     * @param {number} size 边长（px）。
     * @returns {object|null} React 节点或 null。
     */
    function icon(name, size) {
      const Component = primitives[name];
      return typeof Component === 'function' ? h(Component, { size }) : null;
    }

    // ── 3. 语言包 ────────────────────────────────────────────────────────────────
    const zh = {
      panel: '记忆',
      title: '本地记忆',
      tabsLabel: '记忆面板分页',
      tabSearch: '搜索',
      tabSettings: '设置',
      tabKeeper: '仓管',
      tabSide: '副仓管',
      todoCount: '等你确认 {n} 件',
      todoOpen: '待确认',
      todoPassed: '已通过',
      todoPartial: '部分通过',
      todoRejected: '已驳回',
      todoDone: '已处理',
      todoKeeperRun: '仓管一轮',
      todoGroups: '{m} 张单 · 通过 {passed} · 驳回 {rejected}',
      todoMoreOps: '还有 {n} 项',
      todoRun: '启动仓管',
      todoRunning: '仓管正在看…',
      todoProgress: '正在看 {done}/{total} · 失败 {failed}',
      todoElapsed: '已跑 {time}',
      todoRunStats: '已出 {plans} 张单 / {ops} 条操作 · 跳过 {skipped} · 重试 {retried}',
      todoLastProgress: '最近一次进展 {sec} 秒前',
      todoStuckHint: '单组可能要几分钟，超时会自动重试一次 —— 进度暂时不动是正常的。',
      // 「已处理」收起来那一行右侧：收起的只是流水，轮数照旧写着。
      todoDoneRounds: '{n} 轮',
      // 跑一轮那条控制带下面的一句：某组失败归副仓管，模型在那一页选。
      keeperSideHint: '某一组失败就挂到「副仓管」，用那一页选的模型接手。',
      todoPass: '通过',
      todoApproveAll: '一键通过',
      todoApproveAllOk: '已通过 {n} 项。',
      todoApproveAllPartial: '通过 {ok} 项，{bad} 项失败。',
      // 副仓管（原「副审阅区」/「待接手记忆」）：**独立的一页 + 独立的一个仓管角色**。
      // 用户 2026-10-07：「副审阅区使用独立的仓管角色 独立建立页面『副仓管』」——
      // 那一页选一次模型（存 `settings.keeper.side`），每一条「接手」都用它重头整理。
      sideQueueTitle: '待接手 {n} 组',
      sideModelLabel: '副仓管模型',
      sideHint: '挂进来的组都用它**重头**整理（embedding 召回 → 组 → 出单）；不选 = 自动（本地优先 → 宿主）。',
      sideSaved: '副仓管模型已改。',
      sideSaveFailed: '改副仓管模型失败',
      sideEmpty: '副仓管手上没有挂着的组。',
      sideRunning: '正在接手（{taker}）…',
      sideLastRun: '上一次接手（{taker}）：{result}',
      handoffCount: '{n} 条记忆',
      handoffTried: '试过 {n} 次',
      handoffStart: '接手',
      handoffDrop: '清掉',
      handoffDropConfirm: '把这一组从副仓管队列里清掉？只清这一行的状态，记忆正文一个字都不动。',
      handoffDropped: '已清掉这一组（正文未动）。',
      handoffTaken: '接手完成：新出 1 张变更单（{n} 条操作），去「等你确认」审。',
      handoffTakenNone: '接手完成：这一组无需变更。',
      handoffAutoDropped: '涉及的记忆都已删除，这一组已自动清掉。',
      handoffFailed: '接手失败',
      todoRunHandoff: '副仓管挂了 {queued} 组 · 接手回来 {taken} 组',
      takerAuto: '自动（本地优先）',
      takerHost: '宿主模型',
      // 「转手」：待审变更单上的第三个动作（用户 2026-10-07）—— 原单停在 `handed`、记忆**入队**等你去「副仓管」页点「接手」。
      planHandoff: '转手',
      planHandoffConfirm:
        '把这张单转手给副仓管？原单停在「已转手」（不算通过、也不算驳回），它的记忆进副仓管队列 —— 之后由你在「副仓管」页点「接手」（模型就是那一页选的副仓管角色）。',
      planHandoffOk: '已转手：已挂进副仓管 —— 去「副仓管」页点「接手」（用那一页选的模型重头整理）。',
      planHandoffFailed: '转手失败',
      todoHanded: '已转手',
      kqBeforeN: '{n} 条',
      kqAfterN: '{n} 块',
      searchEdit: '改',
      searchEditTitle: '改写这条记忆',
      memEditLabel: '正文',
      memEditSubmit: '送审',
      memEditHint: '送审不会立刻改库：正文进待审区，过审后才「删旧录新」。',
      memEditOk: '已送进待审区（过审后才改库）。',
      memEditFailed: '送审失败',
      memEditEmpty: '正文不能为空。',
      memDeleteConfirm: '删除这条记忆？软删：整行与历史都保留，可从库里恢复。',
      memDeleted: '已删除（软删，可恢复）。',
      memDeleteFailed: '删除失败',
      todoReject: '驳回',
      todoPassConfirm: '通过这张单子？会按上面的方案落库（删改都留在历史里，能撤回）。',
      todoApplyOk: '已通过这张单子。',
      todoApplyNoReason: '已通过；有 {n} 条删除没写理由，已跳过（记忆一个字都没动）。',
      todoRejectOk: '已驳回这张单子（记忆没动）。',
      // 三个页签（用户 2026-10-07：「副审阅区…独立建立页面『副仓管』」+「移除目前空置的『待办』页面」）：
      // 「仓管」页 = 待审变更单 + 启动仓管 + 已处理流水；
      // 「副仓管」页 = 副仓管（那个**独立角色**用它自己选的模型接手）；
      // 原来那页「待办」（抽取待审区）**已按用户要求整页移除** —— 宿主路由与工具都还在。
      keeperApproveAllConfirm: '通过全部 {n} 张变更单？按方案落库 —— 这一步会真的改库。',
      keeperCurrentTitle: '正在处理的记忆（第 {n} 组 · {count} 条）',
      keeperCurrentSeed: '种子',
      keeperCurrentPending: '正在准备下一组…',
      opDrop: '删除 {n} 条',
      opSplit: '拆分 1 条 → {n} 块',
      opMerge: '合并 {n} 条 → 1 条',
      opReplace: '改写 {n} 条',
      keeperModelTitle: '仓管模型',
      keeperDeleted: '已删除。',
      keeperPingOk: '通了：{text}',
      fieldName: '档案名',
      fieldProvider: 'provider',
      fieldEndpoint: '端点 baseUrl',
      fieldModel: '模型 id',
      fieldApiKey: '密钥引用名',
      fieldTimeout: '超时 ms',
      loading: '加载中…',
      retry: '重试',
      cancel: '取消',
      delete: '删',
      save: '保存',
      search: '搜索',
      none: '—',
      empty: '暂无数据',
      // 搜索页 —— 那条记忆的两个行为计数器（读取 / 整理）标签
      scoreReadTag: '读取 {count}',
      scoreTidyTag: '整理 {count}',
      // 设置页 —— 仓管档案（多档案 + 主动切换：线上 OpenAI 兼容 / 局域网 Ollama / 本机 Ollama）
      keeperProfileNotConfigured: '未配置',
      // 搜索
      searchPlaceholder: '输入关键词（中文建议 ≥3 字，短词走 LIKE 兜底）',
      searchIdle: '输入关键词后回车或点「搜索」。',
      // 搜索页「最近入库」块：最近被记录进库的 10 条（入库时刻倒序，只读）
      recentTitle: '最近入库',
      recentHint: '最近被记进库的 {count} 条（按入库时刻倒序）',
      recentEmpty: '库里还没有记忆。',
      recentRefresh: '刷新',
      keywordScore: '关键词分',
      vectorScore: '向量分',
      source: '来源',
      noResults: '没有命中任何记忆。',
      tookMs: '耗时',
      vectorUnavailable: '向量检索本次未生效',
      expandHint: '点条目展开全文',
      fullTextLoading: '正在取全文…',
      // 设置
      model: '模型',
      dimensions: '维度',
      apiKeyRef: '密钥引用',
      keyWrite: '写入密钥',
      credentialPlaceholder: '粘贴密钥（不会回显）',
      credentialSave: '保存密钥',
      saved: '已保存。',
      credentialEmpty: '请先填入密钥。',
      saveFailed: '保存失败',
      // 设置 —— 嵌入配置档案
      dotSwitch: '点一下切到它',
      profilesTitle: '向量模型',
      profileConfigTitle: '档案配置',
      close: '关闭',
      profileNew: '＋ 新建档案',
      patchProfile: '补丁配置',
      keeperModelRequired: '请填模型 id（空的档案不显示，所以存不下去）。',
      profileEditHint: '点名字改',
      profileNameRequired: '请先填档案名。',
      profileNumberBad: '{field} 必须是正整数。',
      profileVectors: '{vectors} 条',
      profileMissing: '缺 {missing} 条',
      profileSwitchedLatest: '已切换，已是最新。',
      profileSwitchedFilling: '已切换，正在补齐 {missing} 条。',
      profileSwitchedMissing: '已切换，还缺 {missing} 条（补齐要单独触发回填）。',
      profileDeleteConfirm: '删除档案「{name}」？只删这个档案：它已有的向量保留，切回来仍然可用。',
      profileDeleted: '档案已删除（它的向量保留）。',
      profileDeletedActive: '档案已删除（它当时生效，已回落到 config）。',
      profileConfigUndeletable: '「config」是补丁配置，不能删，改 profile 补丁文件即可。',
      profileTest: '测',
      profileTesting: '正在测试…',
      profileTestOk: '{provider}/{model} → 返回 {dims} 维，耗时 {ms} ms',
      profileTestFailed: '测试失败',
      baseUrl: '接口地址',
      ollamaUrl: 'Ollama 地址',
      localDims: '本地哈希维度',
      // 仓管待审（第 6 个分页）：仓管不再直接改库，先出「变更单」，人在这里审过才落库。
      // 与「待审」页（抽取待审区）刻意分开：那条管**新事实入库**，这条管**已有记忆的二次加工**。
      kqRunFailed: '启动失败',
      kqBefore: '改动前',
      kqAfter: '改动后',
      kqReason: '理由',
      kqAfterEmpty: '这一项没有「改动后」正文：它就是删除。',
      kqReviewFailed: '提交失败',
    };

    const en = {
      panel: 'Memory',
      title: 'Local memory',
      tabsLabel: 'Memory panel tabs',
      tabSearch: 'Search',
      tabSettings: 'Settings',
      tabKeeper: 'Keeper',
      tabSide: 'Side keeper',
      todoCount: '{n} waiting for you',
      todoOpen: 'waiting',
      todoPassed: 'accepted',
      todoPartial: 'partial',
      todoRejected: 'rejected',
      todoDone: 'Handled',
      todoKeeperRun: 'Keeper round',
      todoGroups: '{m} plans · {passed} accepted · {rejected} rejected',
      todoMoreOps: 'and {n} more',
      todoRun: 'Start keeper',
      todoRunning: 'Keeper is looking…',
      todoProgress: 'looking {done}/{total} · {failed} failed',
      todoElapsed: 'running {time}',
      todoRunStats: '{plans} plans / {ops} ops · {skipped} skipped · {retried} retried',
      todoLastProgress: 'last progress {sec}s ago',
      todoStuckHint: 'A single group can take minutes; a timeout is retried once — a paused bar is normal.',
      todoDoneRounds: '{n} round(s)',
      keeperSideHint: 'A failed group goes to the side keeper; the model is chosen on that page.',
      todoPass: 'Accept',
      todoApproveAll: 'Accept all',
      todoApproveAllOk: 'Accepted {n} items.',
      todoApproveAllPartial: '{ok} accepted, {bad} failed.',
      sideQueueTitle: '{n} group(s) waiting to be taken over',
      sideModelLabel: 'Side keeper model',
      sideHint: 'Every queued group is re-organized from scratch with it (embedding recall → group → new plan); unset = automatic (local first, then host).',
      sideSaved: 'Side keeper model updated.',
      sideSaveFailed: 'Could not change the side keeper model',
      sideEmpty: 'The side keeper has nothing queued.',
      sideRunning: 'Taking over ({taker})\u2026',
      sideLastRun: 'Last takeover ({taker}): {result}',
      handoffCount: '{n} memories',
      handoffTried: 'tried {n}×',
      handoffStart: 'Take over',
      handoffDrop: 'Dismiss',
      handoffDropConfirm: 'Dismiss this group from the side keeper queue? Only this row\u2019s state changes; no memory text is touched.',
      handoffDropped: 'Dismissed (text untouched).',
      handoffTaken: 'Taken over: 1 new change plan ({n} ops) is waiting under "waiting for you".',
      handoffTakenNone: 'Taken over: this group needs no change.',
      handoffAutoDropped: 'All its memories are gone, so this group was dismissed automatically.',
      handoffFailed: 'Takeover failed',
      todoRunHandoff: '{queued} queued for the side keeper · {taken} taken over',
      takerAuto: 'Automatic (local first)',
      takerHost: 'Host model',
      planHandoff: 'Hand off',
      planHandoffConfirm:
        'Hand this plan to the side keeper? The plan stops at "handed off" (neither accepted nor rejected) and its memories are queued — you start it with "Take over" on the side keeper page (using the model chosen there).',
      planHandoffOk: 'Handed off: queued for the side keeper — press "Take over" on that page (it uses the model chosen there).',
      planHandoffFailed: 'Hand-off failed',
      todoHanded: 'handed off',
      kqBeforeN: '{n} item(s)',
      kqAfterN: '{n} block(s)',
      searchEdit: 'Edit',
      searchEditTitle: 'Rewrite this memory',
      memEditLabel: 'Text',
      memEditSubmit: 'Send to review',
      memEditHint: 'Sending does not write yet: the text goes to the review queue, and only after approval is the old memory deleted and the new one stored.',
      memEditOk: 'Sent to the review queue (nothing is written until it is approved).',
      memEditFailed: 'Could not send',
      memEditEmpty: 'The text cannot be empty.',
      memDeleteConfirm: 'Delete this memory? Soft delete: the row and its history stay and it can be restored.',
      memDeleted: 'Deleted (soft; restorable).',
      memDeleteFailed: 'Delete failed',
      todoReject: 'Reject',
      todoPassConfirm: 'Accept this plan? It will be applied as shown (everything stays in history and can be reverted).',
      todoApplyOk: 'Plan accepted.',
      todoApplyNoReason: 'Accepted; {n} delete(s) had no reason and were skipped (nothing was touched).',
      todoRejectOk: 'Plan rejected (memory untouched).',
      keeperApproveAllConfirm: 'Accept all {n} change plans? They will be applied as shown — this really writes to the store.',
      keeperCurrentTitle: 'Working on now (group {n} · {count})',
      keeperCurrentSeed: 'seed',
      keeperCurrentPending: 'Preparing the next group…',
      opDrop: 'drop {n}',
      opSplit: 'split into {n}',
      opMerge: 'merge {n} into 1',
      opReplace: 'replace {n}',
      keeperModelTitle: 'Keeper model',
      keeperDeleted: 'Deleted.',
      keeperPingOk: 'connected: {text}',
      fieldName: 'name',
      fieldProvider: 'provider',
      fieldEndpoint: 'endpoint baseUrl',
      fieldModel: 'model id',
      fieldApiKey: 'key reference',
      fieldTimeout: 'timeout ms',
      loading: 'Loading…',
      retry: 'Retry',
      cancel: 'Cancel',
      delete: 'Delete',
      save: 'Save',
      search: 'Search',
      none: '—',
      empty: 'Nothing to show',
      // Search page — the two behavioural counters (read / tidy) labels
      scoreReadTag: 'read {count}',
      scoreTidyTag: 'tidy {count}',
      // Settings page — keeper profiles (several complete LLM setups, switchable on demand)
      keeperProfileNotConfigured: 'not configured',
      keeperModelRequired: 'Enter a model id (a blank profile would not show up).',
      searchPlaceholder: 'Keywords (CJK: 3+ chars preferred; short terms use the LIKE fallback)',
      searchIdle: 'Type keywords, then press Enter or click Search.',
      recentTitle: 'Recently added',
      recentHint: '{count} most recently added memories (newest ingest first)',
      recentEmpty: 'No memories yet.',
      recentRefresh: 'Refresh',
      keywordScore: 'keyword',
      vectorScore: 'vector',
      source: 'Source',
      noResults: 'No memory matched.',
      tookMs: 'took',
      vectorUnavailable: 'vector retrieval was not used this time',
      expandHint: 'Click an item for the full text',
      fullTextLoading: 'Loading full text…',
      // Settings
      model: 'Model',
      dimensions: 'Dimensions',
      apiKeyRef: 'API key ref',
      keyWrite: 'Write key',
      credentialPlaceholder: 'Paste key (never echoed)',
      credentialSave: 'Save key',
      saved: 'Saved.',
      credentialEmpty: 'Enter a key first.',
      saveFailed: 'Save failed',
      dotSwitch: 'Click to switch to it',
      profilesTitle: 'Embedding model',
      profileConfigTitle: 'Profile',
      close: 'Close',
      profileNew: '＋ New profile',
      patchProfile: 'patch config',
      profileEditHint: 'Click the name to edit',
      profileNameRequired: 'Enter a profile name first.',
      profileNumberBad: '{field} must be a positive integer.',
      profileVectors: '{vectors} vectors',
      profileMissing: '{missing} missing',
      profileSwitchedLatest: 'Switched; already up to date.',
      profileSwitchedFilling: 'Switched; filling {missing} vectors.',
      profileSwitchedMissing: 'Switched; {missing} vectors are still missing (trigger a backfill separately).',
      profileDeleteConfirm: 'Delete profile "{name}"? Only the profile goes away: its vectors are kept and stay usable if you switch back.',
      profileDeleted: 'Profile deleted (its vectors are kept).',
      profileDeletedActive: 'Profile deleted (it was active; fell back to config).',
      profileConfigUndeletable: '"config" is the patch config and cannot be deleted; edit the profile patch file instead.',
      profileTest: 'Test',
      profileTesting: 'Testing…',
      profileTestOk: '{provider}/{model} → returned {dims} dims in {ms} ms',
      profileTestFailed: 'Test failed',
      baseUrl: 'Base URL',
      ollamaUrl: 'Ollama URL',
      localDims: 'Local hash dims',
      // Keeper queue (6th tab): the keeper no longer writes to the store itself — it proposes change
      // plans, and a human approves them here. Deliberately separate from the Review tab: that one
      // gates **new facts going in**, this one gates **second-pass work on existing memories**.
      kqRunFailed: 'Could not start',
      kqBefore: 'Before',
      kqAfter: 'After',
      kqReason: 'Why',
      kqAfterEmpty: 'This item has no "after" text: it is a delete.',
      kqReviewFailed: 'Could not submit',
    };

    // ── 4. 取数层 ────────────────────────────────────────────────────────────────

    /**
     * 把任意异常压成一行可显示文本。
     * @param {unknown} error 异常。
     * @returns {string} 文本。
     */
    function errorText(error) {
      if (error === null || error === undefined) return '';
      const name = error.name === undefined || error.name === null ? '' : String(error.name) + ': ';
      return name + String(error.message ?? error);
    }

    /**
     * 是否是「主动取消」造成的异常（卸载时 abort 会走到这里，不该显示成错误）。
     * @param {unknown} error 异常。
     * @returns {boolean} 是否取消。
     */
    function isAbort(error) {
      return error !== null && error !== undefined && error.name === 'AbortError';
    }

    /**
     * 调本插件的宿主接口。
     *
     * 用**相对路径** fetch：同源、带上会话 Cookie，`/api` 前缀处理器会做鉴权。
     * 解析失败要显式抛错（「HTTP 400：响应不是 JSON」正是 DESIGN §B 描述的那个陷阱现象，
     * 保留原状态码才能在真出问题时一眼认出来）。
     *
     * @param {string} path 相对 API 前缀的路径。
     * @param {{method?: string, query?: object|null, body?: object|null, signal?: AbortSignal}} [options] 选项。
     * @returns {Promise<object>} 解析后的响应体（**不**自动要求 ok===true）。
     */
    async function apiJson(path, options = {}) {
      const method = options.method ?? 'GET';
      const query = options.query ?? null;
      const body = options.body ?? null;
      let url = API + path;
      if (query !== null) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value === null || value === undefined || value === '') continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        if (qs !== '') url += '?' + qs;
      }
      /** @type {RequestInit} */
      const init = { method, signal: options.signal, headers: { accept: 'application/json' } };
      if (body !== null) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(url, init);
      const parsed = await response.json().catch(() => null);
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('HTTP ' + response.status + '：响应不是 JSON');
      }
      return parsed;
    }

    /**
     * 同 `apiJson`，但要求信封 `ok === true`，否则抛出信封里的错误文本。
     *
     * @param {string} path 路径。
     * @param {object} [options] 选项。
     * @returns {Promise<object>} 成功的响应体。
     */
    async function apiOk(path, options) {
      const result = await apiJson(path, options);
      if (result.ok !== true) throw new Error(String(result.error ?? '接口返回 ok=false'));
      return result;
    }

    /**
     * 「点按钮触发」的一次性请求：给一个能被卸载中止的 AbortController。
     *
     * 为什么不能裸 fetch：面板切分页 / 关页面时组件已卸载，响应回来再 setState 会告警，
     * 且慢请求（抽取、查冲突要调 LLM）会一直挂着。abort 让宿主尽快结束。
     *
     * @returns {(path: string, options?: object) => Promise<object>} 发起器。
     */
    function useAction() {
      const ref = React.useRef(null);
      React.useEffect(
        () => () => {
          const controller = ref.current;
          if (controller !== null) controller.abort();
        },
        [],
      );
      return React.useCallback((path, options) => {
        const previous = ref.current;
        if (previous !== null) previous.abort();
        const controller = new AbortController();
        ref.current = controller;
        return apiJson(path, { ...(options ?? {}), signal: controller.signal });
      }, []);
    }

    // ── 5. 小零件 ────────────────────────────────────────────────────────────────

    /**
     * 截断文本用于展示。
     * @param {unknown} text 原文。
     * @param {number} max 上限。
     * @returns {string} 展示文本。
     */
    function clip(text, max) {
      const value = String(text ?? '');
      return value.length > max ? value.slice(0, max) + '…' : value;
    }

    /**
     * id 缩到 8 位前缀（变更单的目标 id / 种子 / 成员都只展示前缀，全文在 `title` 里）。
     *
     * **改版时它被连旧分区一起删掉过**，而 `planDetail` 还在调它 —— 行折叠时不渲染详情，
     * 自检因此全绿，人一点开就 `ReferenceError` 白屏。别再把这类只在展开态用到的助手删掉。
     *
     * @param {unknown} value 原值。
     * @returns {string} 展示用短 id；空值给空串。
     */
    function shortId(value) {
      const text = value === null || value === undefined ? '' : String(value);
      return text.length > 8 ? text.slice(0, 8) : text;
    }

    /** 空值统一显示「—」，避免 undefined/null 直接漏到界面上。 */
    function orNone(value, t) {
      if (value === null || value === undefined || value === '') return t('none');
      return String(value);
    }

    /**
     * ISO 时间戳 → 本地**日期 + 时间**文本（仓管变更单的创建时间用）。
     *
     * 不裸调 `new Date(at).toLocaleString()`：字段缺失或值不是时间时它会给出
     * 「Invalid Date」；宁可原样回显那个值，也别在界面上摆一句看不懂的英文。
     *
     * @param {unknown} value 时间戳。
     * @returns {string} 本地日期时间文本；空值给空串。
     */
    function localDateTime(value) {
      if (value === null || value === undefined || value === '') return '';
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    /** 卡片外壳。 */
    function Card(props) {
      return h(
        'section',
        { className: 'dshm-card' },
        h(
          'div',
          { className: 'dshm-cardhead' },
          h('span', { className: 'dshm-cardtitle' }, props.title),
          props.action ?? null,
        ),
        props.children,
      );
    }

    /** 错误条：**绝不静默**，错误文本原样显示，可选一个重试按钮。 */
    function ErrorBox(props) {
      const text = props.text;
      if (text === null || text === undefined || text === '') return null;
      return h(
        'div',
        { className: 'dshm-card' },
        h('div', { className: 'dshm-error' }, String(text)),
        props.onRetry
          ? h(
              'div',
              { className: 'dshm-actions', style: { marginTop: 10 } },
              h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  icon: icon('IconRefreshOutlineRegular', 14),
                  onClick: props.onRetry,
                },
                props.retryLabel ?? 'Retry',
              ),
            )
          : null,
      );
    }

    /** 空态。 */
    function Empty(props) {
      return h('div', { className: 'dshm-empty' }, props.text);
    }

    // ── 6. 分页：仓管（默认页） ─────────────────────────────────────────────────
    //
    // 这一页的口径（和用户当面定的）：
    //   * 它是**读流水**的地方，不是一张待办清单 —— 只在真有待确认的东西时才出现按钮；
    //   * 已处理的按**轮次**分组（仓管跑一轮 → 一条流水，下面挂这一轮出的单），整块默认收起；
    //   * 点一行才展开前后对比；机器提示只在展开后出现。
    // 为此：零分页、零空状态文案、零说明段落。（副仓管的队列在它自己那一页，见 §6b。）

    /**
     * 一条 op 压成一行人话。
     * @param {Function} t 翻译函数。
     * @param {object} op 变更单里的一条 op。
     * @returns {string} 一行摘要。
     */
    function opLine(t, op) {
      const type = String(op?.type ?? '');
      const targets = Array.isArray(op?.targets) ? op.targets.length : 0;
      if (type === 'drop') return t('opDrop').replace('{n}', String(targets));
      if (type === 'split') {
        const blocks = Array.isArray(op?.after) ? op.after.length : 0;
        return t('opSplit').replace('{n}', String(blocks));
      }
      if (type === 'merge') return t('opMerge').replace('{n}', String(targets));
      if (type === 'replace' || type === 'rewrite') return t('opReplace').replace('{n}', String(targets));
      return type;
    }

    /**
     * 一行摘要后面那个「是哪个东西」：取改动前第一条的开头。
     * 没有它，一轮里十几行「删除 1 条」就完全一样 —— 只有数量、没有内容。
     * @param {object} op 变更单里的一条 op。
     * @param {number} [max] 最多留几个字。
     * @returns {string} 预览（没有改动前正文时是空串）。
     */
    function opPreview(op, max = 26) {
      const before = Array.isArray(op?.before) ? op.before : [];
      const text = before.length > 0 ? String(before[0]?.text ?? '') : '';
      return text === '' ? '' : clip(text.replace(/\s+/g, ' '), max);
    }

    /**
     * 一张变更单压成一行人话。
     *
     * 口径（用户 2026-10-07 指着旧的一行说「这个描述太抽象，难以理解」）：**先说它要动什么**，
     * 也就是「第一项做了什么 + 那条正文的开头」，而不是把 op 计数排一串（`删除 1 条 · 合并 2 条
     * → 1 条 · 拆分 1 条 → 7 块`）—— 那串数字读的人根本不知道会被改成什么。还有别的项就补一句
     * 「还有 N 项」，展开能看到每一项的前后对比。
     *
     * @param {Function} t 翻译函数。
     * @param {object} plan 变更单。
     * @returns {string} 一行摘要。
     */
    function planSummary(t, plan) {
      const ops = Array.isArray(plan?.ops) ? plan.ops : [];
      if (ops.length === 0) return t('none');
      const head = opLine(t, ops[0]);
      const preview = opPreview(ops[0], 44);
      const rest = ops.length > 1 ? ' · ' + t('todoMoreOps').replace('{n}', String(ops.length - 1)) : '';
      return (preview === '' ? head : head + '：' + preview) + rest;
    }

    /**
     * 一张单的**第一项**是不是删除 —— 折叠行的摘要说的正是第一项，所以「摘要要不要标红」看它。
     *
     * 为什么只看第一项（用户 2026-10-07：「待审区中定为删除的记忆需要标红」）：摘要是「第一项做了什么 +
     * 那条正文的开头」，如果第一项是 merge 却整行染红，读的人会把合并也当成删除；混了删除的单，
     * 展开后在那一项上标红（`.dshm-op.is-drop`）。
     *
     * @param {object} plan 变更单。
     * @returns {boolean} 第一项是否为 `drop`。
     */
    function firstOpIsDrop(plan) {
      const ops = Array.isArray(plan?.ops) ? plan.ops : [];
      return ops.length > 0 && String(ops[0]?.type ?? '') === 'drop';
    }

    /**
     * 流水里的时间只要「月/日 时:分」—— 年份和秒都是噪声。
     * @param {unknown} iso ISO 时间串。
     * @returns {string} 短时间。
     */
    function shortWhen(iso) {
      const text = String(localDateTime(iso));
      const m = /(\d{1,2}:\d{2}):\d{2}/.exec(text);
      if (m === null) return text;
      return text.slice(0, m.index).replace(/^\d{4}[\/-]/, '') + m[1];
    }

    /**
     * 副仓管那次接手的**结果一句话**（给「上一次接手（模型）：…」用）。
     *
     * 取宿主 `sideJob.tail` 的最后一行 —— 那是终态原文（「完成：N 条操作」/「失败：… → 放回队列」）。
     * 拿不到 tail 就退到 `error`，都没有就给一个破折号：**绝不编一句看起来像结果的话**。
     *
     * @param {object} job 副仓管的运行状态（`{tail,error}`）。
     * @returns {string} 一句话结果。
     */
    function sideResultText(job) {
      const tail = Array.isArray(job?.tail) ? job.tail : [];
      const last = tail.length > 0 ? String(tail[tail.length - 1]) : '';
      if (last !== '') return last;
      const error = String(job?.error ?? '');
      return error !== '' ? error : '\u2014';
    }

    /**
     * 仓管一轮的完成百分比（0–100）。
     *
     * `total` 缺失 / 为 0 / 非数字时给 0 —— **绝不把 NaN 塞进 style.width**（那是白屏与
     * 视觉错乱的经典来源）。进度条用它，数字仍由 `todoProgress` 那行文案照实报。
     *
     * @param {object} job 仓管任务进度（`{done,total,failed}`）。
     * @returns {number} 0–100 的整数。
     */
    function progressPercent(job) {
      const total = Number(job?.total ?? 0);
      const done = Number(job?.done ?? 0);
      if (!Number.isFinite(total) || total <= 0) return 0;
      const pct = Math.round((Math.min(Number.isFinite(done) ? done : 0, total) / total) * 100);
      return Math.max(0, Math.min(100, pct));
    }

    /**
     * 毫秒 → `m:ss`（超过一小时给 `h:mm:ss`）。非法值给空串 —— 界面上宁可少一段，不摆 `NaN:NaN`。
     * @param {unknown} ms 毫秒。
     * @returns {string} 时长文本。
     */
    function formatDuration(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) return '';
      const total = Math.floor(value / 1000);
      const seconds = String(total % 60).padStart(2, '0');
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      return hours > 0
        ? String(hours) + ':' + String(minutes).padStart(2, '0') + ':' + seconds
        : String(Math.floor(total / 60)) + ':' + seconds;
    }

    /**
     * 一轮已经跑了多久（毫秒）：用宿主给的 `startedAt`。缺 / 坏值给 0（界面少一段，不摆 NaN）。
     * @param {object} job 任务进度。
     * @returns {number} 毫秒。
     */
    function runElapsedMs(job) {
      const started = Date.parse(String(job?.startedAt ?? ''));
      if (!Number.isFinite(started)) return 0;
      return Math.max(0, Date.now() - started);
    }

    /**
     * 从某个时刻到现在过了几秒（心跳用：进度多久没动了）。
     * @param {number} at 时刻（epoch ms）。
     * @returns {number} 秒；没记过给 0。
     */
    function secondsSince(at) {
      const value = Number(at);
      if (!Number.isFinite(value) || value <= 0) return 0;
      return Math.max(0, Math.round((Date.now() - value) / 1000));
    }

    /**
     * 逐组日志：取最后 8 行（宿主最多给 20 行）。**最新的在下面** —— 跟真终端一个方向。
     * @param {object} job 任务进度。
     * @returns {string[]} 日志行。
     */
    function runTailLines(job) {
      const tail = Array.isArray(job?.tail) ? job.tail : [];
      return tail.slice(-8).map((line) => String(line));
    }

    /** 变更单状态 → 文案键。`handed` = 转手给副整理区了（`handOffPlan()` 之后原单停在这里）。 */
    const PLAN_STATE_KEY = {
      open: 'todoOpen',
      approved: 'todoPassed',
      partial: 'todoPartial',
      rejected: 'todoRejected',
      handed: 'todoHanded',
    };

    /**
     * 一张变更单的只读展开体：每条 op 的改动前 / 改动后 + 机器提示。
     *
     * 改动前 / 改动后各自一个**带左侧色条的框 + 醒目标签**（用户 2026-10-07：「让待审区的
     * 『改动前』『改动后』更显眼，便于审阅」）：原来两个标签只是灰字，一眼扫过去分不清哪块是
     * 旧的、哪块是新的。现在前块压暗、后块正常亮度，标签本身用 13px 强档并带条数
     * （`改动前 2 条` / `改动后 3 块`）—— split / merge 这种多项 op 不必再数段落。
     *
     * @param {Function} t 翻译函数。
     * @param {object} plan 变更单。
     * @returns {object} React 节点。
     */
    function planDetail(t, plan) {
      const ops = Array.isArray(plan?.ops) ? plan.ops : [];
      return h(
        'div',
        { className: 'dshm-ops' },
        ops.map((op, index) => {
          const before = Array.isArray(op?.before) ? op.before : [];
          const warnings = Array.isArray(op?.warnings) ? op.warnings : [];
          const after = op?.after;
          const afterBlocks = Array.isArray(after) ? after : null;
          const afterText = afterBlocks === null ? String(after ?? '') : '';
          /** 定为删除的一条：**整块标红**（用户 2026-10-07：「待审区中定为删除的记忆需要标红」）。 */
          const isDrop = String(op?.type ?? '') === 'drop';
          const reason = String(op?.reason ?? '').trim();
          return h(
            'div',
            { className: isDrop ? 'dshm-op is-drop' : 'dshm-op', key: 'detail-' + String(index) },
            h('div', { className: 'dshm-item-head' },
              h('span', { className: 'dshm-op-line' }, opLine(t, op)),
              h('span', { className: 'dshm-mono dshm-faint' },
                (Array.isArray(op?.targets) ? op.targets : []).map((id) => shortId(id)).join(' ')),
            ),
            // 理由紧跟标题：用户 2026-10-07「仓管提出删除时必须附带理由」—— 理由要**看得见**，
            // 只存在库里的理由是没人会去翻的。
            reason === ''
              ? null
              : h('div', { className: 'dshm-op-reason' },
                  h('span', { className: 'dshm-faint' }, t('kqReason')),
                  h('span', { className: 'dshm-op-reason-text' }, reason),
                ),
            h('div', { className: 'dshm-diff' },
              h('div', { className: 'dshm-diff-part is-before' },
                h('span', { className: 'dshm-diff-label is-before' },
                  t('kqBefore'),
                  before.length > 1
                    ? h('span', { className: 'dshm-diff-count' }, t('kqBeforeN').replace('{n}', String(before.length)))
                    : null,
                ),
                before.length === 0
                  ? h('span', { className: 'dshm-faint' }, t('none'))
                  : before.map((entry, beforeIndex) =>
                      h('p', { className: 'dshm-diff-text is-before', key: 'before-' + String(beforeIndex) },
                        String(entry?.text ?? '')),
                    ),
              ),
              warnings.length === 0
                ? null
                : h('ul', { className: 'dshm-warn-list' },
                    warnings.map((warning, warningIndex) =>
                      h('li', { key: 'warn-' + String(warningIndex) }, String(warning)),
                    )),
              h('div', { className: 'dshm-diff-part is-after' },
                h('span', { className: 'dshm-diff-label is-after' },
                  t('kqAfter'),
                  afterBlocks !== null && afterBlocks.length > 1
                    ? h('span', { className: 'dshm-diff-count' }, t('kqAfterN').replace('{n}', String(afterBlocks.length)))
                    : null,
                ),
                afterBlocks !== null
                  ? afterBlocks.map((block, blockIndex) =>
                      h('p', { className: 'dshm-diff-text is-after', key: 'after-' + String(blockIndex) }, String(block)),
                    )
                  : afterText === ''
                    ? h('span', { className: 'dshm-diff-empty' }, t('kqAfterEmpty'))
                    : h('p', { className: 'dshm-diff-text is-after' }, afterText),
              ),
            ),
          );
        }),
      );
    }

    /**
     * 仓管页（用户 2026-10-07：「为仓管单开一个页面 展示它正在处理的记忆是哪些 并且仓管整理完成的
     * 记忆也在该页面审阅」）。这一页把**主仓管那条线**收进来，自上而下：
     *   ① 「等你确认 N 件」= 它整理完等着人审的变更单（每张单：通过 / 驳回 / 转手）；
     *   ② 「启动仓管」= 一条控制带（只有按钮 + 一行说明；**模型归副仓管那页**）；
     *   ③ 「已处理」= 按轮次的只读流水，**默认收成一行卡片按钮**。
     * 副仓管（原副审阅区）的队列在它自己那一页；原来那页「待办」（抽取待审区）已整页移除。
     *
     * @param {{t: Function}} props 属性。
     * @returns {object} React 节点。
     */
    function KeeperTab(props) {
      const t = props.t;
      const call = useAction();
      const [plans, setPlans] = React.useState({ status: 'loading' });
      const [keeperJob, setKeeperJob] = React.useState(null);
      const [runBusy, setRunBusy] = React.useState(false);
      /** 展开的行：键是 `plan:<id>` / `run:<runId>` / `done`；默认全收起。 */
      const [open, setOpen] = React.useState({});
      const [pending, setPending] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [actionError, setActionError] = React.useState('');
      const [nonce, setNonce] = React.useState(0);
      /** 最近一次「真有进展」的时刻（`done` / `failed` / tail 行数变了才算）—— 回答「卡住了没」。 */
      const [progressAt, setProgressAt] = React.useState(0);
      /** 上一次的进度指纹（用 ref：它只用于比较，不该触发重渲染）。 */
      const progressKeyRef = React.useRef('');

      /**
       * 记一次进展。一轮里单组可能要跑几分钟，所以进度"暂时不动"是正常的 ——
       * 面板要能把这个说清楚（`progressAt` + 下面的提示文案），而不是让人干瞪眼。
       * @param {object|null} job 仓管任务进度。
       * @returns {void}
       */
      const markProgress = (job) => {
        const key =
          String(job?.done ?? 0) + '/' + String(job?.failed ?? 0) + '/' + String(Array.isArray(job?.tail) ? job.tail.length : 0);
        if (key === progressKeyRef.current) return;
        progressKeyRef.current = key;
        setProgressAt(Date.now());
      };

      React.useEffect(() => {
        const controller = new AbortController();
        apiJson('/keeper-plans', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            if (body.ok !== true) { setPlans({ status: 'error', message: String(body.error ?? '') }); return; }
            setPlans({ status: 'ready', items: Array.isArray(body.plans) ? body.plans : [] });
          },
          (error) => { if (!controller.signal.aborted && !isAbort(error)) setPlans({ status: 'error', message: errorText(error) }); },
        );
        apiJson('/keeper', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            const job = body?.job ?? null;
            setKeeperJob(job);
            markProgress(job);
          },
          () => undefined,
        );
        return () => controller.abort();
      }, [nonce]);

      // 仓管跑着的时候每 2 秒看一眼进度；跑完自动停。
      React.useEffect(() => {
        if (keeperJob === null || keeperJob.running !== true) return undefined;
        const controller = new AbortController();
        let timer = null;
        const tick = () => {
          apiJson('/keeper', { signal: controller.signal }).then(
            (body) => {
              if (controller.signal.aborted) return;
              const job = body?.job ?? null;
              setKeeperJob(job);
              markProgress(job);
              if (job !== null && job.running === true) timer = setTimeout(tick, POLL_MS);
              else { setRunBusy(false); setNonce((value) => value + 1); }
            },
            () => { if (!controller.signal.aborted) setRunBusy(false); },
          );
        };
        timer = setTimeout(tick, POLL_MS);
        return () => {
          controller.abort();
          if (timer !== null) clearTimeout(timer);
        };
      }, [keeperJob]);

      const runKeeper = () => {
        setRunBusy(true);
        setActionError('');
        setNotice('');
        // 某组失败时用哪个模型接手，由**「副仓管」这个角色**那一页的设定决定（用户 2026-10-07）——
        // 所以这一轮请求里不带 `taker`，宿主去读 `settings.keeper.side`。
        call('/keeper-run', { method: 'POST', body: {} }).then(
          (body) => {
            if (body.ok !== true) {
              setRunBusy(false);
              setActionError(t('kqRunFailed') + '：' + String(body.error ?? ''));
              return;
            }
            setKeeperJob(body.job ?? { running: true, done: 0, total: 0, failed: 0 });
          },
          (error) => {
            if (isAbort(error)) return;
            setRunBusy(false);
            setActionError(t('kqRunFailed') + '：' + errorText(error));
          },
        );
      };

      const reviewPlan = (plan, reject) => {
        const id = String(plan?.id ?? '');
        if (reject !== true) {
          const ok =
            typeof window === 'undefined' ||
            typeof window.confirm !== 'function' ||
            window.confirm(t('todoPassConfirm')) === true;
          if (!ok) return;
        }
        setPending('plan:' + id);
        setActionError('');
        setNotice('');
        call('/keeper-plan-review', {
          method: 'POST',
          body: reject === true ? { id, reject: true } : { id },
        }).then(
          (body) => {
            setPending('');
            if (body.ok !== true) {
              setActionError(t('kqReviewFailed') + '：' + String(body.error ?? ''));
              return;
            }
            // 「已通过」不能盖住「有一条没理由的删除被跳过」—— 那一步是真的没改库，必须说出来。
            const noReason = Number(body?.noReason ?? 0);
            if (reject === true) setNotice(t('todoRejectOk'));
            else if (Number.isFinite(noReason) && noReason > 0) setNotice(t('todoApplyNoReason').replace('{n}', String(noReason)));
            else setNotice(t('todoApplyOk'));
            setNonce((value) => value + 1);
          },
          (error) => {
            if (isAbort(error)) return;
            setPending('');
            setActionError(t('kqReviewFailed') + '：' + errorText(error));
          },
        );
      };

      const toggle = (key) => setOpen((current) => ({ ...current, [key]: current[key] !== true }));

      const items = plans.status === 'ready' ? plans.items : [];
      const openPlans = items.filter((plan) => String(plan?.state ?? '') === 'open');
      const donePlans = items.filter((plan) => String(plan?.state ?? '') !== 'open');
      const waiting = openPlans.length;

      /**
       * 一键通过：把「等你确认」里**现在所有**的变更单一次过掉（用户 2026-10-07：「审阅区新增一键通过」）。
       *
       * 三条口径：① **逐条串行**，不并发打宿主；② 失败的不藏起来，最后如实报「通过 N / 失败 M」；
       * ③ 二次确认里把数量写清楚（这一步是真的改库，误点代价最大）。
       * 抽取批次那条线的「一键通过」原本在「待办」页 —— 那一页（连同 `/pending`、`/batch`、`/review`
       * 三条路由）2026-10-07 已按用户要求整页移除；能力本身还在 `memory_review` 等工具里。
       * @returns {void}
       */
      const approveAll = () => {
        const planCount = openPlans.length;
        if (planCount === 0) return;
        const confirmed =
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          window.confirm(t('keeperApproveAllConfirm').replace('{n}', String(planCount))) === true;
        if (!confirmed) return;
        setPending('all');
        setNotice('');
        setActionError('');
        void (async () => {
          let ok = 0;
          let bad = 0;
          for (const plan of openPlans) {
            const body = await call('/keeper-plan-review', { method: 'POST', body: { id: String(plan?.id ?? '') } }).catch(
              (error) => ({ ok: false, error: errorText(error) }),
            );
            if (body?.ok === true) ok += 1;
            else bad += 1;
          }
          setPending('');
          if (bad === 0) setNotice(t('todoApproveAllOk').replace('{n}', String(ok)));
          else setActionError(t('todoApproveAllPartial').replace('{ok}', String(ok)).replace('{bad}', String(bad)));
          setNonce((value) => value + 1);
        })();
      };

      /**
       * **转手**：把一张待审变更单交给副仓管（用户 2026-10-07）。
       *
       * 三条口径：① 先二次确认（原单会**停在终态 `handed`**，既不算通过也不算驳回）；
       * ② **只入队、不自动开跑** —— 真正跑起来是在「副仓管」页点「接手」的时候，用的是那一页选的
       * 副仓管角色（`settings.keeper.side`）；这一步一个字都不打模型
       * （用户 2026-10-07 更正：「转手后进入副审阅区，最终由什么模型接手由我启动时决定」）；
       * ③ 结果如实报，失败也刷新（原单可能已经停在 `handed`，不能让界面显示成还开着）。
       * @param {object} plan 变更单。
       * @returns {void}
       */
      const handOffPlan = (plan) => {
        const id = String(plan?.id ?? '');
        if (id === '') return;
        const ok =
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          window.confirm(t('planHandoffConfirm')) === true;
        if (!ok) return;
        setPending('hand:' + id);
        setActionError('');
        setNotice('');
        call('/handoff-plan', { method: 'POST', body: { id } }).then(
          (body) => {
            setPending('');
            // 成败都要刷新：原单要变成「已转手」，副仓管那一页也要如实出现新的一行。
            setNonce((value) => value + 1);
            if (body.ok !== true) {
              setActionError(t('planHandoffFailed') + '：' + String(body.error ?? ''));
              return;
            }
            setNotice(t('planHandoffOk'));
          },
          (error) => {
            if (isAbort(error)) return;
            setPending('');
            setActionError(t('planHandoffFailed') + '：' + errorText(error));
            setNonce((value) => value + 1);
          },
        );
      };

      // 已处理的按 runId 分组，新的在前。
      const runs = [];
      const seen = new Map();
      for (const plan of donePlans) {
        const key = String(plan?.runId ?? '') === '' ? 'single' : String(plan.runId);
        if (!seen.has(key)) {
          const entry = { key, at: String(plan?.createdAt ?? ''), plans: [] };
          seen.set(key, entry);
          runs.push(entry);
        }
        const entry = seen.get(key);
        entry.plans.push(plan);
        if (String(plan?.createdAt ?? '') > entry.at) entry.at = String(plan.createdAt);
      }
      runs.sort((a, b) => String(b.at).localeCompare(String(a.at)));

      /** 「已处理」那块收 / 放：默认**收起**（用户 2026-10-07：「『已处理』内容收起来」）。 */
      const doneOpen = open[DONE_OPEN_KEY] === true;

      /** 拦冒泡：行本身要展开，按钮得自己吃掉这次点击（浅渲染里事件可能是假的，所以只做能做的）。 */
      const stop = (event) => {
        if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation();
      };

      /**
       * 一行的动作按钮组：`通过` / `驳回`；待审的变更单还多一个 **`转手`**（用户 2026-10-07：
       * 「为所有待审记忆改动新增按钮『转手』」）—— 第三个动作只在给了 `onHand` 时才画。
       * @param {string} key 行键（日志/去重用）。
       * @param {string} busyKey 忙碌键。
       * @param {Function} onPass 通过。
       * @param {Function} onReject 驳回。
       * @param {string} [passLabel] 通过按钮文案。
       * @param {Function} [onHand] 转手（省略 = 不画这个按钮）。
       * @returns {object} React 节点。
       */
      const actionRow = (key, busyKey, onPass, onReject, passLabel, onHand) =>
        h('div', { className: 'dshm-actions' },
          h(Button, { variant: 'primary', size: 'sm', disabled: pending !== '', onClick: (event) => { stop(event); onPass(); } }, passLabel ?? t('todoPass')),
          h(Button, { variant: 'ghost', size: 'sm', disabled: pending !== '', onClick: (event) => { stop(event); onReject(); } }, t('todoReject')),
          typeof onHand !== 'function'
            ? null
            : h(Button, { variant: 'outline', size: 'sm', disabled: pending !== '', onClick: (event) => { stop(event); onHand(); } }, t('planHandoff')),
        );

      // 待审的变更单（仓管整理完的产物）：一行一张，点开看前后对比 / 理由 / 机器提示。
      const waitingRows = openPlans.map((plan) => {
        const id = String(plan?.id ?? '');
        const key = 'plan:' + id;
        return h('div', { className: 'dshm-item is-row is-clickable', key, onClick: () => toggle(key) },
          h('div', { className: 'dshm-item-head' },
            h('span', { className: firstOpIsDrop(plan) ? 'dshm-op-line is-drop' : 'dshm-muted' }, planSummary(t, plan)),
            h('div', { className: 'dshm-grow' }),
            h('span', { className: 'dshm-faint' }, shortWhen(plan?.createdAt)),
            actionRow(key, 'plan:' + id, () => reviewPlan(plan, false), () => reviewPlan(plan, true), undefined, () => handOffPlan(plan)),
          ),
          open[key] === true ? planDetail(t, plan) : null,
        );
      });

      // 副仓管那一块（队列 + 接手 + 清掉）**整块搬到「副仓管」页**去了（用户 2026-10-07）：
      // 这一页只管主仓管 —— 待审变更单 / 跑一轮 / 已处理流水。


      return h(
        React.Fragment,
        null,
        waitingRows.length === 0
          ? null
          : h(Card, {
              title: t('todoCount').replace('{n}', String(waiting)),
              // 一键通过：只在这一块真有东西时才出现（空了整块都不画）。
              action: h(
                Button,
                { variant: 'primary', size: 'sm', disabled: pending !== '', onClick: approveAll },
                t('todoApproveAll'),
              ),
            },
              h('div', { className: 'dshm-list' }, waitingRows),
            ),
        // 上一动作的结果（转手）报在页顶 —— 原来这几行落在「已处理」卡片里，
        // 那句话和那张卡片说的不是一件事。
        notice === '' ? null : h('div', { className: 'dshm-muted' }, notice),
        actionError === '' ? null : h('div', { className: 'dshm-error' }, actionError),
        // 启动仓管：主动作独立成一条控制带（用户 2026-10-07：「按钮拿出来，并改为『启动仓管』」）。
        // 原来这个按钮挂在「已处理」卡片右上角，等于把"开一轮"藏进历史。这一块**不设标题**：
        // 里面没有需要被命名的内容，按钮自己就是它的名字（再加一个标题只会和按钮重复）。
        h('section', { className: 'dshm-card' },
          h('div', { className: 'dshm-field-row' },
            h(Button, {
              variant: 'primary',
              size: 'sm',
              icon: icon('IconRefreshOutlineRegular', 14),
              disabled: runBusy || pending !== '',
              onClick: runKeeper,
            }, runBusy ? t('todoRunning') : t('todoRun')),
          ),
          h('div', { className: 'dshm-faint', style: { marginTop: 4 } }, t('keeperSideHint')),
          // 跑一轮：**让人看见过程**（用户 2026-10-07：「我需要能看见仓管的工作过程…以及确保它
          // 没卡住而是在正常运行」）。四样东西，自上而下：
          //   ① 进度条（条给直觉，计数给准数）；
          //   ② 已跑多久 + 本轮产出（几张单 / 几条操作 / 跳过 / 重试）——从宿主 `publicKeeper()` 来；
          //   ③ **逐组日志**（tail：`组 N：开始（M 条记忆…）` / `组 N：3 条操作` / `组 N：超时，重试一次`）;
          //   ④ 心跳：最近一次进展是几秒前 + 一句"单组可能要几分钟"的说明 —— 否则进度不动就被当成卡死。
          keeperJob !== null && keeperJob.running === true
            ? h('div', null,
                h('div', { className: 'dshm-progress-row' },
                  h('div', { className: 'dshm-progress' },
                    h('div', {
                      className: 'dshm-progress-fill',
                      style: { width: String(progressPercent(keeperJob)) + '%' },
                    }),
                  ),
                  h('span', { className: 'dshm-faint' },
                    t('todoProgress')
                      .replace('{done}', String(keeperJob.done ?? 0))
                      .replace('{total}', String(keeperJob.total ?? 0))
                      .replace('{failed}', String(keeperJob.failed ?? 0))),
                ),
                // 「正在处理的是哪些记忆」（用户 2026-10-07）：tail 只写得出条数与种子前 8 位，
                // 所以宿主把这一组的成员摊在 `job.current` 上随轮询送出来（每条截 200 字）。
                // 两种"没有具体一条"要分清楚，别把前者说成后者：
                //   * 宿主**有** `current` 字段、值是 null → 组与组之间，画「正在准备下一组…」；
                //   * 宿主**根本没有**这个字段（宿主半没重载）→ 整块不画 —— 那时我们并不知道它在处理什么，
                //     画「准备下一组」就是在替宿主撒谎。
                Object.prototype.hasOwnProperty.call(keeperJob, 'current')
                  ? h('div', { className: 'dshm-current' },
                      keeperJob.current == null
                        ? h('div', { className: 'dshm-faint' }, t('keeperCurrentPending'))
                        : h(React.Fragment, null,
                            h('div', { className: 'dshm-current-head' },
                              h('span', { className: 'dshm-group-title' },
                                t('keeperCurrentTitle')
                                  .replace('{n}', String(Number(keeperJob.current.groupNo ?? 0)))
                                  .replace('{count}', String(Number(keeperJob.current.count ?? 0)))),
                              h('span', { className: 'dshm-mono dshm-faint' },
                                t('keeperCurrentSeed') + ' ' + shortId(String(keeperJob.current.seedId ?? ''))),
                            ),
                            (Array.isArray(keeperJob.current.members) ? keeperJob.current.members : []).map((member, index) =>
                              h('p', {
                                className:
                                  String(member?.id ?? '') === String(keeperJob.current.seedId ?? '')
                                    ? 'dshm-item-text dshm-current-seed'
                                    : 'dshm-item-text dshm-muted',
                                key: 'cur-' + String(index),
                              }, String(member?.text ?? '')),
                            ),
                          ),
                    )
                  : null,
                h('div', { className: 'dshm-meta', style: { marginTop: 6 } },
                  h('span', null, t('todoElapsed').replace('{time}', formatDuration(runElapsedMs(keeperJob)))),
                  h('span', null, t('todoRunStats')
                    .replace('{plans}', String(keeperJob.plans ?? 0))
                    .replace('{ops}', String(keeperJob.ops ?? 0))
                    .replace('{skipped}', String(keeperJob.skipped ?? 0))
                    .replace('{retried}', String(keeperJob.retried ?? 0))),
                  // 有待接手才显示这一格（0 组时不占地方）。
                  Number(keeperJob.handedOff ?? 0) + Number(keeperJob.takenOver ?? 0) === 0
                    ? null
                    : h('span', null, t('todoRunHandoff')
                        .replace('{queued}', String(keeperJob.handedOff ?? 0))
                        .replace('{taken}', String(keeperJob.takenOver ?? 0))),
                ),
                h('div', { className: 'dshm-log' },
                  runTailLines(keeperJob).map((line, index) =>
                    h('div', { className: 'dshm-log-line', key: 'tail-' + String(index) }, line),
                  ),
                ),
                progressAt === 0
                  ? null
                  : h('div', { className: 'dshm-faint', style: { marginTop: 6 } },
                      t('todoLastProgress').replace('{sec}', String(secondsSince(progressAt)))),
                h('div', { className: 'dshm-faint', style: { marginTop: 2 } }, t('todoStuckHint')),
              )
            : null,
        ),
        // 变更单读不出来时**不装作没有**（宿主半没重载 / 路由 404 时这行红字就是提示）。
        plans.status === 'error'
          ? h(ErrorBox, { text: plans.message, onRetry: () => setNonce((value) => value + 1), retryLabel: t('retry') })
          : null,
        plans.status === 'loading' ? h('div', { className: 'dshm-muted' }, t('loading')) : null,
        // 「已处理」= 只剩流水，而且**默认收成一行卡片按钮**（用户 2026-10-07：「『已处理』内容收起来」）：
        // 收起的只是那一串流水，轮数照旧写在那一行；这一块里**没有任何按钮 / 下拉 / 控制项**。
        runs.length === 0
          ? null
          : h('section', { className: 'dshm-card' },
              h('div', { className: 'dshm-cardtoggle', onClick: () => toggle(DONE_OPEN_KEY) },
                h('span', { className: 'dshm-faint' }, doneOpen ? '▾' : '▸'),
                h('span', { className: 'dshm-cardtitle dshm-grow' }, t('todoDone')),
                h('span', { className: 'dshm-faint' }, t('todoDoneRounds').replace('{n}', String(runs.length))),
              ),
              doneOpen
                ? h('div', { className: 'dshm-list', style: { marginTop: 10 } },
                    runs.slice(0, 20).map((run) => {
                      const passed = run.plans.filter((plan) => String(plan?.state ?? '') === 'approved').length;
                      const rejected = run.plans.filter((plan) => String(plan?.state ?? '') === 'rejected').length;
                      const runKey = 'run:' + run.key;
                      const runOpen = open[runKey] === true;
                      // 一轮 19 行流水默认**收起来**（用户 2026-10-07：「收起来」）：
                      // 平时只占一行（时间 · 仓管一轮 · 19 张单 · 通过 18 · 驳回 1），点开才铺开。
                      return h('div', { className: 'dshm-block', key: run.key },
                        h('div', { className: 'dshm-item is-row is-clickable', onClick: () => toggle(runKey) },
                          h('span', { className: 'dshm-faint' }, runOpen ? '▾' : '▸'),
                          // 分组标题：同字号但**字重 600 + 主色**，与下面 400 字重、次要色的行分开
                          // （用户 2026-10-07：「大标题小标题样式不能一样否则分不清」）。
                          h('div', { className: 'dshm-meta dshm-group-title' },
                            h('span', null, shortWhen(run.at)),
                            h('span', null, t('todoKeeperRun')),
                            h('span', null, t('todoGroups')
                              .replace('{m}', String(run.plans.length))
                              .replace('{passed}', String(passed))
                              .replace('{rejected}', String(rejected))),
                          ),
                        ),
                        runOpen
                          ? h('div', { className: 'dshm-list' },
                              run.plans.map((plan) => {
                                const id = String(plan?.id ?? '');
                                const key = 'plan:' + id;
                                const state = String(plan?.state ?? '');
                                return h('div', { className: 'dshm-item is-row is-clickable', key, onClick: () => toggle(key) },
                                  h('div', { className: 'dshm-item-head' },
                                    h('span', { className: firstOpIsDrop(plan) ? 'dshm-op-line is-drop' : 'dshm-muted' }, planSummary(t, plan)),
                                    h('div', { className: 'dshm-grow' }),
                                    h(Tag, { tone: state === 'approved' ? 'success' : state === 'rejected' ? 'quiet' : 'warning' },
                                      t(PLAN_STATE_KEY[state] ?? 'none')),
                                  ),
                                  open[key] === true ? planDetail(t, plan) : null,
                                );
                              }),
                            )
                          : null,
                      );
                    }),
                  )
                : null,
            ),
      );
    }

    // ── 6b. 分页：副仓管（用户 2026-10-07：「副审阅区使用独立的仓管角色 独立建立页面『副仓管』」）──
    //
    // 这一页就是原来挤在「仓管」页里的副仓管，现在**单开一页 + 单有一个角色**：
    //   * 「副仓管模型」= 这个角色用哪个模型（选一次、存 `settings.keeper.side`；与主仓管的
    //     `keeper.active` **各存各的**）—— 所以不再逐条弹窗问「用哪个模型」；
    //   * 队列 = 挂进来的组（仓管某组失败 / 人把待审单转手过来）：一行一组，点「接手」就用
    //     上面那个模型**重头**整理（只出单、不改正文），「清掉」只改这一行的状态。
    //
    // 空队列时给一行「副仓管手上没有挂着的组」—— 独立成页之后，空白必须说清楚是"没有"，不是坏了。
    // （原来挤在「仓管」页时是"空了整块不画"，那是同一页里的口径，搬到独立页就不适用了。）

    /**
     * 「副仓管模型」下拉的候选：**已配好的**仓管档案 + 宿主模型 + 「自动」。
     *
     * 从 `/keeper` 的 `profiles` / `hostModel` 现算（与「设置 → 仓管模型」那份列表同一个来源）。
     *
     * @param {object} body `/keeper` 的响应体。
     * @param {Function} t 翻译函数。
     * @returns {{options: object[], hostModel: string|null}} 候选与宿主模型 id
     */
    function takerOptions(body, t) {
      const hostModel = body?.hostModel == null ? null : String(body.hostModel);
      const options = [
        { value: 'auto', label: t('takerAuto') },
        ...(Array.isArray(body?.profiles) ? body.profiles : [])
          .filter((profile) => profile?.configured === true && profile?.builtin !== true)
          .map((profile) => ({
            value: String(profile.name),
            label: profile.model == null ? String(profile.name) : `${String(profile.name)} / ${String(profile.model)}`,
          })),
        { value: 'host', label: hostModel == null || hostModel === '' ? t('takerHost') : `${t('takerHost')} / ${hostModel}` },
      ];
      return { options, hostModel };
    }

    /**
     * 分页：副仓管。
     *
     * 状态顺序（`useState` 的先后）：1 keeper / 2 handoffs / 3 pending / 4 notice / 5 actionError /
     * 6 nonce / **7 sideJob**（新状态只能往后加 —— 浅渲染按位置喂状态）。
     *
     * @param {{t: Function}} props 属性。
     * @returns {object} React 节点。
     */
    function SideTab(props) {
      const t = props.t;
      const call = useAction();
      const [keeper, setKeeper] = React.useState({ status: 'loading' });
      const [handoffs, setHandoffs] = React.useState({ status: 'loading' });
      const [pending, setPending] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [actionError, setActionError] = React.useState('');
      const [nonce, setNonce] = React.useState(0);
      // 副仓管**自己**的运行状态（宿主 `keeperStatus().sideJob`）：与主仓管那一轮各存各的。
      // ⚠️ 必须是**最后一个** state：`tools/check-client.mjs` 的浅渲染按位置喂状态
      // （`__stateQueue`），插在中间会把后面每个状态都挤错位（踩过：136 → 131）。
      const [sideJob, setSideJob] = React.useState(null);

      React.useEffect(() => {
        const controller = new AbortController();
        apiJson('/keeper', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            setKeeper({ status: 'ready', ...body, ...takerOptions(body, t) });
            setSideJob(body?.sideJob ?? null);
          },
          (error) => {
            if (controller.signal.aborted || isAbort(error)) return;
            setKeeper({ status: 'error', message: errorText(error) });
          },
        );
        apiJson('/handoffs', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            if (body.ok !== true) {
              setHandoffs({ status: 'error', message: String(body.error ?? '') });
              return;
            }
            setHandoffs({ status: 'ready', items: Array.isArray(body.handoffs) ? body.handoffs : [] });
          },
          (error) => {
            if (controller.signal.aborted || isAbort(error)) return;
            setHandoffs({ status: 'error', message: errorText(error) });
          },
        );
        return () => controller.abort();
      }, [nonce]);

      // 副仓管接手跑着的时候每 2 秒看一眼（与仓管那条进度同一个节奏）；跑完刷新队列：
      // 成功那一行会变成 `taken` 从列表里消失，失败会带回新的原因与「试过 N 次」。
      React.useEffect(() => {
        if (sideJob === null || sideJob.running !== true) return undefined;
        const controller = new AbortController();
        let timer = null;
        const tick = () => {
          apiJson('/keeper', { signal: controller.signal }).then(
            (body) => {
              if (controller.signal.aborted) return;
              const next = body?.sideJob ?? null;
              setSideJob(next);
              if (next !== null && next.running === true) timer = setTimeout(tick, POLL_MS);
              else setNonce((value) => value + 1);
            },
            () => undefined,
          );
        };
        timer = setTimeout(tick, POLL_MS);
        return () => {
          controller.abort();
          if (timer !== null) clearTimeout(timer);
        };
      }, [sideJob]);

      /**
       * 换这个角色用的模型：**只写一行设置**（`POST /keeper-side` → `settings.keeper.side`）。
       * @param {string} model `'auto'` / 档案名 / `'host'`。
       * @returns {void}
       */
      const saveSideModel = (model) => {
        setPending('side');
        setNotice('');
        setActionError('');
        call('/keeper-side', { method: 'POST', body: { model } }).then(
          (body) => {
            setPending('');
            if (body.ok !== true) {
              setActionError(t('sideSaveFailed') + '：' + String(body.error ?? ''));
              setNonce((value) => value + 1);
              return;
            }
            // 宿主把设定后的现状回给我们（`status`）——拿它覆盖本地那份，下拉立刻是新的。
            setKeeper((current) => ({ ...current, status: 'ready', ...(body.status ?? {}), side: body.side ?? null }));
            setNotice(t('sideSaved'));
          },
          (error) => {
            if (isAbort(error)) return;
            setPending('');
            setActionError(t('sideSaveFailed') + '：' + errorText(error));
            setNonce((value) => value + 1);
          },
        );
      };

      /**
       * 用**这一页选的模型**开跑一条：与 run 里当场接手同一个宿主方法（`reorganizeMemories`），
       * **只出单、不改正文**。三种结果如实报：出了单（去「等你确认」审）、无需变更、记忆已全删
       * （宿主自动清掉这一行）。
       *
       * 请求体**不带 `model`** —— 宿主用「副仓管」这个角色存下来的选择（`settings.keeper.side`）。
       * 这正是"独立的仓管角色"：模型在这一页选一次，每一条都用它，不再逐条问。
       *
       * @param {string} id 副仓管项 id。
       * @returns {void}
       */
      const takeOver = (id) => {
        const handoffId = String(id ?? '');
        if (handoffId === '') return;
        setPending('handoff:' + handoffId);
        setActionError('');
        setNotice('');
        call('/handoff-takeover', { method: 'POST', body: { id: handoffId } }).then(
          (body) => {
            setPending('');
            // 成败都刷新：成功这一行会消失（taken），失败要看到新的原因与试过次数。
            setNonce((value) => value + 1);
            if (body.ok !== true) {
              setActionError(t('handoffFailed') + '：' + String(body.error ?? ''));
              return;
            }
            const state = String(body?.handoff?.state ?? '');
            const ops = Number(body?.ops ?? 0);
            if (state === 'dropped') setNotice(t('handoffAutoDropped'));
            else if (!Number.isFinite(ops) || ops <= 0) setNotice(t('handoffTakenNone'));
            else setNotice(t('handoffTaken').replace('{n}', String(ops)));
          },
          (error) => {
            if (isAbort(error)) return;
            setPending('');
            setActionError(t('handoffFailed') + '：' + errorText(error));
            setNonce((value) => value + 1);
          },
        );
      };

      /**
       * 把一组从队列里清掉。**只动那一行的状态，记忆正文一个字都不碰。**
       * @param {object} row 副仓管项。
       * @returns {void}
       */
      const dismissHandoff = (row) => {
        const id = String(row?.id ?? '');
        if (id === '') return;
        const ok =
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          window.confirm(t('handoffDropConfirm')) === true;
        if (!ok) return;
        setPending('handoff:' + id);
        setActionError('');
        setNotice('');
        call('/handoff-drop', { method: 'POST', body: { id } }).then(
          (body) => {
            setPending('');
            if (body.ok !== true) {
              setActionError(t('handoffFailed') + '：' + String(body.error ?? ''));
              return;
            }
            setNotice(t('handoffDropped'));
            setNonce((value) => value + 1);
          },
          (error) => {
            if (isAbort(error)) return;
            setPending('');
            setActionError(t('handoffFailed') + '：' + errorText(error));
          },
        );
      };

      const items = handoffs.status === 'ready' ? handoffs.items : [];
      const side = keeper.status === 'ready' && keeper.side != null ? String(keeper.side) : 'auto';
      // 候选还没取回来时也留「自动」一项：下拉不能是空的（那看着像坏了）。
      const options =
        keeper.status === 'ready' && Array.isArray(keeper.options) && keeper.options.length > 0
          ? keeper.options
          : [{ value: 'auto', label: t('takerAuto') }];
      // 选中的那个如果已经不在候选里（档案被删 / 改坏了），回落到「自动」——别显示一个不存在的选项。
      const value = options.some((option) => option.value === side) ? side : 'auto';

      const rows = items.slice(0, HANDOFF_SHOWN).map((row) => {
        const id = String(row?.id ?? '');
        const members = Array.isArray(row?.members) ? row.members : [];
        const count = Number(row?.count ?? members.length);
        return h('div', { className: 'dshm-item', key: 'handoff:' + id },
          h('div', { className: 'dshm-item-head' },
            // 这一行为什么在这儿：失败原因 / 「面板转手：原单 xxxxxxxx 请你接手」。
            h('span', { className: 'dshm-error dshm-grow' }, String(row?.error ?? '')),
            h('span', { className: 'dshm-faint' }, t('handoffCount').replace('{n}', String(count))),
            h('span', { className: 'dshm-faint' }, t('handoffTried').replace('{n}', String(Number(row?.attempts ?? 0)))),
            h('span', { className: 'dshm-faint' }, shortWhen(row?.createdAt)),
            h('div', { className: 'dshm-actions' },
              // 「接手」= 用上面那条控制带里选的模型开跑（**不弹窗问模型**）。
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: pending !== '',
                onClick: () => takeOver(id),
              }, t('handoffStart')),
              h(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: pending !== '',
                onClick: () => dismissHandoff(row),
              }, t('handoffDrop')),
            ),
          ),
          // 成员预览（宿主最多给 3 条、每条截 80 字）：一眼看出「是哪一坨记忆卡住了」。
          members.map((member, index) =>
            h('p', { className: 'dshm-item-text dshm-muted', key: 'hm-' + String(index) }, String(member?.text ?? '')),
          ),
        );
      });

      return h(
        React.Fragment,
        null,
        // 这个角色用哪个模型：一条控制带（与「启动仓管」同一种样式）+ 一行小字说明。
        keeper.status === 'error'
          ? h(ErrorBox, { text: keeper.message, onRetry: () => setNonce((value) => value + 1), retryLabel: t('retry') })
          : h('section', { className: 'dshm-card' },
              h('div', { className: 'dshm-field-row' },
                h('span', { className: 'dshm-field-label' }, t('sideModelLabel')),
                h('div', { className: 'dshm-grow' },
                  h('select', {
                    className: 'dshm-select',
                    value,
                    disabled: pending !== '',
                    onChange: (event) => saveSideModel(String(event?.target?.value ?? 'auto')),
                  },
                    options.map((option) =>
                      h('option', { value: option.value, key: 'side-' + option.value }, option.label),
                    ),
                  ),
                ),
              ),
              h('div', { className: 'dshm-faint', style: { marginTop: 4 } }, t('sideHint')),
            ),
        notice === '' ? null : h('div', { className: 'dshm-muted' }, notice),
        actionError === '' ? null : h('div', { className: 'dshm-error' }, actionError),
        // 副仓管**自己**的运行状态：跑着就说在跑，跑完留下"上一次用了哪个模型、结果如何"。
        // 没有在跑也没有跑过 → 一个字都不画（空状态不占位）。
        sideJob !== null && (sideJob.running === true || sideJob.finishedAt != null)
          ? h('div', { className: 'dshm-faint' },
              sideJob.running === true
                ? t('sideRunning').replace('{taker}', String(sideJob.taker ?? t('takerAuto')))
                : t('sideLastRun')
                    .replace('{taker}', String(sideJob.taker ?? '\u2014'))
                    .replace('{result}', sideResultText(sideJob)),
            )
          : null,
        // 队列读不到时**不装作没有**（宿主半没重载时 `/handoffs` 会 404 —— 这行红字就是提示）。
        handoffs.status === 'error'
          ? h(ErrorBox, { text: handoffs.message, onRetry: () => setNonce((value) => value + 1), retryLabel: t('retry') })
          : null,
        handoffs.status === 'ready' && items.length === 0 ? h(Empty, { text: t('sideEmpty') }) : null,
        rows.length === 0
          ? null
          : h(Card, { title: t('sideQueueTitle').replace('{n}', String(items.length)) },
              h('div', { className: 'dshm-list' }, rows),
              items.length > HANDOFF_SHOWN
                ? h('div', { className: 'dshm-faint' },
                    t('todoMoreOps').replace('{n}', String(items.length - HANDOFF_SHOWN)))
                : null,
            ),
      );
    }

    // ── 7. 分页：搜索 ───────────────────────────────────────────────────────────

    /**
     * 搜索：输入 → 结果列表 → 点条目展开全文。
     * @param {{t: Function}} props 属性。
     * @returns {object} React 节点。
     */
    function SearchTab(props) {
      const t = props.t;
      const call = useAction();
      const [draft, setDraft] = React.useState('');
      const [submitted, setSubmitted] = React.useState(null);
      const [state, setState] = React.useState({ status: 'idle' });
      const [openId, setOpenId] = React.useState(null);
      const [openState, setOpenState] = React.useState({ status: 'idle' });

      // 每次提交都新建 controller：上一次的请求必须 abort，否则慢响应会覆盖新结果。
      React.useEffect(() => {
        if (submitted === null) return undefined;
        const controller = new AbortController();
        setState({ status: 'loading' });
        apiJson('/search', {
          query: { q: submitted.q, limit: 20 },
          signal: controller.signal,
        }).then(
          (body) => {
            if (controller.signal.aborted) return;
            if (body.ok === true) setState({ status: 'ready', data: body });
            else setState({ status: 'error', message: String(body.error ?? 'search failed') });
          },
          (error) => {
            if (controller.signal.aborted || isAbort(error)) return;
            setState({ status: 'error', message: errorText(error) });
          },
        );
        return () => controller.abort();
      }, [submitted]);

      const submit = () => {
        const q = draft.trim();
        if (q === '') return;
        setOpenId(null);
        // nonce 让「同一个词再搜一次」也能触发 effect。
        setSubmitted({ q, nonce: Date.now() });
      };

      const toggle = (id) => {
        if (openId === id) {
          setOpenId(null);
          return;
        }
        setOpenId(id);
        setOpenState({ status: 'loading' });
        call('/memory', { query: { id } }).then(
          (body) => {
            if (body.ok === true) setOpenState({ status: 'ready', memory: body.memory ?? null });
            else setOpenState({ status: 'error', message: String(body.error ?? 'not found') });
          },
          (error) => {
            if (isAbort(error)) return;
            setOpenState({ status: 'error', message: errorText(error) });
          },
        );
      };

      const data = state.status === 'ready' ? state.data : null;
      const items = data !== null && Array.isArray(data.items) ? data.items : [];

      /** 被改写的那条（`null` = 没开窗口）；`editDraft` 是窗口里那一稿正文。 */
      const [editing, setEditing] = React.useState(null);
      const [editDraft, setEditDraft] = React.useState('');
      const [editBusy, setEditBusy] = React.useState(false);
      const [editError, setEditError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [actionError, setActionError] = React.useState('');
      // 「最近入库」（本页新增的那一块）：**最后一个 state** —— 加在这里不动前面 11 个 state
      // 的下标，浅渲染自检（tools/check-client.mjs 的 __stateQueue）才不会被这次改动打乱。
      const [recent, setRecent] = React.useState({ status: 'loading' });

      /**
       * 取「最近入库」那一段（GET `/recent`，宿主按 `created_at DESC` 给前 N 条）。
       *
       * 与搜索是**两条独立请求**：搜索盖掉旧搜索结果，不该把这一块也冲掉。
       * 失败就在块里如实显示原因（绝不静默 —— 与全站同一条口径）。
       *
       * @returns {void}
       */
      const reloadRecent = React.useCallback(() => {
        setRecent({ status: 'loading' });
        call('/recent', { query: { limit: RECENT_LIMIT } }).then(
          (body) => {
            if (body.ok === true) setRecent({ status: 'ready', data: body });
            else setRecent({ status: 'error', message: String(body.error ?? 'recent failed') });
          },
          (error) => {
            if (isAbort(error)) return;
            setRecent({ status: 'error', message: errorText(error) });
          },
        );
      }, [call]);

      // 进搜索页就取一次；`call` 是稳定引用（内部 useCallback([])），所以这不会重复触发。
      React.useEffect(() => {
        reloadRecent();
      }, [reloadRecent]);

      /** 拦冒泡：行点击是「展开全文」，行里的按钮不该把它收回去。 */
      const stop = (event) => {
        if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation();
      };

      /**
       * 开「改写」窗口。**新正文只送待审区，不直接改库**（用户定的口径：
       * 改记忆 = 依原记忆编写新正文 → 待审区 → 过审后删旧录新）。
       * @param {string} id 记忆 id。
       * @param {string} text 当前全文。
       * @returns {void}
       */
      const startEdit = (id, text) => {
        setEditing({ id });
        setEditDraft(text);
        setEditError('');
        setNotice('');
        setActionError('');
      };

      const closeEdit = () => {
        setEditing(null);
        setEditDraft('');
        setEditError('');
      };

      /** 送审：`/propose` 与工具 `memory_keeper {action:'propose'}` 走同一个 service 方法。 */
      const saveEdit = () => {
        if (editing === null) return;
        const text = editDraft.trim();
        if (text === '') {
          setEditError(t('memEditEmpty'));
          return;
        }
        setEditBusy(true);
        setEditError('');
        call('/propose', { method: 'POST', body: { id: String(editing.id), text } }).then(
          (body) => {
            setEditBusy(false);
            if (body.ok !== true) {
              setEditError(t('memEditFailed') + '：' + String(body.error ?? ''));
              return;
            }
            setNotice(t('memEditOk'));
            setOpenId(null);
            closeEdit();
          },
          (error) => {
            if (isAbort(error)) return;
            setEditBusy(false);
            setEditError(t('memEditFailed') + '：' + errorText(error));
          },
        );
      };

      /** 删这条记忆：软删（行与历史都留着、可恢复），删完重搜一次让列表如实刷新。 */
      const removeMemory = (id) => {
        const confirmed =
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          window.confirm(t('memDeleteConfirm')) === true;
        if (!confirmed) return;
        setEditBusy(true);
        setNotice('');
        setActionError('');
        call('/forget', { method: 'POST', body: { id } }).then(
          (body) => {
            setEditBusy(false);
            if (body.ok !== true) {
              setActionError(t('memDeleteFailed') + '：' + String(body.error ?? ''));
              return;
            }
            setNotice(t('memDeleted'));
            setOpenId(null);
            // 重搜一次：列表里那条该消失（软删后检索过滤掉它）。
            setSubmitted((current) => (current === null ? null : { q: current.q, nonce: Date.now() }));
            // 「最近入库」块也重取一次：软删的那条不该再出现在「最近入库」里。
            reloadRecent();
          },
          (error) => {
            if (isAbort(error)) return;
            setEditBusy(false);
            setActionError(t('memDeleteFailed') + '：' + errorText(error));
          },
        );
      };

      /**
       * 画一行记忆（搜索结果与「最近入库」**共用这一个行渲染器**）。
       *
       * 两处的差别只有装饰，所以差别被收进这里：
       * - `withScore=true`（搜索结果）：画相关度分 + 两个行为计数器 Tag + 关键词/向量分明细；
       * - `withScore=false`（最近入库）：这些**一个都不画** —— 「最近入库」没有检索分数，
       *   硬画出来就是 0 / NaN，那种行是假信息。改画**入库时刻**。
       *
       * 展开/收起、全文加载、`改`（送审）/`删`（软删）两处行为完全一致。
       *
       * @param {object} item 条目（搜索结果项或列表项）。
       * @param {number} index 在列表里的序号（无 id 时用来兜底 key）。
       * @param {boolean} withScore 是否画检索分数。
       * @returns {object} React 节点。
       */
      const renderRow = (item, index, withScore) => {
        const id = String(item.id ?? '');
        const expanded = openId === id;
        const children = [
          h(
            'div',
            { className: 'dshm-item-head', key: 'head' },
            withScore
              ? h(Tag, null, String(Number(item.score ?? 0).toFixed(3)))
              : h(Tag, { tone: 'quiet' }, localDateTime(item.createdAt)),
            // 两个行为计数器的小 Tag：宿主没给（老版本）就整块不画，绝不摆出 NaN。
            withScore && Number.isFinite(Number(item.readScore))
              ? h(Tag, { tone: 'quiet' }, t('scoreReadTag').replace('{count}', String(Math.round(Number(item.readScore) * 100) / 100)))
              : null,
            withScore && Number.isFinite(Number(item.tidyScore))
              ? h(Tag, { tone: 'quiet' }, t('scoreTidyTag').replace('{count}', String(Math.round(Number(item.tidyScore) * 100) / 100)))
              : null,
            h('span', { className: 'dshm-faint' }, t('source') + ' ' + orNone(item.source, t)),
            item.section ? h('span', { className: 'dshm-faint' }, String(item.section)) : null,
            withScore
              ? h(
                  'span',
                  { className: 'dshm-faint dshm-mono' },
                  t('keywordScore') + ' ' + String(item.keywordScore ?? 0) +
                    ' · ' + t('vectorScore') + ' ' + String(item.vectorScore ?? 0),
                )
              : null,
          ),
          h(
            'p',
            { className: 'dshm-item-text', key: 'text' },
            expanded
              ? openState.status === 'ready' && openState.memory !== null
                ? String(openState.memory.text ?? '')
                : openState.status === 'error'
                  ? openState.message
                  : t('fullTextLoading')
              : clip(item.text, SEARCH_TEXT_LIMIT),
          ),
        ];
        // 展开、且全文取回来之后，才给这条记忆的两个动作：`改`（送审）/ `删`（软删）。
        // 不做成每行常驻按钮：一页 20 行、一行两个按钮就是 40 个控件（用户的口径是"不多余"）。
        if (expanded && openState.status === 'ready' && openState.memory !== null) {
          const fullText = String(openState.memory.text ?? '');
          children.push(
            h(
              'div',
              { className: 'dshm-actions', key: 'actions' },
              h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  disabled: editBusy,
                  onClick: (event) => {
                    stop(event);
                    startEdit(id, fullText);
                  },
                },
                t('searchEdit'),
              ),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  disabled: editBusy,
                  onClick: (event) => {
                    stop(event);
                    removeMemory(id);
                  },
                },
                t('delete'),
              ),
            ),
          );
        }
        return h(
          'div',
          {
            className: 'dshm-item is-clickable',
            key: id === '' ? String(item.score) + '-' + String(index) : id,
            onClick: () => toggle(id),
            title: t('expandHint'),
          },
          children,
        );
      };

      const rows = items.map((item, index) => renderRow(item, index, true));

      const vectorNote =
        data !== null && data.vectorUsed !== true && data.vectorError
          ? h('div', { className: 'dshm-faint' }, t('vectorUnavailable') + '：' + String(data.vectorError))
          : null;

      const statusLine =
        state.status === 'idle'
          ? h('div', { className: 'dshm-faint' }, t('searchIdle'))
          : state.status === 'loading'
            ? h('div', { className: 'dshm-muted' }, t('loading'))
            : state.status === 'error'
              ? h('div', { className: 'dshm-error' }, state.message)
              : h(
                  'div',
                  { className: 'dshm-faint' },
                  items.length + ' / ' + String(data?.count ?? 0) + ' · ' + t('tookMs') + ' ' + String(data?.tookMs ?? 0) + ' ms',
                );

      // ── 「最近入库」块（本页新增）─────────────────────────────────────────────
      // 口径：最近被**记进库**的 N 条（`created_at` 倒序）。没有检索分，所以行里不画
      // 分数那三样，改画**入库时刻**。点一行照样能展开全文、`改`（送审）/`删`（软删）——
      // 与搜索结果共用 renderRow，行为完全一致。
      const recentData = recent.status === 'ready' ? recent.data : null;
      const recentItems = recentData !== null && Array.isArray(recentData.items) ? recentData.items : [];

      const recentCard = h(
        Card,
        {
          title: t('recentTitle'),
          action: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              icon: icon('IconRefreshOutlineRegular', 14),
              disabled: recent.status === 'loading',
              onClick: reloadRecent,
            },
            t('recentRefresh'),
          ),
        },
        recent.status === 'loading'
          ? h('div', { className: 'dshm-muted' }, t('loading'))
          : recent.status === 'error'
            ? h('div', { className: 'dshm-error' }, recent.message)
            : recentItems.length === 0
              ? h(Empty, { text: t('recentEmpty') })
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dshm-faint', style: { marginBottom: 8 } },
                    // 「按入库时刻倒序」这句话必须留着：导入进来的旧记忆 created_at 是**导入那一刻**，
                    // 不说清就会被读成「最近发生的事」。
                    t('recentHint').replace('{count}', String(recentItems.length)),
                  ),
                  h('div', { className: 'dshm-list' }, recentItems.map((item, index) => renderRow(item, index, false))),
                ),
      );

      return h(
        React.Fragment,
        null,
        recentCard,
        h(
          Card,
          { title: t('tabSearch') },
          h(
            'div',
            { className: 'dshm-toolbar' },
            h(
              'div',
              { className: 'dshm-grow' },
              h(Input, {
                value: draft,
                placeholder: t('searchPlaceholder'),
                onChange: (event) => setDraft(event?.target?.value ?? ''),
                onKeyDown: (event) => {
                  if (event?.key === 'Enter') submit();
                },
              }),
            ),
            h(
              Button,
              {
                variant: 'primary',
                size: 'sm',
                icon: icon('IconSearchOutlineRegular', 14),
                disabled: state.status === 'loading' || draft.trim() === '',
                onClick: submit,
              },
              t('search'),
            ),
          ),
          h('div', { style: { marginTop: 10 } }, statusLine),
          vectorNote,
        ),
        items.length === 0
          ? state.status === 'ready'
            ? h(Empty, { text: t('noResults') })
            : null
          : h('div', { className: 'dshm-list' }, rows),
        notice === '' ? null : h('div', { className: 'dshm-muted' }, notice),
        actionError === '' ? null : h(ErrorBox, { text: actionError }),
        // 改写窗口：独立窗口（与设置页同一套 `Modal`），footer 只有 送审 / 取消。
        // **送审 ≠ 改库**：正文进待审区，过审后才「删旧录新」。
        editing === null
          ? null
          : h(
              Modal,
              {
                open: true,
                onClose: closeEdit,
                title: t('searchEditTitle'),
                closeLabel: t('close'),
                description: String(editing.id),
                footer: h(
                  'div',
                  { className: 'dshm-actions' },
                  h(Button, { variant: 'primary', size: 'sm', disabled: editBusy, onClick: saveEdit }, t('memEditSubmit')),
                  h(Button, { variant: 'ghost', size: 'sm', disabled: editBusy, onClick: closeEdit }, t('cancel')),
                ),
              },
              h(
                'div',
                { className: 'dshm-field-row', style: { alignItems: 'flex-start' } },
                h('span', { className: 'dshm-field-label' }, t('memEditLabel')),
                h(
                  'div',
                  { className: 'dshm-grow' },
                  h('textarea', {
                    className: 'dshm-textarea',
                    value: editDraft,
                    onChange: (event) => setEditDraft(String(event?.target?.value ?? '')),
                  }),
                ),
              ),
              h('div', { className: 'dshm-faint', style: { marginTop: 8 } }, t('memEditHint')),
              editError === '' ? null : h('div', { className: 'dshm-error', style: { marginTop: 8 } }, editError),
            ),
      );
    }

    // ── 10. 分页五：设置 ─────────────────────────────────────────────────────────

    /**
     * 空档案表单：字段与 `/profile` 的入参一一对应。
     * @returns {object} 表单值。
     */
    function emptyProfileForm() {
      return {
        name: '',
        provider: 'openai',
        baseUrl: '',
        model: '',
        dimensions: '',
        apiKeyRef: '',
        ollamaUrl: '',
        localDims: '',
      };
    }

    /**
     * 把一个档案摊成表单值（缺的留空，交给宿主的默认值兜底）。
     *
     * `config` 是 patch 配置的保留名、不能覆盖，所以选到它时名字留空，逼着人另起一个名字。
     *
     * @param {object|null} profile 档案（来自 `/profiles`）。
     * @returns {object} 表单值。
     */
    function profileForm(profile) {
      if (profile === null || typeof profile !== 'object') return emptyProfileForm();
      const embedding = profile.embedding ?? {};
      const name = String(profile.name ?? '');
      return {
        name: name === 'config' ? '' : name,
        provider: String(embedding.provider ?? 'openai'),
        baseUrl: embedding.baseUrl == null ? '' : String(embedding.baseUrl),
        model: embedding.model == null ? '' : String(embedding.model),
        dimensions: embedding.dimensions == null ? '' : String(embedding.dimensions),
        apiKeyRef: embedding.apiKeyRef == null ? '' : String(embedding.apiKeyRef),
        ollamaUrl: embedding.ollamaUrl == null ? '' : String(embedding.ollamaUrl),
        localDims: embedding.localDims == null ? '' : String(embedding.localDims),
      };
    }

    /**
     * 数字输入只收数字字符：状态里因此永远不会有 `NaN`，空串则交给宿主默认值兜底。
     * @param {unknown} raw 输入值。
     * @returns {string} 只含 0-9 的文本。
     */
    function digitsOnly(raw) {
      return String(raw ?? '').replace(/[^0-9]/g, '');
    }

    /**
     * 数字输入文本 → 正整数；空串或非法值给 `null`（**绝不产生 NaN**）。
     * @param {unknown} text 文本。
     * @returns {number|null} 正整数或 `null`。
     */
    function positiveIntOrNull(text) {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '') return null;
      const value = Number(trimmed);
      return Number.isInteger(value) && value > 0 ? value : null;
    }

    /**
     * 设置：嵌入模型（点圆点切生效、点名字改）+ 一段默认收起的「诊断」。
     *
     * 口径（用户 2026-10-07 当面定的三条 UI 要求）：直观、低认知负荷，**可见的每个按钮 /
     * 控件 / 文字都不得多余**。所以这次把原来的 6 张卡压到 2 张：
     *   * 编辑表单内联在所选档案行里 —— 与「仓管模型」块同一套动作语言（圆点切换 / 点名字改 /
     *     `＋ 新建` / `.dshm-fields` 竖排字段），两块看起来是同一件东西；
     *   * 密钥写入并进编辑表单：密钥永远属于某个档案，单独一张卡只是多一次视觉跳转；
     *   * 只读配置 / LLM 预检 / 数据目录收进 `<details>`：默认不占注意力，要用时一次展开；
     *   * 与档案行重复的信息（provider / model / 维度 / 密钥引用、当前空间）不再单独列一遍。
     *
     * **安全**：密钥值只从输入框单向送到宿主；面板只显示「已配置 / 未配置」与来源，
     * 从不把 value 渲染到 DOM（宿主 `/config` 也从不回传 value）。
     *
     * @param {{t: Function}} props 属性。
     * @returns {object} React 节点。
     */
    function SettingsTab(props) {
      const t = props.t;
      const call = useAction();
      const [state, setState] = React.useState({ status: 'loading' });
      const [profiles, setProfiles] = React.useState({ status: 'loading' });
      const [nonce, setNonce] = React.useState(0);
      const [value, setValue] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [pendingAction, setPendingAction] = React.useState('');
      /** 正在展开编辑的档案名；`null` = 全部收起，`''` = 新建表单。 */
      const [editing, setEditing] = React.useState(null);
      const [form, setForm] = React.useState(emptyProfileForm);
      const [testResult, setTestResult] = React.useState(null);
      /** 最近一次「测」测的是哪个档案（结果行要带名字，不然不知道测了谁）。 */
      const [testTarget, setTestTarget] = React.useState('');
      const [credentialNotice, setCredentialNotice] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [formError, setFormError] = React.useState('');
      const [actionError, setActionError] = React.useState('');

      // 只读配置：切档案 / 写密钥之后靠 nonce 重取（密钥状态就在这个信封里）。
      React.useEffect(() => {
        const controller = new AbortController();
        setState({ status: 'loading' });
        apiOk('/config', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            setState({ status: 'ready', data: body });
          },
          (error) => {
            if (controller.signal.aborted || isAbort(error)) return;
            setState({ status: 'error', message: errorText(error) });
          },
        );
        return () => controller.abort();
      }, [nonce]);

      // 档案列表：存 / 删 / 切之后重取。每行都带它自己的空间键与「已保留多少 / 还缺多少」。
      React.useEffect(() => {
        const controller = new AbortController();
        setProfiles({ status: 'loading' });
        apiJson('/profiles', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            if (body.ok !== true) {
              setProfiles({ status: 'error', message: String(body.error ?? 'profiles failed') });
              return;
            }
            setProfiles({
              status: 'ready',
              active: body.active == null || body.active === '' ? 'config' : String(body.active),
              profiles: Array.isArray(body.profiles) ? body.profiles : [],
            });
          },
          (error) => {
            if (controller.signal.aborted || isAbort(error)) return;
            setProfiles({ status: 'error', message: errorText(error) });
          },
        );
        return () => controller.abort();
      }, [nonce]);

      // 先派生只读视图，再定义写操作：写入密钥要用到「正在编辑的档案」的引用名。
      const data = state.status === 'ready' ? state.data : null;
      const config = data?.config ?? null;
      const configKeyRef = config?.embedding?.apiKeyRef ?? null;

      const list = profiles.status === 'ready' ? profiles.profiles : [];
      const activeName = profiles.status === 'ready' ? profiles.active : '';
      const editingProfile = list.find((item) => String(item?.name ?? '') === editing) ?? null;
      const editingKeyRef = editingProfile?.embedding?.apiKeyRef ?? null;
      /** 密钥写到**正在编辑的档案**的引用名上；它没写引用名才退回补丁配置的。 */
      const targetKeyRef = typeof editingKeyRef === 'string' && editingKeyRef !== '' ? editingKeyRef : configKeyRef;
      const pending = pendingAction !== '' || busy;

      const openForm = (item) => {
        setEditing(item === null ? '' : String(item.name));
        setForm(profileForm(item));
        setTestResult(null);
        setCredentialNotice('');
        setNotice('');
        setFormError('');
        setActionError('');
      };

      const closeForm = () => {
        setEditing(null);
        setTestResult(null);
        setCredentialNotice('');
        setFormError('');
      };

      /** 切生效档案：只改生效项，向量按空间保留，`autoFill` 顺手补缺的那些。 */
      const activateProfile = (name) => {
        setPendingAction('activate');
        setNotice('');
        setActionError('');
        call('/activate', { method: 'POST', body: { name, autoFill: true } }).then(
          (body) => {
            setPendingAction('');
            if (body.ok !== true) {
              setActionError(String(body.error ?? 'activate failed'));
              return;
            }
            const missing = Number(body.missing ?? 0);
            const filling = body.backfill !== null && body.backfill !== undefined && body.backfill.running === true;
            setNotice(
              Number.isFinite(missing) && missing > 0
                ? (filling ? t('profileSwitchedFilling') : t('profileSwitchedMissing')).replace('{missing}', String(missing))
                : t('profileSwitchedLatest'),
            );
            setNonce((current) => current + 1);
          },
          (error) => {
            if (isAbort(error)) return;
            setPendingAction('');
            setActionError(errorText(error));
          },
        );
      };

      const deleteProfile = (name) => {
        if (name === 'config') {
          setActionError(t('profileConfigUndeletable'));
          return;
        }
        // 二次确认：照需求用 window.confirm（拿不到 confirm 的环境不拦，直接照做）。
        const confirmed =
          typeof window === 'undefined' ||
          typeof window.confirm !== 'function' ||
          window.confirm(t('profileDeleteConfirm').replace('{name}', name)) === true;
        if (!confirmed) return;
        setPendingAction('delete');
        setNotice('');
        setActionError('');
        call('/profile-delete', { method: 'POST', body: { name } }).then(
          (body) => {
            setPendingAction('');
            if (body.ok !== true) {
              setActionError(String(body.error ?? 'delete failed'));
              return;
            }
            setNotice(body.wasActive === true ? t('profileDeletedActive') : t('profileDeleted'));
            closeForm();
            setNonce((current) => current + 1);
          },
          (error) => {
            if (isAbort(error)) return;
            setPendingAction('');
            setActionError(errorText(error));
          },
        );
      };

      const testProfile = (name) => {
        setPendingAction('test:' + name);
        setNotice('');
        setActionError('');
        setTestResult(null);
        setTestTarget(name);
        call('/embed-test', { method: 'POST', body: { name } }).then(
          (body) => {
            setPendingAction('');
            // 成败都留原文：ok=false 的 error 就是宿主的原话。
            setTestResult(body);
          },
          (error) => {
            if (isAbort(error)) return;
            setPendingAction('');
            setTestResult({ ok: false, error: errorText(error) });
          },
        );
      };

      /**
       * 密钥写入：值只单向送宿主，写完不回显、只刷新「已配置 / 未配置」。
       */
      const saveKey = () => {
        if (value === '') {
          setActionError(t('credentialEmpty'));
          return;
        }
        setBusy(true);
        setCredentialNotice('');
        setActionError('');
        call('/credential', { method: 'POST', body: { value, ref: targetKeyRef } }).then(
          (body) => {
            setBusy(false);
            if (body.ok === true) {
              setValue('');
              setCredentialNotice(t('saved'));
              setNonce((current) => current + 1);
            } else {
              // 原样显示宿主给的原因，绝不假装保存成功。
              setActionError(t('saveFailed') + '：' + String(body.error ?? ''));
            }
          },
          (error) => {
            if (isAbort(error)) return;
            setBusy(false);
            setActionError(t('saveFailed') + '：' + errorText(error));
          },
        );
      };

      const saveProfile = () => {
        const name = form.name.trim();
        if (name === '') {
          setFormError(t('profileNameRequired'));
          return;
        }
        const dimensions = positiveIntOrNull(form.dimensions);
        if (form.dimensions.trim() !== '' && dimensions === null) {
          setFormError(t('profileNumberBad').replace('{field}', t('dimensions')));
          return;
        }
        const localDims = positiveIntOrNull(form.localDims);
        if (form.localDims.trim() !== '' && localDims === null) {
          setFormError(t('profileNumberBad').replace('{field}', t('localDims')));
          return;
        }
        // 只送填了的字段：空字段交给宿主默认值兜底，避免把 '' 送进去撞校验。
        const payload = { name, provider: form.provider };
        if (form.baseUrl.trim() !== '') payload.baseUrl = form.baseUrl.trim();
        if (form.model.trim() !== '') payload.model = form.model.trim();
        if (form.apiKeyRef.trim() !== '') payload.apiKeyRef = form.apiKeyRef.trim();
        if (form.ollamaUrl.trim() !== '') payload.ollamaUrl = form.ollamaUrl.trim();
        if (dimensions !== null) payload.dimensions = dimensions;
        if (localDims !== null) payload.localDims = localDims;
        setPendingAction('save');
        setFormError('');
        setNotice('');
        setActionError('');
        call('/profile', { method: 'POST', body: payload }).then(
          (result) => {
            setPendingAction('');
            if (result.ok !== true) {
              // 服务端校验：坏值/保留名在这里原样显示，绝不吞掉。
              setFormError(t('saveFailed') + '：' + String(result.error ?? ''));
              return;
            }
            setEditing(String(result.name ?? name));
            setNotice(t('saved'));
            setNonce((current) => current + 1);
          },
          (error) => {
            if (isAbort(error)) return;
            setPendingAction('');
            setFormError(t('saveFailed') + '：' + errorText(error));
          },
        );
      };

      /**
       * 弹窗里的一条参数：**独占一行**（标签定宽、控件撑满）—— 参数之间互不拥挤。
       * 用户 2026-10-07：配置改用独立窗口展示，原来的「点名字在行下面展开」整块移除。
       */
      const fieldRow = (label, control) =>
        h('div', { className: 'dshm-field-row' },
          h('span', { className: 'dshm-field-label' }, label),
          h('div', { className: 'dshm-grow' }, control),
        );

      const textInput = (fieldName, placeholder) =>
        h(Input, {
          value: form[fieldName],
          placeholder,
          onChange: (event) =>
            setForm((current) => ({ ...current, [fieldName]: String(event?.target?.value ?? '') })),
        });

      const numberInput = (fieldName) =>
        h(Input, {
          value: form[fieldName],
          inputMode: 'numeric',
          onChange: (event) =>
            setForm((current) => ({ ...current, [fieldName]: digitsOnly(event?.target?.value) })),
        });

      const providerSelect = h(
        'select',
        {
          className: 'dshm-select',
          value: form.provider,
          onChange: (event) =>
            setForm((current) => ({ ...current, provider: String(event?.target?.value ?? 'openai') })),
        },
        ['openai', 'ollama', 'local-hash'].map((name) => h('option', { key: name, value: name }, name)),
      );

      /**
       * 档案配置弹窗（平台 `Modal`：遮罩 + 居中对话框 + Esc/焦点处理都由它管）。
       *
       * `editing === ''` = 新建（还没有名字），否则 `editingProfile` 就是正在编辑的那个档案。
       * 「测」放在窗口里 —— 新旧配置就在眼前，测出来的结果也显示在这儿；行上只留「删」。
       *
       * @returns {object|null} Modal 节点；没有编辑任何档案时是 `null`。
       */
      const editorModal = () => {
        if (editing === null) return null;
        const isNew = editing === '';
        const canWriteKey = !isNew && targetKeyRef !== null && targetKeyRef !== '';
        return h(
          Modal,
          {
            open: true,
            onClose: closeForm,
            title: t('profileConfigTitle'),
            closeLabel: t('close'),
            description: isNew ? '' : String(editingProfile?.name ?? ''),
            footer: h(
              'div',
              { className: 'dshm-actions' },
              h(
                Button,
                { variant: 'primary', size: 'sm', disabled: pending, onClick: saveProfile },
                pendingAction === 'save' ? t('loading') : t('save'),
              ),
              h(Button, { variant: 'ghost', size: 'sm', disabled: pending, onClick: closeForm }, t('cancel')),
            ),
          },
          fieldRow(t('fieldName'), textInput('name', 'my-embedding')),
          fieldRow(t('fieldProvider'), providerSelect),
          form.provider === 'ollama'
            ? fieldRow(t('ollamaUrl'), textInput('ollamaUrl', 'http://127.0.0.1:11434'))
            : form.provider === 'openai'
              ? fieldRow(t('baseUrl'), textInput('baseUrl', 'https://…/v1'))
              : null,
          fieldRow(t('model'), textInput('model', 'text-embedding-v4')),
          form.provider === 'local-hash'
            ? fieldRow(t('localDims'), numberInput('localDims'))
            : fieldRow(t('dimensions'), numberInput('dimensions')),
          form.provider === 'local-hash' ? null : fieldRow(t('apiKeyRef'), textInput('apiKeyRef', 'DASHSCOPE_API_KEY')),
          formError === '' ? null : h('div', { className: 'dshm-error', style: { marginTop: 10 } }, formError),
          canWriteKey
            ? h(
                'div',
                { className: 'dshm-toolbar', style: { marginTop: 10 } },
                h('span', { className: 'dshm-field-label' }, t('keyWrite') + ' · ' + String(targetKeyRef)),
                h(
                  'div',
                  { className: 'dshm-grow' },
                  h(Input, {
                    type: 'password',
                    value,
                    placeholder: t('credentialPlaceholder'),
                    autoComplete: 'off',
                    onChange: (event) => setValue(String(event?.target?.value ?? '')),
                  }),
                ),
                h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: saveKey }, t('credentialSave')),
              )
            : null,
          credentialNotice === '' ? null : h('div', { className: 'dshm-muted', style: { marginTop: 6 } }, credentialNotice),
        );
      };

      /**
       * 补丁配置（`source === 'config'`）**不是"能配的档案"**：宿主不许改也不许删。
       * 它只在**它生效时**占一行（兜底时它就是你正在用的那套）；平时不出现。
       * 用户 2026-10-07 指着它说「改成线上」—— 那件事已经把它落成真档案了
       * （名 `线上`、参数逐字相同、空间键不变、向量不重算），所以平时列表里只有真档案。
       */
      const isPatchRow = (item) => item?.source === 'config';

      /**
       * 一行档案：圆点切生效、点名字改、右边 `测` / `删`（补丁配置不给「删」，因为宿主硬拒）。
       * @param {object} item 档案。
       * @returns {object} React 节点。
       */
      const profileRow = (item) => {
        const name = String(item?.name ?? '');
        const itemEmbedding = item?.embedding ?? {};
        const vectors = Number(item?.vectors ?? 0);
        const missing = Number(item?.missing ?? 0);
        const isActive = name === activeName;
        const patch = isPatchRow(item);
        return h(
          'div',
          { className: 'dshm-item', key: name },
          h(
            'div',
            { className: 'dshm-item-head' },
            h('span', {
              className: 'dshm-dot' + (isActive ? ' is-active' : ''),
              title: t('dotSwitch'),
              onClick: () => {
                if (!isActive) activateProfile(name);
              },
            }),
            // 补丁配置显示成「补丁配置」而不是它那个技术名 `config`（悬停能看到原名）；
            // 它点不动（改 / 删都由宿主拒），所以不给手型也不给 onClick。
            h(
              'span',
              {
                className: 'dshm-mono',
                title: patch ? name : t('profileEditHint'),
                style: patch ? undefined : { cursor: 'pointer' },
                onClick: patch ? undefined : () => openForm(item),
              },
              patch ? t('patchProfile') : name === '' ? t('none') : name,
            ),
            // 只画模型名（用户当面指过：「只保留模型名」）——
            // provider 收进 `title`：同名的两个模型（线上 / 局域网）鼠标一悬停还能分清，
            // 但平时不占一行字。
            h(
              'span',
              { className: 'dshm-faint', title: String(itemEmbedding.provider ?? '') },
              orNone(itemEmbedding.model, t),
            ),
            h(
              'span',
              { className: missing > 0 ? 'dshm-warn' : 'dshm-faint' },
              missing > 0
                ? t('profileMissing').replace('{missing}', String(missing))
                : t('profileVectors').replace('{vectors}', String(vectors)),
            ),
            h(
              'div',
              { className: 'dshm-row-actions' },
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  disabled: pending,
                  onClick: () => testProfile(name),
                },
                pendingAction === 'test:' + name ? t('profileTesting') : t('profileTest'),
              ),
              patch
                ? null
                : h(
                    Button,
                    { variant: 'ghost', size: 'sm', disabled: pending, onClick: () => deleteProfile(name) },
                    t('delete'),
                  ),
            ),
          ),
        );
      };

      const rows = list
        .filter((item) => !isPatchRow(item) || String(item?.name ?? '') === activeName)
        .map(profileRow);

      return h(
        React.Fragment,
        null,
        state.status === 'error'
          ? h(ErrorBox, {
              text: state.message,
              onRetry: () => setNonce((current) => current + 1),
              retryLabel: t('retry'),
            })
          : null,
        h(
          Card,
          {
            title: t('profilesTitle'),
            action: h(
              Button,
              { variant: 'ghost', size: 'sm', disabled: editing !== null, onClick: () => openForm(null) },
              t('profileNew'),
            ),
          },
          profiles.status === 'loading' ? h('div', { className: 'dshm-muted', style: { marginTop: 10 } }, t('loading')) : null,
          profiles.status === 'error' ? h('div', { className: 'dshm-error', style: { marginTop: 10 } }, profiles.message) : null,
          profiles.status === 'ready' && list.length === 0 ? h(Empty, { text: t('empty') }) : null,
          h('div', { className: 'dshm-list', style: { marginTop: 10 } }, rows),
          // 「测」的结果：带档案名显示在卡片上（按钮在行上，结果就贴着卡片显示 ——
          // 窗口是编辑配置用的，不在窗口里再放一遍动作）。
          testResult === null
            ? null
            : testResult.ok === true
              ? h(
                  'div',
                  { className: 'dshm-muted', style: { marginTop: 10 } },
                  String(testTarget) + ' · ' + t('profileTestOk')
                    .replace('{provider}', String(testResult.provider ?? ''))
                    .replace('{model}', String(testResult.model ?? ''))
                    .replace('{dims}', String(testResult.vectorLength ?? 0))
                    .replace('{ms}', String(testResult.elapsedMs ?? 0)),
                )
              : h(
                  'div',
                  { className: 'dshm-error', style: { marginTop: 10 } },
                  String(testTarget) + ' · ' + t('profileTestFailed') + '：' + String(testResult.error ?? ''),
                ),
          notice === '' ? null : h('div', { className: 'dshm-muted', style: { marginTop: 10 } }, notice),
          // 这里原来有一个默认收起的「诊断」（LLM 探活 / 密钥状态 / 数据目录）。
          // 用户 2026-10-07 看过之后拍板**整块移除** —— 面板这一页只留"配模型"这件事。
          // 那几样照样拿得到：宿主 LLM 能不能用 → 工具 `memory_stats {probe:true}`
          // （或直接 POST `/llm-test`）；密钥状态与来源 → `GET /config` 的 `keyStatus`；
          // 数据目录 → 配置项 `dataDir`（README 也写着默认值）。
        ),
        editorModal(),
        actionError === '' ? null : h(ErrorBox, { text: actionError }),
      );
    }

    // ── 6b. 设置页里的「仓管模型」 ──────────────────────────────────────────────
    //
    // 只有两块：档案列表（点一行展开编辑）+ 一个新建。切换 = 点最左边那个圆点。
    // 这里刻意不做「采样数 / 每组邻居」这类运行参数 —— 那是给一轮用的，改成工具侧默认。

    /**
     * 仓管模型：列档案、切生效、点一行改字段、测连通。
     * @param {{t: Function}} props 属性。
     * @returns {object} React 节点。
     */
    function KeeperModelBlock(props) {
      const t = props.t;
      const call = useAction();
      const [state, setState] = React.useState({ status: 'loading' });
      const [form, setForm] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [result, setResult] = React.useState('');
      const [error, setError] = React.useState('');
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        const controller = new AbortController();
        apiJson('/keeper-profiles', { signal: controller.signal }).then(
          (body) => {
            if (controller.signal.aborted) return;
            if (body.ok !== true) { setState({ status: 'error', message: String(body.error ?? '') }); return; }
            setState({ status: 'ready', items: Array.isArray(body.profiles) ? body.profiles : [], active: String(body.active ?? '') });
          },
          (error2) => {
            if (!controller.signal.aborted && !isAbort(error2)) setState({ status: 'error', message: errorText(error2) });
          },
        );
        return () => controller.abort();
      }, [nonce]);

      const list = state.status === 'ready' ? state.items : [];
      const activeName = state.status === 'ready' ? state.active : '';

      const openForm = (item) => {
        setResult('');
        setError('');
        if (item === null) {
          setForm({ name: '', provider: 'openai', baseUrl: '', model: '', apiKeyRef: '', ollamaUrl: '', timeoutMs: '' });
          return;
        }
        const fields = item?.fields ?? item ?? {};
        setForm({
          name: String(item?.name ?? ''),
          provider: String(fields.provider ?? item?.provider ?? 'openai'),
          baseUrl: String(fields.baseUrl ?? item?.endpoint ?? ''),
          model: String(fields.model ?? item?.model ?? ''),
          apiKeyRef: String(fields.apiKeyRef ?? item?.apiKeyRef ?? ''),
          ollamaUrl: String(fields.ollamaUrl ?? ''),
          timeoutMs: fields.timeoutMs === null || fields.timeoutMs === undefined ? '' : String(fields.timeoutMs),
          builtin: item?.builtin === true,
        });
      };

      const act = (key, path, body, okText) => {
        setBusy(key);
        setResult('');
        setError('');
        call(path, { method: 'POST', body }).then(
          (response) => {
            setBusy('');
            if (response.ok !== true) { setError(String(response.error ?? '')); return; }
            if (okText !== '') setResult(okText);
            if (path === '/keeper-test') {
              setResult(response.ok === true ? t('keeperPingOk').replace('{text}', clip(JSON.stringify(response), 120)) : '');
              return;
            }
            setForm(null);
            setNonce((value) => value + 1);
          },
          (error2) => {
            if (isAbort(error2)) return;
            setBusy('');
            setError(errorText(error2));
          },
        );
      };

      /**
       * 保存这个档案。**模型 id 不能空**：未配置的档案在列表里整条不画（用户连着两次把那一块
       * 往下压），存下去等于凭空消失 —— 那比报个错更让人摸不着头脑，所以在客户端先挡住。
       */
      const saveForm = () => {
        if (String(form.model ?? '').trim() === '') {
          setError(t('keeperModelRequired'));
          return;
        }
        act('save', '/keeper-profile', {
          name: form.name,
          provider: form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          apiKeyRef: form.apiKeyRef,
          ollamaUrl: form.ollamaUrl,
          timeoutMs: form.timeoutMs === '' ? null : Number(form.timeoutMs) || null,
        }, t('saved'));
      };

      /** 弹窗里的一行参数：标签定宽、控件撑满（与「向量模型」那个弹窗同一套）。 */
      const field = (label, key, options) =>
        h('div', { className: 'dshm-field-row' },
          h('span', { className: 'dshm-field-label' }, label),
          h('div', { className: 'dshm-grow' },
            options === undefined
              ? h(Input, { value: form[key], placeholder: label, onChange: (event) => setForm((current) => ({ ...current, [key]: String(event?.target?.value ?? '') })) })
              : h('select', {
                  className: 'dshm-select',
                  value: form[key],
                  onChange: (event) => setForm((current) => ({ ...current, [key]: String(event?.target?.value ?? '') })),
                }, options.map((name) => h('option', { key: name, value: name }, name))),
          ),
        );

      /**
       * 仓管档案配置弹窗（与「向量模型」那张卡完全同一套：独立窗口、每条参数独占一行）。
       * footer 只有 保存 / 取消 —— 「测」在行上（用户 2026-10-07 的批注把 测 / 删 放在行上），
       * 同一个动作不画两遍。校验失败的那条 `error` 显示在窗口里（不然它被遮罩挡在后面看不见）；
       * `result` 属于行上的动作，窗口关着时显示在卡片上。
       *
       * @returns {object|null} Modal 节点；没在编辑时是 `null`。
       */
      const formModal = () => {
        if (form === null) return null;
        return h(
          Modal,
          {
            open: true,
            onClose: () => setForm(null),
            title: t('profileConfigTitle'),
            closeLabel: t('close'),
            description: String(form.name ?? ''),
            footer: h(
              'div',
              { className: 'dshm-actions' },
              h(Button, { variant: 'primary', size: 'sm', disabled: busy !== '', onClick: saveForm }, t('save')),
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '', onClick: () => setForm(null) }, t('cancel')),
            ),
          },
          field(t('fieldName'), 'name'),
          field(t('fieldProvider'), 'provider', ['openai', 'ollama']),
          field(t('fieldEndpoint'), 'baseUrl'),
          field(t('fieldModel'), 'model'),
          field(t('fieldApiKey'), 'apiKeyRef'),
          field(t('fieldTimeout'), 'timeoutMs'),
          result === '' ? null : h('div', { className: 'dshm-muted', style: { marginTop: 10 } }, result),
          error === '' ? null : h('div', { className: 'dshm-error', style: { marginTop: 10 } }, error),
        );
      };

      /** 一行仓管档案：圆点切生效、点名字改（补丁配置点不动）、`测` / `删`。 */
      const keeperRow = (item) => {
        const name = String(item?.name ?? '');
        const itemFields = item?.fields ?? {};
        const configured = item?.configured === true;
        const builtin = item?.builtin === true;
        const isActive = name === activeName;
        return h('div', { className: 'dshm-item' + (configured ? '' : ' dshm-dim'), key: name },
          h('div', { className: 'dshm-item-head' },
            h('span', {
              className: 'dshm-dot' + (isActive ? ' is-active' : ''),
              title: t('dotSwitch'),
              onClick: () => { if (!isActive) act('activate:' + name, '/keeper-activate', { name }, ''); },
            }),
            // 与「向量模型」同一套：补丁配置显示成「补丁配置」，点不动。
            h('span', {
              className: 'dshm-mono',
              title: builtin ? name : t('profileEditHint'),
              style: builtin ? undefined : { cursor: 'pointer' },
              onClick: builtin ? undefined : () => openForm(item),
            }, builtin ? t('patchProfile') : name === '' ? t('none') : name),
            // 与「向量模型」同一套：只画模型名，provider 收进 title。
            h('span', { className: 'dshm-faint', title: String(itemFields.provider ?? item?.provider ?? '') },
              orNone(itemFields.model ?? item?.model, t)),
            configured ? null : h(Tag, { tone: 'warning' }, t('keeperProfileNotConfigured')),
            h('div', { className: 'dshm-row-actions' },
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '', onClick: () => act('test:' + name, '/keeper-test', { name }, '') }, t('profileTest')),
              // 补丁配置（内置档案）删不掉也改不了 —— 那就不画这个按钮（画出来也点不动，是纯多余）。
              builtin
                ? null
                : h(Button, { variant: 'ghost', size: 'sm', disabled: busy !== '', onClick: () => act('del:' + name, '/keeper-profile-delete', { name }, t('keeperDeleted')) }, t('delete')),
            ),
          ),
        );
      };

      /**
       * 只画**能用的**档案（已配置的 + 正在生效的那条）。
       *
       * 用户 2026-10-07 连着两次把这一块往下压：先说「没配置就不要一直挂着」（于是收进一行折叠），
       * 再指着那行折叠说「移除」—— 所以现在**没配置的档案整条不画**（连折叠行都没有）。
       * **代价（如实写在这）**：面板里再也看不到、改不了、删不掉那些档案；要清理得让 agent 动库，
       * 或者先把它配置起来（见下面 saveForm 的"必须填模型"校验：面板不会再新建出未配置的档案）。
       */
      const isUsableRow = (item) => item?.configured === true || String(item?.name ?? '') === activeName;
      const shownRows = list.filter(isUsableRow);

      return h(React.Fragment, null,
        h(Card, { title: t('keeperModelTitle'),
          action: h(Button, { variant: 'ghost', size: 'sm', disabled: form !== null, onClick: () => openForm(null) }, t('profileNew')) },
          state.status === 'loading' ? h('div', { className: 'dshm-muted' }, t('loading')) : null,
          state.status === 'error' ? h('div', { className: 'dshm-error' }, state.message) : null,
          h('div', { className: 'dshm-list', style: { marginTop: 10 } }, shownRows.map(keeperRow)),
          // 状态行各自只出现一次：窗口开着时它在窗口里（见 formModal），关着才显示在卡片上。
          form === null && result !== '' ? h('div', { className: 'dshm-muted', style: { marginTop: 10 } }, result) : null,
          form === null && error !== '' ? h('div', { className: 'dshm-error', style: { marginTop: 10 } }, error) : null,
        ),
        formModal(),
      );
    }

    // ── 11. 主区页面与左栏图标 ───────────────────────────────────────────────────


    /**
     * 四个页签：**仓管（默认）/ 副仓管 / 搜索 / 设置**。
     *
     * 用户 2026-10-07：「为仓管单开一个页面 展示它正在处理的记忆是哪些 并且仓管整理完成的记忆也在
     * 该页面审阅」→ 仓管那条线独立成页；之后又「副审阅区使用独立的仓管角色 独立建立页面『副仓管』」
     * + 「移除目前空置的『待办』页面」—— 于是副仓管也成页，而原来那页「待办」（抽取待审区）整页删掉。
     * 2026-10-08 曾加过第五页「注入」（读取侧观测面），当天下午用户「现已不再需要」→ **整页移除**：
     * 页签、组件、中英字典键、HTTP 路由，以及只为它存在的引擎侧台账，一并清掉（不留死代码）。
     */
    function tabItems(t) {
      return [
        { id: 'dshm-tab-keeper', value: 'keeper', label: t('tabKeeper') },
        { id: 'dshm-tab-side', value: 'side', label: t('tabSide') },
        { id: 'dshm-tab-search', value: 'search', label: t('tabSearch') },
        { id: 'dshm-tab-settings', value: 'settings', label: t('tabSettings') },
      ];
    }

    /**
     * 主区页面：默认落在「仓管」（「待办」页已按用户要求移除；副仓管是它自己的页）。
     * @param {{t: Function}} props 属性。
     * @returns {object} React 节点。
     */
    function MemoryPage(props) {
      const t = props.t;
      const [tab, setTab] = React.useState('keeper');
      return h(
        'div',
        { className: 'dshm-root' },
        h(
          'div',
          { className: 'dshm-col' },
          h('div', { className: 'dshm-head' }, h('h2', { className: 'dshm-title' }, t('title'))),
          h(SegmentedTabs, {
            items: tabItems(t),
            value: tab,
            onChange: setTab,
            label: t('tabsLabel'),
          }),
          h(
            'div',
            {
              className: 'dshm-panel',
              id: 'dshm-panel-' + tab,
              role: 'tabpanel',
              'aria-labelledby': 'dshm-tab-' + tab,
            },
            tab === 'keeper' ? h(KeeperTab, { t }) : null,
            tab === 'side' ? h(SideTab, { t }) : null,
            tab === 'search' ? h(SearchTab, { t }) : null,
            tab === 'settings' ? h(SettingsTab, { t }) : null,
            tab === 'settings' ? h(KeeperModelBlock, { t }) : null,
          ),
        ),
      );
    }

    /** 左栏图标。owner 只传 `{ size, active }`，图标自己不能导航。 */
    function MemoryIcon(props) {
      return icon('IconDatabaseOutlineRegular', props.size ?? 16);
    }

    // ── 12. 插件体 ───────────────────────────────────────────────────────────────

    /** 本插件需要的浏览器端 cordis 服务（**服务名**，不是包名）。 */
    const inject = ['slots', 'locale'];

    /**
     * 插件体。
     * @param {object} ctx 浏览器端 cordis 根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries');
      const t = ctx.locale.bind(NS);

      // 左栏一行。`sidebar.panellist` 是 dsh-client-ui-sidebar 声明的 list/root 槽，
      // 必须走 ctx.slots.inject —— 该槽由别的包声明，插件激活顺序无保证。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => t('panel'),
            locale: NS,
          },
          MemoryIcon,
        ),
      );

      // 主区页面。`main` 是 dsh-client-ui-layout 声明的 keyed/root 槽，key 由侧栏点击后
      // 经 ctx.layout.selectPanel(PANEL_ID) 选中。
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MemoryPage),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
