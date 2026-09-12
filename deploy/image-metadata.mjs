import { fileURLToPath } from "node:url";

import {
  MAX_SUPPORTED_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from "../server/migrations.ts";

const VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REVISION = /^[0-9a-f]{40}$/;

export function metadata(
  version,
  revision,
  schemaVersion,
  maxSchemaVersion,
  testedPredecessor,
) {
  if (typeof version !== "string" || !VERSION.test(version))
    throw new Error("Release version must be stable SemVer");
  if (typeof revision !== "string" || !REVISION.test(revision))
    throw new Error("Revision must be a full lowercase SHA");
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
    throw new Error("Schema version must be a positive integer");
  if (
    !Number.isSafeInteger(maxSchemaVersion) ||
    maxSchemaVersion < schemaVersion
  )
    throw new Error(
      "Maximum schema version must be an integer at least as new as the schema",
    );

  if (
    typeof testedPredecessor !== "string" ||
    !/^(?:none|ghcr\.io\/vndee\/ship\.live@sha256:[0-9a-f]{64})(?![\s\S])/.test(
      testedPredecessor,
    )
  )
    throw new Error("Tested predecessor must be an immutable image or none");

  return {
    version,
    revision,
    schemaVersion,
    maxSchemaVersion,
    testedPredecessor,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, revision, testedPredecessor] = process.argv.slice(2);
  const values = metadata(
    version,
    revision,
    SCHEMA_VERSION,
    MAX_SUPPORTED_SCHEMA_VERSION,
    testedPredecessor,
  );
  process.stdout.write(
    [
      `VERSION=${values.version}`,
      `REVISION=${values.revision}`,
      `SCHEMA_VERSION=${values.schemaVersion}`,
      `MAX_SCHEMA_VERSION=${values.maxSchemaVersion}`,
      `TESTED_PREDECESSOR=${values.testedPredecessor}`,
      "",
    ].join("\n"),
  );
}
