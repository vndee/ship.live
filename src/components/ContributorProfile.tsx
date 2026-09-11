import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ActivityEvent } from "../../shared/types";
import { EVENT_META } from "../lib/activity";
import { getContributorProfile, XP_HISTORY_DAYS } from "../lib/contributor";
import {
  ACTIVITY_ICONS as icons,
  ActivityHeatmap,
  ago,
  DailyBars,
  dayLabel,
  shortRepo,
} from "./ProfileParts";

const RECENT_SHOWN = 6;

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
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [allRecent, setAllRecent] = useState(false);
  const recent = allRecent
    ? profile.recent
    : profile.recent.slice(0, RECENT_SHOWN);
  const name = displayName(profile.login);
  const cells = profile.heatmap;
  const avatar =
    profile.avatarUrl?.startsWith("https://avatars.githubusercontent.com/") &&
    !avatarFailed;
  const tableDays = cells
    .filter((cell): cell is NonNullable<typeof cell> => Boolean(cell?.count))
    .reverse();

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
        <ActivityHeatmap cells={profile.heatmap} />
        <DailyBars
          title="XP history"
          days={profile.xpHistory}
          metric="xp"
          total={profile.xp30}
        />
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
