import { useCallback, useEffect, useState } from "react";
import type { EngineeringWallSnapshot } from "../../shared/wall.js";
import type { HealthSnapshot } from "../../shared/health.js";

const empty: EngineeringWallSnapshot = { repositories: [], updatedAt: "" };

export function useEngineeringWall(workspaceId?: string, enabled = true) {
  const [data, setData] = useState(empty);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState("");
  const [health, setHealth] = useState<HealthSnapshot>({
    services: [],
    updatedAt: "",
  });
  const refresh = useCallback(async () => {
    if (!workspaceId || !enabled) return;
    try {
      const [response, healthResponse] = await Promise.all([
        fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/wall`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        }),
        fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/health`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null),
      ]);
      if (!response.ok) throw new Error("Could not load engineering signals.");
      setData(await response.json());
      if (healthResponse?.ok) setHealth(await healthResponse.json());
      setError("");
    } catch (reason) {
      setData(empty);
      setHealth({ services: [], updatedAt: "" });
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load engineering signals.",
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId, enabled]);
  useEffect(() => {
    setData(empty);
    setHealth({ services: [], updatedAt: "" });
    setLoading(Boolean(workspaceId));
    void refresh();
    const update = () => void refresh();
    window.addEventListener("ship-live-wall", update);
    const timer = setInterval(update, 30_000);
    return () => {
      window.removeEventListener("ship-live-wall", update);
      clearInterval(timer);
    };
  }, [refresh, workspaceId]);
  return { data, health, loading, error, refresh };
}
