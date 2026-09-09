export interface HealthRefreshClock {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}
const systemClock: HealthRefreshClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Rate-limit starts while retaining one trailing invalidation, even during a request. */
export function createHealthRefresh(
  load: (signal: AbortSignal) => Promise<void>,
  {
    signal,
    intervalMs = 2000,
    clock = systemClock,
  }: {
    signal?: AbortSignal;
    intervalMs?: number;
    clock?: HealthRefreshClock;
  } = {},
) {
  const controller = new AbortController();
  let stopped = false;
  let running = false;
  let pending = false;
  let lastStart = -Infinity;
  let timer: unknown;
  function schedule() {
    if (stopped || running || !pending || timer !== undefined) return;
    const delay = Math.max(0, lastStart + intervalMs - clock.now());
    if (delay > 0) {
      timer = clock.setTimeout(() => {
        timer = undefined;
        schedule();
      }, delay);
      return;
    }
    pending = false;
    running = true;
    lastStart = clock.now();
    void (async () => {
      try {
        await load(controller.signal);
      } catch {
        /* The loader owns error reporting; failures must not stall future invalidations. */
      } finally {
        running = false;
        schedule();
      }
    })();
  }
  function stop() {
    stopped = true;
    pending = false;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    controller.abort();
    signal?.removeEventListener("abort", stop);
  }
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  return {
    request() {
      if (!stopped) {
        pending = true;
        schedule();
      }
    },
    stop,
  };
}
