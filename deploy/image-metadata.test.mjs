import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { metadata } from "./image-metadata.mjs";
import {
  SCHEMA_VERSION,
  MAX_SUPPORTED_SCHEMA_VERSION,
} from "../server/migrations.ts";

const predecessor = `ghcr.io/vndee/ship.live@sha256:${"b".repeat(64)}`;

// Missing/normalized predecessor metadata would let a schema migration advertise
// compatibility with an image other than the one actually exercised in CI.
test("metadata binds the exact tested predecessor image and validates the first-release sentinel", () => {
  for (const image of [predecessor, "none"]) {
    assert.equal(
      metadata("v1.4.2", "a".repeat(40), 18, 19, image).testedPredecessor,
      image,
    );
  }
  for (const image of [
    undefined,
    "",
    predecessor.toUpperCase(),
    predecessor + "\n",
    predecessor + "\0",
    predecessor + ";id",
    predecessor.replace("ship.live", "other"),
    "ghcr.io/vndee/ship.live:v1.4.1",
    "NONE",
    { toString: () => predecessor },
  ]) {
    assert.throws(() => metadata("v1.4.2", "a".repeat(40), 18, 19, image));
  }
});

test("metadata CLI emits the exact tested predecessor without shell injection", () => {
  for (const image of [predecessor, "none", predecessor + "\nINJECTED=yes"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "deploy/image-metadata.mjs",
        "v1.4.2",
        "a".repeat(40),
        image,
      ],
      { encoding: "utf8" },
    );
    if (image.includes("\n")) {
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.endsWith(`TESTED_PREDECESSOR=${image}\n`));
    }
  }
});

test("metadata accepts a stable release and full revision", () => {
  assert.deepEqual(metadata("v1.4.2", "a".repeat(40), 18, 19, "none"), {
    version: "v1.4.2",
    revision: "a".repeat(40),
    schemaVersion: 18,
    maxSchemaVersion: 19,
    testedPredecessor: "none",
  });
});

test("metadata rejects prerelease versions", () => {
  assert.throws(() => metadata("v1.4.2-rc.1", "a".repeat(40), 18, 19, "none"));
});

test("metadata rejects abbreviated revisions", () => {
  assert.throws(() => metadata("v1.4.2", "abc123", 18, 19, "none"));
});

test("metadata rejects non-scalar release inputs", () => {
  assert.throws(() =>
    metadata({ toString: () => "v1.4.2" }, "a".repeat(40), 18, 19, "none"),
  );
});

test("the metadata command prints GitHub-output-safe scalar lines", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "deploy/image-metadata.mjs",
      "v1.4.2",
      "a".repeat(40),
      "none",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `VERSION=v1.4.2\nREVISION=${"a".repeat(40)}\nSCHEMA_VERSION=${SCHEMA_VERSION}\nMAX_SCHEMA_VERSION=${MAX_SUPPORTED_SCHEMA_VERSION}\nTESTED_PREDECESSOR=none\n`,
  );
});
