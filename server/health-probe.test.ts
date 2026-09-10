import assert from "node:assert/strict";
import { test, mock } from "node:test";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { validateProbe, validateHeaders, runProbe } from "./health-probe.js";

const definition = (extra = {}) => ({
  name: "API",
  url: "https://example.com/health",
  ...extra,
});
test("validates defaults and rejects unsafe or unbounded definitions", () => {
  assert.equal(validateProbe(definition()).timeoutMs, 10000);
  for (const extra of [
    { method: "POST" },
    { timeoutMs: 21000 },
    { intervalSeconds: 29 },
    { failureThreshold: 0 },
    { recoveryThreshold: 11 },
    { statusMin: 300, statusMax: 200 },
    { enabled: "yes" },
    { method: "HEAD", jsonPath: "ok", jsonExpected: true },
    { jsonPath: "__proto__.ok" },
    { jsonExpected: {} },
  ])
    assert.throws(() => validateProbe(definition(extra)));
  for (const url of [
    "file:///etc/passwd",
    "http://user:secret@example.com",
    "https://example.com/#x",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://10.0.0.1",
    "http://100.64.0.1",
    "http://169.254.169.254",
    "http://192.0.0.8",
    "http://198.18.0.1",
    "http://224.0.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[64:ff9b::7f00:1]",
    "http://[2002:7f00:1::]",
    "http://[2001:db8::1]",
    "http://[3fff::1]",
  ])
    assert.throws(() => validateProbe(definition({ url })), url);
});
test("secret headers are bounded and cannot alter routing or inject lines", () => {
  assert.deepEqual(validateHeaders({ Authorization: "Bearer secret" }), {
    authorization: "Bearer secret",
  });
  for (const value of [
    { Host: "evil" },
    { Connection: "close" },
    { "Content-Length": "2" },
    { "X-Api-Key": "a\r\nx: y" },
    { x: "a".repeat(9000) },
    { Authorization: "a", authorization: "b" },
  ])
    assert.throws(() => validateHeaders(value));
});
test("rejects the entire DNS answer when any address is private, without network I/O", async () => {
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  const request = mock.method(http, "request", () => {
    throw new Error("Network must not run");
  });
  try {
    const result = await runProbe(
      validateProbe(definition({ url: "http://example.com" })),
      {},
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /public/);
    assert.equal(request.mock.callCount(), 0);
  } finally {
    resolver.mock.restore();
    request.mock.restore();
  }
});
test("pins DNS, evaluates status and JSON, bounds bodies, and never follows redirects", async () => {
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  let payload = '{"health":{"ok":true}}';
  let status = 200;
  const request = mock.method(
    http,
    "request",
    (_url: URL, options: any, callback: any) => {
      assert.equal(options.agent, false);
      options.lookup(
        "example.com",
        { all: true },
        (error: unknown, addresses: unknown) => {
          assert.equal(error, null);
          assert.deepEqual(addresses, [
            { address: "93.184.216.34", family: 4 },
          ]);
        },
      );
      const req = new EventEmitter() as any;
      req.destroy = () => req;
      req.end = () => {
        const response = new PassThrough() as any;
        response.statusCode = status;
        callback(response);
        response.end(payload);
      };
      return req;
    },
  );
  try {
    const probe = validateProbe(
      definition({
        url: "http://example.com",
        jsonPath: "health.ok",
        jsonExpected: true,
      }),
    );
    assert.equal((await runProbe(probe, {})).ok, true);
    payload = '{"health":{"ok":"true"}}';
    assert.equal((await runProbe(probe, {})).ok, false);
    payload = "secret invalid JSON";
    const invalid = await runProbe(probe, {});
    assert.equal(invalid.ok, false);
    assert.ok(!invalid.reason.includes("secret"));
    payload = "x".repeat(65537);
    assert.match((await runProbe(probe, {})).reason, /large/);
    status = 302;
    payload = "";
    assert.equal(
      (
        await runProbe(
          validateProbe(definition({ url: "http://example.com" })),
          {},
        )
      ).ok,
      false,
    );
  } finally {
    resolver.mock.restore();
    request.mock.restore();
  }
});
test("absolute timeout includes unresolved DNS", async () => {
  const resolver = mock.method(dns, "lookup", () => new Promise(() => {}));
  try {
    const start = Date.now();
    const result = await runProbe(
      validateProbe(definition({ timeoutMs: 1000 })),
      {},
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /timed out/);
    assert.ok(Date.now() - start < 2500);
  } finally {
    resolver.mock.restore();
  }
});

test("absolute deadline destroys a response that never ends", async () => {
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const response = new PassThrough() as any;
  response.statusCode = 200;
  let destroyed = false;
  const transport = mock.method(
    http,
    "request",
    (_url: URL, _options: any, callback: any) => {
      const request = new EventEmitter() as any;
      request.destroy = () => {
        destroyed = true;
        return request;
      };
      request.end = () => {
        callback(response);
        response.write("{");
      };
      return request;
    },
  );
  try {
    const result = await runProbe(
      validateProbe(definition({ url: "http://example.com", timeoutMs: 1000 })),
      {},
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /timed out/);
    assert.equal(destroyed, true);
    assert.equal(response.destroyed, true);
  } finally {
    resolver.mock.restore();
    transport.mock.restore();
    response.destroy();
  }
});

test("HTTPS retains the hostname and default certificate verification with a pinned address", async () => {
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const transport = mock.method(
    https,
    "request",
    (url: URL, options: any, callback: any) => {
      assert.equal(url.hostname, "example.com");
      assert.notEqual(options.rejectUnauthorized, false);
      assert.equal(options.checkServerIdentity, undefined);
      assert.equal(options.agent, false);
      options.lookup(
        "example.com",
        {},
        (error: unknown, address: string, family: number) => {
          assert.equal(error, null);
          assert.equal(address, "2606:4700:4700::1111");
          assert.equal(family, 6);
        },
      );
      const request = new EventEmitter() as any;
      request.destroy = () => request;
      request.end = () => {
        const response = new PassThrough() as any;
        response.statusCode = 204;
        callback(response);
        response.end();
      };
      return request;
    },
  );
  try {
    assert.equal(
      (await runProbe(validateProbe(definition({ method: "HEAD" })), {})).ok,
      true,
    );
  } finally {
    resolver.mock.restore();
    transport.mock.restore();
  }
});

test("filters status components by a stable primitive property", async () => {
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  let payload = JSON.stringify({
    components: [
      { name: "Chat Completions", status: "degraded" },
      { name: "Embeddings", status: "operational" },
    ],
  });
  const transport = mock.method(
    http,
    "request",
    (_url: URL, _options: any, callback: any) => {
      const request = new EventEmitter() as any;
      request.destroy = () => request;
      request.end = () => {
        const response = new PassThrough() as any;
        response.statusCode = 200;
        callback(response);
        response.end(payload);
      };
      return request;
    },
  );
  try {
    const probe = validateProbe(
      definition({
        url: "http://example.com",
        jsonPath: 'components[?(@.name=="Embeddings")].status',
        jsonExpected: "operational",
      }),
    );
    assert.equal((await runProbe(probe, {})).ok, true);
    for (const jsonPath of [
      'components[?(@.name!="Embeddings")].status',
      "components[?(@.name==process.exit())].status",
      "components[?(@.__proto__==null)].status",
    ])
      assert.throws(() =>
        validateProbe(definition({ jsonPath, jsonExpected: "operational" })),
      );
    payload = '{"components":[]}';
    const result = await runProbe(probe, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, "JSON condition did not match.");
  } finally {
    resolver.mock.restore();
    transport.mock.restore();
  }
});
