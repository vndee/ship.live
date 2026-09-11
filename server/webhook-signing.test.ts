import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  larkSignature,
  shipSignature,
  verifyShipSignature,
} from "./webhook-signing.js";

test("ship signatures cover the timestamp and body and verify in constant time", () => {
  const body = '{"type":"webhook.test"}';
  const signature = shipSignature("secret", 1789027509, body);
  assert.equal(
    signature,
    `v1=${createHmac("sha256", "secret").update(`1789027509.${body}`).digest("hex")}`,
  );
  assert.equal(
    verifyShipSignature("secret", 1789027509, body, signature),
    true,
  );
  assert.equal(
    verifyShipSignature("secret", 1789027510, body, signature),
    false,
  );
  assert.equal(
    verifyShipSignature("other", 1789027509, body, signature),
    false,
  );
  assert.equal(verifyShipSignature("secret", 1789027509, body, "v1=00"), false);
});

test("Lark signatures key HMAC-SHA256 with the timestamp and secret over an empty message", () => {
  const sign = larkSignature("lark-secret", 1789027509);
  assert.equal(
    sign,
    createHmac("sha256", "1789027509\nlark-secret").update("").digest("base64"),
  );
  assert.match(sign, /^[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(larkSignature("lark-secret", 1789027510), sign);
});
