import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MAX_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from "../server/migrations.ts";

const suppliedImage = process.env.SHIP_LIVE_TEST_IMAGE;
const image = suppliedImage ?? `ship-live-runtime-test:${process.pid}`;
const ownsImage = !suppliedImage;
const failure = (result) =>
  result.error?.stack ||
  result.stderr ||
  result.stdout ||
  "Docker command failed";

test("the production image loads the digest module and carries release labels", (t) => {
  if (ownsImage) {
    t.after(() => {
      spawnSync("docker", ["image", "rm", "--force", image], {
        encoding: "utf8",
        timeout: 30_000,
      });
    });
    const build = spawnSync(
      "docker",
      [
        "build",
        "--target",
        "runtime",
        "--tag",
        image,
        "--build-arg",
        "RELEASE_VERSION=v0.0.0",
        "--build-arg",
        `VCS_REVISION=${"0".repeat(40)}`,
        "--build-arg",
        `SCHEMA_VERSION=${SCHEMA_VERSION}`,
        "--build-arg",
        `MAX_SCHEMA_VERSION=${MAX_SUPPORTED_SCHEMA_VERSION}`,
        ".",
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    assert.equal(build.status, 0, failure(build));
  }

  const loadServerModule = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      image,
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "await import('./server/digest.ts')",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(loadServerModule.status, 0, failure(loadServerModule));

  const inspect = spawnSync(
    "docker",
    ["image", "inspect", image, "--format", "{{json .Config.Labels}}"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(inspect.status, 0, failure(inspect));
  const labels = JSON.parse(inspect.stdout);
  assert.equal(
    labels["org.opencontainers.image.source"],
    "https://github.com/vndee/ship.live",
  );
  assert.match(labels["org.opencontainers.image.revision"], /^[0-9a-f]{40}$/);
  assert.match(labels["org.opencontainers.image.version"], /^v\d+\.\d+\.\d+$/);
  assert.equal(labels["io.ship-live.schema-version"], String(SCHEMA_VERSION));
  assert.equal(
    labels["io.ship-live.max-schema-version"],
    String(MAX_SUPPORTED_SCHEMA_VERSION),
  );
});
