import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActivityEvent } from "../shared/types.js";

interface StoredEvent {
  organization: string;
  event: ActivityEvent;
  restricted: boolean;
}
interface StoreData {
  version: 1;
  records: StoredEvent[];
  deliveries: string[];
  protectedOrganizations: string[];
}
const MAX_EVENTS = 2_000;
const MAX_DELIVERIES = 3_000;

function selectEvent(
  existing: ActivityEvent | undefined,
  incoming: ActivityEvent,
  preferExisting = false,
): ActivityEvent {
  if (!existing) return incoming;
  // Reopening and reclosing an issue must not move its credit into a later week.
  if (existing.type === "issue" && incoming.type === "issue") {
    return Date.parse(existing.occurredAt) <= Date.parse(incoming.occurredAt)
      ? existing
      : incoming;
  }
  return preferExisting ? existing : incoming;
}

export function combineEvents(...groups: ActivityEvent[][]): ActivityEvent[] {
  const events = new Map<string, ActivityEvent>();
  for (const group of groups)
    for (const event of group)
      events.set(event.id, selectEvent(events.get(event.id), event));
  return [...events.values()]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, MAX_EVENTS);
}

/** Local, single-process persistence. Move to a database before running multiple replicas. */
export class EventStore {
  private data: StoreData = {
    version: 1,
    records: [],
    deliveries: [],
    protectedOrganizations: [],
  };
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly file: string | null) {}

  static async open(file: string | null): Promise<EventStore> {
    const store = new EventStore(file);
    if (file) {
      try {
        const data = JSON.parse(await readFile(file, "utf8")) as StoreData;
        if (
          data.version !== 1 ||
          !Array.isArray(data.records) ||
          !Array.isArray(data.deliveries) ||
          !Array.isArray(data.protectedOrganizations)
        ) {
          throw new Error(
            "Unsupported event store format. Back up the store before replacing it.",
          );
        }
        store.data = data;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    return store;
  }

  list(organization: string): ActivityEvent[] {
    return this.data.records
      .filter((record) => record.organization === organization.toLowerCase())
      .map((record) => record.event);
  }

  requiresProtection(organization: string): boolean {
    return this.data.protectedOrganizations.includes(
      organization.toLowerCase(),
    );
  }

  async merge(
    organization: string,
    events: ActivityEvent[],
    options: {
      restricted?: boolean;
      deliveryId?: string;
      preferExisting?: boolean;
    } = {},
  ): Promise<{ duplicate: boolean; added: ActivityEvent[] }> {
    const operation = this.queue.then(async () => {
      const org = organization.toLowerCase();
      if (
        options.deliveryId &&
        this.data.deliveries.includes(options.deliveryId)
      )
        return { duplicate: true, added: [] };
      const records = new Map(
        this.data.records.map((record) => [
          `${record.organization}:${record.event.id}`,
          record,
        ]),
      );
      const added: ActivityEvent[] = [];
      for (const event of events) {
        const key = `${org}:${event.id}`;
        const existing = records.get(key);
        if (!existing) added.push(event);
        records.set(key, {
          organization: org,
          event: selectEvent(existing?.event, event, options.preferExisting),
          restricted: Boolean(options.restricted || existing?.restricted),
        });
      }
      const protectedOrganizations = new Set(this.data.protectedOrganizations);
      if (options.restricted) protectedOrganizations.add(org);
      const next: StoreData = {
        version: 1,
        records: [...records.values()]
          .sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt))
          .slice(0, MAX_EVENTS),
        deliveries: [
          ...this.data.deliveries,
          ...(options.deliveryId ? [options.deliveryId] : []),
        ].slice(-MAX_DELIVERIES),
        protectedOrganizations: [...protectedOrganizations],
      };
      if (this.file && JSON.stringify(next) !== JSON.stringify(this.data)) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, this.file);
      }
      this.data = next;
      return { duplicate: false, added };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
