const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/
const INTEGER_STRING_RE = /^-?[0-9]+$/
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER
const DEFAULT_MAX_BYTES = 1_000_000

const SECRET_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret|database[_-]?url|connection(?:[_-]?string)?|dsn|bearer)/i
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/@]+):([^\s/@]+)@([^\s/?#]+)([^\s]*)/gi
const QUERY_SECRET_RE = /([?&](?:password|passwd|secret|token|api[_-]?key|authorization|credential|access[_-]?key|client[_-]?secret|key)=)([^&#\s]*)/gi
const ASSIGNMENT_SECRET_RE = /\b(password|passwd|secret|token|api[_-]?key|authorization|credential|access[_-]?key|client[_-]?secret)\s*([=:])\s*([^,;&\s]+)/gi

const fail = (message) => { throw new TypeError(message) }

/** Canonical exact decimal wire value. Financial values must arrive as strings. */
export function canonicalizeDecimal(value) {
  if (typeof value !== 'string') fail('decimal must be a string')
  if (!DECIMAL_RE.test(value)) fail(`invalid decimal: ${value}`)
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  let [integer, fraction] = unsigned.split('.')
  fraction = fraction?.replace(/0+$/, '')
  if (fraction) return `${negative ? '-' : ''}${integer}.${fraction}`
  if (integer === '0') return '0'
  return `${negative ? '-' : ''}${integer}`
}

export function assertSafeInteger(value, name = 'integer') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(`${name} must be a safe integer`)
  }
  return value
}

export function canonicalizeIntegerString(value, name = 'integer string') {
  if (typeof value !== 'string' || !INTEGER_STRING_RE.test(value)) {
    fail(`${name} must be an integer string`)
  }
  const negative = value.startsWith('-')
  const digits = (negative ? value.slice(1) : value).replace(/^0+(?=\d)/, '')
  if (digits === '0') return '0'
  return `${negative ? '-' : ''}${digits}`
}

/** Accept only an explicit instant and normalize it to an ISO UTC timestamp. */
export function normalizeUtcTimestamp(value, name = 'timestamp') {
  if (typeof value !== 'string' || !value.includes('T') || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value)) {
    fail(`${name} must include an explicit UTC offset or Z`)
  }
  const datePart = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value)
  if (!datePart) fail(`${name} is invalid`)
  const year = Number(datePart[1]); const month = Number(datePart[2]); const day = Number(datePart[3])
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) fail(`${name} is invalid`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(`${name} is invalid`)
  return new Date(parsed).toISOString()
}

function assertSerializable(value, path, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`)
    return
  }
  if (typeof value === 'bigint') fail(`${path} contains BigInt`)
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    fail(`${path} contains an unsupported value`)
  }
  if (seen.has(value)) fail(`${path} contains a circular reference`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializable(item, `${path}[${index}]`, seen))
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) fail(`${path}.${key} is a secret-like field`)
      assertSerializable(child, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

export function safeJsonStringify(value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  assertSerializable(value, '$', new Set())
  const text = JSON.stringify(value)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) fail(`JSON payload exceeds ${maxBytes} bytes`)
  return text
}

function redactString(value) {
  return value
    .replace(URL_RE, (_match, scheme, _user, _password, _host, rest) => `${scheme}://[REDACTED]@[REDACTED]${rest}`)
    .replace(QUERY_SECRET_RE, (_match, prefix) => `${prefix}[REDACTED]`)
    .replace(ASSIGNMENT_SECRET_RE, (_match, key, separator) => `${key}${separator}[REDACTED]`)
}

function redactValue(value, seen) {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[REDACTED_CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactValue(child, seen)
  }
  seen.delete(value)
  return out
}

/** Redact diagnostics for logs/errors without mutating the original value. */
export function redactDiagnostic(value) {
  return redactValue(value, new Set())
}

export function assertWireValue(value, wireType, name = 'value') {
  if (value === null) return null
  switch (wireType) {
    case 'decimal': return canonicalizeDecimal(value)
    case 'safe_integer': return assertSafeInteger(value, name)
    case 'integer_string': return canonicalizeIntegerString(value, name)
    case 'timestamp': return normalizeUtcTimestamp(value, name)
    case 'boolean':
      if (typeof value !== 'boolean') fail(`${name} must be boolean`)
      return value
    case 'string':
      if (typeof value !== 'string') fail(`${name} must be string`)
      return value
    default: fail(`unsupported wire type: ${wireType}`)
  }
}

export { DECIMAL_RE, INTEGER_STRING_RE, SAFE_INTEGER_MAX }
