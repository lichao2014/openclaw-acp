import { randomUUID } from "node:crypto";

import type { GatewayClient, GatewayEventFrame } from "./protocols/types.js";

type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | undefined;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface OpenClawAcpBridgeOptions {
  gateway: GatewayClient;
  send: (message: JsonRpcNotification) => void;
  cwdProvider: () => string;
}

interface SessionState {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  activeRunId?: string;
  presentation?: SessionPresentationState;
}

interface PendingPrompt {
  sessionId: string;
  sessionKey: string;
  runId: string;
  sentTextLength: number;
  sentThoughtLength: number;
  toolCalls: Map<string, { title: string; rawInput?: unknown }>;
  resolve: (result: { stopReason: string }) => void;
  reject: (error: Error) => void;
}

type AcpUsageSnapshot = {
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  };
};

interface LiveSessionUsageSnapshot {
  usage: AcpUsageSnapshot;
  source: "gateway-session-message" | "gateway-sessions-changed";
  updatedAt: number;
}

interface SessionSnapshot {
  configOptions: Record<string, unknown>[];
  modes: Record<string, unknown>;
  models?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  usage?: AcpUsageSnapshot;
}

interface SessionPresentationState {
  currentMode?: string;
  configOptions?: string;
  metadata?: string;
}

const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const ACP_FAST_MODE_CONFIG_ID = "fast_mode";
const ACP_VERBOSE_LEVEL_CONFIG_ID = "verbose_level";
const ACP_TRACE_LEVEL_CONFIG_ID = "trace_level";
const ACP_REASONING_LEVEL_CONFIG_ID = "reasoning_level";
const ACP_RESPONSE_USAGE_CONFIG_ID = "response_usage";
const ACP_ELEVATED_LEVEL_CONFIG_ID = "elevated_level";
const ACP_LOAD_SESSION_REPLAY_LIMIT = 1000000;
const ACP_USAGE_EVENT_WAIT_MS = 500;

const ACP_RUNTIME_CONTROLS = [
  "session/set_mode",
  "session/set_config_option",
  "session/status"
] as const;

const ACP_CONFIG_OPTION_IDS = [
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  ACP_FAST_MODE_CONFIG_ID,
  ACP_VERBOSE_LEVEL_CONFIG_ID,
  ACP_TRACE_LEVEL_CONFIG_ID,
  ACP_REASONING_LEVEL_CONFIG_ID,
  ACP_RESPONSE_USAGE_CONFIG_ID,
  ACP_ELEVATED_LEVEL_CONFIG_ID
] as const;

const DEFAULT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "adaptive"
];

const AVAILABLE_COMMANDS = [
  {
    name: "model",
    description: "Select a model (list|status|<name>)."
  },
  {
    name: "thinking",
    description: "Adjust thinking level."
  },
  {
    name: "reasoning",
    description: "Toggle reasoning output (on|off|stream)."
  },
  {
    name: "elevated",
    description: "Toggle elevated mode (on|off)."
  },
  {
    name: "compact",
    description: "Compact the session history."
  }
];

export class OpenClawAcpBridge {
  private readonly gateway: GatewayClient;
  private readonly send: (message: JsonRpcNotification) => void;
  private readonly cwdProvider: () => string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private readonly liveUsageSnapshots = new Map<string, LiveSessionUsageSnapshot>();
  private readonly liveUsageWaiters = new Map<string, Set<(snapshot: LiveSessionUsageSnapshot) => void>>();
  private sessionChangesSubscribePromise?: Promise<void>;
  private sessionChangesSubscribed = false;

  constructor(options: OpenClawAcpBridgeOptions) {
    this.gateway = options.gateway;
    this.send = options.send;
    this.cwdProvider = options.cwdProvider;
    this.gateway.onEvent((event) => {
      void this.handleGatewayEvent(event);
    });
  }

  async handleJsonRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const result = await this.dispatch(request.method, request.params);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize();
      case "session/new":
        return await this.newSession(params);
      case "session/load":
        return await this.loadSession(params);
      case "session/list":
        return await this.listSessions();
      case "session/prompt":
        return await this.prompt(params);
      case "session/cancel":
        return await this.cancel(params);
      case "session/set_mode":
        return await this.setSessionMode(params);
      case "session/set_config_option":
        return await this.setSessionConfigOption(params);
      case "session/status":
        return await this.sessionStatus(params);
      case "session/set_model":
        return await this.setSessionModel(params);
      default:
        throw new Error(`Unsupported ACP method: ${method}`);
    }
  }

  private initialize(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        },
        mcpCapabilities: {
          http: false,
          sse: false
        },
        sessionCapabilities: {
          list: {}
        }
      },
      agentInfo: {
        name: "openclaw-acp",
        title: "OpenClaw ACP Gateway",
        version: "0.1.2"
      },
      authMethods: [],
      _meta: {
        controls: [...ACP_RUNTIME_CONTROLS],
        configOptionKeys: [...ACP_CONFIG_OPTION_IDS]
      }
    };
  }

  private async newSession(params: unknown): Promise<Record<string, unknown>> {
    const sessionId = randomUUID();
    const cwd = readString(params, "cwd") ?? this.cwdProvider();
    const sessionKey = await this.resolveSessionKey(`acp:${sessionId}`);
    await this.ensureSessionChangesSubscribed();
    this.sessions.set(sessionId, {
      sessionId,
      sessionKey,
      cwd
    });

    const sessionSnapshot = await this.getSessionSnapshot(sessionKey);
    this.sendSessionSnapshotUpdate(sessionId, sessionSnapshot, {
      includeControls: false
    });
    this.sendAvailableCommands(sessionId);

    return {
      sessionId,
      ...buildSessionSetupResponse(sessionSnapshot)
    };
  }

  private async loadSession(params: unknown): Promise<Record<string, unknown>> {
    const sessionId = readRequiredString(params, "sessionId");
    const cwd = readString(params, "cwd") ?? this.cwdProvider();
    const sessionKey = await this.resolveSessionKey(sessionId);
    await this.ensureSessionChangesSubscribed();
    this.sessions.set(sessionId, {
      sessionId,
      sessionKey,
      cwd
    });

    const [sessionSnapshot, transcript] = await Promise.all([
      this.getSessionSnapshot(sessionKey),
      this.getSessionTranscript(sessionKey).catch(() => [])
    ]);
    this.replaySessionTranscript(sessionId, transcript);
    this.sendSessionSnapshotUpdate(sessionId, sessionSnapshot, {
      includeControls: false
    });
    this.sendAvailableCommands(sessionId);

    return buildSessionSetupResponse(sessionSnapshot);
  }

  private async listSessions(): Promise<Record<string, unknown>> {
    const response = await this.gateway.request("sessions.list", {});
    const sessions = isRecord(response) && Array.isArray(response.sessions)
      ? response.sessions
      : [];

    return {
      sessions: sessions.map((session) => mapGatewaySession(session, this.cwdProvider())),
      nextCursor: null
    };
  }

  private async prompt(params: unknown): Promise<{ stopReason: string }> {
    const sessionId = readRequiredString(params, "sessionId");
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const prompt = isRecord(params) ? params.prompt : undefined;
    const text = extractPromptText(prompt);
    const runId = randomUUID();
    const message = `[Working directory: ${session.cwd}]\n\n${text}`;
    if (!this.sessionChangesSubscribed) {
      await this.ensureSessionChangesSubscribed();
    }
    const messageSubscriptionPromise = this.subscribeSessionMessages(session.sessionKey);
    const unsubscribeSessionMessages = () => {
      void messageSubscriptionPromise.then((subscribed) => {
        if (subscribed) {
          return this.unsubscribeSessionMessages(session.sessionKey);
        }
        return undefined;
      });
    };
    this.clearLiveSessionUsage(session.sessionKey);

    const pendingPromise = new Promise<{ stopReason: string }>((resolve, reject) => {
      this.pendingPrompts.set(sessionId, {
        sessionId,
        sessionKey: session.sessionKey,
        runId,
        sentTextLength: 0,
        sentThoughtLength: 0,
        toolCalls: new Map(),
        resolve,
        reject
      });
    });

    session.activeRunId = runId;

    try {
      await this.enableFullToolVerbosity(session);
      await this.gateway.request(
        "chat.send",
        {
          sessionKey: session.sessionKey,
          message,
          idempotencyKey: runId
        },
        {
          timeoutMs: null
        }
      );
    } catch (error) {
      unsubscribeSessionMessages();
      this.pendingPrompts.delete(sessionId);
      session.activeRunId = undefined;
      throw error;
    }

    try {
      return await pendingPromise;
    } finally {
      unsubscribeSessionMessages();
    }
  }

  private async enableFullToolVerbosity(session: SessionState): Promise<void> {
    await this.gateway.request("sessions.patch", {
      key: session.sessionKey,
      verboseLevel: "full"
    });
  }

  private async cancel(params: unknown): Promise<Record<string, never>> {
    const sessionId = readRequiredString(params, "sessionId");
    const session = this.sessions.get(sessionId);
    if (!session?.activeRunId) {
      return {};
    }

    const runId = session.activeRunId;
    session.activeRunId = undefined;
    await this.gateway.request("chat.abort", {
      sessionKey: session.sessionKey,
      runId
    });

    const pending = this.pendingPrompts.get(sessionId);
    if (pending) {
      this.pendingPrompts.delete(sessionId);
      pending.resolve({ stopReason: "cancelled" });
    }

    return {};
  }

  private async sessionStatus(params: unknown): Promise<Record<string, unknown>> {
    const sessionId = readRequiredString(params, "sessionId");
    const session = this.readSession(sessionId);
    const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey);
    return buildRuntimeStatus(session, sessionSnapshot);
  }

  private async setSessionMode(params: unknown): Promise<Record<string, never>> {
    const sessionId = readRequiredString(params, "sessionId");
    const modeId = readRequiredString(params, "modeId");
    const session = this.readSession(sessionId);

    await this.gateway.request("sessions.patch", {
      key: session.sessionKey,
      thinkingLevel: modeId
    });

    const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, {
      thinkingLevel: modeId
    });
    this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: true
    });

    return {};
  }

  private async setSessionConfigOption(params: unknown): Promise<Record<string, unknown>> {
    const sessionId = readRequiredString(params, "sessionId");
    const configId = readRequiredString(params, "configId");
    const session = this.readSession(sessionId);
    const value = isRecord(params) ? params.value : undefined;
    const sessionPatch = resolveSessionConfigPatch(configId, value);

    await this.gateway.request("sessions.patch", {
      key: session.sessionKey,
      ...sessionPatch.patch
    });

    const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, sessionPatch.overrides);
    this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: true
    });

    return {
      configOptions: sessionSnapshot.configOptions
    };
  }

  private async setSessionModel(params: unknown): Promise<Record<string, never>> {
    const sessionId = readRequiredString(params, "sessionId");
    const modelId = readRequiredString(params, "modelId");
    const session = this.readSession(sessionId);

    const response = await this.gateway.request("sessions.patch", {
      key: session.sessionKey,
      model: modelId
    });

    const sessionSnapshot = await this.getSessionSnapshot(
      session.sessionKey,
      resolveModelOverride(response, modelId)
    );
    this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: true
    });

    return {};
  }

  private async resolveSessionKey(fallbackKey: string): Promise<string> {
    let response: unknown;
    try {
      response = await this.gateway.request("sessions.resolve", {
        key: fallbackKey
      });
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return fallbackKey;
      }
      throw error;
    }

    if (isRecord(response) && typeof response.key === "string" && response.key) {
      return response.key;
    }

    return fallbackKey;
  }

  private readSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private async getSessionSnapshot(
    sessionKey: string,
    overrides?: Record<string, unknown>
  ): Promise<SessionSnapshot> {
    const row = await this.getGatewaySessionRow(sessionKey).catch(() => undefined);
    const mergedRow = {
      ...(row ?? {}),
      ...(overrides ?? {})
    };
    const modelState = await this.getSessionModelState(mergedRow).catch(() => undefined);

    return {
      ...buildSessionPresentation(mergedRow),
      ...(modelState ? { models: modelState } : {}),
      metadata: buildSessionMetadata({
        row: mergedRow,
        sessionKey
      }),
      usage: buildSessionUsageSnapshot(mergedRow)
    };
  }

  private async getGatewaySessionRow(sessionKey: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.gateway.request("sessions.list", {
      limit: 200,
      search: sessionKey,
      includeDerivedTitles: true
    });
    const sessions = isRecord(response) && Array.isArray(response.sessions)
      ? response.sessions
      : [];

    return sessions.find((session): session is Record<string, unknown> => {
      if (!isRecord(session)) {
        return false;
      }
      const key = readOwnString(session, "key") ?? readOwnString(session, "sessionKey");
      return Boolean(key && sessionKeysMatch(sessionKey, key));
    });
  }

  private async getSessionModelState(row: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const response = await this.gateway.request("models.list", {});
    const models = isRecord(response) && Array.isArray(response.models)
      ? response.models
      : [];
    const availableModels = dedupeModels(models.map(mapGatewayModel).filter(isPresent));
    const currentModelId = resolveCurrentModelId(row) ?? availableModels[0]?.modelId;
    if (!currentModelId) {
      return undefined;
    }

    if (!availableModels.some((model) => model.modelId === currentModelId)) {
      availableModels.push({
        modelId: currentModelId,
        name: currentModelId
      });
    }

    return {
      availableModels,
      currentModelId
    };
  }

  private async getSessionTranscript(
    sessionKey: string,
    limit = ACP_LOAD_SESSION_REPLAY_LIMIT
  ): Promise<unknown[]> {
    const result = await this.gateway.request("sessions.get", {
      key: sessionKey,
      limit
    });
    return isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
  }

  private replaySessionTranscript(sessionId: string, transcript: unknown[]): void {
    for (const message of transcript) {
      for (const chunk of extractReplayChunks(message)) {
        this.sendSessionUpdate(sessionId, {
          sessionUpdate: chunk.sessionUpdate,
          content: {
            type: "text",
            text: chunk.text
          }
        });
      }
    }
  }

  private async handleGatewayEvent(event: GatewayEventFrame): Promise<void> {
    if (event.event === "chat") {
      await this.handleChatEvent(event.payload);
      return;
    }

    if (event.event === "agent") {
      await this.handleAgentEvent(event.payload);
      return;
    }

    if (event.event === "sessions.changed") {
      this.handleSessionsChangedEvent(event.payload);
      return;
    }

    if (event.event === "session.message") {
      this.handleSessionMessageEvent(event.payload);
    }
  }

  private async handleChatEvent(payload: unknown): Promise<void> {
    if (!isRecord(payload)) {
      return;
    }

    const sessionKey = readOwnString(payload, "sessionKey");
    const state = readOwnString(payload, "state");
    const runId = readOwnString(payload, "runId");
    if (!sessionKey || !state) {
      return;
    }

    const pending = this.findPendingPrompt(sessionKey, runId);
    if (!pending) {
      return;
    }

    if (payload.message && (state === "delta" || state === "final")) {
      this.emitMessageChunks(pending, payload.message);
    }

    if (state === "final") {
      const sentUsage = await this.sendChatUsageUpdate(pending, payload);
      if (!sentUsage) {
        await this.sendFinalChatSessionStoreUsageUpdate(pending);
      }
      this.finishPrompt(pending, payload.stopReason === "max_tokens" ? "max_tokens" : "end_turn");
      return;
    }

    if (state === "aborted") {
      this.finishPrompt(pending, "cancelled");
      return;
    }

    if (state === "error") {
      this.finishPrompt(pending, payload.errorKind === "refusal" ? "refusal" : "end_turn");
    }
  }

  private async handleAgentEvent(payload: unknown): Promise<void> {
    if (!isRecord(payload) || payload.stream !== "tool" || !isRecord(payload.data)) {
      return;
    }

    const sessionKey = readOwnString(payload, "sessionKey");
    const runId = readOwnString(payload, "runId");
    const pending = sessionKey ? this.findPendingPrompt(sessionKey, runId) : null;
    if (!pending) {
      return;
    }

    const toolCallId = readOwnString(payload.data, "toolCallId");
    const phase = readOwnString(payload.data, "phase");
    if (!toolCallId || !phase) {
      return;
    }

    if (phase === "start") {
      const name = readOwnString(payload.data, "name") ?? "tool";
      pending.toolCalls.set(toolCallId, {
        title: name,
        rawInput: payload.data.args
      });
      this.sendSessionUpdate(pending.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: name,
        status: "in_progress",
        rawInput: payload.data.args
      });
      return;
    }

    if (phase === "update") {
      this.sendSessionUpdate(pending.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        rawOutput: payload.data.partialResult
      });
      return;
    }

    if (phase === "result") {
      pending.toolCalls.delete(toolCallId);
      this.sendSessionUpdate(pending.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: payload.data.isError === true ? "failed" : "completed",
        rawOutput: payload.data.result
      });
    }
  }

  private emitMessageChunks(pending: PendingPrompt, message: unknown): void {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      return;
    }

    const thought = joinContentBlocks(message.content, "thinking", "thinking");
    if (thought.length > pending.sentThoughtLength) {
      const text = thought.slice(pending.sentThoughtLength);
      pending.sentThoughtLength = thought.length;
      this.sendSessionUpdate(pending.sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text
        }
      });
    }

    const assistantText = joinContentBlocks(message.content, "text", "text");
    if (assistantText.length <= pending.sentTextLength) {
      return;
    }

    const text = assistantText.slice(pending.sentTextLength);
    pending.sentTextLength = assistantText.length;
    this.sendSessionUpdate(pending.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text
      }
    });
  }

  private async sendChatUsageUpdate(
    pending: PendingPrompt,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    const usage = extractChatEventUsage(payload);
    if (!usage) {
      logUsageDebug("final chat event has no usage", {
        sessionKey: pending.sessionKey,
        runId: pending.runId
      });
      return false;
    }

    try {
      const size = await this.resolveChatUsageSize(pending.sessionKey, payload, usage);
      const usageUpdate = buildChatUsageUpdate(usage, size);
      if (!usageUpdate) {
        logUsageDebug("final chat event usage could not be mapped to ACP usage_update", {
          sessionKey: pending.sessionKey,
          runId: pending.runId,
          usageKeys: Object.keys(usage),
          size
        });
        return false;
      }

      this.sendSessionUpdate(pending.sessionId, {
        sessionUpdate: "usage_update",
        used: usageUpdate.used,
        size: usageUpdate.size,
        ...(usageUpdate.cost ? { cost: usageUpdate.cost } : {}),
        _meta: {
          source: "gateway-chat-event"
        }
      });
      logUsageDebug("sent usage_update from final chat event", {
        sessionKey: pending.sessionKey,
        runId: pending.runId,
        used: usageUpdate.used,
        size: usageUpdate.size
      });
      return true;
    } catch (error) {
      logUsageDebug("failed to map final chat usage", {
        sessionKey: pending.sessionKey,
        runId: pending.runId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async sendFinalChatSessionStoreUsageUpdate(pending: PendingPrompt): Promise<void> {
    try {
      const liveUsage = await this.waitForLiveSessionUsage(
        pending.sessionKey,
        ACP_USAGE_EVENT_WAIT_MS
      );
      let usage = liveUsage?.usage;
      let source = liveUsage?.source ?? "gateway-session-store";
      const row = usage ? undefined : await this.getGatewaySessionRow(pending.sessionKey);
      if (!usage) {
        usage = row ? buildSessionUsageSnapshot(row) : undefined;
      }

      if (!usage) {
        logUsageDebug("final chat session store has no fresh usage snapshot", {
          sessionKey: pending.sessionKey,
          runId: pending.runId
        });
        return;
      }

      this.sendSessionUpdate(pending.sessionId, {
        sessionUpdate: "usage_update",
        used: usage.used,
        size: usage.size,
        ...(usage.cost ? { cost: usage.cost } : {}),
        _meta: {
          source,
          approximate: true,
          trigger: "final-chat"
        }
      });
      logUsageDebug("sent usage_update from session store after final chat", {
        sessionKey: pending.sessionKey,
        runId: pending.runId,
        source,
        used: usage.used,
        size: usage.size
      });
    } catch (error) {
      logUsageDebug("failed to read final chat session store usage", {
        sessionKey: pending.sessionKey,
        runId: pending.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resolveChatUsageSize(
    sessionKey: string,
    payload: Record<string, unknown>,
    usage: Record<string, unknown>
  ): Promise<number | undefined> {
    const directSize =
      readPositiveFiniteNumber(payload, "contextTokens") ??
      readPositiveFiniteNumber(payload, "contextWindow") ??
      readPositiveFiniteNumber(payload, "size") ??
      readPositiveFiniteNumber(usage, "contextTokens") ??
      readPositiveFiniteNumber(usage, "contextWindow") ??
      readPositiveFiniteNumber(usage, "size") ??
      readPositiveFiniteNumber(usage, "limit");
    if (directSize !== undefined) {
      return directSize;
    }

    const row = await this.getGatewaySessionRow(sessionKey);
    return (
      (row ? readPositiveFiniteNumber(row, "contextTokens") : undefined) ??
      (row ? readPositiveFiniteNumber(row, "contextWindow") : undefined)
    );
  }

  private finishPrompt(pending: PendingPrompt, stopReason: string): void {
    this.pendingPrompts.delete(pending.sessionId);
    const session = this.sessions.get(pending.sessionId);
    if (session) {
      session.activeRunId = undefined;
    }
    pending.resolve({ stopReason });
  }

  private findPendingPrompt(
    sessionKey: string,
    runId: string | undefined
  ): PendingPrompt | null {
    for (const pending of this.pendingPrompts.values()) {
      if (!sessionKeysMatch(pending.sessionKey, sessionKey)) {
        continue;
      }
      if (runId && pending.runId !== runId) {
        continue;
      }
      return pending;
    }
    return null;
  }

  private sendSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update
      }
    });
  }

  private sendSessionSnapshotUpdate(
    sessionId: string,
    sessionSnapshot: SessionSnapshot,
    options: { includeControls: boolean }
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (options.includeControls) {
      if (this.rememberPresentation(session, "currentMode", sessionSnapshot.modes.currentModeId)) {
        this.sendSessionUpdate(sessionId, {
          sessionUpdate: "current_mode_update",
          currentModeId: sessionSnapshot.modes.currentModeId
        });
      }
      if (this.rememberPresentation(session, "configOptions", sessionSnapshot.configOptions)) {
        this.sendSessionUpdate(sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: sessionSnapshot.configOptions
        });
      }
    } else {
      this.rememberPresentation(session, "currentMode", sessionSnapshot.modes.currentModeId);
      this.rememberPresentation(session, "configOptions", sessionSnapshot.configOptions);
    }

    if (
      sessionSnapshot.metadata &&
      this.rememberPresentation(session, "metadata", sessionSnapshot.metadata)
    ) {
      this.sendSessionUpdate(sessionId, {
        sessionUpdate: "session_info_update",
        ...sessionSnapshot.metadata
      });
    }

    if (sessionSnapshot.usage) {
      this.sendSessionUpdate(sessionId, {
        sessionUpdate: "usage_update",
        used: sessionSnapshot.usage.used,
        size: sessionSnapshot.usage.size,
        ...(sessionSnapshot.usage.cost ? { cost: sessionSnapshot.usage.cost } : {}),
        _meta: {
          source: "gateway-session-store",
          approximate: true
        }
      });
    }
  }

  private sendAvailableCommands(sessionId: string): void {
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: AVAILABLE_COMMANDS
    });
  }

  private async ensureSessionChangesSubscribed(): Promise<void> {
    if (!this.sessionChangesSubscribePromise) {
      this.sessionChangesSubscribePromise = this.gateway.request("sessions.subscribe")
        .then(() => {
          this.sessionChangesSubscribed = true;
        })
        .catch((error) => {
          this.sessionChangesSubscribePromise = undefined;
          this.sessionChangesSubscribed = false;
          throw error;
        });
    }
    await this.sessionChangesSubscribePromise;
  }

  private subscribeSessionMessages(sessionKey: string): Promise<boolean> {
    return this.gateway.request("sessions.messages.subscribe", {
      key: sessionKey
    })
      .then((result) => isRecord(result) ? result.subscribed === true : false)
      .catch((error) => {
        logUsageDebug("failed to subscribe session messages", {
          sessionKey,
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      });
  }

  private async unsubscribeSessionMessages(sessionKey: string): Promise<void> {
    try {
      await this.gateway.request("sessions.messages.unsubscribe", {
        key: sessionKey
      });
    } catch (error) {
      logUsageDebug("failed to unsubscribe session messages", {
        sessionKey,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private handleSessionsChangedEvent(payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }

    const sessionKey = readOwnString(payload, "sessionKey");
    if (!sessionKey) {
      return;
    }

    const usage = buildSessionUsageSnapshot(payload);
    if (usage) {
      this.cacheLiveSessionUsage(sessionKey, usage, "gateway-sessions-changed");
    }

    if (readOwnString(payload, "phase") === "message") {
      return;
    }

    this.sendSessionsChangedPresentationUpdates(sessionKey, payload);
  }

  private handleSessionMessageEvent(payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }

    const sessionKey = readOwnString(payload, "sessionKey");
    if (!sessionKey || !isRecord(payload.message)) {
      return;
    }

    if (readOwnString(payload.message, "role") !== "assistant" || !isRecord(payload.message.usage)) {
      return;
    }

    const usage = buildChatUsageUpdate(
      payload.message.usage,
      resolveGatewayEventUsageSize(payload, payload.message.usage)
    );
    if (!usage) {
      logUsageDebug("session.message usage could not be mapped to ACP usage_update", {
        sessionKey,
        usageKeys: Object.keys(payload.message.usage)
      });
      return;
    }

    this.cacheLiveSessionUsage(sessionKey, usage, "gateway-session-message");
  }

  private sendSessionsChangedPresentationUpdates(
    sessionKey: string,
    payload: Record<string, unknown>
  ): void {
    const presentation = buildSessionPresentation(payload);
    const metadata = buildSessionMetadata({
      row: payload,
      sessionKey
    });

    for (const session of this.sessions.values()) {
      if (!sessionKeysMatch(session.sessionKey, sessionKey) && !sessionKeysMatch(sessionKey, session.sessionKey)) {
        continue;
      }

      if (this.rememberPresentation(session, "currentMode", presentation.modes.currentModeId)) {
        this.sendSessionUpdate(session.sessionId, {
          sessionUpdate: "current_mode_update",
          currentModeId: presentation.modes.currentModeId
        });
      }
      if (this.rememberPresentation(session, "configOptions", presentation.configOptions)) {
        this.sendSessionUpdate(session.sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: presentation.configOptions
        });
      }
      if (this.rememberPresentation(session, "metadata", metadata)) {
        this.sendSessionUpdate(session.sessionId, {
          sessionUpdate: "session_info_update",
          ...metadata
        });
      }
    }
  }

  private rememberPresentation(
    session: SessionState,
    field: keyof SessionPresentationState,
    value: unknown
  ): boolean {
    const next = JSON.stringify(value);
    const presentation = session.presentation ?? {};
    if (presentation[field] === next) {
      return false;
    }
    presentation[field] = next;
    session.presentation = presentation;
    return true;
  }

  private cacheLiveSessionUsage(
    sessionKey: string,
    usage: AcpUsageSnapshot,
    source: LiveSessionUsageSnapshot["source"]
  ): void {
    const snapshot: LiveSessionUsageSnapshot = {
      usage,
      source,
      updatedAt: Date.now()
    };
    this.liveUsageSnapshots.set(sessionKey, snapshot);
    this.resolveLiveUsageWaiters(sessionKey, snapshot);
  }

  private clearLiveSessionUsage(sessionKey: string): void {
    for (const key of this.liveUsageSnapshots.keys()) {
      if (sessionKeysMatch(sessionKey, key) || sessionKeysMatch(key, sessionKey)) {
        this.liveUsageSnapshots.delete(key);
      }
    }
  }

  private getLiveSessionUsage(sessionKey: string): LiveSessionUsageSnapshot | undefined {
    for (const [key, snapshot] of this.liveUsageSnapshots) {
      if (sessionKeysMatch(sessionKey, key) || sessionKeysMatch(key, sessionKey)) {
        return snapshot;
      }
    }
    return undefined;
  }

  private waitForLiveSessionUsage(
    sessionKey: string,
    timeoutMs: number
  ): Promise<LiveSessionUsageSnapshot | undefined> {
    const snapshot = this.getLiveSessionUsage(sessionKey);
    if (snapshot) {
      return Promise.resolve(snapshot);
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const waiters = this.liveUsageWaiters.get(sessionKey) ?? new Set();
      const complete = (result: LiveSessionUsageSnapshot | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        waiters.delete(complete);
        if (waiters.size === 0) {
          this.liveUsageWaiters.delete(sessionKey);
        }
        resolve(result);
      };

      timeout = setTimeout(() => complete(undefined), timeoutMs);
      waiters.add(complete);
      this.liveUsageWaiters.set(sessionKey, waiters);
    });
  }

  private resolveLiveUsageWaiters(
    sessionKey: string,
    snapshot: LiveSessionUsageSnapshot
  ): void {
    for (const [waiterSessionKey, waiters] of this.liveUsageWaiters) {
      if (
        !sessionKeysMatch(waiterSessionKey, sessionKey) &&
        !sessionKeysMatch(sessionKey, waiterSessionKey)
      ) {
        continue;
      }
      for (const waiter of [...waiters]) {
        waiter(snapshot);
      }
    }
  }
}

function buildSessionSetupResponse(sessionSnapshot: SessionSnapshot): Record<string, unknown> {
  return {
    configOptions: sessionSnapshot.configOptions,
    modes: sessionSnapshot.modes,
    ...(sessionSnapshot.models ? { models: sessionSnapshot.models } : {})
  };
}

function buildRuntimeStatus(
  session: SessionState,
  sessionSnapshot: SessionSnapshot
): Record<string, unknown> {
  const status = session.activeRunId ? "running" : "alive";
  return {
    summary: `status=${status} session=${session.sessionKey}`,
    backendSessionId: session.sessionKey,
    agentSessionId: session.sessionKey,
    ...(sessionSnapshot.models ? { models: sessionSnapshot.models } : {}),
    ...(sessionSnapshot.usage ? { usage: buildRuntimeStatusUsage(sessionSnapshot.usage) } : {}),
    availableCommands: AVAILABLE_COMMANDS,
    details: {
      status,
      cwd: session.cwd,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      currentModeId: sessionSnapshot.modes.currentModeId,
      configOptions: sessionSnapshot.configOptions,
      ...(sessionSnapshot.metadata ?? {})
    }
  };
}

function buildRuntimeStatusUsage(usage: AcpUsageSnapshot): Record<string, unknown> {
  return {
    cumulative: {
      totalTokens: usage.used,
      contextTokens: usage.size
    },
    ...(usage.cost ? { cost: usage.cost } : {})
  };
}

function buildSessionPresentation(row: Record<string, unknown>): {
  configOptions: Record<string, unknown>[];
  modes: Record<string, unknown>;
} {
  const currentModeId = readOwnString(row, "thinkingLevel") ?? "adaptive";
  const availableLevelIds = [...DEFAULT_THINKING_LEVELS];
  if (!availableLevelIds.includes(currentModeId)) {
    availableLevelIds.push(currentModeId);
  }
  const modes = {
    currentModeId,
    availableModes: availableLevelIds.map((level) => ({
      id: level,
      name: formatThinkingLevelName(level),
      ...(level === "adaptive"
        ? { description: "Use the Gateway session default thought level." }
        : {})
    }))
  };

  return {
    configOptions: [
      buildSelectConfigOption({
        id: ACP_THOUGHT_LEVEL_CONFIG_ID,
        name: "Thought level",
        category: "thought_level",
        description: "Controls how much deliberate reasoning OpenClaw requests from the Gateway model.",
        currentValue: currentModeId,
        values: availableLevelIds
      }),
      buildSelectConfigOption({
        id: ACP_FAST_MODE_CONFIG_ID,
        name: "Fast mode",
        description: "Controls whether OpenAI sessions use the Gateway fast-mode profile.",
        currentValue: row.fastMode === true ? "on" : "off",
        values: ["off", "on"]
      }),
      buildSelectConfigOption({
        id: ACP_VERBOSE_LEVEL_CONFIG_ID,
        name: "Tool verbosity",
        description: "Controls how much tool progress and output detail OpenClaw keeps enabled for the session.",
        currentValue: readOwnString(row, "verboseLevel") ?? "off",
        values: ["off", "on", "full"]
      }),
      buildSelectConfigOption({
        id: ACP_TRACE_LEVEL_CONFIG_ID,
        name: "Plugin trace",
        description: "Controls whether plugin-owned trace lines are shown for the session.",
        currentValue: readOwnString(row, "traceLevel") ?? "off",
        values: ["off", "on"]
      }),
      buildSelectConfigOption({
        id: ACP_REASONING_LEVEL_CONFIG_ID,
        name: "Reasoning stream",
        description: "Controls whether reasoning-capable models emit reasoning text for the session.",
        currentValue: readOwnString(row, "reasoningLevel") ?? "off",
        values: ["off", "on", "stream"]
      }),
      buildSelectConfigOption({
        id: ACP_RESPONSE_USAGE_CONFIG_ID,
        name: "Usage detail",
        description: "Controls how much usage information OpenClaw attaches to responses for the session.",
        currentValue: readOwnString(row, "responseUsage") ?? "off",
        values: ["off", "tokens", "full"]
      }),
      buildSelectConfigOption({
        id: ACP_ELEVATED_LEVEL_CONFIG_ID,
        name: "Elevated actions",
        description: "Controls how aggressively the session allows elevated execution behavior.",
        currentValue: readOwnString(row, "elevatedLevel") ?? "off",
        values: ["off", "on", "ask", "full"]
      })
    ],
    modes
  };
}

function buildSelectConfigOption(params: {
  id: string;
  name: string;
  category?: string;
  description: string;
  currentValue: string;
  values: string[];
}): Record<string, unknown> {
  return {
    type: "select",
    id: params.id,
    name: params.name,
    ...(params.category ? { category: params.category } : {}),
    description: params.description,
    currentValue: params.currentValue,
    options: params.values.map((value) => ({
      value,
      name: formatConfigValueName(value)
    }))
  };
}

function formatThinkingLevelName(level: string): string {
  switch (level) {
    case "xhigh":
      return "Extra High";
    case "adaptive":
      return "Adaptive";
    default:
      return formatConfigValueName(level);
  }
}

function formatConfigValueName(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : "Unknown";
}

function buildSessionMetadata(params: {
  row: Record<string, unknown>;
  sessionKey: string;
}): Record<string, unknown> {
  return {
    title:
      readOwnString(params.row, "derivedTitle") ??
      readOwnString(params.row, "displayName") ??
      readOwnString(params.row, "title") ??
      readOwnString(params.row, "label") ??
      params.sessionKey,
    updatedAt: readTimestampAsIsoString(params.row, "updatedAt") ?? null
  };
}

function buildSessionUsageSnapshot(
  row: Record<string, unknown>
): AcpUsageSnapshot | undefined {
  const totalTokens = row.totalTokens;
  const contextTokens = row.contextTokens;
  if (
    row.totalTokensFresh !== true ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return undefined;
  }

  const size = Math.max(0, Math.floor(contextTokens));
  return {
    size,
    used: Math.max(0, Math.min(Math.floor(totalTokens), size)),
    ...buildEstimatedAcpCost(row)
  };
}

function extractChatEventUsage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(payload.usage)) {
    return payload.usage;
  }
  if (isRecord(payload.message) && isRecord(payload.message.usage)) {
    return payload.message.usage;
  }
  return undefined;
}

function buildChatUsageUpdate(
  usage: Record<string, unknown>,
  rawSize: number | undefined
): AcpUsageSnapshot | undefined {
  if (rawSize === undefined || !Number.isFinite(rawSize) || rawSize <= 0) {
    return undefined;
  }

  const totalTokens = readUsageTotalTokens(usage);
  if (totalTokens === undefined) {
    return undefined;
  }

  const size = Math.max(0, Math.floor(rawSize));
  return {
    used: Math.max(0, Math.min(Math.floor(totalTokens), size)),
    size,
    ...buildAcpCost(usage)
  };
}

function resolveGatewayEventUsageSize(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>
): number | undefined {
  return (
    readPositiveFiniteNumber(payload, "contextTokens") ??
    readPositiveFiniteNumber(payload, "contextWindow") ??
    readPositiveFiniteNumber(payload, "size") ??
    readPositiveFiniteNumber(usage, "contextTokens") ??
    readPositiveFiniteNumber(usage, "contextWindow") ??
    readPositiveFiniteNumber(usage, "size") ??
    readPositiveFiniteNumber(usage, "limit")
  );
}

function buildEstimatedAcpCost(
  row: Record<string, unknown>
): { cost?: { amount: number; currency: string } } {
  const amount = readNonNegativeFiniteNumber(row, "estimatedCostUsd");
  if (amount === undefined) {
    return {};
  }

  return {
    cost: {
      amount,
      currency: "USD"
    }
  };
}

function readUsageTotalTokens(usage: Record<string, unknown>): number | undefined {
  const explicitTotal =
    readNonNegativeFiniteNumber(usage, "totalTokens") ??
    readNonNegativeFiniteNumber(usage, "total") ??
    readNonNegativeFiniteNumber(usage, "used");
  if (explicitTotal !== undefined) {
    return explicitTotal;
  }

  const input =
    readNonNegativeFiniteNumber(usage, "inputTokens") ??
    readNonNegativeFiniteNumber(usage, "input");
  const output =
    readNonNegativeFiniteNumber(usage, "outputTokens") ??
    readNonNegativeFiniteNumber(usage, "output");
  const cacheRead =
    readNonNegativeFiniteNumber(usage, "cachedReadTokens") ??
    readNonNegativeFiniteNumber(usage, "cacheRead") ??
    readNonNegativeFiniteNumber(usage, "cache_read_input_tokens");
  const cacheWrite =
    readNonNegativeFiniteNumber(usage, "cachedWriteTokens") ??
    readNonNegativeFiniteNumber(usage, "cacheWrite") ??
    readNonNegativeFiniteNumber(usage, "cache_creation_input_tokens");

  const parts = [input, output, cacheRead, cacheWrite].filter(isPresent);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.reduce((sum, value) => sum + value, 0);
}

function buildAcpCost(
  usage: Record<string, unknown>
): { cost?: { amount: number; currency: string } } {
  if (!isRecord(usage.cost)) {
    return {};
  }

  const amount =
    readNonNegativeFiniteNumber(usage.cost, "amount") ??
    readNonNegativeFiniteNumber(usage.cost, "total");
  if (amount === undefined) {
    return {};
  }

  return {
    cost: {
      amount,
      currency: readOwnString(usage.cost, "currency") ?? "USD"
    }
  };
}

function resolveSessionConfigPatch(
  configId: string,
  value: unknown
): {
  patch: Record<string, unknown>;
  overrides: Record<string, unknown>;
} {
  switch (configId) {
    case ACP_THOUGHT_LEVEL_CONFIG_ID:
      return stringPatch("thinkingLevel", value);
    case ACP_FAST_MODE_CONFIG_ID: {
      const enabled = readOnOffValue(value);
      return {
        patch: { fastMode: enabled },
        overrides: { fastMode: enabled }
      };
    }
    case ACP_VERBOSE_LEVEL_CONFIG_ID:
      return stringPatch("verboseLevel", value);
    case ACP_TRACE_LEVEL_CONFIG_ID:
      return stringPatch("traceLevel", value);
    case ACP_REASONING_LEVEL_CONFIG_ID:
      return stringPatch("reasoningLevel", value);
    case ACP_RESPONSE_USAGE_CONFIG_ID:
      return stringPatch("responseUsage", value);
    case ACP_ELEVATED_LEVEL_CONFIG_ID:
      return stringPatch("elevatedLevel", value);
    default:
      throw new Error(`ACP bridge does not support session config option "${configId}".`);
  }
}

function stringPatch(field: string, value: unknown): {
  patch: Record<string, unknown>;
  overrides: Record<string, unknown>;
} {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ACP bridge does not support non-string session config option values for "${field}".`);
  }
  return {
    patch: { [field]: value },
    overrides: { [field]: value }
  };
}

function readOnOffValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "on") {
    return true;
  }
  if (value === "off") {
    return false;
  }
  throw new Error('ACP bridge expected "on", "off", or boolean for fast_mode.');
}

function resolveModelOverride(
  response: unknown,
  requestedModelId: string
): Record<string, unknown> {
  if (isRecord(response) && isRecord(response.resolved)) {
    const modelProvider = readOwnString(response.resolved, "modelProvider");
    const model = readOwnString(response.resolved, "model");
    if (modelProvider && model) {
      return {
        modelProvider,
        model
      };
    }
  }

  const parsed = parseModelId(requestedModelId);
  return parsed.provider
    ? {
        modelProvider: parsed.provider,
        model: parsed.model
      }
    : {
        model: parsed.model
      };
}

function mapGatewayModel(model: unknown): { modelId: string; name: string; description?: string; _meta?: Record<string, unknown> } | null {
  if (!isRecord(model)) {
    return null;
  }

  const explicitModelId = readOwnString(model, "modelId");
  const provider = readOwnString(model, "provider");
  const id = readOwnString(model, "id") ?? readOwnString(model, "model") ?? explicitModelId;
  const modelId = explicitModelId ?? (provider && id ? `${provider}/${id}` : id);
  if (!modelId) {
    return null;
  }

  const description = readOwnString(model, "description");
  const result: { modelId: string; name: string; description?: string; _meta?: Record<string, unknown> } = {
    modelId,
    name: readOwnString(model, "name") ?? modelId
  };
  if (description) {
    result.description = description;
  }
  if (provider || id) {
    result._meta = {
      ...(provider ? { provider } : {}),
      ...(id ? { id } : {})
    };
  }
  return result;
}

function dedupeModels(
  models: { modelId: string; name: string; description?: string; _meta?: Record<string, unknown> }[]
): { modelId: string; name: string; description?: string; _meta?: Record<string, unknown> }[] {
  const seen = new Set<string>();
  const result = [];
  for (const model of models) {
    if (seen.has(model.modelId)) {
      continue;
    }
    seen.add(model.modelId);
    result.push(model);
  }
  return result;
}

function resolveCurrentModelId(row: Record<string, unknown>): string | undefined {
  const modelProvider = readOwnString(row, "modelProvider");
  const model = readOwnString(row, "model");
  if (modelProvider && model) {
    return `${modelProvider}/${model}`;
  }
  return model;
}

function parseModelId(modelId: string): { provider?: string; model: string } {
  const separatorIndex = modelId.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
    return { model: modelId };
  }
  return {
    provider: modelId.slice(0, separatorIndex),
    model: modelId.slice(separatorIndex + 1)
  };
}

function extractReplayChunks(message: unknown): Array<{ sessionUpdate: string; text: string }> {
  if (!isRecord(message)) {
    return [];
  }
  const role = readOwnString(message, "role");
  if (role !== "user" && role !== "assistant") {
    return [];
  }

  const sessionUpdate = role === "user" ? "user_message_chunk" : "agent_message_chunk";
  if (typeof message.content === "string" && message.content.length > 0) {
    return [
      {
        sessionUpdate,
        text: message.content
      }
    ];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || !block.text) {
        return null;
      }
      return {
        sessionUpdate,
        text: block.text
      };
    })
    .filter(isPresent);
}

function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (!Array.isArray(prompt)) {
    return "";
  }

  return prompt
    .map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
        return "";
      }
      return block.text;
    })
    .filter(Boolean)
    .join("\n");
}

function joinContentBlocks(
  blocks: unknown[],
  blockType: string,
  textField: string
): string {
  return blocks
    .map((block) => {
      if (!isRecord(block) || block.type !== blockType) {
        return "";
      }
      const value = block[textField];
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n")
    .trimEnd();
}

function mapGatewaySession(session: unknown, cwd: string): Record<string, unknown> {
  if (!isRecord(session)) {
    return {
      sessionId: "unknown",
      cwd
    };
  }

  const key = readOwnString(session, "key") ?? readOwnString(session, "sessionKey") ?? "unknown";
  return {
    sessionId: key,
    cwd,
    title:
      readOwnString(session, "derivedTitle") ??
      readOwnString(session, "displayName") ??
      readOwnString(session, "title") ??
      readOwnString(session, "label") ??
      key,
    updatedAt: readTimestampAsIsoString(session, "updatedAt") ?? undefined,
    _meta: {
      sessionKey: key
    }
  };
}

function readRequiredString(value: unknown, field: string): string {
  const result = readString(value, field);
  if (!result) {
    throw new Error(`Missing string field ${field}`);
  }
  return result;
}

function readString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readOwnString(value, field);
}

function readOwnString(
  value: Record<string, unknown>,
  field: string
): string | undefined {
  const result = value[field];
  if (typeof result !== "string" || result.trim() === "") {
    return undefined;
  }
  return result;
}

function readNonNegativeFiniteNumber(
  value: Record<string, unknown>,
  field: string
): number | undefined {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    return undefined;
  }
  return result;
}

function readPositiveFiniteNumber(
  value: Record<string, unknown>,
  field: string
): number | undefined {
  const result = readNonNegativeFiniteNumber(value, field);
  return result !== undefined && result > 0 ? result : undefined;
}

function readTimestampAsIsoString(
  value: Record<string, unknown>,
  field: string
): string | undefined {
  const result = value[field];
  if (typeof result === "string" && result.trim() !== "") {
    return result;
  }
  if (typeof result === "number" && Number.isFinite(result)) {
    return new Date(result).toISOString();
  }
  return undefined;
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("No session found:");
}

function sessionKeysMatch(expected: string, actual: string): boolean {
  return expected === actual || actual.startsWith("agent:") && actual.endsWith(`:${expected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function logUsageDebug(message: string, details: Record<string, unknown>): void {
  const enabled = /^(1|true|yes|on)$/i.test(process.env.OPENCLAW_ACP_DEBUG_USAGE ?? "");
  if (!enabled) {
    return;
  }
  process.stderr.write(`[openclaw-acp][usage] ${message} ${JSON.stringify(details)}\n`);
}
