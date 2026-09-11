import type { WebhookEvent } from "./webhooks";

/**
 * Optional narrowing of an endpoint's events. A list applies only to events
 * that carry its field, so a production-only deployment filter still lets
 * activity through. Patterns accept * wildcards and are case-insensitive; a
 * leading ! excludes, as in "!*[bot]".
 */
export interface WebhookFilters {
  repositories?: string[];
  branches?: string[];
  environments?: string[];
  services?: string[];
  actors?: string[];
  /** Text the summary must contain. */
  text?: string;
}

const LISTS = [
  "repositories",
  "branches",
  "environments",
  "services",
  "actors",
] as const;
type ListKey = (typeof LISTS)[number];

export class FilterError extends Error {}

function hasControl(value: string) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function validateFilters(input: unknown): WebhookFilters {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input))
    throw new FilterError("Filters must be an object.");
  const result: WebhookFilters = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "text") {
      if (typeof value !== "string" || value.length > 200 || hasControl(value))
        throw new FilterError("Summary text must be at most 200 characters.");
      if (value.trim()) result.text = value.trim();
      continue;
    }
    if (!(LISTS as readonly string[]).includes(key))
      throw new FilterError(`Unknown filter "${key}".`);
    if (!Array.isArray(value) || value.length > 50)
      throw new FilterError(`${key} accepts at most 50 patterns.`);
    const patterns = value.map((item) => {
      if (
        typeof item !== "string" ||
        !item.trim() ||
        item.length > 200 ||
        hasControl(item)
      )
        throw new FilterError(
          `Each ${key} pattern must be 1–200 characters without control characters.`,
        );
      return item.trim();
    });
    if (patterns.length) result[key as ListKey] = [...new Set(patterns)];
  }
  return result;
}

function pattern(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

/** Exclusions win; when inclusions exist, one must match. */
function listMatches(patterns: string[], value: string): boolean {
  const excluded = patterns.filter((item) => item.startsWith("!"));
  const included = patterns.filter((item) => !item.startsWith("!"));
  if (excluded.some((item) => pattern(item.slice(1)).test(value))) return false;
  return !included.length || included.some((item) => pattern(item).test(value));
}

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const field = (value: unknown, key: string) =>
  value && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The value each filter reads from an event, when it has one. */
export function filterFields(
  event: Pick<WebhookEvent, "data">,
): Record<ListKey, string | undefined> {
  const data = event.data;
  return {
    repositories: text(field(data, "repository")),
    branches: text(field(data, "branch")),
    environments: text(field(field(data, "deployment"), "environment")),
    services: text(field(field(data, "service"), "name")),
    actors: text(field(field(data, "actor"), "login")),
  };
}

export function filtersMatch(
  filters: WebhookFilters,
  event: Pick<WebhookEvent, "summary" | "data">,
): boolean {
  const fields = filterFields(event);
  for (const key of LISTS) {
    const patterns = filters[key];
    const value = fields[key];
    if (
      patterns?.length &&
      value !== undefined &&
      !listMatches(patterns, value)
    )
      return false;
  }
  return (
    !filters.text ||
    event.summary.toLowerCase().includes(filters.text.toLowerCase())
  );
}
