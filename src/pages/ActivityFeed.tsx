import {
  ArrowDown,
  ArrowUpRight,
  Download,
  ExternalLink,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  X,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types";
import type { FeedController } from "../hooks/useFeed";
import { EVENT_META } from "../lib/activity";
import { ago, safeUrl, shortRepo } from "../lib/format";
import { noteTags } from "../lib/journal";
import { EVENT_ICONS, EVENT_VERBS, type Kind } from "../components/event-kinds";

export interface ActivityFeedProps {
  feed: FeedController;
  /** The Live feed page, rather than the list beside Pulse. */
  full?: boolean;
  personal: boolean;
  canWriteNote: boolean;
  replaying: boolean;
  visible: ActivityEvent[];
  shown: ActivityEvent[];
  /** "Now" for relative times: the replay position while replaying. */
  timeNow: number;
  kind: Kind | "";
  onKind: (kind: Kind | "") => void;
  repo: string;
  onRepo: (repo: string) => void;
  repositories: string[];
  /** The journal tag filter, and the journal's tags with their counts. */
  tag: string;
  tags: { tag: string; count: number }[];
  onTag: (tag: string) => void;
  /** Downloads the current view as Markdown. */
  onExport: () => void;
  activeFilters: boolean;
  onClearFilters: () => void;
  onReturnToNow: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDetail: (id: string) => void;
  highlightedIds: ReadonlySet<string>;
  moving: boolean;
  displayName: (login: string) => string;
  onViewAll: () => void;
  onShowMore: () => void;
  onAddNote: () => void;
  onConnect: () => void;
}

export function ActivityFeed({
  feed,
  full = false,
  personal,
  canWriteNote,
  replaying,
  visible,
  shown,
  timeNow,
  kind,
  onKind,
  repo,
  onRepo,
  repositories,
  tag,
  tags,
  onTag,
  onExport,
  activeFilters,
  onClearFilters,
  onReturnToNow,
  selectedId,
  onSelect,
  onDetail,
  highlightedIds,
  moving,
  displayName,
  onViewAll,
  onShowMore,
  onAddNote,
  onConnect,
}: ActivityFeedProps) {
  return (
    <section
      className={`activity-feed ${full ? "full-feed" : ""}`}
      aria-label="Shipping activity feed"
    >
      <div className="section-heading">
        <h2>
          {replaying ? "Activity replay" : "Live activity"}
          <span className="section-count">{visible.length}</span>
        </h2>
        <div className="small-actions">
          <button
            className="icon-button"
            aria-label={feed.paused ? "Resume updates" : "Pause updates"}
            title={feed.paused ? "Resume updates" : "Pause updates"}
            onClick={() => feed.setPaused(!feed.paused)}
          >
            {feed.paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          {full && (
            <button
              className="icon-button"
              onClick={onExport}
              aria-label="Export Markdown"
              title="Export this view as Markdown"
            >
              <Download size={15} />
            </button>
          )}
          {!full && (
            <button
              className="icon-button"
              onClick={onViewAll}
              aria-label="View all activity"
              title="View all activity"
            >
              <ArrowUpRight size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="feed-filter-row">
        <label>
          <span className="sr-only">Activity type</span>
          <select
            aria-label="Activity type"
            value={kind}
            onChange={(e) => onKind(e.target.value as Kind | "")}
          >
            <option value="">All activity</option>
            {(Object.keys(EVENT_META) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {EVENT_META[k].label}
              </option>
            ))}
          </select>
        </label>
        {full && (
          <label>
            <span className="sr-only">Filter repository</span>
            <select
              aria-label="Filter repository"
              value={repo}
              onChange={(e) => onRepo(e.target.value)}
            >
              <option value="">
                {personal ? "All sources" : "All repositories"}
              </option>
              {/* A linked repository stays selectable before its activity loads. */}
              {[...new Set(repo ? [...repositories, repo] : repositories)].map(
                (r) => (
                  <option key={r} value={r}>
                    {shortRepo(r)}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        {full && (tags.length > 0 || tag) && (
          <label>
            <span className="sr-only">Filter by tag</span>
            <select
              aria-label="Filter by tag"
              value={tag}
              onChange={(e) => onTag(e.target.value)}
            >
              <option value="">All tags</option>
              {tag && !tags.some((item) => item.tag === tag) && (
                <option value={tag}>#{tag}</option>
              )}
              {tags.map((item) => (
                <option key={item.tag} value={item.tag}>
                  #{item.tag} ({item.count})
                </option>
              ))}
            </select>
          </label>
        )}
        {(activeFilters || replaying) && (
          <button
            className="text-button clear-filter"
            onClick={() => {
              onClearFilters();
              onReturnToNow();
            }}
          >
            <X size={12} />
            Reset
          </button>
        )}
      </div>
      {feed.paused && (
        <p className="feed-pause-note">
          Live stream paused. Access is still checked.
        </p>
      )}
      <div className="event-list">
        {shown.map((event) => {
          const Icon = EVENT_ICONS[event.type];
          const isSelected = selectedId === event.id;
          const isNew = highlightedIds.has(event.id);
          return (
            <article
              key={event.id}
              className={`event-row ${isSelected ? "selected" : ""} ${isNew ? `activity-new ${moving ? "with-activity-motion" : ""}` : ""}`}
            >
              <button
                className="event-select"
                aria-pressed={isSelected}
                onClick={() => onSelect(event.id)}
              >
                <span className="event-topline">
                  <Icon size={14} className={`event-icon ${event.type}`} />
                  <span className="event-actor">
                    {displayName(event.actor.login)}{" "}
                    <span>{EVENT_VERBS[event.type]}</span>
                  </span>
                  <time
                    dateTime={event.occurredAt}
                    title={new Date(event.occurredAt).toLocaleString()}
                  >
                    {ago(event.occurredAt, timeNow)}
                  </time>
                </span>
                <span className="event-title">{event.title}</span>
                <span className="event-metadata">
                  <span>
                    {event.type === "note"
                      ? "Private journal"
                      : shortRepo(event.repo)}
                    {event.number ? ` / #${event.number}` : ""}
                  </span>
                  <span>
                    {noteTags(event)
                      .slice(0, 3)
                      .map((item) => (
                        <span key={item} className="note-tag">
                          #{item}
                        </span>
                      ))}
                    {isNew && <span className="new-activity-badge">New</span>}
                    {EVENT_META[event.type].label}
                  </span>
                </span>
              </button>
              {isSelected && (
                <div className="event-expanded">
                  <button
                    className="text-button"
                    onClick={() => onDetail(event.id)}
                  >
                    Event details <ArrowUpRight size={13} />
                  </button>
                  {!feed.demo && safeUrl(event.url) && (
                    <a
                      className="text-button"
                      href={safeUrl(event.url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!visible.length && (
        <div className="empty-state">
          <h3>
            {feed.loading
              ? "Loading activity…"
              : activeFilters
                ? "No matching activity"
                : replaying
                  ? "No activity at this point"
                  : personal
                    ? "Your journal starts with one ship"
                    : "Waiting for the first signal"}
          </h3>
          <p>
            {activeFilters
              ? "Try another repository, activity type, or search."
              : replaying
                ? "Move the timeline forward to see later events."
                : personal
                  ? "Add a ship note, or connect GitHub to bring your work into your dashboard."
                  : "Received GitHub events will appear here and on the leaderboard."}
          </p>
          {activeFilters ? (
            <button className="button secondary" onClick={onClearFilters}>
              Clear filters
            </button>
          ) : replaying ? (
            <button className="button secondary" onClick={onReturnToNow}>
              Return to now
            </button>
          ) : canWriteNote ? (
            <button className="button secondary" onClick={onAddNote}>
              <Plus size={14} /> Add a ship note
            </button>
          ) : !feed.demo ? (
            <button className="text-button" onClick={onConnect}>
              Manage connection <ArrowUpRight size={13} />
            </button>
          ) : null}
        </div>
      )}
      {visible.length > shown.length && (
        <button className="feed-more" onClick={full ? onShowMore : onViewAll}>
          {full ? "Show more activity" : `View all ${visible.length} events`}
          <ArrowDown size={14} />
        </button>
      )}
      {!full && personal && (
        <div className="shared-goal journal-reflection">
          <div className="goal-label">
            <span>
              <LockKeyhole size={12} /> Private journal
            </span>
            <span>
              {visible.filter((event) => event.type === "note").length} ship
              notes
            </span>
          </div>
          <h3>The story behind the work.</h3>
          <p>Small wins, experiments, and lessons belong here too.</p>
          {canWriteNote && (
            <button className="text-button" onClick={onAddNote}>
              <Plus size={13} /> Add a ship note
            </button>
          )}
        </div>
      )}
    </section>
  );
}
