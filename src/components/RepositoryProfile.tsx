import { useMemo, useState } from "react";
import { ExternalLink, FolderGit2, ListFilter } from "lucide-react";
import type { ActivityEvent } from "../../shared/types";
import type { EngineeringWallSnapshot } from "../../shared/wall";
import { EVENT_META } from "../lib/activity";
import { XP_HISTORY_DAYS } from "../lib/contributor";
import { getRepositoryProfile, getRepositorySignals } from "../lib/repository";
import {
  ACTIVITY_ICONS as icons,
  ActivityHeatmap,
  ago,
  DailyBars,
} from "./ProfileParts";

const SHOWN = 6;
const RADAR = {
  failing: ["CI failing", "danger"],
  ready: ["Ready to merge", "success"],
  running: ["Checks running", "info"],
  waiting: ["Awaiting review", "neutral"],
} as const;
const deploymentTone = (status: string) =>
  status === "successful"
    ? "success"
    : status === "failing"
      ? "danger"
      : status === "running" || status === "queued"
        ? "info"
        : "neutral";
const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** A repository's view of received activity and its current delivery signals. */
export function RepositoryProfile({
  events,
  repository,
  now,
  snapshot,
  demo = false,
  displayName = (value) => value,
  onSelectPerson,
  onViewActivity,
}: {
  events: ActivityEvent[];
  repository: string;
  now: number;
  snapshot?: EngineeringWallSnapshot | null;
  demo?: boolean;
  displayName?: (login: string) => string;
  onSelectPerson: (login: string) => void;
  onViewActivity: () => void;
}) {
  const profile = useMemo(
    () => getRepositoryProfile(events, repository, now),
    [events, repository, now],
  );
  const signals = useMemo(
    () => getRepositorySignals(snapshot, repository, now),
    [snapshot, repository, now],
  );
  const [allPeople, setAllPeople] = useState(false);
  const [allRecent, setAllRecent] = useState(false);
  const people = allPeople
    ? profile.contributors
    : profile.contributors.slice(0, SHOWN);
  const recent = allRecent ? profile.recent : profile.recent.slice(0, SHOWN);
  const delivery =
    signals.pullRequests.length > 0 || signals.deployments.length > 0;
  const github =
    !demo && repository.includes("/") && repository !== "journal/notes";
  return (
    <div className="contributor-profile repository-profile">
      <div className="profile-identity">
        <span className="profile-avatar" aria-hidden="true">
          <FolderGit2 size={22} />
        </span>
        <div>
          <span className="profile-handle">{repository}</span>
          <div className="profile-badges">
            <span className="profile-badge">
              {profile.rank === null ? (
                "No activity this week"
              ) : (
                <>
                  <strong>#{profile.rank}</strong> most active this week
                </>
              )}
            </span>
            {profile.latestAt && (
              <span className="profile-badge">
                Last activity {ago(profile.latestAt, now)}
              </span>
            )}
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
        <div className="profile-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onViewActivity}
          >
            <ListFilter size={14} aria-hidden="true" />
            <span>View all activity</span>
          </button>
          {github && (
            <a
              className="button secondary profile-github"
              href={`https://github.com/${repository}`}
              target="_blank"
              rel="noreferrer"
            >
              <span>GitHub</span> <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      <dl className="profile-stats">
        <div className="profile-stat">
          <dt>Merges this week</dt>
          <dd>{profile.merges.toLocaleString()}</dd>
        </div>
        <div className="profile-stat">
          <dt>Reviews this week</dt>
          <dd>{profile.reviews.toLocaleString()}</dd>
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
        <ActivityHeatmap cells={profile.heatmap} showXp={false} />
        <DailyBars
          title="Daily contributions"
          days={profile.history}
          metric="count"
          total={profile.contributions30}
        />
      </div>

      <div className="profile-lists">
        <section className="profile-card" aria-labelledby="repository-people">
          <div className="profile-card-heading">
            <h3 id="repository-people">Contributors</h3>
            <span>30 days</span>
          </div>
          {people.length ? (
            <ul className="profile-people">
              {people.map((person) => (
                <li key={person.login}>
                  <button
                    type="button"
                    aria-label={`Open ${displayName(person.login)}'s profile`}
                    onClick={() => onSelectPerson(person.login)}
                  >
                    <span className="initials" aria-hidden="true">
                      {initials(displayName(person.login))}
                    </span>
                    <span>{displayName(person.login)}</span>
                    <span className="count">
                      {person.count}{" "}
                      {person.count === 1 ? "contribution" : "contributions"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="profile-empty">No activity in the last 30 days.</p>
          )}
          {profile.contributors.length > SHOWN && (
            <button
              type="button"
              className="text-button profile-more"
              aria-expanded={allPeople}
              onClick={() => setAllPeople((value) => !value)}
            >
              {allPeople
                ? "Show fewer"
                : `Show all ${profile.contributors.length}`}
            </button>
          )}
        </section>

        <section className="profile-card" aria-labelledby="repository-types">
          <div className="profile-card-heading">
            <h3 id="repository-types">Breakdown</h3>
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

        <section className="profile-card" aria-labelledby="repository-recent">
          <div className="profile-card-heading">
            <h3 id="repository-recent">Recent activity</h3>
            <span>Newest first</span>
          </div>
          {recent.length ? (
            <ul className="profile-recent">
              {recent.map(({ event, points }) => {
                const Icon = icons[event.type];
                return (
                  <li key={event.id}>
                    <Icon size={14} aria-hidden="true" />
                    <span>
                      <strong>{event.title}</strong>
                      <small>
                        {EVENT_META[event.type].label} ·{" "}
                        {displayName(event.actor.login)}
                        {event.number ? ` · #${event.number}` : ""} ·{" "}
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
          {profile.recent.length > SHOWN && (
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

        <section className="profile-card" aria-labelledby="repository-delivery">
          <div className="profile-card-heading">
            <h3 id="repository-delivery">Delivery</h3>
            <span>Now</span>
          </div>
          {delivery ? (
            <>
              {signals.pullRequests.length > 0 && (
                <>
                  <h4 className="profile-subheading">
                    Open pull requests · {signals.pullRequests.length}
                  </h4>
                  <ul className="profile-signals">
                    {signals.pullRequests.slice(0, SHOWN).map((pull) => (
                      <li key={pull.number}>
                        <strong>{pull.title}</strong>
                        <small>
                          #{pull.number} · {displayName(pull.author)} ·{" "}
                          {ago(new Date(now - pull.ageMs).toISOString(), now)}
                        </small>
                        <span
                          className={`signal-state tone-${RADAR[pull.state][1]}`}
                        >
                          {RADAR[pull.state][0]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {signals.deployments.length > 0 && (
                <>
                  <h4 className="profile-subheading">Deployments</h4>
                  <ul className="profile-signals">
                    {signals.deployments.map((deployment) => (
                      <li key={`${deployment.environment}-${deployment.id}`}>
                        <strong>{deployment.environment}</strong>
                        <small>
                          {deployment.headSha.slice(0, 7)} ·{" "}
                          {ago(deployment.updatedAt, now)}
                        </small>
                        <span
                          className={`signal-state tone-${deploymentTone(deployment.status)}`}
                        >
                          {deployment.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="profile-empty">
              No open pull requests or deployments reported.
            </p>
          )}
        </section>
      </div>
      <p className="profile-footnote">
        Based on activity this workspace has received, credited like the weekly
        board, and on current pull request and deployment signals; history can
        be partial. Days are UTC.
      </p>
    </div>
  );
}
