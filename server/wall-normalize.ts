import type {
  DeploymentStatus,
  PipelineStatus,
  WallSignalUpdate,
} from "../shared/wall.js";
import { object, safeGithubUrl } from "./normalize.js";

type JsonObject = Record<string, unknown>;

function text(value: unknown, limit = 300): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function sha(value: unknown): string | undefined {
  const candidate = text(value, 64);
  return /^[a-f\d]{40,64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

function timestamp(value: unknown, fallback: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function pipelineStatus(status: unknown, conclusion: unknown): PipelineStatus {
  const current = text(status).toLowerCase();
  const result = text(conclusion).toLowerCase();
  if (["queued", "requested", "waiting"].includes(current)) return "queued";
  if (["in_progress", "running", "pending"].includes(current)) return "running";
  if (!result && current === "success") return "passing";
  if (!result && ["failure", "error"].includes(current)) return "failing";
  if (["success"].includes(result)) return "passing";
  if (
    ["failure", "timed_out", "action_required", "stale", "error"].includes(
      result,
    )
  )
    return "failing";
  if (["cancelled", "skipped"].includes(result)) return "cancelled";
  return "neutral";
}

function deploymentStatus(value: unknown): DeploymentStatus {
  const state = text(value).toLowerCase();
  if (["queued", "pending", "waiting"].includes(state)) return "queued";
  if (["in_progress", "running"].includes(state)) return "running";
  if (state === "success") return "successful";
  if (["failure", "error"].includes(state)) return "failing";
  if (state === "inactive") return "inactive";
  return "cancelled";
}

function pullRequestUpdate(
  payload: JsonObject,
  receivedAt: string,
): WallSignalUpdate | undefined {
  const pull = object(payload.pull_request);
  const number = positiveInteger(pull.number ?? payload.number);
  const headSha = sha(object(pull.head).sha);
  const url = safeGithubUrl(pull.html_url);
  if (!number || !headSha || !url) return undefined;
  const action = text(payload.action).toLowerCase();
  const updatedAt = timestamp(pull.updated_at, receivedAt);
  const user = object(pull.user);
  const state =
    pull.merged === true || action === "merged"
      ? "merged"
      : text(pull.state) === "closed" || action === "closed"
        ? "closed"
        : "open";
  return {
    kind: "pull_request",
    observedAt: updatedAt,
    value: {
      number,
      title: text(pull.title) || `Pull request #${number}`,
      url,
      author: text(user.login, 100) || "unknown",
      authorAvatarUrl: safeGithubUrl(user.avatar_url, true),
      headSha,
      state,
      draft: pull.draft === true,
      ...(typeof pull.mergeable === "boolean"
        ? { mergeable: pull.mergeable }
        : {}),
      createdAt: timestamp(pull.created_at, updatedAt),
      updatedAt,
    },
  };
}

export function normalizeWallWebhook(
  kind: string,
  payload: JsonObject,
  receivedAt = new Date().toISOString(),
): WallSignalUpdate[] {
  if (!positiveInteger(object(payload.repository).id)) return [];
  if (kind === "pull_request") {
    const update = pullRequestUpdate(payload, receivedAt);
    return update ? [update] : [];
  }
  if (kind === "pull_request_review") {
    const pull = pullRequestUpdate(payload, receivedAt);
    const review = object(payload.review);
    const id = positiveInteger(review.id);
    const pullRequestNumber = positiveInteger(
      object(payload.pull_request).number,
    );
    const reviewer = text(object(review.user).login, 100);
    const decision = text(review.state).toLowerCase();
    if (
      !pull ||
      !id ||
      !pullRequestNumber ||
      !reviewer ||
      !["approved", "changes_requested", "commented", "dismissed"].includes(
        decision,
      )
    )
      return pull ? [pull] : [];
    const submittedAt = timestamp(review.submitted_at, receivedAt);
    return [
      pull,
      {
        kind: "review",
        observedAt: submittedAt,
        value: {
          id,
          pullRequestNumber,
          reviewer,
          decision: decision as
            "approved" | "changes_requested" | "commented" | "dismissed",
          submittedAt,
        },
      },
    ];
  }
  if (kind === "check_run") {
    const run = object(payload.check_run);
    const id = positiveInteger(run.id);
    const headSha = sha(run.head_sha);
    const name = text(run.name);
    if (!id || !headSha || !name) return [];
    const completedAt = run.completed_at
      ? timestamp(run.completed_at, receivedAt)
      : undefined;
    const updatedAt = completedAt ?? timestamp(run.started_at, receivedAt);
    return [
      {
        kind: "pipeline",
        observedAt: updatedAt,
        value: {
          id: `check:${id}`,
          name,
          provider: text(object(run.app).slug, 100) || "github-check",
          headSha,
          status: pipelineStatus(run.status, run.conclusion),
          url: safeGithubUrl(run.details_url),
          startedAt: run.started_at
            ? timestamp(run.started_at, receivedAt)
            : undefined,
          completedAt,
          updatedAt,
        },
      },
    ];
  }
  if (kind === "status") {
    const headSha = sha(payload.sha);
    const name = text(payload.context);
    if (!headSha || !name) return [];
    const updatedAt = timestamp(
      payload.updated_at ?? payload.created_at,
      receivedAt,
    );
    return [
      {
        kind: "pipeline",
        observedAt: updatedAt,
        value: {
          id: `status:${name.toLowerCase()}`,
          name,
          provider: text(object(payload.creator).login, 100) || "commit-status",
          headSha,
          status: pipelineStatus(payload.state, undefined),
          url: safeGithubUrl(payload.target_url),
          updatedAt,
        },
      },
    ];
  }
  if (kind === "workflow_run") {
    const run = object(payload.workflow_run);
    const id = positiveInteger(run.id);
    const headSha = sha(run.head_sha);
    const name = text(run.name);
    if (!id || !headSha || !name) return [];
    const completedAt = run.completed_at
      ? timestamp(run.completed_at, receivedAt)
      : undefined;
    const updatedAt = timestamp(
      run.updated_at ?? run.run_started_at,
      receivedAt,
    );
    return [
      {
        kind: "pipeline",
        observedAt: updatedAt,
        value: {
          id: `workflow:${id}`,
          name,
          provider: "github-actions",
          headSha,
          status: pipelineStatus(run.status, run.conclusion),
          url: safeGithubUrl(run.html_url),
          startedAt: run.run_started_at
            ? timestamp(run.run_started_at, receivedAt)
            : undefined,
          completedAt,
          updatedAt,
        },
      },
    ];
  }
  if (kind === "deployment" || kind === "deployment_status") {
    const deployment = object(payload.deployment);
    const status = object(payload.deployment_status);
    const id = positiveInteger(deployment.id);
    const headSha = sha(deployment.sha);
    if (!id || !headSha) return [];
    const updatedAt = timestamp(
      status.created_at ?? deployment.updated_at,
      receivedAt,
    );
    return [
      {
        kind: "deployment",
        observedAt: updatedAt,
        value: {
          id: `deployment:${id}`,
          environment:
            text(status.environment ?? deployment.environment, 100) ||
            "deployment",
          headSha,
          status:
            kind === "deployment" ? "queued" : deploymentStatus(status.state),
          url: safeGithubUrl(status.target_url),
          updatedAt,
        },
      },
    ];
  }
  return [];
}
