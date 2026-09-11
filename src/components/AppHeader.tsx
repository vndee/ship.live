import {
  ChevronDown,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Settings2,
} from "lucide-react";
import type { FeedController } from "../hooks/useFeed";
import type { Page } from "../lib/routes";
import { BrandMark } from "./BrandMark";
import { RouteLink } from "./RouteLink";
import { ThemeToggle } from "./ThemeToggle";

// Pages with their own status. Every other page is part of Pulse.
const OWN_PAGES = new Set<Page>(["health", "webhooks"]);

export function AppHeader({
  feed,
  page,
  status,
  wall,
  onConnect,
  onSettings,
  onToggleWall,
}: {
  feed: FeedController;
  page: Page;
  status: string;
  wall: boolean;
  onConnect: () => void;
  onSettings: () => void;
  onToggleWall: () => void;
}) {
  // Teams, and a journal's owner, have every page.
  const team =
    !feed.demo &&
    Boolean(
      feed.workspace &&
      (feed.workspace.kind === "team" || feed.workspace.owner),
    );
  const pages = (
    [
      ["pulse", "Pulse"],
      ["health", "Service Health"],
      ["webhooks", "Webhooks"],
    ] as const
  ).filter(
    ([id]) => id === "pulse" || (id === "health" ? feed.demo || team : team),
  );
  return (
    <header className="app-header">
      <RouteLink className="brand" to={{ page: "pulse" }}>
        <BrandMark />
        <span className="brand-name">
          ship<span>.live</span>
        </span>
      </RouteLink>
      <button className="organization-switch" onClick={onConnect}>
        {!feed.demo && <LockKeyhole size={12} />}
        <span>{feed.demo ? "Acme Team" : feed.organization}</span>
        <ChevronDown size={13} />
      </button>
      <nav aria-label="Main navigation">
        {pages.map(([id, label]) => (
          <RouteLink
            key={id}
            to={{ page: id }}
            // Pages opened from Pulse (feed, team, milestones) keep Pulse current.
            aria-current={
              (id === "pulse" ? !OWN_PAGES.has(page) : page === id)
                ? "page"
                : undefined
            }
          >
            {label}
          </RouteLink>
        ))}
      </nav>
      <div className="header-tools">
        {!OWN_PAGES.has(page) && status && (
          <span
            className={`connection-status ${feed.error ? "has-error" : ""}`}
          >
            <span />
            {status}
          </span>
        )}
        {!feed.session.user && (
          <button className="text-button sign-in-button" onClick={onConnect}>
            Sign in
          </button>
        )}
        <ThemeToggle />
        <button
          className="icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={onSettings}
        >
          <Settings2 size={17} />
        </button>
        <button
          className="icon-button"
          aria-label={wall ? "Exit wall display" : "Open wall display"}
          title={wall ? "Exit wall display" : "Open wall display"}
          onClick={onToggleWall}
        >
          {wall ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      </div>
    </header>
  );
}
