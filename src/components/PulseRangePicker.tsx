import { useEffect, useState } from "react";
import { resolvePulseRange, type PulseSelection } from "../../shared/pulse";
import { Picker, type PickerOption } from "./Picker";

const periods: readonly PickerOption<NonNullable<PulseSelection["period"]>>[] =
  [
    { value: "today", label: "Today" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "month", label: "This month" },
    { value: "custom", label: "Custom dates" },
  ];

export function PulseRangePicker({
  selection,
  now,
  onChange,
}: {
  selection: PulseSelection;
  now: number;
  onChange: (selection: PulseSelection) => void;
}) {
  const [preset, setPreset] = useState(selection.period || "7d");
  const [from, setFrom] = useState(selection.from || "");
  const [to, setTo] = useState(selection.to || "");
  const [error, setError] = useState("");
  useEffect(() => {
    setPreset(selection.period || "7d");
    setFrom(selection.from || "");
    setTo(selection.to || "");
    setError("");
  }, [selection.period, selection.from, selection.to]);
  return (
    <form
      className="pulse-range-picker"
      onSubmit={(event) => {
        event.preventDefault();
        const next: PulseSelection = { period: "custom", from, to };
        try {
          resolvePulseRange(next, now);
          setError("");
          onChange(next);
        } catch (error) {
          setError(
            error instanceof Error ? error.message : "Choose valid dates.",
          );
        }
      }}
    >
      <div className="pulse-range-controls">
        <Picker
          label="Period"
          value={preset}
          options={periods}
          onChange={(value) => {
            if (value === preset) return;
            setPreset(value);
            setError("");
            if (value === "custom") {
              try {
                const range = resolvePulseRange(selection, now);
                setFrom(range.from);
                setTo(range.to);
              } catch {
                /* Keep invalid URL fields available to correct. */
              }
            } else onChange({ period: value });
          }}
        />
        <span className="pulse-timezone">Dates in UTC</span>
      </div>
      {preset === "custom" && (
        <div className="pulse-custom-dates">
          <label>
            From{" "}
            <input
              aria-label="From date"
              type="date"
              required
              aria-describedby="pulse-date-guidance"
              value={from}
              max={new Date(now).toISOString().slice(0, 10)}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To{" "}
            <input
              aria-label="To date"
              type="date"
              required
              aria-describedby="pulse-date-guidance"
              value={to}
              max={new Date(now).toISOString().slice(0, 10)}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button className="button secondary" type="submit">
            Apply dates
          </button>
          <p id="pulse-date-guidance" className="pulse-date-guidance">
            Choose up to 366 days. Both dates are included.
          </p>
        </div>
      )}
      {error && (
        <p className="pulse-range-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
