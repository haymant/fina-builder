// Browser-safe entry point for `@earendil-works/pi-mcp`.
//
// The package's `index.js` statically re-exports `StdioTransport`, which
// imports `node:child_process` / `node:process`. Vite externalizes those for
// the browser, and `transports/stdio.js` reads `process.platform` at module
// top level, so importing the package root throws in the Tauri webview.
//
// The pieces the local agent needs (`McpClient` and the JSON-RPC/content
// helpers) do not depend on the stdio transport, so we import them from their
// own modules and re-export only those. `vite.config.ts` aliases
// `@earendil-works/pi-mcp` to this file.
export { McpClient, type McpClientOptions, type McpRequestOptions } from '@earendil-works/pi-mcp/dist/client.js'
export {
  toLlmContent,
  type CallToolResult,
  type ContentBlock,
  type LlmContent,
  type TextContent,
  type ImageContent,
} from '@earendil-works/pi-mcp/dist/protocol/content.js'
export {
  parseJsonRpcMessage,
  McpAbortError,
  McpConnectionClosedError,
  McpError,
  McpTimeoutError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from '@earendil-works/pi-mcp/dist/protocol/jsonrpc.js'
export type {
  Tool,
  Root,
  InitializeResult,
  ServerCapabilities,
  ListToolsResult,
  SupportedProtocolVersion,
} from '@earendil-works/pi-mcp/dist/protocol/types.js'
export type {
  McpTransport,
  McpTransportCloseListener,
  McpTransportErrorListener,
  McpTransportMessageListener,
} from '@earendil-works/pi-mcp/dist/transports/transport.js'
