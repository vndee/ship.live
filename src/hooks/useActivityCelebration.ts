import { useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "../../shared/types";
import {
  observeActivity,
  type ActivityCelebration,
  type ActivityObservation,
} from "../lib/dashboardPulse";

export function useActivityCelebration(
  events: ActivityEvent[],
  {
    scope,
    ready,
    enabled,
  }: { scope: string; ready: boolean; enabled: boolean },
) {
  const tracker = useRef<ActivityObservation | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentScope = useRef(scope);
  const [celebration, setCelebration] = useState<ActivityCelebration | null>(
    null,
  );
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    const reset = () => {
      clearTimeout(timer.current);
      setCelebration(null);
      setHighlightedIds(new Set());
    };
    if (currentScope.current !== scope || !ready) {
      currentScope.current = scope;
      tracker.current = undefined;
      reset();
      if (!ready) return;
    }
    const next = observeActivity(
      tracker.current,
      events,
      Date.now(),
      enabled && visible,
    );
    tracker.current = next.state;
    if (!enabled || !visible) {
      reset();
      return;
    }
    if (!next.celebration) return;
    setCelebration(next.celebration);
    setHighlightedIds(
      (previous) => new Set([...previous, ...next.highlightedIds]),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCelebration(null);
      setHighlightedIds(new Set());
    }, 6000);
  }, [events, scope, ready, enabled, visible]);
  // Never retain a notice containing private event details while access is unverified.
  const active = ready && enabled && visible && currentScope.current === scope;
  return {
    celebration:
      active && events.some((event) => event.id === celebration?.event.id)
        ? celebration
        : null,
    highlightedIds: active ? highlightedIds : new Set<string>(),
  };
}
