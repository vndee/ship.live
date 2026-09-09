import { useEffect, useState } from "react";
import {
  Clock3,
  Eye,
  GitMerge,
  Maximize2,
  Minimize2,
  RefreshCw,
  Sparkles,
  Unlink,
} from "lucide-react";
import { useSharedFeed } from "../hooks/useSharedFeed";
import { isEffectivelyNoExpiration } from "../../shared/shares";
import { EVENT_META } from "../lib/activity";
import { ActivityCelebration } from "./ActivityCelebration";
import { useActivityCelebration } from "../hooks/useActivityCelebration";
import type { ActivityEvent } from "../../shared/types";
import { EngineeringWall } from "./EngineeringWall";

const noEvents: ActivityEvent[] = [];

export function SharedDashboard() {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const feed = useSharedFeed(token);
  const [now, setNow] = useState(Date.now());
  const [moving, setMoving] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [wall, setWall] = useState(false);
  const [celebrations, setCelebrations] = useState(true);
  const liveEffects = useActivityCelebration(feed.data?.events || noEvents, {
    scope: token,
    ready: Boolean(feed.data) && !feed.error,
    enabled: celebrations,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    const changed = () => setToken(window.location.hash.slice(1));
    const fullscreen = () => setWall(Boolean(document.fullscreenElement));
    window.addEventListener("hashchange", changed);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      clearInterval(timer);
      window.removeEventListener("hashchange", changed);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, []);
  useEffect(() => {
    setNow(Date.now());
  }, [feed.data]);
  async function toggleWall() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setWall((value) => !value);
    }
  }
  return (
    <div className={`app-shell shared-dashboard ${wall ? "wall-mode" : ""}`}>
      <header className="app-header">
        <a className="brand" href="/">
          ship<span>.</span>live
        </a>
        <span className="shared-workspace">
          {feed.data?.organization || "Shared dashboard"}
        </span>
        <div className="header-tools">
          <button
            className="icon-button"
            aria-label="Celebrate new activity"
            title={
              celebrations
                ? "Turn off activity celebrations"
                : "Turn on activity celebrations"
            }
            aria-pressed={celebrations}
            onClick={() => setCelebrations((value) => !value)}
          >
            <Sparkles size={16} />
          </button>
          <span className="read-only-badge">
            <Eye size={13} /> Read only
          </span>
          <button
            className="icon-button"
            onClick={() => void toggleWall()}
            aria-label={wall ? "Exit wall display" : "Open wall display"}
          >
            {wall ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="date-line">
              {new Date(now).toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
            <h1>Great work. Shared momentum.</h1>
          </div>
          {feed.data && (
            <span className="share-expiry-badge">
              <Clock3 size={14} />
              {isEffectivelyNoExpiration(feed.data.expiresAt, now)
                ? "No expiration"
                : `Expires ${new Date(feed.data.expiresAt).toLocaleString()}`}
            </span>
          )}
        </div>
        {!feed.data ? (
          <div
            className="shared-unavailable"
            role={feed.error ? "alert" : "status"}
          >
            {feed.loading ? (
              <RefreshCw size={28} className="spin" />
            ) : (
              <Unlink size={28} />
            )}
            <h2>
              {feed.loading
                ? "Opening the team dashboard…"
                : "Dashboard unavailable"}
            </h2>
            <p>{feed.error || "Checking this share link."}</p>
            {!feed.loading && (
              <button className="button secondary" onClick={feed.retry}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="dashboard-layout">
            <EngineeringWall
              key={token}
              snapshot={feed.data.wall}
              events={feed.data.events}
              now={now}
              demo={false}
              moving={moving}
              loading={feed.loading}
              onToggleMotion={() => setMoving((value) => !value)}
              onRules={() => undefined}
              onMilestones={() => undefined}
              status={feed.connected ? "Live" : "Reconnecting"}
            />
            <aside className="dashboard-sidebar">
              <section className="activity-feed">
                <div className="section-heading">
                  <h2>
                    Live activity
                    <span className="section-count">
                      {feed.data.events.length}
                    </span>
                  </h2>
                </div>
                <div className="event-list">
                  {feed.data.events.slice(0, 8).map((event) => (
                    <article
                      className={`event-row shared-event ${liveEffects.highlightedIds.has(event.id) ? `activity-new ${moving ? "with-activity-motion" : ""}` : ""}`}
                      key={event.id}
                    >
                      <div className="event-topline">
                        <GitMerge
                          size={14}
                          className={`event-icon ${event.type}`}
                        />
                        <span className="event-actor">{event.actor.login}</span>
                        <time dateTime={event.occurredAt}>
                          {new Date(event.occurredAt).toLocaleTimeString(
                            undefined,
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </time>
                      </div>
                      <p className="event-title">{event.title}</p>
                      <div className="event-metadata">
                        <span>{event.repo}</span>
                        <span>
                          {liveEffects.highlightedIds.has(event.id) && (
                            <span className="new-activity-badge">New</span>
                          )}
                          {EVENT_META[event.type].label}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
                {!feed.data.events.length && (
                  <div className="empty-state">
                    <h3>Waiting for activity</h3>
                    <p>
                      New contributions from shared repositories will appear
                      here.
                    </p>
                  </div>
                )}
                <div className="shared-goal">
                  <Eye size={17} />
                  <h3>A live window into the team.</h3>
                  <p>
                    This dashboard updates as the team ships. Access ends when
                    the link is revoked or its lifetime ends.
                  </p>
                </div>
              </section>
            </aside>
          </div>
        )}
        <footer className="app-footer">
          <span>Shared team dashboard · Read only</span>
          <span>Weekly recognition resets Monday, 00:00 UTC</span>
        </footer>
      </main>
      <ActivityCelebration
        celebration={liveEffects.celebration}
        moving={moving}
      />
    </div>
  );
}
