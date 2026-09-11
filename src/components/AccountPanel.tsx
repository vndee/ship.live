import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Github,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Users,
} from "lucide-react";
import type { InstallationChoice, Workspace } from "../../shared/workspaces";
import type { FeedController } from "../hooks/useFeed";

function installationUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/apps/")
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Names a workspace; GitHub's name for it stays as its secondary identity. */
function WorkspaceRename({
  workspace,
  onSave,
  onCancel,
}: {
  workspace: Workspace;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const fallback = workspace.defaultName ?? workspace.name;
  const [value, setValue] = useState(
    workspace.defaultName ? workspace.name : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(name: string) {
    setBusy(true);
    setError("");
    try {
      await onSave(name);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not rename the workspace. Try again.",
      );
      setBusy(false);
    }
  }
  return (
    <form
      className="workspace-rename-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(value.trim());
      }}
    >
      <label>
        {workspace.kind === "personal" ? "Journal name" : "Team name"}
        <input
          aria-label="Workspace name"
          autoFocus
          value={value}
          maxLength={80}
          placeholder={fallback}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <small className="field-hint">
        {workspace.kind === "team"
          ? `Everyone in this team sees it. On GitHub it stays ${workspace.githubAccount ?? fallback}.`
          : "Only you see it."}{" "}
        Leave it empty to use “{fallback}”.
      </small>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="workspace-rename-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function AccountPanel({
  feed,
  onClose,
}: {
  feed: FeedController;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<InstallationChoice[]>([]);
  const [installUrl, setInstallUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const connectedIds = feed.workspaces.flatMap((workspace) =>
    workspace.installationId ? [workspace.installationId] : [],
  );
  const connectedKey = [...connectedIds].sort((a, b) => a - b).join(",");
  // Ticked installations; saved changes reset them to what is connected.
  const [picked, setPicked] = useState(() => new Set(connectedIds));
  useEffect(
    () => setPicked(new Set(connectedIds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectedKey],
  );
  const toConnect = choices
    .filter(
      (choice) => picked.has(choice.id) && !connectedIds.includes(choice.id),
    )
    .map((choice) => choice.id);
  const toLeave = choices.filter(
    (choice) => !picked.has(choice.id) && connectedIds.includes(choice.id),
  );
  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function loadInstallations() {
    setBusy("Refreshing GitHub access…");
    setError("");
    try {
      const result = await feed.refreshInstallations();
      setChoices(result.installations);
      setInstallUrl(installationUrl(result.installUrl) || "");
      setLoaded(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load GitHub installations.",
      );
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    if (!feed.session.user || !feed.githubConnected) return;
    let canceled = false;
    setBusy("Loading GitHub installations…");
    void feed
      .installations()
      .then((result) => {
        if (canceled) return;
        setChoices(result.installations);
        setInstallUrl(installationUrl(result.installUrl) || "");
        setLoaded(true);
      })
      .catch((failure: unknown) => {
        if (!canceled)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load GitHub installations.",
          );
      })
      .finally(() => {
        if (!canceled) setBusy("");
      });
    return () => {
      canceled = true;
    };
    // Fetch for this account/connection, not for each live feed render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.session.user?.id, feed.githubConnected]);

  async function act(
    label: string,
    action: () => Promise<unknown>,
    close = false,
  ) {
    setBusy(label);
    setError("");
    try {
      await action();
      if (close) onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not complete this request.",
      );
    } finally {
      setBusy("");
    }
  }
  const user = feed.session.user;
  const operationPending = feed.operation?.status === "pending";
  function saveConnections() {
    if (
      toLeave.length &&
      !window.confirm(
        `Leave ${toLeave.map((choice) => choice.account).join(", ")}? Its activity stays with the team, and you can connect it again at any time.`,
      )
    )
      return;
    void act(
      toConnect.length
        ? "Connecting and importing recent activity…"
        : "Saving connections…",
      () =>
        feed.saveConnections(
          toConnect,
          toLeave.map((choice) => choice.id),
        ),
    );
  }
  return (
    <>
      {feed.sessionError && (
        <p className="form-error" role="alert">
          {feed.sessionError}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {feed.sessionLoading ? (
        <p className="modal-description">
          <LoaderCircle size={15} className="spin" /> Checking your session…
        </p>
      ) : !user ? (
        <>
          <p className="modal-description">
            A private record of what you build. Bring in your GitHub activity
            and add the story behind each ship.
          </p>
          <div className="oauth-buttons">
            <a
              className={`button full-width ${!feed.session.providers.google ? "disabled-link" : ""}`}
              href={
                feed.session.providers.google
                  ? "/api/auth/google/start"
                  : undefined
              }
              aria-disabled={!feed.session.providers.google}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.4ZM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22ZM6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6ZM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6C7.2 7.8 9.4 6 12 6Z"
                />
              </svg>
              Continue with Google
            </a>
            <a
              className={`button full-width ${!feed.session.providers.github ? "disabled-link" : ""}`}
              href={
                feed.session.providers.github
                  ? "/api/auth/github/start"
                  : undefined
              }
              aria-disabled={!feed.session.providers.github}
            >
              <Github size={16} /> Continue with GitHub
            </a>
          </div>
          {(!feed.session.configured ||
            (!feed.session.providers.google &&
              !feed.session.providers.github)) && (
            <p className="field-hint">
              Sign-in has not been enabled on this instance yet. The demo is
              available without an account.
            </p>
          )}
          <p className="privacy-note">
            <LockKeyhole size={14} /> Your journal is private. Signing in does
            not grant access to your repositories.
          </p>
          {feed.logoutIncomplete && (
            <button
              className="button secondary full-width"
              onClick={() => void act("Signing out…", feed.logout)}
            >
              Retry sign-out
            </button>
          )}
        </>
      ) : (
        <>
          <div className="account-identity">
            <span className="avatar">
              {user.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>Signed in</small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              disabled={Boolean(busy) || operationPending}
              onClick={() => void act("Signing out…", feed.logout, true)}
            >
              <LogOut size={17} />
            </button>
          </div>
          <section className="settings-section">
            <h3>Your workspaces</h3>
            <div className="workspace-choices">
              {feed.workspaces.map((workspace) =>
                renaming === workspace.id ? (
                  <WorkspaceRename
                    key={workspace.id}
                    workspace={workspace}
                    onCancel={() => setRenaming(null)}
                    onSave={async (name) => {
                      await feed.renameWorkspace(workspace.id, name);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <div className="workspace-row" key={workspace.id}>
                    <button
                      className="workspace-choice"
                      disabled={operationPending}
                      onClick={() => {
                        feed.selectWorkspace(workspace);
                        onClose();
                      }}
                    >
                      {workspace.kind === "personal" ? (
                        <BookOpen size={18} />
                      ) : (
                        <Users size={18} />
                      )}
                      <span>
                        <strong>{workspace.name}</strong>
                        <small>
                          {/* GitHub's name stays visible once it is renamed. */}
                          {workspace.githubAccount &&
                            workspace.githubAccount !== workspace.name && (
                              <span className="workspace-github">
                                <Github size={11} aria-hidden="true" />
                                {workspace.githubAccount} ·{" "}
                              </span>
                            )}
                          {workspace.kind === "personal"
                            ? "Personal journal · only you"
                            : "Team · members with repository access"}
                        </small>
                      </span>
                      {workspace.id === feed.workspace?.id ? (
                        <Check size={15} />
                      ) : (
                        <LockKeyhole size={13} />
                      )}
                    </button>
                    <button
                      className="icon-button workspace-rename"
                      aria-label={`Rename ${workspace.name}`}
                      title="Rename"
                      disabled={operationPending}
                      onClick={() => setRenaming(workspace.id)}
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                ),
              )}
              {!feed.workspaces.length && (
                <p className="field-hint">
                  Your journal is being prepared.{" "}
                  <button
                    className="text-button"
                    onClick={() => void feed.loadWorkspaces()}
                  >
                    Refresh workspaces
                  </button>
                </p>
              )}
            </div>
          </section>
          <section className="settings-section">
            <h3>GitHub activity</h3>
            <p>
              Connect your GitHub account, then choose a GitHub App
              installation. You decide which repositories it can read on GitHub.
            </p>
            {!feed.githubAppConfigured ? (
              <p className="field-hint">
                The GitHub App has not been configured on this instance. You can
                still keep your personal ship journal.
              </p>
            ) : !feed.githubConnected ? (
              <button
                className="button primary"
                disabled={Boolean(busy) || operationPending}
                onClick={() => void act("Opening GitHub…", feed.connectGithub)}
              >
                <Github size={15} /> Connect GitHub
              </button>
            ) : (
              <>
                {choices.length > 0 && (
                  <p className="field-hint">
                    Tick the accounts and organizations to connect. Unticking
                    one leaves it; its team keeps its activity, and you can tick
                    it again at any time.
                  </p>
                )}
                <div className="installation-list">
                  {choices.map((choice) => {
                    const connected = feed.workspaces.find(
                      (workspace) => workspace.installationId === choice.id,
                    );
                    return (
                      <div className="installation-choice" key={choice.id}>
                        <label className="installation-pick">
                          <input
                            type="checkbox"
                            aria-label={`Connect ${choice.account}`}
                            checked={picked.has(choice.id)}
                            disabled={
                              Boolean(busy) ||
                              operationPending ||
                              !choice.connectable
                            }
                            onChange={() => toggle(choice.id)}
                          />
                          {choice.kind === "Organization" ? (
                            <Users size={16} />
                          ) : (
                            <Github size={16} />
                          )}
                          <span>
                            <strong>{choice.account}</strong>
                            <small>
                              {choice.kind === "Organization"
                                ? "Organization"
                                : "Personal account"}{" "}
                              · {choice.repositories.length}{" "}
                              {choice.repositories.length === 1
                                ? "repository"
                                : "repositories"}
                              {choice.connectable
                                ? ""
                                : " · only its owner can connect it"}
                            </small>
                          </span>
                        </label>
                        {connected && (
                          <button
                            className="text-button"
                            disabled={Boolean(busy) || operationPending}
                            onClick={() => {
                              feed.selectWorkspace(connected);
                              onClose();
                            }}
                          >
                            Open
                          </button>
                        )}
                        {choice.repositories.length > 0 && (
                          <details>
                            <summary>Repository access</summary>
                            <ul>
                              {choice.repositories.map((repository) => (
                                <li key={repository.id}>
                                  <span>{repository.name}</span>
                                  <small>
                                    {repository.private ? "Private" : "Public"}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
                {choices.length > 0 && (
                  <div className="connection-save">
                    <button
                      className="button primary"
                      disabled={
                        Boolean(busy) ||
                        operationPending ||
                        !(toConnect.length || toLeave.length)
                      }
                      onClick={saveConnections}
                    >
                      Save connections
                    </button>
                    <small>
                      {toConnect.length || toLeave.length
                        ? [
                            toConnect.length &&
                              `${toConnect.length} to connect`,
                            toLeave.length && `${toLeave.length} to leave`,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "No changes"}
                    </small>
                  </div>
                )}
                {loaded && !choices.length && (
                  <p className="field-hint">
                    No accessible installations yet. Install the app on your
                    personal account or organization, then refresh this list.
                  </p>
                )}
                <div className="connection-actions">
                  {installUrl && (
                    <a
                      className="button secondary"
                      href={installUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Plus size={14} /> Install GitHub App{" "}
                      <ArrowUpRight size={13} />
                    </a>
                  )}
                  <button
                    className="text-button"
                    disabled={Boolean(busy) || operationPending}
                    onClick={() => void loadInstallations()}
                  >
                    <RefreshCw size={13} /> Refresh
                  </button>
                </div>
                <button
                  className="text-button danger-button"
                  disabled={Boolean(busy) || operationPending}
                  onClick={() =>
                    void act(
                      "Disconnecting GitHub…",
                      feed.disconnectGithub,
                      true,
                    )
                  }
                >
                  Disconnect GitHub
                </button>
                <p className="field-hint">
                  Disconnecting hides GitHub activity here. Your manual ship
                  notes stay in your personal journal. To stop webhook delivery,
                  uninstall the App in GitHub.
                </p>
              </>
            )}
          </section>
        </>
      )}
      {busy && (
        <p className="operation-status" role="status">
          <LoaderCircle size={14} className="spin" />
          {busy}
        </p>
      )}
      <button
        className="text-button demo-link"
        onClick={() => {
          feed.useDemo();
          onClose();
        }}
      >
        Explore fictional demo activity <ArrowUpRight size={14} />
      </button>
    </>
  );
}
