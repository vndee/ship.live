import { useEffect, useState } from "react";
import type { Recap } from "../../shared/recap";
export function useRecap(workspaceId: string, scopeKey: string, week?: string) {
  const key = JSON.stringify([workspaceId, scopeKey, week]);
  const [state, setState] = useState<{
    key: string;
    data?: Recap;
    error?: string;
  }>({ key });
  const [revision, reload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ key });
    fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/recap${week ? `?week=${encodeURIComponent(week)}` : ""}`,
      {
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not load the recap.");
        if (active) setState({ key, data: body });
      })
      .catch((error) => {
        if (active) setState({ key, error: error.message });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, workspaceId, week, revision]);
  return {
    ...(state.key === key ? state : {}),
    retry: () => reload((r) => r + 1),
    invalidate: (error: string) => setState({ key, error }),
  };
}
