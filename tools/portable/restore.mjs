#!/usr/bin/env node
/**
 * dsh-memory · 个人数据包「一键还原」CLI。
 *
 * 这就是 INSTALL.md 里那一条命令：
 *
 * ```bash
 * node 2-personal-data/tools/restore.mjs
 * ```
 *
 * 默认 `--mode auto`：全新机器落快照（记忆/向量/待审/变更单/设置一字不差）；
 * 已有数据的机器只做合并（按正文判重，绝不覆盖）。两条路都在写完时自证数字。
 *
 * 用法：
 *   node tools/restore.mjs                      # 自动选模式
 *   node tools/restore.mjs --dry-run            # 只报告，不写库
 *   node tools/restore.mjs --mode verify        # 只校验包 + 看目标现状
 *   node tools/restore.mjs --mode snapshot --force
 *   node tools/restore.mjs --data-dir /srv/dsh-memory
 *   node tools/restore.mjs --json
 *
 * @module dsh-memory/tools/portable/restore
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectDataDir, loadCounts, restorePersonalData, RestoreError, verifyPackage, inspectTarget } from './restore-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');

/**
 * 极简参数解析：`--key value` / `--key=value` / 布尔开关。
 *
 * @param {string[]} argv 参数
 * @returns {Record<string, string | true>} 参数表
 */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** 帮助文本。 */
function usage() {
  return [
    'dsh-memory 个人数据还原',
    '',
    '用法：node tools/restore.mjs [选项]',
    '',
    '选项：',
    '  --mode <auto|snapshot|merge|verify>  还原模式（默认 auto：全新→快照；已有数据→合并）',
    '  --data-dir <path>   目标数据目录（默认读已安装 patch 里的 dataDir，否则 <DSH_HOME>/dsh-memory）',
    '  --plugin <dir>      插件源码目录（merge 模式需要；默认包内 1-plugin/dsh-memory）',
    '  --dry-run           只报告将做什么，不写任何文件',
    '  --force             允许用快照覆盖非空目标库（会先备份旧库）',
    '  --no-verify         跳过包内文件的 sha256 校验（不建议）',
    '  --json              结果以 JSON 输出',
    '  --help              这一段',
  ].join('\n');
}

/**
 * 主流程。
 *
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const json = args.json === true;
  const mode = typeof args.mode === 'string' ? args.mode : 'auto';
  const dryRun = args['dry-run'] === true;
  const verify = args['no-verify'] !== true;
  const force = args.force === true;
  const dataDir = typeof args['data-dir'] === 'string' ? args['data-dir'] : null;
  const pluginDir = typeof args.plugin === 'string' ? args.plugin : null;

  /** @type {string[]} */
  const lines = [];
  const log = (line) => {
    lines.push(line);
    if (!json) console.log(line);
  };

  try {
    if (mode === 'verify') {
      const counts = loadCounts(PACKAGE_DIR);
      const integrity = verify ? verifyPackage(PACKAGE_DIR, counts) : { ok: true, checked: 0, errors: [] };
      const target = inspectTarget(dataDir ?? detectDataDir().dataDir);
      if (!json) {
        console.log(`包：${PACKAGE_DIR}`);
        console.log(`  导出于 ${counts.exportedAt ?? '(未知)'}，标签 ${counts.label ?? '(无)'}`);
        console.log(`  期望：记忆 ${counts.expected?.snapshot?.memoriesActive ?? '?'} 条（含已删共 ${counts.expected?.snapshot?.memoriesTotal ?? '?'}）· 向量 ${counts.expected?.snapshot?.vectors ?? '?'} · 待审批次 ${counts.expected?.snapshot?.batchesOpen ?? '?'} · 待审条目 ${counts.expected?.snapshot?.batchItemsPending ?? '?'} · 变更单 ${counts.expected?.snapshot?.plansActionable ?? '?'} · 副审阅区 ${counts.expected?.snapshot?.handoffsOpen ?? '?'}`);
        console.log(`  完整性：${integrity.ok ? `OK（${integrity.checked} 个文件）` : `失败\n- ${integrity.errors.join('\n- ')}`}`);
        console.log(`  目标库：${target.dbPath}`);
        console.log(`    ${target.dbExists ? `记忆 ${target.memories} 条 · 向量 ${target.vectors} · 待审批次 ${target.batchesOpen} · 变更单 ${target.plansActionable} · 副审阅区 ${target.handoffsOpen}${target.walPresent ? ' · ⚠ 正被打开' : ''}` : '不存在（全新部署）'}`);
      } else {
        console.log(JSON.stringify({ ok: integrity.ok, package: PACKAGE_DIR, integrity, expected: counts.expected ?? null, target }, null, 2));
      }
      return integrity.ok ? 0 : 1;
    }

    const result = await restorePersonalData({
      packageDir: PACKAGE_DIR,
      dataDir,
      mode,
      dryRun,
      force,
      verify,
      pluginDir,
      log,
    });

    if (json) {
      console.log(JSON.stringify({ ...result, lines }, null, 2));
      return 0;
    }

    console.log('');
    if (result.actions.length > 0) {
      console.log('本次动作：');
      for (const action of result.actions) console.log(`  · ${action}`);
      console.log('');
    }
    console.log('下一步：');
    if (result.mode === 'snapshot') {
      console.log('  1) 装插件（如果还没装）：node 1-plugin/dsh-memory/tools/install.mjs');
      console.log('  2) 完全退出并重启 DSH —— 重启后面板里应能看到全部记忆');
    } else {
      console.log('  1) 重启 DSH，面板「概览」核对条数');
      console.log('  2) 概览页点「补齐」把向量按当前模型算出来（合并导入不搬向量）');
    }
    console.log('  3) 嵌入密钥要单独在面板「设置」里填（包里永远不带密钥）');
    console.log('  4) 详细验收清单：2-personal-data/README.md「验收」一节');
    return 0;
  } catch (error) {
    const code = error instanceof RestoreError ? error.code : 'UNEXPECTED';
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, code, error: message, lines }, null, 2));
    } else {
      console.error(`✗ 还原失败（${code}）`);
      console.error(message);
    }
    return 1;
  }
}

process.exitCode = await main();
