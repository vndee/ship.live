import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  FolderGit2,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Github,
  BookOpen,
  LockKeyhole,
  NotebookPen,
  Plus,
  Trash2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Settings2,
  Share2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { ActivityEvent } from "../shared/types";
import {
  basePoints,
  EVENT_META,
  getAchievements,
  getLeaderboard,
  getMetrics,
  SCORING_RULES,
} from "./lib/activity";
import {
  filterEvents,
  getTimelineCutoff,
  getTimelineRange,
  getWindowEvents,
} from "./lib/feedView";
import { useFeed, type FeedController } from "./hooks/useFeed";
import { HealthSharePanel } from "./components/HealthSharePanel";
import { SharedHealth } from "./components/SharedHealth";
import { ServiceHealth } from "./components/ServiceHealth";
import { AccountPanel } from "./components/AccountPanel";
import { ShipNoteComposer } from "./components/ShipNoteComposer";
import { Modal } from "./components/Modal";
import { LiveLeaderboard } from "./components/LiveLeaderboard";
import { SharePanel } from "./components/SharePanel";
import { SharedDashboard } from "./components/SharedDashboard";
import type { CreatedDashboardShare } from "../shared/shares";
import { DashboardPulse } from "./components/DashboardPulse";
import { ActivityCelebration } from "./components/ActivityCelebration";
import { useActivityCelebration } from "./hooks/useActivityCelebration";
import { useEngineeringWall } from "./hooks/useEngineeringWall";
import { EngineeringWall } from "./components/EngineeringWall";
import { ThemeToggle } from "./components/ThemeToggle";

type Page =
  "dashboard" | "feed" | "team" | "milestones" | "repositories" | "health";
type Kind = ActivityEvent["type"];
type Period = "24h" | "7d" | "30d";
const icons: Record<Kind, ElementType> = {
  merge: GitMerge,
  review: MessageSquare,
  push: GitCommitHorizontal,
  issue: CheckCheck,
  release: Rocket,
  pr: GitPullRequest,
  note: NotebookPen,
};
const verbs: Record<Kind, string> = {
  merge: "merged",
  review: "reviewed",
  push: "pushed",
  issue: "closed",
  release: "released",
  pr: "opened",
  note: "shipped",
};
const names: Record<string, string> = {
  alexchen: "Alex Chen",
  sarahpark: "Sarah Park",
  minhnguyen: "Minh Nguyen",
  emmarivera: "Emma Rivera",
  jordanlee: "Jordan Lee",
  leowang: "Leo Wang",
};
const periodNames: Record<Period, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};
const shortRepo = (repo: string) =>
  repo === "journal/notes" ? "Ship notes" : repo.split("/").pop() || repo;
function safeUrl(url?: string) {
  try {
    const parsed = new URL(url || "");
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
function ago(timestamp: string, now = Date.now()) {
  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(timestamp)) / 60000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function clock(timestamp: number, period: Period) {
  return new Date(timestamp).toLocaleString(
    undefined,
    period === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}
function Avatar({
  login,
  url,
  demo,
}: {
  login: string;
  url?: string;
  demo: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const display = demo ? names[login] || login : login;
  const initials = display.includes(" ")
    ? display
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
    : display.slice(0, 2);
  return (
    <span className="avatar" aria-label={display}>
      {url?.startsWith("https://avatars.githubusercontent.com/") && !failed ? (
        <img src={url} alt="" onError={() => setFailed(true)} />
      ) : (
        initials.toUpperCase()
      )}
    </span>
  );
}

export default function App() {
  if (window.location.pathname.replace(/\/$/, "") === "/share/health")
    return <SharedHealth />;
  return window.location.pathname.replace(/\/$/, "") === "/share" ? (
    <SharedDashboard />
  ) : (
    <PrivateApp />
  );
}

function PrivateApp() {
  const feed = useFeed();
  return <WorkspaceView key={feed.scopeKey} feed={feed} />;
}

function WorkspaceView({ feed }: { feed: FeedController }) {
  const personal = feed.workspace?.kind === "personal";
  const canWriteNote =
    personal && feed.workspace?.owner && feed.operation?.status !== "pending";
  const [page, setPage] = useState<Page>("dashboard");
  const engineering = useEngineeringWall(
    feed.workspace?.kind === "team" ? feed.workspace.id : undefined,
    page === "dashboard",
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [repo, setRepo] = useState("");
  const [period, setPeriod] = useState<Period>("24h");
  const [replay, setReplay] = useState<{ end: number; percent: number } | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<CreatedDashboardShare | null>(
    null,
  );
  const [moving, setMoving] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [wall, setWall] = useState(false);
  const [celebrations, setCelebrations] = useState(true);
  const [modal, setModal] = useState<
    "connect" | "rules" | "settings" | "note" | "share" | "health-share" | null
  >(null);
  useEffect(() => {
    if (!feed.session.user || !feed.workspace) return;
    const url = new URL(window.location.href);
    if (
      ["connected", "installed"].includes(url.searchParams.get("github") || "")
    ) {
      setModal("connect");
      url.searchParams.delete("github");
      // Installation IDs in callback URLs are never used as authorization or selection.
      url.searchParams.delete("installation_id");
      url.searchParams.delete("setup_action");
      window.history.replaceState(
        null,
        "",
        url.pathname + url.search + url.hash,
      );
    }
  }, [feed.session.user?.id, feed.workspace?.id]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = feed.events.find((event) => event.id === detailId) || null;
  const [actionError, setActionError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const liveEffects = useActivityCelebration(feed.events, {
    scope: feed.scopeKey,
    ready: feed.demo || (feed.hasSnapshot && !feed.error),
    enabled:
      celebrations &&
      page === "dashboard" &&
      !feed.paused &&
      !replay &&
      !syncing &&
      !modal,
  });
  const [toast, setToast] = useState("");
  const [limit, setLimit] = useState(30);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const metrics = useMemo(
    () => getMetrics(feed.events, now),
    [feed.events, now],
  );
  const people = useMemo(
    () => getLeaderboard(feed.events, now),
    [feed.events, now],
  );
  const achievements = useMemo(
    () => getAchievements(feed.events, now),
    [feed.events, now],
  );
  const range = getTimelineRange(period, replay?.end ?? now);
  const cutoff = getTimelineCutoff(
    range.start,
    range.end,
    replay?.percent ?? 100,
  );
  const windowEvents = useMemo(
    () => getWindowEvents(feed.events, range.start, range.end),
    [feed.events, range.start, range.end],
  );
  const allRepositories = useMemo(
    () => [...new Set(feed.events.map((e) => e.repo))].sort(),
    [feed.events],
  );
  const visible = useMemo(
    () =>
      filterEvents(windowEvents, { repo, kind, query }).filter(
        (e) => Date.parse(e.occurredAt) <= cutoff,
      ),
    [windowEvents, repo, kind, query, cutoff],
  );
  const activeFilters = Boolean(query || kind || repo);
  const selected = visible.find((e) => e.id === selectedId);
  const shownEvents =
    page === "dashboard" && selected
      ? [selected, ...visible.filter((e) => e.id !== selected.id)].slice(0, 5)
      : visible.slice(0, page === "dashboard" ? 5 : limit);
  const status = feed.demo
    ? "Demo"
    : feed.loading
      ? "Syncing"
      : feed.error
        ? "Needs attention"
        : feed.paused
          ? "Updates paused"
          : feed.streaming
            ? "Connected"
            : "Polling";
  const displayName = (login: string) =>
    feed.demo ? names[login] || login : login;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setNow(Date.now());
  }, [feed.events]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    setLimit(30);
  }, [query, kind, repo, period, page]);
  useEffect(() => {
    if (selectedId && !visible.some((e) => e.id === selectedId))
      setSelectedId(null);
  }, [visible, selectedId]);
  useEffect(() => {
    setRepo("");
    setKind("");
    setQuery("");
    setReplay(null);
    setSelectedId(null);
    setDetailId(null);
  }, [feed.organization]);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const onReduced = () => {
      if (reduced.matches) setMoving(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPage("feed");
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (e.key === "Escape") setWall(false);
    };
    const onFullscreen = () => {
      if (!document.fullscreenElement) setWall(false);
    };
    reduced.addEventListener("change", onReduced);
    document.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      reduced.removeEventListener("change", onReduced);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, []);
  function clearFilters() {
    setQuery("");
    setKind("");
    setRepo("");
    setSelectedId(null);
  }
  function openConnect() {
    setModal("connect");
  }
  async function syncGithub() {
    setSyncing(true);
    setActionError("");
    try {
      const result = await feed.sync();
      setToast(result?.notice || "GitHub activity refreshed");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not sync GitHub activity.",
      );
    } finally {
      setSyncing(false);
    }
  }
  async function deleteNote(id: string) {
    setDetailId(null);
    setActionError("");
    try {
      await feed.deleteNote(id);
      setToast("Ship note deleted");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not delete your note.",
      );
    }
  }
  async function toggleWall() {
    const next = !wall;
    setWall(next);
    if (next && page !== "health") setPage("dashboard");
    try {
      if (next) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* The display layout also works without browser fullscreen. */
    }
  }
  function selectEvent(event: ActivityEvent) {
    setSelectedId(event.id);
  }

  function renderFeed(full = false) {
    return (
      <section
        className={`activity-feed ${full ? "full-feed" : ""}`}
        aria-label="Shipping activity feed"
      >
        <div className="section-heading">
          <h2>
            {replay ? "Activity replay" : "Live activity"}
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
            {!full && (
              <button
                className="icon-button"
                onClick={() => setPage("feed")}
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
              onChange={(e) => setKind(e.target.value as Kind | "")}
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
                onChange={(e) => setRepo(e.target.value)}
              >
                <option value="">
                  {personal ? "All sources" : "All repositories"}
                </option>
                {allRepositories.map((r) => (
                  <option key={r} value={r}>
                    {shortRepo(r)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(activeFilters || replay) && (
            <button
              className="text-button clear-filter"
              onClick={() => {
                clearFilters();
                setReplay(null);
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
          {shownEvents.map((event) => {
            const Icon = icons[event.type];
            const isSelected = selectedId === event.id;
            return (
              <article
                key={event.id}
                className={`event-row ${isSelected ? "selected" : ""} ${liveEffects.highlightedIds.has(event.id) ? `activity-new ${moving ? "with-activity-motion" : ""}` : ""}`}
              >
                <button
                  className="event-select"
                  aria-pressed={isSelected}
                  onClick={() => selectEvent(event)}
                >
                  <span className="event-topline">
                    <Icon size={14} className={`event-icon ${event.type}`} />
                    <span className="event-actor">
                      {displayName(event.actor.login)}{" "}
                      <span>{verbs[event.type]}</span>
                    </span>
                    <time
                      dateTime={event.occurredAt}
                      title={new Date(event.occurredAt).toLocaleString()}
                    >
                      {ago(event.occurredAt, replay ? cutoff : now)}
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
                      {liveEffects.highlightedIds.has(event.id) && (
                        <span className="new-activity-badge">New</span>
                      )}
                      {EVENT_META[event.type].label}
                    </span>
                  </span>
                </button>
                {isSelected && (
                  <div className="event-expanded">
                    <button
                      className="text-button"
                      onClick={() => setDetailId(event.id)}
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
                  : replay
                    ? "No activity at this point"
                    : personal
                      ? "Your journal starts with one ship"
                      : "Waiting for the first signal"}
            </h3>
            <p>
              {activeFilters
                ? "Try another repository, activity type, or search."
                : replay
                  ? "Move the timeline forward to see later events."
                  : personal
                    ? "Add a ship note, or connect GitHub to bring your work into your dashboard."
                    : "Received GitHub events will appear here and on the leaderboard."}
            </p>
            {activeFilters ? (
              <button className="button secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : replay ? (
              <button
                className="button secondary"
                onClick={() => setReplay(null)}
              >
                Return to now
              </button>
            ) : canWriteNote ? (
              <button
                className="button secondary"
                onClick={() => setModal("note")}
              >
                <Plus size={14} /> Add a ship note
              </button>
            ) : !feed.demo ? (
              <button className="text-button" onClick={openConnect}>
                Manage connection <ArrowUpRight size={13} />
              </button>
            ) : null}
          </div>
        )}
        {visible.length > shownEvents.length && (
          <button
            className="feed-more"
            onClick={() => (full ? setLimit(limit + 30) : setPage("feed"))}
          >
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
              <button className="text-button" onClick={() => setModal("note")}>
                <Plus size={13} /> Add a ship note
              </button>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className={`app-shell ${wall ? "wall-mode" : ""}`}>
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("dashboard");
          }}
        >
          ship<span>.</span>live
        </a>
        <button className="organization-switch" onClick={openConnect}>
          {!feed.demo && <LockKeyhole size={12} />}
          <span>{feed.demo ? "Demo workspace" : feed.organization}</span>
          <ChevronDown size={13} />
        </button>
        <nav aria-label="Main navigation">
          {(
            [
              ["dashboard", "Dashboard"],
              ["health", "Service Health"],
              ["feed", "Live feed"],
              ["team", "Team"],
              ["milestones", "Milestones"],
              ["repositories", "Repositories"],
            ] as const
          )
            .filter(
              ([id]) =>
                (!personal || (id !== "team" && id !== "milestones")) &&
                (id !== "health" ||
                  (!feed.demo && feed.workspace?.kind === "team")),
            )
            .map(([id, label]) => (
              <button
                key={id}
                aria-current={page === id ? "page" : undefined}
                onClick={() => setPage(id)}
              >
                {personal && id === "feed"
                  ? "Journal"
                  : personal && id === "repositories"
                    ? "Sources"
                    : label}
              </button>
            ))}
        </nav>
        <div className="header-tools">
          {page !== "health" && (
            <span
              className={`connection-status ${feed.error ? "has-error" : ""}`}
            >
              <span />
              {status}
            </span>
          )}
          {!feed.session.user && (
            <button
              className="text-button sign-in-button"
              onClick={openConnect}
            >
              Sign in
            </button>
          )}
          <ThemeToggle />
          <button
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={wall ? "Exit wall display" : "Open wall display"}
            title={wall ? "Exit wall display" : "Open wall display"}
            onClick={() => void toggleWall()}
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
            <h1>
              {
                {
                  dashboard: personal
                    ? "Your week, in motion."
                    : "Great work. Shared momentum.",
                  feed: personal
                    ? "The shipping journal."
                    : "The activity log.",
                  health: "Service Health",
                  team: "The people behind it.",
                  milestones: "Built, together.",
                  repositories: "Where work takes shape.",
                }[page]
              }
            </h1>
          </div>
          <div className="page-tools">
            {feed.demo && page === "dashboard" && (
              <button
                className="button secondary demo-activity-button"
                onClick={feed.simulateActivity}
                disabled={feed.paused || Boolean(liveEffects.celebration)}
                title="Add a fictional activity to preview live updates"
              >
                <Sparkles size={15} /> Try live activity
              </button>
            )}
            {!personal && (
              <button
                className="button secondary share-dashboard-button"
                onClick={() =>
                  setModal(page === "health" ? "health-share" : "share")
                }
              >
                <Share2 size={15} />{" "}
                {page === "health" ? "Share service health" : "Share dashboard"}
              </button>
            )}
            {page === "feed" && (
              <>
                <label className="search-box">
                  <Search size={15} />
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search activity"
                    placeholder="Search activity"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
                </label>
                <select
                  aria-label="Activity time period"
                  value={period}
                  onChange={(e) => {
                    setPeriod(e.target.value as Period);
                    setReplay(null);
                    setSelectedId(null);
                  }}
                >
                  {(Object.keys(periodNames) as Period[]).map((p) => (
                    <option key={p} value={p}>
                      {periodNames[p]}
                    </option>
                  ))}
                </select>
              </>
            )}
            {canWriteNote ? (
              <button
                className="button connect-button"
                onClick={() => setModal("note")}
              >
                <Plus size={15} /> Add ship note
              </button>
            ) : (
              feed.demo && (
                <button className="button connect-button" onClick={openConnect}>
                  <BookOpen size={15} />
                  {feed.session.user
                    ? "Open your journal"
                    : "Start your journal"}
                </button>
              )
            )}
          </div>
        </div>
        {feed.demo && (
          <p className="demo-notice">
            Fictional demo activity.{" "}
            {feed.session.user
              ? "Your private journal is in the workspace menu."
              : "Sign in to start your own private journal."}
          </p>
        )}
        {actionError && (
          <div className="notice error-notice" role="alert">
            {actionError}
          </div>
        )}
        {feed.operation && (
          <div
            className={`notice ${feed.operation.status === "failed" ? "error-notice" : ""}`}
            role={feed.operation.status === "failed" ? "alert" : "status"}
          >
            <span>
              {feed.operation.status === "pending"
                ? feed.operation.kind === "disconnect"
                  ? "Disconnecting GitHub…"
                  : "Deleting ship note…"
                : feed.operation.error}
            </span>
            {feed.operation.status === "failed" && (
              <>
                <button
                  className="text-button"
                  onClick={() => void feed.retryOperation()}
                >
                  {feed.operation.kind === "disconnect"
                    ? "Retry disconnect"
                    : "Retry delete"}
                </button>
                <button className="text-button" onClick={() => feed.refresh()}>
                  Reload activity
                </button>
              </>
            )}
          </div>
        )}
        {page !== "health" && feed.error && !feed.operation && (
          <div className="notice error-notice" role="alert">
            <span>{feed.error}</span>
            <button className="text-button" onClick={openConnect}>
              Manage connection
            </button>
            <button
              className="icon-button"
              aria-label="Retry connection"
              onClick={() => void feed.refresh()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        )}
        {page !== "health" && !feed.error && !feed.operation && feed.notice && (
          <div className="notice">
            <span>{feed.notice}</span>
          </div>
        )}
        {(page === "dashboard" || page === "feed") && (
          <>
            {page === "dashboard" ? (
              <div className="dashboard-layout">
                {!personal ? (
                  <EngineeringWall
                    snapshot={engineering.data}
                    health={engineering.health}
                    events={feed.events}
                    now={now}
                    demo={feed.demo}
                    moving={moving}
                    loading={feed.loading || engineering.loading}
                    onToggleMotion={() => setMoving(!moving)}
                    onRules={() => setModal("rules")}
                    onMilestones={() => setPage("milestones")}
                    status={
                      feed.demo
                        ? "Demo"
                        : feed.paused
                          ? "Paused"
                          : feed.streaming
                            ? "Live"
                            : feed.loading
                              ? "Syncing"
                              : "Polling"
                    }
                  />
                ) : (
                  <LiveLeaderboard
                    events={feed.events}
                    now={now}
                    demo={feed.demo}
                    moving={moving}
                    loading={feed.loading}
                    onToggleMotion={() => setMoving(!moving)}
                    onRules={() => setModal("rules")}
                    status={status}
                  />
                )}
                <aside className="dashboard-sidebar">{renderFeed()}</aside>
              </div>
            ) : (
              <div className="feed-page">{renderFeed(true)}</div>
            )}
            {page === "feed" && (
              <div className="timeline">
                <div className="timeline-track">
                  <label className="sr-only" htmlFor="activity-timeline">
                    Activity timeline
                  </label>
                  <input
                    id="activity-timeline"
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={replay?.percent ?? 100}
                    aria-valuetext={clock(cutoff, "7d")}
                    onChange={(e) => {
                      const percent = Number(e.target.value);
                      setReplay(
                        percent === 100
                          ? null
                          : { end: replay?.end ?? now, percent },
                      );
                    }}
                  />
                  <div className="timeline-labels">
                    {[0, 0.25, 0.5, 0.75, 1].map((fraction, i) => (
                      <span
                        key={fraction}
                        className={i % 2 ? "minor-tick" : ""}
                      >
                        {clock(
                          range.start + (range.end - range.start) * fraction,
                          period,
                        )}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  className={`timeline-now ${!replay ? "is-live" : ""}`}
                  onClick={() => setReplay(null)}
                  aria-label="Return to latest activity"
                >
                  <span />
                  Now
                </button>
              </div>
            )}
          </>
        )}
        {page === "health" &&
          !feed.demo &&
          feed.workspace?.kind === "team" &&
          feed.session.csrfToken && (
            <ServiceHealth
              workspaceId={feed.workspace.id}
              csrfToken={feed.session.csrfToken}
            />
          )}
        {page === "team" && (
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
              <button className="text-button" onClick={() => setModal("rules")}>
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
                    <Avatar
                      login={person.login}
                      url={person.avatarUrl}
                      demo={feed.demo}
                    />
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
              Reviews, releases, merges, and new commits all count. Weekly
              recognition excludes bot accounts and resets Monday at 00:00 UTC.
            </p>
          </section>
        )}
        {page === "milestones" && (
          <section className="milestones-page">
            <div className="section-heading">
              <h2>Shared milestones</h2>
              <span className="period-note">This week · UTC</span>
            </div>
            <div className="milestone-list">
              {achievements.map((a) => {
                const Icon = icons[a.kind];
                return (
                  <article className="milestone" key={a.id}>
                    <Icon size={24} strokeWidth={1.2} />
                    <div>
                      <span
                        className={`milestone-state ${a.unlocked ? "complete" : ""}`}
                      >
                        {a.unlocked ? "Reached together" : "In progress"}
                      </span>
                      <h2>{a.title}</h2>
                      <p>{a.description}</p>
                      <div
                        className="goal-track"
                        role="progressbar"
                        aria-label={a.title}
                        aria-valuemin={0}
                        aria-valuemax={a.target}
                        aria-valuenow={a.progress}
                      >
                        <span
                          style={{ width: `${(a.progress / a.target) * 100}%` }}
                        />
                      </div>
                    </div>
                    <strong className="milestone-number">
                      {a.progress}
                      <small> / {a.target}</small>
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
        )}
        {page === "repositories" && (
          <section className="repositories-page">
            <div className="section-heading">
              <h2>
                {allRepositories.length} {personal ? "sources" : "repositories"}
              </h2>
              <span className="period-note">Weekly activity · UTC</span>
            </div>
            <div className="repository-list">
              {allRepositories.map((repository) => {
                const events = feed.events.filter((e) => e.repo === repository),
                  m = getMetrics(events, now);
                return (
                  <button
                    className="repository-row"
                    key={repository}
                    onClick={() => {
                      clearFilters();
                      setRepo(repository);
                      setPeriod("30d");
                      setReplay(null);
                      setPage("dashboard");
                    }}
                  >
                    <FolderGit2 size={21} />
                    <span className="repository-identity">
                      <strong>{shortRepo(repository)}</strong>
                      <small>{repository}</small>
                    </span>
                    <span>
                      {m.merges}
                      <small>merges</small>
                    </span>
                    <span>
                      {m.reviews}
                      <small>reviews</small>
                    </span>
                    <span className="repository-latest">
                      {ago(events[0].occurredAt, now)}
                    </span>
                    <ArrowUpRight size={18} />
                  </button>
                );
              })}
            </div>
            {!allRepositories.length && (
              <div className="empty-state">
                <h3>Repositories appear with activity</h3>
                <p>Connect GitHub to start receiving repository activity.</p>
                <button className="button" onClick={openConnect}>
                  Manage connection
                </button>
              </div>
            )}
          </section>
        )}
        <footer className="app-footer">
          <span>
            {feed.demo
              ? "Fictional sample data"
              : personal
                ? "Private journal · visible only to you"
                : `${feed.organization} · Private workspace`}
          </span>
          {page !== "health" && (
            <div>
              <span>
                {feed.demo
                  ? "Explore at your own pace"
                  : `Updated ${ago(feed.updatedAt, now)}`}
              </span>
              <button
                className="icon-button"
                aria-label="Refresh activity"
                title="Refresh activity"
                disabled={feed.loading}
                onClick={() => void feed.refresh()}
              >
                <RefreshCw size={13} className={feed.loading ? "spin" : ""} />
              </button>
            </div>
          )}
        </footer>
      </main>
      <ActivityCelebration
        celebration={liveEffects.celebration}
        moving={moving}
        displayName={displayName}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal === "health-share" &&
        !feed.demo &&
        feed.workspace?.kind === "team" &&
        feed.session.csrfToken && (
          <Modal title="Share service health" onClose={() => setModal(null)}>
            <HealthSharePanel
              workspaceId={feed.workspace.id}
              csrfToken={feed.session.csrfToken}
            />
          </Modal>
        )}
      {modal === "share" && feed.demo && (
        <Modal title="Share dashboard" onClose={() => setModal(null)}>
          <p className="modal-description">
            Share a connected team dashboard with a read-only link. Choose an
            expiration, rotate the link, or revoke access at any time.
          </p>
          <p className="field-hint">
            Sign in and connect a team workspace to create a share link.
            Fictional demo activity cannot be shared.
          </p>
          <button className="button primary" onClick={openConnect}>
            {feed.session.user ? "Choose team workspace" : "Sign in to share"}
          </button>
        </Modal>
      )}
      {modal === "share" && feed.workspace?.kind === "team" && (
        <Modal title="Share dashboard" onClose={() => setModal(null)}>
          <SharePanel feed={feed} link={shareLink} onLink={setShareLink} />
        </Modal>
      )}
      {modal === "connect" && (
        <Modal
          title={feed.session.user ? "Your workspace" : "Your shipping journal"}
          onClose={() => setModal(null)}
        >
          <AccountPanel feed={feed} onClose={() => setModal(null)} />
        </Modal>
      )}
      {modal === "note" && canWriteNote && (
        <Modal title="Add a ship note" onClose={() => setModal(null)}>
          <ShipNoteComposer
            onSave={async (input) => {
              await feed.addNote(input);
              setModal(null);
              setToast("Ship note saved privately");
            }}
          />
        </Modal>
      )}
      {modal === "rules" && (
        <Modal title="Good work, recognized" onClose={() => setModal(null)}>
          <p className="modal-description">
            Weekly XP celebrates visible contributions. It is a conversation
            starter, never a performance score.
          </p>
          <div className="scoring-rules">
            {SCORING_RULES.map((rule) => {
              const Icon = icons[rule.type];
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
            Bot accounts and duplicate events are excluded. Review XP counts
            once per reviewer, pull request, and UTC day. Commit XP counts only
            commits new to the repository, so each commit is credited once.
            Weeks start Monday at 00:00 UTC. Public history can be incomplete;
            totals reflect received activity.
          </p>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Workspace settings" onClose={() => setModal(null)}>
          <section className="settings-section">
            <h3>
              {feed.session.user ? feed.session.user.name : "Your account"}
            </h3>
            <p>
              {feed.demo
                ? "You’re exploring fictional sample activity."
                : personal
                  ? "Your journal is private and visible only to you."
                  : `Viewing ${feed.organization}. Repository access is checked for your account.`}
            </p>
            <button className="button primary" onClick={openConnect}>
              {feed.session.user ? "Account and GitHub connections" : "Sign in"}
            </button>
            {!feed.demo && feed.githubConnected && (
              <>
                <button
                  className="text-button"
                  disabled={syncing}
                  onClick={() => void syncGithub()}
                >
                  <RefreshCw size={14} className={syncing ? "spin" : ""} />
                  {syncing
                    ? "Importing recent activity…"
                    : "Sync GitHub activity"}
                </button>
                <p className="field-hint">
                  New activity arrives automatically. Sync re-reads your
                  repository access, which spends your GitHub API quota shared
                  with your other GitHub tools, and imports recent history. Use
                  it after changing access in GitHub or if activity looks
                  missing; repeat syncs only fetch what changed since the last
                  one.
                </p>
              </>
            )}
          </section>
          <section className="settings-section">
            <h3>Motion and live updates</h3>
            <label className="settings-toggle">
              <span>Highlight and celebrate new activity</span>
              <input
                type="checkbox"
                checked={celebrations}
                onChange={(e) => setCelebrations(e.target.checked)}
              />
            </label>
            <label className="settings-toggle">
              <span>Animate dashboard</span>
              <input
                type="checkbox"
                checked={moving}
                onChange={(e) => setMoving(e.target.checked)}
              />
            </label>
            <label className="settings-toggle">
              <span>Receive live updates</span>
              <input
                type="checkbox"
                checked={!feed.paused}
                onChange={(e) => feed.setPaused(!e.target.checked)}
              />
            </label>
            <button
              className="button secondary"
              onClick={() => {
                setModal(null);
                void toggleWall();
              }}
            >
              <Maximize2 size={15} />
              {wall ? "Exit wall display" : "Open wall display"}
            </button>
          </section>
          <section className="settings-section">
            <h3>A journal for what you build</h3>
            <p>
              Keep a personal ship journal or follow your team’s work. GitHub
              connections use the repositories you choose in the GitHub App
              installation.
            </p>
            <span className="version">ship.live / 0.1.0</span>
          </section>
        </Modal>
      )}
      {detail && (
        <Modal title="Activity details" onClose={() => setDetailId(null)}>
          <div className="detail-person">
            <Avatar
              login={detail.actor.login}
              url={detail.actor.avatarUrl}
              demo={feed.demo}
            />
            <div>
              <strong>{displayName(detail.actor.login)}</strong>
              <span>{EVENT_META[detail.type].verb}</span>
            </div>
          </div>
          <h3 className="detail-title">{detail.title}</h3>
          <p className="detail-repo">
            <FolderGit2 size={15} />
            {detail.type === "note" ? "Private journal" : detail.repo}
            {detail.number ? ` #${detail.number}` : ""}
            {detail.type === "merge" && detail.branch
              ? ` into ${detail.branch}`
              : ""}
          </p>
          <p className="detail-date">
            {new Date(detail.occurredAt).toLocaleString()}
          </p>
          {detail.additions !== undefined && (
            <p className="diff-stat">
              +{detail.additions} additions{" "}
              <span>−{detail.deletions ?? 0} deletions</span>
            </p>
          )}
          {detail.body && <p className="note-body">{detail.body}</p>}
          {!personal && detail.type !== "note" && (
            <p className="field-hint">
              Base recognition: {basePoints(detail)} XP
              {detail.type === "push" && detail.commits !== undefined
                ? ` for ${detail.commits} new commit${detail.commits === 1 ? "" : "s"}`
                : ""}
              . The weekly board applies duplicate and review limits.
            </p>
          )}
          {detail.type === "note" && (
            <p className="privacy-note">
              <LockKeyhole size={14} /> Only you can see this ship note.
            </p>
          )}
          {!feed.demo && safeUrl(detail.url) ? (
            <a
              className="button primary full-width"
              href={safeUrl(detail.url)}
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub <ExternalLink size={15} />
            </a>
          ) : (
            detail.type !== "note" && (
              <p className="field-hint">
                {feed.demo
                  ? "This is fictional sample activity."
                  : "No GitHub link was supplied for this event."}
              </p>
            )
          )}
          {detail.type === "note" && canWriteNote && (
            <button
              className="text-button danger-button"
              onClick={() => void deleteNote(detail.id)}
            >
              <Trash2 size={14} /> Delete ship note
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}
