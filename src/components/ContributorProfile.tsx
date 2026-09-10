import { useMemo, useState, type ElementType, type KeyboardEvent } from "react";
import {
  CheckCheck,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  NotebookPen,
  Rocket,
} from "lucide-react";
import type { ActivityEvent, ActivityType } from "../../shared/types";
import { EVENT_META } from "../lib/activity";
import {
  getContributorProfile,
  HEATMAP_WEEKS,
  XP_HISTORY_DAYS,
} from "../lib/contributor";
import "../contributor-profile.css";

const icons: Record<ActivityType, ElementType> = {
  merge: GitMerge,
  review: MessageSquare,
  push: GitCommitHorizontal,
  issue: CheckCheck,
  release: Rocket,
  pr: GitPullRequest,
  note: NotebookPen,
};
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];
const RECENT_SHOWN = 6;

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);
const dayLabel = (date: string) =>
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
const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
const shortRepo = (repo: string) =>
  repo === "journal/notes" ? "Ship notes" : repo.split("/").pop() || repo;
function ago(timestamp: string, now: number) {
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

function arrowStep(key: string, steps: Record<string, number>) {
  return key in steps ? steps[key] : null;
}

export function ContributorProfile({
  events,
  login,
  now,
  demo = false,
  displayName = (value) => value,
}: {
  events: ActivityEvent[];
  login: string;
  now: number;
  demo?: boolean;
  displayName?: (login: string) => string;
}) {
  const profile = useMemo(
    () => getContributorProfile(events, login, now),
    [events, login, now],
  );
  const [heatIndex, setHeatIndex] = useState<number | null>(null);
  const [xpIndex, setXpIndex] = useState<number | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [allRecent, setAllRecent] = useState(false);
  const recent = allRecent
    ? profile.recent
    : profile.recent.slice(0, RECENT_SHOWN);
  const name = displayName(profile.login);
  const cells = profile.heatmap;
  const lastDay = cells.reduce((last, cell, index) => (cell ? index : last), 0);
  const maxCount = Math.max(1, ...cells.map((cell) => cell?.count ?? 0));
  const heatTotal = cells.reduce((sum, cell) => sum + (cell?.count ?? 0), 0);
  const activeCell = heatIndex === null ? null : cells[heatIndex];
  const history = profile.xpHistory;
  const xpTop = niceMax(Math.max(...history.map((day) => day.xp)));
  const activeXp = xpIndex === null ? null : history[xpIndex];
  const avatar =
    profile.avatarUrl?.startsWith("https://avatars.githubusercontent.com/") &&
    !avatarFailed;
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
  const tableDays = cells
    .filter((cell): cell is NonNullable<typeof cell> => Boolean(cell?.count))
    .reverse();

  function exploreHeatmap(event: KeyboardEvent<HTMLDivElement>) {
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
  function exploreXp(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") return setXpIndex(null);
    const step = arrowStep(event.key, { ArrowLeft: -1, ArrowRight: 1 });
    if (step === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const key = event.key;
    const last = history.length - 1;
    setXpIndex((current) => {
      if (key === "Home") return 0;
      if (key === "End") return last;
      return Math.max(0, Math.min(last, (current ?? last) + step!));
    });
  }

  return (
    <div className="contributor-profile">
      <div className="profile-identity">
        <span className="profile-avatar" aria-hidden="true">
          {avatar ? (
            <img
              src={profile.avatarUrl}
              alt=""
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            name
              .split(/\s+/)
              .map((part) => part[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()
          )}
        </span>
        <div>
          <span className="profile-handle">@{profile.login}</span>
          <div className="profile-badges">
            <span className="profile-badge">
              {profile.rank === null ? (
                "No activity this week"
              ) : (
                <>
                  <strong>#{profile.rank}</strong> this week
                </>
              )}
            </span>
            {profile.firstSeen && (
              <span className="profile-badge">
                Since{" "}
                {new Date(profile.firstSeen).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            )}
          </div>
        </div>
        {!demo && (
          <a
            className="button secondary profile-github"
            href={`https://github.com/${encodeURIComponent(profile.login)}`}
            target="_blank"
            rel="noreferrer"
          >
            <span>GitHub</span> <ExternalLink size={14} />
          </a>
        )}
      </div>

      <dl className="profile-stats">
        <div className="profile-stat">
          <dt>Weekly XP</dt>
          <dd>{profile.weeklyXp.toLocaleString()}</dd>
        </div>
        <div className="profile-stat">
          <dt>XP · 30 days</dt>
          <dd>{profile.xp30.toLocaleString()}</dd>
        </div>
        <div className="profile-stat">
          <dt>Contributions · 30 days</dt>
          <dd>{profile.contributions30.toLocaleString()}</dd>
        </div>
        <div className="profile-stat">
          <dt>Active days · 30 days</dt>
          <dd>
            {profile.activeDays30}
            <small>/ {XP_HISTORY_DAYS}</small>
          </dd>
        </div>
      </dl>

      <div className="profile-charts">
        <section className="profile-card" aria-labelledby="profile-heatmap">
          <div className="profile-card-heading">
            <h3 id="profile-heatmap">Activity</h3>
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
              aria-describedby="profile-heatmap-readout"
              tabIndex={0}
              onKeyDown={exploreHeatmap}
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
          <p
            className="profile-readout"
            id="profile-heatmap-readout"
            aria-live="polite"
          >
            {activeCell ? (
              <>
                <strong>{plural(activeCell.count, "contribution")}</strong> ·{" "}
                {activeCell.xp} XP · {dayLabel(activeCell.date)}
              </>
            ) : (
              <>
                <strong>{plural(heatTotal, "contribution")}</strong> in the last{" "}
                {HEATMAP_WEEKS} weeks
              </>
            )}
          </p>
        </section>

        <section className="profile-card" aria-labelledby="profile-xp">
          <div className="profile-card-heading">
            <h3 id="profile-xp">XP history</h3>
            <span>{XP_HISTORY_DAYS} days · UTC</span>
          </div>
          <div className="xp-chart">
            <div className="xp-axis" aria-hidden="true">
              <span style={{ top: 0 }}>{xpTop.toLocaleString()}</span>
              <span style={{ top: "50%" }}>{(xpTop / 2).toLocaleString()}</span>
              <span style={{ top: "100%" }}>0</span>
            </div>
            <div className="xp-plot">
              <span className="xp-grid" style={{ top: 0 }} />
              <span className="xp-grid" style={{ top: "50%" }} />
              <div
                className={`xp-bars ${activeXp ? "has-active" : ""}`}
                role="group"
                aria-label={`Daily XP over the last ${XP_HISTORY_DAYS} days. Use arrow keys to explore days.`}
                aria-describedby="profile-xp-readout"
                tabIndex={0}
                onKeyDown={exploreXp}
                onFocus={() =>
                  setXpIndex((current) => current ?? history.length - 1)
                }
                onBlur={() => setXpIndex(null)}
                onPointerLeave={() => setXpIndex(null)}
              >
                {history.map((day, index) => (
                  <span
                    key={day.date}
                    aria-hidden="true"
                    className={`xp-column ${index === xpIndex ? "is-active" : ""}`}
                    onPointerEnter={() => setXpIndex(index)}
                  >
                    {day.xp > 0 && (
                      <span
                        className="xp-bar"
                        style={{ height: `${(day.xp / xpTop) * 100}%` }}
                      />
                    )}
                  </span>
                ))}
              </div>
            </div>
            <div className="xp-dates" aria-hidden="true">
              <span>
                {utcDate(history[0].date).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })}
              </span>
              <span>Today</span>
            </div>
          </div>
          <p
            className="profile-readout"
            id="profile-xp-readout"
            aria-live="polite"
          >
            {activeXp ? (
              <>
                <strong>{activeXp.xp} XP</strong> ·{" "}
                {plural(activeXp.count, "contribution")} ·{" "}
                {dayLabel(activeXp.date)}
              </>
            ) : (
              <>
                <strong>{profile.xp30.toLocaleString()} XP</strong> in the last{" "}
                {XP_HISTORY_DAYS} days
              </>
            )}
          </p>
        </section>
      </div>

      <div className="profile-lists">
        <section className="profile-card" aria-labelledby="profile-breakdown">
          <div className="profile-card-heading">
            <h3 id="profile-breakdown">Breakdown</h3>
            <span>30 days</span>
          </div>
          {profile.byType.length ? (
            <ul className="profile-breakdown">
              {profile.byType.map(({ type, count, xp }) => {
                const Icon = icons[type];
                return (
                  <li key={type}>
                    <Icon size={14} aria-hidden="true" />
                    <span>{EVENT_META[type].label}</span>
                    <span className="count">{count}</span>
                    <span className="xp">{xp.toLocaleString()} XP</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="profile-empty">No activity in the last 30 days.</p>
          )}
        </section>

        <section className="profile-card" aria-labelledby="profile-recent">
          <div className="profile-card-heading">
            <h3 id="profile-recent">Recent activity</h3>
            <span>Newest first</span>
          </div>
          {profile.recent.length ? (
            <ul className="profile-recent">
              {recent.map(({ event, points }) => {
                const Icon = icons[event.type];
                return (
                  <li key={event.id}>
                    <Icon size={14} aria-hidden="true" />
                    <span>
                      <strong>{event.title}</strong>
                      <small>
                        {EVENT_META[event.type].label} · {shortRepo(event.repo)}
                        {event.number ? ` #${event.number}` : ""} ·{" "}
                        {ago(event.occurredAt, now)}
                      </small>
                    </span>
                    <span className={`xp ${points ? "has-xp" : ""}`}>
                      {points ? `+${points}` : "0"} XP
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="profile-empty">No activity received yet.</p>
          )}
          {profile.recent.length > RECENT_SHOWN && (
            <button
              type="button"
              className="text-button profile-more"
              aria-expanded={allRecent}
              onClick={() => setAllRecent((value) => !value)}
            >
              {allRecent ? "Show fewer" : `Show all ${profile.recent.length}`}
            </button>
          )}
        </section>
      </div>

      {tableDays.length > 0 && (
        <details className="profile-data">
          <summary>View daily data</summary>
          <div className="profile-table-scroll">
            <table>
              <caption className="sr-only">
                {name}: contributions and XP per UTC day, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Contributions</th>
                  <th scope="col">XP</th>
                </tr>
              </thead>
              <tbody>
                {tableDays.map((day) => (
                  <tr key={day.date}>
                    <td>{dayLabel(day.date)}</td>
                    <td>{day.count}</td>
                    <td>{day.xp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="profile-footnote">
        Based on activity this workspace has received, credited like the weekly
        board; history can be partial. Days are UTC.
      </p>
    </div>
  );
}
