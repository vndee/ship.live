import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { mock, type TestContext } from "node:test";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";
import { HealthStore } from "./health-store.js";
import { startHealthWorker } from "./health-worker.js";
import { validateProbe } from "./health-probe.js";

async function fixture(t: TestContext) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const events = await PostgresEventStore.open(database);
  const workspace = randomUUID();
  await events.pool.query(
    "INSERT INTO ship_live_workspaces(id,name,kind) VALUES($1,'Worker test','team')",
    [workspace],
  );
  return {
    events,
    workspace,
    health: new HealthStore(events.pool, "11".repeat(32)),
  };
}
async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(
      Date.now() < deadline,
      "Worker did not reach expected state within five seconds",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("worker initial tick claims a real scheduled probe and records its successful response", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  let stop: (() => Promise<void>) | undefined;
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const transport = mock.method(
    http,
    "request",
    (_url: URL, _options: unknown, callback: (response: unknown) => void) => {
      const request = new EventEmitter() as any;
      request.destroy = () => request;
      request.end = () => {
        const response = new PassThrough() as any;
        response.statusCode = 200;
        callback(response);
        response.end('{"ready":true}');
      };
      return request;
    },
  );
  try {
    const service = await f.health.createService(f.workspace, "Worker API");
    await f.health.saveProbe(
      f.workspace,
      service.id,
      null,
      validateProbe({
        name: "Ready",
        url: "http://example.com/health",
        jsonPath: "ready",
        jsonExpected: true,
      }),
    );
    stop = startHealthWorker(f.health);
    await waitUntil(
      async () =>
        (await f.health.snapshot(f.workspace)).services[0].probes[0]
          .checks24h === 1,
    );
    await stop();
    const state = (await f.health.snapshot(f.workspace)).services[0].probes[0];
    assert.equal(state.status, "healthy");
    assert.equal(state.lastCheck?.statusCode, 200);
    assert.equal(state.lastCheck?.ok, true);
    assert.equal(state.successRate24h, 100);
    assert.equal(state.history.length, 1);
    assert.equal(
      (await f.health.claim(1)).length,
      0,
      "Completed probe must be rescheduled, not immediately reclaimed",
    );
  } finally {
    await stop?.();
    resolver.mock.restore();
    transport.mock.restore();
    await f.events.close();
  }
});

test("worker caps active probes at four and shutdown waits for their bounded timeouts and database records", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  let stop: (() => Promise<void>) | undefined;
  let active = 0;
  let peak = 0;
  let started = 0;
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const transport = mock.method(
    http,
    "request",
    (_url: URL, _options: unknown, callback: (response: unknown) => void) => {
      const request = new EventEmitter() as any;
      let destroyed = false;
      request.destroy = () => {
        if (!destroyed) {
          destroyed = true;
          active--;
        }
        return request;
      };
      request.end = () => {
        started++;
        active++;
        peak = Math.max(peak, active);
        const response = new PassThrough() as any;
        response.statusCode = 200;
        callback(response);
        response.write("never ends");
      };
      return request;
    },
  );
  try {
    const service = await f.health.createService(f.workspace, "Bounded API");
    for (let index = 0; index < 5; index++)
      await f.health.saveProbe(
        f.workspace,
        service.id,
        null,
        validateProbe({
          name: `Probe ${index}`,
          url: "http://example.com/health",
          timeoutMs: 3000,
        }),
      );
    stop = startHealthWorker(f.health);
    await waitUntil(() => started === 4);
    // Cross a scheduler tick while all four requests remain in flight.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(started, 4);
    assert.equal(peak, 4);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopped, false, "Shutdown must wait for active requests");
    await stopping;
    assert.equal(active, 0);
    const probes = (await f.health.snapshot(f.workspace)).services[0].probes;
    assert.equal(probes.filter((probe) => probe.checks24h === 1).length, 4);
    assert.equal(probes.filter((probe) => probe.checks24h === 0).length, 1);
    assert.ok(
      probes
        .filter((probe) => probe.lastCheck)
        .every(
          (probe) =>
            probe.lastCheck?.ok === false &&
            /timed out/.test(probe.lastCheck.reason),
        ),
    );
    assert.equal(started, 4, "Shutdown must not claim the fifth probe");
  } finally {
    await stop?.();
    resolver.mock.restore();
    transport.mock.restore();
    await f.events.close();
  }
});
