import { object } from "./normalize.js";

export interface AccessChange {
  /** The organization or repository owner the delivery belongs to. */
  accountId?: number;
  /** The GitHub user whose access changed; absent when a team change affects everyone. */
  githubUserId?: number;
  repositoryId?: number;
  /** Drop the affected access before GitHub confirms the new state. */
  removal: boolean;
}

const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Members-permission webhooks that change who can read an installation's repositories. */
export function normalizeAccessWebhook(
  kind: string,
  input: unknown,
): AccessChange | undefined {
  const payload = object(input);
  const action = payload.action;
  const repository = object(payload.repository);
  const repositoryId = positiveId(repository.id) ? repository.id : undefined;
  const account =
    object(payload.organization).id ?? object(repository.owner).id;
  let change: Omit<AccessChange, "accountId"> | undefined;
  if (
    kind === "organization" &&
    (action === "member_added" || action === "member_removed")
  ) {
    const user = object(object(payload.membership).user).id;
    if (positiveId(user))
      change = { githubUserId: user, removal: action === "member_removed" };
  } else if (
    (kind === "membership" || kind === "member") &&
    (action === "added" || action === "removed")
  ) {
    const user = object(payload.member).id;
    // A team change can affect several repositories, so it names none.
    if (positiveId(user) && (kind === "membership" || repositoryId))
      change = {
        githubUserId: user,
        ...(kind === "member" ? { repositoryId } : {}),
        removal: action === "removed",
      };
  } else if (
    kind === "team" &&
    (action === "added_to_repository" || action === "removed_from_repository")
  ) {
    if (repositoryId)
      change = { repositoryId, removal: action === "removed_from_repository" };
  } else if (kind === "team" && action === "deleted") {
    // A deleted team names no repositories; recompute its members without narrowing.
    change = { removal: false };
  }
  return (
    change && {
      ...change,
      accountId: positiveId(account) ? account : undefined,
    }
  );
}
