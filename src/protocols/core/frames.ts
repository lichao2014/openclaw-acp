import type { GatewayEventFrame } from "../types.js";

export interface GatewayResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export async function normalizeWebSocketMessage(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  if (data instanceof Blob) {
    return await data.text();
  }

  return String(data);
}

export function isGatewayEventFrame(value: unknown): value is GatewayEventFrame {
  return isRecord(value) && value.type === "event" && typeof value.event === "string";
}

export function isGatewayResponseFrame(value: unknown): value is GatewayResponseFrame {
  return (
    isRecord(value) &&
    value.type === "res" &&
    typeof value.id === "string" &&
    typeof value.ok === "boolean"
  );
}

export function readNonce(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.nonce !== "string") {
    return null;
  }

  const nonce = payload.nonce.trim();
  return nonce === "" ? null : nonce;
}

export function readStatus(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.status !== "string") {
    return undefined;
  }
  return payload.status;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
