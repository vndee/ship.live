import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import type { LegacyImportData, LegacyImportResult } from "./legacy-import.js";
import {
  ACTIVITY_CHANNEL,
  PostgresNotifications,
} from "./postgres-notifications.js";
import {
  FEED_LIMIT,
  selectEvent,
  type ActivityListener,
  type EventStore,
  type MergeOptions,
  type MergeResult,
} from "./store.js";

interface EventRecord {
  event: ActivityEvent;
  restricted: boolean;
}

/** Durable history shared by every app instance connected to this database. */
export class PostgresEventStore implements EventStore {
  readonly pool: Pool;
  private readonly notifications: PostgresNotifications;
  private closing?: Promise<void>;

  private constructor(databaseUrl: string) {
    // Pass the URL intact: pg owns its options, SSL modes, and certificate validation.
    this.pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      fallback_application_name: "ship.live",
    });
    this.pool.on("error", () => {
      console.error(
        "An idle PostgreSQL connection failed; the pool will reconnect on demand.",
      );
    });
    this.notifications = new PostgresNotifications(databaseUrl);
  }

  static async open(databaseUrl: string): Promise<PostgresEventStore> {
    const store = new PostgresEventStore(databaseUrl);
    try {
      await store.migrate();
      await store.notifications.start();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      failed = true;
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release(failed);
    }
  }

  private async migrate(): Promise<void> {
    const migrations = await Promise.all(
      [
        "001_initial.sql",
        "002_auth.sql",
        "003_workspaces.sql",
        "004_connection_fencing.sql",
        "005_dashboard_shares.sql",
        "006_service_health.sql",
        "007_health_shares.sql",
        "008_health_latency_daily.sql",
      ].map((file) =>
        readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"),
      ),
    );
    await this.transaction(async (client) => {
      // The lock is database-scoped and acquired before touching the version table.
      await client.query("SELECT pg_advisory_xact_lock(1936222576, 1)");
      await client.query(`CREATE TABLE IF NOT EXISTS ship_live_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = await client.query<{ version: number }>(
        "SELECT version FROM ship_live_schema_migrations ORDER BY version",
      );
      if (applied.rows.some((row) => row.version > migrations.length))
        throw new Error(
          "This database uses a newer ship.live schema. Upgrade the application before starting it.",
        );
      for (const [index, sql] of migrations.entries())
        if (!applied.rows.some((row) => row.version === index + 1)) {
          await client.query(sql);
          await client.query(
            "INSERT INTO ship_live_schema_migrations (version) VALUES ($1)",
            [index + 1],
          );
        }
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async list(organization: string): Promise<ActivityEvent[]> {
    const result = await this.pool.query<{ event: ActivityEvent }>(
      "SELECT event FROM ship_live_events WHERE organization = $1 ORDER BY occurred_at DESC, event_id LIMIT $2",
      [organization.toLowerCase(), FEED_LIMIT],
    );
    return result.rows.map((row) => row.event);
  }

  async get(
    organization: string,
    eventId: string,
  ): Promise<ActivityEvent | undefined> {
    const result = await this.pool.query<{ event: ActivityEvent }>(
      "SELECT event FROM ship_live_events WHERE organization = $1 AND event_id = $2",
      [organization.toLowerCase(), eventId],
    );
    return result.rows[0]?.event;
  }

  async requiresProtection(organization: string): Promise<boolean> {
    const result = await this.pool.query<{ protected: boolean }>(
      "SELECT protected FROM ship_live_organizations WHERE organization = $1",
      [organization.toLowerCase()],
    );
    return result.rows[0]?.protected ?? false;
  }

  async protectOrganization(organization: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ship_live_organizations (organization, protected) VALUES ($1, true)
       ON CONFLICT (organization) DO UPDATE SET protected = true`,
      [organization.toLowerCase()],
    );
  }

  private async lockOrganization(
    client: PoolClient,
    organization: string,
  ): Promise<boolean> {
    await client.query(
      "INSERT INTO ship_live_organizations (organization) VALUES ($1) ON CONFLICT DO NOTHING",
      [organization],
    );
    const result = await client.query<{ protected: boolean }>(
      "SELECT protected FROM ship_live_organizations WHERE organization = $1 FOR UPDATE",
      [organization],
    );
    return result.rows[0].protected;
  }

  private async writeEvents(
    client: PoolClient,
    organization: string,
    records: EventRecord[],
    preferExisting = false,
  ): Promise<{ added: ActivityEvent[]; eventIds: string[] }> {
    if (!records.length) return { added: [], eventIds: [] };
    const current = await client.query<EventRecord>(
      "SELECT event, restricted FROM ship_live_events WHERE organization = $1 AND event_id = ANY($2::text[])",
      [organization, records.map((record) => record.event.id)],
    );
    const existing = new Map(
      current.rows.map((record) => [record.event.id, record]),
    );
    const selected = new Map<string, EventRecord>();
    for (const incoming of records) {
      const previous =
        selected.get(incoming.event.id) ?? existing.get(incoming.event.id);
      selected.set(incoming.event.id, {
        event: selectEvent(previous?.event, incoming.event, preferExisting),
        restricted: Boolean(incoming.restricted || previous?.restricted),
      });
    }
    const values = [...selected].map(([id, record]) => ({
      id,
      event: record.event,
      occurred_at: record.event.occurredAt,
      restricted: record.restricted,
    }));
    await client.query(
      `INSERT INTO ship_live_events (organization, event_id, event, occurred_at, restricted)
       SELECT $1, incoming.id, incoming.event, incoming.occurred_at::timestamptz, incoming.restricted
       FROM jsonb_to_recordset($2::jsonb) AS incoming(id text, event jsonb, occurred_at text, restricted boolean)
       ON CONFLICT (organization, event_id) DO UPDATE SET
         event = EXCLUDED.event,
         occurred_at = EXCLUDED.occurred_at,
         restricted = ship_live_events.restricted OR EXCLUDED.restricted`,
      [organization, JSON.stringify(values)],
    );
    return {
      added: [...selected]
        .filter(([id]) => !existing.has(id))
        .map(([, record]) => record.event),
      eventIds: [...selected.keys()],
    };
  }

  async merge(
    organization: string,
    events: ActivityEvent[],
    options: MergeOptions = {},
  ): Promise<MergeResult> {
    const org = organization.toLowerCase();
    return this.transaction(async (client) => {
      if (options.deliveryId) {
        const accepted = await client.query(
          "INSERT INTO ship_live_deliveries (delivery_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING delivery_id",
          [options.deliveryId],
        );
        if (!accepted.rowCount) return { duplicate: true, added: [] };
      }
      await this.lockOrganization(client, org);
      if (options.restricted) {
        await client.query(
          "UPDATE ship_live_organizations SET protected = true WHERE organization = $1",
          [org],
        );
      }
      const { added, eventIds } = await this.writeEvents(
        client,
        org,
        events.map((event) => ({
          event,
          restricted: Boolean(options.restricted),
        })),
        options.preferExisting,
      );
      // PostgreSQL releases notifications only after this same transaction commits.
      if (options.deliveryId && eventIds.length) {
        await client.query(
          "SELECT pg_notify($1, reference) FROM unnest($2::text[]) AS reference",
          [
            ACTIVITY_CHANNEL,
            eventIds.map((eventId) =>
              JSON.stringify({ organization: org, eventId }),
            ),
          ],
        );
      }
      return { duplicate: false, added };
    });
  }

  async importLegacy(data: LegacyImportData): Promise<LegacyImportResult> {
    return this.transaction(async (client) => {
      const groups = new Map<string, EventRecord[]>();
      const protectedOrgs = new Set(
        data.protectedOrganizations.map((org) => org.toLowerCase()),
      );
      for (const record of data.records) {
        const org = record.organization.toLowerCase();
        const group = groups.get(org) ?? [];
        group.push({ event: record.event, restricted: record.restricted });
        groups.set(org, group);
        if (record.restricted) protectedOrgs.add(org);
      }
      const organizations = [
        ...new Set([...groups.keys(), ...protectedOrgs]),
      ].sort();
      const result = { events: 0, deliveries: 0, protectedOrganizations: 0 };
      // Delivery locks come first, matching merge; imports sort both sets of locks.
      if (data.deliveries.length) {
        const inserted = await client.query(
          "INSERT INTO ship_live_deliveries (delivery_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING delivery_id",
          [[...new Set(data.deliveries)].sort()],
        );
        result.deliveries = inserted.rowCount ?? 0;
      }
      for (const org of organizations) {
        const wasProtected = await this.lockOrganization(client, org);
        if (protectedOrgs.has(org) && !wasProtected) {
          await client.query(
            "UPDATE ship_live_organizations SET protected = true WHERE organization = $1",
            [org],
          );
          result.protectedOrganizations += 1;
        }
      }
      for (const org of organizations) {
        const { added } = await this.writeEvents(
          client,
          org,
          groups.get(org) ?? [],
          true,
        );
        result.events += added.length;
      }
      return result;
    });
  }

  subscribe(listener: ActivityListener): () => void {
    return this.notifications.subscribe(listener);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.notifications.close();
      await this.pool.end();
    })();
    return this.closing;
  }
}
