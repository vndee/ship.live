import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRestEvent,
  normalizeWebhook,
  safeGithubUrl,
  validOrganization,
} from "./normalize.js";

const occurredAt = "2026-09-07T08:00:00.000Z";
const actor = {
  login: "engineer",
  avatar_url: "https://avatars.githubusercontent.com/u/123",
};
const repository = { full_name: "team/service", owner: { login: "team" } };
const pull_request = {
  number: 42,
  title: "Ship the cache fix",
  merged: true,
  merged_at: occurredAt,
  created_at: occurredAt,
  additions: 20,
  deletions: 5,
};

test("REST and webhook merges use the same identity, preserve metrics, and ignore unmerged closures", () => {
  const payload = { action: "closed", pull_request };
  const rest = normalizeRestEvent({
    id: "123",
    type: "PullRequestEvent",
    actor,
    repo: { name: repository.full_name },
    payload,
    created_at: occurredAt,
  });
  const webhook = normalizeWebhook(
    "pull_request",
    { ...payload, sender: actor, repository },
    "delivery-1",
    occurredAt,
  );
  assert.deepEqual(rest, webhook);
  assert.equal(rest?.type, "merge");
  assert.equal(rest?.additions, 20);
  assert.equal(
    normalizeWebhook(
      "pull_request",
      {
        ...payload,
        pull_request: { ...pull_request, merged: false },
        sender: actor,
        repository,
      },
      "delivery-2",
    ),
    null,
  );
});

test("REST and webhook push identities match even when the REST payload lacks commits", () => {
  const head = "a".repeat(40);
  const rest = normalizeRestEvent({
    id: "123",
    type: "PushEvent",
    actor,
    repo: { name: repository.full_name },
    payload: { ref: "refs/heads/main", head },
    created_at: occurredAt,
  });
  const webhook = normalizeWebhook(
    "push",
    {
      ref: "refs/heads/main",
      after: head,
      head_commit: { message: "Fix retries\n\nDetails" },
      sender: actor,
      repository,
    },
    "delivery-1",
    occurredAt,
  );
  assert.equal(rest?.id, webhook?.id);
  assert.equal(rest?.title, "Pushed to main");
  assert.equal(webhook?.title, "Fix retries");
});

test("reviews only count submitted reviews, and releases only count published releases", () => {
  const payload = {
    action: "submitted",
    review: { id: 77, state: "approved", submitted_at: occurredAt },
    pull_request,
    sender: actor,
    repository,
  };
  assert.equal(
    normalizeWebhook("pull_request_review", payload, "delivery")?.type,
    "review",
  );
  assert.equal(
    normalizeWebhook(
      "pull_request_review",
      { ...payload, action: "edited" },
      "delivery",
    ),
    null,
  );
  assert.equal(
    normalizeWebhook(
      "release",
      {
        action: "created",
        release: { id: 8, tag_name: "v1" },
        sender: actor,
        repository,
      },
      "delivery",
    ),
    null,
  );
  assert.equal(
    normalizeWebhook(
      "release",
      {
        action: "published",
        release: { id: 8, tag_name: "v1", published_at: occurredAt },
        sender: actor,
        repository,
      },
      "delivery",
    )?.title,
    "v1",
  );
});

test("current REST review-created and PR-merged actions normalize consistently with webhooks", () => {
  const review = { id: 77, state: "approved", submitted_at: occurredAt };
  const restReview = normalizeRestEvent({
    id: "123",
    type: "PullRequestReviewEvent",
    actor,
    repo: { name: repository.full_name },
    payload: { action: "created", review, pull_request },
    created_at: occurredAt,
  });
  const webhookReview = normalizeWebhook(
    "pull_request_review",
    { action: "submitted", review, pull_request, sender: actor, repository },
    "delivery",
    occurredAt,
  );
  assert.deepEqual(restReview, webhookReview);
  const restMerge = normalizeRestEvent({
    id: "124",
    type: "PullRequestEvent",
    actor,
    repo: { name: repository.full_name },
    payload: { action: "merged", pull_request },
    created_at: occurredAt,
  });
  assert.equal(restMerge?.type, "merge");
  assert.equal(restMerge?.id, "team/service:pr:42:merged");
});

test("only completed issue closures qualify, and closing the same issue again cannot create more XP", () => {
  const issue = {
    number: 10,
    title: "Add tracing",
    created_at: occurredAt,
    closed_at: "2026-09-07T09:00:00Z",
    state_reason: "completed",
  };
  for (const action of ["opened", "reopened"])
    assert.equal(
      normalizeWebhook(
        "issues",
        { action, issue, sender: actor, repository },
        `delivery-${action}`,
      ),
      null,
    );
  assert.equal(
    normalizeWebhook(
      "issues",
      {
        action: "closed",
        issue: { ...issue, state_reason: "not_planned" },
        sender: actor,
        repository,
      },
      "delivery-not-planned",
    ),
    null,
  );
  const closed = normalizeWebhook(
    "issues",
    { action: "closed", issue, sender: actor, repository },
    "delivery-closed",
  );
  const closedAgain = normalizeWebhook(
    "issues",
    {
      action: "closed",
      issue: { ...issue, closed_at: "2026-09-08T09:00:00Z" },
      sender: actor,
      repository,
    },
    "delivery-closed-again",
  );
  assert.equal(closed?.id, "team/service:issue:10:closed");
  assert.equal(closed?.id, closedAgain?.id);
  assert.equal(closed?.title, "Add tracing");
  const rest = normalizeRestEvent({
    id: "999",
    type: "IssuesEvent",
    actor,
    repo: { name: repository.full_name },
    payload: { action: "closed", issue },
    created_at: occurredAt,
  });
  assert.deepEqual(rest, closed);
  assert.equal(
    normalizeRestEvent({ id: "1", type: "WatchEvent", created_at: occurredAt }),
    null,
  );
});

test("reopening a pull request does not create another scorable opening event", () => {
  const reopened = normalizeWebhook(
    "pull_request",
    { action: "reopened", pull_request, sender: actor, repository },
    "delivery-reopened",
  );
  assert.equal(reopened, null);
  const opened = normalizeWebhook(
    "pull_request",
    { action: "opened", pull_request, sender: actor, repository },
    "delivery-opened",
  );
  assert.equal(opened?.type, "pr");
});

test("PRs celebrate the author, reviews the reviewer, and releases the author instead of the delivery sender", () => {
  const automation = {
    login: "merge-bot[bot]",
    avatar_url: "https://avatars.githubusercontent.com/u/999",
  };
  const author = {
    login: "author",
    avatar_url: "https://avatars.githubusercontent.com/u/456",
  };
  const reviewer = {
    login: "reviewer",
    avatar_url: "https://avatars.githubusercontent.com/u/789",
  };
  const expectedAuthor = { login: author.login, avatarUrl: author.avatar_url };
  for (const action of ["opened", "closed"]) {
    const event = normalizeWebhook(
      "pull_request",
      {
        action,
        pull_request: { ...pull_request, user: author },
        sender: automation,
        repository,
      },
      `delivery-${action}`,
    );
    assert.deepEqual(event?.actor, expectedAuthor);
  }
  const restMerge = normalizeRestEvent({
    id: "999",
    type: "PullRequestEvent",
    actor: automation,
    repo: { name: repository.full_name },
    payload: {
      action: "closed",
      pull_request: { ...pull_request, user: author },
    },
    created_at: occurredAt,
  });
  assert.deepEqual(restMerge?.actor, expectedAuthor);
  const review = normalizeWebhook(
    "pull_request_review",
    {
      action: "submitted",
      review: { id: 3, state: "approved", user: reviewer },
      pull_request: { ...pull_request, user: author },
      sender: automation,
      repository,
    },
    "delivery-review",
  );
  assert.deepEqual(review?.actor, {
    login: reviewer.login,
    avatarUrl: reviewer.avatar_url,
  });
  const release = normalizeWebhook(
    "release",
    {
      action: "published",
      release: { id: 8, tag_name: "v1", author },
      sender: automation,
      repository,
    },
    "delivery-release",
  );
  assert.deepEqual(release?.actor, expectedAuthor);
  const issue = normalizeWebhook(
    "issues",
    {
      action: "closed",
      issue: {
        number: 10,
        title: "Add tracing",
        state_reason: "completed",
        user: author,
      },
      sender: reviewer,
      repository,
    },
    "delivery-issue",
  );
  assert.deepEqual(issue?.actor, {
    login: reviewer.login,
    avatarUrl: reviewer.avatar_url,
  });
});

test("missing contributor information falls back to the event actor and unsafe contributor avatars are removed", () => {
  const merge = normalizeWebhook(
    "pull_request",
    {
      action: "closed",
      pull_request: { ...pull_request, user: {} },
      sender: actor,
      repository,
    },
    "delivery-merge",
  );
  assert.equal(merge?.actor.login, actor.login);
  const attributed = normalizeWebhook(
    "pull_request",
    {
      action: "closed",
      pull_request: {
        ...pull_request,
        user: { login: "author", avatar_url: "https://untrusted.test/tracker" },
      },
      sender: actor,
      repository,
    },
    "delivery-avatar",
  );
  assert.equal(attributed?.actor.login, "author");
  assert.equal(attributed?.actor.avatarUrl, undefined);
});

test("organization inputs and outgoing links reject URL injection and untrusted hosts", () => {
  assert.equal(validOrganization("example-org"), true);
  for (const input of [
    "../team",
    "https://github.com/team",
    "team?x=1",
    "-team",
    "team-",
    "",
    "x".repeat(40),
  ])
    assert.equal(validOrganization(input), false);
  for (const url of [
    "javascript:alert(1)",
    "https://github.com.evil.test/team",
    "https://evil.test",
    "https://secret@github.com/team",
    "http://github.com/team",
  ])
    assert.equal(safeGithubUrl(url), undefined);
  const event = normalizeWebhook(
    "pull_request",
    {
      action: "closed",
      pull_request: { ...pull_request, html_url: "javascript:alert(1)" },
      sender: { ...actor, avatar_url: "https://evil.test/tracker" },
      repository,
    },
    "delivery",
  );
  assert.equal(event?.url, "https://github.com/team/service/pull/42");
  assert.equal(event?.actor.avatarUrl, undefined);
});
