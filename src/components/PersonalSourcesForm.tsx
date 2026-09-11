import { useState } from "react";
import type { PersonalSources } from "../../shared/workspaces";
import "./personal-sources.css";

export interface SourceOption {
  id: number;
  name: string;
  /** The owner's own GitHub account, or an organization. */
  kind: "personal" | "team";
}

/** Chooses which connected GitHub installations feed a personal dashboard. */
export function PersonalSourcesForm({
  sources,
  options,
  onSave,
  onCancel,
}: {
  sources: PersonalSources;
  options: SourceOption[];
  onSave: (sources: PersonalSources) => Promise<void>;
  onCancel: () => void;
}) {
  const [every, setEvery] = useState(sources.installationIds === null);
  const [chosen, setChosen] = useState(
    () =>
      new Set(sources.installationIds ?? options.map((option) => option.id)),
  );
  const [mineOnly, setMineOnly] = useState(sources.mineOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function toggle(id: number) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave({
        installationIds: every
          ? null
          : options.map((option) => option.id).filter((id) => chosen.has(id)),
        mineOnly,
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save the sources. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="sources-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="modal-description">
        Choose which GitHub accounts and organizations feed your personal
        dashboard. Your journal notes always appear, and only you see this
        dashboard.
      </p>
      {!options.length && (
        <p className="notice">
          No GitHub installations are connected yet. Connect your account or an
          organization in Account and GitHub connections, then choose it here.
        </p>
      )}
      <label className="sources-toggle">
        <input
          type="checkbox"
          checked={mineOnly}
          onChange={(event) => setMineOnly(event.target.checked)}
        />
        <span>
          <strong>Only my activity</strong>
          <small>
            Merges, reviews, pull requests, and pushes you made yourself. Turn
            it off to see everyone&apos;s activity in these sources.
          </small>
        </span>
      </label>
      <fieldset className="sources-choice">
        <legend>Sources</legend>
        <label className="sources-toggle">
          <input
            type="radio"
            name="sources-scope"
            checked={every}
            onChange={() => setEvery(true)}
          />
          <span>
            <strong>Every connected installation</strong>
            <small>Includes the ones you connect later.</small>
          </span>
        </label>
        <label className="sources-toggle">
          <input
            type="radio"
            name="sources-scope"
            checked={!every}
            onChange={() => setEvery(false)}
          />
          <span>
            <strong>Only the ones I choose</strong>
          </span>
        </label>
        {!every && (
          <ul className="sources-list">
            {options.map((option) => (
              <li key={option.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(option.id)}
                    onChange={() => toggle(option.id)}
                  />
                  <span>{option.name}</span>
                  <small>
                    {option.kind === "personal"
                      ? "Your account"
                      : "Organization"}
                  </small>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="sources-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
