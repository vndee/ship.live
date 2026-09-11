import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const ci = read(".github/workflows/ci.yml");
const release = () => read(".github/workflows/release.yml");

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
const manifest = fs.readFileSync(path.join(directory, 'local-manifest.json'), 'utf8');
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify([command, ...args]) + '\\n');
if (command === 'skopeo') {
  if (args[0] === 'manifest-digest') {
    console.log('sha256:' + crypto.createHash('sha256').update(fs.readFileSync(args[1])).digest('hex'));
  } else if (args[0] === 'copy') {
    if (!args.includes('--preserve-digests')) process.exit(92);
    fs.writeFileSync(path.join(directory, 'copied'), 'yes');
  } else if (args[0] === 'inspect') {
    if (args.includes('--config')) {
      console.log(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: {
        'org.opencontainers.image.source': 'https://github.com/vndee/ship.live',
        'org.opencontainers.image.version': scenario === 'wrong-label' ? 'v9.0.0' : 'v1.2.3',
        'org.opencontainers.image.revision': process.env.REVISION
      } } }));
    } else if (fs.existsSync(path.join(directory, 'copied')) || scenario === 'existing') {
      process.stdout.write(scenario === 'remote-mismatch' ? '{}' : manifest);
    } else if (scenario === 'version-conflict' || (scenario === 'sha-conflict' && args.at(-1).includes(':sha-'))) {
      process.stdout.write('{}');
    } else {
      console.error(scenario === 'registry-error' ? 'unauthorized: authentication required' : 'manifest unknown');
      process.exit(1);
    }
  } else process.exit(93);
} else if (command === 'docker') {
  if (args.includes('manifest') && scenario === 'private-image') process.exit(1);
  if (args[0] === 'run' && scenario === 'current-migration-failed' && args.includes(process.env.LOCAL_IMAGE)) process.exit(1);
  if (args[0] === 'run' && scenario === 'previous-migration-failed' && args.some(arg => arg.startsWith('ship-live-previous:'))) process.exit(1);
} else if (command === 'git') {
  if (args[0] === 'rev-parse') console.log(scenario === 'moved-previous-tag' ? 'd'.repeat(40) : process.env.PREVIOUS_REVISION);
} else if (command === 'ssh') {
  for (const file of ['deploy_key', 'known_hosts']) {
    if ((fs.statSync(path.join(directory, file)).mode & 0o777) !== 0o600) process.exit(94);
  }
} else process.exit(95);
`;
  try {
    for (const command of ["skopeo", "docker", "git", "ssh"])
      writeFileSync(join(directory, command), program, { mode: 0o755 });
    writeFileSync(join(directory, "local-manifest.json"), manifest);
    const script = step(job(release(), jobName), stepId)
      .split("        run: |\n")[1]
      ?.replace(/^          /gm, "");
    assert.ok(script, `Missing shell script for ${stepId}`);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        SCENARIO: scenario,
        IMAGE_REPOSITORY: "ghcr.io/vndee/ship.live",
        VERSION: "v1.2.3",
        REVISION: "a".repeat(40),
        PREVIOUS_TAG: "v1.2.2",
        PREVIOUS_REVISION: "c".repeat(40),
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
  for (const scenario of ["remote-mismatch", "wrong-label"]) {
    const result = runWorkflowStep("publish", "publish", scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(result.output, "", scenario);
  }
});

test("first-release compatibility allows only deployment-disabled bootstrap", () => {
  for (const enabled of ["true", "false", ""]) {
    const result = runWorkflowStep("publish", "compatibility", "missing", {
      PREVIOUS_TAG: "",
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

test("compatibility runs new then previous migrations and propagates either failure", () => {
  for (const scenario of [
    "missing",
    "current-migration-failed",
    "previous-migration-failed",
  ]) {
    const result = runWorkflowStep("publish", "compatibility", scenario);
    assert.equal(result.status, scenario === "missing" ? 0 : 1, result.stderr);
    const migrations = result.calls.filter(
      (call) => call[0] === "docker" && call[1] === "run",
    );
    assert.equal(
      migrations.length,
      scenario === "current-migration-failed" ? 1 : 2,
    );
    assert.ok(migrations[0].includes("ship-live-release:fixture"));
    if (migrations.length === 2)
      assert.ok(migrations[1].includes(`ship-live-previous:${"a".repeat(40)}`));
  }
});

test("compatibility refuses a previous tag moved after release validation", () => {
  const result = runWorkflowStep(
    "publish",
    "compatibility",
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
});

test("production publishing is exclusively a stable published release with serialized runs", () => {
  const source = release();
  assert.match(source, /on:\n  release:\n    types: \[published\]/);
  assert.doesNotMatch(
    source,
    /^  (?:push|pull_request|workflow_dispatch|workflow_run):/m,
  );
  assert.match(source, /permissions:\n  contents: read/);
  assert.match(
    source,
    /concurrency:\n  group: production\n  cancel-in-progress: false/,
  );
  assert.match(
    job(source, "validate"),
    /!github\.event\.release\.draft && !github\.event\.release\.prerelease/,
  );
});

test("every action in both workflows is pinned to a full lowercase commit", () => {
  for (const source of [ci, release()]) {
    const actions = [...source.matchAll(/\buses:\s*([^\s#]+)/g)];
    assert.ok(actions.length > 0);
    for (const [, action] of actions)
      assert.match(action, /^[\w./-]+@[0-9a-f]{40}$/);
    assert.doesNotMatch(source, /persist-credentials:\s*true/);
  }
});

test("production concurrency retains pending releases instead of replacing them", () => {
  const concurrency = release().match(/^concurrency:\n(?:  .+\n)+/m)?.[0];
  assert.ok(concurrency, "Missing workflow-level production concurrency");
  assert.match(concurrency, /^  group: production$/m);
  assert.match(concurrency, /^  cancel-in-progress: false$/m);
  assert.match(concurrency, /^  queue: max$/m);
});

test("validation binds the event commit to the checked-out tag and main ancestry", () => {
  const validate = job(release(), "validate");
  assert.match(validate, /ref: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(validate, /fetch-depth: 0/);
  assert.match(
    validate,
    /git fetch --force origin '\+refs\/heads\/main:refs\/remotes\/origin\/main' --tags/,
  );
  assert.match(validate, /RELEASE_SHA: \$\{\{ github\.sha \}\}/);
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

test("all checks use the validated SHA and block publishing and deployment", () => {
  const source = release();
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
  assert.match(job(source, "deploy"), /needs: \[checks, browser, publish\]/);
  assert.doesNotMatch(
    source,
    /continue-on-error:|if:\s*\$\{\{\s*always\(\)\s*\}\}/,
  );
});

test("package writes and production secrets are isolated to their respective jobs", () => {
  const source = release();
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
  assert.equal((source.match(/environment:\s*production/g) ?? []).length, 1);
  assert.match(job(source, "deploy"), /environment: production/);
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
  const publish = job(release(), "publish");
  assert.equal(
    (publish.match(/docker buildx build/g) ?? []).length,
    2,
    "Only the current and previous runtime builds are allowed",
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
  ])
    assert.ok(build.includes(`--build-arg "${argument}=`));
  assert.match(
    step(publish, "smoke"),
    /SHIP_LIVE_TEST_IMAGE="\$LOCAL_IMAGE" npm run test:docker/,
  );
  const ids = ["build", "smoke", "compatibility", "publish"].map((id) =>
    publish.indexOf(`id: ${id}\n`),
  );
  assert.ok(
    ids.every((offset, index) => index === 0 || offset > ids[index - 1]),
  );
  for (const id of ["build", "smoke", "compatibility", "publish"])
    assert.doesNotMatch(step(publish, id), /^        if:/m);
  assert.doesNotMatch(
    publish.slice(0, ids[3]),
    /docker push|skopeo copy[^\n]*docker:\/\//,
  );
});

test("the exact previous tag opens the new schema, with fail-closed bootstrap", () => {
  const publish = job(release(), "publish");
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
  assert.match(
    compatibility,
    /git worktree add --detach "\$previous_source" "refs\/tags\/\$PREVIOUS_TAG"/,
  );
  assert.match(
    compatibility,
    /docker buildx build --load --platform linux\/amd64 --target runtime/,
  );
  assert.match(
    compatibility,
    /docker run --rm --network host -e DATABASE_URL "\$LOCAL_IMAGE" npm run db:migrate/,
  );
  assert.match(
    compatibility,
    /docker run --rm --network host -e DATABASE_URL "\$previous_image" npm run db:migrate/,
  );
  assert.ok(
    compatibility.indexOf('"$LOCAL_IMAGE" npm run db:migrate') <
      compatibility.indexOf('"$previous_image" npm run db:migrate'),
  );
});

test("both immutable tags are checked before digest-preserving publication", () => {
  const publish = step(job(release(), "publish"), "publish");
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
  const deploy = job(release(), "deploy");
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
    release(),
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
