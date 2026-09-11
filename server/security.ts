import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Production response headers. Scripts, styles, fonts, and the manifest load
 * only from this origin; avatars are the one image host outside it.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://avatars.githubusercontent.com https://*.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // The wall display is the only browser feature the app requests.
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function verifyWebhookSignature(
  body: Buffer,
  signature: unknown,
  secret: string,
): boolean {
  if (
    !secret ||
    typeof signature !== "string" ||
    !/^sha256=[a-f\d]{64}$/i.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(signature.slice(7), "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(expected, supplied)
  );
}

export function verifyAccessKey(
  provided: unknown,
  expected: string | undefined,
): boolean {
  if (!expected || typeof provided !== "string" || provided.length > 4096)
    return false;
  // Hash first so length differences don't affect the constant-time comparison.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
