import {
  buildDirectOpenClawGatewayConfig,
  loadOpenClawGatewayConfig,
  resolveOpenClawConfigPath
} from "./config.js";
import {
  createGatewayProtocolAdapter,
  isGatewayProtocolVersion,
  type GatewayProtocolAdapter,
  type GatewayProtocolVersion
} from "./protocols/index.js";
import { runOpenClawAcpBridge } from "./run.js";

export type GatewayProtocolSelection = GatewayProtocolVersion | "auto";

export interface CliArgs {
  configPath?: string;
  gatewayProtocol: GatewayProtocolSelection;
  url?: string;
  token?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    gatewayProtocol: "auto"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config_path" || arg === "--config-path") {
      parsed.configPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--config_path=") || arg.startsWith("--config-path=")) {
      parsed.configPath = readInlineOptionValue(
        arg,
        arg.startsWith("--config_path=") ? "--config_path" : "--config-path"
      );
      continue;
    }

    if (arg === "--url") {
      parsed.url = readOptionValue(argv, index, "--url");
      index += 1;
      continue;
    }

    if (arg.startsWith("--url=")) {
      parsed.url = readInlineOptionValue(arg, "--url");
      continue;
    }

    if (arg === "--token") {
      parsed.token = readOptionValue(argv, index, "--token");
      index += 1;
      continue;
    }

    if (arg.startsWith("--token=")) {
      parsed.token = readInlineOptionValue(arg, "--token");
      continue;
    }

    if (arg === "--gateway_protocol" || arg === "--gateway-protocol") {
      parsed.gatewayProtocol = parseGatewayProtocol(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--gateway_protocol=") || arg.startsWith("--gateway-protocol=")) {
      parsed.gatewayProtocol = parseGatewayProtocol(
        readInlineOptionValue(
          arg,
          arg.startsWith("--gateway_protocol=") ? "--gateway_protocol" : "--gateway-protocol"
        )
      );
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (Boolean(parsed.url) !== Boolean(parsed.token)) {
    throw new Error("--url and --token must be provided together");
  }

  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  const gatewayConfig = args.url && args.token
    ? buildDirectOpenClawGatewayConfig({
        url: args.url,
        token: args.token,
        configPath: args.configPath
      })
    : await loadOpenClawGatewayConfig(resolveOpenClawConfigPath(args.configPath));
  return await runOpenClawAcpBridge({
    gatewayConfig,
    protocolAdapters: resolveGatewayProtocolAdapters(args.gatewayProtocol)
  });
}

export function resolveGatewayProtocolAdapters(
  selection: GatewayProtocolSelection
): GatewayProtocolAdapter[] {
  if (selection === "auto") {
    return [
      createGatewayProtocolAdapter("v4"),
      createGatewayProtocolAdapter("v3")
    ];
  }
  return [createGatewayProtocolAdapter(selection)];
}

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `openclaw-acp: ${message}`;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function readInlineOptionValue(arg: string, optionName: string): string {
  const value = arg.slice(`${optionName}=`.length);
  if (value === "") {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function parseGatewayProtocol(value: string): GatewayProtocolSelection {
  if (value === "auto") {
    return value;
  }
  if (isGatewayProtocolVersion(value)) {
    return value;
  }
  throw new Error(`Unsupported gateway protocol: ${value}`);
}
