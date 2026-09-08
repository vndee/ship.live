import { useEffect, useId, useMemo, useRef } from "react";
import type { ActivityEvent } from "../../shared/types";
import {
  buildOrbitModel,
  createOrbitProjector,
  visibleOrbitPoints,
  type OrbitPoint,
} from "../lib/orbit";

export interface OrbitSceneProps {
  events: ActivityEvent[];
  repositories: string[];
  journal?: boolean;
  rangeStart: number;
  rangeEnd: number;
  cutoff: number;
  selectedId: string | null;
  hoveredId: string | null;
  selectedRepo: string;
  /** The parent owns reduced-motion defaults and explicit user playback intent. */
  playing: boolean;
  onSelect: (event: ActivityEvent) => void;
  onHover?: (id: string | null) => void;
}

interface ScreenPoint {
  x: number;
  y: number;
  z: number;
  perspective: number;
  point: OrbitPoint;
}

const verbs: Record<ActivityEvent["type"], string> = {
  merge: "merged",
  review: "reviewed",
  push: "pushed",
  issue: "closed an issue",
  release: "released",
  pr: "opened a pull request",
  note: "added a ship note",
};

const ink = "#e5e9e3";
const accent = "#dfb891";
const trace = "143,158,165";

export function OrbitScene(props: OrbitSceneProps) {
  const controlRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hintId = useId();
  const model = useMemo(
    () =>
      buildOrbitModel(
        props.events,
        props.repositories,
        props.rangeStart,
        props.rangeEnd,
      ),
    [props.events, props.repositories, props.rangeStart, props.rangeEnd],
  );
  const current = useRef({ ...props, model });
  const invalidateRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    current.current = { ...props, model };
    invalidateRef.current?.();
  }, [props, model]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const control = controlRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !control || !context) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let yaw = 0.18;
    let pitch = -0.38;
    let idlePhase = 0;
    let motionTime = 0;
    let velocityX = 0;
    let velocityY = 0;
    let pointer: { id: number; x: number; y: number; distance: number } | null =
      null;
    let localHover: string | null = null;
    let screenPoints: ScreenPoint[] = [];
    let frame = 0;
    let lastTime = 0;
    let inView = true;
    let disposed = false;
    const mountedAt = Date.now();
    const seenEventIds = new Set(
      current.current.model.points.map((point) => point.event.id),
    );
    const arrivals = new Map<string, number>();
    let observedModel = current.current.model;

    const isVisible = () =>
      !document.hidden && inView && width > 0 && height > 0;
    const isMoving = () =>
      current.current.playing && current.current.model.traces.length > 0;
    const clampPitch = () => {
      pitch = Math.max(-1.25, Math.min(1.25, pitch));
    };
    const invalidate = () => {
      if (!disposed && !frame && isVisible()) {
        frame = requestAnimationFrame(render);
      }
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
    };
    const setHover = (id: string | null) => {
      if (localHover === id) return;
      localHover = id;
      current.current.onHover?.(id);
      control.style.cursor = pointer ? "grabbing" : id ? "pointer" : "grab";
      invalidate();
    };

    function render(now: number) {
      frame = 0;
      if (disposed || !isVisible()) {
        lastTime = 0;
        return;
      }
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
      lastTime = now;
      if (isMoving() && !pointer) {
        idlePhase += dt * 0.18;
        yaw += velocityX * dt;
        pitch += velocityY * dt;
        velocityX *= Math.exp(-dt * 5);
        velocityY *= Math.exp(-dt * 5);
        clampPitch();
      } else if (!isMoving()) {
        velocityX = 0;
        velocityY = 0;
      }
      if (isMoving()) motionTime += dt;
      else arrivals.clear();

      const {
        model: data,
        cutoff,
        selectedRepo,
        selectedId,
        hoveredId,
      } = current.current;

      if (data !== observedModel) {
        const newPoints = data.points.filter(
          (point) => !seenEventIds.has(point.event.id),
        );
        for (const point of newPoints) seenEventIds.add(point.event.id);
        if (isMoving()) {
          // Never pulse the initial dataset or older history revealed by a filter.
          // A persistent ID ledger also prevents a previously visible event replaying.
          const freshAfterMount = newPoints.filter(
            (point) =>
              point.occurredAt > mountedAt &&
              Date.now() - point.occurredAt < 120000,
          );
          for (const point of freshAfterMount.slice(0, 8)) {
            arrivals.set(point.event.id, motionTime);
          }
        }
        observedModel = data;
      }
      for (const [id, appearedAt] of arrivals) {
        if (motionTime - appearedAt >= 1.65) arrivals.delete(id);
      }
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      context!.clearRect(0, 0, width, height);

      // Fit all repository paths, including dimmed ones. Scrubbing and filtering
      // never re-centers the sculpture or changes an event's repository lane.
      let extentX = 0.62;
      let extentY = 0.55;
      // Idle motion stays around the user's chosen orientation, never turning
      // the sculpture edge-on over time. Its phase freezes exactly when paused.
      const project = createOrbitProjector(
        yaw + Math.sin(idlePhase) * 0.16,
        pitch + Math.sin(idlePhase * 0.7) * 0.022,
      );
      const paths = data.traces.map((path) => ({
        ...path,
        points: path.points.map((point) => {
          const projected = project(point);
          extentX = Math.max(extentX, Math.abs(projected.x));
          extentY = Math.max(extentY, Math.abs(projected.y));
          return projected;
        }),
      }));
      const projectedEvents = visibleOrbitPoints(data, cutoff).map((point) => ({
        ...project(point),
        point,
      }));
      const horizontalRoom = Math.max(1, width / 2 - 28);
      const verticalRoom = Math.max(1, (height - 64) / 2);
      const scale = Math.min(
        horizontalRoom / (extentX + 0.06),
        verticalRoom / (extentY + 0.06),
      );
      const centerX = width / 2;
      const centerY = (height - 22) / 2;

      for (const path of paths) {
        const active = !selectedRepo || selectedRepo === path.repo;
        const emphasized = selectedRepo === path.repo;
        for (const front of [false, true]) {
          context!.beginPath();
          let drawing = false;
          path.points.forEach((point, index) => {
            const here = point.z >= 0 === front;
            const x = centerX + point.x * scale;
            const y = centerY + point.y * scale;
            if (!here) {
              if (drawing) context!.lineTo(x, y);
              drawing = false;
              return;
            }
            if (!drawing) {
              const previous = path.points[Math.max(0, index - 1)];
              context!.moveTo(
                centerX + previous.x * scale,
                centerY + previous.y * scale,
              );
            }
            context!.lineTo(x, y);
            drawing = true;
          });
          const alpha =
            (front ? 0.24 : 0.09) *
            (1 - Math.abs(path.strand) * 0.22) *
            (active ? 1 : 0.22);
          context!.strokeStyle = emphasized
            ? `rgba(223,184,145,${alpha * 1.4})`
            : `rgba(${trace},${alpha})`;
          context!.lineWidth = front ? 0.68 : 0.55;
          context!.stroke();
        }
      }

      screenPoints = projectedEvents
        .map((point) => ({
          ...point,
          x: centerX + point.x * scale,
          y: centerY + point.y * scale,
        }))
        .sort((a, b) => a.z - b.z);

      const selectableIds = new Set(
        screenPoints
          .filter(
            ({ point }) => !selectedRepo || point.event.repo === selectedRepo,
          )
          .map(({ point }) => point.event.id),
      );
      const focusId = [localHover, hoveredId, selectedId].find(
        (id) => id !== null && selectableIds.has(id),
      );
      for (const point of screenPoints) {
        const event = point.point.event;
        const active = !selectedRepo || selectedRepo === event.repo;
        const focused = event.id === selectedId || event.id === focusId;
        const warm = event.type === "release" || focused;
        const appearedAt = arrivals.get(event.id);
        const arrival =
          appearedAt === undefined
            ? 0
            : Math.max(0, 1 - (motionTime - appearedAt) / 1.65);
        const alpha = active ? Math.min(1, 0.65 + point.z * 0.38) : 0.12;
        const radius =
          (event.type === "release"
            ? 2.6
            : event.type === "merge"
              ? 1.8
              : 1.4) * point.perspective;
        context!.globalAlpha = focused ? 1 : alpha;
        context!.fillStyle = warm ? accent : ink;
        context!.strokeStyle = warm ? accent : ink;
        context!.lineWidth = 0.95;

        if (event.type === "review" || event.type === "pr") {
          context!.beginPath();
          context!.arc(point.x, point.y, radius, 0, Math.PI * 2);
          context!.stroke();
        } else if (event.type === "release") {
          context!.beginPath();
          context!.moveTo(point.x, point.y - radius * 1.3);
          context!.lineTo(point.x + radius, point.y);
          context!.lineTo(point.x, point.y + radius * 1.3);
          context!.lineTo(point.x - radius, point.y);
          context!.closePath();
          context!.fill();
        } else {
          context!.beginPath();
          context!.arc(point.x, point.y, radius, 0, Math.PI * 2);
          context!.fill();
        }

        if (active && (focused || event.type === "release" || arrival > 0)) {
          const spread = focused ? 25 : arrival > 0 ? 22 : 18;
          const glow = context!.createRadialGradient(
            point.x,
            point.y,
            0,
            point.x,
            point.y,
            spread,
          );
          const glowStrength =
            focused || event.type === "release" ? 1 : arrival;
          glow.addColorStop(0, `rgba(223,184,145,${0.14 * glowStrength})`);
          glow.addColorStop(0.25, `rgba(223,184,145,${0.055 * glowStrength})`);
          glow.addColorStop(1, "rgba(223,184,145,0)");
          context!.fillStyle = glow;
          context!.fillRect(
            point.x - spread,
            point.y - spread,
            spread * 2,
            spread * 2,
          );
        }
        if (focused && active) {
          context!.globalAlpha = 0.8;
          context!.strokeStyle = accent;
          context!.lineWidth = 0.8;
          context!.beginPath();
          context!.arc(point.x, point.y, 7.5, 0, Math.PI * 2);
          context!.stroke();
        }
        if (active && arrival > 0) {
          context!.globalAlpha = 0.48 * arrival * arrival;
          context!.strokeStyle = accent;
          context!.lineWidth = 0.7;
          context!.beginPath();
          context!.arc(
            point.x,
            point.y,
            5 + (1 - arrival) * 14,
            0,
            Math.PI * 2,
          );
          context!.stroke();
        }
      }
      context!.globalAlpha = 1;

      const focus = screenPoints.find(
        (point) =>
          point.point.event.id === focusId &&
          (!selectedRepo || point.point.event.repo === selectedRepo),
      );
      if (focus) {
        const event = focus.point.event;
        const repo = event.repo.split("/").at(-1) ?? event.repo;
        let text = `${repo} / ${verbs[event.type]}`;
        context!.font = '11px "DM Sans Variable", Arial, sans-serif';
        const maximum = Math.min(230, width - 32);
        while (text.length > 4 && context!.measureText(text).width > maximum) {
          text = text.slice(0, -2).trimEnd() + "…";
        }
        const textWidth = context!.measureText(text).width;
        const labelX = Math.max(
          12,
          Math.min(width - textWidth - 12, focus.x + 17),
        );
        const labelY = Math.max(20, Math.min(height - 50, focus.y - 16));
        context!.fillStyle = "rgba(9,12,16,0.94)";
        context!.fillRect(labelX - 5, labelY - 13, textWidth + 10, 21);
        context!.fillStyle = accent;
        context!.fillText(text, labelX, labelY);
      }
      if (isMoving()) invalidate();
      else lastTime = 0;
    }

    function resize() {
      const bounds = control!.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.max(1, Math.round(width * dpr));
      canvas!.height = Math.max(1, Math.round(height * dpr));
      invalidate();
    }
    function nearest(x: number, y: number, radius = 15) {
      let result: ScreenPoint | null = null;
      let distance = radius;
      for (const point of screenPoints) {
        const { selectedRepo } = current.current;
        if (selectedRepo && point.point.event.repo !== selectedRepo) continue;
        const delta = Math.hypot(point.x - x, point.y - y);
        if (
          delta < distance ||
          (delta === distance && point.z > (result?.z ?? -2))
        ) {
          result = point;
          distance = delta;
        }
      }
      return result?.point.event ?? null;
    }
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        distance: 0,
      };
      velocityX = 0;
      velocityY = 0;
      control.setPointerCapture(event.pointerId);
      control.style.cursor = "grabbing";
      setHover(null);
    };
    const pointerMove = (event: PointerEvent) => {
      if (pointer && pointer.id === event.pointerId) {
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        pointer.distance += Math.hypot(dx, dy);
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        yaw += dx * 0.006;
        pitch += dy * 0.006;
        velocityX = Math.max(-1.4, Math.min(1.4, dx * 0.032));
        velocityY = Math.max(-1.4, Math.min(1.4, dy * 0.032));
        clampPitch();
        invalidate();
      } else if (!pointer) {
        const bounds = control.getBoundingClientRect();
        setHover(
          nearest(event.clientX - bounds.left, event.clientY - bounds.top)
            ?.id ?? null,
        );
      }
    };
    const finishPointer = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const wasClick = pointer.distance < 7 && event.type === "pointerup";
      pointer = null;
      if (control.hasPointerCapture(event.pointerId)) {
        control.releasePointerCapture(event.pointerId);
      }
      control.style.cursor = "grab";
      if (wasClick) {
        const bounds = control.getBoundingClientRect();
        const eventAtPoint = nearest(
          event.clientX - bounds.left,
          event.clientY - bounds.top,
          event.pointerType === "touch" ? 24 : 15,
        );
        if (eventAtPoint) current.current.onSelect(eventAtPoint);
        velocityX = 0;
        velocityY = 0;
      }
      invalidate();
    };
    const pointerLeave = () => {
      if (!pointer) setHover(null);
    };
    const selectNext = (direction = 1) => {
      const {
        model: data,
        cutoff,
        selectedRepo,
        selectedId,
        onSelect,
      } = current.current;
      const eligible = visibleOrbitPoints(data, cutoff).filter(
        (point) => !selectedRepo || point.event.repo === selectedRepo,
      );
      if (!eligible.length) return;
      const index = eligible.findIndex(
        (point) => point.event.id === selectedId,
      );
      const next =
        index < 0
          ? direction > 0
            ? 0
            : eligible.length - 1
          : (index + direction + eligible.length) % eligible.length;
      setHover(null);
      onSelect(eligible[next].event);
      invalidate();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(
          event.key,
        )
      ) {
        event.preventDefault();
        velocityX = 0;
        velocityY = 0;
        if (event.key === "Home") {
          yaw = 0.18;
          pitch = -0.38;
          idlePhase = 0;
        } else {
          yaw +=
            event.key === "ArrowLeft"
              ? -0.13
              : event.key === "ArrowRight"
                ? 0.13
                : 0;
          pitch +=
            event.key === "ArrowUp"
              ? -0.13
              : event.key === "ArrowDown"
                ? 0.13
                : 0;
        }
        clampPitch();
        invalidate();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNext(event.shiftKey ? -1 : 1);
      }
    };
    const click = (event: MouseEvent) => {
      // Screen-reader activation produces a native click without a pointer event.
      if (event.detail === 0) selectNext();
    };
    const visibilityChange = () => {
      if (document.hidden) stop();
      else invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(control);
    const intersection = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        if (inView) invalidate();
        else stop();
      },
      { threshold: 0 },
    );
    intersection.observe(control);
    document.addEventListener("visibilitychange", visibilityChange);
    window.addEventListener("resize", resize);
    control.addEventListener("pointerdown", pointerDown);
    control.addEventListener("pointermove", pointerMove);
    control.addEventListener("pointerup", finishPointer);
    control.addEventListener("pointercancel", finishPointer);
    control.addEventListener("lostpointercapture", finishPointer);
    control.addEventListener("pointerleave", pointerLeave);
    control.addEventListener("keydown", keyDown);
    control.addEventListener("click", click);
    invalidateRef.current = invalidate;
    resize();

    return () => {
      disposed = true;
      stop();
      invalidateRef.current = null;
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", visibilityChange);
      window.removeEventListener("resize", resize);
      control.removeEventListener("pointerdown", pointerDown);
      control.removeEventListener("pointermove", pointerMove);
      control.removeEventListener("pointerup", finishPointer);
      control.removeEventListener("pointercancel", finishPointer);
      control.removeEventListener("lostpointercapture", finishPointer);
      control.removeEventListener("pointerleave", pointerLeave);
      control.removeEventListener("keydown", keyDown);
      control.removeEventListener("click", click);
    };
  }, []);

  const visible = visibleOrbitPoints(model, props.cutoff).filter(
    (point) => !props.selectedRepo || point.event.repo === props.selectedRepo,
  );
  const selected = visible.find(
    (point) => point.event.id === props.selectedId,
  )?.event;
  const repositoryCount = props.selectedRepo ? 1 : model.repositories.length;

  return (
    <div className="orbit-scene">
      <button
        type="button"
        ref={controlRef}
        className="orbit-canvas-control"
        aria-label={`Explore ${visible.length} activity events in orbit. Arrow keys rotate. Enter selects the next event. Shift Enter selects the previous event. Home resets the view.`}
        aria-describedby={hintId}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
      </button>
      <span id={hintId} className="orbit-scene-hint">
        Drag to explore · select a point
      </span>
      <span className="orbit-scene-count">
        {repositoryCount}{" "}
        {props.journal
          ? repositoryCount === 1
            ? "source"
            : "sources"
          : repositoryCount === 1
            ? "repository"
            : "repositories"}{" "}
        · {visible.length} {visible.length === 1 ? "event" : "events"}
      </span>
      <span
        className="orbit-scene-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {selected
          ? `${selected.actor.login} ${verbs[selected.type]} ${selected.title} in ${selected.repo}.`
          : ""}
      </span>
    </div>
  );
}
