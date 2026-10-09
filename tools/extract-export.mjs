/**
 * 从原系统 `/api/export` 的 markdown 导出里提取记忆。
 *
 * 格式（实测）：
 *   # 记忆库导出（1083 块 · 41 个来源）
 *   ## 📄 <来源相对路径>　（N 块）
 *   ### <分节：A > B > C>
 *   <分节重复行?>            ← 正文里带着分节标题，需要识别并剥离
 *   - <正文>
 *
 * 用法：
 *   node tools/extract-export.mjs <导出.md> [输出.jsonl]
 * 只打印统计，不打印正文。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const input = process.argv[2];
const output = process.argv[3];
if (!input) {
  console.error('用法: node tools/extract-export.mjs <导出.md> [输出.jsonl]');
  process.exit(2);
}

const raw = readFileSync(input, 'utf8');
const lines = raw.split(/\r?\n/);

// ── 1. 逐行分类 ────────────────────────────────────────────────────────────────
const H1 = /^# (.*)$/;
const H2 = /^## 📄\s*(.+?)\s*　?（(\d+)\s*块）\s*$/;
const H3 = /^### (.*)$/;
const BULLET = /^-\s?(.*)$/;

const sources = [];
let current = null; // { source, declared, chunks: [] }
let chunk = null; // { section, rawLines: [] }

function flushChunk() {
  if (chunk === null || current === null) return;
  const body = chunk.rawLines.slice();
  // 剥掉：正文开头与 section 完全相同的那一行（导出把 `【来源】分节\n\n正文` 的正文一并打印了）
  while (body.length > 0 && body[0].trim() === chunk.section.trim()) body.shift();
  while (body.length > 0 && body[0].trim() === '') body.shift();
  const text = body
    .map((line) => {
      const m = BULLET.exec(line);
      return m ? m[1] : line;
    })
    .join('\n')
    .trim();
  current.chunks.push({ section: chunk.section, text });
  chunk = null;
}

for (const line of lines) {
  const m2 = H2.exec(line);
  if (m2 !== null) {
    flushChunk();
    current = { source: m2[1].trim(), declared: Number(m2[2]), chunks: [] };
    sources.push(current);
    continue;
  }
  if (/^# /.test(line) || /^---\s*$/.test(line)) {
    flushChunk();
    continue;
  }
  const m3 = H3.exec(line);
  if (m3 !== null) {
    flushChunk();
    if (current !== null) chunk = { section: m3[1].trim(), rawLines: [] };
    continue;
  }
  if (chunk !== null) chunk.rawLines.push(line);
}
flushChunk();

// ── 2. 统计 ────────────────────────────────────────────────────────────────────
const all = sources.flatMap((s) => s.chunks.map((c) => ({ source: s.source, ...c })));
const total = all.length;
const declaredTotal = sources.reduce((n, s) => n + s.declared, 0);

const withLeadingDup = (() => {
  let n = 0;
  for (const s of sources) {
    for (const c of s.chunks) {
      // 重新看原文里是否出现「紧接着 ### 之后就是同一行」
      n += 0;
    }
  }
  return n;
})();

const lens = all.map((r) => [...r.text].length).sort((a, b) => a - b);
const pct = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? 0;
const empties = all.filter((r) => r.text.length === 0).length;
const multiPara = all.filter((r) => r.text.includes('\n\n')).length;
const withNewline = all.filter((r) => r.text.includes('\n')).length;

const byHash = new Map();
for (const r of all) {
  const h = createHash('sha256').update(r.text).digest('hex');
  byHash.set(h, (byHash.get(h) ?? 0) + 1);
}
const dupGroups = [...byHash.values()].filter((n) => n > 1).length;
const dupExtra = [...byHash.values()].filter((n) => n > 1).reduce((n, v) => n + v - 1, 0);

const perSourceMismatch = sources
  .map((s) => ({ source: s.source, declared: s.declared, parsed: s.chunks.length }))
  .filter((s) => s.declared !== s.parsed);

const nonEmptySections = all.filter((r) => r.section.length > 0).length;
const hasCjk = all.filter((r) => /[\u4e00-\u9fff]/.test(r.text)).length;

// 掩码后的形状：确认「### 之后紧跟重复行」是否普遍
const shape = [];
{
  let seen = 0;
  let inChunk = false;
  let section = null;
  let firstNonBlank = null;
  for (const line of lines) {
    const m3 = H3.exec(line);
    if (m3 !== null) {
      section = m3[1].trim();
      firstNonBlank = null;
      inChunk = true;
      continue;
    }
    if (H2.test(line)) { inChunk = false; continue; }
    if (inChunk && firstNonBlank === null && line.trim() !== '') {
      firstNonBlank = line.trim() === section ? 'SAME-AS-SECTION' : 'DIFFERENT';
      shape.push(firstNonBlank);
      seen += 1;
      inChunk = false;
    }
  }
}
const sameCount = shape.filter((s) => s === 'SAME-AS-SECTION').length;

console.log('=== 对账 ===');
console.log(`来源数：解析 ${sources.length}；声明合计 ${declaredTotal} 块`);
console.log(`记忆块：解析 ${total}（H3 数应为同值）`);
console.log(`空正文：${empties}；含换行：${withNewline}；多段：${multiPara}`);
console.log(`分节非空：${nonEmptySections}/${total}；含中文：${hasCjk}`);
console.log(`正文长度：min=${lens[0]} p50=${pct(0.5)} p90=${pct(0.9)} max=${lens[lens.length - 1]}`);
console.log(`完全重复的正文：${dupGroups} 组，多出 ${dupExtra} 条`);
console.log(`### 之后第一行是否与分节相同：SAME=${sameCount} / DIFFERENT=${shape.length - sameCount}`);
console.log(
  `每来源块数不符的：${perSourceMismatch.length}` +
    (perSourceMismatch.length > 0
      ? ' → ' + JSON.stringify(perSourceMismatch.slice(0, 5))
      : '（全部吻合）'),
);
console.log('--- 来源清单（路径 + 块数，已截断） ---');
for (const s of sources) {
  console.log(`  ${String(s.chunks.length).padStart(4)}  ${s.source.slice(0, 70)}`);
}

// ── 3. 输出 JSONL ──────────────────────────────────────────────────────────────
/**
 * 还原原系统 `palace_lib.classify` 的分类规则，让迁移后的 kind 与旧库语义一致。
 *
 * @param {string} source 来源名（宫殿相对路径，或 `手动写入` / `抽取审阅`）
 * @returns {string} palace | hotzone | archive | index | manual | extracted
 */
function classifyKind(source) {
  if (source === '手动写入') return 'manual';
  if (source === '抽取审阅') return 'extracted';
  if (source.startsWith('归档/')) return 'archive';
  if (source.startsWith('热区基线/')) return 'hotzone';
  if (/索引\.md$/.test(source) || source === 'README.md') return 'index';
  return 'palace';
}

if (output) {
  const out = resolve(output);
  mkdirSync(dirname(out), { recursive: true });
  const rows = all
    .filter((r) => r.text.length > 0)
    .map((r, i) => ({
      id: `legacy-${String(i + 1).padStart(5, '0')}`,
      text: r.text,
      source: r.source,
      section: r.section,
      kind: classifyKind(r.source),
      meta: { importedFrom: '记忆库导出-最新.md' },
    }));
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const kinds = {};
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
  console.log(`\n已写出 ${rows.length} 条 → ${out}`);
  console.log('kind 分布：' + JSON.stringify(kinds));
}
