import { Client, type Notification } from "pg";
import type { ActivityListener } from "./store.js";

export const ACTIVITY_CHANNEL = "ship_live_event_changes";

/** LISTEN needs a session connection, separate from the query pool and transactions. */
export class PostgresNotifications {
  private client?: Client;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 250;
  private closed = false;
  private readonly listeners = new Set<ActivityListener>();

  constructor(private readonly databaseUrl: string) {}

  async start(): Promise<void> {
    await this.connect();
  }

  subscribe(listener: ActivityListener): () => void {
    if (this.closed) throw new Error("The PostgreSQL event store is closed.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    if (this.closed) return;
    const client = new Client({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      fallback_application_name: "ship.live-listener",
    });
    this.client = client;
    const disconnected = () => {
      if (this.client !== client) return;
      this.client = undefined;
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on("error", disconnected);
    client.on("end", disconnected);
    client.on("notification", (message: Notification) => this.receive(message));
    try {
      await client.connect();
      if (this.closed || this.client !== client) {
        await client.end();
        return;
      }
      await client.query(`LISTEN ${ACTIVITY_CHANNEL}`);
      if (this.client !== client)
        throw new Error("The PostgreSQL listener disconnected during startup.");
      this.retryDelay = 250;
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, this.retryDelay);
    this.reconnectTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
  }

  private receive(message: Notification): void {
    if (this.closed || message.channel !== ACTIVITY_CHANNEL || !message.payload)
      return;
    let reference: unknown;
    try {
      reference = JSON.parse(message.payload);
    } catch {
      return;
    }
    if (
      !reference ||
      typeof reference !== "object" ||
      !("organization" in reference) ||
      typeof reference.organization !== "string" ||
      !("eventId" in reference) ||
      typeof reference.eventId !== "string" ||
      !reference.organization ||
      !reference.eventId
    )
      return;
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(
          listener(reference.organization, reference.eventId),
        ).catch(() =>
          console.error("An activity notification subscriber failed."),
        );
      } catch {
        console.error("An activity notification subscriber failed.");
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
    await this.connecting?.catch(() => undefined);
  }
}
