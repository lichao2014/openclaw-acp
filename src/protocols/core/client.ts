import { randomUUID } from "node:crypto";

import type {
  GatewayClient,
  GatewayClientCreateOptions,
  GatewayEventFrame,
  GatewayEventListener,
  GatewayProtocolProfile,
  GatewayProtocolSession,
  GatewayRequestOptions,
  GatewayTransport,
  GatewayTransportFactory
} from "../types.js";
import {
  isGatewayEventFrame,
  isGatewayResponseFrame,
  readNonce,
  readStatus,
  type GatewayResponseFrame
} from "./frames.js";
import { GlobalWebSocketTransport } from "./transport.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  timeout: NodeJS.Timeout | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export class GatewayRpcClient implements GatewayClient {
  private readonly options: GatewayClientCreateOptions;
  private readonly protocol: GatewayProtocolSession;
  private readonly eventListeners: GatewayEventListener[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private transport: GatewayTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private isOpen = false;
  private isReady = false;
  private connectSent = false;

  constructor(options: GatewayClientCreateOptions, profile: GatewayProtocolProfile) {
    this.options = options;
    this.protocol = profile.createSession(options);
  }

  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.transport = this.createTransport();
    this.transport.onOpen(() => {
      this.isOpen = true;
    });
    this.transport.onMessage((message) => {
      this.handleMessage(message);
    });
    this.transport.onClose((code, reason) => {
      this.isOpen = false;
      this.isReady = false;
      const error = new Error(`gateway closed (${code}): ${reason}`);
      this.flushPending(error);
      if (!this.isReady) {
        this.rejectReady?.(error);
      }
    });
    this.transport.onError((error) => {
      if (!this.isReady) {
        this.rejectReady?.(error);
      }
    });

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    return this.connectPromise;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: GatewayRequestOptions = {}
  ): Promise<T> {
    if (!this.isReady) {
      throw new Error("gateway not connected");
    }

    return await this.sendRequest<T>(method, params, options);
  }

  onEvent(listener: GatewayEventListener): void {
    this.eventListeners.push(listener);
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
    this.isOpen = false;
    this.isReady = false;
    this.flushPending(new Error("gateway client stopped"));
  }

  private createTransport(): GatewayTransport {
    const factory: GatewayTransportFactory =
      this.options.transportFactory ?? ((url) => new GlobalWebSocketTransport(url));
    return factory(this.options.url);
  }

  private handleMessage(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (isGatewayEventFrame(parsed)) {
      if (parsed.event === "connect.challenge") {
        this.sendConnect(parsed);
        return;
      }

      for (const listener of this.eventListeners) {
        void listener(parsed);
      }
      return;
    }

    if (isGatewayResponseFrame(parsed)) {
      this.handleResponse(parsed);
    }
  }

  private sendConnect(event: GatewayEventFrame): void {
    if (this.connectSent) {
      return;
    }

    const nonce = readNonce(event.payload);
    if (!nonce) {
      this.rejectReady?.(new Error("gateway connect challenge missing nonce"));
      return;
    }

    this.connectSent = true;
    void this.sendRequest(
      "connect",
      this.protocol.buildConnectParams({
        nonce,
        options: this.options
      }),
      {
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
      }
    )
      .then((helloOk) => {
        this.protocol.onHelloOk?.({
          helloOk,
          options: this.options
        });
        this.isReady = true;
        this.resolveReady?.();
      })
      .catch((error) => {
        this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private async sendRequest<T>(
    method: string,
    params: unknown,
    options: GatewayRequestOptions
  ): Promise<T> {
    if (!this.transport || !this.isOpen) {
      throw new Error("gateway not connected");
    }

    const id = randomUUID();
    const frame = {
      type: "req",
      id,
      method,
      params
    };

    const response = new Promise<T>((resolve, reject) => {
      const timeoutMs = resolveTimeoutMs(options);
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout for ${method}`));
            }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: options.expectFinal === true,
        timeout
      });
    });

    this.transport.send(JSON.stringify(frame));
    return await response;
  }

  private handleResponse(response: GatewayResponseFrame): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    const status = readStatus(response.payload);
    if (pending.expectFinal && status === "accepted") {
      return;
    }

    this.pending.delete(response.id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if (response.ok) {
      pending.resolve(response.payload);
      return;
    }

    pending.reject(
      new Error(response.error?.message ?? response.error?.code ?? "gateway request failed")
    );
  }

  private flushPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resolveTimeoutMs(options: GatewayRequestOptions): number | null {
  if (options.timeoutMs === null) {
    return null;
  }

  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)) {
    return Math.max(1, Math.min(Math.floor(options.timeoutMs), 2147483647));
  }

  if (options.expectFinal === true) {
    return null;
  }

  return DEFAULT_REQUEST_TIMEOUT_MS;
}
