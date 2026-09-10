/** Outbound webhook events, payload version 1, and body presets. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

export const WEBHOOK_EVENT_GROUPS = [
  {
    id: "activity",
    label: "Activity",
    types: [
      "activity.merge",
      "activity.review",
      "activity.release",
      "activity.pr",
      "activity.issue",
      "activity.push",
    ],
  },
  {
    id: "delivery",
    label: "CI and deployments",
    types: [
      "pipeline.failed",
      "pipeline.recovered",
      "deployment.succeeded",
      "deployment.failed",
    ],
  },
  {
    id: "health",
    label: "Service Health",
    types: [
      "incident.opened",
      "incident.resolved",
      "health.degraded",
      "health.down",
      "health.recovered",
    ],
  },
  { id: "inbound", label: "Inbound webhooks", types: ["inbound"] },
  { id: "digest", label: "Digest", types: ["digest.weekly"] },
] as const;

export type WebhookEventType =
  (typeof WEBHOOK_EVENT_GROUPS)[number]["types"][number] | "webhook.test";

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "activity.merge": "Pull request merged",
  "activity.review": "Review submitted",
  "activity.release": "Release published",
  "activity.pr": "Pull request opened",
  "activity.issue": "Issue closed",
  "activity.push": "Commits pushed",
  "pipeline.failed": "CI started failing",
  "pipeline.recovered": "CI passing again",
  "deployment.succeeded": "Deployment succeeded",
  "deployment.failed": "Deployment failed",
  "incident.opened": "Incident opened (a probe is down)",
  "incident.resolved": "Incident resolved",
  "health.degraded": "Probe degraded",
  "health.down": "Probe down",
  "health.recovered": "Probe healthy again",
  inbound: "Any inbound webhook",
  "digest.weekly": "Weekly digest",
  "webhook.test": "Test delivery",
};

/** Inbound events are typed inbound.<endpoint slug>; a rule for "inbound" matches all. */
export function eventMatches(
  subscribed: readonly string[],
  type: string,
): boolean {
  return subscribed.some(
    (item) =>
      item === type || (item === "inbound" && type.startsWith("inbound.")),
  );
}

export interface WebhookEvent {
  version: typeof WEBHOOK_PAYLOAD_VERSION;
  id: string;
  type: string;
  occurredAt: string;
  workspace: { id: string; name: string };
  /** One line for people, such as "Sarah Park merged #428 in acme/platform". */
  summary: string;
  /** The page to open, when there is one. */
  url?: string;
  data: Record<string, unknown>;
}

export type WebhookPresetId =
  "generic" | "slack" | "discord" | "teams" | "google-chat" | "lark";
export interface WebhookPreset {
  id: WebhookPresetId;
  name: string;
  hint: string;
  template: string;
  /** ship signs a header; lark adds timestamp and sign fields to the body. */
  signing?: "ship" | "lark";
  /** A response JSON value that must match for a delivery to count. */
  success?: { path: string; value: string | number | boolean };
}

// Failures and incidents are red, recoveries green, everything else neutral.
const DISCORD_COLOR =
  '{{#if (or (contains type "failed") (contains type "down") (eq type "incident.opened"))}}15548997{{else if (or (contains type "recovered") (contains type "resolved") (contains type "succeeded"))}}5763719{{else if (eq type "health.degraded")}}16705372{{else}}9807270{{/if}}';
// Lark card header colors.
const LARK_COLOR =
  '{{#if (or (contains type "failed") (contains type "down") (eq type "incident.opened"))}}red{{else if (or (contains type "recovered") (contains type "resolved") (contains type "succeeded"))}}green{{else if (eq type "health.degraded")}}orange{{else}}blue{{/if}}';

export const WEBHOOK_PRESETS: Record<WebhookPresetId, WebhookPreset> = {
  generic: {
    id: "generic",
    name: "Generic JSON",
    hint: "The complete version 1 event. Verify X-Ship-Signature with your signing secret.",
    template: "{{json this}}",
  },
  slack: {
    id: "slack",
    name: "Slack",
    hint: "Create an incoming webhook in Slack and paste its URL.",
    template: `{
  "text": "{{slack summary}}",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "{{#if url}}*<{{url}}|{{slack summary}}>*{{else}}*{{slack summary}}*{{/if}}"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "{{slack workspace.name}} · {{date occurredAt}}" }
      ]
    }
  ]
}`,
  },
  discord: {
    id: "discord",
    name: "Discord",
    hint: "In the channel's Integrations settings, create a webhook and paste its URL.",
    template: `{
  "embeds": [
    {
      "title": "{{truncate summary 256}}",{{#if url}}
      "url": "{{url}}",{{/if}}
      "color": ${DISCORD_COLOR},
      "timestamp": "{{occurredAt}}",
      "footer": { "text": "{{workspace.name}} · ship.live" }
    }
  ]
}`,
  },
  teams: {
    id: "teams",
    name: "Microsoft Teams",
    hint: 'Use a Teams Workflows "Post to a channel when a webhook request is received" URL.',
    template: `{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
          { "type": "TextBlock", "text": "{{summary}}", "weight": "Bolder", "wrap": true },
          {
            "type": "TextBlock",
            "text": "{{workspace.name}} · {{date occurredAt}}",
            "isSubtle": true,
            "spacing": "None",
            "wrap": true
          }
        ]{{#if url}},
        "actions": [{ "type": "Action.OpenUrl", "title": "Open", "url": "{{url}}" }]{{/if}}
      }
    }
  ]
}`,
  },
  "google-chat": {
    id: "google-chat",
    name: "Google Chat",
    hint: "In the space's Apps & integrations, add a webhook and paste its URL.",
    template:
      '{ "text": "{{#if url}}<{{url}}|{{summary}}>{{else}}{{summary}}{{/if}}\\n{{workspace.name}} · {{date occurredAt}}" }',
  },
  lark: {
    id: "lark",
    name: "Lark / Feishu",
    hint: "Add a custom bot to the group and paste its webhook URL. If the bot uses signature verification, paste its secret as the signing secret.",
    signing: "lark",
    success: { path: "code", value: 0 },
    template: `{
  {{#if @delivery.larkSign}}"timestamp": "{{@delivery.timestamp}}",
  "sign": "{{@delivery.larkSign}}",
  {{/if}}"msg_type": "interactive",
  "card": {
    "config": { "wide_screen_mode": true },
    "header": {
      "template": "${LARK_COLOR}",
      "title": { "tag": "plain_text", "content": "{{truncate summary 100}}" }
    },
    "elements": [
      {{#if data.body}}{ "tag": "div", "text": { "tag": "lark_md", "content": "{{truncate data.body 1000}}" } },
      {{/if}}{
        "tag": "note",
        "elements": [
          { "tag": "plain_text", "content": "{{workspace.name}} · {{date occurredAt}}" }
        ]
      }{{#if url}},
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": { "tag": "plain_text", "content": "Open" },
            "type": "primary",
            "url": "{{url}}"
          }
        ]
      }{{/if}}
    ]
  }
}`,
  },
};

/** Fictional events for previews and test deliveries. */
export function sampleEvent(
  type: string,
  workspace = { id: "00000000-0000-4000-8000-000000000000", name: "Acme Team" },
  now = Date.now(),
): WebhookEvent {
  const occurredAt = new Date(now).toISOString();
  const base = {
    version: WEBHOOK_PAYLOAD_VERSION,
    id: `sample-${type}`,
    type,
    occurredAt,
    workspace,
  } as const;
  const repository = "acme/platform";
  const actor = {
    login: "sarahpark",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  };
  const service = { id: "sample-service", name: "Public API" };
  const probe = { id: "sample-probe", name: "Health endpoint" };
  if (type.startsWith("activity.")) {
    const kind = type.slice("activity.".length);
    const verb: Record<string, string> = {
      merge: "merged",
      review: "reviewed",
      release: "released",
      pr: "opened",
      issue: "closed",
      push: "pushed to",
    };
    const title =
      kind === "release"
        ? "v2.8.0 — faster responses, fewer retries"
        : kind === "push"
          ? "3 new commits"
          : "Add instant preview environments for every pull request";
    return {
      ...base,
      summary:
        `${actor.login} ${verb[kind] ?? "updated"} ${kind === "release" || kind === "push" ? "" : "#428 "}in ${repository}: ${title}`.replace(
          "  ",
          " ",
        ),
      url: `https://github.com/${repository}/pull/428`,
      data: {
        kind,
        actor,
        repository,
        title,
        number: kind === "release" || kind === "push" ? undefined : 428,
        branch: "main",
        commits: kind === "push" ? 3 : undefined,
      },
    };
  }
  if (type.startsWith("pipeline.")) {
    const failed = type === "pipeline.failed";
    return {
      ...base,
      summary: `CI ${failed ? "is failing" : "is passing again"} for ${repository}: test (GitHub Actions)`,
      url: `https://github.com/${repository}/actions/runs/1`,
      data: {
        repository,
        pipeline: {
          name: "test",
          provider: "GitHub Actions",
          status: failed ? "failing" : "passing",
          previousStatus: failed ? "passing" : "failing",
          headSha: "4f9c2a1",
        },
      },
    };
  }
  if (type.startsWith("deployment.")) {
    const failed = type === "deployment.failed";
    return {
      ...base,
      summary: `Deployment to production ${failed ? "failed" : "succeeded"} for ${repository}`,
      url: `https://github.com/${repository}/deployments`,
      data: {
        repository,
        deployment: {
          environment: "production",
          status: failed ? "failing" : "successful",
          headSha: "4f9c2a1",
        },
      },
    };
  }
  if (type.startsWith("health.") || type.startsWith("incident.")) {
    const status =
      type === "health.degraded"
        ? "degraded"
        : type === "health.recovered" || type === "incident.resolved"
          ? "healthy"
          : "down";
    const resolved = type === "incident.resolved";
    return {
      ...base,
      summary:
        type === "incident.opened"
          ? `Incident: ${service.name} / ${probe.name} is down`
          : resolved
            ? `Resolved after 12 minutes: ${service.name} / ${probe.name} is healthy`
            : `${service.name} / ${probe.name} is ${status}`,
      data: {
        service,
        probe,
        status,
        previousStatus: status === "healthy" ? "down" : "healthy",
        reason:
          status === "healthy"
            ? "Probe passed."
            : "HTTP status is outside the accepted range.",
        statusCode: status === "healthy" ? 200 : 503,
        latencyMs: status === "healthy" ? 142 : 2310,
        incident: type.startsWith("incident.")
          ? {
              id: "sample-incident",
              openedAt: new Date(now - 12 * 60_000).toISOString(),
              resolvedAt: resolved ? occurredAt : null,
              durationSeconds: resolved ? 720 : null,
            }
          : undefined,
      },
    };
  }
  if (type.startsWith("inbound")) {
    return {
      ...base,
      type: type === "inbound" ? "inbound.alerts" : type,
      summary: "Grafana: API p95 latency above 800 ms",
      url: "https://grafana.example.com/alerting",
      data: {
        endpoint: {
          id: "sample-inbound",
          name: "Grafana alerts",
          slug: "alerts",
        },
        title: "API p95 latency above 800 ms",
        body: "p95 latency has been above 800 ms for 5 minutes.",
        payload: { status: "firing", labels: { severity: "warning" } },
      },
    };
  }
  if (type === "digest.weekly") {
    return {
      ...base,
      summary:
        "Acme Team's week: 34 merges, 41 reviews, 3 releases from 6 people",
      data: {
        weekStart: new Date(now - 7 * 86_400_000).toISOString().slice(0, 10),
        weekEnd: occurredAt.slice(0, 10),
        totals: {
          merges: 34,
          reviews: 41,
          releases: 3,
          contributors: 6,
          xp: 2415,
        },
        topContributors: [
          { login: "sarahpark", xp: 610, merges: 9, reviews: 12 },
          { login: "alexchen", xp: 545, merges: 8, reviews: 10 },
          { login: "minhnguyen", xp: 430, merges: 6, reviews: 9 },
        ],
        repositories: [
          { name: "acme/platform", merges: 12, reviews: 15 },
          { name: "acme/web-app", merges: 9, reviews: 11 },
        ],
        services: [
          { name: "Public API", uptime: 0.9994, incidents: 1 },
          { name: "Web app", uptime: 1, incidents: 0 },
        ],
      },
    };
  }
  return {
    ...base,
    type: "webhook.test",
    summary: "Test delivery from ship.live",
    data: { message: "If you can read this, the webhook works." },
  };
}
