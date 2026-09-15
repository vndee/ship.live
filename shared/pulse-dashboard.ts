import type { ActivityEvent } from "./types.js";
import type { PulseRange, PulseOverview } from "./pulse.js";
import type { EngineeringWallSnapshot } from "./wall.js";
import type { HealthSnapshot } from "./health.js";

/** One authorized period snapshot shared by every Pulse tab. */
export interface PulseDashboard {
  range: PulseRange;
  overview: PulseOverview;
  events: ActivityEvent[];
  wall: EngineeringWallSnapshot;
  /** Private workspaces only; dashboard share tokens cannot authorize health. */
  health?: HealthSnapshot;
}
