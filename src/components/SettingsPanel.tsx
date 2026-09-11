import { Maximize2, RefreshCw } from "lucide-react";
import type { FeedController } from "../hooks/useFeed";

export function SettingsPanel({
  feed,
  personal,
  syncing,
  onSync,
  onConnect,
  celebrations,
  onCelebrations,
  moving,
  onMoving,
  wall,
  onToggleWall,
}: {
  feed: FeedController;
  personal: boolean;
  syncing: boolean;
  onSync: () => void;
  onConnect: () => void;
  celebrations: boolean;
  onCelebrations: (enabled: boolean) => void;
  moving: boolean;
  onMoving: (enabled: boolean) => void;
  wall: boolean;
  onToggleWall: () => void;
}) {
  return (
    <>
      <section className="settings-section">
        <h3>{feed.session.user ? feed.session.user.name : "Your account"}</h3>
        <p>
          {feed.demo
            ? "You’re exploring fictional sample activity."
            : personal
              ? "Your journal is private and visible only to you."
              : `Viewing ${feed.organization}. Repository access is checked for your account.`}
        </p>
        <button className="button primary" onClick={onConnect}>
          {feed.session.user ? "Account and GitHub connections" : "Sign in"}
        </button>
        {!feed.demo && feed.githubConnected && (
          <>
            <button className="text-button" disabled={syncing} onClick={onSync}>
              <RefreshCw size={14} className={syncing ? "spin" : ""} />
              {syncing ? "Syncing in the background…" : "Sync GitHub activity"}
            </button>
            <p className="field-hint">
              New activity arrives automatically. Sync re-reads your repository
              access, which spends your GitHub API quota shared with your other
              GitHub tools, and imports recent history. Use it after changing
              access in GitHub or if activity looks missing; repeat syncs only
              fetch what changed since the last one.
            </p>
          </>
        )}
      </section>
      <section className="settings-section">
        <h3>Motion and live updates</h3>
        <label className="settings-toggle">
          <span>Highlight and celebrate new activity</span>
          <input
            type="checkbox"
            checked={celebrations}
            onChange={(e) => onCelebrations(e.target.checked)}
          />
        </label>
        <label className="settings-toggle">
          <span>Animate Pulse</span>
          <input
            type="checkbox"
            checked={moving}
            onChange={(e) => onMoving(e.target.checked)}
          />
        </label>
        <label className="settings-toggle">
          <span>Receive live updates</span>
          <input
            type="checkbox"
            checked={!feed.paused}
            onChange={(e) => feed.setPaused(!e.target.checked)}
          />
        </label>
        <button className="button secondary" onClick={onToggleWall}>
          <Maximize2 size={15} />
          {wall ? "Exit wall display" : "Open wall display"}
        </button>
      </section>
      <section className="settings-section">
        <h3>A journal for what you build</h3>
        <p>
          Keep a personal ship journal or follow your team’s work. GitHub
          connections use the repositories you choose in the GitHub App
          installation.
        </p>
        <span className="version">ship.live / 0.1.0</span>
      </section>
    </>
  );
}
