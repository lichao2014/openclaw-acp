import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGatewayProtocolAdapter,
  isGatewayProtocolVersion,
  SUPPORTED_GATEWAY_PROTOCOLS
} from "../dist/protocols/index.js";

test("gateway protocol registry exposes supported versions", () => {
  assert.deepEqual(SUPPORTED_GATEWAY_PROTOCOLS, ["v3", "v4"]);
  assert.equal(isGatewayProtocolVersion("v3"), true);
  assert.equal(isGatewayProtocolVersion("v4"), true);
  assert.equal(isGatewayProtocolVersion("v5"), false);
});

test("gateway protocol registry rejects unsupported versions", () => {
  assert.throws(
    () => createGatewayProtocolAdapter("v5"),
    /Unsupported gateway protocol: v5/
  );
});
