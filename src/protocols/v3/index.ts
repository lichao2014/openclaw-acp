import { GatewayRpcClient } from "../core/client.js";
import { isRecord, readStringArray } from "../core/frames.js";
import type {
  GatewayClientCreateOptions,
  GatewayConnectContext,
  GatewayHelloOkContext,
  GatewayProtocolAdapter,
  GatewayProtocolProfile,
  GatewayProtocolSession
} from "../types.js";
import {
  buildSignedDevice,
  loadDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  storeDeviceAuthToken,
  type DeviceIdentity,
  type SignedDevice
} from "./device-auth.js";

const V3_PROTOCOL = 3;
const CLIENT_ID = "cli";
const CLIENT_MODE = "cli";
const OPERATOR_ROLE = "operator";
const DEFAULT_OPERATOR_SCOPES = ["operator.admin"];

export function createV3GatewayProtocolAdapter(): GatewayProtocolAdapter<"v3"> {
  return {
    version: "v3",
    createClient(options) {
      return new GatewayRpcClient(options, v3GatewayProtocolProfile);
    }
  };
}

const v3GatewayProtocolProfile: GatewayProtocolProfile<"v3"> = {
  version: "v3",
  protocolNumber: V3_PROTOCOL,
  createSession(options) {
    return new V3GatewayProtocolSession(options);
  }
};

class V3GatewayProtocolSession implements GatewayProtocolSession {
  private readonly options: GatewayClientCreateOptions;
  private deviceIdentity: DeviceIdentity | null = null;

  constructor(options: GatewayClientCreateOptions) {
    this.options = options;
  }

  buildConnectParams(context: GatewayConnectContext): Record<string, unknown> {
    const platform = process.platform;
    const scopes = DEFAULT_OPERATOR_SCOPES;
    const storedDeviceAuth = this.loadStoredDeviceAuth(OPERATOR_ROLE);
    const device = this.buildConnectDevice({
      nonce: context.nonce,
      platform,
      scopes
    });

    return {
      minProtocol: V3_PROTOCOL,
      maxProtocol: V3_PROTOCOL,
      client: {
        id: CLIENT_ID,
        displayName: "ACP",
        version: this.options.clientVersion ?? "openclaw-acp",
        platform,
        mode: CLIENT_MODE
      },
      caps: ["tool-events"],
      auth: {
        token: this.options.token,
        ...(storedDeviceAuth ? { deviceToken: storedDeviceAuth.token } : {})
      },
      role: OPERATOR_ROLE,
      scopes,
      device,
      pathEnv: process.env.PATH,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      userAgent: "openclaw-acp"
    };
  }

  onHelloOk(context: GatewayHelloOkContext): void {
    this.storeDeviceTokenFromHelloOk(context.helloOk);
  }

  private loadStoredDeviceAuth(role: string): { token: string; scopes: string[] } | null {
    if (!this.options.stateDir) {
      return null;
    }
    const identity = this.ensureDeviceIdentity();
    if (!identity) {
      return null;
    }
    return loadDeviceAuthToken({
      stateDir: this.options.stateDir,
      deviceId: identity.deviceId,
      role
    });
  }

  private buildConnectDevice(params: {
    nonce: string;
    platform: string;
    scopes: string[];
  }): SignedDevice | undefined {
    const identity = this.ensureDeviceIdentity();
    if (!identity) {
      return undefined;
    }

    return buildSignedDevice({
      identity,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: OPERATOR_ROLE,
      scopes: params.scopes,
      signedAtMs: Date.now(),
      token: this.options.token,
      nonce: params.nonce,
      platform: params.platform
    });
  }

  private ensureDeviceIdentity(): DeviceIdentity | null {
    if (this.deviceIdentity) {
      return this.deviceIdentity;
    }

    if (!this.options.stateDir) {
      return null;
    }

    this.deviceIdentity = loadOrCreateDeviceIdentity(this.options.stateDir);
    return this.deviceIdentity;
  }

  private storeDeviceTokenFromHelloOk(helloOk: unknown): void {
    if (!this.options.stateDir || !this.deviceIdentity || !isRecord(helloOk)) {
      return;
    }

    const auth = helloOk.auth;
    if (!isRecord(auth) || typeof auth.deviceToken !== "string") {
      return;
    }

    storeDeviceAuthToken({
      stateDir: this.options.stateDir,
      deviceId: this.deviceIdentity.deviceId,
      role: typeof auth.role === "string" ? auth.role : OPERATOR_ROLE,
      token: auth.deviceToken,
      scopes: readStringArray(auth.scopes)
    });
  }
}
