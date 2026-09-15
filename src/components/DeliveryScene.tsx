import { useMemo, useState } from "react";
import type { PulseRange } from "../../shared/pulse";
import type { HealthSnapshot } from "../../shared/health";
import type { EngineeringWallSnapshot } from "../../shared/wall";
import { deliveryMetrics, formatDuration } from "../lib/delivery-metrics";
import { Picker } from "./Picker";
import { SceneHeader } from "./SceneHeader";

const perWeek = (value: number | null) =>
  value === null
    ? "—"
    : value >= 10
      ? String(Math.round(value))
      : String(Math.round(value * 10) / 10);
const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
const weekLabel = (start: string) =>
  new Date(`${start}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * Team delivery in the spirit of DORA: how often the team ships to one
 * environment and how quickly it recovers. It describes the team, never a
 * person, and compares each figure with the 30 days before.
 */
export function DeliveryScene({
  snapshot,
  health,
  now,
  range,
}: {
  snapshot: EngineeringWallSnapshot;
  health?: HealthSnapshot;
  now: number;
  range?: PulseRange;
}) {
  const [chosen, setChosen] = useState<string>();
  const metrics = useMemo(
    () => deliveryMetrics(snapshot, health, now, chosen, range),
    [snapshot, health, now, chosen, range],
  );
  const { current, previous, environment } = metrics;
  const grouping = range?.granularity ?? "week";
  const periodLabel = range
    ? `${weekLabel(range.from)}–${weekLabel(range.to)} UTC`
    : "the last 30 days";
  const finished = current.deployments + current.failures;
  const figures: {
    label: string;
    value: string;
    detail: string;
    before: string | null;
  }[] = [
    {
      label: "Deployments per week",
      value: perWeek(current.deploymentsPerWeek),
      detail: environment
        ? `${current.deployments} successful to ${environment}`
        : "No deployments reported",
      before:
        previous.deploymentsPerWeek === null || !previous.deployments
          ? null
          : perWeek(previous.deploymentsPerWeek),
    },
    {
      label: "Change failure rate",
      value: percent(current.changeFailureRate),
      detail: `${current.failures} of ${finished} ${finished === 1 ? "deployment" : "deployments"} failed`,
      before:
        previous.changeFailureRate === null
          ? null
          : percent(previous.changeFailureRate),
    },
    {
      label: "Time to restore",
      value: formatDuration(current.timeToRestoreMs),
      detail: "From a failed deployment to the next success",
      before:
        previous.timeToRestoreMs === null
          ? null
          : formatDuration(previous.timeToRestoreMs),
    },
    {
      label: "Time to merge",
      value: formatDuration(current.timeToMergeMs),
      detail: `${current.merged} pull ${current.merged === 1 ? "request" : "requests"} merged`,
      before:
        previous.timeToMergeMs === null
          ? null
          : formatDuration(previous.timeToMergeMs),
    },
  ];
  const peak = Math.max(
    1,
    ...metrics.weeks.map((week) => week.deployments + week.failures),
  );
  return (
    <>
      <SceneHeader
        title="Delivery"
        description={`How often the team ships and how quickly it recovers, over ${periodLabel}.`}
      >
        {metrics.environments.length > 1 && (
          <Picker
            label="Environment"
            value={environment ?? metrics.environments[0]}
            options={metrics.environments.map((item) => ({
              value: item,
              label: item,
            }))}
            onChange={setChosen}
          />
        )}
      </SceneHeader>
      <div className="delivery-body">
        <div className="delivery-figures">
          {figures.map((figure) => (
            <div className="delivery-figure" key={figure.label}>
              <span>{figure.label}</span>
              <strong>{figure.value}</strong>
              <small>{figure.detail}</small>
              {figure.before !== null && (
                <small className="delivery-before">
                  {figure.before}{" "}
                  {range
                    ? "in the preceding period of equal duration"
                    : "in the 30 days before"}
                </small>
              )}
            </div>
          ))}
        </div>
        {environment && (
          <div className="delivery-weeks">
            <div className="delivery-weeks-legend">
              <span>
                <i className="delivery-successful" aria-hidden="true" />
                Deployments
              </span>
              <span>
                <i className="delivery-failing" aria-hidden="true" />
                Failed
              </span>
              <span className="delivery-weeks-scope">
                {environment}, by {grouping}
              </span>
            </div>
            <div
              className="delivery-weeks-bars"
              data-period={range ? true : undefined}
              style={
                range
                  ? {
                      gridTemplateColumns: `repeat(${metrics.weeks.length}, minmax(0, 1fr))`,
                      columnGap:
                        metrics.weeks.length > 31
                          ? 2
                          : metrics.weeks.length > 16
                            ? 4
                            : undefined,
                    }
                  : undefined
              }
              role="img"
              aria-label={`Deployments to ${environment} by ${grouping}, oldest first: ${metrics.weeks
                .map(
                  (week) =>
                    `${grouping} starting ${week.start}, ${week.deployments} successful and ${week.failures} failed`,
                )
                .join("; ")}`}
            >
              {metrics.weeks.map((week, index) => (
                <div
                  className="delivery-week"
                  key={week.start}
                  title={`${grouping === "day" ? "Day" : "Week starting"} ${weekLabel(week.start)}: ${week.deployments} successful, ${week.failures} failed`}
                >
                  <div className="delivery-week-stack">
                    {week.deployments > 0 && (
                      <span
                        className="delivery-successful"
                        style={{
                          height: `${(week.deployments / peak) * 100}%`,
                        }}
                      />
                    )}
                    {week.failures > 0 && (
                      <span
                        className="delivery-failing"
                        style={{ height: `${(week.failures / peak) * 100}%` }}
                      />
                    )}
                  </div>
                  <small>
                    {!range ||
                    metrics.weeks.length <= 8 ||
                    index === 0 ||
                    index === metrics.weeks.length - 1 ||
                    index % Math.ceil(metrics.weeks.length / 6) === 0
                      ? range
                        ? week.start.slice(5)
                        : weekLabel(week.start)
                      : "\u00a0"}
                  </small>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="delivery-note">
          {current.incidents > 0 &&
            `Service Health had ${metrics.incidentsCapped ? "at least " : ""}${current.incidents} ${current.incidents === 1 ? "incident" : "incidents"}${current.incidentRestoreMs === null ? "" : `, restored in ${formatDuration(current.incidentRestoreMs)} at the median`}. `}
          Lead time is shown as time to merge: GitHub does not link a deployment
          to the pull requests it ships. These figures describe the team, never
          a person.
        </p>
      </div>
    </>
  );
}
