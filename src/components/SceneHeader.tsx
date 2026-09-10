import type { ReactNode } from "react";

/** A wall scene's title and description, with optional controls beside them. */
export function SceneHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="scene-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children && <div className="scene-chips">{children}</div>}
    </div>
  );
}
