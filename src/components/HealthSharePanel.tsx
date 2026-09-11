import { useEffect, useRef, useState } from "react";
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
import { ExpirationPicker } from "./ExpirationPicker";

export function HealthSharePanel({
  workspaceId,
  csrfToken,
}: {
  workspaceId: string;
  csrfToken: string;
}) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/health/share`;
  const scope = useRef<AbortController | null>(null);
  const [share, setShare] = useState<DashboardShare | null>(null);
  const [link, setLink] = useState<CreatedDashboardShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [duration, setDuration] = useState(86400);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  async function request<T>(
    controller: AbortController,
    path = "",
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      headers: {
        "Content-Type": "application/json",
        ...(method === "GET" ? {} : { "x-csrf-token": csrfToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(
        data?.error || "Could not update your health share link.",
      );
    }
    return response.status === 204 ? (undefined as T) : response.json();
  }
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    setShare(null);
    setLink(null);
    setError("");
    setMessage("");
    setLoading(true);
    setBusy(false);
    void request<{ share: DashboardShare | null }>(controller)
      .then((result) => {
        if (!controller.signal.aborted) setShare(result.share);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Could not load your health link. Close this dialog and try again.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const clock = setInterval(() => setNow(Date.now()), 500);
    return () => {
      controller.abort();
      clearInterval(clock);
    };
  }, [base]);
  const expired = Boolean(share && Date.parse(share.expiresAt) <= now);
  const noExpiration = Boolean(
    share && !expired && isEffectivelyNoExpiration(share.expiresAt, now),
  );
  // A link just created, or the active link the server can show again.
  const token = link && share?.id === link.id ? link.token : share?.token;
  const url =
    token && !expired ? `${window.location.origin}/share/health#${token}` : "";
  async function change(action: "create" | "rotate" | "revoke") {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    setCopied(false);
    setLink(null);
    try {
      if (action === "revoke") {
        await request(controller, "", "DELETE");
        if (controller.signal.aborted) return;
        setShare(null);
        setMessage(
          "Link revoked. Viewers can no longer access service health.",
        );
      } else {
        const created = await request<CreatedDashboardShare>(
          controller,
          action === "rotate" ? "/rotate" : "",
          "POST",
          { expiresIn: duration },
        );
        if (controller.signal.aborted) return;
        setShare(created);
        setLink(created);
        setMessage(
          action === "rotate"
            ? "New link created. The previous health link no longer works."
            : "Your read-only service health link is ready.",
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error
          ? err.message
          : "Could not update your link. Try again.",
      );
      // A rotation may have committed even when its response was lost. Never restore an old token.
      try {
        const result = await request<{ share: DashboardShare | null }>(
          controller,
        );
        if (!controller.signal.aborted) setShare(result.share);
      } catch {
        if (!controller.signal.aborted) setShare(null);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function copy() {
    const controller = scope.current;
    try {
      await navigator.clipboard.writeText(url);
      if (controller && !controller.signal.aborted) setCopied(true);
    } catch {
      if (controller && !controller.signal.aborted)
        setError("Copy is unavailable. Select the link and copy it manually.");
    }
  }
  return (
    <div className="share-panel">
      <p className="modal-description">
        Anyone with this link can view live service health for the lifetime you
        choose.
      </p>
      <div className="share-scope">
        <ShieldCheck size={20} />
        <div>
          <strong>Read-only service health</strong>
          <p>
            Includes all current and future service and probe names, statuses,
            latency and recorded check history. Endpoint URLs, secret headers
            and check conditions stay private.
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
        <p className="field-hint">Loading your health link…</p>
      ) : (
        <>
          {share && (
            <div className="share-status">
              <span>
                <span className={`share-dot ${expired ? "expired" : ""}`} />
                {expired ? "Expired" : "Active health link"}
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
              Your health share link
              <div className="share-link-input">
                <input
                  aria-label="Service health share link"
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
              This link was created before links could be shown again. Rotate it
              once to get a link you can copy.
            </p>
          ) : null}
          <ExpirationPicker
            label={share && !expired ? "New link lifetime" : "Link lifetime"}
            ariaLabel="Health link expiration"
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
                <RefreshCw size={15} />
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
            Rotating immediately invalidates the previous health link. Dashboard
            share links are managed separately. Other members manage their own
            links.
          </p>
        </>
      )}
    </div>
  );
}
