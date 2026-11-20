export interface McpToolParams {
  name?: string
  arguments?: Record<string, unknown>
}

export function validateRdToolCall(params?: McpToolParams): void
export function validateRiskcubeToolCall(params?: McpToolParams): void
