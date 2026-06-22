export interface GatewayEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
}

export interface GatewayRequestOptions {
  expectFinal?: boolean;
  timeoutMs?: number | null;
}

export type GatewayEventListener = (
  event: GatewayEventFrame
) => void | Promise<void>;

export interface GatewayClient {
  connect(): Promise<void>;
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions
  ): Promise<T>;
  onEvent(listener: GatewayEventListener): void;
  close(): void;
}

export interface GatewayTransport {
  onOpen(listener: () => void): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  send(message: string): void;
  close(): void;
}

export type GatewayTransportFactory = (url: string) => GatewayTransport;

export interface GatewayClientCreateOptions {
  url: string;
  token: string;
  clientVersion?: string;
  stateDir?: string;
  transportFactory?: GatewayTransportFactory;
}

export interface GatewayConnectContext {
  nonce: string;
  options: GatewayClientCreateOptions;
}

export interface GatewayHelloOkContext {
  helloOk: unknown;
  options: GatewayClientCreateOptions;
}

export interface GatewayProtocolSession {
  buildConnectParams(context: GatewayConnectContext): Record<string, unknown>;
  onHelloOk?(context: GatewayHelloOkContext): void;
}

export interface GatewayProtocolProfile<TVersion extends string = string> {
  readonly version: TVersion;
  readonly protocolNumber: number;
  createSession(options: GatewayClientCreateOptions): GatewayProtocolSession;
}

export interface GatewayProtocolAdapter<TVersion extends string = string> {
  readonly version: TVersion;
  createClient(options: GatewayClientCreateOptions): GatewayClient;
}
