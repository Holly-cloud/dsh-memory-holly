/**
 * dsh-memory · 安装器的纯函数部分（不改文件，只做「patch 文本 → patch 文本」）。
 *
 * 为什么要有这一层：`install.ps1` 与 `install.mjs` 必须**写出同一块内容、认得出彼此写过的块**。
 * 逻辑只在这里实现一遍，Windows 脚本与跨平台脚本都调它 —— 否则两套实现迟早分叉，
 * 轻则重复插两行同 id 的 row（DSH 直接起不来），重则吞掉别人的 patch 段。
 *
 * ## 块长什么样
 *
 * ```yaml
 * # dsh-memory -- managed block (written by tools/install.mjs; do not edit by hand).
 * # ...说明注释...
 * - insert:
 *     - id: memory
 *       name: '<入口绝对路径，正斜杠>'
 *       config:
 *         dataDir: '<数据目录，正斜杠>'
 * ```
 *
 * ## 删除规则（与 install.ps1 逐条一致）
 *
 * 块式删除，不是逐行删除：先吃掉 marker，再吃掉块自己的注释/空行，然后吃掉 `- insert:`，
 * 最后吃掉**所有缩进行**与空行，遇到第一行「零缩进且非空」就停 —— 那是下一条 patch entry
 * （以及它自己的注释），绝不能吞。
 *
 * 认 marker 时**故意宽松**（`/^#\s*dsh-memory\b/`）：最早那版是按中文注释手写进去的，
 * 若只认当前精确 marker，旧块会活下来，再插一次就是两行同 id。
 *
 * @module dsh-memory/tools/install-lib
 */

/** 本安装器写入的块首行。 */
export const MARKER = '# dsh-memory -- managed block';

/** 认「这是 dsh-memory 的块」的宽松模式（与 install.ps1 的 `(?m)^#\s*dsh-memory\b` 等价）。 */
const MARKER_PATTERN = /^#\s*dsh-memory\b/;

/** 在整文件上判断有没有被安装过（`.test()` 逐行，等价于 PS 的 `(?m)`）。 */
export function hasManagedBlock(text) {
  return splitLines(text).some((line) => MARKER_PATTERN.test(line));
}

/**
 * 去掉本安装器负责的那一块（可能不存在）。
 *
 * @param {string} text patch 文件全文
 * @returns {string} 去掉块之后的全文（**总是**以单个换行结尾；原文件的 CRLF 会被归一成 LF，
 *   与写 patch 的其他工具一致 —— 本项目的 patch 文件在 git 里也是 LF）
 */
export function removeManagedBlock(text) {
  /** @type {string[]} */
  const out = [];
  let removing = false; // 见过 marker，正在删
  let inInsert = false; // 已进入 `- insert:` 块
  for (const line of splitLines(text)) {
    if (!removing) {
      if (MARKER_PATTERN.test(line)) {
        removing = true;
        continue;
      }
      out.push(line);
      continue;
    }
    if (!inInsert) {
      // marker 之后的注释与空行属于这个块
      if (/^\s*#/.test(line) || line.trim() === '') continue;
      if (/^- insert:\s*$/.test(line)) {
        inInsert = true;
        continue;
      }
      // marker 没能引出 insert 块（文件被手工改坏了）：保留这一行，停止删除
      removing = false;
      out.push(line);
      continue;
    }
    // insert 块内：缩进行（4 空格以上）与空行都算块内
    if (/^\s{4,}\S/.test(line) || line.trim() === '') continue;
    removing = false;
    inInsert = false;
    out.push(line);
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * 渲染要追加的 patch 块（不含前导空行）。
 *
 * @param {{ entrySpec: string, dataDirSpec: string, diagnostics?: boolean }} options 入参
 *   - `entrySpec` / `dataDirSpec`：**正斜杠**绝对路径（patch 加载器把 insert 行里的绝对路径转 file URL）
 * @returns {string} 多行 YAML 片段（以换行结尾）
 */
export function renderManagedBlock({ entrySpec, dataDirSpec, diagnostics = false }) {
  const lines = [
    `${MARKER} (written by tools/install.mjs; do not edit by hand).`,
    '# The row names this plugin by absolute path: the patch loader converts',
    '# absolute paths inside `insert` rows into file URLs, so no pnpm install,',
    '# no network, and no dsh.bundle / dsh.profile.bundles involvement is needed.',
    '# To uninstall: delete this block, or run tools/install.mjs --uninstall.',
    '- insert:',
    '    - id: memory',
    `      name: '${entrySpec}'`,
    '      config:',
    `        dataDir: '${dataDirSpec}'`,
  ];
  if (diagnostics) {
    lines.push(
      '        # WARNING: unauthenticated loopback diagnostic routes.',
      '        # They can read arbitrary files, write credentials, mutate data',
      '        # and dump memory text. Remove this line and restart when done.',
      '        diagnostics: true',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 安装（或刷新）本插件那一块。**幂等**：先删旧块再追加新块，重复跑不会出现两行。
 *
 * @param {string} text patch 文件全文
 * @param {{ entrySpec: string, dataDirSpec: string, diagnostics?: boolean }} options 入参
 * @returns {string} 新全文
 */
export function applyInstall(text, options) {
  const base = removeManagedBlock(text);
  const block = renderManagedBlock(options);
  if (base.trim() === '') return block;
  return `${base.trimEnd()}\n\n${block}`;
}

/**
 * 卸载：只删块，不动文件里别的内容。
 *
 * @param {string} text patch 文件全文
 * @returns {string} 新全文
 */
export function applyUninstall(text) {
  return removeManagedBlock(text);
}

/**
 * 从现有块里读回配置（重装时用来保留用户自己的 dataDir / 诊断开关）。
 *
 * @param {string} text patch 文件全文
 * @returns {{ found: boolean, entrySpec: string | null, dataDir: string | null, diagnostics: boolean }} 结果
 */
export function readManagedBlock(text) {
  const lines = splitLines(text);
  /** @type {{ found: boolean, entrySpec: string | null, dataDir: string | null, diagnostics: boolean }} */
  const result = { found: false, entrySpec: null, dataDir: null, diagnostics: false };
  for (let i = 0; i < lines.length; i += 1) {
    if (!MARKER_PATTERN.test(lines[i])) continue;
    result.found = true;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      // 块内的合法行：注释 / 空行 / 缩进行（4 空格以上）/ `- insert:`、`- id:` 这类块内条目行
      const inBlock = /^\s*#/.test(line) || line.trim() === '' || /^\s{4,}\S/.test(line) || /^\s*-\s/.test(line);
      if (!inBlock) break;
      const name = line.match(/^\s+name:\s*'([^']*)'/);
      if (name) result.entrySpec = name[1];
      const dataDir = line.match(/^\s+dataDir:\s*'([^']*)'/);
      if (dataDir) result.dataDir = dataDir[1];
      if (/^\s+diagnostics:\s*true\s*$/.test(line)) result.diagnostics = true;
    }
    break;
  }
  return result;
}

/**
 * 按 `\r?\n` 切行（**不**保留行尾 `\r`：写回时统一 LF）。
 *
 * @param {string} text 全文
 * @returns {string[]} 行
 */
export function splitLines(text) {
  return String(text ?? '').split(/\r?\n/);
}

/**
 * 把 Windows 风格路径转成 patch 行里要求的正斜杠路径。
 *
 * @param {string} value 路径
 * @returns {string} 正斜杠路径
 */
export function toSpecPath(value) {
  return String(value).replace(/\\/g, '/');
}
