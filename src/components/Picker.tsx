import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import "./picker.css";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

/** A compact dropdown styled like the app, in place of the platform's menu. */
export function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[current];
  // An option to focus once the list renders, when it is not open yet.
  const pending = useRef<number | null>(null);
  const optionsIn = () =>
    root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
  function focusOption(index: number) {
    const items = optionsIn();
    if (items?.length) items[index]?.focus();
    else pending.current = index;
  }
  useLayoutEffect(() => {
    if (!open || pending.current === null) return;
    optionsIn()?.[pending.current]?.focus();
    pending.current = null;
  }, [open]);
  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  function step(event: KeyboardEvent, from: number) {
    const last = options.length - 1;
    const next = {
      ArrowDown: Math.min(last, from + 1),
      ArrowUp: Math.max(0, from - 1),
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return false;
    event.preventDefault();
    setOpen(true);
    focusOption(next);
    return true;
  }
  return (
    <div className="picker" ref={root}>
      <span className="picker-label" aria-hidden="true">
        {label}
      </span>
      <div className="picker-control">
        <button
          ref={trigger}
          type="button"
          className="picker-trigger"
          aria-label={`${label}: ${selected?.label ?? ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            setOpen(!open);
            if (!open) focusOption(current);
          }}
          onKeyDown={(event) => {
            if (step(event, current - (event.key === "ArrowDown" ? 1 : 0)))
              return;
            if (event.key === "Escape" && open) {
              event.preventDefault();
              close();
            }
          }}
        >
          <span>{selected?.label}</span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={open ? "open" : ""}
          />
        </button>
        {open && (
          <div className="picker-menu" role="listbox" aria-label={label}>
            {options.map((option, index) => (
              <button
                type="button"
                role="option"
                key={option.value}
                aria-selected={option.value === value}
                tabIndex={option.value === value ? 0 : -1}
                onClick={() => {
                  onChange(option.value);
                  close(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    close(true);
                  } else if (event.key === "Tab") setOpen(false);
                  else step(event, index);
                }}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <Check size={13} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
