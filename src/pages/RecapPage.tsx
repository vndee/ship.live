import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  CalendarDays,
} from "lucide-react";
import { useRecap } from "../hooks/useRecap";
import {
  resolveRecapWeek,
  RECAP_DAY,
  safeRecapUrl,
  type Recap,
} from "../../shared/recap";
import "./RecapPage.css";
export interface RecapPageProps {
  workspaceId: string;
  csrfToken: string;
  scopeKey: string;
  week?: string;
  onWeekChange?: (week: string) => void;
}
export function RecapPage(props: RecapPageProps) {
  return (
    <RecapScope
      key={JSON.stringify([props.workspaceId, props.scopeKey, props.week])}
      {...props}
    />
  );
}
function RecapScope(props: RecapPageProps) {
  const [localWeek, setLocalWeek] = useState(props.week);
  const selected = props.week ?? localWeek;
  const { data, error, retry, invalidate } = useRecap(
    props.workspaceId,
    props.scopeKey,
    selected,
  );
  const change = (week: string) => {
    if (props.onWeekChange) props.onWeekChange(week);
    else setLocalWeek(week);
  };
  return (
    <section className="recap-page" aria-label="Weekly recap">
      <header className="recap-page__header">
        <div>
          <span className="recap-eyebrow">
            <CalendarDays size={14} /> WEEKLY RECAP
          </span>
          <p>Shipping, people who helped, and what you learned.</p>
        </div>
      </header>
      {error ? (
        <section role="alert" className="recap-card">
          <h2>Could not load the recap</h2>
          <p>{error}</p>
          <button onClick={retry}>Retry recap</button>
        </section>
      ) : !data ? (
        <p role="status">Loading your recap…</p>
      ) : (
        <RecapContent
          key={data.weekStart}
          recap={data}
          {...props}
          onChange={change}
          onAccessDenied={invalidate}
        />
      )}
    </section>
  );
}
function RecapContent({
  recap,
  workspaceId,
  csrfToken,
  onChange,
  onAccessDenied,
}: RecapPageProps & {
  recap: Recap;
  onChange: (week: string) => void;
  onAccessDenied: (message: string) => void;
}) {
  const [reflection, setReflection] = useState(recap.reflection),
    [schedule, setSchedule] = useState(recap.schedule);
  const [savedReflection, setSavedReflection] = useState(recap.reflection);
  const [dateError, setDateError] = useState("");
  const reflectionDirty = reflection !== savedReflection;
  const [noteStatus, setNoteStatus] = useState(""),
    [scheduleStatus, setScheduleStatus] = useState("");
  const [savingNote, setSavingNote] = useState(false),
    [savingSchedule, setSavingSchedule] = useState(false);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/recap`;
  const move = (days: number) =>
    onChange(
      new Date(Date.parse(`${recap.weekStart}T00:00:00Z`) + days * RECAP_DAY)
        .toISOString()
        .slice(0, 10),
    );
  async function save(path: string, body: unknown) {
    const response = await fetch(base + path, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || "Could not save. Please try again.";
      if (response.status === 401 || response.status === 403)
        onAccessDenied(message);
      throw new Error(message);
    }
  }
  const entry = (title: string, url?: string) => {
    const href = safeRecapUrl(url);
    return href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {title}
      </a>
    ) : (
      <span>{title}</span>
    );
  };
  return (
    <>
      <section className="recap-toolbar" aria-label="Recap week">
        <div className="recap-week">
          <button aria-label="Previous week" onClick={() => move(-7)}>
            <ChevronLeft size={18} />
          </button>
          <label>
            Week starting
            <input
              type="date"
              aria-label="Week starting"
              value={recap.weekStart}
              max={resolveRecapWeek().weekStart}
              step={7}
              onChange={(event) => {
                try {
                  onChange(resolveRecapWeek(event.target.value).weekStart);
                } catch (error) {
                  setDateError((error as Error).message);
                }
              }}
            />
          </label>
          <button
            aria-label="Next week"
            disabled={recap.weekStart >= resolveRecapWeek().weekStart}
            onClick={() => move(7)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div>
          {reflectionDirty || savingNote ? (
            <button disabled aria-describedby="recap-export-hint">
              <Download size={16} />
              Export Markdown
            </button>
          ) : (
            <a
              className="recap-export"
              href={`${base}/export?week=${recap.weekStart}`}
            >
              <Download size={16} />
              Export Markdown
            </a>
          )}
          {reflectionDirty && (
            <p id="recap-export-hint" className="recap-export-hint">
              Save your reflection before exporting.
            </p>
          )}
        </div>
      </section>
      {dateError && <p role="alert">{dateError}</p>}
      <p className="recap-basis">
        {recap.workspaceName} · {recap.weekStart}–{recap.weekEnd} · UTC
        Monday–Sunday
      </p>
      <div className="recap-metrics">
        {[
          ["Merges", recap.totals.merges],
          ["Reviews", recap.totals.reviews],
          ["Releases", recap.totals.releases],
          ["Contributors", recap.totals.contributors],
        ].map(([label, value]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p className="recap-coverage">
        Based on stored activity in your currently authorized repositories.
        Missing history may lower totals. Each section shows up to five
        highlights.
      </p>
      <div className="recap-grid">
        <section className="recap-card">
          <h2>Shipped highlights</h2>
          {recap.shipped.length ? (
            <ul>
              {recap.shipped.map((item) => (
                <li key={item.id}>
                  <small>{item.repository}</small>
                  {entry(item.title, item.url)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No merges or releases found for this week.</p>
          )}
        </section>
        <section className="recap-card">
          <h2>Helpful reviewers</h2>
          <p>People who reviewed a teammate’s PR this week.</p>
          {recap.helpfulReviewers.length ? (
            <ul>
              {recap.helpfulReviewers.map((item) => (
                <li key={item.login}>
                  <strong>{item.login}</strong>
                  <span>
                    Helped on {item.pullRequests} PR
                    {item.pullRequests === 1 ? "" : "s"} · {item.reviews}{" "}
                    reviews
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No cross-author reviews confirmed in stored data.</p>
          )}
        </section>
        <section className="recap-card recap-card--wide">
          <h2>Current needs help</h2>
          <p>
            Latest stored PR status as of{" "}
            {new Date(recap.checkedAt).toLocaleString()}. This is current work,
            not a historical snapshot of the recap week.
          </p>
          {recap.needsHelp.length ? (
            <ul>
              {recap.needsHelp.map((item) => (
                <li key={`${item.repository}#${item.number}`}>
                  <small>
                    {item.repository} #{item.number} ·{" "}
                    {item.state === "failing"
                      ? "Checks failing"
                      : "Review or follow-up needed"}
                  </small>
                  {entry(item.title, item.url)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No current PRs needing help found in stored signals.</p>
          )}
        </section>
      </div>
      <section className="recap-card recap-reflection">
        <h2>Your reflection</h2>
        <p>
          Private to you in this workspace and week. Included when you export
          your recap.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSavingNote(true);
            setNoteStatus("");
            try {
              await save("/reflection", { week: recap.weekStart, reflection });
              setSavedReflection(reflection);
              setNoteStatus("Reflection saved.");
            } catch (error) {
              setNoteStatus((error as Error).message);
            } finally {
              setSavingNote(false);
            }
          }}
        >
          <label htmlFor="recap-reflection">
            What mattered or what you learned
          </label>
          <textarea
            id="recap-reflection"
            value={reflection}
            maxLength={5000}
            rows={5}
            onChange={(event) => setReflection(event.target.value)}
            placeholder="A decision that mattered, customer feedback, or something to try next week…"
          />
          <div className="recap-form-footer">
            <button type="submit" disabled={savingNote}>
              {savingNote ? "Saving…" : "Save reflection"}
            </button>
            <span role="status">{noteStatus}</span>
            <small>{reflection.length}/5,000</small>
          </div>
        </form>
      </section>
      <section className="recap-card recap-schedule">
        <h2>Weekly digest delivery</h2>
        <p>
          Set the schedule for this workspace’s enabled weekly digest webhooks.
          Weekly totals always use completed UTC Monday–Sunday weeks.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSavingSchedule(true);
            setScheduleStatus("");
            try {
              await save("/schedule", schedule);
              setScheduleStatus("Schedule saved.");
            } catch (error) {
              setScheduleStatus((error as Error).message);
            } finally {
              setSavingSchedule(false);
            }
          }}
        >
          <div className="recap-schedule-fields">
            <label>
              Digest day
              <select
                value={schedule.weekday}
                onChange={(event) =>
                  setSchedule({
                    ...schedule,
                    weekday: Number(event.target.value),
                  })
                }
              >
                {[
                  "Sunday",
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                ].map((name, index) => (
                  <option value={index} key={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Digest time
              <input
                type="time"
                value={schedule.time}
                required
                onChange={(event) =>
                  setSchedule({ ...schedule, time: event.target.value })
                }
              />
            </label>
            <label>
              Digest timezone
              <input
                value={schedule.timezone}
                required
                list="recap-timezones"
                onChange={(event) =>
                  setSchedule({ ...schedule, timezone: event.target.value })
                }
              />
              <datalist id="recap-timezones">
                {[
                  "UTC",
                  "Asia/Ho_Chi_Minh",
                  "Asia/Singapore",
                  "Asia/Tokyo",
                  "Europe/London",
                  "Europe/Berlin",
                  "America/New_York",
                  "America/Los_Angeles",
                ].map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </label>
          </div>
          <p className="recap-coverage">
            Use an IANA timezone. During daylight saving changes, a skipped time
            moves forward and a repeated time sends at its later occurrence.
            Each recap week is sent once.
          </p>
          <div className="recap-form-footer">
            <button type="submit" disabled={savingSchedule}>
              {savingSchedule ? "Saving…" : "Save schedule"}
            </button>
            <span role="status">{scheduleStatus}</span>
          </div>
        </form>
      </section>
    </>
  );
}
