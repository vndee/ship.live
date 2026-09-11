import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const image = `ship-live-runtime-test:${process.pid}`;
const failure = (result) =>
  result.error?.stack ||
  result.stderr ||
  result.stdout ||
  "Docker command failed";

test("the production image can load the digest module", (t) => {
  t.after(() => {
    spawnSync("docker", ["image", "rm", "--force", image], {
      encoding: "utf8",
      timeout: 30_000,
    });
  });
  const build = spawnSync(
    "docker",
    ["build", "--target", "runtime", "--tag", image, "."],
    { encoding: "utf8", timeout: 300_000 },
  );
  assert.equal(build.status, 0, failure(build));

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
});
