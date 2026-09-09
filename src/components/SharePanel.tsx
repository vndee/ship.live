import { useEffect, useState } from "react";
import {
  Check,
  Clock3,
  Copy,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import {
  isEffectivelyNoExpiration,
  type CreatedDashboardShare,
  type DashboardShare,
} from "../../shared/shares";
import type { FeedController } from "../hooks/useFeed";
import { ExpirationPicker } from "./ExpirationPicker";

export function SharePanel({
  feed,
  link,
  onLink,
}: {
  feed: FeedController;
  link: CreatedDashboardShare | null;
  onLink: (link: CreatedDashboardShare | null) => void;
}) {
  const [share, setShare] = useState<DashboardShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [duration, setDuration] = useState(86400);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    feed
      .readShare()
      .then(({ share }) => {
        if (active) setShare(share);
      })
      .catch(() => {
        if (active)
          setError(
            "Could not load your share link. Close this dialog and try again.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearInterval(clock);
    };
  }, []);
  const expired = share && Date.parse(share.expiresAt) <= now;
  const noExpiration = Boolean(
    share && !expired && isEffectivelyNoExpiration(share.expiresAt, now),
  );
  const url =
    link && share?.id === link.id && !expired
      ? `${window.location.origin}/share#${link.token}`
      : "";
  async function change(action: "create" | "rotate" | "revoke") {
    setBusy(true);
    setError("");
    setMessage("");
    setCopied(false);
    onLink(null);
    try {
      if (action === "revoke") {
        await feed.revokeShare();
        setShare(null);
        setMessage(
          "Link revoked. Viewers can no longer access this dashboard.",
        );
      } else {
        const created = await feed.createShare(duration, action === "rotate");
        setShare(created);
        onLink(created);
        setMessage(
          action === "rotate"
            ? "New link created. The previous link no longer works."
            : "Your read-only dashboard link is ready.",
        );
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not update your link. Try again.",
      );
      // An ambiguous response can follow a committed rotation: never offer the old token.
      try {
        setShare((await feed.readShare()).share);
      } catch {
        setShare(null);
      }
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Copy is unavailable. Select the link and copy it manually.");
    }
  }
  return (
    <div className="share-panel">
      <p className="modal-description">
        Give your team a live view of the work. Anyone with this link can view
        this dashboard for the lifetime you choose.
      </p>
      <div className="share-scope">
        <ShieldCheck size={20} />
        <div>
          <strong>Read-only team dashboard</strong>
          <p>
            Includes contributor names, XP and GitHub activity from repositories
            you can access. Personal journal notes are always private.
          </p>
        </div>
      </div>
      {error && (
        <p className="notice error-notice" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="share-message" role="status">
          <Check size={15} />
          {message}
        </p>
      )}
      {loading ? (
        <p className="field-hint">Loading your link…</p>
      ) : (
        <>
          {share && (
            <div className="share-status">
              <span>
                <span className={`share-dot ${expired ? "expired" : ""}`} />
                {expired ? "Expired" : "Active link"}
              </span>
              <span>
                {share.repositoryCount}{" "}
                {share.repositoryCount === 1 ? "repository" : "repositories"}
              </span>
              <p>
                <Clock3 size={13} />
                {expired
                  ? `Expired ${new Date(share.expiresAt).toLocaleString()}`
                  : noExpiration
                    ? "No expiration"
                    : `Expires ${new Date(share.expiresAt).toLocaleString()}`}
              </p>
            </div>
          )}
          {url ? (
            <label className="share-link-label">
              Your share link
              <div className="share-link-input">
                <input
                  aria-label="Dashboard share link"
                  readOnly
                  value={url}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="button secondary"
                  onClick={() => void copy()}
                  disabled={busy}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </label>
          ) : share && !expired ? (
            <p className="field-hint">
              The link’s secret is only shown when it is created. Rotate to get
              a new link to copy.
            </p>
          ) : null}
          <ExpirationPicker
            label={share && !expired ? "New link lifetime" : "Link lifetime"}
            ariaLabel="Link expiration"
            value={duration}
            disabled={busy}
            onChange={setDuration}
          />
          <div className="share-actions">
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void change(share && !expired ? "rotate" : "create")
              }
            >
              {share && !expired ? (
                <RefreshCw size={15} className={busy ? "spin" : ""} />
              ) : (
                <Link2 size={15} />
              )}
              {busy
                ? "Updating…"
                : share && !expired
                  ? "Rotate link"
                  : "Create share link"}
            </button>
            {share && (
              <button
                className="text-button revoke-link"
                disabled={busy}
                onClick={() => void change("revoke")}
              >
                <Unlink size={14} /> Revoke link
              </button>
            )}
          </div>
          <p className="field-hint">
            Rotating invalidates your previous link immediately and starts a new
            expiration. Other members manage their own links.
          </p>
        </>
      )}
    </div>
  );
}
