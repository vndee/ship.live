import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
