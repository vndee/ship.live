import type { ElementType } from "react";
import {
  CheckCheck,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  NotebookPen,
  Rocket,
} from "lucide-react";
import type { ActivityEvent } from "../../shared/types";

export type Kind = ActivityEvent["type"];

export const EVENT_ICONS: Record<Kind, ElementType> = {
  merge: GitMerge,
  review: MessageSquare,
  push: GitCommitHorizontal,
  issue: CheckCheck,
  release: Rocket,
  pr: GitPullRequest,
  note: NotebookPen,
};

export const EVENT_VERBS: Record<Kind, string> = {
  merge: "merged",
  review: "reviewed",
  push: "pushed",
  issue: "closed",
  release: "released",
  pr: "opened",
  note: "shipped",
};
