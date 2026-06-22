import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEVICE_IDENTITY_FILE = "device.json";
const DEVICE_AUTH_FILE = "device-auth.json";

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface SignedDeviceParams {
  identity: DeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform?: string;
  deviceFamily?: string;
}

export interface SignedDevice {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

export function loadOrCreateDeviceIdentity(stateDir: string): DeviceIdentity {
  const filePath = deviceIdentityPath(stateDir);
  const existing = readDeviceIdentity(filePath);
  if (existing) {
    return existing;
  }

  const identity = generateDeviceIdentity();
  ensureParentDir(filePath);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem,
        createdAtMs: Date.now()
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  chmodOwnerOnly(filePath);
  return identity;
}

export function buildSignedDevice(params: SignedDeviceParams): SignedDevice {
  const payload = buildDeviceAuthPayloadV3(params);
  return {
    id: params.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem),
    signature: signDevicePayload(params.identity.privateKeyPem, payload),
    signedAt: params.signedAtMs,
    nonce: params.nonce
  };
}

export function storeDeviceAuthToken(params: {
  stateDir: string;
  deviceId: string;
  role: string;
  token: string;
  scopes: string[];
}): void {
  const filePath = deviceAuthPath(params.stateDir);
  const existing = readDeviceAuthStore(filePath);
  const next = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing?.deviceId === params.deviceId && isRecord(existing.tokens)
        ? { ...existing.tokens }
        : {}
  };

  next.tokens[normalizeDeviceAuthRole(params.role)] = {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now()
  };

  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600
  });
  chmodOwnerOnly(filePath);
}

export function loadDeviceAuthToken(params: {
  stateDir: string;
  deviceId: string;
  role: string;
}): { token: string; role: string; scopes: string[] } | null {
  const store = readDeviceAuthStore(deviceAuthPath(params.stateDir));
  if (!store || store.deviceId !== params.deviceId || !isRecord(store.tokens)) {
    return null;
  }

  const role = normalizeDeviceAuthRole(params.role);
  const entry = store.tokens[role];
  if (!isRecord(entry) || typeof entry.token !== "string" || entry.token.trim() === "") {
    return null;
  }

  return {
    token: entry.token,
    role: typeof entry.role === "string" ? normalizeDeviceAuthRole(entry.role) : role,
    scopes: normalizeDeviceAuthScopes(Array.isArray(entry.scopes) ? entry.scopes : [])
  };
}

function readDeviceIdentity(filePath: string): DeviceIdentity | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.publicKeyPem !== "string" ||
      typeof parsed.privateKeyPem !== "string"
    ) {
      return null;
    }

    const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
    if (derivedId !== parsed.deviceId) {
      return null;
    }

    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem
    };
  } catch {
    return null;
  }
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({
    type: "spki",
    format: "pem"
  }) as string;
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem"
  }) as string;

  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem
  };
}

function buildDeviceAuthPayloadV3(params: SignedDeviceParams): string {
  return [
    "v3",
    params.identity.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily)
  ].join("|");
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto
    .createHash("sha256")
    .update(derivePublicKeyRaw(publicKeyPem))
    .digest("hex");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der"
  });
  if (
    Buffer.isBuffer(spki) &&
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return Buffer.from(spki);
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  return base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem))
  );
}

function readDeviceAuthStore(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isRecord(parsed) && parsed.version === 1 && typeof parsed.deviceId === "string") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeDeviceAuthRole(role: string): string {
  return role.trim() || "operator";
}

function normalizeDeviceAuthScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => typeof scope === "string" && scope.trim() !== "");
}

function normalizeDeviceMetadataForAuth(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function deviceIdentityPath(stateDir: string): string {
  return path.join(stateDir, "identity", DEVICE_IDENTITY_FILE);
}

function deviceAuthPath(stateDir: string): string {
  return path.join(stateDir, "identity", DEVICE_AUTH_FILE);
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function chmodOwnerOnly(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore POSIX file modes.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
