import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonPath, readJsonPath } from "./json-path.ts";

test("reads fields, numeric indexes, and primitive equality filters", () => {
  const value = {
    components: [
      { name: "Responses", status: "degraded" },
      { name: "Embeddings", status: "operational" },
    ],
  };
  assert.equal(
    readJsonPath(
      value,
      parseJsonPath('components[?(@.name=="Embeddings")].status'),
    ),
    "operational",
  );
  assert.equal(
    readJsonPath({ items: [{ ok: true }] }, parseJsonPath("items.0.ok")),
    true,
  );
});

test("accepts every bounded primitive and chooses the first strict match", () => {
  assert.equal(
    readJsonPath(
      {
        v: [
          { x: 1, y: "first" },
          { x: 1, y: "second" },
        ],
      },
      parseJsonPath("v[?(@.x==1)].y"),
    ),
    "first",
  );
  assert.equal(
    readJsonPath(
      { v: [{ x: false, y: 2 }] },
      parseJsonPath("v[?(@.x==false)].y"),
    ),
    2,
  );
  assert.equal(
    readJsonPath(
      { v: [{ x: null, y: 3 }] },
      parseJsonPath("v[?(@.x==null)].y"),
    ),
    3,
  );
});

test("rejects executable, ambiguous, malformed, and prototype paths", () => {
  for (const path of [
    "components[*].status",
    'components[?(@.name!="Embeddings")].status',
    "components[?(@.name==process.exit())].status",
    "components[?(@.__proto__==null)].status",
    "constructor.value",
    "a..b",
    "x".repeat(257),
  ])
    assert.throws(() => parseJsonPath(path), /JSON path/);
});
