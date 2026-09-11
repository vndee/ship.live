import { useMemo, useState, type ReactNode } from "react";
import { FolderGit2 } from "lucide-react";
import type { ActivityEvent } from "../../shared/types.js";
import { getRepositoryActivity, shortAge } from "../lib/engineering-wall.js";
import "../engineering-wall.css";

/** Rows shown before "Show all": workspaces can see hundreds of repositories. */
const SHOWN = 6;
const shortName = (repository: string) =>
  repository === "journal/notes"
    ? "Ship notes"
    : repository.split("/").pop() || repository;

export function RepositoryList({
  events,
  now,
  title = "Repositories",
  note,
  framed = false,
  onSelect,
}: {
  events: ActivityEvent[];
  now: number;
  title?: string;
  /** Where the activity comes from, shown under the list. */
  note?: string;
  /** A standalone card rather than a section of the wall. */
  framed?: boolean;
  onSelect?: (repository: string) => void;
}) {
  const repositories = useMemo(
    () => getRepositoryActivity(events, now),
    [events, now],
  );
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? repositories : repositories.slice(0, SHOWN);
  return (
    <section
      className={`repository-section ${framed ? "is-framed" : ""}`}
      aria-label={title}
    >
      <div className="scene-header">
        <div>
          <h2>{title}</h2>
          <p>Merges and reviews this week, most active first · UTC</p>
        </div>
        {repositories.length > 0 && (
          <div className="scene-chips">
            <span className="scene-chip">{repositories.length} total</span>
          </div>
        )}
      </div>
      {repositories.length ? (
        <ul className="scene-list">
          {shown.map((item) => {
            const age = shortAge(Math.max(0, now - Date.parse(item.latestAt)));
            const content: ReactNode = (
              <>
                <span className="scene-avatar" aria-hidden="true">
                  <FolderGit2 size={15} />
                </span>
                <span className="scene-row-body">
                  <strong>{shortName(item.repository)}</strong>
                  <small>
                    {item.repository.includes("/") && `${item.repository} · `}
                    {age === "now" ? "just now" : `${age} ago`}
                  </small>
                </span>
                <span className="repository-stats">
                  <span>
                    <b>{item.merges}</b> merges
                  </span>
                  <span>
                    <b>{item.reviews}</b> reviews
                  </span>
                </span>
              </>
            );
            return (
              <li key={item.repository}>
                {onSelect ? (
                  <button
                    type="button"
                    className="scene-row"
                    aria-label={`Open details for ${item.repository}`}
                    onClick={() => onSelect(item.repository)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="scene-row">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="repository-empty">
          Repositories appear as activity arrives.
        </p>
      )}
      {(repositories.length > SHOWN || note) && (
        <div className="repository-footer">
          {repositories.length > SHOWN && (
            <button
              type="button"
              className="text-button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "Show fewer" : `Show all ${repositories.length}`}
            </button>
          )}
          {note && <p>{note}</p>}
        </div>
      )}
    </section>
  );
}
