import type { Readable, Writable } from "node:stream";

import { OpenClawAcpBridge } from "./acp-bridge.js";
import { startAcpJsonRpcServer } from "./acp-server.js";
import type { OpenClawGatewayConfig } from "./config.js";
import type { GatewayProtocolAdapter } from "./protocols/types.js";

export interface RunOpenClawAcpBridgeOptions {
  gatewayConfig: OpenClawGatewayConfig;
  protocolAdapter: GatewayProtocolAdapter;
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
  const gateway = options.protocolAdapter.createClient({
    url: options.gatewayConfig.gatewayUrl,
    token: options.gatewayConfig.token,
    stateDir: options.gatewayConfig.stateDir,
    clientVersion: "openclaw-acp"
  });

  await gateway.connect();

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
