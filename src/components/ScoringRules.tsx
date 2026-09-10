import { SCORING_RULES } from "../lib/activity";
import { EVENT_ICONS } from "./event-kinds";

export function ScoringRules() {
  return (
    <>
      <p className="modal-description">
        Weekly XP celebrates visible contributions. It is a conversation
        starter, never a performance score.
      </p>
      <div className="scoring-rules">
        {SCORING_RULES.map((rule) => {
          const Icon = EVENT_ICONS[rule.type];
          return (
            <div key={rule.verb}>
              <Icon size={17} />
              <span>{rule.verb}</span>
              <strong>
                {rule.points} <small>XP{rule.each ? " each" : ""}</small>
              </strong>
            </div>
          );
        })}
      </div>
      <p className="field-hint">
        Bot accounts and duplicate events are excluded. Review XP counts once
        per reviewer, pull request, and UTC day. Commit XP counts only commits
        new to the repository, so each commit is credited once. Weeks start
        Monday at 00:00 UTC. Public history can be incomplete; totals reflect
        received activity.
      </p>
    </>
  );
}
