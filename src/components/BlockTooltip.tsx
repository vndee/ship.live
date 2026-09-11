import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";

interface Tip {
  lines: string[];
  center: number;
  top: number;
  below: boolean;
}

/**
 * Hover, or tap, details for the blocks of a status strip. Each block keeps
 * its text in data-tip, one line per "\n". The tooltip is fixed to the
 * viewport, so a card's clipped edges never cut it off.
 */
export function useBlockTooltip<T extends HTMLElement>({ tap = true } = {}) {
  const ref = useRef<T>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  function show(target: EventTarget) {
    const block =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-tip]")
        : null;
    if (!block || !ref.current?.contains(block)) {
      setTip(null);
      return;
    }
    const box = block.getBoundingClientRect();
    // Near the top of the window, the tooltip opens below the block.
    const below = box.top < 80;
    setTip({
      lines: (block.dataset.tip ?? "").split("\n"),
      center: box.left + box.width / 2,
      top: below ? box.bottom + 8 : box.top - 8,
      below,
    });
  }
  // Centered on the block, but never past the window's edges.
  useLayoutEffect(() => {
    if (!tip || !tipRef.current) {
      setLeft(null);
      return;
    }
    const width = tipRef.current.offsetWidth;
    setLeft(
      Math.min(
        window.innerWidth - width - 8,
        Math.max(8, tip.center - width / 2),
      ),
    );
  }, [tip]);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const outside = (event: globalThis.PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [tip]);
  const handlers = {
    onPointerOver: (event: PointerEvent<T>) => {
      if (event.pointerType !== "touch") show(event.target);
    },
    onPointerLeave: (event: PointerEvent<T>) => {
      if (event.pointerType !== "touch") setTip(null);
    },
    ...(tap ? { onClick: (event: MouseEvent<T>) => show(event.target) } : {}),
  };
  // The strip's own label already describes every block to assistive technology.
  const tooltip = tip ? (
    <span
      ref={tipRef}
      className={`block-tooltip${tip.below ? " below" : ""}`}
      aria-hidden="true"
      style={{
        top: tip.top,
        left: left ?? 0,
        visibility: left === null ? "hidden" : undefined,
      }}
    >
      {tip.lines.map((line, index) =>
        index === 0 ? (
          <strong key={index}>{line}</strong>
        ) : (
          <span key={index}>{line}</span>
        ),
      )}
    </span>
  ) : null;
  return { ref, handlers, tooltip };
}
