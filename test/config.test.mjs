import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildDirectOpenClawGatewayConfig,
  DEFAULT_OPENCLAW_GATEWAY_PORT,
  loadOpenClawGatewayConfig,
  resolveOpenClawConfigPath
} from "../dist/config.js";

async function withTempDir(fn) {
  const dir = path.join(
    tmpdir(),
    `openclaw-acp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolveOpenClawConfigPath defaults to ~/.openclaw/openclaw.json", () => {
  const configPath = resolveOpenClawConfigPath(undefined, "test-home");

  assert.equal(
    configPath,
    path.join("test-home", ".openclaw", "openclaw.json")
  );
});

test("resolveOpenClawConfigPath uses --config_path as the directory containing openclaw.json", () => {
  const configPath = resolveOpenClawConfigPath("/opt/OpenClaw Runtime", "/ignored");

  assert.equal(configPath, path.join("/opt/OpenClaw Runtime", "openclaw.json"));
});

test("resolveOpenClawConfigPath expands ~ in --config_path", () => {
  const configPath = resolveOpenClawConfigPath("~/.openclaw-test", "test-home");

  assert.equal(
    configPath,
    path.join("test-home", ".openclaw-test", "openclaw.json")
  );
});

test("resolveOpenClawConfigPath expands bare ~ in --config_path", () => {
  const configPath = resolveOpenClawConfigPath("~", "test-home");

  assert.equal(configPath, path.join("test-home", "openclaw.json"));
});

test("buildDirectOpenClawGatewayConfig uses explicit url and token without reading openclaw.json", () => {
  const config = buildDirectOpenClawGatewayConfig({
    url: "ws://127.0.0.1:19001",
    token: "fixture-value-1",
    configPath: "~/.openclaw-test",
    homeDir: "test-home"
  });

  assert.deepEqual(config, {
    configFile: path.join("test-home", ".openclaw-test", "openclaw.json"),
    stateDir: path.join("test-home", ".openclaw-test"),
    gatewayUrl: "ws://127.0.0.1:19001",
    port: 19001,
    token: "fixture-value-1"
  });
});

test("buildDirectOpenClawGatewayConfig defaults state dir without reading openclaw.json", () => {
  const config = buildDirectOpenClawGatewayConfig({
    url: "ws://localhost:19001/gateway",
    token: "fixture-value-1",
    homeDir: "test-home"
  });

  assert.deepEqual(config, {
    configFile: path.join("test-home", ".openclaw", "openclaw.json"),
    stateDir: path.join("test-home", ".openclaw"),
    gatewayUrl: "ws://localhost:19001/gateway",
    port: 19001,
    token: "fixture-value-1"
  });
});

test("loadOpenClawGatewayConfig reads gateway port and token", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "openclaw.json");
    await writeFile(
      file,
      JSON.stringify({
        gateway: {
          port: 19001,
          auth: {
            mode: "token",
            token: "fixture-value-1"
          }
        }
      }),
      "utf8"
    );

    const config = await loadOpenClawGatewayConfig(file);

    assert.deepEqual(config, {
      configFile: file,
      stateDir: dir,
      gatewayUrl: "ws://127.0.0.1:19001",
      port: 19001,
      token: "fixture-value-1"
    });
  });
});

test("loadOpenClawGatewayConfig defaults missing gateway.port to OpenClaw's default port", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "openclaw.json");
    await writeFile(
      file,
      JSON.stringify({
        gateway: {
          auth: {
            token: "fixture-value-1"
          }
        }
      }),
      "utf8"
    );

    const config = await loadOpenClawGatewayConfig(file);

    assert.equal(config.port, DEFAULT_OPENCLAW_GATEWAY_PORT);
    assert.equal(
      config.gatewayUrl,
      `ws://127.0.0.1:${DEFAULT_OPENCLAW_GATEWAY_PORT}`
    );
  });
});

test("loadOpenClawGatewayConfig rejects invalid JSON", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "openclaw.json");
    await writeFile(file, "{ invalid", "utf8");

    await assert.rejects(
      loadOpenClawGatewayConfig(file),
      /Failed to parse openclaw\.json/
    );
  });
});

test("loadOpenClawGatewayConfig rejects missing gateway auth token", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "openclaw.json");
    await writeFile(
      file,
      JSON.stringify({
        gateway: {
          port: 19001,
          auth: {
            mode: "token"
          }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      loadOpenClawGatewayConfig(file),
      /openclaw\.json must include string field gateway\.auth\.token/
    );
  });
});
