import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWallWebhook } from "./wall-normalize.js";

const receivedAt = "2026-09-10T05:00:00.000Z";
const repository = {
  id: 101,
  full_name: "acme/api",
  html_url: "https://github.com/acme/api",
};
const sender = {
  login: "alex",
  avatar_url: "https://avatars.githubusercontent.com/u/1",
};

test("normalizes pull requests and review decisions without retaining bodies", () => {
  const pull_request = {
    number: 42,
    title: "Ship faster",
    html_url: "https://github.com/acme/api/pull/42",
    state: "open",
    draft: false,
    mergeable: true,
    created_at: "2026-09-10T02:00:00Z",
    updated_at: "2026-09-10T04:00:00Z",
    head: { sha: "a".repeat(40) },
    user: sender,
    body: "must not persist",
  };
  const opened = normalizeWallWebhook(
    "pull_request",
    { action: "opened", repository, sender, pull_request },
    receivedAt,
  );
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], {
    kind: "pull_request",
    observedAt: "2026-09-10T04:00:00.000Z",
    value: {
      number: 42,
      title: "Ship faster",
      url: "https://github.com/acme/api/pull/42",
      author: "alex",
      authorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
      headSha: "a".repeat(40),
      state: "open",
      draft: false,
      mergeable: true,
      createdAt: "2026-09-10T02:00:00.000Z",
      updatedAt: "2026-09-10T04:00:00.000Z",
    },
  });

  const reviewed = normalizeWallWebhook(
    "pull_request_review",
    {
      action: "submitted",
      repository,
      sender,
      pull_request,
      review: {
        id: 9,
        state: "approved",
        submitted_at: "2026-09-10T04:30:00Z",
        user: { login: "reviewer" },
        body: "secret review body",
      },
    },
    receivedAt,
  );
  assert.equal(reviewed[0].kind, "pull_request");
  assert.equal(reviewed[1].kind, "review");
  assert.equal(JSON.stringify(reviewed).includes("secret review body"), false);
});

test("normalizes check runs, commit statuses, and workflow runs by commit SHA", () => {
  const check = normalizeWallWebhook(
    "check_run",
    {
      action: "completed",
      repository,
      check_run: {
        id: 7,
        name: "unit tests",
        head_sha: "b".repeat(40),
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-10T04:00:00Z",
        completed_at: "2026-09-10T04:04:00Z",
        details_url: "https://github.com/acme/api/runs/7",
        output: { text: "must not persist" },
        app: { slug: "github-actions" },
      },
    },
    receivedAt,
  );
  assert.equal(check[0].kind, "pipeline");
  assert.equal(check[0].value.status, "failing");
  assert.equal(check[0].value.provider, "github-actions");

  const status = normalizeWallWebhook(
    "status",
    {
      repository,
      sha: "c".repeat(40),
      state: "pending",
      context: "ci/build",
      target_url: "https://github.com/acme/api/actions/runs/8",
      updated_at: "2026-09-10T04:10:00Z",
      creator: { login: "circleci" },
    },
    receivedAt,
  );
  assert.equal(status[0].kind, "pipeline");
  assert.equal(status[0].value.status, "running");

  const workflow = normalizeWallWebhook(
    "workflow_run",
    {
      action: "in_progress",
      repository,
      workflow_run: {
        id: 11,
        name: "Build",
        head_sha: "d".repeat(40),
        status: "in_progress",
        html_url: "https://github.com/acme/api/actions/runs/11",
        run_started_at: "2026-09-10T04:20:00Z",
        updated_at: "2026-09-10T04:21:00Z",
      },
    },
    receivedAt,
  );
  assert.equal(workflow[0].kind, "pipeline");
  if (workflow[0].kind !== "pipeline")
    throw new Error("Expected a pipeline update");
  assert.equal(workflow[0].value.status, "running");
});

test("normalizes deployments and rejects unsafe URLs or incomplete identities", () => {
  const deployment = normalizeWallWebhook(
    "deployment_status",
    {
      action: "created",
      repository,
      deployment: { id: 55, sha: "e".repeat(40), environment: "production" },
      deployment_status: {
        id: 56,
        state: "success",
        created_at: "2026-09-10T04:40:00Z",
        target_url: "https://evil.example/deploy/56",
        environment_url: "https://service.example.com",
      },
    },
    receivedAt,
  );
  assert.equal(deployment[0].kind, "deployment");
  assert.equal(deployment[0].value.status, "successful");
  assert.equal(deployment[0].value.url, undefined);
  assert.equal(
    normalizeWallWebhook(
      "check_run",
      { repository, check_run: { id: 1 } },
      receivedAt,
    ).length,
    0,
  );
  assert.equal(
    normalizeWallWebhook("unknown", { repository }, receivedAt).length,
    0,
  );
});
