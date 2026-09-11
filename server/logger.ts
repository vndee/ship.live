/**
 * Structured operational logs. Callers pass explicit fields; request bodies,
 * headers, tokens, and query strings are never logged. Errors contribute their
 * message only, because GitHub and database errors never embed credentials.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}
export interface LoggerOptions {
  level?: LogLevel;
  format?: "json" | "text";
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Error objects log their message; everything else must already be plain data. */
function plain(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  if (typeof value === "bigint") return value.toString();
  return value;
}

function textValue(value: unknown): string {
  const data = plain(value);
  if (typeof data === "string")
    return /^[\w.:/@+-]+$/.test(data) ? data : JSON.stringify(data);
  return JSON.stringify(data) ?? String(data);
}

export function createLogger(
  options: LoggerOptions = {},
  base: LogFields = {},
): Logger {
  const threshold = LEVELS[options.level ?? "info"];
  const format = options.format ?? "text";
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((line: string, level: LogLevel) =>
      (level === "warn" || level === "error"
        ? process.stderr
        : process.stdout
      ).write(`${line}\n`));
  function emit(level: LogLevel, message: string, fields?: LogFields) {
    if (LEVELS[level] < threshold) return;
    const merged = { ...base, ...fields };
    if (format === "json") {
      const entry: LogFields = {
        time: now().toISOString(),
        level,
        msg: message,
      };
      for (const [key, value] of Object.entries(merged))
        if (value !== undefined && !(key in entry)) entry[key] = plain(value);
      write(JSON.stringify(entry), level);
      return;
    }
    const pairs = Object.entries(merged)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ` ${key}=${textValue(value)}`)
      .join("");
    write(
      `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${pairs}`,
      level,
    );
  }
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

/** Unknown values fall back to defaults so a typo never stops the server. */
export function logOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LoggerOptions {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  const format = env.LOG_FORMAT?.trim().toLowerCase();
  return {
    level: level && level in LEVELS ? (level as LogLevel) : "info",
    format:
      format === "json" || format === "text"
        ? format
        : env.NODE_ENV === "production"
          ? "json"
          : "text",
  };
}

export const log: Logger = createLogger(logOptionsFromEnv());
