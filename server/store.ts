import type { ActivityEvent } from "../shared/types.js";

export const FEED_LIMIT = 2_000;

export interface MergeOptions {
  restricted?: boolean;
  deliveryId?: string;
  preferExisting?: boolean;
}

export interface MergeResult {
  duplicate: boolean;
  added: ActivityEvent[];
}

export type ActivityListener = (organization: string, eventId: string) => void;

export interface EventStore {
  ping(): Promise<void>;
  list(organization: string): Promise<ActivityEvent[]>;
  get(
    organization: string,
    eventId: string,
  ): Promise<ActivityEvent | undefined>;
  requiresProtection(organization: string): Promise<boolean>;
  protectOrganization(organization: string): Promise<void>;
  merge(
    organization: string,
    events: ActivityEvent[],
    options?: MergeOptions,
  ): Promise<MergeResult>;
  subscribe(listener: ActivityListener): () => void;
  close(): Promise<void>;
}

export function selectEvent(
  existing: ActivityEvent | undefined,
  incoming: ActivityEvent,
  preferExisting = false,
): ActivityEvent {
  if (!existing) return incoming;
  // A reopen/reclose cycle cannot move issue credit into a later week.
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
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
    )
    .slice(0, FEED_LIMIT);
}

/** An ephemeral adapter for isolated tests; the server uses PostgreSQL. */
export class MemoryEventStore implements EventStore {
  private records = new Map<string, Map<string, ActivityEvent>>();
  private deliveries = new Set<string>();
  private protectedOrganizations = new Set<string>();
  private listeners = new Set<ActivityListener>();

  async ping(): Promise<void> {}

  async list(organization: string): Promise<ActivityEvent[]> {
    return structuredClone(
      combineEvents([
        ...(this.records.get(organization.toLowerCase())?.values() ?? []),
      ]),
    );
  }

  async get(
    organization: string,
    eventId: string,
  ): Promise<ActivityEvent | undefined> {
    const event = this.records.get(organization.toLowerCase())?.get(eventId);
    return event ? structuredClone(event) : undefined;
  }

  async requiresProtection(organization: string): Promise<boolean> {
    return this.protectedOrganizations.has(organization.toLowerCase());
  }

  async protectOrganization(organization: string): Promise<void> {
    this.protectedOrganizations.add(organization.toLowerCase());
  }

  async merge(
    organization: string,
    events: ActivityEvent[],
    options: MergeOptions = {},
  ): Promise<MergeResult> {
    if (options.deliveryId && this.deliveries.has(options.deliveryId))
      return { duplicate: true, added: [] };
    const org = organization.toLowerCase();
    const records = this.records.get(org) ?? new Map<string, ActivityEvent>();
    const added: ActivityEvent[] = [];
    for (const event of events) {
      const existing = records.get(event.id);
      const selected = structuredClone(
        selectEvent(existing, event, options.preferExisting),
      );
      if (!existing) added.push(selected);
      records.set(event.id, selected);
    }
    this.records.set(org, records);
    if (options.restricted) this.protectedOrganizations.add(org);
    if (options.deliveryId) {
      this.deliveries.add(options.deliveryId);
      for (const eventId of new Set(events.map((event) => event.id))) {
        for (const listener of this.listeners) listener(org, eventId);
      }
    }
    return { duplicate: false, added };
  }

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}
