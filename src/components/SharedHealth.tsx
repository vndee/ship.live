import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  Eye,
  Maximize2,
  Minimize2,
  RefreshCw,
  Unlink,
} from "lucide-react";
import type { HealthStatus } from "../../shared/health";
import { isEffectivelyNoExpiration } from "../../shared/shares";
import { useSharedHealth } from "../hooks/useSharedHealth";
import { PublicHealthList, publicProbeStatus } from "./PublicHealthList";
import "./service-health.css";
import { ThemeToggle } from "./ThemeToggle";
import { BrandMark } from "./BrandMark";

function SharedHealthView({ token }: { token: string }) {
  const feed = useSharedHealth(token);
  const [now, setNow] = useState(Date.now());
  const [wall, setWall] = useState(false);
  const [announcement, setAnnouncement] = useState("");
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
        const status = publicProbeStatus(probe, Date.now());
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
          <BrandMark />
          <span className="brand-name">
            ship<span>.live</span>
          </span>
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
            <PublicHealthList services={feed.data.services} now={now} />
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
