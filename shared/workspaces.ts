export interface Workspace {
  id: string;
  name: string;
  kind: "personal" | "team";
  owner: boolean;
  installationId?: number;
  githubAccount?: string;
}

export interface WorkspaceList {
  workspaces: Workspace[];
  githubConnected: boolean;
  githubAppConfigured: boolean;
}

export interface InstallationChoice {
  id: number;
  account: string;
  kind: "User" | "Organization";
  repositories: { id: number; name: string; private: boolean }[];
}

export interface ShipNoteInput {
  title: string;
  body: string;
}
