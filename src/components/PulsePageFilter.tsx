import { RefreshCw } from "lucide-react";
import type {
  PulseOverview,
  PulseRange,
  PulseSelection,
} from "../../shared/pulse";
import { PulseCoverage } from "./PulseCoverage";
import { PulseRangePicker } from "./PulseRangePicker";
import "../pulse-range.css";

export function PulsePageFilter({
  selection,
  range,
  now,
  onChange,
  overview,
  demo,
  onRefresh,
  refreshing = false,
}: {
  onRefresh?: () => void;
  refreshing?: boolean;
  overview?: PulseOverview | null;
  demo?: boolean;
  selection: PulseSelection;
  range: PulseRange | null;
  now: number;
  onChange: (selection: PulseSelection) => void;
}) {
  return (
    <section className="pulse-page-filter" aria-label="Dashboard date range">
      <div className="pulse-filter-controls">
        <PulseRangePicker selection={selection} now={now} onChange={onChange} />
        {onRefresh && (
          <button
            className="text-button pulse-refresh"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh dashboard"
            aria-busy={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>
      <p>
        Applies to every tab and activity.
        {range && (
          <>
            {" "}
            <span>
              {range.from} — {range.to}
            </span>
          </>
        )}
      </p>
      {range && range.to < new Date(now).toISOString().slice(0, 10) && (
        <p className="pulse-history-note">
          Historical view · refresh to check for imported activity.
        </p>
      )}
      {overview && <PulseCoverage data={overview} demo={demo} />}
    </section>
  );
}
