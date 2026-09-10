import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  SECURITY_HEADERS,
  verifyAccessKey,
  verifyWebhookSignature,
} from "./security.js";

test("production headers forbid inline scripts, framing, and unused browser features", () => {
  const policy = Object.fromEntries(
    SECURITY_HEADERS["Content-Security-Policy"]
      .split("; ")
      .map((directive) => [
        directive.split(" ")[0],
        directive.split(" ").slice(1),
      ]),
  );
  assert.deepEqual(policy["script-src"], ["'self'"]);
  assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
  assert.deepEqual(policy["manifest-src"], ["'self'"]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.equal(SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.match(SECURITY_HEADERS["Permissions-Policy"], /camera=\(\)/);
  assert.match(SECURITY_HEADERS["Permissions-Policy"], /fullscreen=\(self\)/);
  assert.equal(SECURITY_HEADERS["Cross-Origin-Opener-Policy"], "same-origin");
});

test("HMAC verification matches the GitHub documented test vector", () => {
  const signature =
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(
    verifyWebhookSignature(
      Buffer.from("Hello, World!"),
      signature,
      "It's a Secret to Everybody",
    ),
    true,
  );
  assert.equal(
    verifyWebhookSignature(
      Buffer.from("Hello, World?"),
      signature,
      "It's a Secret to Everybody",
    ),
    false,
  );
  for (const invalid of [
    undefined,
    "",
    "sha1=abc",
    "sha256=zz",
    signature.slice(0, -1),
  ])
    assert.equal(
      verifyWebhookSignature(Buffer.from("Hello, World!"), invalid, "secret"),
      false,
    );
});

test("HMAC checks raw UTF-8 bytes and keys fail closed when absent", () => {
  const body = Buffer.from('{"title":"Shipping 🚀"}');
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(body, signature, "secret"), true);
  assert.equal(verifyAccessKey("key", "key"), true);
  assert.equal(verifyAccessKey("wrong", "key"), false);
  assert.equal(verifyAccessKey("", undefined), false);
});
