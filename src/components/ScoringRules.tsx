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
        XP v2 credits peer review once per reviewer and pull request, on the
        earliest retained review. Self reviews and reviews with an unknown PR
        author earn no XP. Commits and PR openings earn no XP. LOC describes
        change size, not contribution value. Bots and duplicate events are
        excluded. Weeks start Monday at 00:00 UTC; missing or expired history
        can affect totals.
      </p>
      <p className="field-hint">
        Verification bonuses are being evaluated: 5 candidate XP for observed
        peer review and 5 for passing observed checks at merge. These are not
        included in rankings until repository coverage has been audited. They
        describe verification activity, not code quality.
      </p>
    </>
  );
}
