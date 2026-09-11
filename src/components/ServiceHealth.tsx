import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableHealthService } from "./SortableHealthService";
import { moveService } from "../lib/service-order";
import { LatencyChart } from "./LatencyChart";
import { ServiceStatusStrip } from "./ServiceStatusStrip";
import { HealthServiceStats, HealthStatsInfo } from "./HealthServiceStats";

/** Paused probes are not checked, so their open incidents wait for them. */
function incidentState(
  incident: { probeId: string; resolvedAt: string | null },
  probes: { id: string; enabled: boolean }[],
) {
  if (incident.resolvedAt) return "Resolved";
  const paused = probes.some(
    (probe) => probe.id === incident.probeId && !probe.enabled,
  );
  return paused ? "Ongoing · probe paused" : "Ongoing";
}

/** How long an incident lasted, or has lasted so far. */
function incidentLength(
  incident: { openedAt: string; resolvedAt: string | null },
  now: number,
) {
  const minutes = Math.max(
    1,
    Math.round(
      ((incident.resolvedAt ? Date.parse(incident.resolvedAt) : now) -
        Date.parse(incident.openedAt)) /
        60_000,
    ),
  );
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
import { serviceStats } from "../lib/service-stats";
import { createHealthRefresh } from "../lib/health-refresh";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ChevronDown, Plus, RefreshCw } from "lucide-react";
import type {
  HealthProbe,
  HealthSnapshot,
  HealthStatus,
  ProbeInput,
} from "../../shared/health";
import "./service-health.css";
import { aggregate } from "../lib/service-status-strip";

const defaults: ProbeInput = {
  name: "",
  url: "",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10000,
  statusMin: 200,
  statusMax: 299,
  maxLatencyMs: null,
  jsonPath: "",
  jsonExpected: null,
  failureThreshold: 3,
  recoveryThreshold: 2,
  enabled: true,
};
function definition(probe: ProbeInput): ProbeInput {
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, probe[key as keyof ProbeInput]]),
  ) as unknown as ProbeInput;
}
function currentStatus(probe: HealthProbe, now: number): HealthStatus {
  if (!probe.enabled) return "paused";
  if (
    !probe.lastCheck ||
    now - Date.parse(probe.lastCheck.checkedAt) >
      probe.intervalSeconds * 2000 + probe.timeoutMs
  )
    return "unknown";
  return probe.status;
}
function Badge({ status }: { status: HealthStatus }) {
  return (
    <span className={`health-badge health-${status}`}>
      <span aria-hidden="true" />
      {status[0].toUpperCase() + status.slice(1)}
    </span>
  );
}
function relative(time: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(time)) / 1000));
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`;
}
type Editor = { serviceId: string; probe?: HealthProbe };

export function ServiceHealth({
  workspaceId,
  csrfToken,
}: {
  workspaceId: string;
  csrfToken: string;
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/health`;
  const [accessRevoked, setAccessRevoked] = useState(false);
  const revokeAccess = useRef<() => void>(() => {});
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [changes, setChanges] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const mutationPending = useRef(false);
  const [dragging, setDragging] = useState(false);
  const beforeDrag = useRef<HealthSnapshot["services"] | null>(null);
  const queuedSnapshot = useRef<HealthSnapshot | null>(null);
  const snapshotVersion = useRef(0);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [now, setNow] = useState(Date.now());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(
    null,
  );
  const [serviceIdsBeforeCreate, setServiceIdsBeforeCreate] =
    useState<Set<string> | null>(null);
  const [serviceEditor, setServiceEditor] = useState<{
    id?: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    path: string;
    label: string;
  } | null>(null);
  const refresh = useRef<() => void>(() => {});
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const scope = new AbortController();
    lifecycle.current = scope;
    mutationPending.current = false;
    beforeDrag.current = null;
    queuedSnapshot.current = null;
    setBusy(false);
    setDragging(false);
    let previous: Map<string, HealthStatus> | null = null;
    let stream: EventSource | null = null;
    setAccessRevoked(false);
    setSnapshot(null);
    setLoadError("");
    const revoke = () => {
      scope.abort();
      stream?.close();
      previous = null;
      setSnapshot(null);
      setEditor(null);
      setServiceEditor(null);
      setDeleting(null);
      setChanges([]);
      setNotice("");
      setActionError("");
      setLoadError("");
      setBusy(false);
      mutationPending.current = false;
      beforeDrag.current = null;
      queuedSnapshot.current = null;
      setDragging(false);
      setAccessRevoked(true);
    };
    revokeAccess.current = revoke;
    const load = async (refreshSignal: AbortSignal) => {
      if (scope.signal.aborted) return;
      const version = snapshotVersion.current;
      const request = new AbortController();
      const abort = () => request.abort();
      scope.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 20000);
      try {
        const response = await fetch(base, {
          credentials: "same-origin",
          signal: AbortSignal.any([request.signal, refreshSignal]),
        });
        if (scope.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          revoke();
          return;
        }
        if (!response.ok)
          throw new Error(
            "Health data could not be loaded. Retry to reconnect.",
          );
        const next: HealthSnapshot = await response.json();
        if (scope.signal.aborted) return;
        // A GET begun before a successful reorder must not undo its new order.
        if (version !== snapshotVersion.current) {
          refresh.current();
          return;
        }
        const nextStates = new Map<string, HealthStatus>();
        const announcements: string[] = [];
        for (const service of next.services)
          for (const probe of service.probes) {
            const state = currentStatus(probe, Date.now());
            nextStates.set(probe.id, state);
            const before = previous?.get(probe.id);
            if (
              before &&
              before !== state &&
              (state === "down" ||
                (state === "healthy" &&
                  (before === "down" || before === "degraded")))
            )
              announcements.push(
                `${service.name} / ${probe.name} is ${state === "healthy" ? "healthy again" : "down"}.`,
              );
          }
        previous = nextStates;
        if (announcements.length) setChanges(announcements);
        if (beforeDrag.current) queuedSnapshot.current = next;
        else setSnapshot(next);
        setLoadError("");
      } catch {
        if (!scope.signal.aborted)
          setLoadError(
            "Health updates are unavailable. Displayed results may be out of date.",
          );
      } finally {
        clearTimeout(timeout);
        scope.signal.removeEventListener("abort", abort);
      }
    };
    const scheduler = createHealthRefresh(load, { signal: scope.signal });
    refresh.current = scheduler.request;
    scheduler.request();
    stream = new EventSource(`${base}/events`, { withCredentials: true });
    stream.addEventListener("health", refresh.current);
    stream.addEventListener("access-revoked", revoke);
    stream.onerror = refresh.current;
    stream.onopen = refresh.current;
    const poll = setInterval(scheduler.request, 30000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      scope.abort();
      stream.close();
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [base]);
  useEffect(() => {
    if (!changes.length) return;
    const timer = setTimeout(() => setChanges([]), 12000);
    return () => clearTimeout(timer);
  }, [changes]);
  useEffect(() => {
    if (!snapshot || !serviceIdsBeforeCreate) return;
    const created = snapshot.services.find(
      (service) => !serviceIdsBeforeCreate.has(service.id),
    );
    if (!created) return;
    setExpandedServiceId(created.id);
    setServiceIdsBeforeCreate(null);
  }, [snapshot, serviceIdsBeforeCreate]);
  async function mutate(
    path: string,
    method: string,
    body?: unknown,
    message = "Saved",
  ) {
    const scope = lifecycle.current;
    if (
      !scope ||
      scope.signal.aborted ||
      mutationPending.current ||
      (beforeDrag.current && path !== "/services/order")
    )
      return false;
    mutationPending.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    const request = new AbortController();
    const abort = () => request.abort();
    scope.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20000);
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        credentials: "same-origin",
        signal: request.signal,
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (scope.signal.aborted) return false;
      if ([401, 403].includes(response.status)) {
        revokeAccess.current();
        return false;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Could not save this change.");
      }
      if (scope.signal.aborted) return false;
      setNotice(message);
      refresh.current();
      return true;
    } catch (error) {
      if (!scope.signal.aborted)
        setActionError(
          request.signal.aborted
            ? "The request timed out. Refresh health before retrying; your change may have been saved."
            : error instanceof Error
              ? error.message
              : "Could not save this change.",
        );
      return false;
    } finally {
      clearTimeout(timer);
      scope.signal.removeEventListener("abort", abort);
      if (!scope.signal.aborted) {
        mutationPending.current = false;
        setBusy(false);
      }
    }
  }
  function finishDrag(order?: HealthSnapshot["services"]) {
    const queued = queuedSnapshot.current;
    beforeDrag.current = null;
    queuedSnapshot.current = null;
    setDragging(false);
    if (!queued) return;
    if (!order) {
      setSnapshot(queued);
      return;
    }
    // Keep fresh probe data and membership without replaying a pre-save order.
    const services = new Map(
      queued.services.map((service) => [service.id, service]),
    );
    const ordered = order.flatMap((service) => {
      const fresh = services.get(service.id);
      services.delete(service.id);
      return fresh ? [fresh] : [];
    });
    setSnapshot({ ...queued, services: [...ordered, ...services.values()] });
  }
  async function endDrag({ active, over }: DragEndEvent) {
    const before = beforeDrag.current;
    const scope = lifecycle.current;
    if (!before || !scope || scope.signal.aborted) return;
    const reordered = moveService(
      before,
      String(active.id),
      String(over?.id ?? active.id),
    );
    if (reordered === before) {
      finishDrag();
      return;
    }
    setSnapshot((current) => current && { ...current, services: reordered });
    const saved = await mutate(
      "/services/order",
      "PUT",
      { serviceIds: reordered.map((service) => service.id) },
      "Service order saved",
    );
    if (scope.signal.aborted) return;
    if (saved) snapshotVersion.current++;
    else setSnapshot((current) => current && { ...current, services: before });
    finishDrag(saved ? reordered : undefined);
    // Also reconcile failures: a timeout may have committed, or membership changed.
    refresh.current();
  }
  if (accessRevoked)
    return (
      <section className="service-health" aria-label="Service Health">
        <h2>Service Health</h2>
        <p role="alert">
          Access to this workspace has expired or been removed. Reload to sign
          in or choose an accessible workspace.
        </p>
        <button
          className="button secondary"
          onClick={() => window.location.reload()}
        >
          Reload workspace
        </button>
      </section>
    );
  return (
    <section className="service-health" aria-labelledby="service-health-title">
      <div className="section-heading health-heading">
        <h2 id="service-health-title">
          <Activity size={19} /> Service Health{" "}
          <span className="section-count">
            {snapshot?.services.length ?? 0}
          </span>
        </h2>
        <div className="health-actions">
          <button
            className="text-button"
            onClick={() => {
              setServiceEditor({ name: "" });
              setEditor(null);
            }}
          >
            <Plus size={14} /> Add service
          </button>
          <button
            className="icon-button"
            aria-label="Refresh health"
            onClick={() => refresh.current()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <p className="health-intro">
        Public API checks for your team. Health is live and independent of the
        activity timeline.
      </p>
      {loadError && (
        <p className="health-error" role="alert">
          {loadError}{" "}
          <button className="text-button" onClick={() => refresh.current()}>
            Retry
          </button>
        </p>
      )}
      {actionError && (
        <p className="health-error" role="alert">
          {actionError}
        </p>
      )}
      <div role="status" aria-live="polite">
        {notice && <p className="health-notice">{notice}</p>}
        {changes.length > 0 && (
          <p className="health-change">{changes.join(" ")}</p>
        )}
      </div>
      {serviceEditor && (
        <form
          className="health-service-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const creating = !serviceEditor.id;
            const existingIds = new Set(
              snapshot?.services.map((service) => service.id) || [],
            );
            if (
              await mutate(
                serviceEditor.id
                  ? `/services/${serviceEditor.id}`
                  : "/services",
                serviceEditor.id ? "PATCH" : "POST",
                { name: serviceEditor.name },
                "Service saved",
              )
            ) {
              if (creating) setServiceIdsBeforeCreate(existingIds);
              setServiceEditor((current) =>
                current === serviceEditor ? null : current,
              );
            }
          }}
        >
          <label>
            Service name
            <input
              autoFocus
              required
              maxLength={80}
              value={serviceEditor.name}
              onChange={(event) =>
                setServiceEditor({ ...serviceEditor, name: event.target.value })
              }
              placeholder="Payments API"
            />
          </label>
          <div className="health-actions health-service-form-actions">
            <button className="button secondary" disabled={busy || dragging}>
              Save service
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setServiceEditor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {!snapshot && !loadError && (
        <p className="health-empty" role="status">
          Loading service health…
        </p>
      )}
      {snapshot?.services.length === 0 && (
        <div className="health-empty">
          <h3>Keep an eye on what you ship</h3>
          <p>
            Add a service, then configure a public HTTP endpoint to start
            recording checks.
          </p>
        </div>
      )}
      <DndContext
        sensors={busy ? [] : sensors}
        collisionDetection={closestCenter}
        onDragStart={() => {
          if (mutationPending.current || !snapshot || beforeDrag.current)
            return;
          beforeDrag.current = snapshot.services;
          setDragging(true);
        }}
        onDragEnd={(event) => void endDrag(event)}
        onDragCancel={() => finishDrag()}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              "To reorder a service, press Space, use the arrow keys to move, then press Space to save. Press Escape to cancel.",
          },
          announcements: {
            onDragStart: ({ active }) =>
              `Picked up ${active.data.current?.name ?? "service"}.`,
            onDragOver: ({ active, over }) =>
              over
                ? `${active.data.current?.name ?? "Service"} is over ${over.data.current?.name ?? "another service"}.`
                : undefined,
            onDragEnd: ({ active, over }) =>
              over && active.id !== over.id
                ? `Dropped ${active.data.current?.name ?? "service"}. Saving service order.`
                : "Service order unchanged.",
            onDragCancel: () =>
              "Reordering cancelled. Service order unchanged.",
          },
        }}
      >
        <SortableContext
          items={snapshot?.services.map((service) => service.id) ?? []}
          strategy={verticalListSortingStrategy}
        >
          {snapshot?.services.map((service) => {
            const expanded = expandedServiceId === service.id;
            const stats = serviceStats(service.probes);
            const status = aggregate(
              service.probes.map((probe) => currentStatus(probe, now)),
            );
            return (
              <SortableHealthService
                key={service.id}
                id={service.id}
                name={service.name}
                expanded={expanded}
                disabled={busy}
                unavailable={(snapshot?.services.length ?? 0) < 2}
              >
                {(handle) => (
                  <>
                    <div className="health-service-heading">
                      <div className="health-service-summary">
                        {handle}
                        <button
                          className="health-service-toggle"
                          type="button"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedServiceId((current) =>
                              current === service.id ? null : service.id,
                            )
                          }
                        >
                          <ChevronDown aria-hidden="true" size={16} />
                          <span className="health-service-name">
                            {service.name}
                          </span>
                          <Badge status={status} />
                          <span className="health-probe-count">
                            {service.probes.length}{" "}
                            {service.probes.length === 1 ? "probe" : "probes"}
                          </span>
                          <HealthServiceStats stats={stats} />
                          <ServiceStatusStrip probes={service.probes} />
                        </button>
                        <HealthStatsInfo stats={stats} />
                      </div>
                      {expanded && (
                        <div className="health-actions health-service-actions">
                          <button
                            className="text-button"
                            onClick={() => {
                              setEditor({ serviceId: service.id });
                              setServiceEditor(null);
                            }}
                          >
                            Add probe
                          </button>
                          <button
                            className="text-button"
                            onClick={() => {
                              setServiceEditor({
                                id: service.id,
                                name: service.name,
                              });
                              setEditor(null);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="text-button"
                            onClick={() =>
                              setDeleting({
                                path: `/services/${service.id}`,
                                label: `${service.name} and all its probes`,
                              })
                            }
                          >
                            Delete service
                          </button>
                        </div>
                      )}
                    </div>
                    {expanded && (
                      <div className="health-service-details">
                        {Boolean(service.incidents?.length) && (
                          <div className="health-incidents">
                            <h4>Recent incidents</h4>
                            <ul>
                              {service.incidents!.map((incident) => (
                                <li key={incident.id}>
                                  <span
                                    className={`health-incident-state ${incident.resolvedAt ? "resolved" : "open"}`}
                                  >
                                    {incidentState(incident, service.probes)}
                                  </span>
                                  <span className="health-incident-text">
                                    <strong>{incident.probeName}</strong>{" "}
                                    {incident.reason}
                                  </span>
                                  <time dateTime={incident.openedAt}>
                                    {new Date(
                                      incident.openedAt,
                                    ).toLocaleString()}{" "}
                                    · {incidentLength(incident, now)}
                                  </time>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {!service.probes.length && (
                          <p className="health-empty">
                            No probes yet. Add a public endpoint to check this
                            service.
                          </p>
                        )}
                        {service.probes.map((probe) => (
                          <div className="health-probe" key={probe.id}>
                            <div className="health-probe-top">
                              <strong>{probe.name}</strong>
                              <Badge status={currentStatus(probe, now)} />
                            </div>
                            <div className="health-metrics">
                              <span>
                                Latency{" "}
                                <strong>
                                  {probe.lastCheck
                                    ? `${Math.round(probe.lastCheck.latencyMs)} ms`
                                    : "—"}
                                </strong>
                              </span>
                              <span>
                                Last check{" "}
                                <strong>
                                  {probe.lastCheck ? (
                                    <time
                                      dateTime={probe.lastCheck.checkedAt}
                                      title={new Date(
                                        probe.lastCheck.checkedAt,
                                      ).toLocaleString()}
                                    >
                                      {relative(probe.lastCheck.checkedAt, now)}
                                    </time>
                                  ) : (
                                    "Never"
                                  )}
                                </strong>
                              </span>
                              <span>
                                Check success · 24h{" "}
                                <strong>
                                  {probe.successRate24h === null
                                    ? "—"
                                    : `${probe.successRate24h.toFixed(1)}%`}{" "}
                                  <small>({probe.checks24h} checks)</small>
                                </strong>
                              </span>
                            </div>
                            {probe.lastCheck && (
                              <p className="health-result">
                                {probe.lastCheck.statusCode === null
                                  ? "No HTTP response"
                                  : `HTTP ${probe.lastCheck.statusCode}`}
                                {probe.lastCheck.reason
                                  ? ` · ${probe.lastCheck.reason}`
                                  : ""}
                              </p>
                            )}
                            {currentStatus(probe, now) === "unknown" && (
                              <p className="health-result">
                                {probe.lastCheck
                                  ? "Check overdue. Waiting for a fresh result."
                                  : "Waiting for the first check."}
                              </p>
                            )}
                            <LatencyChart
                              name={probe.name}
                              history={probe.history}
                              daily={probe.latencyHistory}
                              windows={probe.latency24h}
                              now={now}
                            />
                            <div
                              className="health-history"
                              role="img"
                              aria-label={`Recent checks for ${probe.name}, oldest to newest: ${
                                probe.history
                                  .slice(0, 40)
                                  .reverse()
                                  .map((check) =>
                                    check.ok ? "passed" : "failed",
                                  )
                                  .join(", ") || "no checks"
                              }`}
                            >
                              {probe.history
                                .slice(0, 40)
                                .reverse()
                                .map((check, index) => (
                                  <span
                                    key={`${check.checkedAt}-${index}`}
                                    className={
                                      check.ok ? "health-pass" : "health-fail"
                                    }
                                    title={`${new Date(check.checkedAt).toLocaleString()} · ${check.ok ? "Passed" : "Failed"} · ${Math.round(check.latencyMs)} ms`}
                                  />
                                ))}
                              {!probe.history.length && (
                                <span className="health-no-history">
                                  No recorded checks
                                </span>
                              )}
                            </div>
                            <details className="health-timeline">
                              <summary>State-change timeline</summary>
                              <ul>
                                {probe.history
                                  .slice()
                                  .reverse()
                                  .filter(
                                    (check, index, history) =>
                                      index === 0 ||
                                      check.status !==
                                        history[index - 1].status,
                                  )
                                  .slice(-8)
                                  .reverse()
                                  .map((check, index) => (
                                    <li key={`${check.checkedAt}-${index}`}>
                                      <Badge status={check.status} />
                                      <time dateTime={check.checkedAt}>
                                        {new Date(
                                          check.checkedAt,
                                        ).toLocaleString()}
                                      </time>
                                    </li>
                                  ))}
                              </ul>
                              {!probe.history.length && (
                                <p>No state changes recorded.</p>
                              )}
                            </details>
                            <div className="health-actions health-probe-actions">
                              <button
                                className="text-button"
                                disabled={busy || dragging || !probe.enabled}
                                onClick={() =>
                                  void mutate(
                                    `/probes/${probe.id}/check`,
                                    "POST",
                                    undefined,
                                    "Check queued. The result will appear when it finishes.",
                                  )
                                }
                              >
                                Check now
                              </button>
                              <button
                                className="text-button"
                                disabled={busy || dragging}
                                onClick={() =>
                                  void mutate(
                                    `/probes/${probe.id}`,
                                    "PUT",
                                    {
                                      ...definition(probe),
                                      enabled: !probe.enabled,
                                    },
                                    probe.enabled
                                      ? "Probe paused"
                                      : "Probe resumed",
                                  )
                                }
                              >
                                {probe.enabled ? "Pause" : "Resume"}
                              </button>
                              <button
                                className="text-button"
                                onClick={() => {
                                  setEditor({ serviceId: service.id, probe });
                                  setServiceEditor(null);
                                }}
                              >
                                Edit probe
                              </button>
                              <button
                                className="text-button"
                                onClick={() =>
                                  setDeleting({
                                    path: `/probes/${probe.id}`,
                                    label: probe.name,
                                  })
                                }
                              >
                                Delete probe
                              </button>
                            </div>
                          </div>
                        ))}
                        {editor?.serviceId === service.id && (
                          <ProbeEditor
                            key={editor.probe?.id || "new"}
                            probe={editor.probe}
                            busy={busy || dragging}
                            onCancel={() => setEditor(null)}
                            onSave={async (input) => {
                              const ok = await mutate(
                                editor.probe
                                  ? `/probes/${editor.probe.id}`
                                  : `/services/${service.id}/probes`,
                                editor.probe ? "PUT" : "POST",
                                input,
                                "Probe saved",
                              );
                              if (ok)
                                setEditor((current) =>
                                  current === editor ? null : current,
                                );
                            }}
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
              </SortableHealthService>
            );
          })}
        </SortableContext>
      </DndContext>
      {deleting && (
        <div className="health-confirm" role="alert">
          <p>
            Delete {deleting.label}? Its recorded checks will also be removed.
          </p>
          <div className="health-actions">
            <button
              className="button secondary"
              disabled={busy || dragging}
              onClick={async () => {
                if (await mutate(deleting.path, "DELETE", undefined, "Deleted"))
                  setDeleting((current) =>
                    current === deleting ? null : current,
                  );
              }}
            >
              Confirm delete
            </button>
            <button className="text-button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProbeEditor({
  probe,
  busy,
  onSave,
  onCancel,
}: {
  probe?: HealthProbe;
  busy: boolean;
  onSave: (
    input: ProbeInput & { headers?: Record<string, string> },
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState<ProbeInput>(() =>
    probe ? definition(probe) : { ...defaults },
  );
  const [headers, setHeaders] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [expected, setExpected] = useState(
    JSON.stringify(probe?.jsonExpected ?? null),
  );
  const [error, setError] = useState("");
  function update<K extends keyof ProbeInput>(key: K, value: ProbeInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (input.timeoutMs >= input.intervalSeconds * 1000)
        throw new Error("Timeout must be shorter than the check interval.");
      if (input.statusMin > input.statusMax)
        throw new Error("Minimum HTTP status must not exceed maximum status.");
      const jsonExpected: unknown = input.jsonPath
        ? JSON.parse(expected)
        : null;
      if (
        jsonExpected !== null &&
        !["string", "number", "boolean"].includes(typeof jsonExpected)
      )
        throw new Error(
          "Expected JSON value must be a string, number, boolean, or null.",
        );
      let parsedHeaders: Record<string, string> | undefined;
      if (clearHeaders) parsedHeaders = {};
      else if (headers.trim()) {
        const parsed: unknown = JSON.parse(headers);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((value) => typeof value !== "string")
        )
          throw new Error("Headers must be a JSON object with string values.");
        parsedHeaders = parsed as Record<string, string>;
      }
      await onSave({
        ...input,
        jsonExpected: jsonExpected as ProbeInput["jsonExpected"],
        ...(parsedHeaders === undefined ? {} : { headers: parsedHeaders }),
      });
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? "Use valid JSON for headers and the expected value. Put text values in double quotes."
          : err instanceof Error
            ? err.message
            : "Check the probe settings.",
      );
    }
  }
  return (
    <form className="health-editor" onSubmit={save}>
      <fieldset disabled={busy} className="health-editor-fields">
        <h4>{probe ? "Edit probe" : "Add probe"}</h4>
        {error && (
          <p className="health-error" role="alert">
            {error}
          </p>
        )}
        <div className="health-form-grid">
          <label>
            Probe name
            <input
              autoFocus
              required
              maxLength={80}
              value={input.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Readiness"
            />
          </label>
          <label>
            Public endpoint
            <input
              required
              type="url"
              value={input.url}
              onChange={(e) => update("url", e.target.value)}
              placeholder="https://api.example.com/health"
            />
          </label>
          <label>
            Method
            <select
              value={input.method}
              onChange={(e) =>
                update("method", e.target.value as "GET" | "HEAD")
              }
            >
              <option>GET</option>
              <option>HEAD</option>
            </select>
          </label>
          <label>
            Interval (seconds)
            <input
              type="number"
              required
              min={30}
              max={3600}
              value={input.intervalSeconds}
              onChange={(e) =>
                update("intervalSeconds", Number(e.target.value))
              }
            />
          </label>
          <label>
            Timeout (milliseconds)
            <input
              type="number"
              required
              min={1000}
              max={20000}
              value={input.timeoutMs}
              onChange={(e) => update("timeoutMs", Number(e.target.value))}
            />
          </label>
          <label>
            Maximum latency (ms, optional)
            <input
              type="number"
              min={1}
              value={input.maxLatencyMs ?? ""}
              onChange={(e) =>
                update(
                  "maxLatencyMs",
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
            />
          </label>
          <label>
            Minimum HTTP status
            <input
              type="number"
              required
              min={100}
              max={599}
              value={input.statusMin}
              onChange={(e) => update("statusMin", Number(e.target.value))}
            />
          </label>
          <label>
            Maximum HTTP status
            <input
              type="number"
              required
              min={100}
              max={599}
              value={input.statusMax}
              onChange={(e) => update("statusMax", Number(e.target.value))}
            />
          </label>
          <label>
            Failures before down
            <input
              type="number"
              required
              min={1}
              max={10}
              value={input.failureThreshold}
              onChange={(e) =>
                update("failureThreshold", Number(e.target.value))
              }
            />
          </label>
          <label>
            Successes before recovery
            <input
              type="number"
              required
              min={1}
              max={10}
              value={input.recoveryThreshold}
              onChange={(e) =>
                update("recoveryThreshold", Number(e.target.value))
              }
            />
          </label>
          <label>
            JSON path (optional)
            <input
              value={input.jsonPath}
              onChange={(e) => update("jsonPath", e.target.value)}
              placeholder="health.ready"
            />
            <small>
              Examples: health.ready, items.0.status,
              {' components[?(@.name=="Embeddings")].status'}
            </small>
          </label>
          <label>
            Expected JSON value
            <input
              disabled={!input.jsonPath}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder='true or "ok"'
            />
          </label>
        </div>
        <label className="health-headers">
          Secret headers (JSON object)
          <textarea
            autoComplete="off"
            spellCheck={false}
            disabled={clearHeaders}
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            placeholder={'{"Authorization": "Bearer …"}'}
          />
        </label>
        <p className="health-footnote">
          {probe?.hasHeaders
            ? "Secret headers are saved. Leave this blank to keep them; entering headers replaces all saved headers."
            : "Optional request headers are stored securely and never shown again."}
        </p>
        {probe?.hasHeaders && (
          <label className="health-checkbox">
            <input
              type="checkbox"
              checked={clearHeaders}
              onChange={(e) => setClearHeaders(e.target.checked)}
            />
            Remove all saved headers
          </label>
        )}
        <label className="health-checkbox">
          <input
            type="checkbox"
            checked={input.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
          />
          Enable scheduled checks
        </label>
      </fieldset>
      <div className="health-actions">
        <button className="button secondary" disabled={busy}>
          {busy ? "Saving…" : "Save probe"}
        </button>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
