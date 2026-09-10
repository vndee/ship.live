import { CircleHelp, Users } from "lucide-react";
import type { getLeaderboard, getMetrics } from "../lib/activity";
import { Avatar } from "../components/Avatar";

export function TeamPage({
  people,
  metrics,
  displayName,
  onRules,
  onSelectPerson,
}: {
  people: ReturnType<typeof getLeaderboard>;
  metrics: ReturnType<typeof getMetrics>;
  displayName: (login: string) => string;
  onRules: () => void;
  onSelectPerson: (login: string) => void;
}) {
  return (
    <section className="team-page">
      <div className="section-heading">
        <h2>Team spotlight</h2>
        <span className="period-note">This week · UTC</span>
      </div>
      <div className="team-summary">
        <p>
          <strong>{metrics.contributors}</strong> people building.{" "}
          <strong>{metrics.xp.toLocaleString()}</strong> shared XP.
        </p>
        <button className="text-button" onClick={onRules}>
          How recognition works <CircleHelp size={14} />
        </button>
      </div>
      <div className="team-table">
        <div className="team-table-head">
          <span>Contributor</span>
          <span>Merges</span>
          <span>Reviews</span>
          <span>Weekly XP</span>
        </div>
        {people.map((person) => (
          <div className="team-row" key={person.login}>
            <div className="team-person">
              <span className="rank">
                {String(person.rank).padStart(2, "0")}
              </span>
              <Avatar name={displayName(person.login)} url={person.avatarUrl} />
              <span>
                <strong>{displayName(person.login)}</strong>
                <small>@{person.login}</small>
              </span>
            </div>
            <span>{person.merges}</span>
            <span>{person.reviews}</span>
            <strong className="team-xp">
              {person.xp.toLocaleString()}
              <small> XP</small>
            </strong>
            <button
              type="button"
              className="row-select"
              aria-label={`Open ${displayName(person.login)}'s profile`}
              onClick={() => onSelectPerson(person.login)}
            />
          </div>
        ))}
      </div>
      {!people.length && (
        <div className="empty-state">
          <Users size={24} />
          <h3>No contributions received this week</h3>
          <p>Contributors appear as activity arrives.</p>
        </div>
      )}
      <p className="recognition-note">
        Reviews, releases, merges, and new commits all count. Weekly recognition
        excludes bot accounts and resets Monday at 00:00 UTC.
      </p>
    </section>
  );
}
