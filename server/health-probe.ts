import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { AuthError } from "./auth.js";
import type { ProbeInput, ProbeResult } from "../shared/health.js";

const invalid = (message: string): never => {
  throw new AuthError(400, message);
};
function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    if (ip.range() !== "unicast") return false;
    if (ip.kind() === "ipv4") {
      return !(ip as ipaddr.IPv4).match(ipaddr.IPv4.parse("198.18.0.0"), 15);
    }
    const v6 = ip as ipaddr.IPv6;
    return (
      v6.match(ipaddr.IPv6.parse("2000::"), 3) &&
      !["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"].some((range) =>
        v6.match(ipaddr.parseCIDR(range) as [ipaddr.IPv6, number]),
      )
    );
  } catch {
    return false;
  }
}
function probeUrl(input: unknown): URL {
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(input)
  )
    return invalid("Enter a valid public HTTP or HTTPS URL.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalid("Enter a valid public HTTP or HTTPS URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    input.includes("#") ||
    !host ||
    (isIP(host) && !publicAddress(host))
  )
    return invalid(
      "Use a public HTTP or HTTPS URL without credentials or fragments.",
    );
  return url;
}
export function validateProbe(input: unknown): ProbeInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid("Invalid probe definition.");
  const data = input as Record<string, unknown>;
  const number = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const value = data[key] === undefined ? fallback : data[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      return invalid(`Invalid ${key}.`);
    return value;
  };
  if (
    typeof data.name !== "string" ||
    !data.name.trim() ||
    data.name.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(data.name)
  )
    return invalid("Probe name must contain 1–120 characters.");
  const url = probeUrl(data.url).href;
  const method = data.method ?? "GET";
  if (method !== "GET" && method !== "HEAD")
    return invalid("Probe method must be GET or HEAD.");
  const intervalSeconds = number("intervalSeconds", 60, 30, 3600);
  const timeoutMs = number("timeoutMs", 10000, 1000, 20000);
  const statusMin = number("statusMin", 200, 100, 599);
  const statusMax = number("statusMax", 299, statusMin, 599);
  const maxLatencyMs =
    data.maxLatencyMs == null ? null : number("maxLatencyMs", 1000, 1, 20000);
  const jsonPath = data.jsonPath ?? "";
  const jsonExpected =
    data.jsonExpected === undefined ? null : data.jsonExpected;
  if (
    typeof jsonPath !== "string" ||
    jsonPath.length > 256 ||
    (jsonPath &&
      (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(jsonPath) ||
        jsonPath
          .split(".")
          .some((part) =>
            ["__proto__", "constructor", "prototype"].includes(part),
          )))
  )
    return invalid("Use a simple dot-separated JSON path.");
  if (
    jsonExpected !== null &&
    !(typeof jsonExpected === "string" && jsonExpected.length <= 1024) &&
    !(typeof jsonExpected === "number" && Number.isFinite(jsonExpected)) &&
    typeof jsonExpected !== "boolean"
  )
    return invalid("JSON expected value must be a bounded primitive.");
  if (method === "HEAD" && jsonPath)
    return invalid("HEAD probes cannot check a JSON body.");
  if (data.enabled !== undefined && typeof data.enabled !== "boolean")
    return invalid("Invalid enabled state.");
  return {
    name: data.name.trim(),
    url,
    method,
    intervalSeconds,
    timeoutMs,
    statusMin,
    statusMax,
    maxLatencyMs,
    jsonPath,
    jsonExpected: jsonExpected as ProbeInput["jsonExpected"],
    failureThreshold: number("failureThreshold", 3, 1, 10),
    recoveryThreshold: number("recoveryThreshold", 2, 1, 10),
    enabled: data.enabled === undefined ? true : (data.enabled as boolean),
  };
}
export function validateHeaders(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input))
    return invalid("Headers must be an object.");
  const result: Record<string, string> = {};
  const entries = Object.entries(input);
  if (entries.length > 20) return invalid("Use at most 20 headers.");
  let size = 0;
  const blocked = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "expect",
    "trailer",
    "te",
    "keep-alive",
    "proxy-authorization",
    "proxy-authenticate",
    "accept-encoding",
  ]);
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(name) ||
      blocked.has(name) ||
      name.startsWith("proxy-") ||
      Object.hasOwn(result, name) ||
      typeof value !== "string" ||
      /[^\t\x20-\x7e\x80-\xff]/.test(value)
    )
      return invalid("Invalid or forbidden request header.");
    size += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (size > 8192) return invalid("Headers must total at most 8 KiB.");
    Object.defineProperty(result, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
export async function runProbe(
  input: ProbeInput,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let finished = false;
    let statusCode: number | null = null;
    const finish = (ok: boolean, reason: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      response?.destroy();
      request?.destroy();
      resolve({
        ok,
        reason,
        statusCode,
        latencyMs: Math.round(performance.now() - started),
      });
    };
    const timer = setTimeout(
      () => finish(false, "Probe timed out."),
      input.timeoutMs,
    );
    void (async () => {
      const url = probeUrl(input.url);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await dns.lookup(host, { all: true, verbatim: true });
      if (finished) return;
      if (
        !addresses.length ||
        addresses.some(({ address }) => !publicAddress(address))
      ) {
        finish(false, "Target must resolve only to public addresses.");
        return;
      }
      const selected = addresses[0];
      request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: input.method,
          headers: {
            ...validateHeaders(headers),
            "accept-encoding": "identity",
          },
          agent: false,
          maxHeaderSize: 16384,
          // The original URL retains Host and TLS hostname verification. No second DNS lookup.
          lookup: ((
            _hostname: string,
            options: { all?: boolean },
            callback: (...args: any[]) => void,
          ) => {
            if (options.all) callback(null, [selected]);
            else callback(null, selected.address, selected.family);
          }) as NonNullable<http.RequestOptions["lookup"]>,
        },
        (incoming) => {
          response = incoming;
          if (finished) {
            incoming.destroy();
            return;
          }
          statusCode = incoming.statusCode ?? null;
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on("error", () =>
            finish(false, "Response could not be read."),
          );
          incoming.on("aborted", () =>
            finish(false, "Response was interrupted."),
          );
          incoming.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) {
              finish(false, "Response body is too large.");
              return;
            }
            if (input.jsonPath) chunks.push(chunk);
          });
          incoming.on("end", () => {
            if (finished) return;
            if (
              statusCode === null ||
              statusCode < input.statusMin ||
              statusCode > input.statusMax
            )
              return finish(
                false,
                "HTTP status is outside the accepted range.",
              );
            if (
              input.maxLatencyMs !== null &&
              performance.now() - started > input.maxLatencyMs
            )
              return finish(false, "Response exceeded the latency limit.");
            if (input.jsonPath) {
              let value: unknown;
              try {
                value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                return finish(false, "Response is not valid JSON.");
              }
              for (const part of input.jsonPath.split("."))
                value =
                  value !== null &&
                  typeof value === "object" &&
                  Object.hasOwn(value, part)
                    ? (value as Record<string, unknown>)[part]
                    : undefined;
              if (value !== input.jsonExpected)
                return finish(false, "JSON condition did not match.");
            }
            finish(true, "Probe passed.");
          });
        },
      );
      request.on("error", () => finish(false, "Connection failed."));
      request.end();
    })().catch(() => finish(false, "Probe could not reach a public target."));
  });
}
