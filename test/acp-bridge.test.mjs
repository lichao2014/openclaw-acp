import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import { OpenClawAcpBridge } from "../dist/acp-bridge.js";
import { startAcpJsonRpcServer } from "../dist/acp-server.js";

class FakeGateway {
  requests = [];
  listeners = [];
  rejectSessionResolve = false;
  sessionListOverrides = {};
  sessionGetMessages = [
    {
      role: "user",
      content: "Previous question"
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Previous answer"
        }
      ]
    }
  ];

  async request(method, params, _options) {
    this.requests.push({ method, params, options: _options });

    if (method === "sessions.resolve") {
      if (this.rejectSessionResolve) {
        throw new Error(`No session found: ${params.key}`);
      }
      return {
        ok: true,
        key: params.key ?? `agent:main:${params.label ?? "main"}`
      };
    }

    if (method === "sessions.list") {
      const sessionKey = typeof params?.search === "string" ? params.search : "agent:main:main";
      const session = {
        key: sessionKey,
        label: "main",
        displayName: "Main",
        derivedTitle: "Main session",
        updatedAt: 1782100000000,
        thinkingLevel: "medium",
        modelProvider: "openai",
        model: "gpt-5.4",
        fastMode: false,
        verboseLevel: "off",
        traceLevel: "off",
        reasoningLevel: "stream",
        responseUsage: "tokens",
        elevatedLevel: "ask",
        totalTokens: 128,
        totalTokensFresh: true,
        contextTokens: 1024,
        ...this.sessionListOverrides
      };
      return {
        sessions: [session]
      };
    }

    if (method === "models.list") {
      return {
        models: [
          {
            provider: "openai",
            id: "gpt-5.4",
            name: "GPT 5.4",
            description: "Default OpenAI model"
          },
          {
            provider: "anthropic",
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6"
          }
        ]
      };
    }

    if (method === "sessions.get") {
      return {
        messages: this.sessionGetMessages
      };
    }

    if (method === "sessions.patch") {
      const model = typeof params.model === "string" ? params.model : "openai/gpt-5.4";
      const [provider, modelId] = model.includes("/")
        ? model.split("/", 2)
        : ["openai", model];
      return {
        ok: true,
        key: params.key,
        entry: params,
        resolved: {
          modelProvider: provider,
          model: modelId
        }
      };
    }

    if (method === "chat.send") {
      return {
        status: "accepted"
      };
    }

    return {
      ok: true
    };
  }

  onEvent(listener) {
    this.listeners.push(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createBridge() {
  const gateway = new FakeGateway();
  const notifications = [];
  const bridge = new OpenClawAcpBridge({
    gateway,
    send: (message) => notifications.push(message),
    cwdProvider: () => "fixture-workspace/project"
  });
  return { bridge, gateway, notifications };
}

async function waitForGatewayRequest(gateway, predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const request = gateway.requests.find(predicate);
    if (request) {
      return request;
    }
    await Promise.resolve();
  }
  return undefined;
}

async function waitForGatewayMethod(gateway, method) {
  return waitForGatewayRequest(gateway, (request) => request.method === method);
}

test("OpenClawAcpBridge initializes as openclaw-acp with session/list support", async () => {
  const { bridge } = createBridge();

  const response = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1
    }
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.agentInfo.name, "openclaw-acp");
  assert.equal(response.result.agentInfo.version, "0.1.1");
  assert.equal(response.result.agentCapabilities.loadSession, true);
  assert.deepEqual(response.result.agentCapabilities.sessionCapabilities.list, {});
  assert.deepEqual(response.result._meta.controls, [
    "session/set_mode",
    "session/set_config_option",
    "session/status"
  ]);
});

test("OpenClawAcpBridge returns ACP session presentation and pushes session metadata", async () => {
  const { bridge, notifications } = createBridge();

  const response = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });

  assert.equal(response.error, undefined);
  assert.equal(typeof response.result.sessionId, "string");
  assert.equal(response.result.modes.currentModeId, "medium");
  assert.ok(response.result.modes.availableModes.some((mode) => mode.id === "medium"));
  assert.equal(response.result.models.currentModelId, "openai/gpt-5.4");
  assert.deepEqual(
    response.result.models.availableModels.map((model) => model.modelId),
    ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]
  );

  const configOptions = new Map(
    response.result.configOptions.map((option) => [option.id, option])
  );
  assert.equal(configOptions.get("thought_level").currentValue, "medium");
  assert.equal(configOptions.get("fast_mode").currentValue, "off");
  assert.equal(configOptions.get("response_usage").currentValue, "tokens");
  assert.equal(configOptions.get("elevated_level").currentValue, "ask");

  const updates = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update);
  assert.ok(
    updates.some((update) => update.sessionUpdate === "session_info_update" && update.title === "Main session")
  );
  assert.ok(
    updates.some((update) => update.sessionUpdate === "usage_update" && update.used === 128 && update.size === 1024)
  );
  assert.ok(
    updates.some((update) =>
      update.sessionUpdate === "available_commands_update" &&
      update.availableCommands.some((command) => command.name === "model")
    )
  );
});

test("OpenClawAcpBridge loads session presentation and replays transcript chunks", async () => {
  const { bridge, notifications } = createBridge();

  const response = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/load",
    params: {
      sessionId: "agent:main:main",
      cwd: "fixture-workspace/project"
    }
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.modes.currentModeId, "medium");
  assert.equal(response.result.models.currentModelId, "openai/gpt-5.4");

  const replayed = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .filter((update) =>
      update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk"
    )
    .map((update) => [update.sessionUpdate, update.content.text]);

  assert.deepEqual(replayed, [
    ["user_message_chunk", "Previous question"],
    ["agent_message_chunk", "Previous answer"]
  ]);
});

test("OpenClawAcpBridge returns standard ACP runtime status for a loaded session", async () => {
  const { bridge } = createBridge();

  await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/load",
    params: {
      sessionId: "agent:main:main",
      cwd: "fixture-workspace/project"
    }
  });

  const response = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/status",
    params: {
      sessionId: "agent:main:main"
    }
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.summary, "status=alive session=agent:main:main");
  assert.equal(response.result.backendSessionId, "agent:main:main");
  assert.equal(response.result.agentSessionId, "agent:main:main");
  assert.equal(response.result.models.currentModelId, "openai/gpt-5.4");
  assert.equal(response.result.usage.cumulative.totalTokens, 128);
  assert.equal(response.result.usage.cumulative.contextTokens, 1024);
  assert.equal(response.result.details.status, "alive");
  assert.equal(response.result.details.cwd, "fixture-workspace/project");
  assert.equal(response.result.details.configOptions.some((option) => option.id === "thought_level"), true);
});

test("OpenClawAcpBridge applies ACP session mode, config, and model changes through Gateway patches", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  notifications.length = 0;

  const modeResponse = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/set_mode",
    params: {
      sessionId,
      modeId: "low"
    }
  });
  assert.equal(modeResponse.error, undefined);
  assert.deepEqual(gateway.requests.findLast((request) => request.method === "sessions.patch").params, {
    key: `acp:${sessionId}`,
    thinkingLevel: "low"
  });
  assert.ok(
    notifications
      .map((message) => message.params.update)
      .some((update) => update.sessionUpdate === "current_mode_update" && update.currentModeId === "low")
  );

  const configResponse = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "session/set_config_option",
    params: {
      sessionId,
      configId: "fast_mode",
      value: "on"
    }
  });
  assert.equal(configResponse.error, undefined);
  assert.deepEqual(gateway.requests.findLast((request) => request.method === "sessions.patch").params, {
    key: `acp:${sessionId}`,
    fastMode: true
  });
  assert.equal(
    configResponse.result.configOptions.find((option) => option.id === "fast_mode").currentValue,
    "on"
  );

  const modelResponse = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "session/set_model",
    params: {
      sessionId,
      modelId: "anthropic/claude-sonnet-4-6"
    }
  });
  assert.equal(modelResponse.error, undefined);
  assert.deepEqual(modelResponse.result, {});
  assert.deepEqual(gateway.requests.findLast((request) => request.method === "sessions.patch").params, {
    key: `acp:${sessionId}`,
    model: "anthropic/claude-sonnet-4-6"
  });
});

test("OpenClawAcpBridge sends prompts through chat.send and resolves on matching final chat event", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });

  const sessionId = newSession.result.sessionId;
  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);
  assert.equal(chatRequest.params.sessionKey, `acp:${sessionId}`);
  assert.ok(
    chatRequest.params.message.includes("[Working directory: fixture-workspace/project]")
  );
  assert.match(chatRequest.params.message, /hello/);
  assert.equal(typeof chatRequest.params.idempotencyKey, "string");

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "delta",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "hello"
          }
        ]
      }
    }
  });

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "hello there"
          }
        ]
      }
    }
  });

  assert.deepEqual(await promptPromise, {
    jsonrpc: "2.0",
    id: 2,
    result: {
      stopReason: "end_turn"
    }
  });

  const textChunks = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => update.content.text);

  assert.deepEqual(textChunks, ["hello", " there"]);
});

test("OpenClawAcpBridge enables full tool verbosity before sending prompts", async () => {
  const { bridge, gateway } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  gateway.requests.length = 0;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const verbosityPatchIndex = gateway.requests.findIndex((request) =>
    request.method === "sessions.patch" &&
    request.params.key === `acp:${sessionId}` &&
    request.params.verboseLevel === "full"
  );
  await waitForGatewayMethod(gateway, "chat.send");
  const chatSendIndex = gateway.requests.findIndex((request) => request.method === "chat.send");
  assert.notEqual(verbosityPatchIndex, -1);
  assert.notEqual(chatSendIndex, -1);
  assert.ok(verbosityPatchIndex < chatSendIndex);

  const chatRequest = gateway.requests[chatSendIndex];
  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "OK"
          }
        ]
      }
    }
  });

  await promptPromise;
});

test("OpenClawAcpBridge sends usage_update when final chat message includes usage", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  notifications.length = 0;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "OK"
          }
        ],
        usage: {
          input: 400,
          output: 40,
          totalTokens: 640,
          cost: {
            total: 0.02
          }
        }
      }
    }
  });

  await promptPromise;

  const usageUpdate = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .find((update) => update.sessionUpdate === "usage_update");

  assert.deepEqual(usageUpdate, {
    sessionUpdate: "usage_update",
    used: 640,
    size: 1024,
    cost: {
      amount: 0.02,
      currency: "USD"
    },
    _meta: {
      source: "gateway-chat-event"
    }
  });
});

test("OpenClawAcpBridge sends usage_update when final chat event includes top-level usage", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  notifications.length = 0;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      contextTokens: 2048,
      usage: {
        inputTokens: 300,
        outputTokens: 20
      },
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "OK"
          }
        ]
      }
    }
  });

  await promptPromise;

  const usageUpdate = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .find((update) => update.sessionUpdate === "usage_update");

  assert.deepEqual(usageUpdate, {
    sessionUpdate: "usage_update",
    used: 320,
    size: 2048,
    _meta: {
      source: "gateway-chat-event"
    }
  });
});

test("OpenClawAcpBridge sends usage_update from session store when final chat event has no usage", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  notifications.length = 0;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "OK"
          }
        ]
      }
    }
  });

  await promptPromise;

  const usageUpdate = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .find((update) => update.sessionUpdate === "usage_update");

  assert.deepEqual(usageUpdate, {
    sessionUpdate: "usage_update",
    used: 128,
    size: 1024,
    _meta: {
      source: "gateway-session-store",
      approximate: true,
      trigger: "final-chat"
    }
  });
});

test("OpenClawAcpBridge sends usage_update from live sessions.changed usage without reading transcript", async () => {
  const { bridge, gateway, notifications } = createBridge();
  gateway.sessionListOverrides = {
    totalTokens: undefined,
    totalTokensFresh: false,
    contextTokens: 200000
  };
  gateway.sessionGetMessages = [];

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  notifications.length = 0;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);

  const subscribeRequest = gateway.requests.find((request) => request.method === "sessions.subscribe");
  assert.ok(subscribeRequest);

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "OK"
          }
        ]
      }
    }
  });

  setTimeout(() => {
    gateway.emit({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: chatRequest.params.sessionKey,
        phase: "message",
        messageId: "msg-usage",
        totalTokens: 0,
        totalTokensFresh: true,
        contextTokens: 200000,
        estimatedCostUsd: 0
      }
    });
  }, 10);

  await promptPromise;

  const transcriptRequest = gateway.requests.find((request) => request.method === "sessions.get");
  assert.equal(transcriptRequest, undefined);

  const usageUpdate = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .find((update) => update.sessionUpdate === "usage_update");

  assert.deepEqual(usageUpdate, {
    sessionUpdate: "usage_update",
    used: 0,
    size: 200000,
    cost: {
      amount: 0,
      currency: "USD"
    },
    _meta: {
      source: "gateway-sessions-changed",
      approximate: true,
      trigger: "final-chat"
    }
  });
});

test("OpenClawAcpBridge sends usage_update from live session.message usage without reading transcript", async () => {
  const { bridge, gateway, notifications } = createBridge();
  gateway.sessionListOverrides = {
    totalTokens: undefined,
    totalTokensFresh: false,
    contextTokens: 200000
  };
  gateway.sessionGetMessages = [];

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  notifications.length = 0;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "2+2"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);

  const messageSubscribeRequest = gateway.requests.find((request) =>
    request.method === "sessions.messages.subscribe" &&
    request.params.key === chatRequest.params.sessionKey
  );
  assert.ok(messageSubscribeRequest);

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "4"
          }
        ]
      }
    }
  });

  setTimeout(() => {
    gateway.emit({
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: chatRequest.params.sessionKey,
        messageId: "msg-usage",
        messageSeq: 2,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "4"
            }
          ],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              total: 0
            }
          }
        },
        totalTokensFresh: false,
        contextTokens: 200000,
        estimatedCostUsd: 0
      }
    });
  }, 10);

  await promptPromise;

  const transcriptRequest = gateway.requests.find((request) => request.method === "sessions.get");
  assert.equal(transcriptRequest, undefined);

  const usageUpdate = notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update)
    .find((update) => update.sessionUpdate === "usage_update");

  assert.deepEqual(usageUpdate, {
    sessionUpdate: "usage_update",
    used: 0,
    size: 200000,
    cost: {
      amount: 0,
      currency: "USD"
    },
    _meta: {
      source: "gateway-session-message",
      approximate: true,
      trigger: "final-chat"
    }
  });
});

test("OpenClawAcpBridge maps non-message sessions.changed state to ACP presentation updates", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  const sessionListRequest = gateway.requests.find((request) => request.method === "sessions.list");
  const sessionKey = sessionListRequest.params.search;
  notifications.length = 0;

  gateway.emit({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey,
      reason: "update",
      displayName: "Updated ACP session",
      updatedAt: 1782100100000,
      thinkingLevel: "high",
      fastMode: true,
      verboseLevel: "on",
      traceLevel: "on",
      reasoningLevel: "stream",
      responseUsage: "full",
      elevatedLevel: "ask"
    }
  });

  const updates = notifications
    .filter((message) => message.method === "session/update")
    .filter((message) => message.params.sessionId === sessionId)
    .map((message) => message.params.update);

  assert.ok(
    updates.some((update) =>
      update.sessionUpdate === "current_mode_update" &&
      update.currentModeId === "high"
    )
  );

  const configUpdate = updates.find((update) => update.sessionUpdate === "config_option_update");
  assert.ok(configUpdate);
  const configOptions = new Map(configUpdate.configOptions.map((option) => [option.id, option]));
  assert.equal(configOptions.get("fast_mode").currentValue, "on");
  assert.equal(configOptions.get("trace_level").currentValue, "on");
  assert.equal(configOptions.get("response_usage").currentValue, "full");

  assert.ok(
    updates.some((update) =>
      update.sessionUpdate === "session_info_update" &&
      update.title === "Updated ACP session" &&
      update.updatedAt === "2026-06-22T03:48:20.000Z"
    )
  );
});

test("OpenClawAcpBridge deduplicates repeated sessions.changed presentation updates", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });
  const sessionId = newSession.result.sessionId;
  const sessionListRequest = gateway.requests.find((request) => request.method === "sessions.list");
  const sessionKey = sessionListRequest.params.search;
  notifications.length = 0;

  const payload = {
    sessionKey,
    phase: "start",
    displayName: "Updated ACP session",
    updatedAt: 1782100100000,
    thinkingLevel: "high",
    fastMode: true,
    verboseLevel: "on",
    traceLevel: "on",
    reasoningLevel: "stream",
    responseUsage: "full",
    elevatedLevel: "ask"
  };
  gateway.emit({
    type: "event",
    event: "sessions.changed",
    payload
  });
  gateway.emit({
    type: "event",
    event: "sessions.changed",
    payload: {
      ...payload,
      phase: "end"
    }
  });

  const updates = notifications
    .filter((message) => message.method === "session/update")
    .filter((message) => message.params.sessionId === sessionId)
    .map((message) => message.params.update);

  assert.equal(
    updates.filter((update) => update.sessionUpdate === "current_mode_update").length,
    1
  );
  assert.equal(
    updates.filter((update) => update.sessionUpdate === "config_option_update").length,
    1
  );
  assert.equal(
    updates.filter((update) => update.sessionUpdate === "session_info_update").length,
    1
  );
});

test("OpenClawAcpBridge falls back to generated ACP session keys when Gateway cannot resolve them", async () => {
  const { bridge, gateway } = createBridge();
  gateway.rejectSessionResolve = true;

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });

  assert.equal(newSession.error, undefined);
  const sessionId = newSession.result.sessionId;

  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);
  assert.equal(chatRequest.params.sessionKey, `acp:${sessionId}`);

  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: chatRequest.params.sessionKey,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: []
      }
    }
  });
  await promptPromise;
});

test("OpenClawAcpBridge matches Gateway-normalized session keys in chat events", async () => {
  const { bridge, gateway, notifications } = createBridge();

  const newSession = await bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "fixture-workspace/project"
    }
  });

  const sessionId = newSession.result.sessionId;
  const promptPromise = bridge.handleJsonRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }
  });

  const chatRequest = await waitForGatewayMethod(gateway, "chat.send");
  assert.ok(chatRequest);
  gateway.emit({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: `agent:main:${chatRequest.params.sessionKey}`,
      runId: chatRequest.params.idempotencyKey,
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "OK"
          }
        ]
      }
    }
  });

  assert.deepEqual(await promptPromise, {
    jsonrpc: "2.0",
    id: 2,
    result: {
      stopReason: "end_turn"
    }
  });
  assert.equal(
    notifications
      .filter((message) => message.method === "session/update")
      .map((message) => message.params.update)
      .find((update) => update.sessionUpdate === "agent_message_chunk")?.content.text,
    "OK"
  );
});

test("startAcpJsonRpcServer writes only JSON-RPC messages to protocol stdout", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderrChunks = [];
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(Buffer.from(chunk).toString("utf8"));
      callback();
    }
  });

  const { bridge } = createBridge();
  const server = startAcpJsonRpcServer({
    input,
    output,
    stderr,
    bridge
  });

  const outputLines = [];
  output.on("data", (chunk) => {
    outputLines.push(...Buffer.from(chunk).toString("utf8").split("\n").filter(Boolean));
  });

  input.write("not-json\n");
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    })}\n`
  );
  input.end();
  await server.closed;

  assert.equal(outputLines.length, 1);
  assert.equal(JSON.parse(outputLines[0]).result.agentInfo.name, "openclaw-acp");
  assert.match(stderrChunks.join(""), /Ignoring non-JSON ACP input line/);
});
