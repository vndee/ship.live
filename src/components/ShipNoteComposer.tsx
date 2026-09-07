import { useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import type { ShipNoteInput } from "../../shared/workspaces";

export function ShipNoteComposer({
  onSave,
}: {
  onSave: (input: ShipNoteInput) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave({ title: title.trim(), body: body.trim() });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save your note. Your draft is still here.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <p className="modal-description">
        What moved forward? Capture a launch, a lesson, or a small win that a
        commit cannot explain.
      </p>
      <label className="field-label" htmlFor="note-title">
        What did you ship?
      </label>
      <input
        className="text-input"
        id="note-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Shipped the first version of…"
        maxLength={200}
        required
        autoComplete="off"
      />
      <label className="field-label" htmlFor="note-body">
        The story behind it <span>Optional</span>
      </label>
      <textarea
        className="text-input note-input"
        id="note-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What changed, what you learned, what comes next."
        maxLength={10000}
        rows={7}
      />
      <p className="privacy-note">
        <LockKeyhole size={14} /> Saved privately in your journal.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button primary full-width"
        disabled={saving || !title.trim()}
        type="submit"
      >
        {saving && <LoaderCircle size={15} className="spin" />}
        {saving ? "Saving…" : "Save ship note"}
      </button>
    </form>
  );
}
