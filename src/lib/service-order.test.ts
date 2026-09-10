import assert from "node:assert/strict";
import { test } from "node:test";
import { moveService } from "./service-order.ts";

test("moves a service without mutating the server snapshot", () => {
  const original = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    moveService(original, "c", "a").map((x) => x.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    original.map((x) => x.id),
    ["a", "b", "c"],
  );
});

test("returns the same order for missing or identical targets", () => {
  const services = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(moveService(services, "a", "a"), services);
  assert.deepEqual(moveService(services, "missing", "a"), services);
  assert.deepEqual(moveService(services, "a", "missing"), services);
  assert.deepEqual(moveService([], "a", "b"), []);
});

test("moves a service down while retaining its probes and identity", () => {
  const first = { id: "a", probes: [{ id: "probe-2" }, { id: "probe-1" }] };
  const second = { id: "b", probes: [] };
  const third = { id: "c", probes: [] };
  const moved = moveService([first, second, third], "a", "c");
  assert.deepEqual(
    moved.map((service) => service.id),
    ["b", "c", "a"],
  );
  assert.equal(moved[2], first);
  assert.deepEqual(
    moved[2].probes.map((probe) => probe.id),
    ["probe-2", "probe-1"],
  );
});
