import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAccessWebhook } from "./access-normalize.js";

const organization = { id: 700, login: "team" };
const repository = {
  id: 102,
  full_name: "team/beta",
  owner: { id: 700, login: "team" },
};

test("membership webhooks describe whose access changed, where, and for which account", () => {
  assert.deepEqual(
    normalizeAccessWebhook("organization", {
      action: "member_removed",
      organization,
      membership: { user: { id: 1 } },
    }),
    { githubUserId: 1, removal: true, accountId: 700 },
  );
  assert.deepEqual(
    normalizeAccessWebhook("membership", {
      action: "added",
      organization,
      member: { id: 1 },
      team: { id: 5 },
    }),
    { githubUserId: 1, removal: false, accountId: 700 },
  );
  assert.deepEqual(
    normalizeAccessWebhook("member", {
      action: "removed",
      member: { id: 1 },
      repository,
    }),
    { githubUserId: 1, repositoryId: 102, removal: true, accountId: 700 },
  );
  assert.deepEqual(
    normalizeAccessWebhook("team", {
      action: "removed_from_repository",
      organization,
      team: { id: 5 },
      repository,
    }),
    { repositoryId: 102, removal: true, accountId: 700 },
  );
  assert.deepEqual(
    normalizeAccessWebhook("team", {
      action: "deleted",
      organization,
      team: { id: 5 },
    }),
    { removal: false, accountId: 700 },
  );
});

test("unrelated or incomplete membership webhooks are ignored", () => {
  const ignored: Array<[string, Record<string, unknown>]> = [
    ["organization", { action: "renamed", organization }],
    ["member", { action: "edited", member: { id: 1 }, repository }],
    ["member", { action: "removed", member: { id: 1 } }],
    ["membership", { action: "removed", member: { id: "1" } }],
    ["team", { action: "added_to_repository", organization, team: { id: 5 } }],
    ["push", { action: "removed", member: { id: 1 }, repository }],
  ];
  for (const [kind, payload] of ignored)
    assert.equal(normalizeAccessWebhook(kind, payload), undefined);
});
