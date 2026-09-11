import { useCallback, useEffect, useState } from "react";
import type {
  InboundHookInput,
  SavedInboundHook,
  SavedWebhook,
  WebhookDeliveryView,
  WebhookInput,
  WebhookSettings,
  WebhookTestResult,
} from "../../shared/webhook-api";

async function call<T>(
  path: string,
  csrfToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "The request could not be completed. Try again.",
    );
  return body as T;
}

/** A team workspace's webhooks, refreshed so delivery status stays current. */
export function useWebhooks(workspaceId: string, csrfToken: string) {
  const base = `/api/workspaces/${workspaceId}`;
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSettings(await call<WebhookSettings>(`${base}/webhooks`, csrfToken));
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not load webhooks.",
      );
    }
  }, [base, csrfToken]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const send = <T>(path: string, method: string, body?: unknown) =>
    call<T>(`${base}${path}`, csrfToken, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    settings,
    error,
    refresh,
    async save(input: WebhookInput, id?: string) {
      const saved = await send<SavedWebhook>(
        id ? `/webhooks/${id}` : "/webhooks",
        id ? "PUT" : "POST",
        input,
      );
      await refresh();
      return saved;
    },
    async remove(id: string) {
      await send(`/webhooks/${id}`, "DELETE");
      await refresh();
    },
    test(id: string, eventType: string) {
      return send<WebhookTestResult>(`/webhooks/${id}/test`, "POST", {
        eventType,
      });
    },
    async deliveries(id: string) {
      return (
        await send<{ deliveries: WebhookDeliveryView[] }>(
          `/webhooks/${id}/deliveries`,
          "GET",
        )
      ).deliveries;
    },
    async redeliver(id: string, deliveryId: string) {
      await send(`/webhooks/${id}/deliveries/${deliveryId}/redeliver`, "POST");
    },
    async saveInbound(input: InboundHookInput, id?: string) {
      const saved = await send<SavedInboundHook>(
        id ? `/inbound/${id}` : "/inbound",
        id ? "PUT" : "POST",
        input,
      );
      await refresh();
      return saved;
    },
    async rotateInbound(id: string) {
      const saved = await send<SavedInboundHook>(
        `/inbound/${id}/rotate`,
        "POST",
      );
      await refresh();
      return saved;
    },
    async removeInbound(id: string) {
      await send(`/inbound/${id}`, "DELETE");
      await refresh();
    },
  };
}
export type WebhookController = ReturnType<typeof useWebhooks>;
