export type HealthStatus =
  "healthy" | "degraded" | "down" | "unknown" | "paused";
export interface ProbeInput {
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutMs: number;
  statusMin: number;
  statusMax: number;
  maxLatencyMs: number | null;
  jsonPath: string;
  jsonExpected: string | number | boolean | null;
  failureThreshold: number;
  recoveryThreshold: number;
  enabled: boolean;
}
export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  statusCode: number | null;
  reason: string;
}
export interface HealthCheck extends ProbeResult {
  checkedAt: string;
  status: HealthStatus;
}
export interface DailyLatency {
  date: string;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  checks: number;
}
/** Latency over one fixed window (15 minutes) within the last 24 hours. */
export interface LatencyWindow {
  start: string;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  checks: number;
}
/** Response times of every check in the last 24 hours. */
export interface LatencyStats {
  mean: number;
  /** Population standard deviation. */
  sd: number;
  checks: number;
}
export interface HealthProbe extends ProbeInput {
  id: string;
  serviceId: string;
  hasHeaders: boolean;
  status: HealthStatus;
  lastCheck: HealthCheck | null;
  successRate24h: number | null;
  checks24h: number;
  history: HealthCheck[];
  latencyHistory: DailyLatency[];
  latency24h: LatencyWindow[];
  latencyStats24h: LatencyStats | null;
}
/** A period when a probe was down. */
export interface HealthIncident {
  id: string;
  probeId: string;
  probeName: string;
  openedAt: string;
  resolvedAt: string | null;
  reason: string;
}
export interface HealthService {
  id: string;
  name: string;
  status: HealthStatus;
  probes: HealthProbe[];
  /** Open incidents and those from the last 30 days, newest first. */
  incidents?: HealthIncident[];
}
export interface HealthSnapshot {
  services: HealthService[];
  updatedAt: string;
}

/** Explicit public allowlist: probe targets, headers and conditions stay private. */
export type PublicHealthProbe = Pick<
  HealthProbe,
  | "id"
  | "name"
  | "status"
  | "enabled"
  | "intervalSeconds"
  | "timeoutMs"
  | "lastCheck"
  | "successRate24h"
  | "checks24h"
  | "history"
  | "latencyHistory"
  | "latency24h"
  | "latencyStats24h"
>;
export interface PublicHealthService {
  id: string;
  name: string;
  status: HealthStatus;
  probes: PublicHealthProbe[];
}
export interface SharedHealthSnapshot {
  organization: string;
  services: PublicHealthService[];
  updatedAt: string;
  expiresAt: string;
}
