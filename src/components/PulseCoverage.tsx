import type { PulseOverview } from "../../shared/pulse";

/** Coverage describes visible contribution history, not notes or health checks. */
export function PulseCoverage({
  data,
  demo = false,
}: {
  data: PulseOverview;
  demo?: boolean;
}) {
  const { earliestStoredAt, retentionDays, sourceSync } = data.coverage;
  const beforeHistory =
    !!earliestStoredAt && data.range.from < earliestStoredAt.slice(0, 10);
  const beforeRetention =
    retentionDays !== null &&
    Date.parse(data.range.start) <
      Date.parse(data.generatedAt) - retentionDays * 86400000;
  const limited = beforeHistory || beforeRetention;
  const status = demo
    ? "Demo data"
    : limited
      ? "Limited history"
      : "Completeness unknown";
  return (
    <section className="pulse-coverage" aria-label="Activity data coverage">
      <div className="pulse-coverage-heading">
        <strong>Activity data coverage</strong>
        <span className="pulse-coverage-status">{status}</span>
      </div>
      {demo ? (
        <p>Fictional demo data.</p>
      ) : (
        <>
          {beforeHistory && (
            <p className="pulse-coverage-warning">
              This period starts before the earliest stored contribution (
              {earliestStoredAt!.slice(0, 10)}).
            </p>
          )}
          {beforeRetention && (
            <p className="pulse-coverage-warning">
              This period includes dates outside the {retentionDays}-day
              retention window. Older activity may have been removed.
            </p>
          )}
          {!earliestStoredAt ? (
            <>
              <p>No stored contributions yet.</p>
              {!!sourceSync?.syncedRepositories && (
                <p>
                  A source import is recorded, but no contributions visible to
                  you are stored.
                </p>
              )}
            </>
          ) : (
            !data.totals.count && (
              <p>
                No stored contributions in this period. Stored history exists
                outside this period.
              </p>
            )
          )}
          <dl>
            <div>
              <dt>Earliest stored contribution</dt>
              <dd>
                {earliestStoredAt
                  ? `${earliestStoredAt.slice(0, 10)} · UTC`
                  : "None recorded"}
              </dd>
            </div>
            <div>
              <dt>Latest successful source import</dt>
              <dd>
                {sourceSync?.lastSyncedAt ? (
                  <>
                    {sourceSync.lastSyncedAt.slice(0, 16).replace("T", " ")} UTC{" "}
                    <span>(sync start)</span>
                  </>
                ) : sourceSync ? (
                  "None recorded"
                ) : (
                  "Unknown"
                )}
              </dd>
            </div>
          </dl>
          {sourceSync ? (
            <p>
              {sourceSync.totalRepositories === 0
                ? "No source repositories selected."
                : sourceSync.syncedRepositories === 0
                  ? "No successful source import recorded. Webhook activity may still be stored."
                  : `${sourceSync.syncedRepositories} of ${sourceSync.totalRepositories} selected repository sources have a successful import recorded.`}
            </p>
          ) : (
            <p>Source import status unavailable.</p>
          )}
          <details>
            <summary>What these totals include</summary>
            <p>
              Totals reflect stored contributions visible to you. GitHub imports
              cover limited history; push history starts with webhooks. A
              successful import does not establish complete history. Notes and
              health checks have separate coverage.
            </p>
            {retentionDays !== null && (
              <p>Activity retention: {retentionDays} days.</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
