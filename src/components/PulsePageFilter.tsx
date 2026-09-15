import type { PulseRange, PulseSelection } from "../../shared/pulse";
import { PulseRangePicker } from "./PulseRangePicker";
import "../pulse-range.css";

export function PulsePageFilter({
  selection,
  range,
  now,
  onChange,
}: {
  selection: PulseSelection;
  range: PulseRange | null;
  now: number;
  onChange: (selection: PulseSelection) => void;
}) {
  return (
    <section className="pulse-page-filter" aria-label="Dashboard date range">
      <PulseRangePicker selection={selection} now={now} onChange={onChange} />
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
    </section>
  );
}
