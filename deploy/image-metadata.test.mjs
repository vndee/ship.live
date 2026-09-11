import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { metadata } from "./image-metadata.mjs";
import {
  SCHEMA_VERSION,
  MAX_SUPPORTED_SCHEMA_VERSION,
} from "../server/migrations.ts";

test("metadata accepts a stable release and full revision", () => {
  assert.deepEqual(metadata("v1.4.2", "a".repeat(40), 18, 19), {
    version: "v1.4.2",
    revision: "a".repeat(40),
    schemaVersion: 18,
    maxSchemaVersion: 19,
  });
});

test("metadata rejects prerelease versions", () => {
  assert.throws(() => metadata("v1.4.2-rc.1", "a".repeat(40), 18, 19));
});

test("metadata rejects abbreviated revisions", () => {
  assert.throws(() => metadata("v1.4.2", "abc123", 18, 19));
});

test("metadata rejects non-scalar release inputs", () => {
  assert.throws(() =>
    metadata({ toString: () => "v1.4.2" }, "a".repeat(40), 18, 19),
  );
});

test("the metadata command prints GitHub-output-safe scalar lines", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "deploy/image-metadata.mjs", "v1.4.2", "a".repeat(40)],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `VERSION=v1.4.2\nREVISION=${"a".repeat(40)}\nSCHEMA_VERSION=${SCHEMA_VERSION}\nMAX_SCHEMA_VERSION=${MAX_SUPPORTED_SCHEMA_VERSION}\n`,
  );
});
