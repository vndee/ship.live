import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    const result = spawnSync(
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
    return { ...result, directory };
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
  assert.equal(config.services.app.init, true);
  assert.equal(config.services.app.restart, "unless-stopped");
  assert.deepEqual(config.services.app.expose, ["3001"]);
  assert.deepEqual(config.services.app.networks, { private: null });
  assert.deepEqual(config.services.app.logging, {
    driver: "json-file",
    options: { "max-size": "10m", "max-file": "5" },
  });
  assert.equal(config.services.app.volumes.length, 1);
  const ca = config.services.app.volumes[0];
  assert.equal(ca.type, "bind");
  assert.equal(ca.source, join(result.directory, "secrets/supabase-ca.crt"));
  assert.equal(ca.target, "/secrets/supabase-ca.crt");
  assert.equal(ca.read_only, true);
  assert.deepEqual(
    config.services.caddy.ports.map(({ target, published, protocol }) => ({
      target,
      published,
      protocol,
    })),
    [
      { target: 80, published: "80", protocol: "tcp" },
      { target: 443, published: "443", protocol: "tcp" },
      { target: 443, published: "443", protocol: "udp" },
    ],
  );
  assert.equal(
    config.services.caddy.volumes[0].source,
    join(result.directory, "deploy/Caddyfile"),
  );
  assert.deepEqual(
    config.services.caddy.volumes.map(
      ({ type, source, target, read_only }) => ({
        type,
        source:
          type === "bind"
            ? source.slice(source.lastIndexOf("/deploy/"))
            : source,
        target,
        read_only: read_only ?? false,
      }),
    ),
    [
      {
        type: "bind",
        source: "/deploy/Caddyfile",
        target: "/etc/caddy/Caddyfile",
        read_only: true,
      },
      {
        type: "volume",
        source: "caddy_data",
        target: "/data",
        read_only: false,
      },
      {
        type: "volume",
        source: "caddy_config",
        target: "/config",
        read_only: false,
      },
    ],
  );
  assert.equal(
    config.services.caddy.depends_on.app.condition,
    "service_healthy",
  );
});

test("external Compose retains the deployed v1 parser's 2.4 contract", () => {
  assert.match(
    readFileSync(join(projectDirectory, "compose.external.yml"), "utf8"),
    /^version: "2\.4"\n/,
  );
});

test("external production Compose rejects a missing image reference", () => {
  const result = renderCompose();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_IMAGE/);
});
