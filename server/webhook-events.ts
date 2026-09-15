import type { HealthStatus, ProbeResult } from "../shared/health.js";
import type { ActivityEvent } from "../shared/types.js";
import type { DeploymentState, PipelineState } from "../shared/wall.js";

/** An event before it is stored for a workspace's webhooks. */
export interface OutboxEvent {
  type: string;
  /** Identical events (a retried webhook, a replayed check) are stored once. */
  dedupeKey: string;
  /** Activity and CI events carry their repository for access checks. */
  repositoryId?: number;
  occurredAt: string;
  summary: string;
  url?: string;
  data: Record<string, unknown>;
  /** Who did it, for journals that keep only their owner's activity. */
  actor?: string;
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Activity as it is credited: notes stay private and never leave, and alerts
 * are already inbound.<slug> events.
 */
export function activityOutboxEvent(
  event: ActivityEvent,
): OutboxEvent | undefined {
  if (event.type === "note" || event.type === "alert") return undefined;
  const who = event.actor.login;
  const number = event.number ? `#${event.number} ` : "";
  const summary = {
    merge: `${who} merged ${number}in ${event.repo}${event.branch ? ` into ${event.branch}` : ""}: ${event.title}`,
    review: `${who} reviewed ${number}in ${event.repo}: ${event.title}`,
    release: `${who} released ${event.title} in ${event.repo}`,
    pr: `${who} opened ${number}in ${event.repo}: ${event.title}`,
    issue: `${who} closed ${number}in ${event.repo}: ${event.title}`,
    push: `${who} pushed ${event.commits ? plural(event.commits, "new commit") : "commits"} to ${event.branch || event.repo}${event.branch ? ` in ${event.repo}` : ""}`,
  }[event.type];
  return {
    type: `activity.${event.type}`,
    dedupeKey: `activity:${event.id}`,
    actor: event.actor.login,
    repositoryId: event.repositoryId,
    occurredAt: event.occurredAt,
    summary,
    url: event.url,
    data: {
      kind: event.type,
      actor: event.actor,
      repository: event.repo,
      title: event.title,
      number: event.number,
      branch: event.branch,
      commits: event.commits,
      additions: event.additions,
      deletions: event.deletions,
    },
  };
}

/** A pipeline that starts failing, or passes again after failing. */
export function pipelineOutboxEvent(
  repository: string,
  repositoryId: number,
  previous: PipelineState | undefined,
  next: PipelineState,
): OutboxEvent | undefined {
  const failed = next.status === "failing" && previous?.status !== "failing";
  const recovered = next.status === "passing" && previous?.status === "failing";
  if (!failed && !recovered) return undefined;
  return {
    type: failed ? "pipeline.failed" : "pipeline.recovered",
    dedupeKey: `pipeline:${repositoryId}:${next.id}:${next.headSha}:${next.status}`,
    repositoryId,
    occurredAt: next.completedAt ?? next.updatedAt,
    summary: `CI ${failed ? "is failing" : "is passing again"} for ${repository}: ${next.name} (${next.provider})`,
    url: next.url,
    data: {
      repository,
      pipeline: {
        name: next.name,
        provider: next.provider,
        status: next.status,
        previousStatus: previous?.status ?? null,
        headSha: next.headSha,
        url: next.url,
      },
    },
  };
}

/** A deployment that finishes, successfully or not. */
export function deploymentOutboxEvent(
  repository: string,
  repositoryId: number,
  previous: DeploymentState | undefined,
  next: DeploymentState,
): OutboxEvent | undefined {
  if (previous?.status === next.status) return undefined;
  if (next.status !== "successful" && next.status !== "failing")
    return undefined;
  const failed = next.status === "failing";
  return {
    type: failed ? "deployment.failed" : "deployment.succeeded",
    dedupeKey: `deployment:${repositoryId}:${next.id}:${next.status}`,
    repositoryId,
    occurredAt: next.updatedAt,
    summary: `Deployment to ${next.environment} ${failed ? "failed" : "succeeded"} for ${repository}`,
    url: next.url,
    data: {
      repository,
      deployment: {
        environment: next.environment,
        status: next.status,
        headSha: next.headSha,
        url: next.url,
      },
    },
  };
}

export interface ProbeIdentity {
  service: { id: string; name: string };
  probe: { id: string; name: string };
}
export interface IncidentChange {
  id: string;
  openedAt: string;
  resolvedAt: string | null;
}

/**
 * Probe state changes, plus incident events when a probe goes down or
 * recovers. Probe URLs and headers are private configuration and are left out.
 */
export function healthOutboxEvents(
  { service, probe }: ProbeIdentity,
  previous: HealthStatus,
  next: HealthStatus,
  result: ProbeResult,
  checkedAt: string,
  incident?: IncidentChange,
): OutboxEvent[] {
  if (previous === next && !incident) return [];
  const label = `${service.name} / ${probe.name}`;
  const base = {
    service,
    probe,
    status: next,
    previousStatus: previous,
    reason: result.reason,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
  };
  const events: OutboxEvent[] = [];
  const type =
    next === "down"
      ? "health.down"
      : next === "degraded"
        ? "health.degraded"
        : next === "healthy" && (previous === "down" || previous === "degraded")
          ? "health.recovered"
          : undefined;
  if (type)
    events.push({
      type,
      dedupeKey: `health:${probe.id}:${checkedAt}:${type}`,
      occurredAt: checkedAt,
      summary: `${label} is ${type === "health.recovered" ? "healthy again" : next}${next === "healthy" ? "" : `: ${result.reason}`}`,
      data: base,
    });
  if (incident) {
    const resolved = incident.resolvedAt !== null;
    const minutes = resolved
      ? Math.max(
          1,
          Math.round(
            (Date.parse(incident.resolvedAt!) - Date.parse(incident.openedAt)) /
              60_000,
          ),
        )
      : 0;
    events.push({
      type: resolved ? "incident.resolved" : "incident.opened",
      dedupeKey: `incident:${incident.id}:${resolved ? "resolved" : "opened"}`,
      occurredAt: checkedAt,
      summary: resolved
        ? `Resolved after ${plural(minutes, "minute")}: ${label} is healthy`
        : `Incident: ${label} is down`,
      data: {
        ...base,
        incident: {
          id: incident.id,
          openedAt: incident.openedAt,
          resolvedAt: incident.resolvedAt,
          durationSeconds: resolved
            ? Math.round(
                (Date.parse(incident.resolvedAt!) -
                  Date.parse(incident.openedAt)) /
                  1000,
              )
            : null,
        },
      },
    });
  }
  return events;
}
