export type JsonPrimitive = string | number | boolean | null;

export type JsonPathStep =
  | { kind: "property"; key: string }
  | { kind: "filter"; key: string; expected: JsonPrimitive };

export function parseJsonPath(path: string): JsonPathStep[] {
  if (!path || path.length > 256) throw new Error("Invalid JSON path.");
  const blocked = new Set(["__proto__", "constructor", "prototype"]);
  const steps: JsonPathStep[] = [];
  let rest = path;
  let needProperty = true;
  while (rest) {
    if (needProperty) {
      const property = /^[A-Za-z0-9_-]+/.exec(rest)?.[0];
      if (!property || blocked.has(property))
        throw new Error("Invalid JSON path.");
      steps.push({ kind: "property", key: property });
      rest = rest.slice(property.length);
      needProperty = false;
      continue;
    }
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      needProperty = true;
      continue;
    }
    const filter =
      /^\[\?\(@\.([A-Za-z0-9_-]+)==((?:"(?:\\.|[^"\\])*")|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\)\]/.exec(
        rest,
      );
    if (!filter || blocked.has(filter[1]))
      throw new Error("Invalid JSON path.");
    const expected = JSON.parse(filter[2]) as JsonPrimitive;
    if (typeof expected === "number" && !Number.isFinite(expected))
      throw new Error("Invalid JSON path.");
    steps.push({ kind: "filter", key: filter[1], expected });
    rest = rest.slice(filter[0].length);
  }
  if (needProperty) throw new Error("Invalid JSON path.");
  return steps;
}

export function readJsonPath(value: unknown, steps: JsonPathStep[]): unknown {
  for (const step of steps) {
    if (step.kind === "property") {
      value =
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, step.key)
          ? (value as Record<string, unknown>)[step.key]
          : undefined;
    } else {
      value = Array.isArray(value)
        ? value.find(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              Object.hasOwn(item, step.key) &&
              (item as Record<string, unknown>)[step.key] === step.expected,
          )
        : undefined;
    }
  }
  return value;
}
