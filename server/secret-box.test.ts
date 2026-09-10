import assert from "node:assert/strict";
import test from "node:test";
import { SecretBox } from "./secret-box.js";

const box = new SecretBox("11".repeat(32));

test("sealed secrets open only with the same key and context", () => {
  const sealed = box.seal(
    "https://hooks.slack.com/services/T/B/secret",
    "webhook:1:url",
  );
  assert.doesNotMatch(sealed, /slack|secret/);
  assert.notEqual(
    sealed,
    box.seal("https://hooks.slack.com/services/T/B/secret", "webhook:1:url"),
  );
  assert.equal(
    box.open(sealed, "webhook:1:url"),
    "https://hooks.slack.com/services/T/B/secret",
  );
  assert.throws(() => box.open(sealed, "webhook:2:url"));
  assert.throws(() =>
    new SecretBox("22".repeat(32)).open(sealed, "webhook:1:url"),
  );
  const [iv, tag, data] = sealed.split(".");
  const flipped = `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`;
  assert.throws(() => box.open([iv, tag, flipped].join("."), "webhook:1:url"));
});

test("an unconfigured box refuses to seal and a malformed key is rejected", () => {
  const empty = new SecretBox("");
  assert.equal(empty.configured, false);
  assert.throws(() => empty.seal("x", "c"), /not configured/);
  assert.throws(() => new SecretBox("not-hex"), /64 hexadecimal/);
});
