// Key-case adapter at the MCP boundary.
//
// `riga-mcp` and `tac-engine` serialise **snake_case** fields (verified against
// the live engines). The UI is written in camelCase, so the transports convert
// keys on the way in and out. Doing it in one place keeps the drift §3.7 warns
// about contained: the tiles never see a wire spelling.
//
// The inbound conversion is deliberately conservative: only all-lowercase
// snake keys are camelised, so opaque map keys such as `FRED_DGS10` or `EUR/USD`
// are left untouched.

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/

export function isSnakeKey(key: string): boolean {
  return SNAKE.test(key)
}

export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

export function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
}

/** Deep-convert all-lowercase snake_case object keys to camelCase. */
export function toCamelKeys<T>(value: T): T {
  return transform(value, (key) => (isSnakeKey(key) ? camelKey(key) : key)) as T
}

/** Deep-convert camelCase object keys to snake_case (for outbound arguments). */
export function toSnakeKeys<T>(value: T): T {
  return transform(value, (key) => (key.includes('_') ? key : snakeKey(key))) as T
}

function transform(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => transform(item, mapKey))
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    output[mapKey(key)] = transform(item, mapKey)
  }
  return output
}
