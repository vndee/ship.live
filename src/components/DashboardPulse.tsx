import { useMemo } from "react";
import {
  ArrowUpRight,
  Flag,
  GitMerge,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types";
import { getDashboardPulse } from "../lib/dashboardPulse";

export function DashboardPulse({
  events,
  now,
  onMilestones,
}: {
  events: ActivityEvent[];
  now: number;
  onMilestones?: () => void;
}) {
  const pulse = useMemo(() => getDashboardPulse(events, now), [events, now]);
  const max = Math.max(1, ...pulse.days.map((day) => day.count));
  const goal = pulse.nextMilestone;
  const contribution =
    goal?.kind === "merge"
      ? "merge"
      : goal?.kind === "review"
        ? "review"
        : "release";
  return (
    <section className="dashboard-pulse" aria-label="Team activity insights">
      <div className="pulse-today">
        <div className="pulse-label">
          <Sparkles size={14} />
          <h2>Today’s momentum</h2>
          <span>UTC</span>
        </div>
        <div className="pulse-total">
          <strong>{pulse.today.count}</strong>
          <span>contributions today</span>
        </div>
        <p>
          <span>
            <GitMerge size={12} /> {pulse.today.merges} merges
          </span>
          <span>
            <MessageSquare size={12} /> {pulse.today.reviews} reviews
          </span>
        </p>
      </div>
      <div className="pulse-rhythm">
        <div className="pulse-label">
          <h2>The last 7 days</h2>
          <span>{pulse.total} contributions</span>
        </div>
        <div
          className="rhythm-chart"
          role="img"
          aria-label={pulse.days
            .map((day) => `${day.date}: ${day.count} contributions`)
            .join("; ")}
        >
          {pulse.days.map((day, index) => (
            <div
              key={day.date}
              className={index === 6 ? "is-today" : ""}
              title={`${day.date}: ${day.count} contributions`}
            >
              <div className="rhythm-column">
                <span style={{ height: `${(day.count / max) * 100}%` }} />
              </div>
              <span>{day.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="pulse-milestone">
        <div className="pulse-label">
          <Flag size={14} />
          <h2>{goal ? "Next team milestone" : "A week to celebrate"}</h2>
          {onMilestones && (
            <button
              className="icon-button"
              aria-label="View team milestones"
              onClick={onMilestones}
            >
              <ArrowUpRight size={15} />
            </button>
          )}
        </div>
        <h3>{goal?.title || "Every milestone reached"}</h3>
        <p>
          {goal
            ? `${pulse.remaining} more ${contribution}${pulse.remaining === 1 ? "" : "s"} to reach ${goal.target}.`
            : "All three goals reached together. Keep shipping!"}
        </p>
        <div className="pulse-goal">
          <div
            className="goal-track"
            role="progressbar"
            aria-label={goal?.title || "Weekly milestones complete"}
            aria-valuemin={0}
            aria-valuemax={goal?.target || 3}
            aria-valuenow={goal?.progress ?? 3}
          >
            <span
              style={{
                width: `${goal ? (goal.progress / goal.target) * 100 : 100}%`,
              }}
            />
          </div>
          <span>{goal ? `${goal.progress}/${goal.target}` : "3/3"}</span>
        </div>
      </div>
    </section>
  );
}
