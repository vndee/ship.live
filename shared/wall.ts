export type PipelineStatus =
  "queued" | "running" | "passing" | "failing" | "cancelled" | "neutral";

export type DeploymentStatus =
  "queued" | "running" | "successful" | "failing" | "inactive" | "cancelled";

export interface PullRequestState {
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatarUrl?: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergeable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewState {
  id: number;
  pullRequestNumber: number;
  reviewer: string;
  decision: "approved" | "changes_requested" | "commented" | "dismissed";
  submittedAt: string;
}

export interface PipelineState {
  id: string;
  name: string;
  provider: string;
  headSha: string;
  status: PipelineStatus;
  url?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface DeploymentState {
  id: string;
  environment: string;
  headSha: string;
  status: DeploymentStatus;
  url?: string;
  updatedAt: string;
}

export type WallSignalUpdate =
  | { kind: "pull_request"; observedAt: string; value: PullRequestState }
  | { kind: "review"; observedAt: string; value: ReviewState }
  | { kind: "pipeline"; observedAt: string; value: PipelineState }
  | { kind: "deployment"; observedAt: string; value: DeploymentState };

export interface WallRepositorySnapshot {
  repositoryId: number;
  repository: string;
  pullRequests: PullRequestState[];
  reviews: ReviewState[];
  pipelines: PipelineState[];
  deployments: DeploymentState[];
}

export interface EngineeringWallSnapshot {
  repositories: WallRepositorySnapshot[];
  updatedAt: string;
}
