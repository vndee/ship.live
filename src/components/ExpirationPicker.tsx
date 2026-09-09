import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Clock3 } from "lucide-react";
import {
  moveShareDuration,
  NO_EXPIRATION_SECONDS,
  SHARE_DURATIONS,
} from "../../shared/shares";
import "./expiration-picker.css";

const DURATION_GROUPS = [
  { label: "Hours", durations: SHARE_DURATIONS.slice(0, 4) },
  { label: "Days", durations: SHARE_DURATIONS.slice(4, 10) },
  { label: "Years", durations: SHARE_DURATIONS.slice(10) },
] as const;

export function ExpirationPicker({
  label,
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  disabled: boolean;
  onChange: (seconds: number) => void;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected =
    SHARE_DURATIONS.find((duration) => duration.seconds === value) ??
    SHARE_DURATIONS[3];

  function focusOption(seconds: number) {
    requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-duration="${seconds}"]`)
        ?.focus();
    });
  }

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
  }

  function choose(seconds: number) {
    onChange(seconds);
    close(true);
  }

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function handleOptionKey(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: number,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = moveShareDuration(
      current,
      event.key as "ArrowUp" | "ArrowDown" | "Home" | "End",
    );
    focusOption(next);
  }

  return (
    <div className="share-expiration" ref={root}>
      <span className="expiration-label">{label}</span>
      <div className="expiration-control">
        <button
          ref={trigger}
          type="button"
          className="expiration-trigger"
          aria-label={`${ariaLabel}: ${selected.label}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={disabled}
          onClick={() => {
            const nextOpen = !open;
            setOpen(nextOpen);
            if (nextOpen) focusOption(value);
          }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              focusOption(
                event.key === "ArrowUp" || event.key === "End"
                  ? SHARE_DURATIONS.at(-1)!.seconds
                  : event.key === "Home"
                    ? SHARE_DURATIONS[0].seconds
                    : value,
              );
            }
            if (event.key === "Escape" && open) {
              event.preventDefault();
              close();
            }
          }}
        >
          <Clock3 size={14} aria-hidden="true" />
          <span>{selected.label}</span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={open ? "open" : ""}
          />
        </button>
        {open && (
          <div
            className="expiration-menu"
            id={menuId}
            role="listbox"
            aria-label={ariaLabel}
          >
            {DURATION_GROUPS.map((group) => (
              <div
                className="expiration-group"
                key={group.label}
                role="group"
                aria-label={group.label}
              >
                <span className="expiration-group-label">{group.label}</span>
                <div className="expiration-options">
                  {group.durations.map((duration) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={duration.seconds === value}
                      tabIndex={duration.seconds === value ? 0 : -1}
                      data-duration={duration.seconds}
                      key={duration.seconds}
                      onClick={() => choose(duration.seconds)}
                      onKeyDown={(event) =>
                        handleOptionKey(event, duration.seconds)
                      }
                    >
                      <span>
                        {duration.label}
                        {"detail" in duration && (
                          <small>{duration.detail}</small>
                        )}
                      </span>
                      {duration.seconds === value && (
                        <Check size={13} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {value === NO_EXPIRATION_SECONDS && (
        <p className="expiration-note">
          Stored as a 100-year link. You can rotate or revoke it anytime.
        </p>
      )}
    </div>
  );
}
