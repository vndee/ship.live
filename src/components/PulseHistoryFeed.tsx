import { useEffect, useRef, useState } from "react";
import { resolvePulseRange, type PulseActivityPage } from "../../shared/pulse";
import { isHumanActor } from "../lib/activity";
import { fetchPulse, pulseEndpoint, type PulseSource } from "../hooks/usePulse";
import type { ActivityEvent } from "../../shared/types";
import "../pulse-range.css";
export function PulseHistoryFeed(props: {
  source: PulseSource;
  from?: string;
  to?: string;
  repo?: string;
  now: number;
  onBack: () => void;
}) {
  const { source, from, to, repo } = props;
  // Remount on scope/range changes so an older request cannot append to a new view.
  const key = `${source.scopeKey}:${source.workspaceId}:${source.shareToken}:${source.enabled}:${from}:${to}:${repo}`;
  return <HistoryPage key={key} {...props} />;
}
function HistoryPage({
  source,
  from,
  to,
  repo,
  now,
  onBack,
}: {
  source: PulseSource;
  from?: string;
  to?: string;
  repo?: string;
  now: number;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [cutoff] = useState(now);
  const active = useRef<AbortController | null>(null);
  const validationCursor = useRef<string | null>(null);
  const loaded = useRef(false);
  const lastRevision = useRef(source.revision);
  const demoRows = source.events
    .filter(
      (event) =>
        event.type !== "note" &&
        event.type !== "alert" &&
        isHumanActor(event.actor.login) &&
        (!repo || event.repo === repo) &&
        Date.parse(event.occurredAt) <= cutoff,
    )
    .sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
        b.id.localeCompare(a.id),
    );
  async function load(cursor?: string) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    if (!cursor) {
      loaded.current = false;
      validationCursor.current = null;
    }
    setLoading(true);
    setError("");
    try {
      const range = resolvePulseRange({ period: "custom", from, to }, cutoff);
      let page: PulseActivityPage;
      if (source.demo) {
        const rows = demoRows.filter(
          (event, index, all) =>
            Date.parse(event.occurredAt) >= Date.parse(range.start) &&
            Date.parse(event.occurredAt) < Date.parse(range.end) &&
            all.findIndex((e) => e.id === event.id) === index,
        );
        const offset = Number(cursor || 0);
        page = {
          events: rows.slice(offset, offset + 100),
          nextCursor: rows.length > offset + 100 ? String(offset + 100) : null,
        };
      } else {
        const params = new URLSearchParams({
          period: "custom",
          from: range.from,
          to: range.to,
        });
        if (repo) params.set("repo", repo);
        if (cursor) params.set("cursor", cursor);
        page = await fetchPulse<PulseActivityPage>(
          source,
          `${pulseEndpoint(source, "activity")}?${params}`,
          controller.signal,
        );
      }
      if (!controller.signal.aborted) {
        if (!cursor) validationCursor.current = page.nextCursor;
        loaded.current = true;
        setEvents((previous) =>
          cursor ? [...previous, ...page.events] : page.events,
        );
        setNext(page.nextCursor);
        setLoading(false);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setEvents([]);
        setNext(null);
        setError(
          error instanceof Error ? error.message : "Could not load activity.",
        );
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    if (source.enabled) void load();
    return () => active.current?.abort();
  }, [retry]);
  useEffect(() => {
    if (lastRevision.current === source.revision) return;
    lastRevision.current = source.revision;
    if (!source.enabled || source.demo || !loaded.current) return;
    const controller = new AbortController();
    const cursor = validationCursor.current;
    const params = new URLSearchParams({
      period: "custom",
      from: from || "",
      to: to || "",
    });
    if (repo) params.set("repo", repo);
    // The server binds this cursor to the complete authorized repository scope.
    // Revalidating it preserves pages and scroll while detecting access changes.
    if (cursor) params.set("cursor", cursor);
    void fetchPulse<PulseActivityPage>(
      source,
      `${pulseEndpoint(source, "activity")}?${params}`,
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted || cursor) return;
        validationCursor.current = page.nextCursor;
        setEvents(page.events);
        setNext(page.nextCursor);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        active.current?.abort();
        setEvents([]);
        setNext(null);
        setLoading(false);
        setError(
          error instanceof Error
            ? error.message
            : "Could not verify activity access.",
        );
      });
    return () => controller.abort();
  }, [source.revision, retry]);
  return (
    <section className="pulse-history" aria-label="Historical activity">
      <button className="text-button" onClick={onBack}>
        ← Back to Overview
      </button>
      <div className="pulse-period-heading">
        <div>
          <h2>Activity in selected period</h2>
          <p>
            {from} — {to} · UTC{repo ? ` · ${repo}` : ""}
          </p>
        </div>
      </div>
      <p className="pulse-coverage">
        {source.demo
          ? "Fictional demo activity."
          : "Stored contributions visible to you. Imports cover limited history; historical completeness is not guaranteed."}
      </p>
      {error ? (
        <div className="pulse-range-state" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="event-list">
            {events.map((event) => (
              <article className="event-row" key={event.id}>
                <div className="event-topline">
                  <strong>{event.actor.login}</strong>
                  <span>
                    {event.type} · {event.repo}
                  </span>
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleString(undefined, {
                      timeZone: "UTC",
                    })}{" "}
                    UTC
                  </time>
                </div>
                {event.url && /^https:\/\//i.test(event.url) ? (
                  <a
                    className="event-title"
                    href={event.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {event.title}
                  </a>
                ) : (
                  <span className="event-title">{event.title}</span>
                )}
              </article>
            ))}
          </div>
          {loading ? (
            <p role="status" className="pulse-range-state">
              Loading activity…
            </p>
          ) : !events.length ? (
            <p className="pulse-range-state">
              No stored activity in this period.
            </p>
          ) : null}
          {next && (
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={() => void load(next)}
            >
              Load more activity
            </button>
          )}
        </>
      )}
    </section>
  );
}
