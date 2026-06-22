import type { GatewayTransport } from "../types.js";
import { normalizeWebSocketMessage } from "./frames.js";

export class GlobalWebSocketTransport implements GatewayTransport {
  private readonly socket: WebSocket;

  constructor(url: string) {
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error("This Node.js runtime does not provide global WebSocket");
    }
    this.socket = new globalThis.WebSocket(url);
  }

  onOpen(listener: () => void): void {
    this.socket.addEventListener("open", () => listener());
  }

  onMessage(listener: (message: string) => void): void {
    this.socket.addEventListener("message", (event) => {
      void normalizeWebSocketMessage(event.data)
        .then((message) => listener(message))
        .catch(() => undefined);
    });
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.socket.addEventListener("close", (event) => {
      listener(event.code, event.reason);
    });
  }

  onError(listener: (error: Error) => void): void {
    this.socket.addEventListener("error", () => {
      listener(new Error("gateway websocket error"));
    });
  }

  send(message: string): void {
    this.socket.send(message);
  }

  close(): void {
    this.socket.close();
  }
}
