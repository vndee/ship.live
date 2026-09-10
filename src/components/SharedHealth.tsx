import { LatencyChart } from "./LatencyChart";
import { ServiceStatusStrip } from "./ServiceStatusStrip";
import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  ChevronDown,
  Eye,
  Maximize2,
  Minimize2,
  RefreshCw,
  Unlink,
} from "lucide-react";
import type { HealthStatus, PublicHealthProbe } from "../../shared/health";
import { isEffectivelyNoExpiration } from "../../shared/shares";
import { useSharedHealth } from "../hooks/useSharedHealth";
import { aggregate } from "../lib/service-status-strip";
import "./service-health.css";
import { ThemeToggle } from "./ThemeToggle";

function statusOf(probe: PublicHealthProbe, now: number): HealthStatus {
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
function SharedHealthView({ token }: { token: string }) {
  const feed = useSharedHealth(token);
  const [now, setNow] = useState(Date.now());
  const [wall, setWall] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(
    null,
  );
  const previous = useRef<Map<string, HealthStatus> | null>(null);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 500);
    const fullscreen = () => setWall(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      clearInterval(clock);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, []);
  useEffect(() => {
    if (!feed.data) {
      previous.current = null;
      setAnnouncement("");
      return;
    }
    const next = new Map<string, HealthStatus>();
    const changes: string[] = [];
    for (const service of feed.data.services)
      for (const probe of service.probes) {
        const status = statusOf(probe, Date.now());
        next.set(probe.id, status);
        const before = previous.current?.get(probe.id);
        if (
          before &&
          before !== status &&
          (status === "down" ||
            (status === "healthy" &&
              (before === "down" || before === "degraded")))
        )
          changes.push(
            `${service.name} / ${probe.name} is ${status === "healthy" ? "healthy again" : "down"}.`,
          );
      }
    previous.current = next;
    if (changes.length) setAnnouncement(changes.join(" "));
  }, [feed.data]);
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(""), 12000);
    return () => clearTimeout(timer);
  }, [announcement]);
  async function toggleWall() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setWall((value) => !value);
    }
  }
  return (
    <div
      className={`app-shell shared-dashboard shared-health ${wall ? "wall-mode" : ""}`}
    >
      <header className="app-header">
        <a className="brand" href="/">
          ship<span>.</span>live
        </a>
        <span className="shared-workspace">
          {feed.data?.organization || "Shared service health"}
        </span>
        <div className="header-tools">
          <ThemeToggle />
          <span className="read-only-badge">
            <Eye size={13} /> Read only
          </span>
          <button
            className="icon-button"
            onClick={() => void toggleWall()}
            aria-label={wall ? "Exit wall display" : "Open wall display"}
          >
            {wall ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="date-line">
              {new Date(now).toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
            <h1>Service Health</h1>
          </div>
          {feed.data && (
            <span className="share-expiry-badge">
              <Clock3 size={14} />
              {isEffectivelyNoExpiration(feed.data.expiresAt, now)
                ? "No expiration"
                : `Expires ${new Date(feed.data.expiresAt).toLocaleString()}`}
            </span>
          )}
        </div>
        {!feed.data ? (
          <div
            className="shared-unavailable"
            role={feed.error ? "alert" : "status"}
          >
            {feed.loading ? (
              <RefreshCw size={28} className="spin" />
            ) : (
              <Unlink size={28} />
            )}
            <h2>
              {feed.loading
                ? "Opening service health…"
                : "Service health unavailable"}
            </h2>
            <p>{feed.error || "Checking this share link."}</p>
            {!feed.loading && (
              <button className="button secondary" onClick={feed.retry}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <section
            aria-label="Shared service health"
            className="health-public-services"
          >
            <div className="section-heading">
              <h2>
                {feed.data.services.length}{" "}
                {feed.data.services.length === 1 ? "service" : "services"}
              </h2>
              <span className="period-note">
                {feed.connected ? "Live updates" : "Reconnecting"}
              </span>
            </div>
            <div aria-live="polite" role="status">
              {announcement && <p className="health-change">{announcement}</p>}
            </div>
            {!feed.data.services.length && (
              <div className="health-empty">
                <h3>No services configured</h3>
                <p>Services will appear when the team adds them.</p>
              </div>
            )}
            {feed.data.services.map((service) => {
              const statuses = service.probes.map((probe) =>
                statusOf(probe, now),
              );
              const status = aggregate(statuses);
              const expanded = expandedServiceId === service.id;
              return (
                <article
                  className={`health-service ${expanded ? "is-expanded" : ""}`}
                  key={service.id}
                >
                  <div className="health-service-heading">
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
                      <ServiceStatusStrip probes={service.probes} />
                    </button>
                  </div>
                  {expanded && (
                    <div className="health-service-details">
                      {!service.probes.length && (
                        <p className="health-empty">No probes configured.</p>
                      )}
                      {service.probes.map((probe) => (
                        <div className="health-probe" key={probe.id}>
                          <div className="health-probe-top">
                            <strong>{probe.name}</strong>
                            <Badge status={statusOf(probe, now)} />
                          </div>
                          <div className="health-metrics">
                            <span>
                              Latency
                              <strong>
                                {probe.lastCheck
                                  ? `${Math.round(probe.lastCheck.latencyMs)} ms`
                                  : "—"}
                              </strong>
                            </span>
                            <span>
                              Last check
                              <strong>
                                {probe.lastCheck ? (
                                  <time dateTime={probe.lastCheck.checkedAt}>
                                    {new Date(
                                      probe.lastCheck.checkedAt,
                                    ).toLocaleString()}
                                  </time>
                                ) : (
                                  "Never"
                                )}
                              </strong>
                            </span>
                            <span>
                              Check success · 24h
                              <strong>
                                {probe.successRate24h === null
                                  ? "—"
                                  : `${probe.successRate24h.toFixed(1)}%`}{" "}
                                <small>({probe.checks24h} checks)</small>
                              </strong>
                            </span>
                          </div>
                          {statusOf(probe, now) === "unknown" && (
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
                                    check.status !== history[index - 1].status,
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
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
            <p className="health-footnote">
              Check success is the percentage of recorded checks that passed in
              the last 24 hours. Missing checks do not count as successes.
              Recent checks run from oldest to newest.
            </p>
          </section>
        )}
        <footer className="app-footer">
          <span>Shared service health · Read only</span>
          <span>
            Access ends when this link is revoked or its lifetime ends.
          </span>
        </footer>
      </main>
    </div>
  );
}
export function SharedHealth() {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const changed = () => setToken(window.location.hash.slice(1));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return <SharedHealthView key={token} token={token} />;
}
