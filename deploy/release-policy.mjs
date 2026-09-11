import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REVISION = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function requireString(value, message) {
  if (typeof value !== "string") fail(message);
  return value;
}

export function validateRelease({
  tag,
  target,
  releaseSha,
  mainContainsRelease,
  packageVersion,
}) {
  requireString(tag, "Release tag must be a string");
  requireString(target, "Release target must be a string");
  requireString(releaseSha, "Release SHA must be a string");
  requireString(packageVersion, "Package version must be a string");

  if (!VERSION.test(tag)) fail("Release tag must be stable SemVer");
  if (!REVISION.test(releaseSha))
    fail("Release SHA must be a full lowercase SHA");
  if (REVISION.test(target) && target !== releaseSha)
    fail("Release target must match the tagged release");
  if (packageVersion !== tag.slice(1))
    fail("Package version must match the release tag");
  if (mainContainsRelease !== true) fail("Release must be an ancestor of main");

  return {
    tag,
    version: tag.slice(1),
    revision: releaseSha,
    shaTag: `sha-${releaseSha}`,
  };
}

function parseOptions(args) {
  const required = new Set([
    "--tag",
    "--target",
    "--release-sha",
    "--main-ref",
    "--package-version",
  ]);
  const values = {};

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!required.has(option) || value === undefined || option in values)
      fail("Release policy requires each supported option exactly once");
    values[option] = value;
  }

  if ([...required].some((option) => !(option in values)))
    fail("Release policy requires all options");
  if (!values["--main-ref"] || values["--main-ref"].startsWith("-"))
    fail("Main ref must be a ref name");

  return {
    tag: values["--tag"],
    target: values["--target"],
    releaseSha: values["--release-sha"],
    mainRef: values["--main-ref"],
    packageVersion: values["--package-version"],
  };
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    fail("Unable to resolve release Git state");
  return result.stdout.trim();
}

function isAncestor(releaseSha, mainRef) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", releaseSha, mainRef],
    { encoding: "utf8" },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail("Unable to verify release Git ancestry");
}

export function validateReleaseFromGit(options) {
  const values = parseOptions(options);
  if (!VERSION.test(values.tag)) fail("Release tag must be stable SemVer");
  if (!REVISION.test(values.releaseSha))
    fail("Release SHA must be a full lowercase SHA");

  const taggedReleaseSha = git([
    "rev-parse",
    `refs/tags/${values.tag}^{commit}`,
  ]);
  if (!REVISION.test(taggedReleaseSha))
    fail("Tagged release must resolve to a full SHA");
  if (values.releaseSha !== taggedReleaseSha)
    fail("Event release SHA must match the tagged release");

  return validateRelease({
    ...values,
    releaseSha: taggedReleaseSha,
    mainContainsRelease: isAncestor(taggedReleaseSha, values.mainRef),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const release = validateReleaseFromGit(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(release)}\n`);
  } catch {
    process.stderr.write("Release validation failed\n");
    process.exitCode = 1;
  }
}
