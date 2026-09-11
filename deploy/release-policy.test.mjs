import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateRelease } from "./release-policy.mjs";

const sha = "a".repeat(40);
const policyPath = fileURLToPath(
  new URL("./release-policy.mjs", import.meta.url),
);

test("validateRelease accepts an in-main stable release", () => {
  assert.deepEqual(
    validateRelease({
      tag: "v1.4.2",
      target: sha,
      releaseSha: sha,
      mainContainsRelease: true,
      packageVersion: "1.4.2",
    }),
    { tag: "v1.4.2", version: "1.4.2", revision: sha, shaTag: `sha-${sha}` },
  );
});

test("validateRelease rejects malformed and prerelease tags", () => {
  for (const tag of ["1.4.2", "v01.4.2", "v1.04.2", "v1.4.02", "v1.4.2-rc.1"]) {
    assert.throws(() =>
      validateRelease({
        tag,
        target: sha,
        releaseSha: sha,
        mainContainsRelease: true,
        packageVersion: "1.4.2",
      }),
    );
  }
});

test("validateRelease rejects a package version that differs from the tag", () => {
  assert.throws(() =>
    validateRelease({
      tag: "v1.4.2",
      target: sha,
      releaseSha: sha,
      mainContainsRelease: true,
      packageVersion: "1.4.3",
    }),
  );
});

test("validateRelease rejects a full-SHA target that differs from the tagged release", () => {
  assert.throws(() =>
    validateRelease({
      tag: "v1.4.2",
      target: "b".repeat(40),
      releaseSha: sha,
      mainContainsRelease: true,
      packageVersion: "1.4.2",
    }),
  );
});

test("validateRelease rejects an uppercase full-SHA target that differs from the tagged release", () => {
  assert.throws(() =>
    validateRelease({
      tag: "v1.4.2",
      target: "B".repeat(40),
      releaseSha: sha,
      mainContainsRelease: true,
      packageVersion: "1.4.2",
    }),
  );
});

test("validateRelease permits a branch target after main advances", () => {
  assert.deepEqual(
    validateRelease({
      tag: "v1.4.2",
      target: "main",
      releaseSha: sha,
      mainContainsRelease: true,
      packageVersion: "1.4.2",
    }),
    { tag: "v1.4.2", version: "1.4.2", revision: sha, shaTag: `sha-${sha}` },
  );
});

test("validateRelease rejects a release outside main history", () => {
  assert.throws(() =>
    validateRelease({
      tag: "v1.4.2",
      target: sha,
      releaseSha: sha,
      mainContainsRelease: false,
      packageVersion: "1.4.2",
    }),
  );
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runPolicy(cwd, args) {
  return spawnSync(process.execPath, [policyPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createReleaseRepository() {
  const cwd = mkdtempSync(join(tmpdir(), "release-policy-"));
  git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Release Policy Test"]);
  writeFileSync(join(cwd, "release.txt"), "release\n");
  git(cwd, ["add", "release.txt"]);
  git(cwd, ["commit", "-m", "release"]);
  const releaseSha = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["tag", "-a", "v1.4.2", "-m", "v1.4.2", releaseSha]);

  writeFileSync(join(cwd, "main.txt"), "advanced\n");
  git(cwd, ["add", "main.txt"]);
  git(cwd, ["commit", "-m", "main advances"]);
  const mainSha = git(cwd, ["rev-parse", "main"]);

  git(cwd, ["switch", "-c", "side", releaseSha]);
  writeFileSync(join(cwd, "side.txt"), "side\n");
  git(cwd, ["add", "side.txt"]);
  git(cwd, ["commit", "-m", "side release"]);
  const sideSha = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["tag", "-a", "v1.4.3", "-m", "v1.4.3", sideSha]);
  git(cwd, ["switch", "main"]);

  return { cwd, mainSha, releaseSha, sideSha };
}

test("the CLI accepts a tagged main ancestor when target is the matching full SHA", (t) => {
  const repository = createReleaseRepository();
  t.after(() => rmSync(repository.cwd, { recursive: true, force: true }));

  const result = runPolicy(repository.cwd, [
    "--tag",
    "v1.4.2",
    "--target",
    repository.releaseSha,
    "--release-sha",
    repository.releaseSha,
    "--main-ref",
    "main",
    "--package-version",
    "1.4.2",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tag: "v1.4.2",
    version: "1.4.2",
    revision: repository.releaseSha,
    shaTag: `sha-${repository.releaseSha}`,
  });
});

test("the CLI accepts a branch target after main advances beyond the annotated tag", (t) => {
  const repository = createReleaseRepository();
  t.after(() => rmSync(repository.cwd, { recursive: true, force: true }));

  const result = runPolicy(repository.cwd, [
    "--tag",
    "v1.4.2",
    "--target",
    "main",
    "--release-sha",
    repository.releaseSha,
    "--main-ref",
    "main",
    "--package-version",
    "1.4.2",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).revision, repository.releaseSha);
  assert.notEqual(repository.mainSha, repository.releaseSha);
});

test("the CLI rejects a full-SHA target mismatch without emitting output", (t) => {
  const repository = createReleaseRepository();
  t.after(() => rmSync(repository.cwd, { recursive: true, force: true }));

  const result = runPolicy(repository.cwd, [
    "--tag",
    "v1.4.2",
    "--target",
    repository.mainSha,
    "--release-sha",
    repository.releaseSha,
    "--main-ref",
    "main",
    "--package-version",
    "1.4.2",
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("the CLI rejects a tag whose commit is not in main history", (t) => {
  const repository = createReleaseRepository();
  t.after(() => rmSync(repository.cwd, { recursive: true, force: true }));

  const result = runPolicy(repository.cwd, [
    "--tag",
    "v1.4.3",
    "--target",
    repository.sideSha,
    "--release-sha",
    repository.sideSha,
    "--main-ref",
    "main",
    "--package-version",
    "1.4.3",
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
