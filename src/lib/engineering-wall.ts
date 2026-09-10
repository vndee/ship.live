import type { ActivityEvent } from "../../shared/types.js";
import type {
  EngineeringWallSnapshot,
  PipelineState,
} from "../../shared/wall.js";
import type { HealthSnapshot } from "../../shared/health.js";

export type WallScene =
  "pulse" | "review" | "release" | "health" | "leaderboard";
export interface ReviewRadarItem {
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  ageMs: number;
  state: "failing" | "running" | "ready" | "waiting";
  checks: PipelineState[];
}

function latestPipelines(pipelines: PipelineState[]): PipelineState[] {
  const latest = new Map<string, PipelineState>();
  for (const pipeline of pipelines) {
    const key = `${pipeline.headSha}:${pipeline.provider}:${pipeline.name}`;
    const current = latest.get(key);
    if (
      !current ||
      Date.parse(current.updatedAt) <= Date.parse(pipeline.updatedAt)
    )
      latest.set(key, pipeline);
  }
  return [...latest.values()];
}

function latestReviews(
  reviews: EngineeringWallSnapshot["repositories"][number]["reviews"],
) {
  const latest = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    const current = latest.get(review.reviewer.toLowerCase());
    if (
      !current ||
      Date.parse(current.submittedAt) <= Date.parse(review.submittedAt)
    )
      latest.set(review.reviewer.toLowerCase(), review);
  }
  return [...latest.values()];
}

export function getReviewRadar(
  snapshot: EngineeringWallSnapshot,
  now = Date.now(),
): ReviewRadarItem[] {
  const result: ReviewRadarItem[] = [];
  for (const repository of snapshot.repositories)
    for (const pull of repository.pullRequests) {
      if (pull.state !== "open" || pull.draft) continue;
      const checks = latestPipelines(
        repository.pipelines.filter((item) => item.headSha === pull.headSha),
      );
      const decisions = latestReviews(
        repository.reviews.filter(
          (item) => item.pullRequestNumber === pull.number,
        ),
      );
      const approved = decisions.some((item) => item.decision === "approved");
      const changesRequested = decisions.some(
        (item) => item.decision === "changes_requested",
      );
      const state = checks.some((item) => item.status === "failing")
        ? "failing"
        : checks.some(
              (item) => item.status === "running" || item.status === "queued",
            )
          ? "running"
          : approved &&
              !changesRequested &&
              checks.length > 0 &&
              checks.every((item) => item.status === "passing") &&
              pull.mergeable !== false
            ? "ready"
            : "waiting";
      result.push({
        repository: repository.repository,
        number: pull.number,
        title: pull.title,
        url: pull.url,
        author: pull.author,
        ageMs: Math.max(0, now - Date.parse(pull.createdAt)),
        state,
        checks,
      });
    }
  const priority = { failing: 0, ready: 1, running: 2, waiting: 3 };
  return result
    .sort((a, b) => priority[a.state] - priority[b.state] || b.ageMs - a.ageMs)
    .slice(0, 8);
}

export function getReleasePulse(snapshot: EngineeringWallSnapshot) {
  const latest = new Map<string, ReturnType<typeof deploymentWithRepository>>();
  for (const item of snapshot.repositories.flatMap((repository) =>
    repository.deployments.map((deployment) =>
      deploymentWithRepository(repository, deployment),
    ),
  )) {
    const key = `${item.repository}:${item.environment}`;
    const current = latest.get(key);
    if (!current || Date.parse(current.updatedAt) <= Date.parse(item.updatedAt))
      latest.set(key, item);
  }
  return [...latest.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 6);
}

function deploymentWithRepository(
  repository: EngineeringWallSnapshot["repositories"][number],
  deployment: EngineeringWallSnapshot["repositories"][number]["deployments"][number],
) {
  return {
    ...deployment,
    repository: repository.repository,
    checks: latestPipelines(
      repository.pipelines.filter(
        (pipeline) => pipeline.headSha === deployment.headSha,
      ),
    ),
  };
}

function windowSummary(events: ActivityEvent[], start: number, now: number) {
  const current = events.filter((event) => {
    const at = Date.parse(event.occurredAt);
    return at >= start && at <= now;
  });
  return {
    total: current.length,
    merges: current.filter((event) => event.type === "merge").length,
    reviews: current.filter((event) => event.type === "review").length,
    releases: current.filter((event) => event.type === "release").length,
    contributors: new Set(
      current.map((event) => event.actor.login.toLowerCase()),
    ).size,
  };
}

export function getWhatChanged(events: ActivityEvent[], now = Date.now()) {
  return {
    hour: windowSummary(events, now - 3_600_000, now),
    day: windowSummary(events, now - 86_400_000, now),
  };
}

export function getAttention(
  snapshot: EngineeringWallSnapshot,
  health?: HealthSnapshot,
) {
  const down = health?.services.find((service) => service.status === "down");
  if (down)
    return {
      kind: "health" as const,
      title: `${down.name} is down`,
      updatedAt: health!.updatedAt,
    };
  const failedDeployment = getReleasePulse(snapshot).find(
    (item) => item.status === "failing",
  );
  if (failedDeployment)
    return {
      kind: "deployment" as const,
      title: `${failedDeployment.repository} deployment failed`,
      url: failedDeployment.url,
      updatedAt: failedDeployment.updatedAt,
    };
  for (const repository of snapshot.repositories) {
    const openHeads = new Set(
      repository.pullRequests
        .filter((pull) => pull.state === "open")
        .map((pull) => pull.headSha),
    );
    const pipeline = latestPipelines(repository.pipelines)
      .filter((item) => openHeads.has(item.headSha))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .find((item) => item.status === "failing");
    if (pipeline)
      return {
        kind: "ci" as const,
        title: `${repository.repository} · ${pipeline.name} failed`,
        url: pipeline.url,
        updatedAt: pipeline.updatedAt,
      };
  }
  return null;
}

export function getAvailableScenes(
  snapshot: EngineeringWallSnapshot,
  events: ActivityEvent[],
  health?: HealthSnapshot,
): WallScene[] {
  const scenes: WallScene[] = ["pulse"];
  if (getReviewRadar(snapshot).length) scenes.push("review");
  if (getReleasePulse(snapshot).length) scenes.push("release");
  if (health?.services.length) scenes.push("health");
  scenes.push("leaderboard");
  return scenes;
}
