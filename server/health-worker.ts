import { HealthStore } from "./health-store.js";
import { runProbe } from "./health-probe.js";
import { log } from "./logger.js";
import { healthChecks } from "./metrics.js";

/** Durable leases coordinate replicas; HTTP work never holds a database lock. */
export function startHealthWorker(health: HealthStore): () => Promise<void> {
  let stopped = false;
  let busy = false;
  let lastPrune = 0;
  const active = new Set<Promise<void>>();
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (Date.now() - lastPrune > 3_600_000) {
        await health.prune();
        lastPrune = Date.now();
      }
      if (active.size >= 4) return;
      const claims = await health.claim(4 - active.size);
      for (const claim of claims) {
        const task = runProbe(claim.config, claim.headers)
          .then(async (result) => {
            await health.complete(claim, result);
            healthChecks.inc({ status: result.ok ? "ok" : "failed" });
          })
          .catch(() => {
            // Lease expiry retries failed database writes without logging probe secrets.
            log.error(
              "A health check could not be recorded; it will be retried.",
            );
          })
          .finally(() => active.delete(task));
        active.add(task);
      }
    } catch {
      log.error("Health scheduler unavailable; retrying shortly.");
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), 2000);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.allSettled([...active]);
  };
}
