import { useEffect, useRef, useState } from "react";
import {
  CheckCheck,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  NotebookPen,
  Rocket,
  Trophy,
} from "lucide-react";
import { EVENT_META } from "../lib/activity";
import type { ActivityCelebration as Celebration } from "../lib/dashboardPulse";

const icons = {
  merge: GitMerge,
  review: MessageSquare,
  release: Rocket,
  issue: CheckCheck,
  pr: GitPullRequest,
  push: GitCommitHorizontal,
  note: NotebookPen,
};

function Confetti({ intensity }: { intensity: "ship" | "milestone" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    let width = innerWidth,
      height = innerHeight;
    const size = () => {
      width = innerWidth;
      height = innerHeight;
      element.width = width * ratio;
      element.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    size();
    const colors = ["#e3ba8a", "#a4c8e5", "#b4acd8", "#95d8bd", "#f1eee3"];
    const particles = Array.from(
      { length: intensity === "milestone" ? 130 : 70 },
      (_, i) => {
        const side = i % 2 ? 1 : -1;
        return {
          x: side === 1 ? width : 0,
          y: height * 0.7,
          vx: -side * (3 + Math.random() * 7),
          vy: -7 - Math.random() * 10,
          spin: Math.random() * 6,
          rotation: Math.random() * Math.PI,
          size: 4 + Math.random() * 5,
          color: colors[i % colors.length],
        };
      },
    );
    let frame = 0,
      start = performance.now(),
      previous = start;
    const draw = (time: number) => {
      const elapsed = time - start;
      const delta = Math.min(2, (time - previous) / 16.67);
      previous = time;
      context.clearRect(0, 0, width, height);
      if (elapsed > 3400 || document.visibilityState !== "visible") return;
      context.globalAlpha = Math.min(1, (3400 - elapsed) / 850);
      for (const p of particles) {
        p.x += p.vx * delta;
        p.y += p.vy * delta;
        p.vy += 0.23 * delta;
        p.vx *= 0.992 ** delta;
        p.rotation += p.spin * 0.025 * delta;
        context.save();
        context.translate(p.x, p.y);
        context.rotate(p.rotation);
        context.fillStyle = p.color;
        context.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.55);
        context.restore();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    window.addEventListener("resize", size);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", size);
      context.clearRect(0, 0, width, height);
    };
  }, [intensity]);
  return (
    <canvas className="celebration-confetti" ref={canvas} aria-hidden="true" />
  );
}

export function ActivityCelebration({
  celebration,
  moving,
  displayName = (login) => login,
}: {
  celebration: Celebration | null;
  moving: boolean;
  displayName?: (login: string) => string;
}) {
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  if (!celebration) return null;
  const Icon = celebration.milestone ? Trophy : icons[celebration.event.type];
  return (
    <>
      {moving && !reduced && celebration.confetti && (
        <Confetti key={celebration.id} intensity={celebration.confetti} />
      )}
      <div
        key={celebration.id}
        className={`activity-celebration ${moving && !reduced ? "with-motion" : ""} ${celebration.milestone ? "milestone-celebration" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="celebration-icon">
          <Icon size={22} />
        </span>
        <div>
          <strong>
            {celebration.milestone
              ? "Milestone unlocked!"
              : celebration.count > 1
                ? `${celebration.count} new contributions`
                : `${displayName(celebration.event.actor.login)} ${EVENT_META[celebration.event.type].verb}`}
          </strong>
          <p>{celebration.milestone || celebration.event.title}</p>
        </div>
        {celebration.xp > 0 && (
          <span className="celebration-xp">
            +{celebration.xp}
            <small>team XP</small>
          </span>
        )}
      </div>
    </>
  );
}
