import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { CreatedDashboardShare } from "../shared/shares";
import { getAchievements, getLeaderboard, getMetrics } from "./lib/activity";
import {
  filterEvents,
  getTimelineCutoff,
  getTimelineRange,
  getWindowEvents,
} from "./lib/feedView";
import { ago, PERIOD_NAMES, personName } from "./lib/format";
import { journalMarkdown, journalTags } from "./lib/journal";
import { PAGE_TITLES, type Period, type Route } from "./lib/routes";
import { createDemoHealth, demoSignals } from "./lib/demo-wall";
import { useFeed, type FeedController } from "./hooks/useFeed";
import { closeOverlay, navigate, useRoute } from "./hooks/useRoute";
import { useActivityCelebration } from "./hooks/useActivityCelebration";
import { useEngineeringWall } from "./hooks/useEngineeringWall";
import { AccountPanel } from "./components/AccountPanel";
import { ActivityCelebration } from "./components/ActivityCelebration";
import { AppHeader } from "./components/AppHeader";
import { ContributorProfile } from "./components/ContributorProfile";
import { RepositoryProfile } from "./components/RepositoryProfile";
import { EngineeringWall } from "./components/EngineeringWall";
import { EventDetail } from "./components/EventDetail";
import type { Kind } from "./components/event-kinds";
import { HealthSharePanel } from "./components/HealthSharePanel";
import { LiveLeaderboard } from "./components/LiveLeaderboard";
import { Modal } from "./components/Modal";
import { PersonalSourcesForm } from "./components/PersonalSourcesForm";
import { PulseHeadingForm } from "./components/PulseHeadingForm";
import { RepositoryList } from "./components/RepositoryList";
import { RouteLink } from "./components/RouteLink";
import { ScoringRules } from "./components/ScoringRules";
import { ServiceHealth } from "./components/ServiceHealth";
import { SettingsPanel } from "./components/SettingsPanel";
import { SharedDashboard } from "./components/SharedDashboard";
import { SharedHealth } from "./components/SharedHealth";
import { SharePanel } from "./components/SharePanel";
import { ShipNoteComposer } from "./components/ShipNoteComposer";
import { ActivityFeed, type ActivityFeedProps } from "./pages/ActivityFeed";
import { DemoHealthPage } from "./pages/DemoHealthPage";
import { FeedTimeline } from "./pages/FeedTimeline";
import { MilestonesPage } from "./pages/MilestonesPage";
import { TeamPage } from "./pages/TeamPage";
import { WebhooksPage } from "./pages/WebhooksPage";

const DEFAULT_TITLE = "ship.live — Great work. Shared momentum.";
const REPOSITORY_NOTE =
  "Activity from repositories your GitHub account can see. Sync imports part of the last 30 days; new pushes arrive through webhooks.";
const SOURCES_NOTE =
  "Your private journal notes and activity from repositories your GitHub account can see. Sync imports part of the last 30 days; new pushes arrive through webhooks.";

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
  const route = useRoute();
  const page = route.page;
  const personal = feed.workspace?.kind === "personal";
  const defaultPulseTitle = personal
    ? "Your week, in motion."
    : "Great work. Shared momentum.";
  // Members edit their workspace's heading; the demo keeps its own.
  const canEditHeading =
    page === "pulse" &&
    !feed.demo &&
    Boolean(
      feed.workspace &&
      (feed.workspace.kind === "team" || feed.workspace.owner),
    );
  const canWriteNote = Boolean(
    personal && feed.workspace?.owner && feed.operation?.status !== "pending",
  );
  const engineering = useEngineeringWall(
    feed.workspace?.kind === "team" ? feed.workspace.id : undefined,
    page === "pulse",
  );
  // Pulse's activity list keeps its own type filter; the Live feed's filters
  // live in the URL, so a filtered feed can be bookmarked and shared.
  const [pulseKind, setPulseKind] = useState<Kind | "">("");
  const onFeed = page === "feed";
  // Service Health and Webhooks have their own status; other pages follow the feed.
  const activity = page !== "health" && page !== "webhooks";
  const kind = onFeed ? (route.kind ?? "") : pulseKind;
  const repo = onFeed ? (route.repo ?? "") : "";
  const query = onFeed ? (route.query ?? "") : "";
  const period: Period = onFeed ? (route.period ?? "24h") : "24h";
  const tag = onFeed ? (route.tag ?? "") : "";
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
    | "connect"
    | "rules"
    | "settings"
    | "note"
    | "share"
    | "health-share"
    | "heading"
    | "sources"
    | null
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
  const profileLogin = route.person;
  const detail = feed.events.find((event) => event.id === detailId) || null;
  const [actionError, setActionError] = useState("");
  const syncing = feed.syncRun?.status === "running";
  const liveEffects = useActivityCelebration(feed.events, {
    scope: feed.scopeKey,
    ready: feed.demo || (feed.hasSnapshot && !feed.error),
    enabled:
      celebrations &&
      page === "pulse" &&
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
    // Alerts name their inbound endpoint, not a repository.
    () =>
      [
        ...new Set(
          feed.events.filter((e) => e.type !== "alert").map((e) => e.repo),
        ),
      ].sort(),
    [feed.events],
  );
  const visible = useMemo(
    () =>
      filterEvents(windowEvents, { repo, kind, query, tag }).filter(
        (e) => Date.parse(e.occurredAt) <= cutoff,
      ),
    [windowEvents, repo, kind, query, tag, cutoff],
  );
  const activeFilters = Boolean(query || kind || repo || tag);
  const selected = visible.find((e) => e.id === selectedId);
  const shownEvents =
    page === "pulse" && selected
      ? [selected, ...visible.filter((e) => e.id !== selected.id)].slice(0, 5)
      : visible.slice(0, page === "pulse" ? 5 : limit);
  // The signed-out demo shows no connection label.
  const status = feed.demo
    ? ""
    : feed.loading
      ? "Syncing"
      : feed.error
        ? "Needs attention"
        : feed.paused
          ? "Updates paused"
          : feed.streaming
            ? "Connected"
            : "Polling";
  const displayName = (login: string) => personName(login, feed.demo);
  /** Live feed filters replace the current history entry instead of adding one. */
  function updateFeed(changes: Partial<Route>) {
    navigate({ ...route, ...changes, page: "feed" }, { replace: true });
  }
  function setKind(next: Kind | "") {
    if (onFeed) updateFeed({ kind: next || undefined });
    else setPulseKind(next);
  }
  function clearFilters() {
    if (onFeed)
      updateFeed({
        kind: undefined,
        repo: undefined,
        query: undefined,
        tag: undefined,
      });
    else setPulseKind("");
    setSelectedId(null);
  }
  /** Downloads the Live feed's current view as Markdown. */
  function exportMarkdown() {
    const markdown = journalMarkdown(visible, {
      title: personal ? "Ship journal" : `${feed.organization} activity`,
      generatedAt: new Date().toISOString(),
    });
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${personal ? "ship-journal" : "activity"}-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const tags = useMemo(
    () => (personal ? journalTags(feed.events) : []),
    [personal, feed.events],
  );
  // A repository chosen in Pulse opens its activity in the Live feed.
  // A repository's details are part of the URL; Back closes them.
  function openRepository(repository: string) {
    navigate({ ...route, repository }, { overlay: true });
  }
  // Its full feed takes the dialog's place, so Back returns to the page.
  function viewRepositoryActivity(repository: string) {
    setReplay(null);
    setSelectedId(null);
    navigate(
      { page: "feed", repo: repository, period: "30d" },
      { replace: true },
    );
  }
  // Profiles are part of the URL; Back closes one opened here.
  function openProfile(login: string) {
    navigate({ ...route, person: login }, { overlay: true });
  }
  // Demo checks stay current: a probe reads as unknown after two missed intervals.
  const demoMinute = Math.floor(now / 60_000);
  const demoHealth = useMemo(
    () => (feed.demo ? createDemoHealth(demoMinute * 60_000) : null),
    [feed.demo, demoMinute],
  );
  // Personal journals have no Service Health; a link to it shows Pulse.
  useEffect(() => {
    if (
      (page === "health" || page === "webhooks") &&
      !feed.demo &&
      feed.workspace &&
      feed.workspace.kind !== "team"
    )
      navigate({ page: "pulse" }, { replace: true });
  }, [page, feed.demo, feed.workspace]);
  useEffect(() => {
    document.title =
      page === "pulse" ? DEFAULT_TITLE : `${PAGE_TITLES[page]} · ship.live`;
  }, [page]);

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
  // A background sync reports its outcome once, if this view saw it running.
  const watchedSync = useRef<string | null>(null);
  useEffect(() => {
    const run = feed.syncRun;
    if (!run) return;
    if (run.status === "running") {
      watchedSync.current = run.id;
      return;
    }
    if (watchedSync.current !== run.id) return;
    watchedSync.current = null;
    if (run.status === "succeeded")
      setToast(run.message || "GitHub activity synced");
    else setActionError(run.message || "Could not sync GitHub activity.");
  }, [feed.syncRun]);
  useEffect(() => {
    setLimit(30);
  }, [query, kind, repo, period, page]);
  // Replay belongs to the Live feed visit that started it.
  useEffect(() => {
    setReplay(null);
  }, [page]);
  useEffect(() => {
    if (selectedId && !visible.some((e) => e.id === selectedId))
      setSelectedId(null);
  }, [visible, selectedId]);
  useEffect(() => {
    setPulseKind("");
    setReplay(null);
    setSelectedId(null);
    setDetailId(null);
  }, [feed.organization]);
  const onFeedRef = useRef(onFeed);
  // Updated after commit, so the key listener never sees a discarded render.
  useLayoutEffect(() => {
    onFeedRef.current = onFeed;
  }, [onFeed]);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const onReduced = () => {
      if (reduced.matches) setMoving(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (!onFeedRef.current) navigate({ page: "feed" });
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
  function openConnect() {
    setModal("connect");
  }
  async function syncGithub() {
    setActionError("");
    try {
      await feed.sync();
      setToast("Sync started in the background.");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not start the GitHub sync.",
      );
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
    if (next && page !== "health") navigate({ page: "pulse" });
    try {
      if (next) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* The display layout also works without browser fullscreen. */
    }
  }

  const feedProps: ActivityFeedProps = {
    feed,
    personal,
    canWriteNote,
    replaying: Boolean(replay),
    visible,
    shown: shownEvents,
    timeNow: replay ? cutoff : now,
    kind,
    onKind: setKind,
    repo,
    onRepo: (next) => updateFeed({ repo: next || undefined }),
    repositories: allRepositories,
    tag,
    tags,
    onTag: (next) => updateFeed({ tag: next || undefined }),
    onExport: exportMarkdown,
    activeFilters,
    onClearFilters: clearFilters,
    onReturnToNow: () => setReplay(null),
    selectedId,
    onSelect: setSelectedId,
    onDetail: setDetailId,
    highlightedIds: liveEffects.highlightedIds,
    moving,
    displayName,
    // The Live feed opens with Pulse's activity type still applied.
    onViewAll: () => navigate({ page: "feed", kind: pulseKind || undefined }),
    onShowMore: () => setLimit(limit + 30),
    onAddNote: () => setModal("note"),
    onConnect: openConnect,
  };

  return (
    <div className={`app-shell ${wall ? "wall-mode" : ""}`}>
      <AppHeader
        feed={feed}
        page={page}
        status={status}
        wall={wall}
        onConnect={openConnect}
        onSettings={() => setModal("settings")}
        onToggleWall={() => void toggleWall()}
      />
      <main>
        <div className="page-heading">
          <div>
            {page === "feed" || page === "team" || page === "milestones" ? (
              <RouteLink
                className="text-button page-back"
                to={{ page: "pulse" }}
              >
                <ArrowLeft size={14} /> Pulse
              </RouteLink>
            ) : (
              <p className="date-line">
                {new Date(now).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            )}
            <div className="heading-line">
              <h1>
                {
                  {
                    pulse: feed.workspace?.pulseTitle || defaultPulseTitle,
                    feed: personal
                      ? "The shipping journal."
                      : "The activity log.",
                    health: "Service Health",
                    webhooks: "Webhooks",
                    team: "The people behind it.",
                    milestones: "Built, together.",
                  }[page]
                }
              </h1>
              {canEditHeading && (
                <button
                  type="button"
                  className="icon-button heading-edit"
                  aria-label="Edit Pulse heading"
                  onClick={() => setModal("heading")}
                >
                  <Pencil size={16} />
                </button>
              )}
            </div>
            {page === "pulse" &&
              !feed.demo &&
              feed.workspace?.pulseSubtitle && (
                <p className="page-subtitle">{feed.workspace.pulseSubtitle}</p>
              )}
          </div>
          <div className="page-tools">
            {feed.demo && page === "pulse" && (
              <button
                className="button secondary demo-activity-button"
                onClick={feed.simulateActivity}
                disabled={feed.paused || Boolean(liveEffects.celebration)}
                title="Add a fictional activity to preview live updates"
              >
                <Sparkles size={15} /> Try live activity
              </button>
            )}
            {personal &&
              feed.workspace?.owner &&
              !feed.demo &&
              (page === "pulse" || page === "feed") && (
                <button
                  className="button secondary"
                  onClick={() => setModal("sources")}
                >
                  <SlidersHorizontal size={15} /> Data sources
                </button>
              )}
            {!personal &&
              page !== "webhooks" &&
              !(feed.demo && page === "health") && (
                <button
                  className="button secondary share-dashboard-button"
                  onClick={() =>
                    setModal(page === "health" ? "health-share" : "share")
                  }
                >
                  <Share2 size={15} />{" "}
                  {page === "health" ? "Share service health" : "Share Pulse"}
                </button>
              )}
            {onFeed && (
              <>
                <label className="search-box">
                  <Search size={15} />
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search activity"
                    placeholder="Search activity"
                    value={query}
                    onChange={(e) =>
                      updateFeed({ query: e.target.value || undefined })
                    }
                  />
                  <kbd>⌘ K</kbd>
                </label>
                <select
                  aria-label="Activity time period"
                  value={period}
                  onChange={(e) => {
                    updateFeed({ period: e.target.value as Period });
                    setReplay(null);
                    setSelectedId(null);
                  }}
                >
                  {(Object.keys(PERIOD_NAMES) as Period[]).map((p) => (
                    <option key={p} value={p}>
                      {PERIOD_NAMES[p]}
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
        {activity && feed.error && !feed.operation && (
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
        {activity && !feed.error && !feed.operation && feed.notice && (
          <div className="notice">
            <span>{feed.notice}</span>
          </div>
        )}
        {page === "pulse" && (
          <div className="dashboard-layout">
            {!personal ? (
              <EngineeringWall
                snapshot={feed.demo ? demoSignals().snapshot : engineering.data}
                health={feed.demo ? demoSignals().health : engineering.health}
                events={feed.events}
                now={now}
                demo={feed.demo}
                displayName={displayName}
                preferencesKey={feed.demo ? "demo" : feed.workspace?.id}
                moving={moving}
                // Signed-out visitors and the wall display slide by default.
                autoplayDefault={(!feed.session.user || wall) && moving}
                loading={feed.loading || engineering.loading}
                onToggleMotion={() => setMoving(!moving)}
                onRules={() => setModal("rules")}
                onMilestones={() => navigate({ page: "milestones" })}
                onOpenHealth={
                  feed.demo ? undefined : () => navigate({ page: "health" })
                }
                onSelectPerson={openProfile}
                onOpenTeam={() => navigate({ page: "team" })}
                onSelectRepository={openRepository}
                repositoryNote={feed.demo ? undefined : REPOSITORY_NOTE}
                status={
                  feed.demo
                    ? ""
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
              <div className="dashboard-main">
                <LiveLeaderboard
                  events={feed.events}
                  now={now}
                  demo={feed.demo}
                  onSelect={openProfile}
                  moving={moving}
                  loading={feed.loading}
                  onToggleMotion={() => setMoving(!moving)}
                  onRules={() => setModal("rules")}
                  status={status}
                />
                <RepositoryList
                  events={feed.events}
                  now={now}
                  title="Sources"
                  framed
                  note={feed.demo ? undefined : SOURCES_NOTE}
                  onSelect={openRepository}
                />
              </div>
            )}
            <aside className="dashboard-sidebar">
              <ActivityFeed {...feedProps} />
            </aside>
          </div>
        )}
        {onFeed && (
          <>
            <div className="feed-page">
              <ActivityFeed {...feedProps} full />
            </div>
            <FeedTimeline
              start={range.start}
              end={range.end}
              period={period}
              percent={replay?.percent ?? 100}
              cutoff={cutoff}
              live={!replay}
              onScrub={(percent) =>
                setReplay(
                  percent === 100 ? null : { end: replay?.end ?? now, percent },
                )
              }
              onNow={() => setReplay(null)}
            />
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
        {page === "health" && demoHealth && (
          <DemoHealthPage services={demoHealth.services} now={now} />
        )}
        {page === "team" && (
          <TeamPage
            people={people}
            metrics={metrics}
            displayName={displayName}
            onRules={() => setModal("rules")}
            onSelectPerson={openProfile}
          />
        )}
        {page === "milestones" && (
          <MilestonesPage achievements={achievements} />
        )}
        {page === "webhooks" &&
          (!feed.demo &&
          feed.workspace?.kind === "team" &&
          feed.session.csrfToken ? (
            <WebhooksPage
              workspace={{ id: feed.workspace.id, name: feed.workspace.name }}
              csrfToken={feed.session.csrfToken}
            />
          ) : (
            <div className="empty-state">
              <h3>Webhooks belong to team workspaces</h3>
              <p>
                Sign in and choose a team workspace to send its activity, CI,
                deployments, and incidents to Slack, Discord, Teams, Google
                Chat, Lark, or any URL.
              </p>
              <button className="button secondary" onClick={openConnect}>
                {feed.session.user ? "Choose team workspace" : "Sign in"}
              </button>
            </div>
          ))}
        <footer className="app-footer">
          <span>
            {feed.demo
              ? "Fictional sample data"
              : personal
                ? "Private journal · visible only to you"
                : `${feed.organization} · Private workspace`}
          </span>
          {activity && (
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
        <Modal title="Share Pulse" onClose={() => setModal(null)}>
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
        <Modal title="Share Pulse" onClose={() => setModal(null)}>
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
            tags={tags.slice(0, 8).map((item) => item.tag)}
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
          <ScoringRules />
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Workspace settings" onClose={() => setModal(null)}>
          <SettingsPanel
            feed={feed}
            personal={personal}
            syncing={syncing}
            onSync={() => void syncGithub()}
            onConnect={openConnect}
            celebrations={celebrations}
            onCelebrations={setCelebrations}
            moving={moving}
            onMoving={setMoving}
            wall={wall}
            onToggleWall={() => {
              setModal(null);
              void toggleWall();
            }}
          />
        </Modal>
      )}
      {modal === "heading" && feed.workspace && (
        <Modal title="Edit Pulse heading" onClose={() => setModal(null)}>
          <PulseHeadingForm
            title={feed.workspace.pulseTitle}
            subtitle={feed.workspace.pulseSubtitle}
            defaultTitle={defaultPulseTitle}
            team={feed.workspace.kind === "team"}
            onCancel={() => setModal(null)}
            onSave={async (title, subtitle) => {
              await feed.updatePulseHeading(title, subtitle);
              setModal(null);
            }}
          />
        </Modal>
      )}
      {modal === "sources" && feed.workspace?.sources && (
        <Modal title="Dashboard sources" onClose={() => setModal(null)}>
          <PersonalSourcesForm
            sources={feed.workspace.sources}
            options={feed.workspaces.flatMap((workspace) =>
              workspace.installationId
                ? [
                    {
                      id: workspace.installationId,
                      name:
                        workspace.kind === "personal"
                          ? (workspace.githubAccount ?? "Your account")
                          : workspace.name,
                      kind: workspace.kind,
                    },
                  ]
                : [],
            )}
            onCancel={() => setModal(null)}
            onSave={async (sources) => {
              await feed.updateSources(sources);
              setModal(null);
            }}
          />
        </Modal>
      )}
      {profileLogin && (
        <Modal
          title={displayName(profileLogin)}
          onClose={() => closeOverlay({ ...route, person: undefined })}
        >
          <ContributorProfile
            events={feed.events}
            login={profileLogin}
            now={now}
            demo={feed.demo}
            displayName={displayName}
          />
        </Modal>
      )}
      {route.repository && (
        <Modal
          title={route.repository.split("/").pop() || route.repository}
          onClose={() => closeOverlay({ ...route, repository: undefined })}
        >
          <RepositoryProfile
            events={feed.events}
            repository={route.repository}
            now={now}
            snapshot={feed.demo ? demoSignals().snapshot : engineering.data}
            demo={feed.demo}
            displayName={displayName}
            onSelectPerson={(login) =>
              navigate(
                { ...route, repository: undefined, person: login },
                { overlay: true, replace: true },
              )
            }
            onViewActivity={() => viewRepositoryActivity(route.repository!)}
          />
        </Modal>
      )}
      {detail && (
        <Modal title="Activity details" onClose={() => setDetailId(null)}>
          <EventDetail
            event={detail}
            demo={feed.demo}
            personal={personal}
            canDelete={detail.type === "note" && canWriteNote}
            displayName={displayName}
            onDelete={() => void deleteNote(detail.id)}
          />
        </Modal>
      )}
    </div>
  );
}
