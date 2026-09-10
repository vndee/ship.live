import type { Workspace } from "../../shared/workspaces";

export function workspacePreferenceKey(userId: string): string {
  return `ship-live-workspace:${userId}`;
}

export function readWorkspacePreference(
  userId: string,
  read: (key: string) => string | null,
): string | null {
  try {
    return read(workspacePreferenceKey(userId));
  } catch {
    return null;
  }
}

export function saveWorkspacePreference(
  userId: string,
  workspaceId: string,
  write: (key: string, value: string) => void,
): boolean {
  try {
    write(workspacePreferenceKey(userId), workspaceId);
    return true;
  } catch {
    return false;
  }
}

export function chooseInitialWorkspace(
  workspaces: Workspace[],
  preferredId: string | null,
): Workspace | null {
  return (
    workspaces.find((workspace) => workspace.id === preferredId) ??
    workspaces.find((workspace) => workspace.kind === "personal") ??
    workspaces[0] ??
    null
  );
}
