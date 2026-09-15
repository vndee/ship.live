import type { ActivityEvent } from "../../shared/types.js";
import type {
  EngineeringWallSnapshot,
  PipelineState,
} from "../../shared/wall.js";
import type { HealthSnapshot } from "../../shared/health.js";
import { getCreditedEvents, getWeekStart } from "./activity.js";

export type WallScene =
  "pulse" | "review" | "release" | "delivery" | "health" | "leaderboard";
export const ALL_SCENES: readonly WallScene[] = [
  "pulse",
  "review",
  "release",
  "delivery",
  "health",
  "leaderboard",
];

export interface WallTabs {
  /** Every scene, in the viewer's order. */
  order: WallScene[];
  hidden: WallScene[];
}

const isScene = (value: unknown): value is WallScene =>
  ALL_SCENES.includes(value as WallScene);

/**
 * A viewer's stored tab order and hidden tabs. Unknown values are ignored;
 * scenes missing from a stored order keep their default place at the end.
 */
export function parseWallTabs(raw: string | null): WallTabs {
  let value: unknown = null;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    // Treat unreadable storage as no preference.
  }
  const stored =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const order = [
    ...new Set(Array.isArray(stored.order) ? stored.order.filter(isScene) : []),
  ];
  const hidden = Array.isArray(stored.hidden) ? stored.hidden : [];
  return {
    order: [...order, ...ALL_SCENES.filter((scene) => !order.includes(scene))],
    hidden: ALL_SCENES.filter((scene) => hidden.includes(scene)),
  };
}

/** Available scenes in the viewer's order minus hidden ones, never empty. */
export function visibleScenes(
  available: WallScene[],
  tabs: WallTabs,
): WallScene[] {
  const shown = tabs.order.filter(
    (scene) => available.includes(scene) && !tabs.hidden.includes(scene),
  );
  return shown.length ? shown : available.slice(0, 1);
}

/** Swap a scene with its neighbor among the scenes the viewer can choose. */
export function moveScene(
  order: WallScene[],
  scene: WallScene,
  offset: -1 | 1,
  among: readonly WallScene[] = order,
): WallScene[] {
  const peers = order.filter((item) => among.includes(item));
  const index = peers.indexOf(scene);
  const target = index < 0 ? undefined : peers[index + offset];
  if (!target) return order;
  return order.map((item) =>
    item === scene ? target : item === target ? scene : item,
  );
}

export interface RepositoryActivity {
  repository: string;
  /** Activity this UTC week. */
  weekly: number;
  merges: number;
  reviews: number;
  latestAt: string;
}

/** Per-repository activity from human events, most active this week first. */
export function getRepositoryActivity(
  events: ActivityEvent[],
  now = Date.now(),
): RepositoryActivity[] {
  const weekStart = getWeekStart(now).getTime();
  const repositories = new Map<string, RepositoryActivity>();
  for (const { event } of getCreditedEvents(events, now)) {
    const at = Date.parse(event.occurredAt);
    const entry = repositories.get(event.repo) ?? {
      repository: event.repo,
      weekly: 0,
      merges: 0,
      reviews: 0,
      latestAt: event.occurredAt,
    };
    if (at > Date.parse(entry.latestAt)) entry.latestAt = event.occurredAt;
    if (at >= weekStart) {
      entry.weekly += 1;
      entry.merges += Number(event.type === "merge");
      entry.reviews += Number(event.type === "review");
    }
    repositories.set(event.repo, entry);
  }
  return [...repositories.values()].sort(
    (a, b) =>
      b.weekly - a.weekly ||
      Date.parse(b.latestAt) - Date.parse(a.latestAt) ||
      a.repository.localeCompare(b.repository),
  );
}
export interface ReviewRadarItem {
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  avatarUrl?: string;
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
        avatarUrl: pull.authorAvatarUrl,
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
    return event.type !== "alert" && at >= start && at <= now;
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

/**
 * Review Radar is always offered (with an empty state), and Service Health
 * whenever health data is available. Release Pulse needs deployments.
 */
export function getAvailableScenes(
  snapshot: EngineeringWallSnapshot,
  events: ActivityEvent[],
  health?: HealthSnapshot,
): WallScene[] {
  const scenes: WallScene[] = ["pulse", "review"];
  if (getReleasePulse(snapshot).length) scenes.push("release");
  // Delivery needs something finished to measure: a deployment or a merge.
  if (
    snapshot.repositories.some(
      (repository) =>
        repository.deployments.some(
          (deployment) =>
            deployment.status === "successful" ||
            deployment.status === "failing" ||
            (deployment.status === "inactive" &&
              deployment.succeededAt !== undefined),
        ) || repository.pullRequests.some((pull) => pull.state === "merged"),
    )
  )
    scenes.push("delivery");
  if (health) scenes.push("health");
  scenes.push("leaderboard");
  return scenes;
}

/** Compact age for wall rows: "now", "12m", "5h", "3d". */
export function shortAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
