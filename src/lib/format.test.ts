import assert from "node:assert/strict";
import test from "node:test";
import { ago, personName, safeUrl, shortRepo } from "./format";

test("relative times step from minutes to hours to days", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  assert.equal(ago("2026-09-10T11:59:30Z", now), "just now");
  assert.equal(ago("2026-09-10T11:15:00Z", now), "45m ago");
  assert.equal(ago("2026-09-10T07:00:00Z", now), "5h ago");
  assert.equal(ago("2026-09-07T12:00:00Z", now), "3d ago");
  assert.equal(ago("2026-09-10T12:05:00Z", now), "just now");
});

test("only GitHub HTTPS links are offered", () => {
  assert.equal(
    safeUrl("https://github.com/acme/api/pull/1"),
    "https://github.com/acme/api/pull/1",
  );
  for (const url of [
    "http://github.com/acme",
    "https://github.com.evil.test/",
    "javascript:alert(1)",
    undefined,
  ])
    assert.equal(safeUrl(url), undefined);
});

test("repositories and people get short display names", () => {
  assert.equal(shortRepo("acme/api-gateway"), "api-gateway");
  assert.equal(shortRepo("journal/notes"), "Ship notes");
  assert.equal(personName("sarahpark", true), "Sarah Park");
  assert.equal(personName("sarahpark", false), "sarahpark");
  assert.equal(personName("octocat", true), "octocat");
});
