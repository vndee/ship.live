import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workspace } from "../../shared/workspaces";
import {
  chooseInitialWorkspace,
  readWorkspacePreference,
  saveWorkspacePreference,
  workspacePreferenceKey,
} from "./workspace-preference.ts";

const personal: Workspace = {
  id: "personal-a",
  name: "Journal",
  kind: "personal",
  owner: true,
};
const team: Workspace = {
  id: "team-a",
  name: "Team",
  kind: "team",
  owner: false,
};

test("restores only an authorized workspace for the current user", () => {
  const workspaces = [personal, team];
  assert.equal(chooseInitialWorkspace(workspaces, team.id), team);
  assert.equal(chooseInitialWorkspace(workspaces, "revoked"), personal);
});

test("falls back to personal, then first authorized workspace, then nothing", () => {
  assert.equal(chooseInitialWorkspace([team, personal], null), personal);
  assert.equal(chooseInitialWorkspace([team], "revoked"), team);
  assert.equal(chooseInitialWorkspace([team], null), team);
  assert.equal(chooseInitialWorkspace([], team.id), null);
  assert.equal(chooseInitialWorkspace([], null), null);
});

test("keeps workspace preferences separate for each authenticated account", () => {
  const storage = new Map<string, string>();
  const read = (key: string) => storage.get(key) ?? null;
  const write = (key: string, value: string) => {
    storage.set(key, value);
  };
  assert.equal(workspacePreferenceKey("user-a"), "ship-live-workspace:user-a");
  assert.notEqual(
    workspacePreferenceKey("user-a"),
    workspacePreferenceKey("user-b"),
  );
  assert.equal(readWorkspacePreference("user-a", read), null);
  assert.equal(saveWorkspacePreference("user-a", team.id, write), true);
  assert.equal(saveWorkspacePreference("user-b", personal.id, write), true);
  assert.equal(readWorkspacePreference("user-a", read), team.id);
  assert.equal(readWorkspacePreference("user-b", read), personal.id);
  assert.equal(readWorkspacePreference("user-c", read), null);
});

test("tolerates blocked reads and blocked or full storage writes", () => {
  assert.equal(
    readWorkspacePreference("user-a", () => {
      throw new DOMException("blocked", "SecurityError");
    }),
    null,
  );
  for (const name of ["SecurityError", "QuotaExceededError"]) {
    assert.equal(
      saveWorkspacePreference("user-a", team.id, () => {
        throw new DOMException("blocked", name);
      }),
      false,
    );
  }
});
