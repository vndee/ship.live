import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Requests to user-supplied URLs (health probes and webhooks) reach only
 * public unicast addresses. The address checked is the address connected
 * to: one DNS lookup is pinned to the socket, and redirects are not followed.
 */
export function publicAddress(address: string): boolean {
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

// Spaces and control characters never belong in a URL we request.
const unsafeCharacter = (input: string) =>
  [...input].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 32 || code === 127;
  });

/** A public HTTP(S) URL without credentials or a fragment, or undefined. */
export function publicHttpUrl(input: unknown): URL | undefined {
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    unsafeCharacter(input)
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
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
    return undefined;
  return url;
}

/** Resolves once; rejects unless every address is public. */
export async function resolvePublic(
  url: URL,
): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new OutboundError("Target must resolve only to public addresses.");
  return addresses[0];
}

export class OutboundError extends Error {}

/** Connects to the already-checked address while keeping Host and TLS names. */
export function pinnedLookup(selected: {
  address: string;
  family: number;
}): NonNullable<http.RequestOptions["lookup"]> {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  }) as NonNullable<http.RequestOptions["lookup"]>;
}

export interface OutboundRequest {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}
export interface OutboundResponse {
  /** Null when no response arrived. */
  status: number | null;
  /** Up to 64 KiB of the response body; the delivery log keeps its first KiB. */
  body: string;
  /** Seconds from a Retry-After header, when present and sensible. */
  retryAfter?: number;
  error?: string;
  latencyMs: number;
}

const RESPONSE_LIMIT = 65_536;

function retryAfter(value: string | string[] | undefined): number | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header)
    ? Number(header)
    : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, 3600)
    : undefined;
}

/** Sends one request; never throws, reporting failures in the result. */
export async function sendOutbound(
  request: OutboundRequest,
): Promise<OutboundResponse> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const url = publicHttpUrl(request.url);
  if (!url)
    return {
      status: null,
      body: "",
      error: "Use a public HTTP or HTTPS URL.",
      latencyMs: 0,
    };
  let selected: { address: string; family: number };
  try {
    selected = await resolvePublic(url);
  } catch (error) {
    return {
      status: null,
      body: "",
      error:
        error instanceof OutboundError
          ? error.message
          : "The host name could not be resolved.",
      latencyMs: elapsed(),
    };
  }
  return new Promise((resolve) => {
    let finished = false;
    let outgoing: http.ClientRequest | undefined;
    const finish = (result: Omit<OutboundResponse, "latencyMs">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      outgoing?.destroy();
      resolve({ ...result, latencyMs: elapsed() });
    };
    const timer = setTimeout(
      () => finish({ status: null, body: "", error: "The request timed out." }),
      request.timeoutMs ?? 10_000,
    );
    outgoing = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: request.method,
        headers: {
          ...request.headers,
          "content-length": String(Buffer.byteLength(request.body)),
          "accept-encoding": "identity",
        },
        agent: false,
        maxHeaderSize: 16_384,
        lookup: pinnedLookup(selected),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const status = incoming.statusCode ?? null;
        const done = () =>
          finish({
            status,
            body: Buffer.concat(chunks)
              .toString("utf8")
              .slice(0, RESPONSE_LIMIT),
            retryAfter: retryAfter(incoming.headers["retry-after"]),
          });
        incoming.on("data", (chunk: Buffer) => {
          if (bytes < RESPONSE_LIMIT) chunks.push(chunk);
          bytes += chunk.length;
          // The status is known; stop reading an oversized body.
          if (bytes > RESPONSE_LIMIT) done();
        });
        incoming.on("end", done);
        incoming.on("error", done);
        incoming.on("aborted", done);
      },
    );
    outgoing.on("error", () =>
      finish({ status: null, body: "", error: "The connection failed." }),
    );
    outgoing.end(request.body);
  });
}
