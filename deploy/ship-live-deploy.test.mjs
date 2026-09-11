import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const target = `ghcr.io/vndee/ship.live@sha256:${"a".repeat(64)}`;
const old = `ghcr.io/vndee/ship.live@sha256:${"b".repeat(64)}`;
const stale = `ghcr.io/vndee/ship.live@sha256:${"c".repeat(64)}`;
const revision = "d".repeat(40);
const source = "https://github.com/vndee/ship.live";
const metadata = `${source}|v1.2.0|${revision}|2|3`;
const priorMetadata = `${source}|v1.1.0|${revision}|1|2`;
const state = (image = old, version = "v1.1.0") =>
  `IMAGE=${image}\nVERSION=${version}\nREVISION=${revision}\nSCHEMA_VERSION=1\nMAX_SCHEMA_VERSION=2\nDEPLOYED_AT=2026-09-10T00:00:00Z\n`;

// Only disposable script copies have constants rewritten. Production has no test
// environment switch, and every external host operation is replaced by a fake.
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ship-deploy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"),
    app = join(root, "app"),
    data = join(root, "state");
  for (const path of [bin, app, data]) mkdirSync(path);
  writeFileSync(join(app, ".env.production"), "DO_NOT_PRINT=fixture-secret\n");
  writeFileSync(join(app, "compose.external.yml"), "services: {}\n");
  if (!options.bootstrap)
    writeFileSync(join(data, "current"), options.state ?? state());
  if (options.previous)
    writeFileSync(join(data, "previous"), state(stale, "v1.0.0"));
  const log = join(root, "commands.jsonl");
  writeFileSync(
    join(root, "options.json"),
    JSON.stringify({
      target,
      old,
      stale,
      metadata,
      priorMetadata,
      testedPredecessor: options.bootstrap ? "none" : old,
      ...options,
    }),
  );
  const fake = join(bin, "fake");
  writeFileSync(
    fake,
    `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const o = JSON.parse(readFileSync(join(root, 'options.json')));
const name = basename(process.argv[1]), a = process.argv.slice(2);
const activePath = join(root, 'active');
const active = existsSync(activePath) ? readFileSync(activePath, 'utf8') : o.old;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({name, args:a, image:process.env.APP_IMAGE ?? null, active, dockerHost:process.env.DOCKER_HOST, project:process.env.COMPOSE_PROJECT_NAME})+'\\n');
const out = value => process.stdout.write(String(value)+'\\n');
if (name === 'id') out(o.nonroot ? '501' : '0');
else if (name === 'flock') process.exit(o.contention ? 1 : 0);
else if (name === 'sudo') process.exit(0);
else if (name === 'timeout') {
  const durationIndex = a.findIndex(arg => !arg.startsWith('--'));
  const command = a[durationIndex + 1], commandArgs = a.slice(durationIndex + 2);
  if (o.timeoutPs && command === 'docker-compose' && commandArgs.includes('ps')) process.exit(137);
  if (o.timeoutInspect && command === 'docker' && commandArgs[0] === 'inspect') process.exit(137);
  const r = spawnSync(command, commandArgs, {stdio:'inherit',env:process.env}); process.exit(r.status ?? 1);
}
else if (name === 'sleep') process.exit(0);
else if (name === 'date') out('2026-09-11T00:00:00Z');
else if (name === 'docker-compose') {
  const cmd = a.find(arg => ['config', 'up', 'ps', 'logs', 'stop'].includes(arg));
  if (cmd === 'config') { out('DO_NOT_PRINT=fixture-secret'); process.exit(o.configFail ? 1 : 0); }
  if (cmd === 'up') { writeFileSync(activePath, process.env.APP_IMAGE); process.exit((o.upFail && process.env.APP_IMAGE === o.target) || (o.rollbackUpFail && process.env.APP_IMAGE === o.old) ? 1 : 0); }
  if (cmd === 'ps') out(o.noContainer ? '' : 'container-id');
  if (cmd === 'logs') for (let i=0; i<150; i++) out('app-log-'+i);
  if (cmd === 'stop') process.exit(o.stopFail ? 1 : 0);
} else if (name === 'docker') {
  if (a[0] === 'pull') process.exit(o.pullFail ? 1 : 0);
  if (a[0] === 'image' && a[1] === 'inspect') {
    if (a.includes('{{.Id}}')) { out(o.old); process.exit(0); }
    if (o.inspectFail || (a.at(-1) === o.old && o.priorInspectFail)) process.exit(1);
    const value = a.at(-1) === o.target ? o.metadata : o.priorMetadata;
    if (a[3] === '{{json .Config.Labels}}') {
      const keys = ['org.opencontainers.image.source','org.opencontainers.image.version','org.opencontainers.image.revision','io.ship-live.schema-version','io.ship-live.max-schema-version'];
      const parts = value.split('|');
      if (parts.length > keys.length) parts[4] = parts.slice(4).join('|');
      const labels = Object.fromEntries(keys.map((key,i)=>[key,parts[i]]));
      labels['io.ship-live.tested-predecessor'] = a.at(-1) === o.target ? o.testedPredecessor : 'none';
      out(JSON.stringify(labels));
    } else out(value + (a[3].endsWith('|END') ? '|END' : ''));
  }
  if (a[0] === 'inspect') {
    if (a.includes('{{.Image}}')) { out(active); process.exit(0); }
    const countPath = join(root, 'polls');
    const count = existsSync(countPath) ? Number(readFileSync(countPath)) : 0;
    writeFileSync(countPath, String(count+1));
    if (o.healthInspectFail) process.exit(1);
    out(active === o.target ? (o.health ?? 'running|healthy|0') : (o.rollbackHealth ?? 'running|healthy|0'));
  }
  if (a[0] === 'image' && a[1] === 'ls') out([o.target, o.old, o.stale, 'elsewhere/image@sha256:'+ 'e'.repeat(64), '<none>@<none>'].join('\\n'));
  if (a[0] === 'image' && a[1] === 'rm') process.exit(o.pruneFail ? 1 : 0);
} else if (name === 'curl') {
  const failed = (active === o.target && o.curlFail) || (active === o.old && o.rollbackCurlFail);
  const body = failed ? (o.curlFailureBody ?? '') : active === o.target ? (o.publicBody ?? '{"status":"ok"}') : (o.rollbackBody ?? '{"status":"ok"}');
  const outputIndex = a.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(a[outputIndex+1], Buffer.from(body));
  else process.stdout.write(body);
  if (a.includes('--write-out')) process.stdout.write(String(active === o.target ? (o.publicCode ?? 200) : (o.rollbackCode ?? 200)));
  process.exit(failed ? 22 : 0);
} else if (name === 'python3') {
  if (o.persistFail && a.includes('commit')) process.exit(1);
  let input;
  if (a.includes('-')) {
    const prelude = 'import os, json\\n_original_fsync = os.fsync\\n_original_replace = os.replace\\ndef _record(event, value):\\n    with open('+JSON.stringify(${JSON.stringify(log)})+', "a") as log:\\n        log.write(json.dumps({"name": event, "args": [value]}) + "\\\\n")\\ndef _fsync(fd):\\n    _record("fsync", fd)\\n    return _original_fsync(fd)\\ndef _replace(src, dst):\\n    _record("rename", dst)\\n    return _original_replace(src, dst)\\nos.fsync = _fsync\\nos.replace = _replace\\n';
    input = prelude + readFileSync(0, 'utf8');
    if (o.fsyncFail && a.includes('commit')) input = input.replace('def _fsync(fd):', '_sync_count = 0\\ndef _fsync(fd):\\n    global _sync_count\\n    _sync_count += 1\\n    if _sync_count == 4:\\n        raise OSError("injected directory fsync failure")');
  }
  const r = spawnSync(${JSON.stringify(spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim())}, a, input === undefined ? {stdio:'inherit'} : {input, stdio:['pipe','inherit','inherit']});
  if (o.commitSignal && a.includes('commit') && r.status === 0) process.kill(process.ppid, 'SIGTERM');
  process.exit(r.status ?? 1);
} else { throw new Error('Unexpected command '+name); }
`,
  );
  chmodSync(fake, 0o755);
  for (const name of [
    "docker",
    "docker-compose",
    "curl",
    "id",
    "flock",
    "sudo",
    "timeout",
    "sleep",
    "date",
    "python3",
  ])
    symlinkSync(fake, join(bin, name));
  const copy = (name) => {
    const file = resolve("deploy", name);
    if (name !== "bootstrap-restore")
      assert.ok(existsSync(file), `${name} implementation does not exist`);
    let script =
      name === "bootstrap-restore"
        ? readFileSync(resolve("docs/self-host-docker.md"), "utf8").match(
            /<!-- bootstrap-restore:start -->\s*```sh\n([\s\S]*?)\n```\s*<!-- bootstrap-restore:end -->/,
          )?.[1]
        : readFileSync(file, "utf8");
    assert.ok(
      script,
      "The executable first-bootstrap restoration procedure is missing",
    );
    for (const [from, to] of [
      [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `PATH=${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
      ],
      ["APP_DIR=/opt/apps/ship-live", `APP_DIR=${app}`],
      ["STATE_DIR=/var/lib/ship-live-deploy", `STATE_DIR=${data}`],
    ]) {
      if (name === "ship-live-deploy-ssh" && !from.startsWith("PATH="))
        continue;
      assert.equal(
        script.split(from).length,
        2,
        `Unsafe fixture: missing or repeated ${from}`,
      );
      script = script.replace(from, to);
    }
    if (options.advanceClock)
      script = script.replace(
        'sleep "$wait_seconds"',
        'SECONDS=$((SECONDS + 120)); sleep "$wait_seconds"',
      );
    if (options.advanceAfterPs)
      script = script.replace(
        /\[\[ "?\$container"? =~/,
        (match) =>
          `SECONDS=$((SECONDS + ${options.advanceAfterPs === true ? 120 : options.advanceAfterPs})); ${match}`,
      );
    const dest = join(root, name);
    writeFileSync(dest, script, { mode: 0o755 });
    return dest;
  };
  return {
    run(args = [target], env = {}, name = "ship-live-deploy") {
      return spawnSync("/bin/bash", [copy(name), ...args], {
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: "/usr/bin:/bin", ...env },
      });
    },
    commands() {
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse)
        : [];
    },
    read(name) {
      return existsSync(join(data, name))
        ? readFileSync(join(data, name), "utf8")
        : null;
    },
    data,
    root,
    restore(env) {
      return spawnSync("/bin/bash", [copy("bootstrap-restore")], {
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: "/usr/bin:/bin", ...env },
      });
    },
  };
}
const upCommands = (f) =>
  f
    .commands()
    .filter((c) => c.name === "docker-compose" && c.args.includes("up"));
const notMutated = (f) => assert.equal(upCommands(f).length, 0);
const failed = (r) => {
  assert.equal(r.error, undefined);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
};

// The former max-schema-only decision allowed C to migrate and restore A even
// though compatibility had only exercised B. Run the real transaction twice:
// B fails health and leaves A current; C must then be rejected before Compose.
test("tested predecessor rejects skipped or failed intermediate B before C can migrate A", (t) => {
  const aState = state().replace(
    "SCHEMA_VERSION=1\nMAX_SCHEMA_VERSION=2",
    "SCHEMA_VERSION=18\nMAX_SCHEMA_VERSION=19",
  );
  for (const failedB of [false, true]) {
    const f = fixture(t, {
      state: aState,
      metadata: `${source}|v1.2.0|${revision}|18|19`,
      priorMetadata: `${source}|v1.1.0|${revision}|18|19`,
      health: "exited|unhealthy|0",
    });
    writeFileSync(join(f.root, "active"), old);
    if (failedB) {
      failed(f.run());
      assert.deepEqual(
        upCommands(f).map((c) => c.image),
        [target, old],
      );
      assert.equal(f.read("current"), aState);
    }
    const config = join(f.root, "options.json");
    const options = JSON.parse(readFileSync(config, "utf8"));
    writeFileSync(
      config,
      JSON.stringify({
        ...options,
        target: stale,
        metadata: `${source}|v1.3.0|${revision}|19|20`,
        testedPredecessor: target,
      }),
    );
    const before = f.commands().length;
    const result = f.run([stale]);
    failed(result);
    assert.match(result.stderr, /tested predecessor.*current/i);
    assert.equal(
      f
        .commands()
        .slice(before)
        .some((c) => c.name === "docker-compose"),
      false,
      "C must never get a chance to apply its destructive migration",
    );
    assert.equal(f.read("current"), aState);
    assert.equal(readFileSync(join(f.root, "active"), "utf8"), old);
  }
});

test("tested predecessor rejects invalid labels and a schema-changing mismatch before mutation", (t) => {
  for (const testedPredecessor of [
    stale,
    "none",
    null,
    "",
    old.toUpperCase(),
    old + "\n",
    old + "\0",
    old + ";id",
    "ghcr.io/vndee/ship.live:v1.1.0",
    old.replace("ship.live", "other"),
  ]) {
    const f = fixture(t, { testedPredecessor });
    failed(f.run());
    notMutated(f);
    assert.equal(f.read("current"), state());
  }
});

test("tested predecessor preserves same-schema releases but reserves sentinel for empty bootstrap state", (t) => {
  const same = fixture(t, {
    testedPredecessor: stale,
    metadata: metadata.replace("|2|3", "|1|2"),
  });
  assert.equal(same.run().status, 0);
  const bootstrap = fixture(t, { bootstrap: true });
  assert.equal(bootstrap.run().status, 0);
  for (const options of [
    { bootstrap: true, testedPredecessor: old },
    { testedPredecessor: "none", metadata: metadata.replace("|2|3", "|1|2") },
  ]) {
    const f = fixture(t, options);
    failed(f.run());
    notMutated(f);
  }
});
function bootstrapBackup(f, legacy, approvedTarget = target) {
  const backup = join(f.root, "bootstrap");
  mkdirSync(backup);
  writeFileSync(join(backup, "image-id"), `${legacy}\n`);
  writeFileSync(join(backup, "schema-safe"), `${approvedTarget}\n${legacy}\n`);
  writeFileSync(join(backup, "working.compose.yml"), "services: {}\n");
  writeFileSync(join(backup, "fallback-image.yml"), "services: {}\n");
  writeFileSync(join(backup, ".env.production"), "SYNTHETIC=true\n");
  return backup;
}

test("rejects tags, flags, extra arguments, uppercase digests, and alternate images", (t) => {
  for (const args of [
    [],
    ["ghcr.io/vndee/ship.live:v1.2.0"],
    ["--help"],
    [target, "extra"],
    [target.toUpperCase()],
    [target.replace("ship.live", "other")],
    [target + "\n"],
    [target + ";id"],
  ]) {
    const f = fixture(t);
    failed(f.run(args));
    assert.equal(f.commands().filter((c) => c.name === "docker").length, 0);
  }
});
test("passes one validated SSH_ORIGINAL_COMMAND value to sudo without eval or word splitting", (t) => {
  const f = fixture(t);
  assert.equal(
    f.run([], { SSH_ORIGINAL_COMMAND: target }, "ship-live-deploy-ssh").status,
    0,
  );
  assert.deepEqual(f.commands().find((c) => c.name === "sudo").args, [
    "-n",
    "--",
    "/usr/local/sbin/ship-live-deploy",
    target,
  ]);
  for (const value of [
    target + " extra",
    target + "; touch /tmp/unsafe",
    "$(id)",
    target + "\n",
    target.toUpperCase(),
    "",
  ]) {
    const bad = fixture(t);
    failed(
      bad.run([], { SSH_ORIGINAL_COMMAND: value }, "ship-live-deploy-ssh"),
    );
    assert.equal(bad.commands().length, 0);
  }
  const bad = fixture(t);
  failed(
    bad.run(
      ["extra"],
      { SSH_ORIGINAL_COMMAND: target },
      "ship-live-deploy-ssh",
    ),
  );
});
test("serializes with flock and exits before docker pull on contention", (t) => {
  const f = fixture(t, { contention: true });
  failed(f.run());
  assert.deepEqual(f.commands().find((c) => c.name === "flock").args, [
    "-n",
    "9",
  ]);
  notMutated(f);
  assert.ok(!f.commands().some((c) => c.name === "docker"));
});
test("rejects nonroot execution and malformed recorded state without touching Docker", (t) => {
  for (const options of [
    { nonroot: true },
    { state: "IMAGE=$(id)\n" },
    { state: state().replace("v1.1.0", "v01.1.0") },
  ]) {
    const f = fixture(t, options);
    failed(f.run());
    assert.ok(!f.commands().some((c) => c.name === "docker"));
  }
});
test("leaves the current app untouched when pull or label validation fails", (t) => {
  for (const options of [{ pullFail: true }, { inspectFail: true }]) {
    const f = fixture(t, options);
    failed(f.run());
    notMutated(f);
    assert.equal(f.read("current"), state());
  }
});
test("rejects missing, malformed, or mismatched source/version/revision/schema labels", (t) => {
  for (const value of [
    "",
    metadata.replace(source, "https://github.com/elsewhere/app"),
    metadata.replace("v1.2.0", "1.2.0"),
    metadata.replace("v1.2.0", "v01.2.0"),
    metadata.replace("v1.2.0", "v1.2.0-beta.1"),
    metadata.replace(revision, revision.toUpperCase()),
    metadata.replace(revision, "abc"),
    metadata.replace("|2|3", "|0|3"),
    metadata.replace("|2|3", "|2|1"),
    metadata.replace("|2|3", "|2|NaN"),
    metadata + "|extra",
    metadata + "\nextra",
  ]) {
    const f = fixture(t, { metadata: value });
    failed(f.run());
    notMutated(f);
  }
});
test("rejects a target version not newer than recorded production", (t) => {
  for (const version of ["v1.1.0", "v1.0.9"]) {
    const f = fixture(t, { metadata: metadata.replace("v1.2.0", version) });
    failed(f.run());
    notMutated(f);
  }
});
test("recreates only app and records current/previous only after Docker and public health pass", (t) => {
  const f = fixture(t, { previous: true });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const c = f.commands(),
    up = upCommands(f);
  assert.equal(up.length, 1);
  assert.equal(up[0].image, target);
  assert.deepEqual(up[0].args, [
    "--env-file",
    ".env.production",
    "-f",
    "compose.external.yml",
    "up",
    "-d",
    "--no-deps",
    "app",
  ]);
  const indices = [
    c.findIndex((x) => x.name === "docker" && x.args[0] === "pull"),
    c.findIndex((x) => x.name === "docker" && x.args[1] === "inspect"),
    c.findIndex(
      (x) => x.name === "docker-compose" && x.args.includes("config"),
    ),
    c.findIndex((x) => x.name === "docker-compose" && x.args.includes("up")),
    c.findIndex((x) => x.name === "docker" && x.args[0] === "inspect"),
    c.findIndex((x) => x.name === "curl"),
    c.findIndex(
      (x) => x.name === "rename" && x.args[0] === join(f.data, "current"),
    ),
  ];
  assert.ok(
    indices.every((n, i) => n >= 0 && (i === 0 || n > indices[i - 1])),
    JSON.stringify(c),
  );
  assert.equal(c[indices.at(-1) - 1].name, "fsync");
  assert.equal(c[indices.at(-1) + 1].name, "fsync");
  assert.equal(
    f.read("current"),
    `IMAGE=${target}\nVERSION=v1.2.0\nREVISION=${revision}\nSCHEMA_VERSION=2\nMAX_SCHEMA_VERSION=3\nDEPLOYED_AT=2026-09-11T00:00:00Z\n`,
  );
  assert.equal(f.read("previous"), state());
  for (const name of ["current", "previous"])
    assert.equal(statSync(join(f.data, name)).mode & 0o777, 0o600);
  assert.ok(!readdirSync(f.data).some((name) => name.startsWith(".tmp")));
  assert.ok(!(r.stdout + r.stderr).includes("fixture-secret"));
});
test("bootstrap succeeds without previous state and cleans up temporary files", (t) => {
  const f = fixture(t, { bootstrap: true });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read("previous"), null);
  assert.ok(f.read("current").includes(target));
});

test("failed first replacement has no automatic rollback and the documented fallback restores only the retained image", (t) => {
  const legacy = `sha256:${"e".repeat(64)}`;
  const f = fixture(t, {
    bootstrap: true,
    old: legacy,
    health: "exited|unhealthy|0",
  });
  failed(f.run());
  assert.equal(f.read("current"), null);
  assert.equal(f.read("previous"), null);
  assert.equal(upCommands(f).length, 1);
  const backup = bootstrapBackup(f, legacy);
  const result = f.restore({ BOOTSTRAP_DIR: backup, TARGET_IMAGE: target });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    upCommands(f).map((c) => c.image),
    [target, legacy],
  );
  assert.ok(upCommands(f)[1].args.includes("--no-build"));
  assert.ok(upCommands(f)[1].args.includes("--no-deps"));
  assert.equal(upCommands(f)[1].args.at(-1), "app");
  assert.ok(f.commands().some((c) => c.name === "curl" && c.active === legacy));
  assert.equal(f.read("current"), null);
  assert.ok(f.read("last-failure"));
});

test("documented bootstrap recovery rejects mismatched schema evidence and existing committed state before mutation", (t) => {
  const legacy = `sha256:${"e".repeat(64)}`;
  for (const committed of [false, true]) {
    const f = fixture(t, { bootstrap: !committed, old: legacy });
    const backup = bootstrapBackup(f, legacy, committed ? target : stale);
    failed(f.restore({ BOOTSTRAP_DIR: backup, TARGET_IMAGE: target }));
    notMutated(f);
  }
});

test("documented bootstrap recovery enforces bounded Docker and byte-exact public health", (t) => {
  const legacy = `sha256:${"e".repeat(64)}`;
  for (const options of [
    { rollbackHealth: "running|healthy|3" },
    { rollbackHealth: "running|unhealthy|0" },
    { rollbackBody: '{"status":"ok"}\n' },
    { rollbackCode: 201 },
    { advanceAfterPs: true },
    { timeoutPs: true },
  ]) {
    const f = fixture(t, { bootstrap: true, old: legacy, ...options });
    const backup = bootstrapBackup(f, legacy);
    const result = f.restore({ BOOTSTRAP_DIR: backup, TARGET_IMAGE: target });
    failed(result);
    assert.doesNotMatch(result.stdout, /restored and healthy/);
    assert.equal(f.read("current"), null);
    assert.equal(upCommands(f).length, 1);
    const boundedCalls = f.commands().filter((c) => c.name === "timeout");
    assert.ok(boundedCalls.length >= 3);
    assert.ok(boundedCalls.every((c) => c.args.includes("--kill-after=1")));
  }
});
test("config failure does not recreate app or render environment values", (t) => {
  const f = fixture(t, { configFail: true });
  const r = f.run();
  failed(r);
  notMutated(f);
  assert.ok(!(r.stdout + r.stderr).includes("fixture-secret"));
});
test("rolls back and health-checks the previous digest when max-schema covers target schema", (t) => {
  for (const options of [
    { health: "exited|unhealthy|0" },
    { health: "running|unhealthy|0" },
    { health: "restarting|starting|3" },
    { curlFail: true },
    { publicBody: '{"status":"bad"}' },
    { upFail: true },
    { healthInspectFail: true },
    { noContainer: true },
    { persistFail: true },
  ]) {
    const f = fixture(t, options);
    const r = f.run();
    failed(r);
    assert.deepEqual(
      upCommands(f).map((x) => x.image),
      [target, old],
    );
    assert.equal(f.read("current"), state());
    assert.equal(f.read("previous"), null);
    assert.ok(f.read("last-failure").includes(target));
    if (!options.healthInspectFail && !options.noContainer)
      assert.ok(
        f.commands().some((x) => x.name === "curl" && x.active === old),
      );
  }
});
test("refuses unsafe/missing rollback image and stops failed app while leaving Caddy running", (t) => {
  for (const options of [
    { priorMetadata: priorMetadata.replace("|1|2", "|1|1") },
    { priorInspectFail: true },
    { priorMetadata: "invalid" },
    { bootstrap: true },
  ]) {
    const f = fixture(t, { health: "exited|unhealthy|0", ...options });
    failed(f.run());
    assert.equal(upCommands(f).length, 1);
    const stops = f
      .commands()
      .filter((x) => x.name === "docker-compose" && x.args.includes("stop"));
    assert.equal(stops.length, 1);
    assert.equal(stops[0].args.at(-1), "app");
    assert.ok(
      !f
        .commands()
        .some((x) => x.args.includes("caddy") || x.args.includes("down")),
    );
    assert.ok(f.read("last-failure"));
  }
});
test("preserves diagnostic state and exits nonzero when rollback health fails", (t) => {
  for (const options of [
    { rollbackHealth: "exited|unhealthy|0" },
    { rollbackCurlFail: true },
    { rollbackBody: "wrong" },
  ]) {
    const f = fixture(t, { curlFail: true, ...options });
    const r = f.run();
    failed(r);
    assert.match(r.stderr, /rollback failed/i);
    assert.equal(f.read("current"), state());
    assert.ok(f.read("last-failure"));
    assert.equal(upCommands(f).length, 2);
  }
});
test("retains current and previous digests while pruning only other ship.live images", (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    f
      .commands()
      .filter((x) => x.name === "docker" && x.args[1] === "rm")
      .map((x) => x.args),
    [["image", "rm", stale]],
  );
});
test("prune failure does not roll back a healthy committed deployment", (t) => {
  const f = fixture(t, { pruneFail: true });
  assert.equal(f.run().status, 0);
  assert.equal(upCommands(f).length, 1);
  assert.ok(f.read("current").includes(target));
});
test("prints only bounded app log tails and never renders Compose environment values", (t) => {
  const f = fixture(t, { curlFail: true });
  const r = f.run();
  failed(r);
  const logs = f
    .commands()
    .filter((x) => x.name === "docker-compose" && x.args.includes("logs"));
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].args.slice(4), [
    "logs",
    "--no-color",
    "--tail",
    "100",
    "app",
  ]);
  assert.equal(
    (r.stdout + r.stderr)
      .split("\n")
      .filter((line) => line.startsWith("app-log-")).length,
    100,
  );
  assert.ok(!(r.stdout + r.stderr).includes("fixture-secret"));
});
test("rejects a failed public request even when its body says ok", (t) => {
  const f = fixture(t, { curlFail: true, curlFailureBody: '{"status":"ok"}' });
  failed(f.run());
  assert.deepEqual(
    upCommands(f).map((x) => x.image),
    [target, old],
  );
});
test("rejects trailing newline in a label rather than trimming it into a valid integer", (t) => {
  const f = fixture(t, { metadata: metadata + "\n" });
  failed(f.run());
  notMutated(f);
});
test("bounds health polling and fails early for missing health or malformed Docker status", (t) => {
  for (const health of [
    "running|starting|0",
    "running|missing|0",
    "bad-format",
    "running|healthy|9999999999999999999999",
  ]) {
    const f = fixture(t, { health, advanceClock: true });
    failed(f.run());
    assert.equal(
      f
        .commands()
        .filter(
          (x) =>
            x.name === "docker" &&
            x.args[0] === "inspect" &&
            x.active === target,
        ).length,
      1,
    );
    assert.deepEqual(
      upCommands(f).map((x) => x.image),
      [target, old],
    );
    const deadlines = f
      .commands()
      .filter((x) => x.name === "timeout")
      .map((x) => Number(x.args.find((arg) => !arg.startsWith("--"))));
    assert.ok(deadlines.every((n) => n > 0 && n <= 120));
  }
});
test("rollback recreation and app stop failures stay nonzero with diagnostics", (t) => {
  for (const options of [
    { rollbackUpFail: true },
    { priorInspectFail: true, stopFail: true },
  ]) {
    const f = fixture(t, { curlFail: true, ...options });
    const r = f.run();
    failed(r);
    assert.ok(f.read("last-failure"));
    assert.match(r.stderr, /failed/i);
  }
});
test("caller environment cannot redirect commands, Docker, Compose, or deployment state", (t) => {
  const f = fixture(t);
  const r = f.run([target], {
    PATH: "/does-not-exist",
    DOCKER_HOST: "tcp://attacker:1234",
    DOCKER_CONFIG: "/attacker",
    COMPOSE_PROJECT_NAME: "attacker",
    SHIP_LIVE_DEPLOY_TEST_ROOT: "/attacker",
  });
  assert.equal(r.status, 0, r.stderr);
  for (const c of f.commands().filter((x) => x.name === "docker"))
    assert.equal(c.dockerHost, "unix:///var/run/docker.sock");
  for (const c of f.commands().filter((x) => x.name === "docker-compose"))
    assert.equal(c.project, "ship-live");
  assert.ok(f.read("current").includes(target));
});
test("rejects orphaned previous state before pulling or pruning any image", (t) => {
  const f = fixture(t, { bootstrap: true, previous: true });
  failed(f.run());
  assert.ok(!f.commands().some((command) => command.name === "docker"));
  assert.equal(f.read("previous"), state(stale, "v1.0.0"));
});

test("does not roll back committed state when termination arrives during commit", (t) => {
  const f = fixture(t, { commitSignal: true });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(upCommands(f).length, 1);
  assert.ok(f.read("current").includes(target));
  assert.equal(f.read("previous"), state());
});

test("restores both state records if directory fsync fails after current rename", (t) => {
  const f = fixture(t, { fsyncFail: true, previous: true });
  failed(f.run());
  assert.equal(f.read("current"), state());
  assert.equal(f.read("previous"), state(stale, "v1.0.0"));
  assert.deepEqual(
    upCommands(f).map((x) => x.image),
    [target, old],
  );
  assert.ok(!readdirSync(f.data).some((name) => name.startsWith(".tmp")));
});

test("round 1: public health requires byte-exact body and HTTP 200 for target and rollback", (t) => {
  for (const options of [
    { publicBody: '{"status":"ok"}\n' },
    { publicBody: '{"status":"o\0k"}' },
    { publicCode: 201 },
    { publicCode: 204 },
  ]) {
    const f = fixture(t, options);
    failed(f.run());
    assert.deepEqual(
      upCommands(f).map((x) => x.image),
      [target, old],
    );
    assert.equal(f.read("current"), state());
  }
  for (const options of [
    { rollbackBody: '{"status":"ok"}\n' },
    { rollbackBody: '{"status":"o\0k"}' },
    { rollbackCode: 201 },
  ]) {
    const f = fixture(t, { curlFail: true, ...options });
    const r = f.run();
    failed(r);
    assert.match(r.stderr, /Rollback failed/);
    assert.equal(f.read("current"), state());
  }
});

test("round 1: embedded NUL labels fail before mutation and forbid rollback", (t) => {
  for (const value of [
    metadata.replace("v1.2.0", "v1.\0" + "2.0"),
    metadata.replace("|2|3", "|2|\0" + "3"),
  ]) {
    const f = fixture(t, { metadata: value });
    failed(f.run());
    notMutated(f);
    assert.equal(f.read("current"), state());
  }
  const f = fixture(t, {
    curlFail: true,
    priorMetadata: priorMetadata.replace("|1|2", "|1|\0" + "2"),
  });
  failed(f.run());
  assert.equal(upCommands(f).length, 1);
  assert.ok(
    f
      .commands()
      .some((c) => c.name === "docker-compose" && c.args.includes("stop")),
  );
});

test("round 1: ps and inspect share a deadline including forced-kill grace", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const timeouts = f.commands().filter((c) => c.name === "timeout");
  assert.ok(
    timeouts.some(
      (c) => c.args.includes("docker-compose") && c.args.includes("ps"),
    ),
  );
  assert.ok(
    timeouts.some(
      (c) => c.args.includes("docker") && c.args.includes("inspect"),
    ),
  );
  for (const c of timeouts) {
    assert.ok(c.args.includes("--signal=TERM"));
    assert.ok(c.args.includes("--kill-after=1"));
    const duration = Number(c.args.find((arg) => !arg.startsWith("--")));
    assert.ok(duration > 0 && duration + 1 <= 120);
  }
  assert.ok(!readdirSync(f.data).some((name) => name.startsWith(".runtime.")));
  const partial = fixture(t, { advanceAfterPs: 115 });
  const partialResult = partial.run();
  assert.equal(partialResult.status, 0, partialResult.stderr);
  const remainingInspect = partial
    .commands()
    .find(
      (c) =>
        c.name === "timeout" &&
        c.args.includes("docker") &&
        c.args.includes("inspect"),
    );
  const remainingDuration = Number(
    remainingInspect.args.find((arg) => !arg.startsWith("--")),
  );
  assert.ok(remainingDuration > 0 && remainingDuration + 1 <= 5);
  const spent = fixture(t, { advanceAfterPs: true });
  failed(spent.run());
  assert.equal(
    spent
      .commands()
      .filter((c) => c.name === "docker" && c.args[0] === "inspect").length,
    0,
  );
  for (const options of [{ timeoutPs: true }, { timeoutInspect: true }]) {
    const hung = fixture(t, options);
    failed(hung.run());
    assert.equal(hung.read("current"), state());
  }
});

test("round 1: oversized prospective state is rejected before app recreation", (t) => {
  const f = fixture(t, {
    metadata: metadata.replace("v1.2.0", `v${"9".repeat(8000)}.2.0`),
  });
  failed(f.run());
  notMutated(f);
  assert.equal(f.read("current"), state());
  assert.equal(f.read("previous"), null);
  assert.ok(!readdirSync(f.data).some((name) => name.startsWith(".runtime.")));
});
