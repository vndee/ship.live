import { useMemo, useState } from "react";
import { ArrowUpRight, Flag, FolderGit2 } from "lucide-react";
import type { PulseSelection } from "../../shared/pulse";
import { getDashboardPulse } from "../lib/dashboardPulse";
import {
  usePulseLocation,
  setPulseLocation,
  usePulseOverview,
  type PulseSource,
} from "../hooks/usePulse";
import { PulseRangePicker } from "./PulseRangePicker";
import "../pulse-range.css";
export function PulseOverview({
  source,
  now,
  onHistory,
  onMilestones,
}: {
  source: PulseSource;
  now: number;
  onHistory: (from: string, to: string, repo?: string) => void;
  onMilestones?: () => void;
}) {
  const { selection } = usePulseLocation();
  const result = usePulseOverview(source, selection, now);
  const [showAll, setShowAll] = useState(false);
  const pulse = useMemo(
    () => getDashboardPulse(source.events, now),
    [source.events, now],
  );
  const goal = pulse.nextMilestone;
  const data = result.data;
  const max = Math.max(1, ...(data?.buckets.map((b) => b.count) || []));
  const onChange = (next: PulseSelection) => {
    setShowAll(false);
    setPulseLocation(next);
  };
  return (
    <section className="pulse-overview" aria-label="Overview by date">
      <PulseRangePicker selection={selection} now={now} onChange={onChange} />
      {result.error ? (
        <div className="pulse-range-state" role="alert" data-pulse-error>
          {result.error}
          <button className="text-button" onClick={result.retry}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <p className="pulse-range-state" role="status">
          Loading activity for this period…
        </p>
      ) : (
        <>
          <div className="pulse-period-heading">
            <div>
              <h2>Activity in this period</h2>
              <p>
                {data.range.from} — {data.range.to} · UTC
              </p>
            </div>
            <button
              className="text-button"
              onClick={() => onHistory(data.range.from, data.range.to)}
            >
              View activity in this period <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="pulse-range-totals">
            <div>
              <strong data-pulse-total>
                {data.totals.count.toLocaleString()}
              </strong>
              <span>contributions</span>
            </div>
            {(["merges", "reviews", "releases"] as const).map((kind) => (
              <div key={kind}>
                <strong>{data.totals[kind].toLocaleString()}</strong>
                <span>{kind}</span>
              </div>
            ))}
          </div>
          <div
            className="pulse-range-chart"
            aria-label={`${data.range.granularity === "day" ? "Daily" : "Weekly"} contributions`}
          >
            {data.buckets.map((bucket, index) => (
              <button
                key={bucket.from}
                type="button"
                className="pulse-range-bucket"
                onClick={() => onHistory(bucket.from, bucket.to)}
                aria-label={`${bucket.from}${bucket.to !== bucket.from ? ` to ${bucket.to}` : ""}: ${bucket.count} contributions`}
                title={`${bucket.from} — ${bucket.to}: ${bucket.count} contributions`}
              >
                <span className="pulse-range-column">
                  <span style={{ height: `${(bucket.count / max) * 100}%` }} />
                </span>
                <span className="pulse-bucket-label">
                  {index === 0 ||
                  index === data.buckets.length - 1 ||
                  data.buckets.length <= 12 ||
                  index % Math.ceil(data.buckets.length / 10) === 0
                    ? bucket.from.slice(5)
                    : "\u00a0"}
                </span>
              </button>
            ))}
          </div>
          {!data.totals.count && (
            <p className="pulse-range-state">
              No stored activity in this period.
            </p>
          )}
          <section
            className="repository-section"
            aria-label="Repositories in this period"
          >
            <div className="scene-header">
              <div>
                <h2>Repositories</h2>
                <p>Contributions in the selected period · UTC</p>
              </div>
              <span className="scene-chip">
                {data.repositories.length} total
              </span>
            </div>
            <ul className="scene-list">
              {(showAll
                ? data.repositories
                : data.repositories.slice(0, 6)
              ).map((item) => (
                <li key={item.repo}>
                  <button
                    className="scene-row"
                    aria-label={`View activity for ${item.repo}`}
                    onClick={() =>
                      onHistory(data.range.from, data.range.to, item.repo)
                    }
                  >
                    <span className="scene-avatar">
                      <FolderGit2 size={15} />
                    </span>
                    <span className="scene-row-body">
                      <strong>{item.repo.split("/").pop()}</strong>
                      <small>{item.repo}</small>
                    </span>
                    <span className="repository-stats">
                      <span>
                        <b>{item.count}</b> contributions
                      </span>
                      <span>
                        <b>{item.merges}</b> merges · <b>{item.reviews}</b>{" "}
                        reviews
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {data.repositories.length > 6 && (
              <button
                className="text-button"
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll
                  ? "Show fewer"
                  : `Show all ${data.repositories.length}`}
              </button>
            )}
          </section>
          <p className="pulse-coverage">
            {source.demo
              ? "Fictional demo data."
              : "Totals reflect stored activity visible to you. GitHub imports cover limited history; push history starts with webhooks."}{" "}
            {data.coverage.earliestStoredAt &&
              `Earliest stored contribution: ${data.coverage.earliestStoredAt.slice(0, 10)}. `}
            {data.coverage.retentionDays !== null &&
              `Retention: ${data.coverage.retentionDays} days. `}
            Historical completeness is not guaranteed.
          </p>
        </>
      )}
      <section className="pulse-weekly-goal">
        <div>
          <Flag size={14} />
          <h2>This week’s team milestone</h2>
          {onMilestones && (
            <button
              className="icon-button"
              aria-label="View team milestones"
              onClick={onMilestones}
            >
              <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        <p>
          {goal
            ? `${goal.title} · ${goal.progress}/${goal.target}`
            : "Every milestone reached this week."}
        </p>
        <small>Monday–Sunday · UTC · live</small>
      </section>
    </section>
  );
}
