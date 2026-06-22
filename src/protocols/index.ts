import { createV3GatewayProtocolAdapter } from "./v3/index.js";
import { createV4GatewayProtocolAdapter } from "./v4/index.js";
import type { GatewayProtocolAdapter } from "./types.js";

const protocolAdapters = {
  v3: createV3GatewayProtocolAdapter(),
  v4: createV4GatewayProtocolAdapter()
} as const;

export type GatewayProtocolVersion = keyof typeof protocolAdapters;

export const SUPPORTED_GATEWAY_PROTOCOLS = Object.keys(
  protocolAdapters
) as GatewayProtocolVersion[];

export function isGatewayProtocolVersion(value: string): value is GatewayProtocolVersion {
  return Object.hasOwn(protocolAdapters, value);
}

export function createGatewayProtocolAdapter(
  version: GatewayProtocolVersion
): GatewayProtocolAdapter {
  const adapter = protocolAdapters[version];
  if (!adapter) {
    throw new Error(`Unsupported gateway protocol: ${version}`);
  }
  return adapter;
}

export type {
  GatewayClient,
  GatewayClientCreateOptions,
  GatewayEventFrame,
  GatewayProtocolAdapter,
  GatewayRequestOptions,
  GatewayTransport,
  GatewayTransportFactory
} from "./types.js";
