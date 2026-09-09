import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHealthRefresh,
  type HealthRefreshClock,
} from "./health-refresh.ts";
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: HealthRefreshClock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      timers.set(++id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
  };
  return {
    clock,
    advance(milliseconds: number) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("health refresh coalesces 100 invalidations and preserves the final trailing update", async () => {
  const time = fakeClock();
  const starts: number[] = [];
  const refresh = createHealthRefresh(
    async () => {
      starts.push(time.clock.now());
    },
    { clock: time.clock },
  );
  refresh.request();
  await flush();
  for (let i = 0; i < 100; i++) {
    time.advance(10);
    refresh.request();
  }
  assert.deepEqual(starts, [0]);
  assert.equal(time.pendingTimers, 1);
  time.advance(999);
  await flush();
  assert.deepEqual(starts, [0]);
  time.advance(1);
  await flush();
  assert.deepEqual(starts, [0, 2000]);
  time.advance(9000);
  await flush();
  assert.deepEqual(starts, [0, 2000]);
  refresh.stop();
});

test("health refresh never overlaps requests and runs one trailing refresh after a long request", async () => {
  const time = fakeClock();
  const starts: number[] = [];
  const finishes: (() => void)[] = [];
  const refresh = createHealthRefresh(
    () => {
      starts.push(time.clock.now());
      return new Promise<void>((resolve) => finishes.push(resolve));
    },
    { clock: time.clock },
  );
  refresh.request();
  time.advance(5000);
  for (let i = 0; i < 100; i++) refresh.request();
  assert.deepEqual(starts, [0]);
  assert.equal(time.pendingTimers, 0);
  finishes.shift()!();
  await flush();
  assert.deepEqual(starts, [0, 5000]);
  refresh.request();
  finishes.shift()!();
  await flush();
  time.advance(1999);
  await flush();
  assert.deepEqual(starts, [0, 5000]);
  time.advance(1);
  await flush();
  assert.deepEqual(starts, [0, 5000, 7000]);
  finishes.shift()!();
  await flush();
  refresh.stop();
});

test("stopping health refresh cancels its pending timer and aborts in-flight work without a trailing request", async () => {
  const time = fakeClock();
  const lifetime = new AbortController();
  let activeSignal: AbortSignal | undefined;
  let finish = () => {};
  let starts = 0;
  const refresh = createHealthRefresh(
    (signal) => {
      starts++;
      activeSignal = signal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    { clock: time.clock, signal: lifetime.signal },
  );
  refresh.request();
  refresh.request();
  lifetime.abort();
  assert.equal(activeSignal?.aborted, true);
  finish();
  await flush();
  time.advance(20000);
  refresh.request();
  assert.equal(starts, 1);
  const scheduled = createHealthRefresh(
    async () => {
      starts++;
    },
    { clock: time.clock },
  );
  scheduled.request();
  await flush();
  scheduled.request();
  assert.equal(time.pendingTimers, 1);
  scheduled.stop();
  assert.equal(time.pendingTimers, 0);
  time.advance(20000);
  scheduled.request();
  assert.equal(starts, 2);
});

test("a rejected health refresh does not stall a pending invalidation", async () => {
  const time = fakeClock();
  let starts = 0;
  const refresh = createHealthRefresh(
    async () => {
      starts++;
      throw new Error("offline");
    },
    { clock: time.clock },
  );
  refresh.request();
  refresh.request();
  await flush();
  time.advance(2000);
  await flush();
  assert.equal(starts, 2);
  refresh.stop();
});
