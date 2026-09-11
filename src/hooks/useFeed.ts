import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { resetRouteDetails } from "./useRoute";
import type { ActivityEvent, FeedResponse } from "../../shared/types";
import type { SessionResponse } from "../../shared/auth";
import type {
  CreatedDashboardShare,
  DashboardShare,
} from "../../shared/shares";
import type {
  InstallationChoice,
  PersonalSources,
  ShipNoteInput,
  SyncRun,
  Workspace,
  WorkspaceList,
} from "../../shared/workspaces";
import { createDemoEvents } from "../lib/demo";
import {
  chooseInitialWorkspace,
  readWorkspacePreference,
  saveWorkspacePreference,
} from "../lib/workspace-preference";
import {
  emptyPrivateFeed,
  isAccessFailure,
  privateFeedReducer,
} from "../lib/privateFeed";

import {
  emptyPrivateOperation,
  privateOperationReducer,
  type PrivateOperationTarget,
} from "../lib/privateOperation";

const signedOut: SessionResponse = {
  user: null,
  providers: { google: false, github: false },
  configured: false,
};
const noWorkspaces: WorkspaceList = {
  workspaces: [],
  githubConnected: false,
  githubAppConfigured: false,
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  options: RequestInit = {},
  timeout = 20_000,
): Promise<T> {
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      signal: options.signal || AbortSignal.timeout(timeout),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new ApiError(
        data.error || "Could not complete this request. Try again.",
        response.status,
      );
    return data as T;
  } catch (error) {
    // Browsers report an elapsed timeout as "signal timed out".
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new Error("The server took too long to respond. Try again.");
    throw error;
  }
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not complete this request. Try again.";
}

export function useFeed() {
  const [state, dispatch] = useReducer(privateFeedReducer, {
    ...emptyPrivateFeed,
    events: createDemoEvents(),
  });
  const [session, setSession] = useState<SessionResponse>(signedOut);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [workspaceList, setWorkspaceList] =
    useState<WorkspaceList>(noWorkspaces);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [paused, setPaused] = useState(false);
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [logoutIncomplete, setLogoutIncomplete] = useState(false);
  const [syncRun, setSyncRun] = useState<SyncRun | null>(null);
  const [operationState, dispatchOperation] = useReducer(
    privateOperationReducer,
    emptyPrivateOperation,
  );
  const operationSequence = useRef(0);
  const operationPending = useRef(false);
  const blocked = useRef(false);
  const pendingLogout = useRef(false);
  const logoutToken = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const requestNumber = useRef(0);
  const sessionRequest = useRef(0);
  const workspaceRequest = useRef(0);
  const latestWorkspaceLoad = useRef<Promise<WorkspaceList | undefined> | null>(
    null,
  );
  const identityRevision = useRef(0);
  const selectionRevision = useRef(0);
  const authorizedWorkspaces = useRef<Workspace[]>([]);
  const currentUser = useRef<string | null>(null);
  const currentWorkspace = useRef<Workspace | null>(null);
  const csrf = useRef<string | undefined>(undefined);
  const channel = useRef<BroadcastChannel | null>(null);
  const initialSelection = useRef(true);
  const demoSequence = useRef(0);
  const demo = !workspace;

  const clearPrivate = useCallback((error = "", sample = false) => {
    generation.current += 1;
    requestNumber.current += 1;
    dispatch({
      type: "reset",
      generation: generation.current,
      error,
      events: sample ? createDemoEvents() : [],
    });
  }, []);
  const applyWorkspace = useCallback(
    (next: Workspace | null) => {
      if (operationPending.current) return false;
      dispatchOperation({
        type: "reset",
        sequence: ++operationSequence.current,
      });
      currentWorkspace.current = next;
      setWorkspace(next);
      initialSelection.current = false;
      setPaused(false);
      blocked.current = false;
      setAccessBlocked(false);
      clearPrivate("", !next);
      return true;
    },
    [clearPrivate],
  );
  const selectWorkspace = useCallback(
    (next: Workspace | null) => {
      const user = currentUser.current;
      const authorized = next
        ? authorizedWorkspaces.current.find((item) => item.id === next.id)
        : null;
      if (next && (!user || !authorized)) return;
      if (!applyWorkspace(authorized ?? null)) return;
      // Filters and profiles in the URL belong to the previous workspace. The
      // first restore does not come through here, so a shared link survives it.
      resetRouteDetails();
      selectionRevision.current += 1;
      if (user && authorized)
        saveWorkspacePreference(user, authorized.id, (key, value) =>
          localStorage.setItem(key, value),
        );
    },
    [applyWorkspace],
  );
  const clearIdentity = useCallback(
    (error = "") => {
      operationPending.current = false;
      dispatchOperation({
        type: "reset",
        sequence: ++operationSequence.current,
      });
      workspaceRequest.current += 1;
      identityRevision.current += 1;
      latestWorkspaceLoad.current = null;
      authorizedWorkspaces.current = [];
      currentUser.current = null;
      csrf.current = undefined;
      currentWorkspace.current = null;
      initialSelection.current = true;
      setWorkspace(null);
      setWorkspaceList(noWorkspaces);
      setSession((previous) => ({
        ...previous,
        user: null,
        csrfToken: undefined,
      }));
      setSessionError(error);
      clearPrivate("", true);
    },
    [clearPrivate],
  );
  const failPrivate = useCallback((error: unknown) => {
    blocked.current = true;
    setAccessBlocked(true);
    generation.current += 1;
    requestNumber.current += 1;
    dispatch({
      type: "error",
      generation: generation.current,
      message: message(error),
    });
  }, []);
  // A transient failure (network, timeout, 5xx) hides cached private data but
  // does not block: polling and the live stream keep retrying, and the next
  // verified snapshot restores the feed. The generation stays the same, so the
  // refresh effect does not rerun into a tight retry loop.
  const hidePrivate = useCallback((error: unknown) => {
    dispatch({
      type: "error",
      generation: generation.current,
      message: message(error),
    });
  }, []);
  const accessFailure = useCallback(
    (error: unknown) => {
      if (!(error instanceof ApiError) || !isAccessFailure(error.status))
        return false;
      if (error.status === 401)
        clearIdentity("Your session ended. Sign in to continue.");
      else failPrivate(error);
      return true;
    },
    [clearIdentity, failPrivate],
  );

  const refreshWorkspaces = useCallback(async () => {
    const user = currentUser.current;
    if (!user) return;
    const serial = ++workspaceRequest.current;
    try {
      const data = await request<WorkspaceList>("/api/workspaces");
      if (currentUser.current !== user || serial !== workspaceRequest.current)
        return;
      setWorkspaceList(data);
      authorizedWorkspaces.current = data.workspaces;
      const active = currentWorkspace.current;
      if (active) {
        const replacement = data.workspaces.find(
          (item) => item.id === active.id,
        );
        if (!replacement) {
          const fallback = chooseInitialWorkspace(data.workspaces, null);
          if (applyWorkspace(fallback) && fallback)
            saveWorkspacePreference(user, fallback.id, (key, value) =>
              localStorage.setItem(key, value),
            );
        } else {
          currentWorkspace.current = replacement;
          setWorkspace(replacement);
        }
      } else if (initialSelection.current) {
        const preferred = readWorkspacePreference(user, (key) =>
          localStorage.getItem(key),
        );
        const next = chooseInitialWorkspace(data.workspaces, preferred);
        if (
          applyWorkspace(next) &&
          next &&
          preferred !== null &&
          preferred !== next.id
        )
          saveWorkspacePreference(user, next.id, (key, value) =>
            localStorage.setItem(key, value),
          );
      }
      return data;
    } catch (error) {
      if (currentUser.current !== user || serial !== workspaceRequest.current)
        return;
      if (!accessFailure(error)) setSessionError(message(error));
    }
  }, [accessFailure, applyWorkspace]);

  const loadWorkspaces = useCallback(() => {
    const pending = refreshWorkspaces();
    latestWorkspaceLoad.current = pending;
    return pending;
  }, [refreshWorkspaces]);

  const loadSession = useCallback(async () => {
    if (pendingLogout.current) return;
    const serial = ++sessionRequest.current;
    try {
      const data = await request<SessionResponse>("/api/session");
      if (serial !== sessionRequest.current) return;
      const nextUser = data.user?.id || null;
      if (currentUser.current !== nextUser) {
        clearIdentity();
        currentUser.current = nextUser;
      }
      csrf.current = data.csrfToken;
      setSession(data);
      setSessionError("");
      if (nextUser) await loadWorkspaces();
    } catch {
      if (serial === sessionRequest.current) {
        const error =
          "Sign-in is temporarily unavailable. You can still explore the demo.";
        if (currentUser.current) clearIdentity(error);
        else setSessionError(error);
      }
    } finally {
      if (serial === sessionRequest.current) setSessionLoading(false);
    }
  }, [clearIdentity, loadWorkspaces]);

  useEffect(() => {
    // Remove the old pre-authentication organization preference, never migrate it into identity.
    try {
      localStorage.removeItem("pulse.organization");
    } catch {
      /* Storage may be disabled. */
    }
    void loadSession();
    const interval = setInterval(() => void loadSession(), 30_000);
    const onFocus = () => void loadSession();
    const onHide = () => {
      if (currentUser.current) clearPrivate();
    };
    const onShow = () => void loadSession();
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    if (typeof BroadcastChannel !== "undefined") {
      const bc = new BroadcastChannel("ship-live-session");
      channel.current = bc;
      bc.onmessage = (event: MessageEvent<unknown>) => {
        if (
          event.data !== "session-clearing" &&
          event.data !== "session-changed"
        )
          return;
        sessionRequest.current += 1;
        pendingLogout.current = event.data === "session-clearing";
        clearIdentity();
        if (!pendingLogout.current) void loadSession();
      };
    }
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      channel.current?.close();
      channel.current = null;
      sessionRequest.current += 1;
      workspaceRequest.current += 1;
      identityRevision.current += 1;
      latestWorkspaceLoad.current = null;
    };
  }, [clearIdentity, clearPrivate, loadSession]);

  const refresh = useCallback(async () => {
    const active = currentWorkspace.current;
    if (!active || !currentUser.current || blocked.current) return;
    const current = generation.current;
    const serial = ++requestNumber.current;
    dispatch({ type: "loading", generation: current, value: true });
    try {
      const data = await request<FeedResponse>(
        `/api/workspaces/${encodeURIComponent(active.id)}/feed`,
      );
      if (serial !== requestNumber.current || current !== generation.current)
        return;
      dispatch({
        type: "snapshot",
        generation: current,
        events: data.events,
        updatedAt: data.updatedAt,
        notice: data.notice,
      });
    } catch (error) {
      if (serial !== requestNumber.current || current !== generation.current)
        return;
      if (!accessFailure(error))
        hidePrivate(
          new Error(
            "Activity could not be verified, so private data is hidden. Retrying automatically.",
          ),
        );
    }
  }, [accessFailure, hidePrivate]);

  useEffect(() => {
    if (demo || accessBlocked) return;
    void refresh();
    // Even with the live stream paused, revalidate the snapshot so revoked access disappears.
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [demo, workspace?.id, state.generation, paused, accessBlocked, refresh]);

  useEffect(() => {
    if (demo || paused || !workspace || accessBlocked) return;
    const controller = new AbortController();
    const current = generation.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => void refresh(), 100);
    };
    async function stream() {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspace!.id)}/events`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new ApiError(
            data.error || "Live activity is temporarily unavailable.",
            response.status,
          );
        }
        if (!response.body) throw new Error("Live activity is unavailable.");
        dispatch({ type: "streaming", generation: current, value: true });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const name = chunk
              .split("\n")
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim();
            if (name === "access-revoked") {
              clearPrivate("Access changed. Checking your workspace…");
              controller.abort();
              void loadSession();
              return;
            }
            if (name === "activity" || name === "refresh") scheduleRefresh();
            if (name === "wall")
              window.dispatchEvent(new Event("ship-live-wall"));
          }
        }
      } catch (error) {
        if (controller.signal.aborted || current !== generation.current) return;
        if (accessFailure(error)) return;
      }
      if (!controller.signal.aborted && current === generation.current) {
        dispatch({ type: "streaming", generation: current, value: false });
        void refresh();
        retry = setTimeout(() => void stream(), 10_000);
      }
    }
    void stream();
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearTimeout(pendingRefresh);
    };
  }, [
    demo,
    workspace?.id,
    state.generation,
    paused,
    accessBlocked,
    accessFailure,
    clearPrivate,
    loadSession,
    refresh,
  ]);

  const mutate = useCallback(
    async <T>(
      path: string,
      body?: unknown,
      method = "POST",
      timeout = 20_000,
    ): Promise<T> => {
      const user = currentUser.current;
      try {
        return await request<T>(
          path,
          {
            method,
            headers: {
              "x-csrf-token": csrf.current || "",
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          timeout,
        );
      } catch (error) {
        if (user === currentUser.current) accessFailure(error);
        throw error;
      }
    },
    [accessFailure],
  );
  async function logout() {
    const token = csrf.current || logoutToken.current;
    logoutToken.current = token;
    pendingLogout.current = true;
    setLogoutIncomplete(true);
    channel.current?.postMessage("session-clearing");
    sessionRequest.current += 1;
    clearIdentity();
    try {
      await request("/api/logout", {
        method: "POST",
        headers: { "x-csrf-token": token || "" },
      });
      logoutToken.current = undefined;
      pendingLogout.current = false;
      setLogoutIncomplete(false);
      channel.current?.postMessage("session-changed");
    } catch {
      setSessionError(
        "Sign-out could not reach the server. Your data is hidden; retry signing out before leaving a shared device.",
      );
      throw new Error(
        "Could not finish signing out. Retry from account settings.",
      );
    }
  }
  async function connectGithub() {
    const data = await mutate<{ url: string }>("/api/github/connect");
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.hostname !== "github.com")
      throw new Error("GitHub returned an invalid connection address.");
    window.location.assign(url.href);
  }
  async function installations() {
    try {
      return await request<{
        installations: InstallationChoice[];
        installUrl: string;
      }>("/api/github/installations");
    } catch (error) {
      accessFailure(error);
      throw error;
    }
  }
  /** Re-reads installations and repository access from GitHub. */
  async function refreshInstallations() {
    try {
      return await mutate<{
        installations: InstallationChoice[];
        installUrl: string;
      }>("/api/github/installations/refresh", undefined, "POST", 180_000);
    } catch (error) {
      accessFailure(error);
      throw error;
    }
  }
  async function connectInstallation(id: number) {
    const user = currentUser.current;
    const identity = identityRevision.current;
    const selection = selectionRevision.current;
    if (!user) throw new Error("Sign in again to continue.");
    const isCurrent = () =>
      user === currentUser.current && identity === identityRevision.current;
    const data = await mutate<{ workspace: Workspace }>(
      `/api/github/installations/${id}/connect`,
      undefined,
      "POST",
      180_000,
    );
    if (!isCurrent())
      throw new Error("Your session changed. Sign in again to continue.");
    let pending = loadWorkspaces();
    let workspaces: WorkspaceList | undefined;
    for (;;) {
      workspaces = await pending;
      if (!isCurrent())
        throw new Error("Your session changed. Sign in again to continue.");
      // Poll/focus refreshes may supersede this load; join the latest result
      // only while the connection's original identity lifecycle is still current.
      const latest = latestWorkspaceLoad.current;
      if (!latest || latest === pending) break;
      pending = latest;
    }
    const connected = workspaces?.workspaces.find(
      (item) => item.id === data.workspace.id,
    );
    if (!connected)
      throw new Error("Could not verify the connected workspace. Try again.");
    // An explicit selection made while connecting takes precedence.
    if (selection === selectionRevision.current) selectWorkspace(connected);
    return connected;
  }
  async function runPrivateOperation(target: PrivateOperationTarget) {
    const user = currentUser.current;
    if (!user || operationPending.current) return;
    const id = ++operationSequence.current;
    operationPending.current = true;
    dispatchOperation({
      type: "start",
      operation: {
        ...target,
        id,
        userId: user,
        status: "pending",
        error: undefined,
      },
    });
    blocked.current = true;
    setAccessBlocked(true);
    clearPrivate();
    const current = () =>
      id === operationSequence.current && user === currentUser.current;
    try {
      try {
        if (target.kind === "disconnect")
          await mutate("/api/github/disconnect");
        else
          await mutate(
            `/api/workspaces/${encodeURIComponent(target.workspaceId)}/notes/${encodeURIComponent(target.noteId)}`,
            undefined,
            "DELETE",
          );
      } catch (error) {
        // The first delete may have committed before its response was lost.
        if (!(
          target.kind === "delete-note" &&
          error instanceof ApiError &&
          error.status === 404
        ))
          throw error;
      }
      if (!current()) return;
      operationPending.current = false;
      dispatchOperation({ type: "complete", id });
      blocked.current = false;
      setAccessBlocked(false);
      if (target.kind === "disconnect") await loadWorkspaces();
      if (user !== currentUser.current) return;
      await refresh();
    } catch (error) {
      if (!current()) return;
      operationPending.current = false;
      const explanation =
        target.kind === "disconnect"
          ? "Could not confirm the GitHub disconnect. Cached activity is hidden. Retry disconnecting or reload activity to check the current connection."
          : "Could not confirm the note deletion. Cached activity is hidden. Retry deleting or reload activity to check whether the note remains.";
      dispatchOperation({ type: "failed", id, error: explanation });
      failPrivate(new Error(explanation));
      throw error;
    }
  }
  async function disconnectGithub() {
    await runPrivateOperation({ kind: "disconnect" });
  }
  // Sync runs in the background. Read the workspace's latest run, and while it
  // runs, poll it every few seconds (database reads only) until it settles.
  const syncRunning = syncRun?.status === "running";
  useEffect(() => {
    setSyncRun(null);
    // A journal can sync its sources without an installation of its own.
    if (demo || !workspace) return;
    const id = workspace.id;
    let cancelled = false;
    void request<{ run: SyncRun | null }>(
      `/api/workspaces/${encodeURIComponent(id)}/sync`,
    )
      .then((data) => {
        if (!cancelled) setSyncRun(data.run);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Load once per selected workspace, not on each workspace object refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, workspace?.id, workspace?.installationId]);
  useEffect(() => {
    if (!syncRunning || !workspace) return;
    const id = workspace.id;
    let cancelled = false;
    const timer = setInterval(() => {
      void request<{ run: SyncRun | null }>(
        `/api/workspaces/${encodeURIComponent(id)}/sync`,
      )
        .then((data) => {
          if (cancelled || !data.run) return;
          setSyncRun(data.run);
          if (data.run.status !== "running") void refresh();
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncRunning, workspace?.id, refresh]);
  async function sync() {
    const active = currentWorkspace.current;
    if (!active) return;
    // Returns at once; the polling effect above reports the outcome.
    const run = await mutate<SyncRun>(
      `/api/workspaces/${encodeURIComponent(active.id)}/sync`,
    );
    if (currentWorkspace.current?.id === active.id) setSyncRun(run);
    return run;
  }
  async function addNote(input: ShipNoteInput) {
    const active = currentWorkspace.current;
    if (!active || active.kind !== "personal" || !active.owner)
      throw new Error("Choose your personal journal to add a note.");
    await mutate<ActivityEvent>(
      `/api/workspaces/${encodeURIComponent(active.id)}/notes`,
      input,
    );
    await refresh();
  }
  async function deleteNote(id: string) {
    const active = currentWorkspace.current;
    if (!active || active.kind !== "personal" || !active.owner) return;
    await runPrivateOperation({
      kind: "delete-note",
      workspaceId: active.id,
      noteId: id,
    });
  }
  /** Saves the workspace's Pulse heading; empty fields restore the default. */
  async function updatePulseHeading(title: string, subtitle: string) {
    const active = currentWorkspace.current;
    if (!active) throw new Error("Choose a workspace first.");
    await request(`/api/workspaces/${encodeURIComponent(active.id)}/pulse`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrf.current || "",
      },
      body: JSON.stringify({ title, subtitle }),
    });
    await refreshWorkspaces();
  }
  /** Gives a workspace its own name; an empty name restores the default. */
  async function renameWorkspace(id: string, name: string) {
    await mutate(
      `/api/workspaces/${encodeURIComponent(id)}/name`,
      { name },
      "PATCH",
    );
    await refreshWorkspaces();
  }
  /** Connects the ticked installations and leaves the unticked ones. */
  async function saveConnections(connect: number[], disconnect: number[]) {
    await mutate(
      "/api/github/installations",
      { connect, disconnect },
      "PUT",
      180_000,
    );
    await refreshWorkspaces();
  }
  /** Chooses which connected installations feed the personal dashboard. */
  async function updateSources(sources: PersonalSources) {
    const active = currentWorkspace.current;
    if (!active || active.kind !== "personal")
      throw new Error("Choose your personal dashboard first.");
    await mutate(
      `/api/workspaces/${encodeURIComponent(active.id)}/sources`,
      sources,
      "PATCH",
    );
    await refreshWorkspaces();
    await refresh();
  }
  const retry = () => {
    if (operationPending.current) return;
    dispatchOperation({ type: "reset", sequence: ++operationSequence.current });
    blocked.current = false;
    setAccessBlocked(false);
    void refresh();
  };
  const retryOperation = async () => {
    const operation = operationState.operation;
    if (
      operation?.status !== "failed" ||
      operation.userId !== currentUser.current
    )
      return;
    try {
      await runPrivateOperation(operation);
    } catch {
      /* The hook retains the error for the remounted view. */
    }
  };
  return {
    ...state,
    ...workspaceList,
    session,
    sessionLoading,
    sessionError,
    logoutIncomplete,
    operation: operationState.operation,
    retryOperation,
    workspace,
    organization: workspace?.name || "",
    demo,
    paused,
    setPaused,
    refresh: retry,
    selectWorkspace,
    updatePulseHeading,
    useDemo: () => selectWorkspace(null),
    simulateActivity: () => {
      // Demo events stay in the browser and can never enter a real workspace.
      if (currentWorkspace.current || !demo || paused) return;
      const index = demoSequence.current++;
      const type = (["release", "merge", "review"] as const)[index % 3];
      const occurredAt = new Date().toISOString();
      const event: ActivityEvent = {
        id: `demo-live-${crypto.randomUUID()}`,
        type,
        actor: { login: "emmarivera" },
        repo: "design-system",
        title:
          type === "release"
            ? "v3.0 — a smoother experience, shipped together"
            : type === "merge"
              ? "Ship the new accessible component library"
              : "Review the next round of design system improvements",
        occurredAt,
        ...(type === "release" ? {} : { number: 500 + index }),
      };
      dispatch({
        type: "snapshot",
        generation: generation.current,
        events: [event, ...state.events].slice(0, 2000),
        updatedAt: occurredAt,
      });
    },
    loadSession,
    loadWorkspaces,
    logout,
    connectGithub,
    installations,
    refreshInstallations,
    connectInstallation,
    saveConnections,
    updateSources,
    renameWorkspace,
    disconnectGithub,
    sync,
    syncRun,
    addNote,
    deleteNote,
    readShare: () =>
      request<{ share: DashboardShare | null }>(
        `/api/workspaces/${encodeURIComponent(workspace!.id)}/share`,
      ),
    /** Rotating can keep the current link's expiry instead of a new lifetime. */
    createShare: (expiresIn: number, rotate: boolean, keepExpiry = false) =>
      mutate<CreatedDashboardShare>(
        `/api/workspaces/${encodeURIComponent(workspace!.id)}/share${rotate ? "/rotate" : ""}`,
        rotate && keepExpiry ? { keepExpiry: true } : { expiresIn },
      ),
    revokeShare: () =>
      mutate<void>(
        `/api/workspaces/${encodeURIComponent(workspace!.id)}/share`,
        undefined,
        "DELETE",
      ),
    scopeKey: `${session.user?.id || "demo"}:${workspace?.id || "demo"}:${state.revision}`,
  };
}
export type FeedController = ReturnType<typeof useFeed>;
