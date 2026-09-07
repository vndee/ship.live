import { readFile } from "node:fs/promises";
import type { ActivityEvent } from "../shared/types.js";
import { safeGithubUrl, validOrganization } from "./normalize.js";

export interface LegacyImportData {
  version: 1;
  records: Array<{
    organization: string;
    event: ActivityEvent;
    restricted: boolean;
  }>;
  deliveries: string[];
  protectedOrganizations: string[];
}

/** Counts of newly inserted IDs and newly protected organizations, not input size. */
export interface LegacyImportResult {
  events: number;
  deliveries: number;
  protectedOrganizations: number;
}

export interface LegacyImportTarget {
  /** The entire import must commit or roll back as one transaction. */
  importLegacy(data: LegacyImportData): Promise<LegacyImportResult>;
}

export function parseLegacyImport(text: string): LegacyImportData {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    invalid();
  }
  const data = object(input);
  if (
    data.version !== 1 ||
    !Array.isArray(data.records) ||
    !Array.isArray(data.deliveries) ||
    !Array.isArray(data.protectedOrganizations)
  )
    invalid();
  return {
    version: 1,
    records: data.records.map((input) => {
      const record = object(input);
      if (
        !validOrganization(record.organization) ||
        typeof record.restricted !== "boolean"
      )
        invalid();
      const organization = record.organization.toLowerCase();
      const event = activityEvent(record.event);
      if (event.repo.split("/")[0].toLowerCase() !== organization) invalid();
      return { organization, event, restricted: record.restricted };
    }),
    deliveries: data.deliveries.map((value) => {
      if (typeof value !== "string" || !/^[a-z\d-]{1,100}$/i.test(value))
        invalid();
      return value;
    }),
    protectedOrganizations: data.protectedOrganizations.map((value) => {
      if (!validOrganization(value)) invalid();
      return value.toLowerCase();
    }),
  };
}

export async function readLegacyImport(
  file: string,
): Promise<LegacyImportData> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    throw new Error("Could not read legacy activity file.");
  }
  return parseLegacyImport(contents);
}

export async function importLegacyFile(
  file: string,
  target: LegacyImportTarget,
): Promise<LegacyImportResult> {
  return target.importLegacy(await readLegacyImport(file));
}

function invalid(): never {
  // JSON parser, filesystem, and driver messages may contain private file data.
  throw new Error("Invalid legacy activity file.");
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > maximum ||
    value.includes("\0")
  )
    invalid();
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
  return value;
}

function optionalUrl(value: unknown, avatar = false): string | undefined {
  if (value === undefined) return undefined;
  const safe = safeGithubUrl(value, avatar);
  if (!safe) invalid();
  return safe;
}

function timestamp(value: unknown): string {
  const text = string(value, 100);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!match || !Number.isFinite(Date.parse(text))) invalid();
  const [, rawYear, rawMonth, rawDay] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse silently rolls some impossible dates into the next month.
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid();
  return new Date(text).toISOString();
}

function activityEvent(input: unknown): ActivityEvent {
  const event = object(input);
  const id = string(event.id, 4096);
  const types = ["merge", "review", "push", "issue", "release", "pr"];
  if (typeof event.type !== "string" || !types.includes(event.type)) invalid();
  const actor = object(event.actor);
  const repo = string(event.repo, 140);
  const [owner, name, extra] = repo.split("/");
  if (
    !validOrganization(owner) ||
    !name ||
    !/^[a-z\d_.-]{1,100}$/i.test(name) ||
    extra !== undefined
  )
    invalid();
  const occurredAt = timestamp(event.occurredAt);
  return {
    id,
    type: event.type as ActivityEvent["type"],
    actor: {
      login: string(actor.login, 1000),
      ...(actor.avatarUrl === undefined
        ? {}
        : { avatarUrl: optionalUrl(actor.avatarUrl, true) }),
    },
    repo,
    title: string(event.title, 1000, true),
    occurredAt,
    ...(event.url === undefined ? {} : { url: optionalUrl(event.url) }),
    ...(event.number === undefined
      ? {}
      : { number: optionalInteger(event.number) }),
    ...(event.additions === undefined
      ? {}
      : { additions: optionalInteger(event.additions) }),
    ...(event.deletions === undefined
      ? {}
      : { deletions: optionalInteger(event.deletions) }),
  };
}
