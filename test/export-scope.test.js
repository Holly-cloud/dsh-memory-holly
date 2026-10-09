/**
 * 导出作用域归一：`resolveExportScope` 的规则 + `MemoryService.exportMemory` 的接线。
 *
 * 这条线以前写的是 `scope ?? cfg.scope`，会把**显式 null** 一起吃掉 —— 于是「全库导出」
 * 永远到不了 `exportPack`，而文档里却写着「要全导就传 scope: null」。现在改成
 * 「省略 = 默认作用域 / 显式 null 或 allScopes: true = 全部 scope」，并用本文件钉住。
 *
 * 用一个假 ctx 直接构造 `MemoryService`：不装插件、不起路由、不联网。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveExportScope } from '../src/host/portability.js';
import { MemoryService } from '../lib/index.js';
import { cleanupTmpDir, freshTmpDir } from './util.js';

const TMP = freshTmpDir('export-scope');

/** 每个服务一个注销器：用完必须关库，否则 Windows 上删临时目录会 EPERM。 */
const closers = [];

after(() => {
  for (const close of closers.splice(0)) close();
  cleanupTmpDir(TMP);
});

/**
 * 最小可用 ctx：`effect` 立即执行回调并**留下注销器**（关库靠它），
 * 路由注册返回空注销器，其余服务一律「未挂载」。
 *
 * @returns {object} 假 ctx（带 `dispose()`）
 */
function makeFakeCtx() {
  const disposers = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    connection: { fetch: { register: () => () => {} } },
    get: () => undefined,
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  ctx.dispose = () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  return ctx;
}

let seq = 0;

/**
 * 造一个带两条分属两个 scope 的记忆的服务（每个服务一个独立 dataDir）。
 *
 * @param {object} [config] 追加的插件配置
 * @returns {MemoryService} 服务
 */
function makeService(config = {}) {
  const ctx = makeFakeCtx();
  closers.push(() => ctx.dispose());
  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`), ...config });
  const store = service.ensureStore();
  store.addMemory({ text: '默认作用域的一条', scope: 'default' });
  store.addMemory({ text: '工作作用域的一条', scope: 'work' });
  return service;
}

/**
 * 造一个「有 tools 服务」的服务，并抓住注册进去的 `memory_export` 工具定义。
 *
 * @returns {{ service: MemoryService, exportTool: object }} 服务与工具定义
 */
function makeToolService() {
  const captured = [];
  const ctx = makeFakeCtx();
  const tools = {
    register: (definition) => {
      captured.push(definition);
      return () => {};
    },
    get: () => undefined,
    schemas: () => captured,
  };
  ctx.get = (name) => (name === 'tools' ? tools : undefined);
  closers.push(() => ctx.dispose());

  const service = new MemoryService(ctx, { dataDir: join(TMP, `data-${(seq += 1)}`) });
  const store = service.ensureStore();
  store.addMemory({ text: '默认作用域的一条', scope: 'default' });
  store.addMemory({ text: '工作作用域的一条', scope: 'work' });

  const exportTool = captured.find((definition) => definition.name === 'memory_export');
  assert.ok(exportTool, '工具目录里应该有 memory_export');
  return { service, exportTool };
}

/**
 * 读回包里的 manifest。
 *
 * @param {string} dir 包目录
 * @returns {object} manifest
 */
function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

test('resolveExportScope：省略=默认、显式 null=全部、allScopes 优先、坏值抛错', () => {
  assert.equal(resolveExportScope({}, 'default'), 'default');
  assert.equal(resolveExportScope({ scope: undefined }, 'work'), 'work');
  assert.equal(resolveExportScope({ scope: null }, 'work'), null);
  assert.equal(resolveExportScope({ scope: 'work' }, 'default'), 'work');
  assert.equal(resolveExportScope({ scope: 'work', allScopes: true }, 'default'), null);
  assert.equal(resolveExportScope({ allScopes: false }, 'default'), 'default');
  assert.throws(() => resolveExportScope({ scope: '' }, 'default'), /scope 只能是/);
  assert.throws(() => resolveExportScope({ scope: 42 }, 'default'), /scope 只能是/);
});

test('exportMemory：省略 scope 只导默认作用域（不是全导）', () => {
  const result = makeService().exportMemory({ dir: join(TMP, 'out-default') });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(manifestOf(result.dir).scope, 'default');
});

test('exportMemory：scope:null 与 allScopes:true 都导全部 scope', () => {
  const byNull = makeService().exportMemory({ dir: join(TMP, 'out-null'), scope: null });
  assert.equal(byNull.count, 2);
  assert.equal(manifestOf(byNull.dir).scope, null);

  const byFlag = makeService().exportMemory({ dir: join(TMP, 'out-all'), allScopes: true });
  assert.equal(byFlag.count, 2);
  assert.equal(manifestOf(byFlag.dir).scope, null);
});

test('exportMemory：默认作用域跟着 config.scope 走（写入 scope 与导出 scope 一致）', () => {
  const result = makeService({ scope: 'work' }).exportMemory({ dir: join(TMP, 'out-config-scope') });
  assert.equal(result.count, 1);
  assert.equal(manifestOf(result.dir).scope, 'work');
});

test('exportMemory：显式指定 scope 时只导那一个', () => {
  const result = makeService().exportMemory({ dir: join(TMP, 'out-work'), scope: 'work' });
  assert.equal(result.count, 1);
  const rows = readFileSync(join(result.dir, 'memories.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).metadata.scope, 'work');
});

test('memory_export 工具：省略 scope=默认、被投影成 null 也只导默认、allScopes 才全导', async () => {
  const { exportTool } = makeToolService();

  const omitted = await exportTool.execute({ dir: join(TMP, 'tool-default') });
  assert.equal(omitted.count, 1);
  assert.equal(manifestOf(omitted.dir).scope, 'default');

  // 工具 schema 里 scope 是 string；万一调用方把它投影成 null，也不能被当成「全导」。
  const injectedNull = await exportTool.execute({ dir: join(TMP, 'tool-injected-null'), scope: null });
  assert.equal(injectedNull.count, 1);
  assert.equal(manifestOf(injectedNull.dir).scope, 'default');

  const all = await exportTool.execute({ dir: join(TMP, 'tool-all'), allScopes: true });
  assert.equal(all.count, 2);
  assert.equal(manifestOf(all.dir).scope, null);

  const one = await exportTool.execute({ dir: join(TMP, 'tool-work'), scope: 'work' });
  assert.equal(one.count, 1);
  assert.equal(manifestOf(one.dir).scope, 'work');
});
