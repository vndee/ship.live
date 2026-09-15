import { PulsePageFilter } from "./PulsePageFilter";
import { usePulseDashboard } from "../hooks/usePulseDashboard";
import { PulseOverview } from "./PulseOverview";
import { PulseHistoryFeed } from "./PulseHistoryFeed";
import { setPulseLocation, usePulseLocation } from "../hooks/usePulse";
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
import { ThemeToggle } from "./ThemeToggle";
import { BrandMark } from "./BrandMark";
import { EngineeringWall } from "./EngineeringWall";
import { ContributorProfile } from "./ContributorProfile";
import { Modal } from "./Modal";

const noEvents: ActivityEvent[] = [];

export function SharedDashboard() {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const feed = useSharedFeed(token);
  const pulseLocation = usePulseLocation();
  const [now, setNow] = useState(Date.now());
  const source = {
    shareToken: token,
    demo: false,
    events: feed.data?.events || noEvents,
    revision: feed.data?.updatedAt,
    enabled: Boolean(feed.data) && !feed.error,
  };
  const dashboard = usePulseDashboard(source, pulseLocation.selection, now);
  const periodEvents = dashboard.data?.events ?? noEvents;
  const historical = Boolean(
    dashboard.range &&
    dashboard.range.to < new Date(now).toISOString().slice(0, 10),
  );
  const [moving, setMoving] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [wall, setWall] = useState(false);
  const [celebrations, setCelebrations] = useState(true);
  const [profileLogin, setProfileLogin] = useState<string | null>(null);
  const liveEffects = useActivityCelebration(feed.data?.events || noEvents, {
    scope: token,
    ready: Boolean(feed.data) && !feed.error,
    enabled:
      celebrations && !pulseLocation.history && !historical && !dashboard.error,
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
          <BrandMark />
          <span className="brand-name">
            ship<span>.live</span>
          </span>
        </a>
        <span className="shared-workspace">
          {feed.data?.organization || "Shared Pulse"}
        </span>
        <div className="header-tools">
          <ThemeToggle />
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
            <h1>{feed.data?.pulseTitle || "Great work. Shared momentum."}</h1>
            {feed.data?.pulseSubtitle && (
              <p className="page-subtitle">{feed.data.pulseSubtitle}</p>
            )}
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
            <h2>{feed.loading ? "Opening Pulse…" : "Pulse unavailable"}</h2>
            <p>{feed.error || "Checking this share link."}</p>
            {!feed.loading && (
              <button className="button secondary" onClick={feed.retry}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <>
            <PulsePageFilter
              selection={pulseLocation.selection}
              range={dashboard.range}
              overview={dashboard.data?.overview}
              onRefresh={dashboard.retry}
              refreshing={dashboard.refreshing}
              now={now}
              onChange={setPulseLocation}
            />
            <div className="dashboard-layout">
              {pulseLocation.history ? (
                <PulseHistoryFeed
                  source={{
                    shareToken: token,
                    demo: false,
                    events: feed.data.events,
                    revision: feed.data.updatedAt,
                    enabled: !feed.error,
                  }}
                  from={pulseLocation.selection.from}
                  to={pulseLocation.selection.to}
                  repo={pulseLocation.repo}
                  now={now}
                  onBack={() => setPulseLocation(pulseLocation.selection)}
                />
              ) : (
                <EngineeringWall
                  overview={
                    <PulseOverview
                      source={source}
                      result={{
                        ...dashboard,
                        data: dashboard.data?.overview ?? null,
                      }}
                      now={now}
                      onHistory={(from, to, repo) =>
                        setPulseLocation(
                          { period: "custom", from, to },
                          true,
                          repo,
                        )
                      }
                    />
                  }
                  key={token}
                  range={dashboard.range}
                  scopeError={dashboard.error}
                  scopeLoading={dashboard.loading}
                  onRetry={dashboard.retry}
                  snapshot={
                    dashboard.data?.wall ?? { repositories: [], updatedAt: "" }
                  }
                  events={periodEvents}
                  now={now}
                  demo={false}
                  moving={moving}
                  autoplayDefault={wall && moving}
                  preferencesKey="shared-dashboard"
                  loading={dashboard.loading}
                  onToggleMotion={() => setMoving((value) => !value)}
                  onRules={() => undefined}
                  onMilestones={() => undefined}
                  onSelectPerson={setProfileLogin}
                  status={
                    historical
                      ? "Historical period"
                      : feed.connected
                        ? "Live"
                        : "Reconnecting"
                  }
                />
              )}
              <aside className="dashboard-sidebar">
                <section className="activity-feed">
                  <div className="section-heading">
                    <h2>
                      Activity in this period
                      <span className="section-count">
                        {periodEvents.length}
                      </span>
                    </h2>
                  </div>
                  <div className="event-list">
                    {periodEvents.slice(0, 8).map((event) => (
                      <article
                        className={`event-row shared-event ${liveEffects.highlightedIds.has(event.id) ? `activity-new ${moving ? "with-activity-motion" : ""}` : ""}`}
                        key={event.id}
                      >
                        <div className="event-topline">
                          <GitMerge
                            size={14}
                            className={`event-icon ${event.type}`}
                          />
                          <span className="event-actor">
                            {event.actor.login}
                          </span>
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
                  {!periodEvents.length && (
                    <div className="empty-state">
                      <h3>
                        {dashboard.loading
                          ? "Loading activity…"
                          : dashboard.error
                            ? "Activity unavailable"
                            : "No activity in this period"}
                      </h3>
                      <p>
                        {dashboard.error ||
                          "Only stored activity in the selected dates is shown."}
                      </p>
                    </div>
                  )}
                  <div className="shared-goal">
                    <Eye size={17} />
                    <h3>A live window into the team.</h3>
                    <p>
                      Pulse updates as the team ships. Access ends when the link
                      is revoked or its lifetime ends.
                    </p>
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}
        <footer className="app-footer">
          <span>Shared team Pulse · Read only</span>
          <span>All tabs follow the selected UTC dates</span>
        </footer>
      </main>
      {profileLogin && feed.data && (
        <Modal title={profileLogin} onClose={() => setProfileLogin(null)}>
          <ContributorProfile
            range={dashboard.range ?? undefined}
            events={periodEvents}
            login={profileLogin}
            now={now}
          />
        </Modal>
      )}
      <ActivityCelebration
        celebration={liveEffects.celebration}
        moving={moving}
      />
    </div>
  );
}
