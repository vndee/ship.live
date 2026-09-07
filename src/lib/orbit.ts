import type { ActivityEvent } from "../../shared/types";

export interface OrbitPosition {
  x: number;
  y: number;
  z: number;
}

export interface OrbitPoint extends OrbitPosition {
  event: ActivityEvent;
  repoIndex: number;
  time: number;
  occurredAt: number;
}

export interface OrbitModel {
  repositories: string[];
  points: OrbitPoint[];
  traces: { repo: string; strand: number; points: OrbitPosition[] }[];
}

function jitter(id: string, salt: number): number {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  }
  return hash / 4294967295;
}

/** Repository filaments are geometry; only supplied events become event points. */
export function orbitPosition(
  repoIndex: number,
  repoCount: number,
  time: number,
  radialOffset = 0,
  depthOffset = 0,
): OrbitPosition {
  const lane = repoCount > 1 ? repoIndex / (repoCount - 1) : 0.5;
  const angle = time * Math.PI * 2 - 0.4 + lane * 0.19;
  const radius = 0.49 + lane * 0.43 + radialOffset;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius * 0.82,
    z:
      Math.sin(angle + lane * 3.4) * 0.22 +
      (lane - 0.5) * 0.19 +
      Math.sin(angle * 2 + lane * 2.2) * 0.045 +
      depthOffset,
  };
}

export function buildOrbitModel(
  events: ActivityEvent[],
  repositories: string[],
  rangeStart: number,
  rangeEnd: number,
): OrbitModel {
  const orderedRepos = [
    ...new Set([...repositories, ...events.map((e) => e.repo)]),
  ]
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const indices = new Map(orderedRepos.map((repo, index) => [repo, index]));
  const duration = Math.max(1, rangeEnd - rangeStart);
  const points: OrbitPoint[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const occurredAt = Date.parse(event.occurredAt);
    if (
      seen.has(event.id) ||
      !Number.isFinite(occurredAt) ||
      occurredAt < rangeStart ||
      occurredAt > rangeEnd
    ) {
      continue;
    }
    seen.add(event.id);
    const repoIndex = indices.get(event.repo);
    if (repoIndex === undefined) continue;
    const time = (occurredAt - rangeStart) / duration;
    points.push({
      ...orbitPosition(
        repoIndex,
        orderedRepos.length,
        time,
        (jitter(event.id, 17) - 0.5) * 0.065,
        (jitter(event.id, 83) - 0.5) * 0.042,
      ),
      event,
      repoIndex,
      time,
      occurredAt,
    });
  }
  points.sort(
    (a, b) =>
      b.occurredAt - a.occurredAt ||
      (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0),
  );

  // Fewer filaments at high repository counts keeps the actual events legible.
  const strands = orderedRepos.length > 16 ? [0] : [-2, -1, 0, 1, 2];
  const traces = orderedRepos.flatMap((repo, repoIndex) =>
    strands.map((strand) => ({
      repo,
      strand,
      points: Array.from({ length: 129 }, (_, step) =>
        orbitPosition(
          repoIndex,
          orderedRepos.length,
          step / 128,
          strand * 0.012,
          strand * 0.005,
        ),
      ),
    })),
  );
  return { repositories: orderedRepos, points, traces };
}

export function visibleOrbitPoints(
  model: OrbitModel,
  cutoff: number,
): OrbitPoint[] {
  return model.points.filter((point) => point.occurredAt <= cutoff);
}

/** Project to camera space first so the renderer can fit the complete geometry. */
export function projectOrbitPosition(
  point: OrbitPosition,
  yaw: number,
  pitch: number,
): OrbitPosition & { perspective: number } {
  return createOrbitProjector(yaw, pitch)(point);
}

/** Cache camera trigonometry once per frame, rather than once per filament point. */
export function createOrbitProjector(yaw: number, pitch: number) {
  const cosineYaw = Math.cos(yaw);
  const sineYaw = Math.sin(yaw);
  const cosinePitch = Math.cos(pitch);
  const sinePitch = Math.sin(pitch);
  return (point: OrbitPosition): OrbitPosition & { perspective: number } => {
    const x = point.x * cosineYaw + point.z * sineYaw;
    const z = -point.x * sineYaw + point.z * cosineYaw;
    const y = point.y * cosinePitch - z * sinePitch;
    const depth = point.y * sinePitch + z * cosinePitch;
    const perspective = 4 / (4 - depth);
    return { x: x * perspective, y: y * perspective, z: depth, perspective };
  };
}
