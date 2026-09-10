/**
 * Webhook body templates: a small Handlebars-like language that runs no user
 * code. The same engine renders previews in the browser and deliveries on the
 * server.
 *
 *   {{path.to.value}}            insert a value
 *   {{helper arg "literal"}}     call a helper; (helper ...) nests
 *   {{#if expr}}…{{else if expr}}…{{else}}…{{/if}}, {{#unless expr}}…{{/unless}}
 *   {{#each list}}…{{else}}…{{/each}} with this, @index, @first, @last
 *   {{#with expr}}…{{/with}}, {{! comment }}, {{~ trims whitespace ~}}
 *   {{@delivery.timestamp}}      values of this delivery rather than the event
 *
 * In JSON mode an inserted value is escaped for a JSON string, so templates
 * write "title": "{{event.title}}"; {{json value}} inserts a complete JSON
 * value. Text mode inserts values as they are.
 */
export type TemplateMode = "json" | "text";

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export const TEMPLATE_LIMITS = {
  sourceBytes: 16_384,
  outputBytes: 262_144,
  depth: 8,
  loopItems: 100,
  steps: 100_000,
} as const;

type Expr =
  | { kind: "path"; root: boolean; segments: string[] }
  | { kind: "data"; name: string; segments: string[] }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "call"; name: string; args: Expr[] };
type Node =
  | { kind: "text"; value: string }
  | { kind: "output"; expr: Expr }
  | {
      kind: "if";
      branches: { test: Expr; negate: boolean; body: Node[] }[];
      otherwise: Node[];
    }
  | { kind: "each" | "with"; expr: Expr; body: Node[]; otherwise: Node[] };

/** Output that is already valid in the body, such as {{json value}}. */
class Raw {
  constructor(readonly text: string) {}
}

const escapeSlack = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const escapeMarkdown = (value: string) =>
  value.replace(/([\\`*_{}[\]()#+\-.!|>~<])/g, "\\$1");
const text = (value: unknown): string =>
  value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
const numeric = (value: unknown) =>
  typeof value === "number" ? value : Number(text(value));
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
function formatDate(value: unknown, format: unknown): string | number {
  const time = typeof value === "number" ? value : Date.parse(text(value));
  if (!Number.isFinite(time)) return "";
  const iso = new Date(time).toISOString();
  switch (format ?? "datetime") {
    case "iso":
      return iso;
    case "date":
      return iso.slice(0, 10);
    case "time":
      return `${iso.slice(11, 16)} UTC`;
    case "unix":
      return Math.floor(time / 1000);
    case "datetime":
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    default:
      throw new TemplateError(
        'date formats are "datetime", "date", "time", "iso", and "unix".',
      );
  }
}

interface Helper {
  args: [number, number];
  description: string;
  run: (...args: unknown[]) => unknown;
}
/** Helpers are pure functions of their arguments. */
export const TEMPLATE_HELPERS: Record<string, Helper> = {
  json: {
    args: [1, 1],
    description: "A complete JSON value: json event",
    run: (value) => new Raw(JSON.stringify(value ?? null)),
  },
  default: {
    args: [2, 2],
    description:
      'A fallback for missing or empty values: default actor.name "Someone"',
    run: (value, fallback) =>
      value === null || value === undefined || value === "" ? fallback : value,
  },
  truncate: {
    args: [2, 2],
    description: "Shortens text to a length, ending with …: truncate title 80",
    run: (value, length) => {
      const input = text(value);
      const limit = Math.max(1, Math.floor(numeric(length)) || 1);
      return input.length > limit ? `${input.slice(0, limit - 1)}…` : input;
    },
  },
  upper: {
    args: [1, 1],
    description: "Uppercase text",
    run: (value) => text(value).toUpperCase(),
  },
  lower: {
    args: [1, 1],
    description: "Lowercase text",
    run: (value) => text(value).toLowerCase(),
  },
  replace: {
    args: [3, 3],
    description: 'Replaces every occurrence: replace branch "refs/heads/" ""',
    run: (value, search, replacement) =>
      text(value).replaceAll(text(search), text(replacement)),
  },
  date: {
    args: [1, 2],
    description:
      'Formats a timestamp in UTC: date occurredAt "date" (datetime, date, time, iso, unix)',
    run: formatDate,
  },
  number: {
    args: [1, 2],
    description: "Rounds to fixed decimals: number latency 0",
    run: (value, digits) => {
      const input = numeric(value);
      return Number.isFinite(input)
        ? input.toFixed(Math.min(6, Math.max(0, numeric(digits ?? 0) || 0)))
        : "";
    },
  },
  percent: {
    args: [1, 2],
    description: "A ratio as a percentage: percent 0.9987 2 → 99.87%",
    run: (value, digits) => {
      const input = numeric(value);
      return Number.isFinite(input)
        ? `${(input * 100).toFixed(Math.min(6, Math.max(0, numeric(digits ?? 1) || 0)))}%`
        : "";
    },
  },
  plural: {
    args: [2, 3],
    description: 'Chooses a word by count: plural count "merge" "merges"',
    run: (count, singular, plural) =>
      numeric(count) === 1 ? singular : (plural ?? `${text(singular)}s`),
  },
  join: {
    args: [1, 2],
    description: 'Joins a list: join names ", "',
    run: (value, separator) =>
      Array.isArray(value)
        ? value
            .slice(0, TEMPLATE_LIMITS.loopItems)
            .map(text)
            .join(separator === undefined ? ", " : text(separator))
        : text(value),
  },
  length: {
    args: [1, 1],
    description: "The number of items or characters",
    run: (value) =>
      Array.isArray(value) || typeof value === "string"
        ? value.length
        : value && typeof value === "object"
          ? Object.keys(value).length
          : 0,
  },
  lookup: {
    args: [2, 2],
    description: "Reads a key chosen by another value: lookup colors status",
    run: (value, key) =>
      value && typeof value === "object" && Object.hasOwn(value, text(key))
        ? (value as Record<string, unknown>)[text(key)]
        : undefined,
  },
  contains: {
    args: [2, 2],
    description:
      'Whether text or a list contains a value: contains title "hotfix"',
    run: (value, needle) =>
      Array.isArray(value)
        ? value.includes(needle)
        : text(value).includes(text(needle)),
  },
  eq: { args: [2, 2], description: "Equal", run: (a, b) => a === b },
  ne: { args: [2, 2], description: "Not equal", run: (a, b) => a !== b },
  gt: {
    args: [2, 2],
    description: "Greater than",
    run: (a, b) => numeric(a) > numeric(b),
  },
  gte: {
    args: [2, 2],
    description: "At least",
    run: (a, b) => numeric(a) >= numeric(b),
  },
  lt: {
    args: [2, 2],
    description: "Less than",
    run: (a, b) => numeric(a) < numeric(b),
  },
  lte: {
    args: [2, 2],
    description: "At most",
    run: (a, b) => numeric(a) <= numeric(b),
  },
  and: {
    args: [2, 8],
    description: "Every value is true",
    run: (...values) => values.every(truthy),
  },
  or: {
    args: [2, 8],
    description: "Any value is true",
    run: (...values) => values.some(truthy),
  },
  not: {
    args: [1, 1],
    description: "The opposite",
    run: (value) => !truthy(value),
  },
  slack: {
    args: [1, 1],
    description: "Escapes &, <, and > for Slack text",
    run: (value) => escapeSlack(text(value)),
  },
  markdown: {
    args: [1, 1],
    description: "Escapes Markdown characters for Discord and Teams",
    run: (value) => escapeMarkdown(text(value)),
  },
};

interface Token {
  tag: boolean;
  value: string;
  offset: number;
  trimLeft?: boolean;
  trimRight?: boolean;
}

function lineOf(source: string, offset: number) {
  return source.slice(0, offset).split("\n").length;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{{", index);
    if (open < 0) {
      tokens.push({ tag: false, value: source.slice(index), offset: index });
      break;
    }
    if (open > index)
      tokens.push({
        tag: false,
        value: source.slice(index, open),
        offset: index,
      });
    let start = open + 2;
    const trimLeft = source[start] === "~";
    if (trimLeft) start += 1;
    const comment = source.startsWith("!--", start);
    const closing = comment ? /--~?\}\}/g : /\}\}/g;
    closing.lastIndex = comment ? start + 3 : start;
    const match = closing.exec(source);
    if (!match)
      throw new TemplateError(
        `A "{{" on line ${lineOf(source, open)} is never closed.`,
      );
    let end = comment ? match.index + 2 : match.index;
    let inner = source.slice(start, end);
    const trimRight = inner.endsWith("~") || match[0].includes("~");
    if (inner.endsWith("~")) inner = inner.slice(0, -1);
    if (comment) end = match.index + match[0].length - 2;
    tokens.push({
      tag: true,
      value: inner.trim(),
      offset: open,
      trimLeft,
      trimRight,
    });
    index = end + 2;
  }
  tokens.forEach((token, position) => {
    if (!token.tag) return;
    const previous = tokens[position - 1];
    const next = tokens[position + 1];
    if (token.trimLeft && previous && !previous.tag)
      previous.value = previous.value.replace(/\s+$/, "");
    if (token.trimRight && next && !next.tag)
      next.value = next.value.replace(/^\s+/, "");
  });
  return tokens;
}

type Part = { type: "string" | "word" | "(" | ")"; value: string };
function lex(input: string, line: number): Part[] {
  const parts: Part[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "(" || char === ")") {
      parts.push({ type: char, value: char });
      index += 1;
    } else if (char === '"' || char === "'") {
      let value = "";
      let position = index + 1;
      while (position < input.length && input[position] !== char) {
        if (input[position] === "\\" && position + 1 < input.length) {
          const escaped = input[position + 1];
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          position += 2;
        } else {
          value += input[position];
          position += 1;
        }
      }
      if (position >= input.length)
        throw new TemplateError(`Unclosed quote on line ${line}.`);
      parts.push({ type: "string", value });
      index = position + 1;
    } else {
      const match = /^[^\s()"']+/.exec(input.slice(index))!;
      parts.push({ type: "word", value: match[0] });
      index += match[0].length;
    }
  }
  return parts;
}

const PATH_SEGMENT = /^(?:[A-Za-z_$][\w$-]*|\d+)$/;
function word(value: string, line: number): Expr {
  if (value === "true" || value === "false")
    return { kind: "literal", value: value === "true" };
  if (value === "null") return { kind: "literal", value: null };
  if (/^-?\d+(?:\.\d+)?$/.test(value))
    return { kind: "literal", value: Number(value) };
  if (["@index", "@first", "@last"].includes(value))
    return { kind: "data", name: value.slice(1), segments: [] };
  if (value === "@delivery" || value.startsWith("@delivery.")) {
    const segments = value.split(".").slice(1);
    if (!segments.every((segment) => PATH_SEGMENT.test(segment)))
      throw new TemplateError(
        `"${value}" on line ${line} is not a valid path.`,
      );
    return { kind: "data", name: "delivery", segments };
  }
  let segments = value.split(".");
  let root = false;
  if (segments[0] === "@root") {
    root = true;
    segments = segments.slice(1);
  } else if (segments[0] === "this") segments = segments.slice(1);
  if (!segments.every((segment) => PATH_SEGMENT.test(segment)))
    throw new TemplateError(`"${value}" on line ${line} is not a valid path.`);
  return { kind: "path", root, segments };
}

function parseExpression(input: string, line: number): Expr {
  const parts = lex(input, line);
  if (!parts.length) throw new TemplateError(`Empty tag on line ${line}.`);
  let position = 0;
  function term(): Expr {
    const part = parts[position];
    if (!part) throw new TemplateError(`Missing value on line ${line}.`);
    position += 1;
    if (part.type === "string") return { kind: "literal", value: part.value };
    if (part.type === ")")
      throw new TemplateError(`Unexpected ")" on line ${line}.`);
    if (part.type === "(") {
      const call = sequence();
      if (parts[position]?.type !== ")")
        throw new TemplateError(`Missing ")" on line ${line}.`);
      position += 1;
      if (call.kind !== "call")
        throw new TemplateError(`Parentheses need a helper on line ${line}.`);
      return call;
    }
    return word(part.value, line);
  }
  function sequence(): Expr {
    const first = parts[position];
    const rest = parts
      .slice(position + 1)
      .findIndex((part) => part.type === ")");
    const available = rest < 0 ? parts.length - position - 1 : rest;
    if (first?.type === "word" && available > 0) {
      const helper = TEMPLATE_HELPERS[first.value];
      if (!helper)
        throw new TemplateError(
          `Unknown helper "${first.value}" on line ${line}.`,
        );
      position += 1;
      const args: Expr[] = [];
      while (position < parts.length && parts[position].type !== ")")
        args.push(term());
      const [min, max] = helper.args;
      if (args.length < min || args.length > max)
        throw new TemplateError(
          `"${first.value}" takes ${min === max ? min : `${min}–${max}`} argument${max === 1 ? "" : "s"} (line ${line}).`,
        );
      return { kind: "call", name: first.value, args };
    }
    return term();
  }
  const expression = sequence();
  if (position < parts.length)
    throw new TemplateError(
      `Unexpected "${parts[position].value}" on line ${line}.`,
    );
  return expression;
}

interface Frame {
  kind: "if" | "unless" | "each" | "with";
  node: Extract<Node, { kind: "if" | "each" | "with" }>;
  /** The list new nodes are appended to. */
  target: Node[];
  line: number;
  sawElse: boolean;
}

function parse(source: string): Node[] {
  if (new TextEncoder().encode(source).length > TEMPLATE_LIMITS.sourceBytes)
    throw new TemplateError("Templates are limited to 16 KiB.");
  const root: Node[] = [];
  const stack: Frame[] = [];
  const target = () => stack.at(-1)?.target ?? root;
  for (const token of tokenize(source)) {
    if (!token.tag) {
      if (token.value) target().push({ kind: "text", value: token.value });
      continue;
    }
    const line = lineOf(source, token.offset);
    const value = token.value;
    if (value.startsWith("!")) continue;
    const block = /^#(if|unless|each|with)\b\s*(.*)$/s.exec(value);
    if (block) {
      if (stack.length >= TEMPLATE_LIMITS.depth)
        throw new TemplateError(`Blocks nest at most 8 deep (line ${line}).`);
      const [, kind, rest] = block;
      if (!rest.trim())
        throw new TemplateError(`{{#${kind}}} needs a value on line ${line}.`);
      const expr = parseExpression(rest, line);
      const body: Node[] = [];
      const node: Frame["node"] =
        kind === "if" || kind === "unless"
          ? {
              kind: "if",
              branches: [{ test: expr, negate: kind === "unless", body }],
              otherwise: [],
            }
          : { kind: kind as "each" | "with", expr, body, otherwise: [] };
      target().push(node);
      stack.push({
        kind: kind as Frame["kind"],
        node,
        target: body,
        line,
        sawElse: false,
      });
      continue;
    }
    const elseTag = /^else(?:\s+if\s+(.+))?$/s.exec(value);
    if (elseTag) {
      const frame = stack.at(-1);
      if (!frame)
        throw new TemplateError(`{{else}} outside a block on line ${line}.`);
      if (frame.sawElse)
        throw new TemplateError(
          `A block has more than one {{else}} (line ${line}).`,
        );
      if (elseTag[1]) {
        if (frame.node.kind !== "if")
          throw new TemplateError(
            `{{else if}} only follows {{#if}} (line ${line}).`,
          );
        const body: Node[] = [];
        frame.node.branches.push({
          test: parseExpression(elseTag[1], line),
          negate: false,
          body,
        });
        frame.target = body;
      } else {
        frame.sawElse = true;
        frame.target = frame.node.otherwise;
      }
      continue;
    }
    const close = /^\/(if|unless|each|with)$/.exec(value);
    if (close) {
      const frame = stack.pop();
      if (!frame || frame.kind !== close[1])
        throw new TemplateError(
          frame
            ? `{{/${close[1]}}} on line ${line} closes {{#${frame.kind}}} from line ${frame.line}.`
            : `{{/${close[1]}}} on line ${line} has no opening block.`,
        );
      continue;
    }
    if (/^[#/]/.test(value))
      throw new TemplateError(`Unknown block "${value}" on line ${line}.`);
    target().push({ kind: "output", expr: parseExpression(value, line) });
  }
  const open = stack.pop();
  if (open)
    throw new TemplateError(
      `{{#${open.kind}}} on line ${open.line} is never closed.`,
    );
  return root;
}

interface Scope {
  value: unknown;
  data?: { index: number; first: boolean; last: boolean };
}
/** Values that are not part of the event, such as {{@delivery.timestamp}}. */
export interface TemplateData {
  delivery?: Record<string, unknown>;
}
interface State {
  steps: number;
  size: number;
  data: TemplateData;
}

function own(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && key === "length") return value.length;
  if (typeof value === "object" && Object.hasOwn(value, key))
    return (value as Record<string, unknown>)[key];
  return undefined;
}

function resolve(expr: Expr, scopes: Scope[], state: State): unknown {
  if ((state.steps += 1) > TEMPLATE_LIMITS.steps)
    throw new TemplateError("The template does too much work to render.");
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "data": {
      if (expr.name === "delivery")
        return expr.segments.reduce<unknown>(
          (value, segment) => own(value, segment),
          state.data.delivery,
        );
      const data = [...scopes].reverse().find((scope) => scope.data)?.data;
      return data?.[expr.name as keyof typeof data];
    }
    case "call":
      return TEMPLATE_HELPERS[expr.name].run(
        ...expr.args.map((arg) => resolve(arg, scopes, state)),
      );
    case "path": {
      if (!expr.segments.length) return scopes.at(-1)?.value;
      // A name missing from the current scope is looked up in enclosing ones,
      // so {{event.type}} still works inside {{#each}}.
      const candidates = expr.root ? [scopes[0]] : [...scopes].reverse();
      const scope =
        candidates.find(
          (item) => own(item.value, expr.segments[0]) !== undefined,
        ) ?? candidates[0];
      return expr.segments.reduce<unknown>(
        (value, segment) => own(value, segment),
        scope?.value,
      );
    }
  }
}

function render(
  nodes: Node[],
  scopes: Scope[],
  mode: TemplateMode,
  state: State,
): string {
  let output = "";
  const append = (value: string) => {
    state.size += value.length;
    if (state.size > TEMPLATE_LIMITS.outputBytes)
      throw new TemplateError("The rendered body is larger than 256 KiB.");
    output += value;
  };
  for (const node of nodes) {
    if (node.kind === "text") append(node.value);
    else if (node.kind === "output") {
      const value = resolve(node.expr, scopes, state);
      if (value instanceof Raw) append(value.text);
      else
        append(
          mode === "json"
            ? JSON.stringify(text(value)).slice(1, -1)
            : text(value),
        );
    } else if (node.kind === "if") {
      const branch = node.branches.find(
        (item) => truthy(resolve(item.test, scopes, state)) !== item.negate,
      );
      append(
        render(branch ? branch.body : node.otherwise, scopes, mode, state),
      );
    } else if (node.kind === "with") {
      const value = resolve(node.expr, scopes, state);
      append(
        truthy(value)
          ? render(node.body, [...scopes, { value }], mode, state)
          : render(node.otherwise, scopes, mode, state),
      );
    } else {
      const value = resolve(node.expr, scopes, state);
      const items = Array.isArray(value)
        ? value.slice(0, TEMPLATE_LIMITS.loopItems)
        : [];
      if (!items.length) append(render(node.otherwise, scopes, mode, state));
      items.forEach((item, index) =>
        append(
          render(
            node.body,
            [
              ...scopes,
              {
                value: item,
                data: {
                  index,
                  first: index === 0,
                  last: index === items.length - 1,
                },
              },
            ],
            mode,
            state,
          ),
        ),
      );
    }
  }
  return output;
}

export interface CompiledTemplate {
  render(context: unknown, data?: TemplateData): string;
}

/** Parses once; throws TemplateError with a line number for invalid syntax. */
export function compileTemplate(
  source: string,
  mode: TemplateMode,
): CompiledTemplate {
  const nodes = parse(source);
  return {
    render(context, data = {}) {
      const output = render(nodes, [{ value: context }], mode, {
        steps: 0,
        size: 0,
        data,
      });
      if (mode === "json") {
        try {
          JSON.parse(output);
        } catch (error) {
          throw new TemplateError(
            `The rendered body is not valid JSON${error instanceof Error ? `: ${error.message}` : "."}`,
          );
        }
      }
      return output;
    },
  };
}

export function renderTemplate(
  source: string,
  context: unknown,
  mode: TemplateMode,
  data?: TemplateData,
): string {
  return compileTemplate(source, mode).render(context, data);
}
