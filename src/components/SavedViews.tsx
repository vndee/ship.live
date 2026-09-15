import { useEffect, useRef, useState } from "react";
import { Bookmark, Plus } from "lucide-react";
import {
  normalizeSavedView,
  savedViewPeriodLabel,
  type SavedView,
} from "../../shared/saved-views";
import { Modal } from "./Modal";
import "./saved-views.css";
export function SavedViews({
  csrfToken,
  scopeKey,
  currentHref,
  onOpen,
}: {
  csrfToken: string;
  scopeKey: string;
  currentHref: string;
  onOpen: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button secondary" onClick={() => setOpen(true)}>
        <Bookmark size={15} /> Saved views
      </button>
      {open && (
        <Modal title="Saved views" onClose={() => setOpen(false)}>
          <SavedViewsDialog
            key={scopeKey}
            csrfToken={csrfToken}
            currentHref={currentHref}
            onOpen={(href) => {
              setOpen(false);
              onOpen(href);
            }}
          />
        </Modal>
      )}
    </>
  );
}
function SavedViewsDialog({
  csrfToken,
  currentHref,
  onOpen,
}: {
  csrfToken: string;
  currentHref: string;
  onOpen: (href: string) => void;
}) {
  const [views, setViews] = useState<SavedView[] | null>(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [newName, setNewName] = useState("");
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  async function call<T>(
    path = "",
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`/api/saved-views${path}`, {
      method,
      credentials: "same-origin",
      signal: active.current?.signal,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not load saved views.");
    return data as T;
  }
  async function load() {
    const version = ++requestVersion.current;
    setError("");
    setViews(null);
    try {
      const data = await call<{ views: SavedView[] }>();
      if (mounted.current && version === requestVersion.current)
        setViews(data.views);
    } catch (e) {
      if (mounted.current && version === requestVersion.current)
        setError(
          e instanceof Error ? e.message : "Could not load saved views.",
        );
    }
  }
  useEffect(() => {
    mounted.current = true;
    active.current = new AbortController();
    void load();
    return () => {
      mounted.current = false;
      requestVersion.current++;
      active.current?.abort();
    };
  }, []);
  async function mutate(action: () => Promise<unknown>) {
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    try {
      await action();
      if (!mounted.current || version !== requestVersion.current) return;
      const data = await call<{ views: SavedView[] }>();
      if (mounted.current && version === requestVersion.current) {
        setViews(data.views);
        setEditing(null);
      }
    } catch (e) {
      if (mounted.current && version === requestVersion.current) {
        setError(e instanceof Error ? e.message : "Could not save this view.");
        setViews(null);
      }
    } finally {
      if (mounted.current && version === requestVersion.current) setBusy(false);
    }
  }
  return (
    <div className="saved-views-panel">
      <p className="saved-views-intro">
        Private to your account, available across browsers. Rolling periods stay
        current; custom dates stay fixed.
      </p>
      <form
        className="saved-view-create"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(async () => {
            const input = normalizeSavedView({ name, href: currentHref });
            await call("", "POST", input);
            if (mounted.current) setName("");
          });
        }}
      >
        <label>
          View name
          <input
            required
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Review morning"
          />
        </label>
        <button className="button primary" disabled={busy || !name.trim()}>
          <Plus size={15} /> Save current view
        </button>
      </form>
      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}
      {!views && !error ? (
        <p role="status">Loading saved views…</p>
      ) : views && !views.length ? (
        <p className="saved-views-empty">No saved views yet.</p>
      ) : (
        <ul className="saved-view-list">
          {views?.map((view) => (
            <li key={view.id}>
              {editing === view.id ? (
                <form
                  className="saved-view-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(() =>
                      call(`/${view.id}`, "PATCH", { name: newName }),
                    );
                  }}
                >
                  <label>
                    New view name
                    <input
                      value={newName}
                      maxLength={60}
                      required
                      onChange={(event) => setNewName(event.target.value)}
                    />
                  </label>
                  <button
                    className="button secondary"
                    disabled={busy || !newName.trim()}
                  >
                    Save name
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <a
                    className="saved-view-name"
                    href={view.href}
                    onClick={(event) => {
                      if (
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        !event.altKey &&
                        event.button === 0
                      ) {
                        event.preventDefault();
                        onOpen(view.href);
                      }
                    }}
                  >
                    {view.name}
                  </a>
                  <small>{savedViewPeriodLabel(view.href)}</small>
                  <div className="saved-view-actions">
                    <button
                      className="text-button"
                      disabled={busy}
                      aria-label={`Rename ${view.name}`}
                      onClick={() => {
                        setEditing(view.id);
                        setNewName(view.name);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      aria-label={`Update ${view.name} to current view`}
                      onClick={() =>
                        void mutate(() =>
                          call(
                            `/${view.id}`,
                            "PATCH",
                            normalizeSavedView({
                              name: view.name,
                              href: currentHref,
                            }),
                          ),
                        )
                      }
                    >
                      Use current view
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      aria-label={`Delete ${view.name}`}
                      onClick={() =>
                        void mutate(() => call(`/${view.id}`, "DELETE"))
                      }
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
