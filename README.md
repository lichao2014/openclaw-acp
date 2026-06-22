# openclaw-acp

[![npm version](https://img.shields.io/npm/v/%40lichao2014%2Fopenclaw-acp)](https://www.npmjs.com/package/@lichao2014/openclaw-acp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`openclaw-acp` 是 OpenClaw 的 Agent Client Protocol (ACP) 适配器。它作为
stdio JSON-RPC 进程运行，通过 WebSocket 连接本机 OpenClaw Gateway，并在 ACP
客户端和 OpenClaw Gateway 协议之间转换会话、提示词、流式输出、工具调用、模型状态
和运行时控制。

## 功能特性

- 通过 stdio 提供 ACP JSON-RPC 服务，适合编辑器、IDE 和宿主程序集成。
- 通过 WebSocket 连接 OpenClaw Gateway，并使用 Gateway token 认证。
- 支持 Gateway 协议 `v3` 和 `v4`，默认使用 `v3`。
- 支持 ACP 会话创建、加载、列表、提示词、取消、状态、模式、配置项和模型切换。
- 支持助手文本、思考文本、工具调用更新、用量快照和已加载会话的历史回放。
- 可以从 `openclaw.json` 读取连接配置，也可以通过 `--url` 和 `--token` 直接指定。
- npm 包内置 CLI 入口，可以用 `npx -y @lichao2014/openclaw-acp` 直接运行。

## 运行要求

- Node.js 20 或更高版本。
- 本机 OpenClaw Gateway 已启动。
- OpenClaw 配置文件中存在 `gateway.auth.token`。默认读取路径是
  `~/.openclaw/openclaw.json`。

如果 `gateway.port` 没有配置，适配器会使用 OpenClaw 默认 Gateway 端口 `18789`。

## 快速开始

直接从 npm 运行：

```bash
npx -y @lichao2014/openclaw-acp
```

指定非默认 OpenClaw 状态目录：

```bash
npx -y @lichao2014/openclaw-acp --config_path ~/.openclaw
```

不读取 `openclaw.json`，直接连接指定 Gateway：

```bash
npx -y @lichao2014/openclaw-acp --url ws://127.0.0.1:18789 --token <gateway-token>
```

显式指定 Gateway 协议版本：

```bash
npx -y @lichao2014/openclaw-acp --gateway_protocol v4
```

## ACP 客户端配置

下面以 `acpx` 作为 ACP 客户端示例。`acpx` 的真实用法支持两种自定义
ACP server 接入方式：临时的 `--agent <command>`，以及配置文件里的
`agents` map。

临时调用，不写配置文件：

```bash
acpx --agent "npx -y @lichao2014/openclaw-acp" exec "summarize this project"
```

长期使用时，可以在 `~/.acpx/config.json` 或项目级 `.acpxrc.json` 中配置
一个自定义 agent：

```json
{
  "agents": {
    "openclaw-gateway": {
      "command": "npx",
      "args": ["-y", "@lichao2014/openclaw-acp"]
    }
  }
}
```

然后通过这个友好名称调用：

```bash
acpx openclaw-gateway exec "summarize this project"
```

如果需要指定 OpenClaw 状态目录，把参数放进 `args`：

```json
{
  "agents": {
    "openclaw-gateway": {
      "command": "npx",
      "args": ["-y", "@lichao2014/openclaw-acp", "--config_path", "./openclaw-state"]
    }
  }
}
```

## CLI 参数

```text
openclaw-acp [--config_path <dir>] [--gateway_protocol v3|v4]
openclaw-acp --url <gateway-url> --token <gateway-token> [--config_path <dir>] [--gateway_protocol v3|v4]
```

| 参数 | 说明 |
| --- | --- |
| `--config_path <dir>` | 包含 `openclaw.json` 的目录。默认是 `~/.openclaw`。 |
| `--url <gateway-url>` | Gateway WebSocket 地址，必须和 `--token` 一起使用。 |
| `--token <gateway-token>` | Gateway 认证 token，必须和 `--url` 一起使用。 |
| `--gateway_protocol v3|v4` | Gateway 协议版本，默认是 `v3`。 |

## 工作原理

```text
ACP Client
  <-> stdio JSON-RPC
openclaw-acp
  <-> Gateway WebSocket protocol
OpenClaw Gateway
```

启动后，适配器会读取 Gateway 连接信息，建立 WebSocket 连接，完成 Gateway 握手，然后从
stdin 读取 ACP JSON-RPC 请求。ACP 响应和通知会以一行一个 JSON 对象的形式写入
stdout。

使用 Gateway 协议 `v3` 时，适配器会在 OpenClaw 状态目录下创建或复用本地 device
identity，并把 Gateway 签发的 device auth token 保存到 `identity/device-auth.json`。

## 本地开发

安装依赖：

```bash
npm install
```

编译 TypeScript 并生成可执行 `.mjs` 入口：

```bash
npm run build
```

运行测试：

```bash
npm test
```

运行本地构建产物：

```bash
node dist/cli.mjs
```

## 发布到 npm

这个包按公开 npm 包发布，并支持 `npx -y @lichao2014/openclaw-acp` 直接运行：

- `bin.openclaw-acp` 指向 `dist/cli.mjs`。
- `prepublishOnly` 会在 `npm publish` 前自动执行 `npm run build`。
- 发布文件限制为 `dist`、`README.md`、`LICENSE` 和 `package.json`。

推荐发布流程：

```bash
npm install
npm run build
npm test
npm pack --dry-run
npm publish
```

发布后，客户端可以直接运行：

```bash
npx -y @lichao2014/openclaw-acp
```

## 许可证

MIT
