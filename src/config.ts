import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_OPENCLAW_GATEWAY_PORT = 18789;

export interface OpenClawGatewayConfig {
  configFile: string;
  stateDir: string;
  gatewayUrl: string;
  port: number;
  token: string;
}

export interface DirectOpenClawGatewayConfigOptions {
  url: string;
  token: string;
  configPath?: string;
  homeDir?: string;
}

export function resolveOpenClawConfigPath(
  configPath?: string,
  homeDir = homedir()
): string {
  const configDir =
    configPath === undefined
      ? path.join(homeDir, ".openclaw")
      : expandHomePath(configPath, homeDir);
  return path.join(configDir, "openclaw.json");
}

export function buildDirectOpenClawGatewayConfig(
  options: DirectOpenClawGatewayConfigOptions
): OpenClawGatewayConfig {
  const homeDir = options.homeDir ?? homedir();
  const configFile = resolveOpenClawConfigPath(options.configPath, homeDir);
  return {
    configFile,
    stateDir: path.dirname(configFile),
    gatewayUrl: options.url,
    port: readGatewayUrlPort(options.url),
    token: options.token
  };
}

export async function loadOpenClawGatewayConfig(
  configFile: string
): Promise<OpenClawGatewayConfig> {
  const text = await readOpenClawConfigText(configFile);
  const parsed = parseOpenClawJson(text, configFile);
  return validateOpenClawGatewayConfig(parsed, configFile);
}

async function readOpenClawConfigText(configFile: string): Promise<string> {
  try {
    return await readFile(configFile, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read openclaw.json at ${configFile}: ${errorMessage(error)}`
    );
  }
}

function parseOpenClawJson(text: string, configFile: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse openclaw.json at ${configFile}: ${errorMessage(error)}`
    );
  }
}

function validateOpenClawGatewayConfig(
  value: unknown,
  configFile: string
): OpenClawGatewayConfig {
  if (!isRecord(value)) {
    throw new Error("openclaw.json must contain a JSON object");
  }

  const gateway = value.gateway;
  if (!isRecord(gateway)) {
    throw new Error("openclaw.json must include object field gateway");
  }

  const auth = gateway.auth;
  if (!isRecord(auth)) {
    throw new Error("openclaw.json must include object field gateway.auth");
  }

  const port = readOptionalPort(gateway.port, "gateway.port");
  const resolvedPort = port ?? DEFAULT_OPENCLAW_GATEWAY_PORT;

  return {
    configFile,
    stateDir: path.dirname(configFile),
    gatewayUrl: `ws://127.0.0.1:${resolvedPort}`,
    port: resolvedPort,
    token: readRequiredString(auth.token, "gateway.auth.token")
  };
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`openclaw.json must include string field ${fieldName}`);
  }
  return value;
}

function readOptionalPort(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error(
      `openclaw.json field ${fieldName} must be an integer TCP port`
    );
  }

  return value;
}

function readGatewayUrlPort(url: string): number {
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_OPENCLAW_GATEWAY_PORT;
  } catch {
    return DEFAULT_OPENCLAW_GATEWAY_PORT;
  }
}

function expandHomePath(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
