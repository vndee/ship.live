import type { ActivityEvent } from "../shared/types.js";

type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 1000) : fallback;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function date(value: unknown, fallback: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/** Limit links rendered by the dashboard to GitHub-owned HTTPS hosts. */
export function safeGithubUrl(
  value: unknown,
  avatar = false,
): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const allowed = avatar
      ? ["avatars.githubusercontent.com", "github.com"]
      : ["github.com"];
    if (
      url.protocol !== "https:" ||
      !allowed.includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function validOrganization(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value) &&
    !value.includes("--")
  );
}

function validRepository(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    validOrganization(parts[0]) &&
    /^[a-z\d_.-]{1,100}$/i.test(parts[1])
  );
}

function contributor(
  value: unknown,
  fallback: JsonObject,
): ActivityEvent["actor"] {
  const preferred = object(value);
  const person = text(preferred.login).trim() ? preferred : fallback;
  return {
    login: text(person.login, "unknown"),
    avatarUrl: safeGithubUrl(person.avatar_url, true),
  };
}

function normalize(
  kind: string,
  payload: JsonObject,
  actor: JsonObject,
  repo: string,
  fallbackId: string,
  occurredAt: string,
): ActivityEvent | null {
  if (!validRepository(repo)) return null;
  const base = {
    actor: contributor(actor, {}),
    repo,
    occurredAt,
  };
  const repoUrl = `https://github.com/${repo}`;
  const action = text(payload.action);
  const pr = object(payload.pull_request);
  if (kind === "pull_request") {
    const prNumber = number(pr.number) ?? number(payload.number);
    if (!prNumber) return null;
    const merged =
      action === "merged" || (action === "closed" && pr.merged === true);
    if (!merged && action !== "opened") return null;
    const at = date(merged ? pr.merged_at : pr.created_at, occurredAt);
    const target = object(pr.base);
    const branch = (merged && text(target.ref)) || undefined;
    // Webhooks and pull listings name the default branch; trimmed REST events may not.
    const defaultName =
      text(object(target.repo).default_branch) ||
      text(object(payload.repository).default_branch);
    return {
      ...base,
      id: `${repo.toLowerCase()}:pr:${prNumber}:${merged ? "merged" : `${action}:${at}`}`,
      actor: contributor(pr.user, actor),
      type: merged ? "merge" : "pr",
      number: prNumber,
      title: text(pr.title, `Pull request #${prNumber}`),
      url: safeGithubUrl(pr.html_url) ?? `${repoUrl}/pull/${prNumber}`,
      occurredAt: at,
      additions: number(pr.additions),
      deletions: number(pr.deletions),
      branch,
      defaultBranch: branch && defaultName ? branch === defaultName : undefined,
    };
  }
  if (kind === "pull_request_review") {
    const review = object(payload.review);
    if (
      action !== "submitted" ||
      !["approved", "commented", "changes_requested"].includes(
        text(review.state).toLowerCase(),
      )
    )
      return null;
    const prNumber = number(pr.number);
    const reviewId = number(review.id);
    const at = date(review.submitted_at, occurredAt);
    return {
      ...base,
      id: `${repo.toLowerCase()}:review:${reviewId ?? fallbackId}`,
      actor: contributor(review.user, actor),
      type: "review",
      number: prNumber,
      occurredAt: at,
      title: text(
        pr.title,
        `Reviewed pull request${prNumber ? ` #${prNumber}` : ""}`,
      ),
      url:
        safeGithubUrl(review.html_url) ?? safeGithubUrl(pr.html_url) ?? repoUrl,
    };
  }
  if (kind === "push") {
    if (payload.deleted === true) return null;
    const ref = text(payload.ref);
    const head = text(payload.after, text(payload.head));
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const latest = object(payload.head_commit ?? commits.at(-1));
    const branch = ref.replace(/^refs\/(heads|tags)\//, "") || "repository";
    const count = number(payload.size) ?? (commits.length || undefined);
    // GitHub marks commits already pushed elsewhere as not distinct, so branch
    // creation and merge commits never credit the same commit twice.
    const added =
      number(payload.distinct_size) ??
      (Array.isArray(payload.commits)
        ? commits.filter((commit) => object(commit).distinct !== false).length
        : undefined);
    return {
      ...base,
      id: head
        ? `${repo.toLowerCase()}:push:${ref}:${head}`
        : `github:${fallbackId}`,
      type: "push",
      commits: ref.startsWith("refs/heads/") ? added : undefined,
      title:
        text(latest.message).split("\n")[0] ||
        `Pushed${count ? ` ${count} commit${count === 1 ? "" : "s"}` : ""} to ${branch}`,
      url:
        safeGithubUrl(payload.compare) ??
        (/^[a-f\d]{40,64}$/i.test(head)
          ? `${repoUrl}/commit/${head}`
          : repoUrl),
    };
  }
  if (kind === "issues") {
    const issue = object(payload.issue);
    if (
      action !== "closed" ||
      issue.state_reason === "not_planned" ||
      issue.pull_request
    )
      return null;
    const issueNumber = number(issue.number);
    if (!issueNumber) return null;
    const at = date(issue.closed_at, occurredAt);
    return {
      ...base,
      id: `${repo.toLowerCase()}:issue:${issueNumber}:closed`,
      type: "issue",
      number: issueNumber,
      occurredAt: at,
      title: text(issue.title, `Issue #${issueNumber}`),
      url: safeGithubUrl(issue.html_url) ?? `${repoUrl}/issues/${issueNumber}`,
    };
  }
  if (kind === "release") {
    const release = object(payload.release);
    if (action !== "published" || release.draft === true) return null;
    const tag = text(release.tag_name);
    return {
      ...base,
      id: `${repo.toLowerCase()}:release:${number(release.id) ?? (tag || fallbackId)}`,
      actor: contributor(release.author, actor),
      type: "release",
      title: text(release.name) || tag || "Published a release",
      occurredAt: date(release.published_at, occurredAt),
      url: safeGithubUrl(release.html_url) ?? repoUrl,
    };
  }
  return null;
}

const restKinds: Record<string, string> = {
  PullRequestEvent: "pull_request",
  PullRequestReviewEvent: "pull_request_review",
  PushEvent: "push",
  IssuesEvent: "issues",
  ReleaseEvent: "release",
};

export function normalizeRestEvent(input: unknown): ActivityEvent | null {
  const event = object(input);
  const kind = restKinds[text(event.type)];
  if (!kind || !event.id || !event.created_at) return null;
  const payload = { ...object(event.payload) };
  // REST uses "created" for reviews; webhooks use "submitted" for the same event.
  if (kind === "pull_request_review" && payload.action === "created")
    payload.action = "submitted";
  return normalize(
    kind,
    payload,
    object(event.actor),
    text(object(event.repo).name),
    String(event.id),
    date(event.created_at, new Date(0).toISOString()),
  );
}

export function webhookOrganization(input: unknown): string | undefined {
  const payload = object(input);
  const repo = object(payload.repository);
  const organization =
    text(object(payload.organization).login) || text(object(repo.owner).login);
  return validOrganization(organization) ? organization : undefined;
}

export function normalizeWebhook(
  kind: string,
  input: unknown,
  deliveryId: string,
  receivedAt = new Date().toISOString(),
): ActivityEvent | null {
  const payload = object(input);
  return normalize(
    kind,
    payload,
    object(payload.sender),
    text(object(payload.repository).full_name),
    deliveryId,
    receivedAt,
  );
}
