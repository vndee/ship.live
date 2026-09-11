import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureImage = `ghcr.io/vndee/ship.live@sha256:${"a".repeat(64)}`;

function renderCompose({ appImage } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ship-live-compose-external-"));
  const composeFile = join(directory, "compose.external.yml");
  const environment = { ...process.env, APP_DOMAIN: "ship.example.test" };
  delete environment.APP_IMAGE;
  if (appImage) environment.APP_IMAGE = appImage;

  try {
    copyFileSync(join(projectDirectory, "compose.external.yml"), composeFile);
    mkdirSync(join(directory, "deploy"));
    copyFileSync(
      join(projectDirectory, "deploy", "Caddyfile"),
      join(directory, "deploy", "Caddyfile"),
    );
    writeFileSync(
      join(directory, ".env.production"),
      "APP_DOMAIN=ship.example.test\nDATABASE_URL=postgres://fixture\n",
    );
    return spawnSync(
      "docker",
      [
        "compose",
        "--project-directory",
        directory,
        "--env-file",
        join(directory, ".env.production"),
        "-f",
        composeFile,
        "config",
        "--format",
        "json",
      ],
      { cwd: directory, encoding: "utf8", env: environment },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("external production Compose pulls the supplied immutable image", () => {
  const result = renderCompose({ appImage: fixtureImage });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.services.app.build, undefined);
  assert.equal(config.services.app.image, fixtureImage);
  assert.deepEqual(config.services.app.tmpfs, ["/tmp:size=64m,mode=1777"]);
  assert.equal(config.services.app.read_only, true);
  assert.equal(
    config.services.caddy.depends_on.app.condition,
    "service_healthy",
  );
});

test("external production Compose rejects a missing image reference", () => {
  const result = renderCompose();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_IMAGE/);
});
