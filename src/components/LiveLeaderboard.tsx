import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CircleHelp,
  GitMerge,
  MessageSquare,
  Pause,
  Play,
  Rocket,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types";
import {
  getLeaderboard,
  getMetrics,
  getWeekStart,
  type LeaderboardEntry,
} from "../lib/activity";
import { getLeaderboardChanges } from "../lib/leaderboard";

const demoNames: Record<string, string> = {
  alexchen: "Alex Chen",
  sarahpark: "Sarah Park",
  minhnguyen: "Minh Nguyen",
  emmarivera: "Emma Rivera",
  jordanlee: "Jordan Lee",
  leowang: "Leo Wang",
};

function AnimatedNumber({ value, moving }: { value: number; moving: boolean }) {
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    if (!moving) {
      current.current = value;
      setDisplay(value);
      return;
    }
    const from = current.current;
    if (from === value) return;
    const start = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, (time - start) / 850);
      current.current = Math.round(
        from + (value - from) * (1 - (1 - progress) ** 3),
      );
      setDisplay(current.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, moving]);
  return (
    <span aria-label={value.toLocaleString()}>
      <span aria-hidden="true">{display.toLocaleString()}</span>
    </span>
  );
}

function ContributorAvatar({
  person,
  name,
}: {
  person: LeaderboardEntry;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  const image =
    person.avatarUrl?.startsWith("https://avatars.githubusercontent.com/") &&
    !failed;
  return (
    <span className="leader-avatar" aria-hidden="true">
      {image ? (
        <img src={person.avatarUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        name
          .split(/\s+/)
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase()
      )}
    </span>
  );
}

export function LiveLeaderboard({
  events,
  now,
  demo = false,
  moving = true,
  onToggleMotion,
  onRules,
  onSelect,
  onAllContributors,
  personal = false,
  status = "Live",
  loading = false,
}: {
  events: ActivityEvent[];
  now: number;
  demo?: boolean;
  moving?: boolean;
  onToggleMotion?: () => void;
  onRules?: () => void;
  /** Opens a contributor's profile; rows become buttons when provided. */
  onSelect?: (login: string) => void;
  /** Opens the full contributor table. */
  onAllContributors?: () => void;
  /** A journal's dashboard: the owner and everyone active in its sources. */
  personal?: boolean;
  status?: string;
  loading?: boolean;
}) {
  const people = useMemo(() => getLeaderboard(events, now), [events, now]);
  const metrics = useMemo(() => getMetrics(events, now), [events, now]);
  const list = useRef<HTMLOListElement>(null);
  const positions = useRef(new Map<string, number>());
  const previous = useRef<LeaderboardEntry[]>([]);
  const [changes, setChanges] = useState<
    ReturnType<typeof getLeaderboardChanges>
  >(new Map());
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const animate = moving && !reduced;
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const row of Array.from(
      list.current?.children || [],
    ) as HTMLElement[]) {
      const key = row.dataset.login!;
      const top = row.offsetTop;
      next.set(key, top);
      row.getAnimations().forEach((animation) => animation.cancel());
      const old = positions.current.get(key);
      if (animate && old !== undefined && old !== top)
        row.animate(
          [
            { transform: `translateY(${old - top}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 750, easing: "cubic-bezier(.22,1,.36,1)" },
        );
    }
    positions.current = next;
  }, [people, animate]);
  useEffect(() => {
    const next = getLeaderboardChanges(previous.current, people);
    previous.current = people;
    setChanges(next);
    if (!next.size) return;
    const timer = setTimeout(() => setChanges(new Map()), 4000);
    return () => clearTimeout(timer);
  }, [people]);
  const week = getWeekStart(now);
  const reset = new Date(week.getTime() + 7 * 86400000);
  return (
    <section
      className={`live-leaderboard ${animate ? "has-motion" : ""}`}
      aria-label={personal ? "Live XP leaderboard" : "Live team XP leaderboard"}
    >
      <div className="leaderboard-heading">
        <div>
          <div className="leaderboard-title">
            <Trophy size={20} />
            <h2>{personal ? "Leaderboard" : "Team leaderboard"}</h2>
          </div>
          <p>
            {personal
              ? "Your week across every source, alongside everyone active in them."
              : "Good work adds up. Every contribution moves the team."}
          </p>
        </div>
        {status && (
          <span
            className={`board-status ${status === "Live" ? "is-live" : ""}`}
          >
            <span />
            {status}
          </span>
        )}
      </div>
      <div className="leaderboard-summary">
        <div className="shared-xp">
          <Zap size={18} />
          <strong>
            <AnimatedNumber value={metrics.xp} moving={animate} />
          </strong>
          <span>{personal ? "XP" : "team XP"}</span>
        </div>
        <div>
          <Users size={15} />
          <strong>{people.length}</strong>
          <span>contributors</span>
        </div>
        <div>
          <Rocket size={15} />
          <strong>{metrics.releases}</strong>
          <span>releases</span>
        </div>
      </div>
      <div className="leaderboard-period">
        <span>
          This week <span className="subtle-divider">/</span>{" "}
          {week.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
          –
          {new Date(reset.getTime() - 1).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </span>
        <span>Weekly XP</span>
      </div>
      <ol className="leaderboard-list" ref={list}>
        {people.map((person) => {
          const name = demo
            ? demoNames[person.login] || person.login
            : person.login;
          const change = changes.get(person.login.toLowerCase());
          return (
            <li
              key={person.login.toLowerCase()}
              data-login={person.login.toLowerCase()}
              className={`leader-row ${person.rank <= 3 ? `place-${person.rank}` : ""} ${animate && (change?.xp || 0) > 0 ? "xp-arrived" : ""}`}
            >
              <div className="leader-rank">
                <span>{String(person.rank).padStart(2, "0")}</span>
                {change?.ranks ? (
                  <small
                    className={change.ranks > 0 ? "rank-up" : "rank-down"}
                    aria-label={`${Math.abs(change.ranks)} ${change.ranks > 0 ? "places up" : "places down"}`}
                  >
                    {change.ranks > 0 ? (
                      <ArrowUp size={11} />
                    ) : (
                      <ArrowDown size={11} />
                    )}
                    {Math.abs(change.ranks)}
                  </small>
                ) : (
                  <span className="rank-stable" aria-hidden="true">
                    —
                  </span>
                )}
              </div>
              <ContributorAvatar person={person} name={name} />
              <div className="leader-identity">
                <div>
                  <strong>{name}</strong>
                  {person.rank === 1 && (
                    <Trophy size={13} aria-label="Leading this week" />
                  )}
                </div>
                <span>
                  <GitMerge size={11} /> {person.merges} merges{" "}
                  <span className="leader-review">
                    <MessageSquare size={11} /> {person.reviews} reviews
                  </span>
                </span>
                <div className="leader-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${people[0].xp ? (person.xp / people[0].xp) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
              <div className="leader-score">
                <strong>
                  <AnimatedNumber value={person.xp} moving={animate} />
                  <small> XP</small>
                </strong>
                {(change?.xp || 0) > 0 ? (
                  <span className="xp-gain">+{change!.xp} XP</span>
                ) : (
                  <span>{person.contributions} contributions</span>
                )}
              </div>
              {onSelect && (
                <button
                  type="button"
                  className="row-select"
                  aria-label={`Open ${name}'s profile`}
                  onClick={() => onSelect(person.login)}
                />
              )}
            </li>
          );
        })}
      </ol>
      {!people.length && (
        <div className="empty-state leaderboard-empty">
          <Trophy size={30} />
          <h3>
            {loading
              ? "Loading this week’s contributions…"
              : "A new week, ready to ship."}
          </h3>
          <p>
            {personal
              ? "Merge a pull request, review someone’s work, or publish a release to earn XP."
              : "Merge a pull request, review a teammate’s work, or publish a release to earn team XP."}
          </p>
        </div>
      )}
      <div className="leaderboard-bottom">
        <span>Resets Monday, 00:00 UTC</span>
        <div>
          {onAllContributors && (
            <button className="text-button" onClick={onAllContributors}>
              All contributors <ArrowRight size={13} />
            </button>
          )}
          {onRules && (
            <button className="text-button" onClick={onRules}>
              How XP works <CircleHelp size={13} />
            </button>
          )}
          {onToggleMotion && (
            <button
              className="icon-button"
              title={
                moving
                  ? "Pause leaderboard animation"
                  : "Resume leaderboard animation"
              }
              aria-label={
                moving
                  ? "Pause leaderboard animation"
                  : "Resume leaderboard animation"
              }
              aria-pressed={!moving}
              onClick={onToggleMotion}
            >
              {moving ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {[...changes]
          .filter(([, change]) => change.xp > 0)
          .map(([login, change]) => `${login} earned ${change.xp} XP.`)
          .join(" ")}
      </div>
    </section>
  );
}
