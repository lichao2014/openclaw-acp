export class FakeGatewayTransport {
  sent = [];
  listeners = {
    open: [],
    message: [],
    close: [],
    error: []
  };

  onOpen(listener) {
    this.listeners.open.push(listener);
  }

  onMessage(listener) {
    this.listeners.message.push(listener);
  }

  onClose(listener) {
    this.listeners.close.push(listener);
  }

  onError(listener) {
    this.listeners.error.push(listener);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.listeners.close.forEach((listener) => listener(1000, "closed"));
  }

  open() {
    this.listeners.open.forEach((listener) => listener());
  }

  receive(frame) {
    const text = JSON.stringify(frame);
    this.listeners.message.forEach((listener) => listener(text));
  }
}

export function acceptGatewayConnect(
  transport,
  {
    nonce = "nonce-1",
    protocol,
    serverVersion = "test-version",
    auth = {
      role: "operator",
      scopes: ["operator.admin"],
      deviceToken: "fixture-value-2"
    }
  } = {}
) {
  transport.open();
  transport.receive({
    type: "event",
    event: "connect.challenge",
    payload: {
      nonce
    }
  });

  const connectFrame = transport.sent.at(-1);
  transport.receive({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol,
      server: {
        version: serverVersion,
        connId: "conn-1"
      },
      features: {
        methods: ["chat.send", "sessions.resolve"],
        events: ["chat", "agent"]
      },
      auth,
      policy: {
        maxPayload: 262144,
        maxBufferedBytes: 262144,
        tickIntervalMs: 30000
      },
      snapshot: {}
    }
  });

  return connectFrame;
}
