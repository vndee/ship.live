import { useEffect, useState } from "react";
import { resolvePulseRange, type PulseSelection } from "../../shared/pulse";
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
      <label>
        Period{" "}
        <select
          aria-label="Overview period"
          value={preset}
          onChange={(event) => {
            const value = event.target.value as NonNullable<
              PulseSelection["period"]
            >;
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
        >
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="custom">Custom dates</option>
        </select>
      </label>
      {preset === "custom" && (
        <>
          <label>
            From{" "}
            <input
              aria-label="From date"
              type="date"
              required
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
              value={to}
              max={new Date(now).toISOString().slice(0, 10)}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button className="button secondary" type="submit">
            Apply dates
          </button>
        </>
      )}
      <span className="pulse-timezone">UTC · up to 366 days</span>
      {error && (
        <p className="pulse-range-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
