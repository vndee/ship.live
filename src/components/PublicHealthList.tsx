import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { HealthStatus, PublicHealthProbe } from "../../shared/health";
import { aggregate } from "../lib/service-status-strip";
import { serviceStats } from "../lib/service-stats";
import { HealthServiceStats, HealthStatsInfo } from "./HealthServiceStats";
import { LatencyChart } from "./LatencyChart";
import { ServiceStatusStrip } from "./ServiceStatusStrip";
import { UptimeStrip } from "./UptimeStrip";
import { formatUptime, uptimeDays } from "../lib/uptime";
import "./service-health.css";

export function publicProbeStatus(
  probe: PublicHealthProbe,
  now: number,
): HealthStatus {
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

/** Read-only service rows, used by shared links and the signed-out demo. */
export function PublicHealthList({
  services,
  now,
}: {
  services: { id: string; name: string; probes: PublicHealthProbe[] }[];
  now: number;
}) {
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(
    null,
  );
  return (
    <>
      {!services.length && (
        <div className="health-empty">
          <h3>No services configured</h3>
          <p>Services will appear when the team adds them.</p>
        </div>
      )}
      {services.map((service) => {
        const status = aggregate(
          service.probes.map((probe) => publicProbeStatus(probe, now)),
        );
        const stats = serviceStats(service.probes);
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
                <span className="health-service-name">{service.name}</span>
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
              <div className="health-service-details">
                <UptimeStrip days={uptimeDays(service.probes, now)} />
                {!service.probes.length && (
                  <p className="health-empty">No probes configured.</p>
                )}
                {service.probes.map((probe) => (
                  <div className="health-probe" key={probe.id}>
                    <div className="health-probe-top">
                      <strong>{probe.name}</strong>
                      <Badge status={publicProbeStatus(probe, now)} />
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
                            : formatUptime(probe.successRate24h)}{" "}
                          <small>({probe.checks24h} checks)</small>
                        </strong>
                      </span>
                    </div>
                    {publicProbeStatus(probe, now) === "unknown" && (
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
                          .map((check) => (check.ok ? "passed" : "failed"))
                          .join(", ") || "no checks"
                      }`}
                    >
                      {probe.history
                        .slice(0, 40)
                        .reverse()
                        .map((check, index) => (
                          <span
                            key={`${check.checkedAt}-${index}`}
                            className={check.ok ? "health-pass" : "health-fail"}
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
                                {new Date(check.checkedAt).toLocaleString()}
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
    </>
  );
}
