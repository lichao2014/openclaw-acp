import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { connectOpenClawGateway } from "../dist/run.js";
import { createGatewayProtocolAdapter } from "../dist/protocols/index.js";
import { acceptGatewayConnect, FakeGatewayTransport } from "./helpers/fake-gateway-transport.mjs";

test("connectOpenClawGateway falls back from v4 to v3 on protocol mismatch", async () => {
  await withGatewayConfig(async (gatewayConfig) => {
    const transports = [];
    const connectPromise = connectOpenClawGateway({
      gatewayConfig,
      protocolAdapters: [
        createGatewayProtocolAdapter("v4"),
        createGatewayProtocolAdapter("v3")
      ],
      transportFactory: () => {
        const transport = new FakeGatewayTransport();
        transports.push(transport);
        return transport;
      }
    });

    rejectGatewayConnect(transports[0], "protocol mismatch");
    await waitFor(() => transports.length === 2);
    acceptGatewayConnect(transports[1], {
      protocol: 3
    });

    const gateway = await connectPromise;
    try {
      assert.equal(transports.length, 2);
      assert.equal(transports[0].sent.at(-1).params.minProtocol, 4);
      assert.equal(transports[0].sent.at(-1).params.maxProtocol, 4);
      assert.equal(transports[1].sent.at(-1).params.minProtocol, 3);
      assert.equal(transports[1].sent.at(-1).params.maxProtocol, 3);
    } finally {
      gateway.close();
    }
  });
});

test("connectOpenClawGateway does not fall back on non-protocol connection errors", async () => {
  await withGatewayConfig(async (gatewayConfig) => {
    const transports = [];
    const connectPromise = connectOpenClawGateway({
      gatewayConfig,
      protocolAdapters: [
        createGatewayProtocolAdapter("v4"),
        createGatewayProtocolAdapter("v3")
      ],
      transportFactory: () => {
        const transport = new FakeGatewayTransport();
        transports.push(transport);
        return transport;
      }
    });

    rejectGatewayConnect(transports[0], "authentication failed");

    await assert.rejects(connectPromise, /authentication failed/);
    assert.equal(transports.length, 1);
  });
});

async function withGatewayConfig(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-acp-run-"));
  try {
    return await fn({
      configFile: path.join(stateDir, "openclaw.json"),
      stateDir,
      gatewayUrl: "ws://127.0.0.1:19001",
      port: 19001,
      token: "fixture-value-1"
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function rejectGatewayConnect(transport, message) {
  transport.open();
  transport.receive({
    type: "event",
    event: "connect.challenge",
    payload: {
      nonce: "nonce-1"
    }
  });

  const connectFrame = transport.sent.at(-1);
  transport.receive({
    type: "res",
    id: connectFrame.id,
    ok: false,
    error: {
      code: "invalid_request",
      message
    }
  });
}

async function waitFor(predicate) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
