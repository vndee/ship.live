import type { PulseRange } from "../../shared/pulse";
import type { DeploymentState, PipelineState } from "../../shared/wall";

/** UTC calendar selection: inclusive start, exclusive end, never future data. */
export function inPeriod(
  value: string | undefined,
  range: PulseRange,
  now: number,
): boolean {
  const time = Date.parse(value ?? "");
  return (
    Number.isFinite(time) &&
    time >= Date.parse(range.start) &&
    time < Date.parse(range.end) &&
    time <= now
  );
}

export function deploymentTime(deployment: DeploymentState): string {
  return (deployment.status === "successful" ||
    deployment.status === "inactive") &&
    deployment.succeededAt
    ? deployment.succeededAt
    : deployment.updatedAt;
}

export function pipelineInPeriod(
  pipeline: PipelineState,
  range: PulseRange,
  now: number,
): boolean {
  return [pipeline.updatedAt, pipeline.startedAt, pipeline.completedAt].some(
    (value) => inPeriod(value, range, now),
  );
}
