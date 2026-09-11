export interface Workspace {
  id: string;
  name: string;
  kind: "personal" | "team";
  owner: boolean;
  installationId?: number;
  githubAccount?: string;
  /** The workspace's own Pulse heading, when set. */
  pulseTitle?: string;
  pulseSubtitle?: string;
  /** A personal dashboard's GitHub sources, for its owner. */
  sources?: PersonalSources;
}

/** Which connected GitHub installations a personal dashboard reads. */
export interface PersonalSources {
  /** null follows every installation its owner connects. */
  installationIds: number[] | null;
  /** Only the owner's own GitHub activity. */
  mineOnly: boolean;
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
  /** A personal account's installation connects only to its owner. */
  connectable: boolean;
}

/** A background history sync; clients poll it until it leaves "running". */
export interface SyncRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  synced?: number;
  message?: string;
}

export interface ShipNoteInput {
  title: string;
  body: string;
}
