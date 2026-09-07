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
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Settings2,
  Users,
  X,
} from "lucide-react";
import type { ActivityEvent } from "../shared/types";
import {
  EVENT_META,
  getAchievements,
  getLeaderboard,
  getMetrics,
} from "./lib/activity";
import {
  filterEvents,
  getTimelineCutoff,
  getTimelineRange,
  getViewCounts,
  getWindowEvents,
} from "./lib/feedView";
import { useFeed } from "./hooks/useFeed";
import { Modal } from "./components/Modal";
import { OrbitScene } from "./components/OrbitScene";

type Page = "orbit" | "feed" | "team" | "milestones" | "repositories";
type Kind = ActivityEvent["type"];
type Period = "24h" | "7d" | "30d";
const icons: Record<Kind, ElementType> = {
  merge: GitMerge,
  review: MessageSquare,
  push: GitCommitHorizontal,
  issue: CheckCheck,
  release: Rocket,
  pr: GitPullRequest,
};
const verbs: Record<Kind, string> = {
  merge: "merged",
  review: "reviewed",
  push: "pushed",
  issue: "closed",
  release: "released",
  pr: "opened",
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
const shortRepo = (repo: string) => repo.split("/").pop() || repo;
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
  const feed = useFeed();
  const [page, setPage] = useState<Page>("orbit");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [repo, setRepo] = useState("");
  const [period, setPeriod] = useState<Period>("24h");
  const [replay, setReplay] = useState<{ end: number; percent: number } | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [moving, setMoving] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [wall, setWall] = useState(false);
  const [modal, setModal] = useState<"connect" | "rules" | "settings" | null>(
    null,
  );
  const [detail, setDetail] = useState<ActivityEvent | null>(null);
  const [orgInput, setOrgInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [connectError, setConnectError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [toast, setToast] = useState("");
  const [limit, setLimit] = useState(30);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const connectionAttempt = useRef(0);
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
  const repositories = useMemo(
    () => [...new Set(windowEvents.map((e) => e.repo))].sort(),
    [windowEvents],
  );
  const allRepositories = useMemo(
    () => [...new Set(feed.events.map((e) => e.repo))].sort(),
    [feed.events],
  );
  const sceneEvents = useMemo(
    () => filterEvents(windowEvents, { repo: "", kind, query }),
    [windowEvents, kind, query],
  );
  const visible = useMemo(
    () =>
      filterEvents(windowEvents, { repo, kind, query }).filter(
        (e) => Date.parse(e.occurredAt) <= cutoff,
      ),
    [windowEvents, repo, kind, query, cutoff],
  );
  const counts = useMemo(() => getViewCounts(visible), [visible]);
  const repositoryButtons =
    repo && !repositories.includes(repo)
      ? [...repositories, repo].sort()
      : repositories;
  const activeFilters = Boolean(query || kind || repo);
  const selected = visible.find((e) => e.id === selectedId);
  const shownEvents =
    page === "orbit" && selected
      ? [selected, ...visible.filter((e) => e.id !== selected.id)].slice(0, 5)
      : visible.slice(0, page === "orbit" ? 5 : limit);
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
    setHoveredId(null);
    setDetail(null);
  }, [feed.organization]);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const onReduced = () => {
      if (reduced.matches) setMoving(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
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
    setOrgInput(feed.organization || feed.suggestedOrg);
    setKeyInput("");
    setConnectError("");
    setConnecting(false);
    setModal("connect");
  }
  function closeConnect() {
    connectionAttempt.current += 1;
    feed.cancelConnection();
    setConnecting(false);
    setKeyInput("");
    setModal(null);
  }
  function useDemo() {
    connectionAttempt.current += 1;
    feed.useDemo();
    setConnecting(false);
    setKeyInput("");
    setModal(null);
    clearFilters();
    setReplay(null);
    setDetail(null);
  }
  async function connect(e: React.FormEvent) {
    e.preventDefault();
    const attempt = ++connectionAttempt.current;
    setConnecting(true);
    setConnectError("");
    try {
      await feed.connect(orgInput, keyInput);
      if (attempt !== connectionAttempt.current) return;
      setModal(null);
      setKeyInput("");
      clearFilters();
      setReplay(null);
      setToast("GitHub organization connected");
    } catch (error) {
      if (attempt === connectionAttempt.current)
        setConnectError(
          error instanceof Error
            ? error.message
            : "Connection failed. Try again.",
        );
    } finally {
      if (attempt === connectionAttempt.current) setConnecting(false);
    }
  }
  async function toggleWall() {
    const next = !wall;
    setWall(next);
    if (next) setPage("orbit");
    try {
      if (next) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* The display layout also works without browser fullscreen. */
    }
  }
  function chooseRepo(value: string) {
    setRepo(value === repo ? "" : value);
    setSelectedId(null);
  }
  function selectEvent(event: ActivityEvent) {
    setSelectedId(event.id);
  }

  function renderFeed(full = false) {
    return (
      <section
        className={`activity-feed ${full ? "full-feed" : ""}`}
        aria-label="GitHub activity feed"
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
                <option value="">All repositories</option>
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
          <p className="feed-pause-note">Live updates are paused.</p>
        )}
        <div className="event-list">
          {shownEvents.map((event) => {
            const Icon = icons[event.type];
            const isSelected = selectedId === event.id;
            return (
              <article
                key={event.id}
                className={`event-row ${isSelected ? "selected" : ""}`}
                onMouseEnter={() => setHoveredId(event.id)}
                onMouseLeave={() => setHoveredId(null)}
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
                      {shortRepo(event.repo)}
                      {event.number ? ` / #${event.number}` : ""}
                    </span>
                    <span>{EVENT_META[event.type].label}</span>
                  </span>
                </button>
                {isSelected && (
                  <div className="event-expanded">
                    <button
                      className="text-button"
                      onClick={() => setDetail(event)}
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
                    : "Waiting for the first signal"}
            </h3>
            <p>
              {activeFilters
                ? "Try another repository, activity type, or search."
                : replay
                  ? "Move the timeline forward to see later events."
                  : "Received GitHub events will appear here and in Orbit."}
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
        {!full && (
          <div className="shared-goal">
            <div className="goal-label">
              <span>Shared milestone</span>
              <span>
                {achievements[0].progress} / {achievements[0].target}
              </span>
            </div>
            <h3>{achievements[0].title}</h3>
            <p>{achievements[0].description}</p>
            <div
              className="goal-track"
              role="progressbar"
              aria-label={achievements[0].title}
              aria-valuemin={0}
              aria-valuemax={achievements[0].target}
              aria-valuenow={achievements[0].progress}
            >
              <span
                style={{
                  width: `${(achievements[0].progress / achievements[0].target) * 100}%`,
                }}
              />
            </div>
            <button
              className="text-button"
              onClick={() => setPage("milestones")}
            >
              All team milestones <ArrowUpRight size={13} />
            </button>
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
            setPage("orbit");
          }}
        >
          ship<span>.</span>live
        </a>
        <button className="organization-switch" onClick={openConnect}>
          <span>{feed.demo ? "Demo workspace" : feed.organization}</span>
          <ChevronDown size={13} />
        </button>
        <nav aria-label="Main navigation">
          {(
            [
              ["orbit", "Orbit"],
              ["feed", "Live feed"],
              ["team", "Team"],
              ["milestones", "Milestones"],
              ["repositories", "Repositories"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="header-tools">
          <span
            className={`connection-status ${feed.error ? "has-error" : ""}`}
          >
            <span />
            {status}
          </span>
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
                  orbit: "Work, in orbit.",
                  feed: "The activity log.",
                  team: "The people behind it.",
                  milestones: "Built, together.",
                  repositories: "Where work takes shape.",
                }[page]
              }
            </h1>
          </div>
          <div className="page-tools">
            {(page === "orbit" || page === "feed") && (
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
            {feed.demo && (
              <button className="button connect-button" onClick={openConnect}>
                <Github size={15} />
                Connect GitHub
              </button>
            )}
          </div>
        </div>
        {feed.error && (
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
        {!feed.error && feed.notice && (
          <div className="notice">
            <span>{feed.notice}</span>
          </div>
        )}
        {(page === "orbit" || page === "feed") && (
          <>
            {page === "orbit" ? (
              <div className="orbit-layout">
                <section
                  className="orbit-workspace"
                  aria-label="Organization activity in Orbit"
                >
                  <div className="orbit-topline">
                    <span>
                      Orbit <span className="subtle-divider">/</span>{" "}
                      {periodNames[period].toLowerCase()}
                    </span>
                    <span>
                      {replay
                        ? `Replay · ${clock(cutoff, "7d")}`
                        : `${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}`}
                    </span>
                  </div>
                  <div className="orbit-stage">
                    <OrbitScene
                      events={sceneEvents}
                      repositories={repositories}
                      rangeStart={range.start}
                      rangeEnd={range.end}
                      cutoff={cutoff}
                      selectedId={selectedId}
                      hoveredId={hoveredId}
                      selectedRepo={repo}
                      playing={moving}
                      onSelect={selectEvent}
                      onHover={setHoveredId}
                    />
                    {!windowEvents.length && (
                      <div className="orbit-empty">
                        <span className="empty-orbit" aria-hidden="true" />
                        <h2>
                          {feed.loading
                            ? "Finding your orbit…"
                            : "Your next chapter starts here."}
                        </h2>
                        <p>No received activity in this time window.</p>
                        {!feed.demo && (
                          <button className="text-button" onClick={useDemo}>
                            Explore Orbit with sample data{" "}
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div
                    className="view-metrics"
                    aria-label="Activity in the current view"
                  >
                    <div>
                      <strong>{counts.merges}</strong>
                      <span>pull requests merged</span>
                    </div>
                    <div>
                      <strong>{counts.reviews}</strong>
                      <span>reviews submitted</span>
                    </div>
                    <div>
                      <strong>{counts.contributors}</strong>
                      <span>contributors</span>
                    </div>
                    <div className="metric-total">
                      <strong>{counts.total}</strong>
                      <span>events in view</span>
                    </div>
                  </div>
                  {repositoryButtons.length > 0 && (
                    <div
                      className="repository-orbits"
                      aria-label="Filter Orbit by repository"
                    >
                      {repositoryButtons.map((repository) => (
                        <button
                          key={repository}
                          aria-pressed={repo === repository}
                          aria-label={`Filter ${repository}`}
                          onClick={() => chooseRepo(repository)}
                        >
                          <span className="repo-orbit-dot" />
                          <span className="repo-name" title={repository}>
                            {shortRepo(repository)}
                          </span>
                          <span className="repo-count">
                            {
                              sceneEvents.filter(
                                (e) =>
                                  e.repo === repository &&
                                  Date.parse(e.occurredAt) <= cutoff,
                              ).length
                            }
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                <aside className="orbit-sidebar">{renderFeed()}</aside>
              </div>
            ) : (
              <div className="feed-page">{renderFeed(true)}</div>
            )}
            <div className="timeline">
              <button
                className="icon-button motion-button"
                aria-label={moving ? "Pause movement" : "Resume movement"}
                aria-pressed={!moving}
                title={moving ? "Pause movement" : "Resume movement"}
                onClick={() => setMoving(!moving)}
              >
                {moving ? <Pause size={16} /> : <Play size={16} />}
              </button>
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
                    <span key={fraction} className={i % 2 ? "minor-tick" : ""}>
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
          </>
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
              Reviews, releases, and shipping all count. Commit volume earns no
              XP. Weekly recognition excludes bot accounts and resets Monday at
              00:00 UTC.
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
              <h2>{allRepositories.length} repositories</h2>
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
                      setPage("orbit");
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
                <p>Connect your organization to start receiving events.</p>
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
              ? "Sample data · No GitHub account connected"
              : `${feed.organization} · Received activity only`}
          </span>
          <div>
            {page === "orbit" && (
              <span className="point-key">One point, one event</span>
            )}
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
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal === "connect" && (
        <Modal title="Connect your organization" onClose={closeConnect}>
          <p className="modal-description">
            Bring your team’s GitHub activity into Orbit. Public activity needs
            only an organization name.
          </p>
          <form onSubmit={connect}>
            <label className="field-label" htmlFor="org">
              GitHub organization
            </label>
            <div className="input-with-prefix">
              <span>github.com/</span>
              <input
                id="org"
                required
                value={orgInput}
                onChange={(e) => setOrgInput(e.target.value)}
                placeholder="your-organization"
                autoComplete="off"
              />
            </div>
            <label className="field-label" htmlFor="access-key">
              Dashboard access key <span>Optional</span>
            </label>
            <input
              id="access-key"
              className="text-input"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="For a protected feed"
              autoComplete="off"
            />
            <p className="field-hint">
              Your dashboard key stays in this tab’s memory. GitHub tokens
              belong on your server.
            </p>
            {connectError && (
              <p className="form-error" role="alert">
                {connectError}
              </p>
            )}
            <button
              className="button primary full-width"
              disabled={connecting}
              type="submit"
            >
              {connecting ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Github size={16} />
              )}{" "}
              {connecting ? "Connecting…" : "Connect organization"}
            </button>
          </form>
          <button className="text-button demo-link" onClick={useDemo}>
            Explore the demo instead <ArrowUpRight size={14} />
          </button>
        </Modal>
      )}
      {modal === "rules" && (
        <Modal title="Good work, recognized" onClose={() => setModal(null)}>
          <p className="modal-description">
            Weekly XP celebrates visible contributions. It is a conversation
            starter, never a performance score.
          </p>
          <div className="scoring-rules">
            {(
              ["release", "merge", "review", "issue", "pr", "push"] as Kind[]
            ).map((type) => {
              const Icon = icons[type];
              return (
                <div key={type}>
                  <Icon size={17} />
                  <span>{EVENT_META[type].verb}</span>
                  <strong>
                    {EVENT_META[type].points} <small>XP</small>
                  </strong>
                </div>
              );
            })}
          </div>
          <p className="field-hint">
            Bot accounts and duplicate events are excluded. Review XP counts
            once per reviewer, pull request, and UTC day. Weeks start Monday at
            00:00 UTC. Public history can be incomplete; totals reflect received
            activity.
          </p>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Workspace settings" onClose={() => setModal(null)}>
          <section className="settings-section">
            <h3>GitHub connection</h3>
            <p>
              {feed.demo
                ? "You’re exploring fictional sample activity."
                : `Connected to ${feed.organization}.`}
            </p>
            <button className="button primary" onClick={openConnect}>
              <Github size={15} />
              {feed.demo ? "Connect GitHub" : "Change organization"}
            </button>
            {!feed.demo && (
              <button className="text-button" onClick={useDemo}>
                Disconnect and use demo
              </button>
            )}
          </section>
          <section className="settings-section">
            <h3>Motion and live updates</h3>
            <label className="settings-toggle">
              <span>Animate Orbit</span>
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
            <h3>Run it for your team</h3>
            <p>
              Any GitHub organization can use ship.live. Connect organization
              webhooks on your server for immediate activity from private
              repositories. See the README for setup.
            </p>
            <span className="version">ship.live / 0.1.0</span>
          </section>
        </Modal>
      )}
      {detail && (
        <Modal title="Activity details" onClose={() => setDetail(null)}>
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
            {detail.repo}
            {detail.number ? ` #${detail.number}` : ""}
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
          <p className="field-hint">
            Base recognition: {EVENT_META[detail.type].points} XP. The weekly
            board applies duplicate and review limits.
          </p>
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
            <p className="field-hint">
              {feed.demo
                ? "This is fictional sample activity."
                : "No GitHub link was supplied for this event."}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
