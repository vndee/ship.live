import { useId, useState, type ElementType, type KeyboardEvent } from "react";
import {
  CheckCheck,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  NotebookPen,
  Rocket,
} from "lucide-react";
import type { ActivityType } from "../../shared/types";
import { HEATMAP_WEEKS, type ContributorDay } from "../lib/contributor";
import "../contributor-profile.css";

export const ACTIVITY_ICONS: Record<ActivityType, ElementType> = {
  merge: GitMerge,
  review: MessageSquare,
  push: GitCommitHorizontal,
  issue: CheckCheck,
  release: Rocket,
  pr: GitPullRequest,
  note: NotebookPen,
};
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);
export const dayLabel = (date: string) =>
  utcDate(date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const monthLabel = (date: string) =>
  utcDate(date).toLocaleDateString(undefined, {
    month: "short",
    timeZone: "UTC",
  });
export const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
export const shortRepo = (repo: string) =>
  repo === "journal/notes" ? "Ship notes" : repo.split("/").pop() || repo;
export function ago(timestamp: string, now: number) {
  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(timestamp)) / 60000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
/** A clean axis top: 1, 2 or 5 times a power of ten. */
function niceMax(value: number) {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].find((step) => step * magnitude >= value)! * magnitude;
}
/** Four steps of one hue for magnitude; zero stays the empty track. */
const heatLevel = (count: number, max: number) =>
  count === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4));
const arrowStep = (key: string, steps: Record<string, number>) =>
  key in steps ? steps[key] : null;

/** Daily contributions over whole UTC weeks, explorable by pointer or keyboard. */
export function ActivityHeatmap({
  cells,
  showXp = true,
}: {
  cells: (ContributorDay | null)[];
  showXp?: boolean;
}) {
  const id = useId();
  const [heatIndex, setHeatIndex] = useState<number | null>(null);
  const lastDay = cells.reduce((last, cell, index) => (cell ? index : last), 0);
  const maxCount = Math.max(1, ...cells.map((cell) => cell?.count ?? 0));
  const heatTotal = cells.reduce((sum, cell) => sum + (cell?.count ?? 0), 0);
  const activeCell = heatIndex === null ? null : cells[heatIndex];
  const month = (week: number) =>
    cells[week * 7] ? monthLabel(cells[week * 7]!.date) : "";
  // A month label sits over the week it starts in; the first column only gets
  // one when the next column is still in the same month, so labels never touch.
  const months = Array.from({ length: HEATMAP_WEEKS }, (_, week) =>
    week === 0
      ? month(1) === month(0)
        ? month(0)
        : ""
      : month(week) !== month(week - 1)
        ? month(week)
        : "",
  );
  function explore(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") return setHeatIndex(null);
    const step = arrowStep(event.key, {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -7,
      ArrowRight: 7,
    });
    if (step === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const key = event.key;
    setHeatIndex((current) => {
      if (key === "Home") return 0;
      if (key === "End") return lastDay;
      return Math.max(0, Math.min(lastDay, (current ?? lastDay) + step!));
    });
  }
  return (
    <section className="profile-card" aria-labelledby={`${id}-title`}>
      <div className="profile-card-heading">
        <h3 id={`${id}-title`}>Activity</h3>
        <span>{HEATMAP_WEEKS} weeks · UTC</span>
      </div>
      <div className="heatmap">
        <div
          className="heatmap-months"
          aria-hidden="true"
          style={{
            gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, var(--heat-cell))`,
          }}
        >
          {months.map((label, week) => (
            <span key={week}>{label}</span>
          ))}
        </div>
        <div className="heatmap-days" aria-hidden="true">
          {WEEKDAYS.map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>
        <div
          className="heatmap-grid"
          role="group"
          aria-label={`Daily contributions over the last ${HEATMAP_WEEKS} weeks. Use arrow keys to explore days.`}
          aria-describedby={`${id}-readout`}
          tabIndex={0}
          onKeyDown={explore}
          onFocus={() => setHeatIndex((current) => current ?? lastDay)}
          onBlur={() => setHeatIndex(null)}
          onPointerLeave={() => setHeatIndex(null)}
        >
          {cells.map((cell, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={`heatmap-cell level-${cell ? heatLevel(cell.count, maxCount) : 0} ${cell ? "" : "is-future"} ${index === heatIndex ? "is-active" : ""}`}
              onPointerEnter={() => cell && setHeatIndex(index)}
            />
          ))}
        </div>
      </div>
      <div className="heatmap-legend" aria-hidden="true">
        Less
        {[0, 1, 2, 3, 4].map((level) => (
          <i className={`heatmap-cell level-${level}`} key={level} />
        ))}
        More
      </div>
      <p className="profile-readout" id={`${id}-readout`} aria-live="polite">
        {activeCell ? (
          <>
            <strong>{plural(activeCell.count, "contribution")}</strong>
            {showXp ? ` · ${activeCell.xp} XP` : ""} ·{" "}
            {dayLabel(activeCell.date)}
          </>
        ) : (
          <>
            <strong>{plural(heatTotal, "contribution")}</strong> in the last{" "}
            {HEATMAP_WEEKS} weeks
          </>
        )}
      </p>
    </section>
  );
}

/** Daily XP or contributions as bars, explorable by pointer or keyboard. */
export function DailyBars({
  title,
  days,
  metric,
  total,
}: {
  title: string;
  days: ContributorDay[];
  metric: "xp" | "count";
  total: number;
}) {
  const id = useId();
  const [index, setIndex] = useState<number | null>(null);
  const value = (day: ContributorDay) => (metric === "xp" ? day.xp : day.count);
  const top = niceMax(Math.max(...days.map(value)));
  const active = index === null ? null : days[index];
  const what = metric === "xp" ? "XP" : "contributions";
  function explore(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") return setIndex(null);
    const step = arrowStep(event.key, { ArrowLeft: -1, ArrowRight: 1 });
    if (step === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const key = event.key;
    const last = days.length - 1;
    setIndex((current) => {
      if (key === "Home") return 0;
      if (key === "End") return last;
      return Math.max(0, Math.min(last, (current ?? last) + step!));
    });
  }
  return (
    <section className="profile-card" aria-labelledby={`${id}-title`}>
      <div className="profile-card-heading">
        <h3 id={`${id}-title`}>{title}</h3>
        <span>{days.length} days · UTC</span>
      </div>
      <div className="xp-chart">
        <div className="xp-axis" aria-hidden="true">
          <span style={{ top: 0 }}>{top.toLocaleString()}</span>
          <span style={{ top: "50%" }}>{(top / 2).toLocaleString()}</span>
          <span style={{ top: "100%" }}>0</span>
        </div>
        <div className="xp-plot">
          <span className="xp-grid" style={{ top: 0 }} />
          <span className="xp-grid" style={{ top: "50%" }} />
          <div
            className={`xp-bars ${active ? "has-active" : ""}`}
            role="group"
            aria-label={`Daily ${what} over the last ${days.length} days. Use arrow keys to explore days.`}
            aria-describedby={`${id}-readout`}
            tabIndex={0}
            onKeyDown={explore}
            onFocus={() => setIndex((current) => current ?? days.length - 1)}
            onBlur={() => setIndex(null)}
            onPointerLeave={() => setIndex(null)}
          >
            {days.map((day, dayIndex) => (
              <span
                key={day.date}
                aria-hidden="true"
                className={`xp-column ${dayIndex === index ? "is-active" : ""}`}
                onPointerEnter={() => setIndex(dayIndex)}
              >
                {value(day) > 0 && (
                  <span
                    className="xp-bar"
                    style={{ height: `${(value(day) / top) * 100}%` }}
                  />
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="xp-dates" aria-hidden="true">
          <span>
            {utcDate(days[0].date).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </span>
          <span>Today</span>
        </div>
      </div>
      <p className="profile-readout" id={`${id}-readout`} aria-live="polite">
        {active ? (
          metric === "xp" ? (
            <>
              <strong>{active.xp} XP</strong> ·{" "}
              {plural(active.count, "contribution")} · {dayLabel(active.date)}
            </>
          ) : (
            <>
              <strong>{plural(active.count, "contribution")}</strong> ·{" "}
              {dayLabel(active.date)}
            </>
          )
        ) : metric === "xp" ? (
          <>
            <strong>{total.toLocaleString()} XP</strong> in the last{" "}
            {days.length} days
          </>
        ) : (
          <>
            <strong>{plural(total, "contribution")}</strong> in the last{" "}
            {days.length} days
          </>
        )}
      </p>
    </section>
  );
}
