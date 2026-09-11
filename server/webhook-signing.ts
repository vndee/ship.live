import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ship.live's signature: X-Ship-Signature: v1=<hex HMAC-SHA256> over
 * "<X-Ship-Timestamp>.<body>", so a receiver can reject replays by age.
 */
export function shipSignature(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Constant-time check, for receivers and tests. */
export function verifyShipSignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(shipSignature(secret, timestamp, body));
  const supplied = Buffer.from(signature);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

/**
 * Lark and Feishu custom bots with signature verification expect timestamp
 * and sign fields in the body: base64(HMAC-SHA256 keyed by
 * "<timestamp>\n<secret>" over an empty message). Timestamps are seconds and
 * must be within an hour of Lark's clock.
 */
export function larkSignature(secret: string, timestamp: number): string {
  return createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
}
