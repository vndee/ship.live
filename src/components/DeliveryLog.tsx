import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw, Send } from "lucide-react";
import type {
  WebhookDeliveryView,
  WebhookTestResult,
  WebhookView,
} from "../../shared/webhook-api";
import { ago } from "../lib/format";
import type { WebhookController } from "../hooks/useWebhooks";
import { eventLabel } from "./WebhookEditor";

const STATUS_LABELS: Record<WebhookDeliveryView["status"], string> = {
  pending: "Retrying",
  succeeded: "Delivered",
  failed: "Failed",
  dead: "Gave up",
  skipped: "Skipped",
};

export function DeliveryStatus({
  status,
}: {
  status: WebhookDeliveryView["status"];
}) {
  return (
    <span className={`webhook-status-chip ${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Recent deliveries with their requests and responses, a test send, and redelivery. */
export function DeliveryLog({
  webhook,
  controller,
}: {
  webhook: WebhookView;
  controller: WebhookController;
}) {
  const [deliveries, setDeliveries] = useState<WebhookDeliveryView[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [testType, setTestType] = useState(webhook.events[0] ?? "webhook.test");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const load = useCallback(async () => {
    try {
      setDeliveries(await controller.deliveries(webhook.id));
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load deliveries.",
      );
    }
    // The controller's methods are stable for one workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webhook.id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);
  const now = Date.now();

  return (
    <div className="delivery-log">
      <div className="delivery-test">
        <label>
          Send a sample
          <select
            value={testType}
            onChange={(e) => setTestType(e.target.value)}
          >
            {[...webhook.events, "webhook.test"].map((type) => (
              <option key={type} value={type}>
                {eventLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setResult(null);
            try {
              setResult(await controller.test(webhook.id, testType));
            } catch (failure) {
              setResult({
                ok: false,
                status: null,
                body: "",
                error:
                  failure instanceof Error
                    ? failure.message
                    : "Could not send.",
                latencyMs: 0,
                requestBody: "",
              });
            } finally {
              setTesting(false);
            }
          }}
        >
          <Send size={14} /> {testing ? "Sending…" : "Send test"}
        </button>
      </div>
      <p className="field-hint">
        Tests use the saved settings and skip filters and cooldowns. They are
        not added to the log.
      </p>
      {result && (
        <div
          className={`delivery-result ${result.ok ? "ok" : "failed"}`}
          role="status"
        >
          <strong>
            {result.ok
              ? `Delivered · HTTP ${result.status} in ${result.latencyMs} ms`
              : result.error}
          </strong>
          {result.body && <pre>{result.body}</pre>}
          {result.requestBody && (
            <details>
              <summary>Request body</summary>
              <pre>{result.requestBody}</pre>
            </details>
          )}
        </div>
      )}
      <div className="section-heading">
        <h3>Recent deliveries</h3>
        <button
          className="icon-button"
          aria-label="Refresh deliveries"
          title="Refresh deliveries"
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {deliveries && !deliveries.length && (
        <p className="field-hint">
          No deliveries yet. Matching events appear here within seconds.
        </p>
      )}
      <ul className="delivery-list">
        {deliveries?.map((delivery) => (
          <li key={delivery.id} className="delivery-row">
            <button
              className="delivery-summary"
              aria-expanded={open === delivery.id}
              onClick={() => setOpen(open === delivery.id ? null : delivery.id)}
            >
              <DeliveryStatus status={delivery.status} />
              <span className="delivery-event">
                <strong>{eventLabel(delivery.eventType)}</strong>
                <span>{delivery.summary}</span>
              </span>
              <span className="delivery-meta">
                {delivery.responseStatus !== null &&
                  `HTTP ${delivery.responseStatus} · `}
                {delivery.attempts > 1 && `${delivery.attempts} attempts · `}
                {ago(delivery.finishedAt ?? delivery.createdAt, now)}
              </span>
            </button>
            {open === delivery.id && (
              <div className="delivery-details">
                {delivery.error && (
                  <p className="form-error">{delivery.error}</p>
                )}
                {delivery.nextAttemptAt && (
                  <p className="field-hint">
                    Next attempt{" "}
                    {new Date(delivery.nextAttemptAt).toLocaleTimeString()}.
                  </p>
                )}
                {delivery.requestBody && (
                  <details open>
                    <summary>Request body</summary>
                    <pre>{delivery.requestBody}</pre>
                  </details>
                )}
                {delivery.responseBody && (
                  <details>
                    <summary>Response</summary>
                    <pre>{delivery.responseBody}</pre>
                  </details>
                )}
                {delivery.status !== "pending" && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      try {
                        await controller.redeliver(webhook.id, delivery.id);
                        await load();
                      } catch (failure) {
                        setError(
                          failure instanceof Error
                            ? failure.message
                            : "Could not redeliver.",
                        );
                      }
                    }}
                  >
                    <RotateCcw size={13} /> Redeliver
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
