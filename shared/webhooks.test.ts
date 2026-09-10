import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate } from "./webhook-template";
import {
  eventMatches,
  sampleEvent,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_PRESETS,
} from "./webhooks";

const types = [
  ...WEBHOOK_EVENT_GROUPS.flatMap((group) => group.types),
  "webhook.test",
];

test("every preset renders valid JSON for every event type", () => {
  for (const preset of Object.values(WEBHOOK_PRESETS))
    for (const type of types)
      assert.doesNotThrow(
        () =>
          JSON.parse(
            renderTemplate(preset.template, sampleEvent(type), "json"),
          ),
        `${preset.id} / ${type}`,
      );
});

test("every event type has a label and a sample with a summary", () => {
  for (const type of types) {
    assert.ok(
      WEBHOOK_EVENT_LABELS[type as keyof typeof WEBHOOK_EVENT_LABELS],
      type,
    );
    const event = sampleEvent(type);
    assert.equal(event.version, 1);
    assert.ok(event.summary.length > 10, type);
    assert.ok(!event.summary.includes("  "), type);
  }
});

test("the generic preset sends the complete event", () => {
  const event = sampleEvent("deployment.failed");
  assert.deepEqual(
    JSON.parse(renderTemplate(WEBHOOK_PRESETS.generic.template, event, "json")),
    JSON.parse(JSON.stringify(event)),
  );
});

test("chat presets link the summary, escape Slack markup, and color by outcome", () => {
  const event = {
    ...sampleEvent("pipeline.failed"),
    summary: "CI <failing> & red",
  };
  const slack = JSON.parse(
    renderTemplate(WEBHOOK_PRESETS.slack.template, event, "json"),
  );
  assert.equal(
    slack.blocks[0].text.text,
    `*<${event.url}|CI &lt;failing&gt; &amp; red>*`,
  );
  const discord = (type: string) =>
    JSON.parse(
      renderTemplate(
        WEBHOOK_PRESETS.discord.template,
        sampleEvent(type),
        "json",
      ),
    ).embeds[0];
  assert.equal(discord("pipeline.failed").color, 15548997);
  assert.equal(discord("incident.resolved").color, 5763719);
  assert.equal(discord("health.degraded").color, 16705372);
  assert.equal(discord("activity.merge").color, 9807270);
  // Events without a link omit it rather than sending an empty URL.
  const health = sampleEvent("health.down");
  assert.equal(health.url, undefined);
  assert.equal(discord("health.down").url, undefined);
  const teams = JSON.parse(
    renderTemplate(WEBHOOK_PRESETS.teams.template, health, "json"),
  );
  assert.equal(teams.attachments[0].content.actions, undefined);
  const chat = JSON.parse(
    renderTemplate(
      WEBHOOK_PRESETS["google-chat"].template,
      sampleEvent("activity.merge"),
      "json",
    ),
  );
  assert.match(chat.text, /^<https:\/\/github\.com\/.+\|.+>\nAcme Team · /);
});

test("inbound subscriptions match every inbound endpoint", () => {
  assert.equal(eventMatches(["inbound"], "inbound.alerts"), true);
  assert.equal(eventMatches(["inbound.alerts"], "inbound.alerts"), true);
  assert.equal(eventMatches(["inbound.alerts"], "inbound.deploys"), false);
  assert.equal(eventMatches(["health.down"], "health.degraded"), false);
});

test("the Lark preset signs in the body when asked, colors the header, and checks the reply code", () => {
  const lark = WEBHOOK_PRESETS.lark;
  assert.equal(lark.signing, "lark");
  assert.deepEqual(lark.success, { path: "code", value: 0 });
  const delivery = { timestamp: "1789027509", larkSign: "c2lnbg==" };
  for (const type of types) {
    const plain = JSON.parse(
      renderTemplate(lark.template, sampleEvent(type), "json"),
    );
    assert.equal(plain.msg_type, "interactive", type);
    assert.equal(plain.sign, undefined, type);
    const signed = JSON.parse(
      renderTemplate(lark.template, sampleEvent(type), "json", { delivery }),
    );
    assert.equal(signed.timestamp, "1789027509", type);
    assert.equal(signed.sign, "c2lnbg==", type);
  }
  const card = (type: string) =>
    JSON.parse(renderTemplate(lark.template, sampleEvent(type), "json")).card;
  assert.equal(card("incident.opened").header.template, "red");
  assert.equal(card("deployment.succeeded").header.template, "green");
  assert.equal(card("health.degraded").header.template, "orange");
  assert.equal(card("activity.merge").header.template, "blue");
  assert.equal(
    card("activity.merge").elements.at(-1).actions[0].url,
    sampleEvent("activity.merge").url,
  );
  assert.equal(card("health.down").elements.at(-1).tag, "note");
  assert.equal(card("inbound").elements[0].text.tag, "lark_md");
});
