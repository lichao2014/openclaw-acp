import { GatewayRpcClient } from "../core/client.js";
import type {
  GatewayClientCreateOptions,
  GatewayProtocolAdapter,
  GatewayProtocolProfile,
  GatewayProtocolSession
} from "../types.js";

const V4_PROTOCOL = 4;
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const OPERATOR_ROLE = "operator";
const DEFAULT_OPERATOR_SCOPES = ["operator.admin"];

export function createV4GatewayProtocolAdapter(): GatewayProtocolAdapter<"v4"> {
  return {
    version: "v4",
    createClient(options) {
      return new GatewayRpcClient(options, v4GatewayProtocolProfile);
    }
  };
}

const v4GatewayProtocolProfile: GatewayProtocolProfile<"v4"> = {
  version: "v4",
  protocolNumber: V4_PROTOCOL,
  createSession(options) {
    return new V4GatewayProtocolSession(options);
  }
};

class V4GatewayProtocolSession implements GatewayProtocolSession {
  private readonly options: GatewayClientCreateOptions;

  constructor(options: GatewayClientCreateOptions) {
    this.options = options;
  }

  buildConnectParams(): Record<string, unknown> {
    const platform = process.platform;

    return {
      minProtocol: V4_PROTOCOL,
      maxProtocol: V4_PROTOCOL,
      client: {
        id: CLIENT_ID,
        displayName: "ACP",
        version: this.options.clientVersion ?? "openclaw-acp",
        platform,
        mode: CLIENT_MODE
      },
      caps: ["tool-events"],
      auth: {
        token: this.options.token
      },
      role: OPERATOR_ROLE,
      scopes: DEFAULT_OPERATOR_SCOPES,
      pathEnv: process.env.PATH,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      userAgent: "openclaw-acp"
    };
  }
}
