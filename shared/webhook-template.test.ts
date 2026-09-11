import assert from "node:assert/strict";
import test from "node:test";
import {
  compileTemplate,
  renderTemplate,
  TemplateError,
} from "./webhook-template";

const event = {
  type: "pipeline.failed",
  occurredAt: "2026-09-10T08:05:09.000Z",
  workspace: { name: "Acme Team" },
  data: {
    repository: "acme/api",
    title: 'Fix "quotes" & <tags>\nsecond line',
    status: "failing",
    count: 1,
    uptime: 0.99871,
    authors: ["sarahpark", "leowang"],
    checks: [
      { name: "build", status: "passing" },
      { name: "test", status: "failing" },
    ],
  },
};

test("JSON mode escapes values for strings, and json inserts whole values", () => {
  const body = renderTemplate(
    '{"text": "{{data.title}}", "authors": {{json data.authors}}, "missing": "{{data.nothing}}"}',
    event,
    "json",
  );
  assert.deepEqual(JSON.parse(body), {
    text: 'Fix "quotes" & <tags>\nsecond line',
    authors: ["sarahpark", "leowang"],
    missing: "",
  });
});

test("text mode inserts values as they are", () => {
  assert.equal(
    renderTemplate(
      "{{workspace.name}}: {{data.repository}} {{data.count}}",
      event,
      "text",
    ),
    "Acme Team: acme/api 1",
  );
});

test("conditions, else-if chains, unless, and with", () => {
  const source = [
    '{{#if (eq data.status "passing")}}green',
    '{{else if (and (eq data.status "failing") (gt data.count 0))}}red',
    "{{else}}grey{{/if}}",
    "{{#unless data.nothing}} none{{/unless}}",
    "{{#with data}} {{repository}}{{/with}}",
    "{{#with data.nothing}}x{{else}} empty{{/with}}",
  ].join("");
  assert.equal(
    renderTemplate(source, event, "text"),
    "red none acme/api empty",
  );
});

test("loops expose this, @index, @first, and @last, and fall back to outer names", () => {
  const source =
    "{{#each data.checks}}{{#unless @first}}, {{/unless}}{{@index}}:{{name}}={{status}} in {{data.repository}}{{#if @last}}.{{/if}}{{/each}}" +
    "{{#each data.authors}} @{{this}}{{/each}}{{#each data.nothing}}x{{else}} (no items){{/each}}";
  assert.equal(
    renderTemplate(source, event, "text"),
    "0:build=passing in acme/api, 1:test=failing in acme/api. @sarahpark @leowang (no items)",
  );
});

test("helpers format text, numbers, dates, and lists", () => {
  const cases: [string, string][] = [
    ['{{default data.nothing "Someone"}}', "Someone"],
    ["{{truncate data.repository 5}}", "acme…"],
    ["{{upper data.status}} {{lower 'LOUD'}}", "FAILING loud"],
    ['{{replace data.repository "acme/" ""}}', "api"],
    ["{{date occurredAt}}", "2026-09-10 08:05 UTC"],
    [
      '{{date occurredAt "date"}} {{date occurredAt "time"}}',
      "2026-09-10 08:05 UTC",
    ],
    ['{{date occurredAt "unix"}}', "1789027509"],
    ["{{percent data.uptime 2}} {{number 2.345 1}}", "99.87% 2.3"],
    ['{{data.count}} {{plural data.count "check" "checks"}}', "1 check"],
    [
      '{{join data.authors " & "}} {{length data.checks}}',
      "sarahpark & leowang 2",
    ],
    ['{{#if (contains data.title "quotes")}}yes{{/if}}', "yes"],
    ['{{lookup data "status"}}', "failing"],
    ["{{slack data.title}}", 'Fix "quotes" &amp; &lt;tags&gt;\nsecond line'],
    ["{{markdown 'a*b_c'}}", "a\\*b\\_c"],
    ["{{#if (not (or data.nothing false))}}ok{{/if}}", "ok"],
  ];
  for (const [source, expected] of cases)
    assert.equal(renderTemplate(source, event, "text"), expected, source);
});

test("comments are dropped and ~ trims whitespace next to a tag", () => {
  const source = `[
  {{~#each data.authors~}}
    "{{this}}"{{#unless @last}},{{/unless}}
  {{~/each~}}
]{{! note }}{{!-- a }} comment --}}`;
  assert.equal(
    renderTemplate(source, event, "json"),
    '["sarahpark","leowang"]',
  );
});

test("only a value's own properties can be read", () => {
  assert.equal(
    renderTemplate(
      "[{{constructor.name}}][{{data.__proto__}}][{{data.title.length}}][{{data.authors.length}}][{{data.checks.1.name}}]",
      event,
      "text",
    ),
    "[][][][2][test]",
  );
});

test("syntax errors name the problem and its line", () => {
  const cases: [string, RegExp][] = [
    ["line one\n{{data.title", /never closed/],
    ["{{#if data.count}}\nyes", /\{\{#if\}\} on line 1 is never closed/],
    ["{{#if data.count}}{{/each}}", /closes \{\{#if\}\}/],
    ["{{else}}", /outside a block/],
    ["{{#each data.authors}}{{else if x}}{{/each}}", /only follows/],
    ["{{shout data.title}}", /Unknown helper "shout"/],
    ["{{truncate data.title}}", /takes 2 arguments/],
    ["{{#if}}x{{/if}}", /needs a value/],
    ['{{date occurredAt "weekday"}}', /date formats/],
    ['{{data.title "x}}', /Unclosed quote/],
    ["{{#for data}}{{/for}}", /Unknown block/],
    ["{{a..b}}", /not a valid path/],
  ];
  for (const [source, pattern] of cases)
    assert.throws(
      () => compileTemplate(source, "text").render(event),
      (error: unknown) =>
        error instanceof TemplateError && pattern.test(error.message),
      source,
    );
});

test("JSON mode rejects a rendered body that is not JSON", () => {
  assert.throws(
    () => renderTemplate('{"text": {{data.title}}}', event, "json"),
    /not valid JSON/,
  );
});

test("limits bound template size, nesting, loops, and output", () => {
  assert.throws(() => compileTemplate("x".repeat(16_385), "text"), /16 KiB/);
  assert.throws(
    () => compileTemplate("{{#if a}}".repeat(9) + "{{/if}}".repeat(9), "text"),
    /8 deep/,
  );
  const many = { items: Array.from({ length: 150 }, (_, index) => index) };
  assert.equal(
    renderTemplate("{{#each items}}.{{/each}}", many, "text").length,
    100,
  );
  const big = { text: "x".repeat(10_000) };
  assert.throws(
    () =>
      renderTemplate(
        "{{#each items}}{{#each @root.items}}{{@root.text}}{{/each}}{{/each}}",
        { ...big, items: many.items },
        "text",
      ),
    /256 KiB|too much work/,
  );
});

test("delivery values are read from @delivery, not the event", () => {
  assert.equal(
    renderTemplate(
      "{{@delivery.attempt}}/{{@delivery.timestamp}}{{#if @delivery.missing}}x{{/if}}",
      event,
      "text",
      { delivery: { attempt: 2, timestamp: "1789027509" } },
    ),
    "2/1789027509",
  );
  assert.equal(
    renderTemplate("[{{@delivery.timestamp}}]", event, "text"),
    "[]",
  );
  assert.throws(
    () => compileTemplate("{{@delivery..x}}", "text"),
    /not a valid path/,
  );
});
