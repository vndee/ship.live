import type { LeaderboardEntry } from "./activity";

export function getLeaderboardChanges(
  previous: LeaderboardEntry[],
  current: LeaderboardEntry[],
) {
  const changes = new Map<string, { xp: number; ranks: number }>();
  if (!previous.length) return changes;
  const byLogin = new Map(
    previous.map((person) => [person.login.toLowerCase(), person]),
  );
  for (const person of current) {
    const old = byLogin.get(person.login.toLowerCase());
    if (!old || person.xp < old.xp) continue;
    const xp = person.xp - old.xp;
    const ranks = old.rank - person.rank;
    if (xp || ranks) changes.set(person.login.toLowerCase(), { xp, ranks });
  }
  return changes;
}
