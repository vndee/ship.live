# XP v2

XP recognizes observable contribution, not individual productivity or code quality. It requires no new user input, labels, estimates, assessments, or integrations.

## Ranked points

| Contribution                                             |  XP |
| -------------------------------------------------------- | --: |
| PR merged into default branch / unknown target           |  30 |
| PR merged into another branch                            |  15 |
| Earliest retained peer review per reviewer/repository/PR |  10 |
| Completed issue                                          |  10 |
| Published release                                        |  50 |
| Commit, PR opening, note, inbound alert                  |   0 |

Issue and release rules remain unchanged. Bots and duplicate events are excluded. Review decisions and comment quantity do not change the award. Reviews without an identifiable PR or author, and self reviews, earn zero. Author identity comes from the normalized review, retained PR activity, or authorized PR wall state. The earliest review wins by timestamp and then event ID. Review credit is resolved across authorized installations before filtering the period or limiting the feed. Equal XP is ordered by login; extra zero-point activity cannot win a tie.

Only retained data can be scored. Importing an earlier review can move credit back to its original period. Retention or access changes can affect which review is earliest; these are not lifetime completeness guarantees. Old API clients must refresh when deploying these rules.

## Verification observations

New live GitHub App merge events capture one immutable snapshot in the event JSON, within the event transaction. Imported history receives no retrospective snapshot. The snapshot records capture time, PR head SHA when available, peer-review IDs and observed check IDs. No new GitHub requests or user actions are needed.

Peer evidence requires a non-bot reviewer other than the author, a matching PR and a submission no later than merge. It records participation, not approval of the final commit: existing review data has no review commit SHA. Dismissal is terminal for a review ID so a delayed original submission cannot revive it.

CI evidence requires exact repository/head SHA matching and all observed distinct checks passing before merge. Same-name checks remain distinct because the current schema cannot prove they are retries of one logical job. Post-merge states cannot establish historical verification. Missing observations are unknown, not proof of failure or success. Late deliveries may leave a snapshot incomplete; snapshots are not retrospectively rewritten.

Potential bonuses are 5 for peer evidence and 5 for passing observed checks. **They are not included in XP, leaderboard ranks, profile history, celebrations or digests.** Evidence details explain this explicitly. There is no user-facing switch or extra input required.

## Coverage audit before enabling bonuses

Audit live merge capture per authorized repository over a representative period, including repositories with zero or missing evidence. Keep candidates unranked while coverage differs materially or timestamp/identity ambiguity remains. This operational audit does not ask contributors to enter anything.

Example read-only SQL for an operator with authorized database access (counts are per installation/repository, not distinct people):

```sql
SELECT organization, event->>'repositoryId' AS repository_id,
       count(*) AS merges,
       count(*) FILTER (WHERE event ? 'verification') AS captured,
       count(*) FILTER (WHERE event #>> '{verification,peerReview,status}' = 'observed') AS peer_observed,
       count(*) FILTER (WHERE event #>> '{verification,ci,status}' = 'passing') AS ci_passing,
       count(*) FILTER (WHERE event #>> '{verification,ci,status}' = 'not_passing') AS ci_not_passing
FROM ship_live_events
WHERE event->>'type' = 'merge'
  AND occurred_at >= now() - interval '28 days'
GROUP BY organization, event->>'repositoryId';
```

This query cannot establish webhook completeness or quality. Review integration uptime, retention and imported/live mix alongside it. No universal coverage threshold or score weights are scientifically validated for this product.

## LOC

Additions and deletions remain visible on events and do not affect XP. Current events lack per-file classification to filter generated files, lockfiles and formatting, so a LOC multiplier would create misleading incentives.

## Verification

Run `npm run check`, `npm run build`, unit/integration tests with `TEST_DATABASE_URL`, and `node --test src/xp.browser.test.mjs`. Database tests create and remove isolated databases, never migrate a configured production database. `PLAYWRIGHT_MODULE_PATH` can point to an already installed Playwright runtime.
