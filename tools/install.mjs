/**
 * dsh-memory · 跨平台安装器（Windows / Linux / macOS 都能跑）。
 *
 * 只做一件事：在 DSH **某个 profile** 的 patch 文件里写（或刷新）一个 `insert` 块，
 * 让 patch 加载器以绝对路径加载本插件。**不需要 pnpm、不需要网络、不需要 dsh.bundle**。
 *
 * 与 `install.ps1` 的关系：两者写出的块**完全一致**，打的是同一个 marker，
 * 因此互相认得、可以互相覆盖/卸载。PS 脚本留着是因为最早只有它；新设备一律用本脚本
 * （Node 是 DSH 的硬依赖，任何装了 DSH 的机器上都有）。
 *
 * 用法：
 *   node tools/install.mjs                     # 自动找 profile，装/刷新
 *   node tools/install.mjs --dry-run --print   # 只打印将写入的内容
 *   node tools/install.mjs --uninstall         # 只删那个块
 *   node tools/install.mjs --diagnostics       # 额外打开诊断路由（⚠️ 无鉴权）
 *   node tools/install.mjs --profile web --data-dir /srv/dsh-memory
 *
 * 退出码：0 成功；1 运行失败（文件缺失/写失败）；2 用法错误。
 *
 * @module dsh-memory/tools/install
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyInstall, applyUninstall, hasManagedBlock, readManagedBlock, toSpecPath } from './install-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const PLUGIN_ENTRY = join(REPO_ROOT, 'lib', 'index.js');

/** 自动选 profile 时的偏好顺序：桌面版用 desktop，web 版常见 default/web。 */
const PROFILE_PREFERENCE = ['desktop', 'default', 'web', 'server'];

/**
 * 极简参数解析：只认 `--key value` / `--key=value` / 布尔开关。
 *
 * @param {string[]} argv `process.argv.slice(2)`
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

/**
 * 找到要改写的 patch 文件。
 *
 * @param {{ patch?: string, profile?: string, dshHome: string }} options 入参
 * @returns {{ patchFile: string, profile: string | null, error: string | null }} 结果
 */
function resolvePatchFile({ patch, profile, dshHome }) {
  if (typeof patch === 'string' && patch.length > 0) {
    return { patchFile: resolve(patch), profile: profile ?? null, error: null };
  }
  const profilesDir = join(dshHome, 'profiles');
  if (!existsSync(profilesDir)) {
    return {
      patchFile: '',
      profile: null,
      error: `找不到 DSH 的 profiles 目录：${profilesDir}\n先启动一次 DSH（它会初始化 profile），再回来跑本脚本。`,
    };
  }
  const names = readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const withPatch = names.filter((name) => existsSync(join(profilesDir, name, 'cordis.patch.yml')));
  if (withPatch.length === 0) {
    return {
      patchFile: '',
      profile: null,
      error: `${profilesDir} 下没有任何带 cordis.patch.yml 的 profile。\n先启动一次 DSH，让它初始化 profile。`,
    };
  }

  /** @type {string | null} */
  let picked = null;
  if (typeof profile === 'string' && profile.length > 0) {
    if (!withPatch.includes(profile)) {
      return {
        patchFile: '',
        profile,
        error: `profile「${profile}」没有 patch 文件。现有 profile：${withPatch.join(', ')}`,
      };
    }
    picked = profile;
  } else {
    picked = PROFILE_PREFERENCE.find((name) => withPatch.includes(name)) ?? (withPatch.length === 1 ? withPatch[0] : null);
    if (picked === null) {
      return {
        patchFile: '',
        profile: null,
        error: `有多个 profile，无法自动选择：${withPatch.join(', ')}\n用 --profile <名字> 指定。`,
      };
    }
  }

  return { patchFile: join(profilesDir, picked, 'cordis.patch.yml'), profile: picked, error: null };
}

/**
 * 原子写（临时文件 + rename）：半截的 patch 会让 DSH 直接起不来。
 *
 * @param {string} file 目标
 * @param {string} text 全文
 * @returns {void}
 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  renameSync(tmp, file);
}

/** 帮助文本。 */
function usage() {
  return [
    'dsh-memory installer',
    '',
    'Usage:',
    '  node tools/install.mjs [options]',
    '',
    'Options:',
    '  --profile <name>   DSH profile（默认自动：desktop → default → web → 唯一那个）',
    '  --data-dir <path>  插件数据目录（默认 <DSH_HOME>/dsh-memory；已装过则沿用旧块里的值）',
    '  --plugin <dir>     插件目录（默认本脚本的上一级）',
    '  --patch <file>     直接指定 cordis.patch.yml（绕过 profile 自动发现）',
    '  --diagnostics      打开无鉴权诊断路由（排障用，排完用 --uninstall 再装回来关掉）',
    '  --uninstall        只删本插件的块，不动插件文件与数据',
    '  --dry-run          只算不写',
    '  --print            把改写后的全文打到 stdout（隐含 --dry-run，除非显式不给）',
    '  --json             结果以 JSON 输出（给 agent 解析）',
    '  --help             这一段',
  ].join('\n');
}

/**
 * 主流程。
 *
 * @returns {number} 退出码
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  const pluginDir = typeof args.plugin === 'string' ? resolve(args.plugin) : REPO_ROOT;
  const entry = join(pluginDir, 'lib', 'index.js');
  const uninstall = args.uninstall === true;
  const dryRun = args['dry-run'] === true || args.print === true;
  const json = args.json === true;
  const fail = (message, code = 1) => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`✗ ${message}`);
    return code;
  };

  if (!existsSync(entry)) return fail(`插件入口不存在：${entry}\n（若你把脚本单独拷走了，用 --plugin <插件目录> 指定）`, 2);

  const located = resolvePatchFile({
    patch: typeof args.patch === 'string' ? args.patch : undefined,
    profile: typeof args.profile === 'string' ? args.profile : undefined,
    dshHome,
  });
  if (located.error !== null) return fail(located.error, 2);
  const { patchFile, profile } = located;
  if (!existsSync(patchFile)) return fail(`patch 文件不存在：${patchFile}`, 2);

  const before = readFileSync(patchFile, 'utf8');
  const existing = readManagedBlock(before);

  if (uninstall) {
    if (!hasManagedBlock(before)) {
      const message = `未安装（patch 里没有 dsh-memory 块）：${patchFile}`;
      if (json) console.log(JSON.stringify({ ok: true, changed: false, patchFile, profile, message }));
      else console.log(`· ${message}`);
      return 0;
    }
    const after = applyUninstall(before);
    if (!dryRun) {
      const backup = backupOf(patchFile);
      writeAtomic(patchFile, after);
      report({ json, patchFile, profile, before, after, backup, uninstall: true, dryRun });
    } else {
      report({ json, patchFile, profile, before, after, backup: null, uninstall: true, dryRun, print: args.print === true });
    }
    return 0;
  }

  // dataDir：显式给了就用；否则沿用旧块里的；再否则默认 $DSH_HOME/dsh-memory
  const dataDirDefault = join(dshHome, 'dsh-memory');
  const dataDirRaw = typeof args['data-dir'] === 'string'
    ? resolve(args['data-dir'])
    : existing.dataDir !== null
      ? existing.dataDir
      : dataDirDefault;

  const after = applyInstall(before, {
    entrySpec: toSpecPath(entry),
    dataDirSpec: toSpecPath(dataDirRaw),
    diagnostics: args.diagnostics === true,
  });

  if (!dryRun) {
    const backup = backupOf(patchFile);
    writeAtomic(patchFile, after);
    report({ json, patchFile, profile, before, after, backup, entry, dataDir: dataDirRaw, dryRun });
  } else {
    report({ json, patchFile, profile, before, after, backup: null, entry, dataDir: dataDirRaw, dryRun, print: args.print === true });
  }
  return 0;
}

/**
 * 写前备份（带时间戳，永不覆盖旧备份）。
 *
 * @param {string} file patch 文件
 * @returns {string} 备份路径
 */
function backupOf(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const backup = `${file}.bak-${stamp}`;
  copyFileSync(file, backup);
  return backup;
}

/**
 * 输出结果（人读 or JSON）。
 *
 * @param {{ json: boolean, patchFile: string, profile: string | null, before: string, after: string,
 *   backup: string | null, entry?: string, dataDir?: string, uninstall?: boolean, dryRun: boolean,
 *   print?: boolean }} result 结果
 * @returns {void}
 */
function report(result) {
  const changed = result.before !== result.after;
  if (result.json) {
    console.log(JSON.stringify({
      ok: true,
      changed,
      dryRun: result.dryRun,
      patchFile: result.patchFile,
      profile: result.profile,
      backup: result.backup,
      entry: result.entry ?? null,
      dataDir: result.dataDir ?? null,
      uninstall: result.uninstall === true,
      bytesBefore: Buffer.byteLength(result.before),
      bytesAfter: Buffer.byteLength(result.after),
    }, null, 2));
    return;
  }

  if (result.print === true) {
    process.stdout.write(result.after);
    return;
  }

  if (!changed) {
    console.log('· 无需改动：patch 里已经是这一块了');
  } else if (result.dryRun) {
    console.log(`· [dry-run] 将改写 ${result.patchFile}`);
    console.log('· 去掉 --dry-run 才会真的写');
  } else if (result.uninstall === true) {
    console.log(`✓ 已卸载：删掉了 patch 里的 dsh-memory 块`);
    console.log(`  patch  : ${result.patchFile}`);
    console.log(`  backup : ${result.backup}`);
    console.log('  插件文件与记忆数据都没动。重启 DSH（完全退出再开）后生效。');
    return;
  } else {
    console.log('✓ 已写入 patch');
    console.log(`  patch   : ${result.patchFile}`);
    console.log(`  profile : ${result.profile}`);
    console.log(`  entry   : ${result.entry}`);
    console.log(`  dataDir : ${result.dataDir}`);
    console.log(`  backup  : ${result.backup}`);
  }

  console.log('');
  console.log('下一步：');
  console.log('  1) 完全退出并重启 DSH（只刷新页面不够；部分版本 patch 会热生效，但重启最稳）');
  console.log('  2) 左栏应出现「记忆」图标；agent 侧 plugin_manager(list_plugins) 里 id=memory 应为 active');
  console.log('  3) 个人数据：见 2-personal-data/README.md（一条命令还原）');
  console.log('  4) 嵌入密钥要单独在面板「设置」里填（不会随数据包带过来）');
}

process.exitCode = main();
