import assert from "node:assert/strict";
import test from "node:test";
import { FilterError, filtersMatch, validateFilters } from "./webhook-filters";
import { sampleEvent } from "./webhooks";

const merge = sampleEvent("activity.merge");
const deploy = sampleEvent("deployment.failed");
const incident = sampleEvent("incident.opened");

test("patterns use * wildcards, ignore case, and ! excludes", () => {
  assert.equal(filtersMatch({ repositories: ["ACME/*"] }, merge), true);
  assert.equal(filtersMatch({ repositories: ["acme/web-*"] }, merge), false);
  assert.equal(filtersMatch({ branches: ["main", "release/*"] }, merge), true);
  assert.equal(filtersMatch({ actors: ["!*[bot]"] }, merge), true);
  assert.equal(
    filtersMatch(
      { actors: ["!*[bot]"] },
      {
        ...merge,
        data: { ...merge.data, actor: { login: "dependabot[bot]" } },
      },
    ),
    false,
  );
  assert.equal(
    filtersMatch({ actors: ["sarah*", "!sarahpark"] }, merge),
    false,
  );
  // Regular expression characters in a pattern are literal.
  assert.equal(filtersMatch({ repositories: ["acme.platform"] }, merge), false);
});

test("a list applies only to events that carry its field", () => {
  const filters = { environments: ["production"], services: ["Web app"] };
  assert.equal(filtersMatch(filters, merge), true);
  assert.equal(filtersMatch(filters, deploy), true);
  assert.equal(filtersMatch(filters, incident), false);
  assert.equal(filtersMatch({ environments: ["staging"] }, deploy), false);
});

test("summary text must appear, case-insensitively", () => {
  assert.equal(filtersMatch({ text: "PREVIEW" }, merge), true);
  assert.equal(filtersMatch({ text: "hotfix" }, merge), false);
});

test("filters are validated, trimmed, and deduplicated", () => {
  assert.deepEqual(
    validateFilters({
      repositories: [" acme/* ", "acme/*"],
      text: "  deploy ",
      actors: [],
    }),
    { repositories: ["acme/*"], text: "deploy" },
  );
  assert.deepEqual(validateFilters(undefined), {});
  for (const input of [
    [],
    { owners: ["x"] },
    { repositories: "acme/*" },
    { repositories: [""] },
    { repositories: Array.from({ length: 51 }, (_, index) => `r${index}`) },
    { branches: ["a\nb"] },
    { text: "x".repeat(201) },
  ])
    assert.throws(
      () => validateFilters(input),
      FilterError,
      JSON.stringify(input),
    );
});
