import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const image = `example/image@sha256:${"a".repeat(64)}`;
const labels = {
  "org.opencontainers.image.source": "https://github.com/vndee/ship.live",
  "org.opencontainers.image.revision": "b".repeat(40),
  "org.opencontainers.image.version": "v1.4.2",
  "io.ship-live.schema-version": "18",
  "io.ship-live.max-schema-version": "19",
  "io.ship-live.tested-predecessor": "none",
};

function runPrebuiltSmoke(imageLabels, expectedPredecessor) {
  const directory = mkdtempSync(join(tmpdir(), "ship-live-prebuilt-test-"));
  const log = join(directory, "docker.log");
  const docker = join(directory, "docker");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  // Nested fixtures own their labels; a real release's expectation belongs only
  // to the outer runtime image and must not leak into these synthetic images.
  delete environment.SHIP_LIVE_TEST_PREDECESSOR;
  writeFileSync(
    docker,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$SHIP_LIVE_DOCKER_LOG"',
      'if [ "$1" = "run" ]; then exit 0; fi',
      'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
      '  printf "%s\\n" "$SHIP_LIVE_DOCKER_LABELS"',
      "  exit 0",
      "fi",
      "exit 91",
      "",
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "deploy/runtime-image.test.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...environment,
          PATH: `${directory}${delimiter}${environment.PATH}`,
          SHIP_LIVE_DOCKER_LABELS: JSON.stringify(imageLabels),
          SHIP_LIVE_DOCKER_LOG: log,
          SHIP_LIVE_TEST_IMAGE: image,
          ...(expectedPredecessor === undefined
            ? {}
            : { SHIP_LIVE_TEST_PREDECESSOR: expectedPredecessor }),
        },
      },
    );
    return {
      ...result,
      calls: existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n")
        : [],
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function assertCallerImageWasUsed(calls) {
  assert.equal(
    calls.some((call) => call.startsWith("build ")),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith("image rm ")),
    false,
  );
  if (
    !calls.some(
      (call) =>
        call.startsWith(`run --rm --entrypoint node ${image} `) &&
        call.includes("await import('./server/digest.ts')"),
    )
  )
    assert.fail(`Expected digest import call; got ${JSON.stringify(calls)}`);
  if (
    !calls.includes(`image inspect ${image} --format {{json .Config.Labels}}`)
  )
    assert.fail(`Expected label inspection; got ${JSON.stringify(calls)}`);
}

test("a supplied image skips build and removal while checking every label", () => {
  const result = runPrebuiltSmoke(labels);

  assert.equal(result.status, 0, result.stderr);
  assertCallerImageWasUsed(result.calls);
});

test("a failed supplied-image label check never removes the caller image", () => {
  for (const [label, value] of [
    ["org.opencontainers.image.source", "https://example.com/wrong"],
    ["org.opencontainers.image.revision", "abc123"],
    ["org.opencontainers.image.version", "v01.2.3"],
    ["io.ship-live.schema-version", "17"],
    ["io.ship-live.max-schema-version", "18"],
  ]) {
    const result = runPrebuiltSmoke({ ...labels, [label]: value });

    assert.notEqual(result.status, 0, result.stdout);
    assertCallerImageWasUsed(result.calls);
  }
});

// A Dockerfile that drops the predecessor build arg must fail the image gate.
test("runtime labels reject a missing or mutable tested predecessor", () => {
  for (const value of [
    undefined,
    "",
    "ghcr.io/vndee/ship.live:v1.4.1",
    `ghcr.io/vndee/ship.live@sha256:${"a".repeat(64)}\n`,
  ]) {
    const result = runPrebuiltSmoke({
      ...labels,
      "io.ship-live.tested-predecessor": value,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assertCallerImageWasUsed(result.calls);
  }
});

test("runtime labels bind the exact predecessor passed by the release gate", () => {
  const predecessor = `ghcr.io/vndee/ship.live@sha256:${"c".repeat(64)}`;
  const good = runPrebuiltSmoke(
    { ...labels, "io.ship-live.tested-predecessor": predecessor },
    predecessor,
  );
  assert.equal(good.status, 0, good.stdout);
  const bad = runPrebuiltSmoke(labels, predecessor);
  assert.notEqual(bad.status, 0, bad.stdout);
});
