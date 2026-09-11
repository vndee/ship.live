import type { ActivityEvent } from "../../shared/types";

// A # that starts a word: not inside a URL, an HTML entity, or "C#".
// Words longer than 40 characters are not tags.
const TAG =
  /(?:^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}][\p{L}\p{M}\p{N}_-]{0,39})(?![\p{L}\p{M}\p{N}_-])/gu;

// A # inside a link belongs to the link, never a tag.
const URL_TEXT = /\b(?:https?:\/\/|www\.)\S+/giu;

/** A tag's single form: lowercased and composed, so notes and URLs agree. */
const normalizeTag = (value: string) => value.toLowerCase().normalize("NFC");

/** Whether a URL value is a tag in the form noteTags returns. */
export function isTag(value: string): boolean {
  // Lowercasing can add combining marks (İ becomes i and a dot above).
  return (
    /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*$/u.test(value) && [...value].length <= 80
  );
}

/** A note's hashtags, lowercased, in order of first use. */
export function noteTags(
  event: Pick<ActivityEvent, "type" | "title" | "body">,
): string[] {
  if (event.type !== "note") return [];
  const tags: string[] = [];
  for (const match of `${event.title}\n${event.body ?? ""}`
    .normalize("NFC")
    .replace(URL_TEXT, " ")
    .matchAll(TAG)) {
    const tag = normalizeTag(match[1]);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** A note body with the tag appended, unless the note already has it. */
export function withTag(title: string, body: string, tag: string): string {
  if (noteTags({ type: "note", title, body }).includes(tag)) return body;
  return `${body}${body && !/\s$/.test(body) ? " " : ""}#${tag}`;
}

/** Tags across a journal, most used first, then alphabetically. */
export function journalTags(
  events: ActivityEvent[],
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const event of events)
    for (const tag of noteTags(event))
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const VERBS: Record<Exclude<ActivityEvent["type"], "note">, string> = {
  merge: "Merged",
  review: "Reviewed",
  push: "Pushed",
  issue: "Closed",
  release: "Released",
  pr: "Opened",
  alert: "Alert",
};
const line = (value: string) => value.replace(/\s*\n\s*/g, " ").trim();
const time = (value: string) => `${value.slice(11, 16)} UTC`;
// Link text escapes what would end or restructure the link.
const linkText = (value: string) => value.replace(/[\\[\]()]/g, "\\$&");
const link = (text: string, url?: string) =>
  url?.startsWith("https://")
    ? `[${linkText(text)}](${url.replace(/[()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`
    : text;

/**
 * A Markdown document of the given events: newest day first, ship notes
 * with their full story and tags, then the day's other activity.
 */
export function journalMarkdown(
  events: ActivityEvent[],
  { title, generatedAt }: { title: string; generatedAt: string },
): string {
  const days = new Map<string, ActivityEvent[]>();
  for (const event of [...events].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  )) {
    const day = event.occurredAt.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  const output = [
    `# ${line(title)}`,
    "",
    `Exported from ship.live on ${generatedAt.slice(0, 10)} · ${events.length} ${events.length === 1 ? "entry" : "entries"}`,
  ];
  for (const [day, items] of days) {
    output.push("", `## ${day}`);
    for (const note of items.filter((item) => item.type === "note")) {
      const tags = noteTags(note);
      output.push(
        "",
        `### ${line(note.title)}`,
        "",
        `_${time(note.occurredAt)}${tags.length ? ` · ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}_`,
      );
      if (note.body?.trim()) output.push("", note.body.trim());
    }
    const activity = items.filter((item) => item.type !== "note");
    if (activity.length) {
      output.push("");
      for (const item of activity) {
        if (item.type === "note") continue;
        const number = item.number ? ` #${item.number}` : "";
        output.push(
          `- ${time(item.occurredAt)} · ${VERBS[item.type]}${number} in ${item.repo}: ${link(line(item.title), item.url)}`,
        );
      }
    }
  }
  return `${output.join("\n")}\n`;
}
