import { useState } from "react";
import "./pulse-heading.css";

const TITLE_MAX = 80;
const SUBTITLE_MAX = 200;

/** Edits a workspace's Pulse heading; empty fields fall back to the default. */
export function PulseHeadingForm({
  title,
  subtitle,
  defaultTitle,
  team,
  onSave,
  onCancel,
}: {
  title?: string;
  subtitle?: string;
  defaultTitle: string;
  team: boolean;
  onSave: (title: string, subtitle: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [nextTitle, setTitle] = useState(title ?? "");
  const [nextSubtitle, setSubtitle] = useState(subtitle ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(values: [string, string]) {
    setBusy(true);
    setError("");
    try {
      await onSave(values[0].trim(), values[1].trim());
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save the heading. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pulse-heading-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save([nextTitle, nextSubtitle]);
      }}
    >
      <p className="modal-description">
        {team
          ? "Everyone in this workspace sees this heading on Pulse, the wall display, and shared links."
          : "Only you see this heading on your journal's Pulse."}
      </p>
      <label>
        Title
        <input
          aria-label="Title"
          value={nextTitle}
          maxLength={TITLE_MAX}
          placeholder={defaultTitle}
          onChange={(event) => setTitle(event.target.value)}
        />
        <small aria-hidden="true">
          {[...nextTitle].length}/{TITLE_MAX}
        </small>
      </label>
      <label>
        Subtitle
        <textarea
          aria-label="Subtitle"
          rows={2}
          value={nextSubtitle}
          maxLength={SUBTITLE_MAX}
          placeholder="Optional: a line under the title"
          onChange={(event) => setSubtitle(event.target.value)}
        />
        <small aria-hidden="true">
          {[...nextSubtitle].length}/{SUBTITLE_MAX}
        </small>
      </label>
      <p className="field-hint">Leave a field empty to use the default.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="pulse-heading-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy || (!title && !subtitle)}
          onClick={() => void save(["", ""])}
        >
          Reset to default
        </button>
        <span />
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
