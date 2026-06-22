import type { Readable, Writable } from "node:stream";

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  OpenClawAcpBridge
} from "./acp-bridge.js";

export interface AcpJsonRpcServerOptions {
  input: Readable;
  output: Writable;
  stderr: Writable;
  bridge: OpenClawAcpBridge;
}

export interface AcpJsonRpcServer {
  closed: Promise<void>;
}

export function startAcpJsonRpcServer(
  options: AcpJsonRpcServerOptions
): AcpJsonRpcServer {
  let buffered = "";
  let chain = Promise.resolve();
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  options.input.on("data", (chunk: Buffer | string) => {
    buffered += Buffer.from(chunk).toString("utf8");
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      chain = chain.then(() => processLine(line, options));
      newlineIndex = buffered.indexOf("\n");
    }
  });

  options.input.on("end", () => {
    const tail = buffered;
    buffered = "";
    if (tail.trim() !== "") {
      chain = chain.then(() => processLine(tail, options));
    }
    chain.then(resolveClosed, rejectClosed);
  });

  options.input.on("error", (error: Error) => {
    rejectClosed(error);
  });

  return { closed };
}

async function processLine(
  line: string,
  options: AcpJsonRpcServerOptions
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    options.stderr.write(`Ignoring non-JSON ACP input line: ${trimmed}\n`);
    return;
  }

  if (!isJsonRpcRequest(parsed)) {
    options.stderr.write("Ignoring non-request ACP input line\n");
    return;
  }

  const response = await options.bridge.handleJsonRpcRequest(parsed);
  writeJsonRpcResponse(options.output, response);
}

function writeJsonRpcResponse(output: Writable, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}
