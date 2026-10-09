/**
 * dsh-memory · 请求超时信号（仓管 LLM 与嵌入通道共用）。
 *
 * ## 为什么不用 `AbortSignal.timeout(ms)`
 * 它是「一次性、不可撤回」的：内部定时器**没有 unref**（部分 Node 版本上），
 * 请求早就结束了、进程却还被那根定时器钉住 ~ms（默认 120s / 60s），
 * 期间它攥着 sqlite 文件句柄 —— 下一个进程 `freshTmpDir()` 里的 `rmSync` 就抛 EPERM，
 * 现象是「整份测试文件假失败、还抑制后续用例」，看着像产品坏了，其实只是定时器没放。
 *
 * ## 约定
 * - 定时器 `unref?.()`：**不阻塞进程退出**；
 * - 请求结束（成功 / 失败 / 抛错）必须由调用方 `clear()`：**不留悬挂定时器**；
 * - 超时的 abort reason 是 `name === 'TimeoutError'` 的 `DOMException`
 *   —— 与 `AbortSignal.timeout` 的错误语义一致，调用方按 `err.name` 判定不用改。
 *
 * @module dsh-memory/host/timeout
 */

/**
 * 造一个可 `unref`、可清理的超时信号。
 *
 * @param {number} timeoutMs 超时毫秒；非正数 = 不设超时（信号永远不 abort）
 * @returns {{signal: AbortSignal, clear: () => void}} 信号与清理器（`clear()` 可重复调用）
 */
export function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const ms = Number(timeoutMs);
  if (!(ms > 0)) return { signal: controller.signal, clear: () => {} };

  const timer = setTimeout(() => {
    // 与 `AbortSignal.timeout()` 同一个 reason：name 是 'TimeoutError'（legacy code 23）。
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, ms);
  // Node 的 `Timeout` 有 unref；浏览器返回数字编号，用可选调用兜住。
  if (typeof timer?.unref === 'function') timer.unref();

  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
