import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "../dist/cli.js";

test("parseCliArgs defaults to the v3 gateway protocol", () => {
  const parsed = parseCliArgs([]);

  assert.deepEqual(parsed, {
    gatewayProtocol: "v3"
  });
});

test("parseCliArgs accepts --config_path with a following directory", () => {
  const parsed = parseCliArgs(["--config_path", "fixture-openclaw-state"]);

  assert.deepEqual(parsed, {
    configPath: "fixture-openclaw-state",
    gatewayProtocol: "v3"
  });
});

test("parseCliArgs accepts --config_path=<dir>", () => {
  const parsed = parseCliArgs(["--config_path=fixture-openclaw-state-inline"]);

  assert.deepEqual(parsed, {
    configPath: "fixture-openclaw-state-inline",
    gatewayProtocol: "v3"
  });
});

test("parseCliArgs accepts --gateway_protocol v3", () => {
  const parsed = parseCliArgs(["--gateway_protocol", "v3"]);

  assert.deepEqual(parsed, {
    gatewayProtocol: "v3"
  });
});

test("parseCliArgs accepts --gateway_protocol v4", () => {
  const parsed = parseCliArgs(["--gateway_protocol", "v4"]);

  assert.deepEqual(parsed, {
    gatewayProtocol: "v4"
  });
});

test("parseCliArgs accepts --url and --token", () => {
  const parsed = parseCliArgs([
    "--url",
    "ws://127.0.0.1:19001",
    "--token",
    "fixture-value-1"
  ]);

  assert.deepEqual(parsed, {
    gatewayProtocol: "v3",
    url: "ws://127.0.0.1:19001",
    token: "fixture-value-1"
  });
});

test("parseCliArgs accepts --url=<url> and --token=<token>", () => {
  const parsed = parseCliArgs([
    "--url=ws://127.0.0.1:19001",
    "--token=fixture-value-1"
  ]);

  assert.deepEqual(parsed, {
    gatewayProtocol: "v3",
    url: "ws://127.0.0.1:19001",
    token: "fixture-value-1"
  });
});

test("parseCliArgs rejects unsupported gateway protocols", () => {
  assert.throws(
    () => parseCliArgs(["--gateway_protocol", "v5"]),
    /Unsupported gateway protocol: v5/
  );
});

test("parseCliArgs rejects missing --config_path value", () => {
  assert.throws(
    () => parseCliArgs(["--config_path"]),
    /Missing value for --config_path/
  );
});

test("parseCliArgs rejects missing --url value", () => {
  assert.throws(
    () => parseCliArgs(["--url"]),
    /Missing value for --url/
  );
});

test("parseCliArgs rejects missing --token value", () => {
  assert.throws(
    () => parseCliArgs(["--token"]),
    /Missing value for --token/
  );
});

test("parseCliArgs requires --url and --token to be used together", () => {
  assert.throws(
    () => parseCliArgs(["--url", "ws://127.0.0.1:19001"]),
    /--url and --token must be provided together/
  );
  assert.throws(
    () => parseCliArgs(["--token", "fixture-value-1"]),
    /--url and --token must be provided together/
  );
});

test("parseCliArgs rejects unknown arguments", () => {
  assert.throws(() => parseCliArgs(["--unknown"]), /Unknown argument: --unknown/);
});
