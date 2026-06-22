import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createGatewayProtocolAdapter } from "../dist/protocols/index.js";
import { acceptGatewayConnect, FakeGatewayTransport } from "./helpers/fake-gateway-transport.mjs";

function createConnectedGateway(options = {}) {
  const transport = new FakeGatewayTransport();
  const adapter = createGatewayProtocolAdapter("v3");
  const gateway = adapter.createClient({
    url: "ws://127.0.0.1:19001",
    token: "fixture-value-1",
    transportFactory: () => transport,
    clientVersion: "test-version",
    ...options
  });

  const ready = gateway.connect();
  const connectFrame = acceptGatewayConnect(transport, {
    protocol: 3,
    serverVersion: "2026.4.21-5"
  });

  return { gateway, ready, transport, connectFrame };
}

test("v3 adapter sends a protocol 3 connect request with token auth", async () => {
  const { ready, connectFrame } = createConnectedGateway();
  await ready;

  assert.equal(connectFrame.type, "req");
  assert.equal(connectFrame.method, "connect");
  assert.equal(connectFrame.params.minProtocol, 3);
  assert.equal(connectFrame.params.maxProtocol, 3);
  assert.equal(connectFrame.params.client.id, "cli");
  assert.equal(connectFrame.params.client.displayName, "ACP");
  assert.equal(connectFrame.params.client.mode, "cli");
  assert.equal(connectFrame.params.auth.token, "fixture-value-1");
  assert.deepEqual(connectFrame.params.caps, ["tool-events"]);
});

test("v3 adapter signs connect requests with a local device identity", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-v3-"));
  const { ready, connectFrame } = createConnectedGateway({ stateDir });
  await ready;

  const device = connectFrame.params.device;
  assert.equal(typeof device.id, "string");
  assert.equal(typeof device.publicKey, "string");
  assert.equal(typeof device.signature, "string");
  assert.equal(typeof device.signedAt, "number");
  assert.equal(device.nonce, "nonce-1");
  assert.equal(device.id, sha256Hex(base64UrlDecode(device.publicKey)));

  const payload = [
    "v3",
    device.id,
    "cli",
    "cli",
    "operator",
    "operator.admin",
    String(device.signedAt),
    "fixture-value-1",
    "nonce-1",
    process.platform,
    ""
  ].join("|");
  assert.equal(
    verifyEd25519(device.publicKey, payload, device.signature),
    true
  );

  const identity = JSON.parse(
    await readFile(path.join(stateDir, "identity", "device.json"), "utf8")
  );
  assert.equal(identity.version, 1);
  assert.equal(identity.deviceId, device.id);
});

test("v3 adapter stores issued device auth tokens from hello-ok", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-v3-"));
  const { ready, connectFrame } = createConnectedGateway({ stateDir });
  await ready;

  const store = JSON.parse(
    await readFile(path.join(stateDir, "identity", "device-auth.json"), "utf8")
  );
  assert.equal(store.version, 1);
  assert.equal(store.deviceId, connectFrame.params.device.id);
  assert.deepEqual(store.tokens.operator, {
    token: "fixture-value-2",
    role: "operator",
    scopes: ["operator.admin"],
    updatedAtMs: store.tokens.operator.updatedAtMs
  });
  assert.equal(typeof store.tokens.operator.updatedAtMs, "number");
});

test("v3 client sends Gateway request frames and waits through accepted responses when requested", async () => {
  const { gateway, ready, transport } = createConnectedGateway();
  await ready;

  const response = gateway.request(
    "chat.send",
    {
      sessionKey: "acp:session-1",
      message: "hello"
    },
    {
      expectFinal: true,
      timeoutMs: null
    }
  );

  const requestFrame = transport.sent.at(-1);
  assert.equal(requestFrame.type, "req");
  assert.equal(requestFrame.method, "chat.send");
  assert.deepEqual(requestFrame.params, {
    sessionKey: "acp:session-1",
    message: "hello"
  });

  transport.receive({
    type: "res",
    id: requestFrame.id,
    ok: true,
    payload: {
      status: "accepted"
    }
  });

  transport.receive({
    type: "res",
    id: requestFrame.id,
    ok: true,
    payload: {
      status: "final",
      ok: true
    }
  });

  assert.deepEqual(await response, {
    status: "final",
    ok: true
  });
});

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlDecode(input) {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
    "base64"
  );
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function verifyEd25519(publicKeyBase64Url, payload, signatureBase64Url) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKeyBase64Url)]),
    type: "spki",
    format: "der"
  });
  return crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    key,
    base64UrlDecode(signatureBase64Url)
  );
}
