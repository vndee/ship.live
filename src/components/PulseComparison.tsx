import type { PulseActivityKind, PulseOverview } from "../../shared/pulse";
import "../pulse-comparison.css";

function comparisonCoverage(
  range: PulseOverview["range"],
  coverage: PulseOverview["coverage"],
  generatedAt: string,
) {
  const beforeHistory =
    !!coverage.earliestStoredAt &&
    range.from < coverage.earliestStoredAt.slice(0, 10);
  const beforeRetention =
    coverage.retentionDays !== null &&
    Date.parse(range.start) <
      Date.parse(generatedAt) - coverage.retentionDays * 86400000;
  return {
    limited: beforeHistory || beforeRetention,
    beforeHistory,
    beforeRetention,
  };
}
export function PulseComparison({
  data,
  demo,
  onHistory,
}: {
  data: PulseOverview;
  demo: boolean;
  onHistory: (
    from: string,
    to: string,
    repo?: string,
    kind?: PulseActivityKind,
  ) => void;
}) {
  const comparison = data.comparison;
  if (!comparison) return null;
  const { previous, currentParticipants, currentIncomplete } = comparison;
  const metrics = [
    {
      label: "Merges",
      kind: "merge" as const,
      current: data.totals.merges,
      previous: previous.totals.merges,
    },
    {
      label: "Releases",
      kind: "release" as const,
      current: data.totals.releases,
      previous: previous.totals.releases,
    },
    {
      label: "Reviews",
      kind: "review" as const,
      current: data.totals.reviews,
      previous: previous.totals.reviews,
    },
    {
      label: "Participating contributors",
      kind: "contribution" as const,
      current: currentParticipants,
      previous: previous.participants,
    },
  ];
  return (
    <section
      className="pulse-comparison"
      aria-label="Previous period comparison"
    >
      <div className="pulse-comparison-heading">
        <h2>Compared with the previous period</h2>
        <p>Equal-length calendar periods · UTC</p>
      </div>
      {currentIncomplete && (
        <p className="pulse-comparison-incomplete">
          Current period incomplete — today is still in progress.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th scope="col">Contribution</th>
            <th scope="col">
              Current{" "}
              <small>
                {data.range.from}
                <br />— {data.range.to}
              </small>
            </th>
            <th scope="col">
              Previous{" "}
              <small>
                {previous.range.from}
                <br />— {previous.range.to}
              </small>
            </th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => {
            const delta = metric.current - metric.previous;
            return (
              <tr key={metric.label}>
                <th scope="row">{metric.label}</th>
                {(["current", "previous"] as const).map((period) => {
                  const range =
                    period === "current" ? data.range : previous.range;
                  return (
                    <td key={period}>
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`View ${period} period ${metric.label.toLowerCase()}: ${metric[period]}`}
                        onClick={() =>
                          onHistory(
                            range.from,
                            range.to,
                            undefined,
                            metric.kind,
                          )
                        }
                      >
                        {metric[period].toLocaleString()}
                      </button>
                    </td>
                  );
                })}
                <td
                  className="pulse-comparison-delta"
                  aria-label={`${metric.label}: ${delta > 0 ? "increase" : delta < 0 ? "decrease" : "no change"} ${Math.abs(delta)}`}
                >
                  {delta > 0 ? "+" : delta < 0 ? "−" : ""}
                  {Math.abs(delta).toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="pulse-comparison-definition">
        Participating contributors are distinct people with stored contributions
        in each period. Select a count to view its contributions.
      </p>
      <div className="pulse-comparison-coverage">
        {[
          { label: "Current", range: data.range, coverage: data.coverage },
          {
            label: "Previous",
            range: previous.range,
            coverage: previous.coverage,
          },
        ].map((period) => {
          const status = comparisonCoverage(
            period.range,
            period.coverage,
            data.generatedAt,
          );
          return (
            <p key={period.label}>
              <strong>
                {period.label} period:{" "}
                {demo
                  ? "Demo data"
                  : status.limited
                    ? "Limited history"
                    : "Completeness unknown"}
                .
              </strong>
              {demo ? (
                " Fictional demo data."
              ) : (
                <>
                  {status.beforeHistory && (
                    <>
                      {" "}
                      Starts before the earliest stored contribution (
                      {period.coverage.earliestStoredAt!.slice(0, 10)}).
                    </>
                  )}
                  {status.beforeRetention && (
                    <>
                      {" "}
                      Includes dates outside the {period.coverage.retentionDays}
                      -day retention window.
                    </>
                  )}
                  {!period.coverage.earliestStoredAt && (
                    <> No stored contributions yet.</>
                  )}
                </>
              )}
            </p>
          );
        })}
        {!demo && (
          <p>
            Both periods use stored contributions visible to you. Imports cover
            limited history; missing history can affect the change shown.
          </p>
        )}
      </div>
    </section>
  );
}
