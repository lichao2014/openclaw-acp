import assert from "node:assert/strict";
import { test } from "node:test";

import { createGatewayProtocolAdapter } from "../dist/protocols/index.js";
import { acceptGatewayConnect, FakeGatewayTransport } from "./helpers/fake-gateway-transport.mjs";

function createConnectedGateway() {
  const transport = new FakeGatewayTransport();
  const adapter = createGatewayProtocolAdapter("v4");
  const gateway = adapter.createClient({
    url: "ws://127.0.0.1:19001",
    token: "fixture-value-1",
    transportFactory: () => transport,
    clientVersion: "test-version"
  });

  const ready = gateway.connect();
  acceptGatewayConnect(transport, {
    protocol: 4,
    serverVersion: "2026.5.12"
  });

  return { gateway, ready, transport };
}

test("shared gateway client dispatches event frames", async () => {
  const { gateway, ready, transport } = createConnectedGateway();
  await ready;

  const received = [];
  gateway.onEvent((event) => {
    received.push(event);
  });

  transport.receive({
    type: "event",
    event: "chat.message",
    seq: 7,
    payload: {
      message: "hello"
    }
  });

  assert.deepEqual(received, [
    {
      type: "event",
      event: "chat.message",
      seq: 7,
      payload: {
        message: "hello"
      }
    }
  ]);
});
