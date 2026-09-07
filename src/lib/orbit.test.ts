import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityEvent } from "../../shared/types";
import {
  buildOrbitModel,
  orbitPosition,
  projectOrbitPosition,
  visibleOrbitPoints,
} from "./orbit.ts";

const start = Date.parse("2026-09-07T00:00:00Z");
const end = Date.parse("2026-09-08T00:00:00Z");
const event = (
  id: string,
  repo = "platform",
  time = start + 3600000,
): ActivityEvent => ({
  id,
  repo,
  occurredAt: new Date(time).toISOString(),
  type: "merge",
  title: "Keep the event and the point connected",
  actor: { login: "minh" },
});

test("orbit has exactly one point per distinct real event, including range boundaries", () => {
  const first = event("first", "platform", start);
  const last = event("last", "agents", end);
  const model = buildOrbitModel(
    [
      first,
      last,
      first,
      event("old", "platform", start - 1),
      event("future", "platform", end + 1),
      { ...event("invalid"), occurredAt: "invalid" },
    ],
    ["platform", "agents"],
    start,
    end,
  );
  assert.deepEqual(
    model.points.map((point) => point.event.id),
    ["last", "first"],
  );
  assert.equal(model.points[0].event, last);
  assert.equal(model.points[1].event, first);
  assert.equal(model.points[0].time, 1);
  assert.equal(model.points[1].time, 0);
  assert.equal(buildOrbitModel([], ["platform"], start, end).points.length, 0);
});

test("event positions survive delivery reordering and new events in an existing repository", () => {
  const a = event("a");
  const b = event("b", "agents", start + 7200000);
  const original = buildOrbitModel([a, b], ["platform", "agents"], start, end);
  const refreshed = buildOrbitModel(
    [event("new", "agents", start + 10800000), b, a],
    ["agents", "platform", "agents"],
    start,
    end,
  );
  for (const point of original.points) {
    assert.deepEqual(
      refreshed.points.find((item) => item.event.id === point.event.id),
      point,
    );
  }
  assert.deepEqual(original.repositories, ["agents", "platform"]);
});

test("timeline cutoff hides future events without moving surviving points or trimming repository traces", () => {
  const model = buildOrbitModel(
    [event("early", "platform", start), event("later", "agents", end)],
    ["platform", "agents"],
    start,
    end,
  );
  const before = model.traces;
  const subset = visibleOrbitPoints(model, start);
  assert.deepEqual(
    subset.map((point) => point.event.id),
    ["early"],
  );
  assert.equal(subset[0], model.points[1]);
  assert.equal(model.traces, before);
  assert.equal(visibleOrbitPoints(model, start - 1).length, 0);
  assert.equal(visibleOrbitPoints(model, end).length, 2);
});

test("simultaneous events get stable distinct positions while retaining their shared timestamp", () => {
  const model = buildOrbitModel(
    [event("one"), event("two")],
    ["platform"],
    start,
    end,
  );
  assert.equal(model.points[0].time, model.points[1].time);
  assert.notDeepEqual(
    [model.points[0].x, model.points[0].y, model.points[0].z],
    [model.points[1].x, model.points[1].y, model.points[1].z],
  );
  assert.deepEqual(
    model,
    buildOrbitModel([event("two"), event("one")], ["platform"], start, end),
  );
});

test("small and large organizations keep finite bounded geometry under arbitrary camera rotation", () => {
  for (const repositoryCount of [1, 5, 100]) {
    for (let repo = 0; repo < repositoryCount; repo += 1) {
      for (let step = 0; step <= 16; step += 1) {
        const position = orbitPosition(
          repo,
          repositoryCount,
          step / 16,
          0.033,
          0.021,
        );
        assert.ok(Math.hypot(position.x, position.y, position.z) < 1.1);
        for (const yaw of [-Math.PI, -1, 0.18, 1, Math.PI]) {
          for (const pitch of [-1.25, -0.38, 1.25]) {
            const projected = projectOrbitPosition(position, yaw, pitch);
            assert.ok(Object.values(projected).every(Number.isFinite));
            assert.ok(
              projected.perspective > 0.75 && projected.perspective < 1.4,
            );
          }
        }
      }
    }
  }
});

test("a zero-length period and an unknown repository still produce a selectable finite point", () => {
  const model = buildOrbitModel(
    [event("instant", "new-repo", start)],
    [],
    start,
    start,
  );
  assert.deepEqual(model.repositories, ["new-repo"]);
  assert.equal(model.points.length, 1);
  assert.ok(
    [model.points[0].x, model.points[0].y, model.points[0].z].every(
      Number.isFinite,
    ),
  );
});
