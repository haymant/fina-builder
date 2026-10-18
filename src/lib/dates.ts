// Date-format heuristic for externally-sourced dates.
//
// Trading-system payloads carry dates in several shapes and never declare the
// format: Excel/Murex serials, Unix seconds, Unix milliseconds, ISO strings,
// `YYYYMMDD`, and `DD/MM/YYYY` / `MM/DD/YYYY` / `DD-Mon-YYYY`. This normalises any
// of them to a `YYYY-MM-DD` (UTC) string, or returns `null` when nothing
// date-like is found. Pure — no DOM, no Node — so the CLI can import it too.

export const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
export const MS_PER_DAY = 86_400_000

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Validated `YYYY-MM-DD` (UTC), or null if the parts do not form a real date. */
function fromParts(year: number, month: number, day: number): string | null {
  if (!(year >= 1900 && year <= 2200)) return null
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

function fromEpochMs(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

/** Numeric formats, disambiguated by magnitude. */
function fromNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null
  // Excel/Murex serial: 1 = 1900-01-01; 20000..60000 ≈ 1954..2064.
  if (value >= 20000 && value <= 60000) {
    return fromEpochMs(EXCEL_EPOCH_MS + Math.floor(value) * MS_PER_DAY)
  }
  // `YYYYMMDD`.
  if (value >= 19000101 && value <= 22001231) {
    const digits = String(Math.trunc(value))
    return fromParts(+digits.slice(0, 4), +digits.slice(4, 6), +digits.slice(6, 8))
  }
  // Unix seconds (1973-03 .. 2100-01).
  if (value >= 1e8 && value <= 4.1e9) return fromEpochMs(value * 1000)
  // Unix milliseconds (1973-03 .. 2242-03).
  if (value >= 1e11 && value <= 8.6e12) return fromEpochMs(value)
  return null
}

export interface DateParseOptions {
  /**
   * How to read an ambiguous `a/b/yyyy` (both parts ≤ 12). Default `false` =
   * `MM/DD/YYYY` (US), which matches this app's US-equity inputs.
   */
  dayFirst?: boolean
}

/** Normalises an unknown date value to `YYYY-MM-DD` (UTC), or null. */
export function toIsoDate(value: unknown, options: DateParseOptions = {}): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return fromEpochMs(value.getTime())
  if (typeof value === 'number') return fromNumber(value)

  const text = String(value).trim()
  if (!text) return null

  // Anything purely numeric is a serial / epoch / `YYYYMMDD`.
  if (/^-?\d+(\.\d+)?$/.test(text)) return fromNumber(Number(text))

  // `YYYY-MM-DD` / `YYYY/MM/DD` (optionally followed by a time).
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(text)
  if (ymd) return fromParts(+ymd[1]!, +ymd[2]!, +ymd[3]!)

  // `DD-Mon-YYYY` / `DD Mon YYYY`.
  const named = /^(\d{1,2})[- ]([A-Za-z]{3,})[- ](\d{2,4})$/.exec(text)
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()]
    if (month) return fromParts(normalizeYear(+named[3]!), month, +named[1]!)
  }

  // `a/b/yyyy` with `-`, `/` or `.` separators (ambiguity resolved below).
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(text)
  if (numeric) {
    const a = +numeric[1]!
    const b = +numeric[2]!
    const year = normalizeYear(+numeric[3]!)
    if (a > 12) return fromParts(year, b, a)
    if (b > 12) return fromParts(year, a, b)
    return options.dayFirst ? fromParts(year, b, a) : fromParts(year, a, b)
  }

  // Last resort: the engine's own parser (handles RFC 2822, etc.).
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : fromEpochMs(parsed)
}

function normalizeYear(year: number): number {
  if (year >= 100) return year
  return year < 70 ? 2000 + year : 1900 + year
}

/** True when `toIsoDate` can make sense of the value. */
export function looksLikeDate(value: unknown): boolean {
  return toIsoDate(value) !== null
}
