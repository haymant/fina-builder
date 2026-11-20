import { describe, expect, it } from 'vitest'
import {
  assertSafeInteger,
  assertWireValue,
  canonicalizeDecimal,
  canonicalizeIntegerString,
  normalizeUtcTimestamp,
  redactDiagnostic,
  safeJsonStringify,
} from '../serialization.mjs'

const throws = (fn, pattern) => expect(fn).toThrow(pattern)

describe('Phase 3 decimal wire contract', () => {
  it('canonicalizes exact positive and negative decimals without binary floating point', () => {
    expect(canonicalizeDecimal('1250000.125')).toBe('1250000.125')
    expect(canonicalizeDecimal('-430.5000')).toBe('-430.5')
    expect(canonicalizeDecimal('0.0000000000000000001')).toBe('0.0000000000000000001')
    expect(canonicalizeDecimal('999999999999999999999999999999.000')).toBe('999999999999999999999999999999')
  })

  it('normalizes zero and negative zero and is idempotent', () => {
    for (const value of ['0', '-0', '0.000', '-0.000']) {
      expect(canonicalizeDecimal(value)).toBe('0')
    }
    const value = canonicalizeDecimal('-12.3400')
    expect(canonicalizeDecimal(value)).toBe(value)
  })

  it('rejects exponent notation, locale formatting, whitespace, and non-string numbers', () => {
    for (const value of ['1e-7', '1E+7', '1,000.00', ' 1.2', '1.2 ', '', '+1.2', 1.2, NaN, Infinity]) {
      throws(() => canonicalizeDecimal(value), /decimal/)
    }
  })

  it('keeps missing measures explicit as null and validates typed columns', () => {
    expect(assertWireValue(null, 'decimal')).toBeNull()
    expect(assertWireValue('-8450.7500', 'decimal')).toBe('-8450.75')
    expect(assertWireValue(10000, 'safe_integer')).toBe(10000)
    expect(assertWireValue('2026-11-20T12:00:03.125Z', 'timestamp')).toBe('2026-11-20T12:00:03.125Z')
  })
})

describe('Phase 3 integer and timestamp wire contract', () => {
  it('accepts only bounded JSON safe integers', () => {
    expect(assertSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(assertSafeInteger(-Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER)
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity, '100']) {
      throws(() => assertSafeInteger(value), /safe integer/)
    }
  })

  it('canonicalizes potentially large integer identifiers as strings', () => {
    expect(canonicalizeIntegerString('00012')).toBe('12')
    expect(canonicalizeIntegerString('-12')).toBe('-12')
    expect(canonicalizeIntegerString('0')).toBe('0')
    for (const value of ['1e9', '1,000', '', 12, '+1']) {
      throws(() => canonicalizeIntegerString(value), /integer string/)
    }
  })

  it('normalizes explicit offsets to UTC and rejects ambiguous local time', () => {
    expect(normalizeUtcTimestamp('2026-11-20T20:00:03+08:00')).toBe('2026-11-20T12:00:03.000Z')
    expect(normalizeUtcTimestamp('2026-11-20T12:00:03.125Z')).toBe('2026-11-20T12:00:03.125Z')
    for (const value of ['2026-11-20T12:00:03', '2026-11-20', 'not-a-date', '2026-02-30T12:00:00Z']) {
      throws(() => normalizeUtcTimestamp(value), /timestamp/)
    }
  })
})

describe('Phase 3 safe JSON persistence and diagnostics', () => {
  it('serializes finite allowlisted data and enforces payload size', () => {
    expect(safeJsonStringify({ schema: 'fina.risk-report/v1', pnl: '-1250.00', count: 10 })).toBe('{"schema":"fina.risk-report/v1","pnl":"-1250.00","count":10}')
    throws(() => safeJsonStringify({ payload: 'x'.repeat(101) }, { maxBytes: 100 }), /exceeds/)
  })

  it('rejects BigInt, functions, undefined, non-finite numbers, and circular data', () => {
    throws(() => safeJsonStringify({ id: 1n }), /BigInt/)
    throws(() => safeJsonStringify({ callback: () => null }), /unsupported/)
    throws(() => safeJsonStringify({ missing: undefined }), /unsupported/)
    throws(() => safeJsonStringify({ value: Number.NaN }), /non-finite/)
    const circular = {}; circular.self = circular
    throws(() => safeJsonStringify(circular), /circular/)
  })

  it('rejects secret-like keys from persisted DTOs at any nesting level', () => {
    for (const value of [
      { password: 'never-persist' },
      { metadata: { apiKey: 'never-persist' } },
      { connectionString: 'postgres://user:secret@host/db' },
      { headers: { authorization: 'Bearer secret' } },
    ]) {
      throws(() => safeJsonStringify(value), /secret-like field/)
    }
  })

  it('redacts nested diagnostic values, URLs, query parameters, and assignments', () => {
    const input = {
      url: 'postgres://alice:super-secret@db.internal/risk?token=abc123&sslmode=require',
      authorization: 'Bearer abc123',
      nested: { api_key: 'key-value', message: 'failed token=abc123' },
      safe: 'request timed out',
    }
    const redacted = redactDiagnostic(input)
    expect(redacted).toEqual({
      url: 'postgres://[REDACTED]@[REDACTED]/risk?token=[REDACTED]&sslmode=require',
      authorization: '[REDACTED]',
      nested: { api_key: '[REDACTED]', message: 'failed token=[REDACTED]' },
      safe: 'request timed out',
    })
    expect(JSON.stringify(redacted)).not.toContain('super-secret')
    expect(JSON.stringify(redacted)).not.toContain('abc123')
  })
})
