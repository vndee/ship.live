import assert from "node:assert/strict";
import test from "node:test";
import {
  createLogger,
  logOptionsFromEnv,
  type LoggerOptions,
} from "./logger.js";

function capture(options: LoggerOptions) {
  const lines: string[] = [];
  const logger = createLogger({
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    write: (line) => lines.push(line),
    ...options,
  });
  return { logger, lines };
}

test("JSON logs carry level, message, and fields, and reduce errors to their message", () => {
  const { logger, lines } = capture({ format: "json", level: "info" });
  const child = logger.child({ component: "sync" });
  child.debug("Hidden below the threshold.");
  child.error("Sync failed.", {
    error: new Error("GitHub rate limit reached"),
    attempt: 2,
    skipped: undefined,
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    time: "2026-09-10T00:00:00.000Z",
    level: "error",
    msg: "Sync failed.",
    component: "sync",
    error: "GitHub rate limit reached",
    attempt: 2,
  });
});

test("fields cannot replace the time, level, or message", () => {
  const { logger, lines } = capture({ format: "json" });
  logger.warn("Real message.", { msg: "forged", level: "debug", time: "x" });
  assert.deepEqual(JSON.parse(lines[0]), {
    time: "2026-09-10T00:00:00.000Z",
    level: "warn",
    msg: "Real message.",
  });
});

test("text logs are one line with quoted values where needed", () => {
  const { logger, lines } = capture({ format: "text", level: "debug" });
  logger.debug("Request.", {
    route: "/api/workspaces/:id/feed",
    status: 200,
    note: "two words",
    lines: "a\nb",
  });
  assert.deepEqual(lines, [
    '2026-09-10T00:00:00.000Z DEBUG Request. route=/api/workspaces/:id/feed status=200 note="two words" lines="a\\nb"',
  ]);
});

test("log options default by environment and ignore unknown values", () => {
  assert.deepEqual(logOptionsFromEnv({}), { level: "info", format: "text" });
  assert.deepEqual(logOptionsFromEnv({ NODE_ENV: "production" }), {
    level: "info",
    format: "json",
  });
  assert.deepEqual(
    logOptionsFromEnv({
      NODE_ENV: "production",
      LOG_LEVEL: " DEBUG ",
      LOG_FORMAT: "text",
    }),
    { level: "debug", format: "text" },
  );
  assert.deepEqual(
    logOptionsFromEnv({ LOG_LEVEL: "verbose", LOG_FORMAT: "xml" }),
    { level: "info", format: "text" },
  );
});
