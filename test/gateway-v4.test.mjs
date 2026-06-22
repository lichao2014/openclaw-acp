import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createGatewayProtocolAdapter } from "../dist/protocols/index.js";
import { loadOrCreateDeviceIdentity } from "../dist/protocols/v3/device-auth.js";
import { acceptGatewayConnect, FakeGatewayTransport } from "./helpers/fake-gateway-transport.mjs";

function createConnectedGateway(options = {}) {
  const transport = new FakeGatewayTransport();
  const adapter = createGatewayProtocolAdapter("v4");
  const gateway = adapter.createClient({
    url: "ws://127.0.0.1:19001",
    token: "fixture-value-1",
    transportFactory: () => transport,
    clientVersion: "test-version",
    ...options
  });

  const ready = gateway.connect();
  const connectFrame = acceptGatewayConnect(transport, {
    protocol: 4,
    serverVersion: "2026.5.12"
  });

  return { gateway, ready, transport, connectFrame };
}

test("v4 adapter sends a protocol 4 connect request with token auth", async () => {
  const { ready, connectFrame } = createConnectedGateway();
  await ready;

  assert.equal(connectFrame.type, "req");
  assert.equal(connectFrame.method, "connect");
  assert.equal(connectFrame.params.minProtocol, 4);
  assert.equal(connectFrame.params.maxProtocol, 4);
  assert.equal(connectFrame.params.client.id, "gateway-client");
  assert.equal(connectFrame.params.client.displayName, "ACP");
  assert.equal(connectFrame.params.client.mode, "backend");
  assert.equal(connectFrame.params.auth.token, "fixture-value-1");
  assert.deepEqual(connectFrame.params.caps, ["tool-events"]);
});

test("v4 adapter uses local backend login without device pairing", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-v4-"));
  const { ready, connectFrame } = createConnectedGateway({ stateDir });
  await ready;

  assert.equal(connectFrame.params.device, undefined);
});

test("v4 adapter does not send a stored operator device token", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-v4-"));
  const identity = loadOrCreateDeviceIdentity(stateDir);
  await mkdir(path.join(stateDir, "identity"), { recursive: true });
  await writeFile(
    path.join(stateDir, "identity", "device-auth.json"),
    `${JSON.stringify(
      {
        version: 1,
        deviceId: identity.deviceId,
        tokens: {
          operator: {
            token: "fixture-value-3",
            role: "operator",
            scopes: ["operator.admin"],
            updatedAtMs: 1
          }
        }
      },
      null,
      2
    )}\n`
  );

  const { ready, connectFrame } = createConnectedGateway({ stateDir });
  await ready;

  assert.equal(connectFrame.params.auth.token, "fixture-value-1");
  assert.equal(connectFrame.params.auth.deviceToken, undefined);
});
