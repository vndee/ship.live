import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ReviewContext,
  ReviewAction,
  ReviewFollowthroughItem,
} from "../../shared/review-followthrough.js";
interface State {
  key: string;
  items: ReviewFollowthroughItem[];
  loading: boolean;
  error: string;
  pending: boolean;
}
export function useReviewFollowthrough(
  context: ReviewContext | undefined,
  targets: { repositoryId: number; number: number }[],
) {
  const query = targets
    .slice(0, 50)
    .map((t) => `${t.repositoryId}:${t.number}`)
    .join(",");
  const key = context
    ? `${context.workspaceId}:${context.userId}:${context.scopeKey}:${query}`
    : "";
  const active = useRef(key);
  useLayoutEffect(() => {
    active.current = key;
  }, [key]);
  const sequence = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const mutation = useRef<{ key: string; request: number } | null>(null);
  const [state, setState] = useState<State>({
    key: "",
    items: [],
    loading: false,
    error: "",
    pending: false,
  });
  const base = context
    ? `/api/workspaces/${encodeURIComponent(context.workspaceId)}/review-followthrough`
    : "";
  useEffect(() => {
    if (!context || !query) {
      setState({ key, items: [], loading: false, error: "", pending: false });
      return;
    }
    let cancelled = false;
    let inflight = false;
    const controller = new AbortController();
    setState({ key, items: [], loading: true, error: "", pending: false });
    const refresh = async () => {
      if (inflight || mutation.current?.key === key) return;
      inflight = true;
      const request = ++sequence.current;
      try {
        const res = await fetch(`${base}?items=${encodeURIComponent(query)}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        });
        if (!res.ok) throw new Error("Could not load current review status.");
        const data = await res.json();
        if (
          !cancelled &&
          active.current === key &&
          request === sequence.current
        )
          setState({
            key,
            items: data.items,
            loading: false,
            error: "",
            pending: false,
          });
      } catch (error) {
        if (
          !cancelled &&
          active.current === key &&
          request === sequence.current
        )
          setState({
            key,
            items: [],
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not load current review status.",
            pending: false,
          });
      } finally {
        inflight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    const update = () => void refresh();
    window.addEventListener("ship-live-wall", update);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("ship-live-wall", update);
    };
  }, [key, base, query, refreshVersion]);
  async function act(
    item: ReviewFollowthroughItem | undefined,
    action: ReviewAction,
    hours?: number,
  ) {
    if (
      !context ||
      !item ||
      mutation.current?.key === key ||
      active.current !== key
    )
      return;
    let conflict = false;
    let invalidInput = false;
    const request = ++sequence.current;
    mutation.current = { key, request };
    setState((s) => ({ ...s, pending: true, error: "" }));
    try {
      const res = await fetch(base, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": context.csrfToken,
        },
        body: JSON.stringify({
          repositoryId: item.repositoryId,
          number: item.number,
          fingerprint: item.fingerprint,
          action,
          hours,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      if (!res.ok) {
        conflict = res.status === 409;
        invalidInput = res.status === 400;
        throw new Error(data.error || "Could not save review action.");
      }
      if (active.current === key && request === sequence.current)
        setState((s) => ({
          ...s,
          pending: false,
          items: s.items.map((old) =>
            old.repositoryId === item.repositoryId && old.number === item.number
              ? data.items[0]
              : old,
          ),
        }));
    } catch (error) {
      if (active.current === key && request === sequence.current)
        setState((s) => ({
          ...s,
          pending: false,
          items: invalidInput ? s.items : [],
          error:
            error instanceof Error
              ? error.message
              : "Could not save review action.",
        }));
    } finally {
      if (mutation.current?.request === request) mutation.current = null;
      if (conflict && active.current === key && request === sequence.current)
        setRefreshVersion((version) => version + 1);
    }
  }
  return {
    ...(state.key === key
      ? state
      : {
          key,
          items: [],
          loading: !!context && !!query,
          error: "",
          pending: false,
        }),
    act,
  };
}
