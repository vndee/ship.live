import { candidateVerificationBonus } from "../../shared/xp";
import {
  ExternalLink,
  FolderGit2,
  Inbox,
  LockKeyhole,
  Trash2,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types";
import { basePoints, EVENT_META } from "../lib/activity";
import { safeUrl } from "../lib/format";
import { Avatar } from "./Avatar";

export function EventDetail({
  event,
  demo,
  personal,
  canDelete,
  displayName,
  onDelete,
}: {
  event: ActivityEvent;
  demo: boolean;
  personal: boolean;
  canDelete: boolean;
  displayName: (login: string) => string;
  onDelete: () => void;
}) {
  const link = demo ? undefined : safeUrl(event.url);
  return (
    <>
      <div className="detail-person">
        <Avatar
          name={displayName(event.actor.login)}
          url={event.actor.avatarUrl}
        />
        <div>
          <strong>{displayName(event.actor.login)}</strong>
          <span>{EVENT_META[event.type].verb}</span>
        </div>
      </div>
      <h3 className="detail-title">{event.title}</h3>
      <p className="detail-repo">
        {event.type === "alert" ? (
          <Inbox size={15} />
        ) : (
          <FolderGit2 size={15} />
        )}
        {event.type === "note" ? "Private journal" : event.repo}
        {event.number ? ` #${event.number}` : ""}
        {event.type === "merge" && event.branch ? ` into ${event.branch}` : ""}
      </p>
      <p className="detail-date">
        {new Date(event.occurredAt).toLocaleString()}
      </p>
      {(event.additions !== undefined || event.deletions !== undefined) && (
        <p className="diff-stat">
          +{event.additions ?? 0} additions{" "}
          <span>−{event.deletions ?? 0} deletions</span>
        </p>
      )}
      {event.body && <p className="note-body">{event.body}</p>}
      {event.type === "alert" && (
        <p className="field-hint">
          Received by an inbound webhook. Alerts earn no XP and never count
          toward the leaderboard.
        </p>
      )}
      {!personal && event.type !== "note" && event.type !== "alert" && (
        <p className="field-hint">
          Base recognition: {basePoints(event)} XP . Review credit belongs to
          the earliest retained peer review; repeated reviews, commits and PR
          openings earn no additional XP.
        </p>
      )}
      {event.type === "merge" && (
        <div className="field-hint">
          <strong>Verification at merge</strong>
          {event.verification ? (
            <>
              <p>
                Peer review:{" "}
                {event.verification.peerReview.status === "observed"
                  ? "Observed before merge"
                  : "Insufficient data"}
                . CI:{" "}
                {event.verification.ci.status === "passing"
                  ? "All observed checks passed on the PR head"
                  : event.verification.ci.status === "not_passing"
                    ? "Observed checks were not all passing"
                    : "Insufficient data"}
                .
              </p>
              <p>
                Candidate bonus:{" "}
                {candidateVerificationBonus(event.verification)} XP — not
                included in rankings. Coverage is under evaluation.
              </p>
              <p>
                Captured{" "}
                {new Date(event.verification.capturedAt).toLocaleString()}. This
                snapshot does not assess test quality or confirm that every
                required check was received.
              </p>
            </>
          ) : (
            <p>
              Insufficient data. Verification was not captured for this merge;
              its base XP is unchanged.
            </p>
          )}
        </div>
      )}
      {event.type === "review" && !event.pullRequestAuthor && (
        <p className="field-hint">
          Insufficient data: the PR author is unknown, so peer-review XP cannot
          be established.
        </p>
      )}
      {event.type === "note" && (
        <p className="privacy-note">
          <LockKeyhole size={14} /> Only you can see this ship note.
        </p>
      )}
      {link ? (
        <a
          className="button primary full-width"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          {event.type === "alert" ? "Open link" : "View on GitHub"}{" "}
          <ExternalLink size={15} />
        </a>
      ) : (
        event.type !== "note" && (
          <p className="field-hint">
            {demo
              ? "This is fictional sample activity."
              : event.type === "alert"
                ? "This alert's mapping supplied no link."
                : "No GitHub link was supplied for this event."}
          </p>
        )
      )}
      {canDelete && (
        <button className="text-button danger-button" onClick={onDelete}>
          <Trash2 size={14} /> Delete ship note
        </button>
      )}
    </>
  );
}
