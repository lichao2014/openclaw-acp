import type { Readable, Writable } from "node:stream";

import { OpenClawAcpBridge } from "./acp-bridge.js";
import { startAcpJsonRpcServer } from "./acp-server.js";
import type { OpenClawGatewayConfig } from "./config.js";
import type {
  GatewayClient,
  GatewayProtocolAdapter,
  GatewayTransportFactory
} from "./protocols/types.js";

export interface RunOpenClawAcpBridgeOptions {
  gatewayConfig: OpenClawGatewayConfig;
  protocolAdapter?: GatewayProtocolAdapter;
  protocolAdapters?: GatewayProtocolAdapter[];
  transportFactory?: GatewayTransportFactory;
  input?: Readable;
  output?: Writable;
  stderr?: Writable;
}

export async function runOpenClawAcpBridge(
  options: RunOpenClawAcpBridgeOptions
): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const gateway = await connectOpenClawGateway(options);

  const bridge = new OpenClawAcpBridge({
    gateway,
    send: (message) => {
      output.write(`${JSON.stringify(message)}\n`);
    },
    cwdProvider: () => process.cwd()
  });

  const server = startAcpJsonRpcServer({
    input,
    output,
    stderr,
    bridge
  });

  try {
    await server.closed;
  } finally {
    gateway.close();
  }

  return 0;
}

export async function connectOpenClawGateway(
  options: Pick<
    RunOpenClawAcpBridgeOptions,
    "gatewayConfig" | "protocolAdapter" | "protocolAdapters" | "transportFactory"
  >
): Promise<GatewayClient> {
  const adapters = resolveProtocolAdapters(options);
  let lastError: unknown;

  for (let index = 0; index < adapters.length; index += 1) {
    const gateway = adapters[index].createClient({
      url: options.gatewayConfig.gatewayUrl,
      token: options.gatewayConfig.token,
      stateDir: options.gatewayConfig.stateDir,
      clientVersion: "openclaw-acp",
      transportFactory: options.transportFactory
    });

    try {
      await gateway.connect();
      return gateway;
    } catch (error) {
      gateway.close();
      lastError = error;
      if (index >= adapters.length - 1 || !isProtocolMismatchError(error)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No gateway protocol adapter configured");
}

function resolveProtocolAdapters(
  options: Pick<RunOpenClawAcpBridgeOptions, "protocolAdapter" | "protocolAdapters">
): GatewayProtocolAdapter[] {
  if (options.protocolAdapters && options.protocolAdapters.length > 0) {
    return options.protocolAdapters;
  }
  if (options.protocolAdapter) {
    return [options.protocolAdapter];
  }
  throw new Error("No gateway protocol adapter configured");
}

function isProtocolMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /protocol mismatch/i.test(message);
}
