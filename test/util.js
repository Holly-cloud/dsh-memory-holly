/**
 * 测试公共工具。
 *
 * 所有测试用的数据库文件都写在 `test/.tmp/<label>/` 下：
 * 测试开始前清掉自己的子目录，测试结束后删掉子目录，并尝试删掉共享的 `.tmp` 根
 * （只有最后一个收尾的测试进程能删成功，因此用带重试的非递归 `rmdir`）。
 *
 * 本文件在模块顶层**没有副作用**——即使被 `node --test` 当作测试文件加载也只是 0 个用例。
 *
 * @module dsh-memory/test/util
 */

import { mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 测试临时目录根（`dsh-memory/test/.tmp`）。 */
export const TMP_ROOT = join(HERE, '.tmp');

/**
 * 同步睡眠（不依赖定时器 Promise，避免测试钩子里出现异步竞态）。
 *
 * @param {number} ms 毫秒
 * @returns {void}
 */
function sleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 尽力删除一个目录（Windows 上若还有句柄没关会抛 EPERM —— 那是**清理不掉的残留**，
 * 不是测试失败：下次 `freshTmpDir` 还会再试一次）。重试几次后放弃，绝不抛。
 *
 * @param {string} dir 目录
 * @returns {void}
 */
function removeBestEffort(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      sleep(60);
    }
  }
}

/**
 * 准备一个干净的临时子目录（先删后建）。
 *
 * @param {string} label 子目录名（每个测试文件一个，避免并行冲突）
 * @returns {string} 绝对路径
 */
export function freshTmpDir(label) {
  const dir = join(TMP_ROOT, label);
  removeBestEffort(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 清掉临时目录：先删自己的子目录，再尽力删掉共享根。
 *
 * ⚠️ 整条路径都是**尽力而为、绝不抛**：这是测试收尾的清理，不是被测行为。
 * 之前 `rmSync` 裸调用会因残留句柄抛 EPERM，把整个测试文件记成"失败"、还抑制后续用例执行
 * （226 例只跑出 217 例），看起来像产品缺陷 —— 其实只是清理没成功。
 *
 * @param {string} dir `freshTmpDir` 返回的目录
 * @returns {void}
 */
export function cleanupTmpDir(dir) {
  removeBestEffort(dir);
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      rmdirSync(TMP_ROOT); // 非递归：还有别的测试进程在用就失败，重试即可
      return;
    } catch (err) {
      if (err.code === 'ENOENT') return;
      sleep(50);
    }
  }
}

/**
 * 造一个每次调用前进 1 秒的固定时钟，让时间戳可预测。
 *
 * @param {string} [startIso] 起始时间
 * @returns {() => Date} 时钟
 */
export function makeClock(startIso = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return () => {
    const current = new Date(t);
    t += 1000;
    return current;
  };
}

/**
 * 造一个记录调用的假 fetch。
 *
 * @param {(url: string, init: RequestInit, callIndex: number) => unknown} handler 响应工厂
 * @returns {Function & { calls: { url: string, init: RequestInit }[] }} 假 fetch
 */
export function makeFakeFetch(handler) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fake.calls = calls;
  return fake;
}

/**
 * 造一个 JSON 响应桩。
 *
 * @param {unknown} body 响应体
 * @param {{ ok?: boolean, status?: number }} [options] 状态
 * @returns {{ ok: boolean, status: number, json: () => Promise<unknown>, text: () => Promise<string> }} 响应
 */
export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}
