import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

export function SortableHealthService({
  id,
  name,
  expanded,
  disabled,
  children,
}: {
  id: string;
  name: string;
  expanded: boolean;
  disabled: boolean;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id, disabled, data: { name } });
  return (
    <article
      ref={setNodeRef}
      className={`health-service ${expanded ? "is-expanded" : ""} ${isDragging ? "is-dragging" : ""} ${isOver && !isDragging ? "is-drop-target" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children(
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="health-drag-handle"
          {...attributes}
          {...listeners}
          disabled={disabled}
          aria-label={`Reorder ${name}`}
        >
          <GripVertical aria-hidden="true" size={16} />
        </button>,
      )}
    </article>
  );
}
