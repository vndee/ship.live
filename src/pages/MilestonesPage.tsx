import type { getAchievements } from "../lib/activity";
import { EVENT_ICONS } from "../components/event-kinds";

export function MilestonesPage({
  achievements,
}: {
  achievements: ReturnType<typeof getAchievements>;
}) {
  return (
    <section className="milestones-page">
      <div className="section-heading">
        <h2>Shared milestones</h2>
        <span className="period-note">This week · UTC</span>
      </div>
      <div className="milestone-list">
        {achievements.map((achievement) => {
          const Icon = EVENT_ICONS[achievement.kind];
          return (
            <article className="milestone" key={achievement.id}>
              <Icon size={24} strokeWidth={1.2} />
              <div>
                <span
                  className={`milestone-state ${achievement.unlocked ? "complete" : ""}`}
                >
                  {achievement.unlocked ? "Reached together" : "In progress"}
                </span>
                <h2>{achievement.title}</h2>
                <p>{achievement.description}</p>
                <div
                  className="goal-track"
                  role="progressbar"
                  aria-label={achievement.title}
                  aria-valuemin={0}
                  aria-valuemax={achievement.target}
                  aria-valuenow={achievement.progress}
                >
                  <span
                    style={{
                      width: `${(achievement.progress / achievement.target) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <strong className="milestone-number">
                {achievement.progress}
                <small> / {achievement.target}</small>
              </strong>
            </article>
          );
        })}
      </div>
      <p className="recognition-note">
        Everyone moves these goals forward. Milestones reflect received
        activity, with a fresh start each Monday.
      </p>
    </section>
  );
}
