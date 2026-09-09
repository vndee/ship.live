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
}
export interface HealthService {
  id: string;
  name: string;
  status: HealthStatus;
  probes: HealthProbe[];
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
