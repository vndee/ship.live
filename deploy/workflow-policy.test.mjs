import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const ci = read(".github/workflows/ci.yml");
const predecessorImage = `ghcr.io/vndee/ship.live@sha256:${"e".repeat(64)}`;
const release = () => read(".github/workflows/release.yml");
const publisher = () => {
  assert.ok(
    existsSync(new URL(".github/workflows/release-publish.yml", root)),
    "A trusted default-branch publisher must exist before release signals can grant publication",
  );
  return read(".github/workflows/release-publish.yml");
};

test("reviewed untrusted release signal requests read-only permissions and never executes repository code", () => {
  const source = release();
  assert.match(source, /on:\n  release:\n    types: \[published\]/);
  assert.match(source, /permissions:\n  contents: read/);
  assert.doesNotMatch(
    source,
    /packages:|environment:|secrets\.|login-action|skopeo|docker |\bssh\b|actions\/checkout|npm |node /,
    "The reviewed signal must not own privileged jobs or execute repository files; this is not a permission ceiling for other writer-authored workflows",
  );
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/);
});

test("trusted publisher receives only an exact-run artifact and owns the reviewed privileged jobs", () => {
  const source = publisher();
  assert.match(
    source,
    /on:\n  workflow_run:\n    workflows: \[Release\]\n    types: \[completed\]/,
  );
  assert.doesNotMatch(
    source,
    /^  (?:push|pull_request|release|workflow_dispatch):/m,
  );
  assert.match(source, /permissions:\n  contents: read/);
  const validate = job(source, "validate");
  assert.match(validate, /actions: read/);
  assert.match(validate, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(validate, /run-id: \$\{\{ github.event.workflow_run.id \}\}/);
  assert.match(validate, /github-token: \$\{\{ secrets.GITHUB_TOKEN \}\}/);
  assert.match(validate, /path: \$\{\{ runner.temp \}\}\/release-signal/);
  assert.doesNotMatch(validate, /cache:|actions\/cache/);
  assert.match(job(source, "publish"), /packages: write/);
  assert.match(job(source, "deploy"), /environment:\n      name: production/);
});

// Removing the trusted consumer's provenance/API checks must let these hostile
// fixtures emit outputs or execute policy code, causing the literal assertions
// below to fail. Git and the validator are real; only the external API is faked.
test("replaced release workflow cannot bypass trusted publisher validation or run replaced policy", (t) => {
  const source = publisher();
  const directory = mkdtempSync(join(tmpdir(), "release-workflow-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  mkdirSync(join(directory, ".github/workflows"), { recursive: true });
  mkdirSync(join(directory, "deploy"));
  writeFileSync(join(directory, ".github/workflows/release.yml"), release());
  writeFileSync(
    join(directory, ".github/workflows/release-publish.yml"),
    source,
  );
  writeFileSync(
    join(directory, "deploy/release-policy.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.POLICY_MARKER, 'trusted');\n" +
      read("deploy/release-policy.mjs"),
  );
  writeFileSync(join(directory, "package.json"), '{"version":"1.4.2"}');
  git("add", ".");
  git("commit", "-m", "trusted default branch");
  const trusted = git("rev-parse", "HEAD");
  git("tag", "-a", "v1.4.2", "-m", "stable");
  git("switch", "-c", "unmerged");
  const attack =
    "name: Release\non:\n  release:\n    types: [published]\npermissions:\n  packages: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo image=attacker >> $GITHUB_OUTPUT\n";
  writeFileSync(join(directory, ".github/workflows/release.yml"), attack);
  writeFileSync(
    join(directory, ".github/workflows/release-publish.yml"),
    attack,
  );
  writeFileSync(
    join(directory, "deploy/release-policy.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.ATTACKER_MARKER, 'ran'); console.log(JSON.stringify({tag:'v1.4.3',revision:process.env.RELEASE_SHA}));",
  );
  writeFileSync(join(directory, "package.json"), '{"version":"1.4.3"}');
  git("commit", "-am", "replace both workflows and policy");
  const unmerged = git("rev-parse", "HEAD");
  git("tag", "v1.4.3");
  git("remote", "add", "origin", directory);
  // Model workflow_run: YAML comes from main even when the triggering release
  // workflow and its artifact were replaced wholesale on the unmerged tag.
  const loaded =
    git("show", `${trusted}:.github/workflows/release-publish.yml`) + "\n";
  const validate = job(loaded, "validate");
  assert.match(validate, /ref: \$\{\{ github.workflow_sha \}\}/);
  const script = step(validate, "release")
    .split("        run: |\n")[1]
    .replace(/^          /gm, "");
  git("checkout", "--detach", trusted);
  const baseRecord = {
    tag_name: "v1.4.2",
    draft: false,
    prerelease: false,
    published_at: "2026-09-11T00:00:00Z",
    target_commitish: "main",
  };
  const cases = [
    { name: "unmerged replacement", tag: "v1.4.3\n", sha: unmerged },
    { name: "forged approved tag for unmerged head", sha: unmerged },
    { name: "unsuccessful producer", conclusion: "failure" },
    { name: "cancelled producer", conclusion: "cancelled" },
    { name: "non-release producer", event: "push" },
    { name: "multiple tag records", tag: "v1.4.2\nv1.4.3\n" },
    { name: "trailing blank record", tag: "v1.4.2\n\n" },
    { name: "NUL record", tag: "v1.4.2\0\n" },
    { name: "option injection", tag: "--upload-pack=evil\n" },
    { name: "prerelease tag", tag: "v1.4.2-rc.1\n" },
    { name: "leading zero", tag: "v01.4.2\n" },
    { name: "oversized record", tag: `v${"1".repeat(128)}.4.2\n` },
    { name: "extra artifact file", extra: true },
    { name: "symlink artifact", symlink: true },
    { name: "missing release", apiFailure: true },
    { name: "draft release", record: { draft: true } },
    { name: "prerelease record", record: { prerelease: true } },
    { name: "unpublished record", record: { published_at: null } },
    { name: "wrong API tag", record: { tag_name: "v1.4.3" } },
    { name: "invalid draft type", record: { draft: "false" } },
    {
      name: "mismatched target commit",
      record: { target_commitish: unmerged },
      policyRuns: true,
    },
    { name: "published merged release", success: true, policyRuns: true },
  ];
  for (const scenario of cases) {
    const temp = mkdtempSync(join(directory, "case-"));
    const artifact = join(temp, "release-signal");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "tag.txt"), scenario.tag ?? "v1.4.2\n");
    if (scenario.extra) writeFileSync(join(artifact, "extra"), "attacker");
    if (scenario.symlink) {
      rmSync(join(artifact, "tag.txt"));
      writeFileSync(join(temp, "outside"), "v1.4.2\n");
      symlinkSync(join(temp, "outside"), join(artifact, "tag.txt"));
    }
    const apiCalls = join(temp, "api-calls");
    writeFileSync(
      join(temp, "gh"),
      `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.API_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.env.API_FAILURE === 'true') process.exit(1);\nprocess.stdout.write(process.env.API_RECORD);\n`,
      { mode: 0o755 },
    );
    const output = join(temp, "outputs");
    const marker = join(temp, "policy-ran");
    const attackerMarker = join(temp, "attacker-ran");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: "",
        PATH: `${temp}${delimiter}${process.env.PATH}`,
        WORKFLOW_SHA: trusted,
        RELEASE_SHA: scenario.sha ?? trusted,
        SOURCE_EVENT: scenario.event ?? "release",
        SOURCE_CONCLUSION: scenario.conclusion ?? "success",
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "vndee/ship.live",
        POLICY_MARKER: marker,
        ATTACKER_MARKER: attackerMarker,
        API_CALLS: apiCalls,
        API_RECORD: JSON.stringify({ ...baseRecord, ...scenario.record }),
        API_FAILURE: String(scenario.apiFailure ?? false),
      },
    });
    assert.equal(
      result.status === 0,
      scenario.success ?? false,
      `${scenario.name}: ${result.stderr}`,
    );
    assert.equal(existsSync(attackerMarker), false, scenario.name);
    assert.equal(
      existsSync(marker),
      scenario.policyRuns ?? false,
      `${scenario.name}: policy execution boundary`,
    );
    const values = readFileSync(output, "utf8");
    if (scenario.success) {
      assert.equal(
        values,
        `tag=v1.4.2\nrevision=${trusted}\nprevious_tag=\nprevious_revision=\n`,
      );
      assert.deepEqual(JSON.parse(readFileSync(apiCalls, "utf8")), [
        "api",
        "--method",
        "GET",
        "repos/vndee/ship.live/releases/tags/v1.4.2",
      ]);
    } else
      assert.equal(
        values,
        "",
        `${scenario.name}: publication prerequisite must remain empty`,
      );
  }
});

function job(source, name) {
  const match = source.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|$(?![\\s\\S]))`,
      "m",
    ),
  );
  assert.ok(match, `Missing ${name} job`);
  return match[1];
}

function step(source, id) {
  const match = source.match(
    new RegExp(
      `^      - (?:name: [^\\n]+\\n        )?id: ${id}\\n([\\s\\S]*?)(?=^      - |$(?![\\s\\S]))`,
      "m",
    ),
  );
  assert.ok(match, `Missing ${id} step`);
  return match[1];
}

function runWorkflowStep(
  jobName,
  stepId,
  scenario = "missing",
  overrides = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "ship-live-workflow-"));
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: `sha256:${"b".repeat(64)}` },
    layers: [],
  });
  const expectedDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  const log = join(directory, "calls.jsonl");
  const output = join(directory, "output");
  const program = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const directory = process.env.RUNNER_TEMP;
const scenario = process.env.SCENARIO;
const manifest = fs.readFileSync(path.join(directory, 'fixture-manifest.json'), 'utf8');
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify([command, ...args]) + '\\n');
if (command === 'skopeo') {
  if (args[0] === 'manifest-digest') {
    console.log(args[1].endsWith('previous-manifest.json') ? 'sha256:' + (scenario === 'previous-invalid-digest' ? 'E' : 'e').repeat(64) : 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(args[1])).digest('hex'));
  } else if (args[0] === 'copy') {
    if (!args.includes('--preserve-digests')) process.exit(92);
    fs.writeFileSync(path.join(directory, 'copied'), 'yes');
  } else if (args[0] === 'inspect') {
    if (args.includes('--config')) {
      const previous = args.at(-1).endsWith('@sha256:' + 'e'.repeat(64));
      console.log(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: {
        'org.opencontainers.image.source': 'https://github.com/vndee/ship.live',
        'org.opencontainers.image.version': scenario === 'wrong-label' ? 'v9.0.0' : previous ? process.env.PREVIOUS_TAG : 'v1.2.3',
        'org.opencontainers.image.revision': previous ? scenario === 'previous-wrong-revision' ? 'f'.repeat(40) : process.env.PREVIOUS_REVISION : process.env.REVISION,
        'io.ship-live.schema-version': scenario === 'previous-invalid-schema' ? '18\\n' : '18',
        'io.ship-live.max-schema-version': scenario === 'previous-low-max' ? '17' : '19',
        'io.ship-live.tested-predecessor': scenario === 'wrong-predecessor' ? 'none' : process.env.TESTED_PREDECESSOR
      } } }));
    } else if (args.at(-1).endsWith(':' + process.env.PREVIOUS_TAG) && scenario !== 'previous-unpublished') {
      process.stdout.write(manifest);
    } else if (args.at(-1).startsWith('oci-archive:') || fs.existsSync(path.join(directory, 'copied')) || scenario === 'existing') {
      process.stdout.write(scenario === 'remote-mismatch' ? '{}' : manifest);
    } else if (scenario === 'version-conflict' || (scenario === 'sha-conflict' && args.at(-1).includes(':sha-'))) {
      process.stdout.write('{}');
    } else {
      console.error(scenario === 'registry-error' ? 'unauthorized: authentication required' : 'manifest unknown');
      process.exit(1);
    }
  } else process.exit(93);
} else if (command === 'docker') {
  if (args[0] === 'image' && args[1] === 'inspect') console.log(args.includes('{{.Id}}') ? 'sha256:' + 'b'.repeat(64) : 'linux/amd64');
  if (args[0] === 'pull' && scenario === 'previous-pull-failed') process.exit(1);
  if (args.includes('manifest') && scenario === 'anonymous-auth') {
    const config = args[args.indexOf('--config') + 1];
    if (process.env.DOCKER_AUTH_CONFIG !== undefined) process.exit(96);
    if (!fs.existsSync(path.join(config, 'config.json'))) process.exit(97);
    if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(config, 'config.json')))) !== '{"auths":{"ghcr.io":{}}}') process.exit(98);
    if ((fs.statSync(config).mode & 0o777) !== 0o700 || (fs.statSync(path.join(config, 'config.json')).mode & 0o777) !== 0o600) process.exit(99);
  }
  if (args.includes('manifest') && scenario === 'private-image') process.exit(1);
  if (args[0] === 'run' && scenario === 'current-migration-failed' && args.includes(process.env.LOCAL_IMAGE)) process.exit(1);
  if (args[0] === 'run' && scenario === 'previous-migration-failed' && args.includes(process.env.TESTED_PREDECESSOR)) process.exit(1);
  if (args[0] === 'run' && scenario === 'previous-probe-failed' && args.at(-1) === 'verify') process.exit(1);
} else if (command === 'git') {
  if (args[0] === 'rev-parse') console.log(scenario === 'moved-previous-tag' ? 'd'.repeat(40) : process.env.PREVIOUS_REVISION);
} else if (command === 'ssh') {
  for (const file of ['deploy_key', 'known_hosts']) {
    if ((fs.statSync(path.join(directory, file)).mode & 0o777) !== 0o600) process.exit(94);
  }
  if (scenario === 'ssh-failed') process.exit(23);
} else if (command === 'gh') {
  const route = args.find(arg => arg.startsWith('repos/'));
  const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
  fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify(['deployment-api', route, body]) + '\\n');
  if (route.endsWith('/deployments')) {
    if (scenario === 'deployment-api-failed') process.exit(1);
    console.log(JSON.stringify({id: 42, sha: scenario === 'deployment-wrong-sha' ? process.env.GITHUB_SHA : body.ref, ref: body.ref, environment: body.environment, payload: body.payload}));
  } else if (route.endsWith('/deployments/42/statuses')) {
    if (scenario === 'deployment-status-failed' && body.state === 'success') process.exit(1);
    console.log(JSON.stringify({id: 100, state: body.state}));
  } else process.exit(101);
} else process.exit(95);
`;
  try {
    for (const command of ["skopeo", "docker", "git", "ssh", "gh"])
      writeFileSync(join(directory, command), program, { mode: 0o755 });
    symlinkSync(process.execPath, join(directory, "node"));
    writeFileSync(join(directory, "local-manifest.json"), manifest);
    writeFileSync(join(directory, "fixture-manifest.json"), manifest);
    const script = step(job(publisher(), jobName), stepId)
      .split("        run: |\n")[1]
      ?.replace(/^          /gm, "");
    assert.ok(script, `Missing shell script for ${stepId}`);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: "",
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        SCENARIO: scenario,
        IMAGE_REPOSITORY: "ghcr.io/vndee/ship.live",
        VERSION: "v1.2.3",
        REVISION: "a".repeat(40),
        GITHUB_SHA: "b".repeat(40),
        GITHUB_REPOSITORY: "vndee/ship.live",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "12345",
        PREVIOUS_TAG: "v1.2.2",
        PREVIOUS_REVISION: "c".repeat(40),
        TESTED_PREDECESSOR: predecessorImage,
        LOCAL_IMAGE: "ship-live-release:fixture",
        PRODUCTION_DEPLOY_ENABLED: "true",
        DATABASE_URL: "postgres://fixture",
        APP_IMAGE: `ghcr.io/vndee/ship.live@${expectedDigest}`,
        DEPLOY_HOST: "ship.example.test",
        DEPLOY_USER: "ship_live",
        DEPLOY_SSH_KEY: "fixture-key",
        DEPLOY_KNOWN_HOSTS: "fixture-host-key",
        ...overrides,
      },
    });
    return {
      ...result,
      expectedDigest,
      calls: existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
      keyRemoved: !existsSync(join(directory, "deploy_key")),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("deployment provenance records the validated release SHA and digest when consumer main has advanced", () => {
  const result = runWorkflowStep("deploy", "deploy");
  assert.equal(result.status, 0, result.stderr);
  const requests = result.calls.filter((call) => call[0] === "deployment-api");
  assert.equal(
    requests.length,
    3,
    "Deployment creation plus in_progress and success must be recorded explicitly",
  );
  assert.deepEqual(requests[0], [
    "deployment-api",
    "repos/vndee/ship.live/deployments",
    {
      ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      auto_merge: false,
      required_contexts: [],
      environment: "production",
      production_environment: true,
      payload: {
        image: `ghcr.io/vndee/ship.live@${result.expectedDigest}`,
        tag: "v1.2.3",
      },
    },
  ]);
  assert.deepEqual(
    requests.slice(1).map((call) => [call[1], call[2].state]),
    [
      ["repos/vndee/ship.live/deployments/42/statuses", "in_progress"],
      ["repos/vndee/ship.live/deployments/42/statuses", "success"],
    ],
  );
  assert.ok(
    result.calls.findIndex((call) => call[0] === "ssh") >
      result.calls.findIndex(
        (call) =>
          call[0] === "deployment-api" && call[2].state === "in_progress",
      ),
  );
  assert.ok(
    result.calls.findIndex((call) => call[0] === "ssh") <
      result.calls.findIndex(
        (call) => call[0] === "deployment-api" && call[2].state === "success",
      ),
  );
  const deploy = job(publisher(), "deploy");
  assert.match(
    deploy,
    /environment:\n      name: production\n      deployment: false/,
  );
  assert.match(
    deploy,
    /REVISION: \$\{\{ needs\.validate\.outputs\.revision \}\}/,
  );
  assert.match(deploy, /VERSION: \$\{\{ needs\.validate\.outputs\.tag \}\}/);
  assert.match(deploy, /deployments: write/);
});

test("deployment provenance records SSH failure without claiming success", () => {
  const result = runWorkflowStep("deploy", "deploy", "ssh-failed");
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(
    result.calls
      .filter(
        (call) => call[0] === "deployment-api" && call[1].endsWith("/statuses"),
      )
      .map((call) => call[2].state),
    ["in_progress", "failure"],
  );
  assert.equal(result.keyRemoved, true);
});

test("deployment provenance API errors or wrong returned SHA fail before SSH and status errors fail the job", () => {
  for (const scenario of [
    "deployment-api-failed",
    "deployment-wrong-sha",
    "deployment-status-failed",
  ]) {
    const result = runWorkflowStep("deploy", "deploy", scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(
      result.calls.some((call) => call[0] === "ssh"),
      scenario === "deployment-status-failed",
      scenario,
    );
    assert.equal(result.keyRemoved, true);
  }
});

test("publication refuses conflicting version or SHA tags and registry errors before either write", () => {
  for (const scenario of [
    "version-conflict",
    "sha-conflict",
    "registry-error",
  ]) {
    const result = runWorkflowStep("publish", "publish", scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(
      result.calls.filter((call) => call[1] === "copy").length,
      0,
      scenario,
    );
    assert.equal(result.output, "", scenario);
  }
});

test("publication of absent or identical tags returns only the verified digest", () => {
  for (const scenario of ["missing", "existing"]) {
    const result = runWorkflowStep("publish", "publish", scenario);
    assert.equal(result.status, 0, result.stderr);
    const copies = result.calls.filter((call) => call[1] === "copy");
    assert.deepEqual(
      copies.map((call) => call.at(-1)),
      [
        "docker://ghcr.io/vndee/ship.live:v1.2.3",
        `docker://ghcr.io/vndee/ship.live:sha-${"a".repeat(40)}`,
      ],
    );
    assert.equal(
      result.output,
      `image=ghcr.io/vndee/ship.live@${result.expectedDigest}\n`,
    );
  }
});

test("a changed remote manifest or incorrect release labels never produce deploy output", () => {
  for (const scenario of [
    "remote-mismatch",
    "wrong-label",
    "wrong-predecessor",
  ]) {
    const result = runWorkflowStep("publish", "publish", scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(result.output, "", scenario);
  }
});

test("first-release compatibility allows only deployment-disabled bootstrap", () => {
  for (const enabled of ["true", "false", ""]) {
    const result = runWorkflowStep("publish", "compatibility", "missing", {
      PREVIOUS_TAG: "",
      PREVIOUS_REVISION: "",
      TESTED_PREDECESSOR: "none",
      PRODUCTION_DEPLOY_ENABLED: enabled,
    });
    assert.equal(result.status, enabled === "true" ? 1 : 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.match(
      result.stdout,
      /first stable release: no previous image compatibility target/,
    );
  }
});

// A rebuilt source tag may differ from the shipped image. Operational probes
// must execute precisely the digest that the candidate advertises for rollback.
test("tested predecessor compatibility executes immutable published bytes without a previous build", () => {
  const result = runWorkflowStep("publish", "compatibility");
  assert.equal(result.status, 0, result.stderr);
  const runs = result.calls.filter((c) => c[0] === "docker" && c[1] === "run");
  assert.equal(runs.length, 3);
  assert.ok(runs[0].includes(predecessorImage));
  assert.ok(runs[2].includes(predecessorImage));
  assert.equal(
    result.calls.some((c) => c.includes("build") || c.includes("worktree")),
    false,
  );
});

test("tested predecessor is resolved and label-validated before the one current build", () => {
  const resolution = runWorkflowStep("publish", "predecessor");
  assert.equal(resolution.status, 0, resolution.stderr);
  assert.equal(resolution.output, `image=${predecessorImage}\n`);
  assert.ok(
    resolution.calls.some(
      (c) =>
        c.includes("--config") && c.at(-1) === `docker://${predecessorImage}`,
    ),
  );
  assert.ok(
    resolution.calls.some(
      (c) => c[0] === "docker" && c[1] === "pull" && c[2] === predecessorImage,
    ),
  );
  for (const scenario of [
    "previous-unpublished",
    "previous-wrong-revision",
    "previous-invalid-schema",
    "previous-invalid-digest",
    "previous-low-max",
    "moved-previous-tag",
    "wrong-label",
  ]) {
    const rejected = runWorkflowStep("publish", "predecessor", scenario);
    assert.notEqual(rejected.status, 0, scenario);
    assert.equal(rejected.output, "", scenario);
    assert.equal(
      rejected.calls.some((c) => c[0] === "docker"),
      false,
      scenario,
    );
  }
  const build = runWorkflowStep("publish", "build");
  assert.equal(build.status, 0, build.stderr + JSON.stringify(build.calls));
  const builds = build.calls.filter(
    (c) => c[0] === "docker" && c[2] === "build",
  );
  assert.equal(builds.length, 1);
  assert.ok(builds[0].includes(`TESTED_PREDECESSOR=${predecessorImage}`));
});

test("tested predecessor resolution permits only a consistent deployment-disabled first release", () => {
  const good = {
    PREVIOUS_TAG: "",
    PREVIOUS_REVISION: "",
    PRODUCTION_DEPLOY_ENABLED: "false",
  };
  const result = runWorkflowStep("publish", "predecessor", "missing", good);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "image=none\n");
  assert.deepEqual(result.calls, []);
  for (const overrides of [
    { ...good, PRODUCTION_DEPLOY_ENABLED: "true" },
    { ...good, PREVIOUS_REVISION: "c".repeat(40) },
  ]) {
    const bad = runWorkflowStep("publish", "predecessor", "missing", overrides);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.output, "");
    assert.deepEqual(bad.calls, []);
  }
  const pullFailure = runWorkflowStep(
    "publish",
    "predecessor",
    "previous-pull-failed",
  );
  assert.notEqual(pullFailure.status, 0);
  assert.equal(pullFailure.output, "");
});

test("compatibility seeds previous data, migrates current, then probes previous operations", () => {
  for (const scenario of [
    "missing",
    "current-migration-failed",
    "previous-migration-failed",
    "previous-probe-failed",
  ]) {
    const result = runWorkflowStep("publish", "compatibility", scenario);
    assert.equal(result.status, scenario === "missing" ? 0 : 1, result.stderr);
    const migrations = result.calls.filter(
      (call) => call[0] === "docker" && call[1] === "run",
    );
    assert.equal(
      migrations.length,
      scenario === "previous-migration-failed"
        ? 1
        : scenario === "current-migration-failed"
          ? 2
          : 3,
    );
    assert.ok(migrations[0].includes(predecessorImage));
    assert.equal(migrations[0].at(-1), "seed");
    if (migrations.length >= 2)
      assert.ok(migrations[1].includes("ship-live-release:fixture"));
    if (migrations.length === 3) {
      assert.ok(migrations[2].includes(predecessorImage));
      assert.equal(migrations[2].at(-1), "verify");
      assert.ok(
        migrations[2].some((arg) =>
          arg.endsWith(
            "/deploy/previous-store-probe.mjs,target=/app/previous-store-probe.mjs,readonly",
          ),
        ),
      );
    }
  }
});

test("compatibility refuses a previous tag moved after release validation", () => {
  const result = runWorkflowStep(
    "publish",
    "predecessor",
    "moved-previous-tag",
  );
  assert.notEqual(result.status, 0);
  assert.equal(
    result.calls.some((call) => call[0] === "docker"),
    false,
  );
});

test("forced SSH receives exactly one immutable digest and removes mode-0600 credentials", () => {
  const result = runWorkflowStep("deploy", "deploy");
  assert.equal(result.status, 0, result.stderr);
  const ssh = result.calls.find((call) => call[0] === "ssh");
  assert.deepEqual(ssh.slice(-2), [
    "ship_live@ship.example.test",
    `ghcr.io/vndee/ship.live@${result.expectedDigest}`,
  ]);
  assert.equal(result.keyRemoved, true);
});

test("invalid deployment references and private images never reach SSH", () => {
  for (const [scenario, overrides] of [
    ["private-image", {}],
    ["missing", { APP_IMAGE: "ghcr.io/vndee/ship.live:v1.2.3" }],
    [
      "missing",
      { APP_IMAGE: `ghcr.io/vndee/ship.live@sha256:${"a".repeat(64)}\nid` },
    ],
    ["missing", { DEPLOY_HOST: "-oProxyCommand=bad" }],
  ]) {
    const result = runWorkflowStep("deploy", "deploy", scenario, overrides);
    assert.notEqual(
      result.status,
      0,
      JSON.stringify({ scenario, overrides, calls: result.calls }),
    );
    assert.equal(
      result.calls.some((call) => call[0] === "ssh"),
      false,
    );
  }
});

test("ordinary pushes and pull requests run deployment policy with read-only credentials", () => {
  assert.match(ci, /on:\n  push:\n  pull_request:/);
  assert.match(ci, /permissions:\n  contents: read/);
  assert.doesNotMatch(
    ci,
    /packages:\s*write|environment:|secrets\.|docker\/login-action/,
  );
  assert.match(job(ci, "checks"), /npm run test:deploy-policy/);
  const runtimeImage = job(ci, "runtime-image");
  assert.match(runtimeImage, /- run: npm ci/);
  assert.ok(
    runtimeImage.indexOf("npm ci") <
      runtimeImage.indexOf("npm run test:docker"),
    "Runtime image CI must install locked dependencies before the smoke test",
  );
});

test("production publishing is exclusively a stable published release with serialized runs", () => {
  const source = publisher();
  assert.match(release(), /on:\n  release:\n    types: \[published\]/);
  assert.match(
    source,
    /on:\n  workflow_run:\n    workflows: \[Release\]\n    types: \[completed\]/,
  );
  assert.doesNotMatch(
    source,
    /^  (?:push|pull_request|workflow_dispatch|release):/m,
  );
  assert.match(source, /permissions:\n  contents: read/);
  assert.match(
    source,
    /concurrency:\n  group: production\n  cancel-in-progress: false/,
  );
  assert.match(
    job(release(), "signal"),
    /!github\.event\.release\.draft && !github\.event\.release\.prerelease/,
  );
  assert.match(
    job(source, "validate"),
    /github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.event == 'release'/,
  );
});

test("every action in CI, signal, and publisher is pinned to a full lowercase commit", () => {
  for (const source of [ci, release(), publisher()]) {
    const actions = [...source.matchAll(/\buses:\s*([^\s#]+)/g)];
    assert.ok(actions.length > 0);
    for (const [, action] of actions)
      assert.match(action, /^[\w./-]+@[0-9a-f]{40}$/);
    assert.doesNotMatch(source, /persist-credentials:\s*true/);
  }
});

test("production concurrency retains pending releases instead of replacing them", () => {
  const concurrency = publisher().match(/^concurrency:\n(?:  .+\n)+/m)?.[0];
  assert.ok(concurrency, "Missing workflow-level production concurrency");
  assert.match(concurrency, /^  group: production$/m);
  assert.match(concurrency, /^  cancel-in-progress: false$/m);
  assert.match(concurrency, /^  queue: max$/m);
});

test("validation binds the event tag using trusted workflow code and main ancestry", () => {
  const validate = job(publisher(), "validate");
  assert.match(validate, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(validate, /^\s*(?:- run: )?npm\s|node-version-file:/m);
  assert.match(validate, /fetch-depth: 0/);
  assert.match(
    validate,
    /git fetch --force origin '\+refs\/heads\/main:refs\/remotes\/origin\/main' --tags/,
  );
  assert.match(
    validate,
    /RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.match(validate, /node deploy\/release-policy\.mjs/);
  for (const argument of [
    "--tag",
    "--target",
    "--release-sha",
    "--main-ref",
    "--package-version",
  ])
    assert.ok(validate.includes(argument), `Missing ${argument}`);
  assert.match(validate, /--main-ref origin\/main/);
  assert.match(
    validate,
    /previous_tag: \$\{\{ steps\.release\.outputs\.previous_tag \}\}/,
  );
});

test("a replaced validator on an unmerged tag cannot pass the publication prerequisite", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "release-provenance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  mkdirSync(join(directory, "deploy"));
  writeFileSync(
    join(directory, "deploy/release-policy.mjs"),
    read("deploy/release-policy.mjs"),
  );
  writeFileSync(join(directory, "package.json"), '{"version":"1.4.2"}');
  git("add", ".");
  git("commit", "-m", "trusted release");
  const tagged = git("rev-parse", "HEAD");
  git("tag", "v1.4.2");
  writeFileSync(join(directory, "package.json"), '{"version":"1.4.3"}');
  git("commit", "-am", "main advances");
  const trusted = git("rev-parse", "HEAD");
  git("switch", "-c", "unmerged");
  writeFileSync(
    join(directory, "deploy/release-policy.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('attacker-ran', 'yes'); console.log(JSON.stringify({tag:'v1.4.3',revision:process.env.RELEASE_SHA}));",
  );
  git("commit", "-am", "replace validator");
  const unmerged = git("rev-parse", "HEAD");
  git("tag", "v1.4.3");
  git("remote", "add", "origin", directory);
  const validate = job(publisher(), "validate");
  const script = step(validate, "release")
    .split("        run: |\n")[1]
    .replace(/^          /gm, "");
  const apiBin = join(directory, "api-bin");
  mkdirSync(apiBin);
  writeFileSync(
    join(apiBin, "gh"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({tag_name:process.env.RELEASE_TAG,draft:false,prerelease:false,published_at:'2026-09-11T00:00:00Z',target_commitish:'main'}));\n`,
    { mode: 0o755 },
  );
  mkdirSync(join(directory, "release-signal"));
  for (const [tag, revision, workflowSha, success] of [
    ["v1.4.3", unmerged, trusted, false],
    ["v1.4.3", unmerged, unmerged, false],
    ["v1.4.2", tagged, trusted, true],
  ]) {
    git(
      "checkout",
      "--detach",
      validate.includes("ref: ${{ github.workflow_sha }}") ? workflowSha : tag,
    );
    const output = join(directory, "outputs");
    writeFileSync(output, "");
    writeFileSync(join(directory, "release-signal/tag.txt"), `${tag}\n`);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${apiBin}${delimiter}${process.env.PATH}`,
        SOURCE_EVENT: "release",
        SOURCE_CONCLUSION: "success",
        GITHUB_REPOSITORY: "vndee/ship.live",
        WORKFLOW_SHA: workflowSha,
        RELEASE_TAG: tag,
        RELEASE_SHA: revision,
        RELEASE_TARGET: "main",
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status === 0, success, `${tag}: ${result.stderr}`);
    assert.equal(existsSync(join(directory, "attacker-ran")), false);
    const values = readFileSync(output, "utf8");
    if (success) assert.match(values, new RegExp(`revision=${tagged}`));
    else
      assert.equal(
        values,
        "",
        "A failed prerequisite must not grant publication outputs",
      );
  }
});

test("anonymous image check cannot inherit registry credentials or credential helpers", () => {
  const result = runWorkflowStep("deploy", "deploy", "anonymous-auth", {
    DOCKER_AUTH_CONFIG: '{"auths":{"ghcr.io":{"auth":"synthetic"}}}',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some((call) => call[0] === "ssh"));
});

test("all checks use the validated SHA and block publishing and deployment", () => {
  const source = publisher();
  for (const name of ["checks", "browser", "publish"]) {
    assert.match(
      job(source, name),
      /ref: \$\{\{ needs\.validate\.outputs\.revision \}\}/,
    );
  }
  for (const command of [
    "format:check",
    "test:deploy-policy",
    "test:db",
    "build",
  ])
    assert.ok(job(source, "checks").includes(`npm run ${command}`));
  assert.match(job(source, "browser"), /npm run test:browser/);
  assert.match(job(source, "checks"), /needs: validate/);
  assert.match(job(source, "browser"), /needs: validate/);
  assert.match(job(source, "publish"), /needs: \[validate, checks, browser\]/);
  assert.match(
    job(source, "deploy"),
    /needs: \[validate, checks, browser, publish\]/,
  );
  assert.doesNotMatch(
    source,
    /continue-on-error:|if:\s*\$\{\{\s*always\(\)\s*\}\}/,
  );
});

test("package writes and production secrets are isolated to their respective jobs", () => {
  const source = publisher();
  assert.equal((source.match(/packages:\s*write/g) ?? []).length, 1);
  assert.match(
    job(source, "publish"),
    /permissions:\n      contents: read\n      packages: write/,
  );
  assert.match(job(source, "publish"), /username: \$\{\{ github\.actor \}\}/);
  assert.match(
    job(source, "publish"),
    /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
  );
  assert.equal((source.match(/^    environment:/gm) ?? []).length, 1);
  assert.match(
    job(source, "deploy"),
    /environment:\n      name: production\n      deployment: false/,
  );
  assert.equal((source.match(/deployments:\s*write/g) ?? []).length, 1);
  for (const name of ["validate", "checks", "browser", "publish"])
    assert.doesNotMatch(
      job(source, name),
      /DEPLOY_SSH_KEY|DEPLOY_KNOWN_HOSTS|environment:/,
    );
  assert.doesNotMatch(
    job(source, "deploy"),
    /packages:\s*write|actions\/checkout/,
  );
});

test("the one current build is loaded, smoke-tested, then compatibility-tested before publication", () => {
  const publish = job(publisher(), "publish");
  assert.equal(
    (publish.match(/docker buildx build/g) ?? []).length,
    1,
    "Only the current image is built; the published predecessor must be used by digest",
  );
  const build = step(publish, "build");
  assert.match(build, /--platform linux\/amd64/);
  assert.match(build, /--target runtime/);
  assert.match(build, /--load/);
  assert.match(
    build,
    /--output "type=oci,dest=\$RUNNER_TEMP\/release-image.tar"/,
  );
  assert.match(build, /node --import tsx deploy\/image-metadata\.mjs/);
  for (const argument of [
    "RELEASE_VERSION",
    "VCS_REVISION",
    "SCHEMA_VERSION",
    "MAX_SCHEMA_VERSION",
    "TESTED_PREDECESSOR",
  ])
    assert.ok(build.includes(`--build-arg "${argument}=`));
  assert.match(
    step(publish, "smoke"),
    /SHIP_LIVE_TEST_IMAGE="\$LOCAL_IMAGE" npm run test:docker/,
  );
  const ids = ["predecessor", "build", "smoke", "compatibility", "publish"].map(
    (id) => publish.indexOf(`id: ${id}\n`),
  );
  assert.ok(
    ids.every((offset, index) => index === 0 || offset > ids[index - 1]),
  );
  for (const id of [
    "predecessor",
    "build",
    "smoke",
    "compatibility",
    "publish",
  ])
    assert.doesNotMatch(step(publish, id), /^        if:/m);
  for (const id of ["build", "compatibility", "publish"])
    assert.match(
      step(publish, id),
      /TESTED_PREDECESSOR: \$\{\{ steps.predecessor.outputs.image \}\}/,
    );
  assert.match(
    step(publish, "smoke"),
    /SHIP_LIVE_TEST_PREDECESSOR: \$\{\{ steps.predecessor.outputs.image \}\}/,
  );
  assert.doesNotMatch(
    publish.slice(0, ids[4]),
    /docker push|skopeo copy[^\n]*docker:\/\//,
  );
});

test("the exact published predecessor opens the new schema, with fail-closed bootstrap", () => {
  const publish = job(publisher(), "publish");
  assert.match(publish, /POSTGRES_DB: ship_live_compatibility/);
  const compatibility = step(publish, "compatibility");
  assert.match(
    compatibility,
    /first stable release: no previous image compatibility target/,
  );
  assert.match(
    compatibility,
    /\[\[ "\$PRODUCTION_DEPLOY_ENABLED" != true \]\]/,
  );
  assert.match(compatibility, /previous_image="\$TESTED_PREDECESSOR"/);
  assert.doesNotMatch(compatibility, /git worktree|docker build/);
  assert.match(
    compatibility,
    /docker run --rm --network host -e DATABASE_URL "\$LOCAL_IMAGE" npm run db:migrate/,
  );
  assert.match(
    compatibility,
    /"\$previous_image" --import tsx \/app\/previous-store-probe.mjs verify/,
  );
  assert.ok(
    compatibility.indexOf('"$LOCAL_IMAGE" npm run db:migrate') <
      compatibility.indexOf(
        '"$previous_image" --import tsx /app/previous-store-probe.mjs verify',
      ),
  );
});

test("both immutable tags are checked before digest-preserving publication", () => {
  const publish = step(job(publisher(), "publish"), "publish");
  assert.match(publish, /for tag in "\$VERSION" "sha-\$REVISION"/);
  assert.match(publish, /existing_digest.*!=.*expected_digest/);
  assert.match(publish, /MANIFEST_UNKNOWN\|NAME_UNKNOWN/);
  assert.match(publish, /skopeo copy --preserve-digests/);
  assert.ok(
    publish.indexOf("existing_digest") < publish.indexOf("skopeo copy"),
  );
  assert.match(
    publish,
    /skopeo inspect .*--raw.*docker:\/\/\$IMAGE_REPOSITORY@\$expected_digest/,
  );
  assert.match(
    publish,
    /cmp "\$RUNNER_TEMP\/local-manifest.json" "\$RUNNER_TEMP\/remote-manifest.json"/,
  );
  assert.match(publish, /image=\$IMAGE_REPOSITORY@\$expected_digest/);
  assert.doesNotMatch(publish, /\|\| true|:latest/);
});

test("deployment checks anonymous registry access before opening the forced SSH session", () => {
  const deploy = job(publisher(), "deploy");
  assert.match(
    deploy,
    /if: \$\{\{ vars\.PRODUCTION_DEPLOY_ENABLED == 'true' \}\}/,
  );
  assert.match(deploy, /APP_IMAGE: \$\{\{ needs\.publish\.outputs\.image \}\}/);
  const handoff = step(deploy, "deploy");
  assert.match(
    handoff,
    /\^ghcr\\\.io\/vndee\/ship\\\.live@sha256:\[0-9a-f\]\{64\}\$/,
  );
  assert.match(
    handoff,
    /docker --config "\$anonymous_config" manifest inspect "\$APP_IMAGE"/,
  );
  assert.ok(handoff.indexOf("manifest inspect") < handoff.indexOf("ssh -T"));
  for (const option of [
    "BatchMode=yes",
    "IdentitiesOnly=yes",
    "StrictHostKeyChecking=yes",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
  ])
    assert.ok(handoff.includes(option), `Missing SSH ${option}`);
  assert.match(
    handoff,
    /chmod 0600 "\$RUNNER_TEMP\/deploy_key" "\$RUNNER_TEMP\/known_hosts"/,
  );
  assert.match(handoff, /"\$DEPLOY_USER@\$DEPLOY_HOST" "\$APP_IMAGE"\s*$/);
  assert.doesNotMatch(
    publisher(),
    /StrictHostKeyChecking=no|ssh-keyscan|\bscp\b|\brsync\b|\.env\.production|upload-artifact/,
  );
});

test("deployment test scripts preserve existing interfaces and exclude runtime builds from policy CI", () => {
  const { scripts } = JSON.parse(read("package.json"));
  assert.equal(
    scripts["test:workflow-policy"],
    "node --test deploy/workflow-policy.test.mjs",
  );
  assert.match(
    scripts["test:deploy-policy"] ?? "",
    /image-metadata\.test\.mjs/,
  );
  assert.match(
    scripts["test:deploy-policy"] ?? "",
    /release-policy\.test\.mjs/,
  );
  assert.match(
    scripts["test:deploy-policy"] ?? "",
    /ship-live-deploy\.test\.mjs/,
  );
  assert.match(
    scripts["test:deploy-policy"] ?? "",
    /workflow-policy\.test\.mjs/,
  );
  assert.doesNotMatch(
    scripts["test:deploy-policy"] ?? "",
    /runtime-image\.test\.mjs|compose-external\.test\.mjs/,
  );
  assert.equal(
    scripts["test:deploy"],
    "npm run test:deploy-policy && npm run test:compose-external",
  );
  assert.equal(
    scripts["test:docker"],
    "node --import tsx --test deploy/runtime-image.test.mjs deploy/runtime-image-prebuilt.test.mjs",
  );
});
