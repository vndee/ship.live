# Webhooks

Team workspaces send events to other services and receive events from them. Any team member can manage a workspace's webhooks on the **Webhooks** page.

- **Outbound webhooks** post activity, CI and deployment changes, Service Health incidents, inbound alerts, and a weekly digest to Slack, Discord, Microsoft Teams, Google Chat, Lark / Feishu, or any HTTPS endpoint. Every body is a template.
- **Inbound webhooks** accept JSON from Grafana, Sentry, a CI system, or anything else that can POST, map it to a title, details, and link, and pass it on through outbound webhooks.

Webhooks store URLs, header values, and secrets encrypted with `TOKEN_ENCRYPTION_KEY`; without that key the page is read-only.

## Events

| Event                                                             | When                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `activity.merge`, `.review`, `.release`, `.pr`, `.issue`, `.push` | A live GitHub webhook adds new activity. Imported history never sends.         |
| `pipeline.failed`, `pipeline.recovered`                           | A check, status, or workflow starts failing, or passes after failing.          |
| `deployment.succeeded`, `deployment.failed`                       | A deployment finishes.                                                         |
| `incident.opened`, `incident.resolved`                            | A probe goes down, and when it is healthy again.                               |
| `health.degraded`, `health.down`, `health.recovered`              | Any probe state change.                                                        |
| `inbound.<slug>`                                                  | An inbound webhook receives a request. Subscribe to `inbound` for all of them. |
| `digest.weekly`                                                   | Monday after 09:00 UTC, for the previous Monday–Sunday.                        |

Each event is stored once. A redelivered GitHub webhook, a replayed check, or an inbound retry with the same ID does not send twice.

### Payload

Templates render this object; the **Generic JSON** preset sends it as is.

```json
{
  "version": 1,
  "id": "6b0e…",
  "type": "incident.opened",
  "occurredAt": "2026-09-10T08:05:09.000Z",
  "workspace": { "id": "…", "name": "Acme Team" },
  "summary": "Incident: Public API / Health is down",
  "url": "https://github.com/…",
  "data": {}
}
```

`summary` is one line for people. `url` appears when the event has a page to open. `data` depends on the event; the editor's preview shows a sample of each. Probe URLs, headers, and conditions are private Service Health settings and never appear in `data`. Journal notes never leave ship.live.

## Presets

A preset fills in the body, content type, signing, and success check. Everything stays editable, and editing the body turns the preset into **Custom**.

| Preset          | Where to get the URL                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Slack           | An incoming webhook in your Slack app.                                                                          |
| Discord         | The channel's **Integrations → Webhooks**.                                                                      |
| Microsoft Teams | A Teams Workflows flow, **Post to a channel when a webhook request is received**; the body is an Adaptive Card. |
| Google Chat     | The space's **Apps & integrations → Webhooks**.                                                                 |
| Lark / Feishu   | A custom bot in the group. Paste the bot's secret if signature verification is on.                              |
| Generic JSON    | Your own endpoint. Generate a signing secret and verify it as shown below.                                      |

Chat presets color alerts red, recoveries green, and degraded probes amber where the service supports it.

## Templates

Templates use a small Handlebars-like language. They run no code, and only a value's own fields can be read.

| Syntax                                                    | Meaning                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `{{summary}}`, `{{data.pipeline.name}}`                   | Insert a value. Missing values insert nothing.                     |
| `{{#if url}}…{{else if …}}…{{else}}…{{/if}}`              | Conditions. Empty text, 0, false, null, and empty lists are false. |
| `{{#unless value}}…{{/unless}}`                           | The opposite of `if`.                                              |
| `{{#each list}}{{@index}} {{this}}{{/each}}`              | Loops, with `@index`, `@first`, and `@last`. At most 100 items.    |
| `{{#with data.deployment}}{{environment}}{{/with}}`       | Read from a nested value.                                          |
| `{{helper value "text"}}`, `(helper …)`                   | Helpers; parentheses nest one inside another.                      |
| `{{! note }}`, `{{~ … ~}}`                                | Comments, and trimming the whitespace beside a tag.                |
| `{{@delivery.attempt}}`, `.timestamp`, `.id`, `.larkSign` | This delivery rather than the event.                               |

Helpers: `json`, `default`, `truncate`, `upper`, `lower`, `replace`, `date` (`datetime`, `date`, `time`, `iso`, `unix`, in UTC), `number`, `percent`, `plural`, `join`, `length`, `lookup`, `contains`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `slack` (escapes `&`, `<`, `>`), and `markdown`. For example:

```text
{{#if (and (eq type "deployment.failed") (eq data.deployment.environment "production"))}}🚨 {{truncate summary 120}}{{/if}}
```

With the `application/json` content type, an inserted value is escaped for a JSON string, so write `"text": "{{summary}}"`. `{{json value}}` inserts a complete JSON value. The rendered body must be valid JSON. Saving renders a sample of every subscribed event, so a template that breaks for one of them is caught before it is used. `text/plain` and form bodies insert values as they are.

Templates are limited to 16 KiB, eight levels of blocks, and a 256 KiB rendered body.

## Filters and cooldown

Filters narrow an endpoint's events. Each is a list of patterns, one per line; `*` matches anything, matching ignores case, and a leading `!` excludes. A filter applies only to events that carry its field, so a production-only environment filter still lets activity through.

| Filter           | Reads                                   |
| ---------------- | --------------------------------------- |
| Repositories     | Activity, CI, and deployment repository |
| Branches         | The branch of a merge or push           |
| Environments     | A deployment's environment              |
| Services         | The Service Health service name         |
| People           | The GitHub login, such as `!*[bot]`     |
| Summary contains | Text in the summary                     |

A **cooldown** skips repeated alerts about the same probe, pipeline, deployment environment, or inbound source for that many seconds. Recoveries always send and end the cooldown. Skipped deliveries appear in the log.

## Delivery

Deliveries leave from the server within seconds. Each request has:

- `Content-Type` from the webhook and `User-Agent: ship.live-webhooks/1`
- `X-Ship-Event`, `X-Ship-Delivery`, and `X-Ship-Timestamp`
- `X-Ship-Signature` when the webhook has a signing secret
- your custom headers, whose values stay hidden after saving

A 2xx response succeeds. When a service answers 200 with an error in the body, add a **success check**: a JSON path and the value it must have. Lark's preset requires `code` to be `0`.

Network errors, timeouts (10 seconds), 408, 425, 429, 5xx, and failed success checks are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours, or later when `Retry-After` asks; the sixth failure is final. Other 4xx answers fail at once. 410 Gone also pauses the webhook until someone turns it back on.

The delivery log keeps 30 days: the request body, the response status and first KiB, the error, and when the next attempt runs. **Redeliver** sends a finished delivery again. **Send test** posts a sample event with the saved settings, ignoring filters and cooldown.

Requests reach only public addresses: the host is resolved once, every address must be public, the connection uses that address, and redirects are not followed.

### Verifying ship.live's signature

`X-Ship-Signature` is `v1=` and the hex HMAC-SHA256, keyed by the signing secret, of `<X-Ship-Timestamp>.<raw body>`. Reject old timestamps to stop replays.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, timestamp, rawBody, signature) {
  const expected = `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return (
    fresh &&
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
```

### Lark and Feishu

With **Lark** signing and the bot's secret, each delivery computes Lark's `sign`: base64 HMAC-SHA256 keyed by `"<timestamp>\n<secret>"` over an empty message. The preset places it in the body with `{{@delivery.timestamp}}` and `{{@delivery.larkSign}}`, and Lark's `code: 0` reply marks success.

## Privacy

Team members may see different repositories. Saving a webhook pins the saver's current repositories to it, like a share link, and every delivery also requires that person to still be a member with access to the repository, checked again before every attempt, including retries. Activity and CI events from other repositories never reach the webhook, and the weekly digest counts only the webhook's repositories. Saving someone else's webhook makes you its owner. Service Health events and incidents are visible to every team member and are not narrowed.

## Inbound webhooks

An inbound webhook's URL, `https://<your ship.live>/api/hooks/<token>`, is its credential and is shown once. **New URL** replaces it at once. For extra assurance, require a secret: requests must then send `X-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, the format GitHub uses.

Requests must be JSON, up to 256 KiB. The mapping's text templates read the body as `payload`:

| Field       | Example                                                              |
| ----------- | -------------------------------------------------------------------- |
| Title       | `{{payload.title}}{{#if payload.state}} is {{payload.state}}{{/if}}` |
| Details     | `{{payload.message}}`                                                |
| Link        | `{{payload.url}}`; kept only when it renders an `https` URL          |
| Delivery ID | `{{payload.id}}`; requests with the same ID count once               |

A request whose title renders empty is rejected with 422. Each accepted request becomes an `inbound.<slug>` event with the title as its summary, the details in `data.body`, and the payload in `data.payload` when it is under 16 KiB. The page lists each endpoint's recent requests, accepted or not.

## Weekly digest

After Monday 09:00 UTC, each team workspace with a webhook listening to `digest.weekly` gets one digest for the previous week. Its `data` has the week's totals (merges, reviews, releases, contributors, XP by the leaderboard's rules), the top five contributors, the busiest repositories, and each service's uptime and incident count. A webhook added after Monday's send time starts the following week.

## Limits

| Limit                           | Value                              |
| ------------------------------- | ---------------------------------- |
| Outbound webhooks per workspace | 20                                 |
| Inbound webhooks per workspace  | 10                                 |
| Inbound requests                | 600 a minute from each IP address  |
| Events per webhook              | 30                                 |
| Filter patterns per list        | 50                                 |
| Custom headers                  | 20, 8 KiB in total                 |
| Delivery and inbound log        | 30 days; inbound keeps 50 requests |
| Incident history                | 1 year                             |
