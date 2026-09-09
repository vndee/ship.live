import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  HealthStatus,
  HealthSnapshot,
  HealthCheck,
  DailyLatency,
  ProbeInput,
  ProbeResult,
} from "../shared/health.js";
import { AuthError } from "./auth.js";
import { ACTIVITY_CHANNEL } from "./postgres-notifications.js";

interface ProbeRow {
  id: string;
  workspace_id: string;
  service_id: string;
  config: ProbeInput;
  headers_encrypted: string | null;
  lease: string | null;
  lease_until: Date | null;
  state: HealthStatus;
  failures: number;
  successes: number;
  last_checked_at: Date | null;
  last_result: ProbeResult | null;
}
export interface ProbeClaim {
  id: string;
  workspaceId: string;
  lease: string;
  config: ProbeInput;
  headers: Record<string, string>;
}
const missing = () => new AuthError(404, "Service or probe not found.");
const validId = (id: string) =>
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80)
    throw new AuthError(400, "Use a service name between 1 and 80 characters.");
  return value.trim();
}
function aggregate(states: HealthStatus[]): HealthStatus {
  const active = states.filter((s) => s !== "paused");
  if (!states.length) return "unknown";
  if (!active.length) return "paused";
  return (
    (["down", "degraded", "unknown", "healthy"] as const).find((s) =>
      active.includes(s),
    ) || "unknown"
  );
}
export class HealthStore {
  private key?: Buffer;
  constructor(
    readonly pool: Pool,
    key = process.env.TOKEN_ENCRYPTION_KEY || "",
  ) {
    if (key && !/^[a-f\d]{64}$/i.test(key))
      throw new Error("Invalid health encryption key.");
    if (key) this.key = Buffer.from(key, "hex");
  }
  private seal(headers: Record<string, string>, id: string): string | null {
    if (!Object.keys(headers).length) return null;
    if (!this.key)
      throw new AuthError(503, "Secret header storage is not configured.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`health:${id}`));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(headers), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  private open(value: string | null, id: string): Record<string, string> {
    if (!value) return {};
    if (!this.key) throw new Error("Secret header storage unavailable");
    const [iv, tag, data] = value
      .split(".")
      .map((s) => Buffer.from(s, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`health:${id}`));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
    ) as Record<string, string>;
  }
  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  private async notify(client: Pool | PoolClient, workspaceId: string) {
    await client.query("SELECT pg_notify($1,$2)", [
      ACTIVITY_CHANNEL,
      JSON.stringify({
        organization: `health-${workspaceId}`,
        eventId: "health",
      }),
    ]);
  }
  private async lockWorkspace(client: PoolClient, id: string) {
    if (!validId(id)) throw missing();
    const found = await client.query(
      "SELECT id FROM ship_live_workspaces WHERE id=$1 AND kind='team' FOR UPDATE",
      [id],
    );
    if (!found.rowCount) throw missing();
  }
  async createService(
    workspaceId: string,
    value: unknown,
  ): Promise<{ id: string }> {
    const label = name(value);
    return this.transaction(async (c) => {
      await this.lockWorkspace(c, workspaceId);
      const count = await c.query(
        "SELECT count(*)::int AS count FROM ship_live_health_services WHERE workspace_id=$1",
        [workspaceId],
      );
      if (count.rows[0].count >= 20)
        throw new AuthError(400, "A team can configure up to 20 services.");
      const id = randomUUID();
      await c.query(
        "INSERT INTO ship_live_health_services(id,workspace_id,name) VALUES($1,$2,$3)",
        [id, workspaceId, label],
      );
      await this.notify(c, workspaceId);
      return { id };
    });
  }
  async renameService(workspaceId: string, id: string, value: unknown) {
    if (!validId(id)) throw missing();
    const result = await this.pool.query(
      "UPDATE ship_live_health_services SET name=$3 WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id, name(value)],
    );
    if (!result.rowCount) throw missing();
    await this.notify(this.pool, workspaceId);
  }
  async deleteService(workspaceId: string, id: string) {
    if (!validId(id)) throw missing();
    const result = await this.pool.query(
      "DELETE FROM ship_live_health_services WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    if (!result.rowCount) throw missing();
    await this.notify(this.pool, workspaceId);
  }
  async saveProbe(
    workspaceId: string,
    serviceId: string,
    id: string | null,
    config: ProbeInput,
    headers?: Record<string, string>,
  ): Promise<{ id: string }> {
    if (!validId(serviceId) || (id && !validId(id))) throw missing();
    return this.transaction(async (c) => {
      await this.lockWorkspace(c, workspaceId);
      const service = await c.query(
        "SELECT id FROM ship_live_health_services WHERE workspace_id=$1 AND id=$2",
        [workspaceId, serviceId],
      );
      if (!service.rowCount) throw missing();
      const probeId = id || randomUUID();
      if (id) {
        const existing = await c.query<ProbeRow>(
          "SELECT * FROM ship_live_health_probes WHERE workspace_id=$1 AND service_id=$2 AND id=$3 FOR UPDATE",
          [workspaceId, serviceId, id],
        );
        if (!existing.rowCount) throw missing();
        const secret =
          headers === undefined
            ? existing.rows[0].headers_encrypted
            : this.seal(headers, id);
        const previous = existing.rows[0];
        const ruleChanged = (Object.keys(config) as (keyof ProbeInput)[]).some(
          (key) =>
            key !== "name" &&
            key !== "enabled" &&
            config[key] !== previous.config[key],
        );
        let headersChanged = headers !== undefined;
        if (headers !== undefined) {
          try {
            const oldHeaders = this.open(previous.headers_encrypted, id);
            headersChanged =
              JSON.stringify(Object.entries(headers).sort()) !==
              JSON.stringify(Object.entries(oldHeaders).sort());
          } catch {
            // Explicit replacement/removal repairs secrets after key rotation.
            headersChanged = true;
          }
        }
        const reset = ruleChanged || headersChanged;
        await c.query(
          "UPDATE ship_live_health_probes SET config=$4,headers_encrypted=$5,lease=NULL,lease_until=NULL,next_check_at=now() WHERE workspace_id=$1 AND service_id=$2 AND id=$3",
          [workspaceId, serviceId, id, config, secret],
        );
        if (reset) {
          // New rules reset current state; recorded measurements stay available.
          await c.query(
            "UPDATE ship_live_health_probes SET state='unknown',failures=0,successes=0,last_checked_at=NULL,last_result=NULL WHERE id=$1",
            [id],
          );
        }
      } else {
        const count = await c.query(
          "SELECT count(*)::int AS count FROM ship_live_health_probes WHERE workspace_id=$1",
          [workspaceId],
        );
        if (count.rows[0].count >= 100)
          throw new AuthError(400, "A team can configure up to 100 probes.");
        await c.query(
          "INSERT INTO ship_live_health_probes(id,workspace_id,service_id,config,headers_encrypted) VALUES($1,$2,$3,$4,$5)",
          [
            probeId,
            workspaceId,
            serviceId,
            config,
            this.seal(headers || {}, probeId),
          ],
        );
      }
      await this.notify(c, workspaceId);
      return { id: probeId };
    });
  }
  async probeService(workspaceId: string, id: string): Promise<string> {
    if (!validId(id)) throw missing();
    const r = await this.pool.query(
      "SELECT service_id FROM ship_live_health_probes WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    if (!r.rowCount) throw missing();
    return r.rows[0].service_id;
  }
  async deleteProbe(workspaceId: string, id: string) {
    if (!validId(id)) throw missing();
    const r = await this.pool.query(
      "DELETE FROM ship_live_health_probes WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    if (!r.rowCount) throw missing();
    await this.notify(this.pool, workspaceId);
  }
  async checkNow(workspaceId: string, id: string) {
    if (!validId(id)) throw missing();
    const r = await this.pool.query(
      "UPDATE ship_live_health_probes SET next_check_at=now() WHERE workspace_id=$1 AND id=$2 AND (config->>'enabled')::boolean=true AND (lease_until IS NULL OR lease_until<now()) AND (last_checked_at IS NULL OR last_checked_at<now()-interval '10 seconds')",
      [workspaceId, id],
    );
    if (!r.rowCount)
      throw new AuthError(
        409,
        "Probe is paused, running, or checked within the last 10 seconds.",
      );
  }
  async snapshot(workspaceId: string): Promise<HealthSnapshot> {
    if (!validId(workspaceId)) throw missing();
    const result = await this.pool.query<{
      id: string;
      name: string;
      probes: (ProbeRow & {
        history: HealthCheck[];
        latencyHistory: DailyLatency[];
        checks: number;
        rate: number | null;
      })[];
    }>(
      `SELECT s.id,s.name,coalesce((SELECT jsonb_agg(to_jsonb(p)-'headers_encrypted'||jsonb_build_object('has_headers',p.headers_encrypted IS NOT NULL,
    'history',coalesce((SELECT jsonb_agg(h.entry ORDER BY h.checked_at DESC,h.id DESC) FROM (SELECT c.id,c.checked_at,c.result||jsonb_build_object('checkedAt',c.checked_at,'status',c.state) AS entry FROM ship_live_health_checks c WHERE c.probe_id=p.id AND c.checked_at>now()-interval '30 days' ORDER BY c.checked_at DESC,c.id DESC LIMIT 120) h),'[]'::jsonb),
    'latencyHistory',coalesce((SELECT jsonb_agg(jsonb_build_object('date',d.day,'avgLatencyMs',round(d.total_latency/d.checks,2),'minLatencyMs',d.min_latency,'maxLatencyMs',d.max_latency,'checks',d.checks) ORDER BY d.day) FROM ship_live_health_latency_daily d WHERE d.probe_id=p.id AND d.day >= (now() AT TIME ZONE 'UTC')::date-29),'[]'::jsonb),
    'checks',(SELECT count(*) FROM ship_live_health_checks c WHERE c.probe_id=p.id AND c.checked_at>now()-interval '24 hours'),
    'rate',(SELECT round(100.0*avg(CASE WHEN (c.result->>'ok')::boolean THEN 1 ELSE 0 END),1) FROM ship_live_health_checks c WHERE c.probe_id=p.id AND c.checked_at>now()-interval '24 hours')
    ) ORDER BY p.config->>'name',p.id) FROM ship_live_health_probes p WHERE p.service_id=s.id),'[]'::jsonb) AS probes FROM ship_live_health_services s WHERE s.workspace_id=$1 ORDER BY s.created_at,s.id`,
      [workspaceId],
    );
    const now = Date.now();
    return {
      updatedAt: new Date(now).toISOString(),
      services: result.rows.map((service) => {
        const probes = service.probes.map((p) => {
          const last = p.last_checked_at
            ? new Date(p.last_checked_at).toISOString()
            : null;
          const stale =
            !last ||
            now - Date.parse(last) >
              p.config.intervalSeconds * 2 * 1000 + p.config.timeoutMs;
          const status: HealthStatus = !p.config.enabled
            ? "paused"
            : stale
              ? "unknown"
              : p.state;
          return {
            ...p.config,
            id: p.id,
            serviceId: p.service_id,
            hasHeaders: Boolean(
              (p as unknown as { has_headers: boolean }).has_headers,
            ),
            status,
            lastCheck:
              last && p.last_result
                ? { ...p.last_result, checkedAt: last, status: p.state }
                : null,
            checks24h: Number(p.checks),
            successRate24h: p.rate === null ? null : Number(p.rate),
            history: p.history,
            latencyHistory: p.latencyHistory,
          };
        });
        return {
          id: service.id,
          name: service.name,
          status: aggregate(probes.map((p) => p.status)),
          probes,
        };
      }),
    };
  }
  async claim(limit: number): Promise<ProbeClaim[]> {
    return this.transaction(async (c) => {
      const rows = await c.query<ProbeRow>(
        `SELECT p.* FROM ship_live_health_probes p WHERE (config->>'enabled')::boolean=true AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [Math.max(1, Math.min(4, limit))],
      );
      const claims: ProbeClaim[] = [];
      for (const p of rows.rows) {
        const lease = randomUUID();
        await c.query(
          "UPDATE ship_live_health_probes SET lease=$2,lease_until=now()+interval '45 seconds' WHERE id=$1",
          [p.id, lease],
        );
        try {
          claims.push({
            id: p.id,
            workspaceId: p.workspace_id,
            lease,
            config: p.config,
            headers: this.open(p.headers_encrypted, p.id),
          });
        } catch {
          await c.query(
            "UPDATE ship_live_health_probes SET lease=NULL,lease_until=NULL,next_check_at=now()+interval '60 seconds',state='unknown',last_checked_at=NULL,last_result=NULL WHERE id=$1",
            [p.id],
          );
        }
      }
      return claims;
    });
  }
  async complete(claim: ProbeClaim, result: ProbeResult): Promise<boolean> {
    return this.transaction(async (c) => {
      const rows = await c.query<ProbeRow>(
        "SELECT * FROM ship_live_health_probes WHERE id=$1 AND lease=$2 AND lease_until>now() FOR UPDATE",
        [claim.id, claim.lease],
      );
      if (!rows.rowCount) return false;
      const p = rows.rows[0];
      const successes = result.ok ? p.successes + 1 : 0;
      const failures = result.ok ? 0 : p.failures + 1;
      const status: HealthStatus = result.ok
        ? p.state === "down" && successes < p.config.recoveryThreshold
          ? "down"
          : "healthy"
        : p.state === "down" || failures >= p.config.failureThreshold
          ? "down"
          : "degraded";
      await c.query(
        "UPDATE ship_live_health_probes SET state=$3,failures=$4,successes=$5,last_checked_at=now(),last_result=$6,lease=NULL,lease_until=NULL,next_check_at=now()+make_interval(secs=>$7) WHERE id=$1 AND lease=$2",
        [
          p.id,
          claim.lease,
          status,
          failures,
          successes,
          result,
          p.config.intervalSeconds,
        ],
      );
      await c.query(
        "INSERT INTO ship_live_health_checks(probe_id,result,state) VALUES($1,$2,$3)",
        [p.id, result, status],
      );
      await c.query(
        `INSERT INTO ship_live_health_latency_daily(probe_id,day,checks,total_latency,min_latency,max_latency) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1,$2,$2,$2)
         ON CONFLICT(probe_id,day) DO UPDATE SET checks=ship_live_health_latency_daily.checks+1,total_latency=ship_live_health_latency_daily.total_latency+EXCLUDED.total_latency,min_latency=least(ship_live_health_latency_daily.min_latency,EXCLUDED.min_latency),max_latency=greatest(ship_live_health_latency_daily.max_latency,EXCLUDED.max_latency)`,
        [p.id, result.latencyMs],
      );
      await this.notify(c, p.workspace_id);
      return true;
    });
  }
  async prune() {
    await this.pool.query(
      "DELETE FROM ship_live_health_latency_daily WHERE day<(now() AT TIME ZONE 'UTC')::date-30",
    );
    await this.pool.query(
      "DELETE FROM ship_live_health_checks WHERE checked_at<now()-interval '30 days'",
    );
  }
}
