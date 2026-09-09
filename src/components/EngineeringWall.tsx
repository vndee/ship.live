import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  Pause,
  Play,
  Rocket,
  Sparkles,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types.js";
import type { EngineeringWallSnapshot } from "../../shared/wall.js";
import type { HealthSnapshot } from "../../shared/health.js";
import {
  getAttention,
  getAvailableScenes,
  getReleasePulse,
  getReviewRadar,
  getWhatChanged,
  type WallScene,
} from "../lib/engineering-wall.js";
import { DashboardPulse } from "./DashboardPulse";
import { LiveLeaderboard } from "./LiveLeaderboard";
import "../engineering-wall.css";

const labels: Record<WallScene, string> = {
  pulse: "Team pulse",
  review: "Review radar",
  release: "Release pulse",
  health: "Service health",
  leaderboard: "Leaderboard",
};

export function EngineeringWall({
  snapshot,
  health,
  events,
  now,
  demo,
  moving,
  status,
  loading,
  onToggleMotion,
  onRules,
  onMilestones,
}: {
  snapshot: EngineeringWallSnapshot;
  health?: HealthSnapshot;
  events: ActivityEvent[];
  now: number;
  demo: boolean;
  moving: boolean;
  status: string;
  loading: boolean;
  onToggleMotion: () => void;
  onRules: () => void;
  onMilestones: () => void;
}) {
  const scenes = useMemo(
    () => getAvailableScenes(snapshot, events, health),
    [snapshot, events, health],
  );
  const [scene, setScene] = useState<WallScene>("pulse");
  const [paused, setPaused] = useState(false);
  const [interactionUntil, setInteractionUntil] = useState(0);
  const previousAttention = useRef<ReturnType<typeof getAttention>>(null);
  const interruptedScene = useRef<WallScene | null>(null);
  const [recovery, setRecovery] = useState("");
  const attention = useMemo(
    () => getAttention(snapshot, health),
    [snapshot, health],
  );
  const radar = useMemo(() => getReviewRadar(snapshot, now), [snapshot, now]);
  const releases = useMemo(() => getReleasePulse(snapshot), [snapshot]);
  const changed = useMemo(() => getWhatChanged(events, now), [events, now]);
  useEffect(() => {
    if (!previousAttention.current && attention)
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
    if (!attention) return;
    const target: WallScene =
      attention.kind === "health"
        ? "health"
        : attention.kind === "deployment"
          ? "release"
          : "review";
    if (scenes.includes(target)) setScene(target);
  }, [attention, scenes]);
  useEffect(() => {
    if (
      paused ||
      !moving ||
      attention ||
      Date.now() < interactionUntil ||
      scenes.length < 2
    )
      return;
    const timer = setInterval(
      () =>
        setScene(
          (current) =>
            scenes[(Math.max(0, scenes.indexOf(current)) + 1) % scenes.length],
        ),
      20_000,
    );
    return () => clearInterval(timer);
  }, [paused, moving, attention, interactionUntil, scenes]);
  useEffect(() => {
    if (!scenes.includes(scene)) setScene(scenes[0]);
  }, [scenes, scene]);
  function move(offset: number) {
    const index = Math.max(0, scenes.indexOf(scene));
    setScene(scenes[(index + offset + scenes.length) % scenes.length]);
    setInteractionUntil(Date.now() + 60_000);
  }
  return (
    <section
      className={`engineering-wall scene-${scene}`}
      aria-label="Engineering utilities wall"
    >
      <header className="wall-toolbar">
        <div>
          <CircleDot size={15} />
          <strong>{labels[scene]}</strong>
          <span>{status}</span>
        </div>
        <nav aria-label="Wall scenes">
          {scenes.map((item) => (
            <button
              key={item}
              className={item === scene ? "active" : ""}
              aria-label={`Show ${labels[item]}`}
              aria-current={item === scene ? "page" : undefined}
              onClick={() => {
                setScene(item);
                setInteractionUntil(Date.now() + 60_000);
              }}
            />
          ))}
        </nav>
        <div>
          <button
            className="icon-button"
            aria-label="Previous wall scene"
            onClick={() => move(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={paused ? "Resume wall rotation" : "Pause wall rotation"}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            className="icon-button"
            aria-label="Next wall scene"
            onClick={() => move(1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </header>
      {attention && (
        <a
          className="wall-attention"
          href={attention.url}
          target={attention.url ? "_blank" : undefined}
          rel={attention.url ? "noreferrer" : undefined}
          aria-disabled={!attention.url}
        >
          <AlertTriangle size={18} />
          <span>
            <strong>Attention</strong>
            {attention.title}
          </span>
          <small>
            {new Date(attention.updatedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </small>
        </a>
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
          </>
        )}
        {scene === "review" && (
          <div className="radar-scene">
            <div className="scene-heading">
              <GitPullRequest />
              <div>
                <h2>Review radar</h2>
                <p>The pull requests that need the team’s attention now.</p>
              </div>
            </div>
            <div className="radar-list">
              {radar.map((item) => (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  key={`${item.repository}:${item.number}`}
                  className={`radar-row ${item.state}`}
                >
                  <span className="radar-state">
                    {item.state === "failing"
                      ? "CI failing"
                      : item.state === "ready"
                        ? "Ready"
                        : item.state === "running"
                          ? "Running"
                          : "Review"}
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.repository} #{item.number} · {item.author}
                    </small>
                  </div>
                  <span>
                    {Math.max(1, Math.floor(item.ageMs / 3_600_000))}h
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}
        {scene === "release" && (
          <div className="release-scene">
            <div className="scene-heading">
              <Rocket />
              <div>
                <h2>Release pulse</h2>
                <p>
                  GitHub deployment state, connected to the commit that produced
                  it.
                </p>
              </div>
            </div>
            {releases.map((item) => (
              <a
                href={item.url}
                target={item.url ? "_blank" : undefined}
                rel={item.url ? "noreferrer" : undefined}
                aria-disabled={!item.url}
                className="release-row"
                key={`${item.repository}:${item.id}`}
              >
                <CheckCircle2 />
                <div>
                  <strong>{item.repository}</strong>
                  <span>
                    {item.environment} · {item.headSha.slice(0, 7)}
                  </span>
                </div>
                <b className={item.status}>{item.status}</b>
              </a>
            ))}
          </div>
        )}
        {scene === "health" && (
          <div className="release-scene">
            <div className="scene-heading">
              <CircleDot />
              <div>
                <h2>Service health</h2>
                <p>
                  Runtime availability from the probes configured by the team.
                </p>
              </div>
            </div>
            {health?.services.map((service) => (
              <div className="release-row" key={service.id}>
                <CircleDot />
                <div>
                  <strong>{service.name}</strong>
                  <span>
                    {service.probes.length}{" "}
                    {service.probes.length === 1 ? "probe" : "probes"}
                  </span>
                </div>
                <b className={service.status}>{service.status}</b>
              </div>
            ))}
          </div>
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
            status={status}
          />
        )}
      </div>
    </section>
  );
}
