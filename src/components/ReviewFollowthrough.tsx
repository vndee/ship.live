import type {
  ReviewAction,
  ReviewFollowthroughItem,
} from "../../shared/review-followthrough.js";
import { shortAge } from "../lib/engineering-wall.js";
import "./ReviewFollowthrough.css";
export function ReviewFollowthrough({
  item,
  loading,
  error,
  pending,
  historical,
  userId,
  onAction,
}: {
  item?: ReviewFollowthroughItem;
  loading: boolean;
  error: string;
  pending: boolean;
  historical: boolean;
  userId: string;
  onAction: (action: ReviewAction, hours?: number) => void;
}) {
  if (loading)
    return (
      <div className="review-followthrough" role="status">
        Loading current review status…
      </div>
    );
  if (!item)
    return (
      <div className="review-followthrough">
        {error ? (
          <span role="alert">{error}</span>
        ) : (
          "Current review context unavailable; no action available."
        )}
      </div>
    );
  const snoozed = Boolean(
    item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now(),
  );
  return (
    <div
      className="review-followthrough"
      aria-label={`Follow-through for pull request ${item.number}`}
    >
      <div className="review-followthrough-facts">
        <span>
          Current status:{" "}
          {item.reasons.length
            ? item.reasons.join(" · ")
            : "No blockers recorded"}
        </span>
        <span>
          Open {shortAge(item.ageMs)} · No recorded activity{" "}
          {shortAge(item.inactiveMs)}
        </span>
      </div>
      {item.claim && (
        <span>
          {item.claim.userId === userId ? "You are" : `${item.claim.name} is`}{" "}
          looking
        </span>
      )}
      {snoozed && (
        <span>
          Snoozed for you until {new Date(item.snoozedUntil!).toLocaleString()}.
          Returns here when you revisit.
        </span>
      )}
      {error && <span role="alert">{error}</span>}
      {historical ? (
        <span>Switch to a current period to take action.</span>
      ) : (
        item.actionable && (
          <div className="review-followthrough-actions">
            {!item.claim ? (
              <button disabled={pending} onClick={() => onAction("claim")}>
                I'm looking
              </button>
            ) : item.claim.userId === userId ? (
              <button disabled={pending} onClick={() => onAction("release")}>
                Release my claim
              </button>
            ) : null}
            {snoozed ? (
              <button disabled={pending} onClick={() => onAction("unsnooze")}>
                Show now
              </button>
            ) : (
              <button disabled={pending} onClick={() => onAction("snooze", 4)}>
                Snooze for 4 hours
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
