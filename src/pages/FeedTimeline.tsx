import { clock } from "../lib/format";
import type { Period } from "../lib/routes";

/** Scrubs the Live feed back through its period; Now returns to live activity. */
export function FeedTimeline({
  start,
  end,
  period,
  percent,
  cutoff,
  live,
  onScrub,
  onNow,
}: {
  start: number;
  end: number;
  period: Period;
  percent: number;
  cutoff: number;
  live: boolean;
  onScrub: (percent: number) => void;
  onNow: () => void;
}) {
  return (
    <div className="timeline">
      <div className="timeline-track">
        <label className="sr-only" htmlFor="activity-timeline">
          Activity timeline
        </label>
        <input
          id="activity-timeline"
          type="range"
          min="0"
          max="100"
          step="0.1"
          value={percent}
          aria-valuetext={clock(cutoff, period)}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <div className="timeline-labels">
          {[0, 0.25, 0.5, 0.75, 1].map((fraction, i) => (
            <span key={fraction} className={i % 2 ? "minor-tick" : ""}>
              {clock(start + (end - start) * fraction, period)}
            </span>
          ))}
        </div>
      </div>
      <button
        className={`timeline-now ${live ? "is-live" : ""}`}
        onClick={onNow}
        aria-label="Return to latest activity"
      >
        <span />
        Now
      </button>
    </div>
  );
}
