import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEvent } from "../../shared/types";
import {
  isTag,
  journalMarkdown,
  journalTags,
  noteTags,
  withTag,
} from "./journal";

const note = (
  id: string,
  title: string,
  body: string,
  occurredAt: string,
): ActivityEvent => ({
  id,
  type: "note",
  actor: { login: "Minh" },
  repo: "journal/notes",
  title,
  body,
  occurredAt,
});

test("hashtags start a word and are lowercased once each", () => {
  assert.deepEqual(
    noteTags(
      note(
        "n1",
        "Shipped search #Launch",
        "Learned a lot. #lesson #launch #tiếng-việt\nSee https://example.com/#section and C# and &#39; #2026",
        "2026-09-10T08:00:00Z",
      ),
    ),
    ["launch", "lesson", "tiếng-việt", "2026"],
  );
  assert.deepEqual(noteTags({ type: "merge", title: "#launch", body: "" }), []);
});

test("tags stop at 40 characters, and suggestions add a tag only once", () => {
  const long = "a".repeat(41);
  const edge = "b".repeat(40);
  assert.deepEqual(
    noteTags(note("n2", "", `#${long} #${edge}`, "2026-09-10T08:00:00Z")),
    [edge],
  );
  assert.equal(
    withTag("", "Shipped #deployment", "deploy"),
    "Shipped #deployment #deploy",
  );
  assert.equal(withTag("Ship #deploy", "Done", "deploy"), "Done");
  assert.equal(withTag("", "Done\n", "launch"), "Done\n#launch");
  assert.equal(withTag("", "", "launch"), "#launch");
});

test("tags whose lowercase adds combining marks stay usable in URLs", () => {
  const istanbul = "İstanbul".toLowerCase();
  assert.deepEqual(
    noteTags(note("n3", "Offsite #İstanbul", "", "2026-09-10T08:00:00Z")),
    [istanbul],
  );
  assert.equal(isTag(istanbul), true);
  assert.equal(isTag("bad tag"), false);
  assert.equal(isTag("-leading"), false);
});

test("journal tags are counted and ordered by use", () => {
  assert.deepEqual(
    journalTags([
      note("a", "One #launch", "", "2026-09-10T08:00:00Z"),
      note("b", "Two #lesson #launch", "", "2026-09-09T08:00:00Z"),
      note("c", "Three #api", "", "2026-09-08T08:00:00Z"),
    ]),
    [
      { tag: "launch", count: 2 },
      { tag: "api", count: 1 },
      { tag: "lesson", count: 1 },
    ],
  );
});

test("the Markdown export groups by day with notes first and links activity", () => {
  const markdown = journalMarkdown(
    [
      note(
        "n1",
        "Shipped search\nfinally",
        "It was worth it. #launch",
        "2026-09-10T14:05:00Z",
      ),
      {
        id: "m1",
        type: "merge",
        actor: { login: "minh" },
        repo: "acme/api",
        title: "Add search",
        url: "https://github.com/acme/api/pull/12",
        number: 12,
        occurredAt: "2026-09-10T09:30:00Z",
      },
      note("n0", "Planned search", "", "2026-09-08T10:00:00Z"),
      {
        id: "r1",
        type: "release",
        actor: { login: "minh" },
        repo: "acme/api",
        title: "v1.0",
        url: "javascript:alert(1)",
        occurredAt: "2026-09-08T11:00:00Z",
      },
    ],
    { title: "Minh's ship journal", generatedAt: "2026-09-11T00:00:00Z" },
  );
  assert.equal(
    markdown,
    [
      "# Minh's ship journal",
      "",
      "Exported from ship.live on 2026-09-11 · 4 entries",
      "",
      "## 2026-09-10",
      "",
      "### Shipped search finally",
      "",
      "_14:05 UTC · #launch_",
      "",
      "It was worth it. #launch",
      "",
      "- 09:30 UTC · Merged #12 in acme/api: [Add search](https://github.com/acme/api/pull/12)",
      "",
      "## 2026-09-08",
      "",
      "### Planned search",
      "",
      "_10:00 UTC_",
      "",
      "- 11:00 UTC · Released in acme/api: v1.0",
      "",
    ].join("\n"),
  );
});

test("exported links escape titles, and URL fragments are never tags", () => {
  const markdown = journalMarkdown(
    [
      {
        id: "m1",
        type: "merge",
        actor: { login: "sarahpark" },
        repo: "acme/api",
        title: "Fix ] and [x](y)",
        url: "https://github.com/acme/api/pull/1",
        occurredAt: "2026-09-10T08:00:00Z",
      },
    ],
    { title: "Acme activity", generatedAt: "2026-09-10T09:00:00Z" },
  );
  assert.ok(
    markdown.includes(
      String.raw`[Fix \] and \[x\]\(y\)](https://github.com/acme/api/pull/1)`,
    ),
  );
  assert.deepEqual(
    noteTags(
      note(
        "n4",
        "Links",
        "See https://example.test/?q=#release and www.example.test/#x, then #real",
        "2026-09-10T08:00:00Z",
      ),
    ),
    ["real"],
  );
});
