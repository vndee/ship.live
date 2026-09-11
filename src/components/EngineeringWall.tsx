import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CircleDot,
  GitPullRequest,
  Pause,
  Play,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types.js";
import type { EngineeringWallSnapshot } from "../../shared/wall.js";
import type { HealthSnapshot, HealthStatus } from "../../shared/health.js";
import {
  getAttention,
  getAvailableScenes,
  getReleasePulse,
  getReviewRadar,
  getWhatChanged,
  moveScene,
  parseWallTabs,
  shortAge,
  visibleScenes,
  type ReviewRadarItem,
  type WallScene,
  type WallTabs,
} from "../lib/engineering-wall.js";
import { DashboardPulse } from "./DashboardPulse";
import { DeliveryScene } from "./DeliveryScene";
import { LiveLeaderboard } from "./LiveLeaderboard";
import { ServiceStatusStrip } from "./ServiceStatusStrip";
import { RepositoryList } from "./RepositoryList";
import { SceneHeader } from "./SceneHeader";
import { serviceStats } from "../lib/service-stats";
import { formatUptime } from "../lib/uptime";
import "../engineering-wall.css";
import "./service-health.css";

const labels: Record<WallScene, string> = {
  pulse: "Overview",
  review: "Review radar",
  release: "Release pulse",
  delivery: "Delivery",
  health: "Service health",
  leaderboard: "Leaderboard",
};
/** How long each scene stays on screen while auto-slide is on. */
const SCENE_MS = 20_000;

type Tone = "success" | "danger" | "info" | "warning" | "neutral" | "violet";
const radarStates: Record<
  ReviewRadarItem["state"],
  { label: string; chip: string; tone: Tone }
> = {
  failing: { label: "CI failing", chip: "failing", tone: "danger" },
  ready: { label: "Ready to merge", chip: "ready", tone: "success" },
  running: { label: "Checks running", chip: "running", tone: "info" },
  waiting: {
    label: "Awaiting review",
    chip: "awaiting review",
    tone: "neutral",
  },
};
const deploymentTones: Record<string, Tone> = {
  successful: "success",
  failing: "danger",
  running: "info",
  queued: "info",
  inactive: "neutral",
  cancelled: "neutral",
};
const healthStates: Record<HealthStatus, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  down: { label: "Down", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
  paused: { label: "Paused", tone: "violet" },
};
const repositoryName = (repository: string) =>
  repository.split("/").pop() || repository;
const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
const initials = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 1)
  ).toUpperCase();
};

function readWallTabs(storageKey: string | null): WallTabs {
  try {
    return parseWallTabs(storageKey ? localStorage.getItem(storageKey) : null);
  } catch {
    return parseWallTabs(null);
  }
}

/** Non-zero counts in a fixed, most-urgent-first order. */
function tally<T extends string>(values: T[], order: readonly T[]) {
  return order
    .map((value) => [value, values.filter((item) => item === value).length])
    .filter((entry): entry is [T, number] => (entry[1] as number) > 0);
}

function SceneEmpty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="scene-empty">
      {icon}
      <strong>{title}</strong>
      <p>{text}</p>
      {action}
    </div>
  );
}

function SceneRow({ url, children }: { url?: string; children: ReactNode }) {
  return url ? (
    <a className="scene-row" href={url} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <div className="scene-row">{children}</div>
  );
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`scene-chip tone-${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

export function EngineeringWall({
  snapshot,
  health,
  events,
  now,
  demo,
  moving,
  autoplayDefault,
  status,
  loading,
  onToggleMotion,
  onRules,
  onMilestones,
  onOpenHealth,
  onSelectPerson,
  onOpenTeam,
  personal = false,
  onSelectRepository,
  repositoryNote,
  displayName = (login) => login,
  preferencesKey,
}: {
  snapshot: EngineeringWallSnapshot;
  health?: HealthSnapshot;
  events: ActivityEvent[];
  now: number;
  demo: boolean;
  moving: boolean;
  /** Whether auto-slide starts on; the viewer can switch it either way. */
  autoplayDefault: boolean;
  status: string;
  loading: boolean;
  onToggleMotion: () => void;
  onRules: () => void;
  onMilestones: () => void;
  onOpenHealth?: () => void;
  /** Opens a contributor's profile from the leaderboard. */
  onSelectPerson?: (login: string) => void;
  /** Opens the full contributor table from the leaderboard. */
  onOpenTeam?: () => void;
  /** A journal's own dashboard, rather than a team's. */
  personal?: boolean;
  /** Opens a repository's activity from Overview. */
  onSelectRepository?: (repository: string) => void;
  /** Explains where repository activity comes from. */
  repositoryNote?: string;
  displayName?: (login: string) => string;
  /** Scope for remembering tab order and visibility in this browser. */
  preferencesKey?: string;
}) {
  const storageKey = preferencesKey
    ? `ship-live:wall-tabs:${preferencesKey}`
    : null;
  const [tabs, setTabs] = useState(() => readWallTabs(storageKey));
  const available = useMemo(
    () => getAvailableScenes(snapshot, events, health),
    [snapshot, events, health],
  );
  const scenes = useMemo(
    () => visibleScenes(available, tabs),
    [available, tabs],
  );
  // Health is only a choice where health data exists.
  const options = tabs.order.filter((item) => item !== "health" || health);
  const shownOptions = options.filter(
    (item) => !tabs.hidden.includes(item),
  ).length;
  // Live data recreates the scene list; only a real change restarts the timer.
  const sceneKey = scenes.join(",");
  const [scene, setScene] = useState<WallScene>(scenes[0]);
  const [autoplay, setAutoplay] = useState(autoplayDefault);
  const [hovered, setHovered] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const chooserRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const previousAttention = useRef<ReturnType<typeof getAttention>>(null);
  const interruptedScene = useRef<WallScene | null>(null);
  const [recovery, setRecovery] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const attention = useMemo(
    () => getAttention(snapshot, health),
    [snapshot, health],
  );
  // A dismissed incident stays hidden until a different one appears.
  const attentionKey = attention
    ? `${attention.kind}:${attention.title}`
    : null;
  const shownAttention = attentionKey !== dismissed ? attention : null;
  const radar = useMemo(() => getReviewRadar(snapshot, now), [snapshot, now]);
  const releases = useMemo(() => getReleasePulse(snapshot), [snapshot]);
  const changed = useMemo(() => getWhatChanged(events, now), [events, now]);
  const rotating = autoplay && !shownAttention && scenes.length > 1;
  function saveTabs(next: WallTabs) {
    setTabs(next);
    try {
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage can be unavailable; the choice still applies to this visit.
    }
  }
  function toggleScene(item: WallScene) {
    saveTabs({
      ...tabs,
      hidden: tabs.hidden.includes(item)
        ? tabs.hidden.filter((value) => value !== item)
        : [...tabs.hidden, item],
    });
  }
  function moveOption(item: WallScene, offset: -1 | 1) {
    saveTabs({ ...tabs, order: moveScene(tabs.order, item, offset, options) });
  }
  useEffect(() => setTabs(readWallTabs(storageKey)), [storageKey]);
  useEffect(() => setAutoplay(autoplayDefault), [autoplayDefault]);
  useEffect(() => {
    if (!choosing) return;
    const outside = (event: PointerEvent) => {
      if (!chooserRef.current?.contains(event.target as Node))
        setChoosing(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChoosing(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [choosing]);
  useEffect(() => {
    if (!previousAttention.current && attention && autoplay)
      interruptedScene.current = scene;
    if (previousAttention.current && !attention) {
      const previous = previousAttention.current;
      setRecovery(
        previous.kind === "health"
          ? previous.title.replace(/ is down$/, " recovered")
          : previous.kind === "deployment"
            ? previous.title.replace(
                / deployment failed$/,
                " deployment recovered",
              )
            : previous.title.replace(/ failed$/, " recovered"),
      );
      if (interruptedScene.current && scenes.includes(interruptedScene.current))
        setScene(interruptedScene.current);
      interruptedScene.current = null;
      const timer = setTimeout(() => setRecovery(""), 6000);
      previousAttention.current = attention;
      return () => clearTimeout(timer);
    }
    previousAttention.current = attention;
  }, [attention]);
  useEffect(() => {
    // A viewer who chose a scene keeps it; only auto-slide jumps to the
    // scene that needs attention, and never to a hidden one.
    if (!shownAttention || !autoplay) return;
    const target: WallScene =
      shownAttention.kind === "health"
        ? "health"
        : shownAttention.kind === "deployment"
          ? "release"
          : "review";
    if (scenes.includes(target)) setScene(target);
  }, [shownAttention, scenes, autoplay]);
  useEffect(() => {
    // Pause while the pointer is over the wall so a row never slides away
    // mid-read; leaving restarts the full interval.
    if (!rotating || hovered) return;
    const timer = setTimeout(
      () =>
        setScene((current) => {
          const order = sceneKey.split(",") as WallScene[];
          return order[
            (Math.max(0, order.indexOf(current)) + 1) % order.length
          ];
        }),
      SCENE_MS,
    );
    return () => clearTimeout(timer);
  }, [rotating, hovered, scene, sceneKey, cycle]);
  useEffect(() => {
    if (!scenes.includes(scene)) setScene(scenes[0]);
  }, [scenes, scene]);
  useEffect(() => {
    // Keep the active tab visible in a scrolling tab strip. Only the strip
    // scrolls: scrollIntoView would also move the page on every slide.
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const strip = nav.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < strip.left) nav.scrollLeft -= strip.left - tab.left + 16;
    else if (tab.right > strip.right)
      nav.scrollLeft += tab.right - strip.right + 16;
  }, [scene, sceneKey]);
  return (
    <section
      className={`engineering-wall scene-${scene}`}
      aria-label="Engineering utilities wall"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        setCycle((value) => value + 1);
      }}
    >
      <header className="wall-toolbar">
        <nav aria-label="Wall scenes" ref={navRef}>
          {scenes.map((item) => (
            <button
              key={item}
              type="button"
              className={item === scene ? "active" : ""}
              aria-current={item === scene ? "page" : undefined}
              onClick={() => setScene(item)}
            >
              {labels[item]}
              {rotating && item === scene && (
                <span
                  className="wall-tab-progress"
                  key={`${scene}:${cycle}`}
                  data-paused={hovered || undefined}
                  style={{ animationDuration: `${SCENE_MS}ms` }}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </nav>
        <div className="wall-toolbar-meta">
          {status && (
            <span className="wall-status">
              <CircleDot size={13} />
              {status}
            </span>
          )}
          {scenes.length > 1 && (
            <button
              type="button"
              className={`wall-autoplay ${autoplay ? "is-on" : ""}`}
              aria-label="Auto-slide"
              aria-pressed={autoplay}
              title={
                autoplay
                  ? "Stop sliding between tabs"
                  : "Slide between tabs automatically"
              }
              onClick={() => setAutoplay((value) => !value)}
            >
              {autoplay ? <Pause size={13} /> : <Play size={13} />}
            </button>
          )}
          <div className="wall-chooser" ref={chooserRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="Arrange tabs"
              title="Arrange tabs"
              aria-expanded={choosing}
              onClick={() => setChoosing((value) => !value)}
            >
              <SlidersHorizontal size={15} />
            </button>
            {choosing && (
              <div
                className="wall-chooser-menu"
                role="group"
                aria-label="Tab order and visibility"
              >
                <strong>Tabs</strong>
                <ol>
                  {options.map((item, index) => {
                    const checked = !tabs.hidden.includes(item);
                    return (
                      <li className="wall-chooser-option" key={item}>
                        <label>
                          <input
                            type="checkbox"
                            checked={checked}
                            // At least one tab always stays visible.
                            disabled={checked && shownOptions === 1}
                            onChange={() => toggleScene(item)}
                          />
                          <span>{labels[item]}</span>
                          {!available.includes(item) && (
                            <small>No data yet</small>
                          )}
                        </label>
                        <span className="wall-chooser-move">
                          <button
                            type="button"
                            aria-label={`Move ${labels[item]} earlier`}
                            title="Move up"
                            disabled={index === 0}
                            onClick={() => moveOption(item, -1)}
                          >
                            <ChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${labels[item]} later`}
                            title="Move down"
                            disabled={index === options.length - 1}
                            onClick={() => moveOption(item, 1)}
                          >
                            <ChevronDown size={14} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p>Order and visibility are remembered in this browser.</p>
              </div>
            )}
          </div>
        </div>
      </header>
      {shownAttention && (
        <div className="wall-attention">
          <a
            className="wall-attention-link"
            href={shownAttention.url}
            target={shownAttention.url ? "_blank" : undefined}
            rel={shownAttention.url ? "noreferrer" : undefined}
            aria-disabled={!shownAttention.url}
          >
            <AlertTriangle size={18} />
            <span>
              <strong>Attention</strong>
              {shownAttention.title}
            </span>
            <small>
              {new Date(shownAttention.updatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          </a>
          <button
            type="button"
            className="wall-attention-dismiss"
            aria-label="Dismiss attention"
            title="Dismiss until something else needs attention"
            onClick={() => setDismissed(attentionKey)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {recovery && !attention && (
        <div className="wall-moment" role="status">
          <Sparkles size={17} />
          <strong>{recovery}</strong>
          <span>Everything is back on track.</span>
        </div>
      )}
      <div className="wall-scene" key={scene}>
        {scene === "pulse" && (
          <>
            <div className="change-strip">
              <div>
                <span>Last hour</span>
                <strong>{changed.hour.total}</strong>
                <small>
                  {changed.hour.merges} merges · {changed.hour.reviews} reviews
                </small>
              </div>
              <div>
                <span>Last 24 hours</span>
                <strong>{changed.day.total}</strong>
                <small>
                  {changed.day.contributors} contributors ·{" "}
                  {changed.day.releases} releases
                </small>
              </div>
            </div>
            <DashboardPulse
              events={events}
              now={now}
              onMilestones={onMilestones}
            />
            <RepositoryList
              events={events}
              now={now}
              note={repositoryNote}
              onSelect={onSelectRepository}
            />
          </>
        )}
        {scene === "review" && (
          <>
            <SceneHeader
              title="Review radar"
              description="Open pull requests, most urgent first."
            >
              {tally(
                radar.map((item) => item.state),
                ["failing", "ready", "running", "waiting"] as const,
              ).map(([state, count]) => (
                <Chip tone={radarStates[state].tone} key={state}>
                  {count} {radarStates[state].chip}
                </Chip>
              ))}
            </SceneHeader>
            {radar.length ? (
              <ul className="scene-list">
                {radar.map((item) => {
                  const author = displayName(item.author);
                  return (
                    <li key={`${item.repository}:${item.number}`}>
                      <SceneRow url={item.url}>
                        <span className="scene-avatar" aria-hidden="true">
                          {item.avatarUrl ? (
                            <img src={item.avatarUrl} alt="" />
                          ) : (
                            initials(author)
                          )}
                        </span>
                        <span className="scene-row-body">
                          <strong>{item.title}</strong>
                          <small>
                            {repositoryName(item.repository)} #{item.number} ·{" "}
                            {author} · {shortAge(item.ageMs)}
                          </small>
                        </span>
                        <span
                          className={`state-pill tone-${radarStates[item.state].tone}`}
                        >
                          <i aria-hidden="true" />
                          {radarStates[item.state].label}
                        </span>
                      </SceneRow>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <SceneEmpty
                icon={<GitPullRequest size={22} />}
                title="No pull requests waiting"
                text="Open, non-draft pull requests appear here with their review and check state."
              />
            )}
          </>
        )}
        {scene === "release" && (
          <>
            <SceneHeader
              title="Release pulse"
              description="The latest GitHub deployment for each environment."
            >
              {tally(
                releases.map((item) => item.status),
                [
                  "failing",
                  "running",
                  "queued",
                  "successful",
                  "inactive",
                  "cancelled",
                ] as const,
              ).map(([value, count]) => (
                <Chip tone={deploymentTones[value]} key={value}>
                  {count} {value}
                </Chip>
              ))}
            </SceneHeader>
            <ul className="scene-list">
              {releases.map((item) => (
                <li key={`${item.repository}:${item.id}`}>
                  <SceneRow url={item.url}>
                    <span className="scene-avatar" aria-hidden="true">
                      <Rocket size={15} />
                    </span>
                    <span className="scene-row-body">
                      <strong>{repositoryName(item.repository)}</strong>
                      <small>
                        {item.environment} · {item.headSha.slice(0, 7)} ·{" "}
                        {shortAge(
                          Math.max(0, now - Date.parse(item.updatedAt)),
                        )}
                      </small>
                    </span>
                    <span
                      className={`state-pill tone-${deploymentTones[item.status]}`}
                    >
                      <i aria-hidden="true" />
                      {capitalize(item.status)}
                    </span>
                  </SceneRow>
                </li>
              ))}
            </ul>
          </>
        )}
        {scene === "delivery" && (
          <DeliveryScene snapshot={snapshot} health={health} now={now} />
        )}
        {scene === "health" && health && (
          <>
            <SceneHeader
              title="Service health"
              description={
                personal
                  ? "Availability from the probes you configured."
                  : "Availability from the probes configured by the team."
              }
            >
              {tally(
                health.services.map((service) => service.status),
                ["down", "degraded", "unknown", "healthy", "paused"] as const,
              ).map(([value, count]) => (
                <Chip tone={healthStates[value].tone} key={value}>
                  {count} {healthStates[value].label.toLowerCase()}
                </Chip>
              ))}
            </SceneHeader>
            {health.services.length ? (
              <div className="health-scene-grid">
                {health.services.map((service) => {
                  const summary = serviceStats(service.probes);
                  const state = healthStates[service.status];
                  return (
                    <article
                      className={`health-card tone-${state.tone}`}
                      key={service.id}
                    >
                      <header>
                        <i className="status-dot" aria-hidden="true" />
                        <strong>{service.name}</strong>
                        <span className="health-card-status">
                          {state.label}
                        </span>
                      </header>
                      <ServiceStatusStrip probes={service.probes} />
                      <dl>
                        <div>
                          <dt>Latency · 24h</dt>
                          <dd>
                            {summary.latencyMean === null
                              ? "—"
                              : `${Math.round(summary.latencyMean)} ms`}
                          </dd>
                        </div>
                        <div>
                          <dt>Uptime · 24h</dt>
                          <dd>
                            {summary.uptime === null
                              ? "—"
                              : formatUptime(summary.uptime)}
                          </dd>
                        </div>
                        <div>
                          <dt>Probes</dt>
                          <dd>{service.probes.length}</dd>
                        </div>
                      </dl>
                    </article>
                  );
                })}
              </div>
            ) : (
              <SceneEmpty
                icon={<Activity size={22} />}
                title="No services monitored yet"
                text="Add a service and its probes in Service Health to see availability here."
                action={
                  onOpenHealth && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={onOpenHealth}
                    >
                      Open Service Health
                    </button>
                  )
                }
              />
            )}
          </>
        )}
        {scene === "leaderboard" && (
          <LiveLeaderboard
            events={events}
            now={now}
            demo={demo}
            moving={moving}
            loading={loading}
            onToggleMotion={onToggleMotion}
            onRules={onRules}
            onSelect={onSelectPerson}
            onAllContributors={onOpenTeam}
            personal={personal}
            status={status}
          />
        )}
      </div>
    </section>
  );
}
