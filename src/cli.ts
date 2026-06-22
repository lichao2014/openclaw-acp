import {
  buildDirectOpenClawGatewayConfig,
  loadOpenClawGatewayConfig,
  resolveOpenClawConfigPath
} from "./config.js";
import {
  createGatewayProtocolAdapter,
  isGatewayProtocolVersion,
  type GatewayProtocolVersion
} from "./protocols/index.js";
import { runOpenClawAcpBridge } from "./run.js";

export interface CliArgs {
  configPath?: string;
  gatewayProtocol: GatewayProtocolVersion;
  url?: string;
  token?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    gatewayProtocol: "v3"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config_path") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --config_path");
      }
      parsed.configPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config_path=")) {
      const value = arg.slice("--config_path=".length);
      if (value === "") {
        throw new Error("Missing value for --config_path");
      }
      parsed.configPath = value;
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

    if (arg === "--gateway_protocol") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("Missing value for --gateway_protocol");
      }
      parsed.gatewayProtocol = parseGatewayProtocol(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--gateway_protocol=")) {
      const value = arg.slice("--gateway_protocol=".length);
      if (value === "") {
        throw new Error("Missing value for --gateway_protocol");
      }
      parsed.gatewayProtocol = parseGatewayProtocol(value);
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
  const protocolAdapter = createGatewayProtocolAdapter(args.gatewayProtocol);
  return await runOpenClawAcpBridge({
    gatewayConfig,
    protocolAdapter
  });
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

function parseGatewayProtocol(value: string): GatewayProtocolVersion {
  if (isGatewayProtocolVersion(value)) {
    return value;
  }
  throw new Error(`Unsupported gateway protocol: ${value}`);
}
