// A full payoff path from `fina-mcp` is ~50k characters (~13k tokens). Letting
// that through untrimmed exhausts the 4096-token context on the next turn and
// makes the webview re-render a 50k string per message, so tool results are
// capped at the MCP boundary.

import { describe, expect, it } from 'vitest'
import { capLlmContent, capToolDetails, MAX_TOOL_RESULT_CHARS } from '../mcpClient'

describe('capLlmContent', () => {
  it('leaves a small result untouched', () => {
    const blocks = [{ type: 'text' as const, text: '{"id":"path-001"}' }]
    expect(capLlmContent(blocks)).toEqual(blocks)
  })

  it('truncates one oversized text block and says how much was dropped', () => {
    const [block] = capLlmContent([{ type: 'text', text: 'x'.repeat(50_801) }])
    expect(block.type).toBe('text')
    if (block.type !== 'text') throw new Error('expected text')
    expect(block.text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200)
    expect(block.text).toContain('46801 more characters truncated')
  })

  it('shares the budget across blocks instead of truncating each one', () => {
    const blocks = capLlmContent([
      { type: 'text', text: 'a'.repeat(3_000) },
      { type: 'text', text: 'b'.repeat(3_000) },
    ])
    const total = blocks.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
    expect(total).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 200)
    // The first block survives intact, the second is the one that gets cut.
    expect(blocks[0]).toEqual({ type: 'text', text: 'a'.repeat(3_000) })
  })

  it('passes images through without eating the text budget', () => {
    const blocks = capLlmContent([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'after the image' },
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('image')
    expect(blocks[1]).toEqual({ type: 'text', text: 'after the image' })
  })

  it('handles an empty result', () => {
    expect(capLlmContent([])).toEqual([])
  })
})

describe('capToolDetails', () => {
  it('keeps a small object as an object so the UI can read its fields', () => {
    const details = { id: 'path-001', couponValue: 10.4 }
    expect(capToolDetails(details)).toBe(details)
  })

  it('truncates a large object to text', () => {
    const details = { dates: Array.from({ length: 200 }, (_, i) => `2024-01-${String(i).padStart(3, '0')} coupon ${i} paid in cash`) }
    const capped = capToolDetails(details)
    expect(typeof capped).toBe('string')
    expect(String(capped)).toContain('more characters truncated')
  })

  it('truncates a long string', () => {
    expect(String(capToolDetails('y'.repeat(9_000)))).toContain('5000 more characters truncated')
  })

  it('passes null and undefined through', () => {
    expect(capToolDetails(undefined)).toBeUndefined()
    expect(capToolDetails(null)).toBeNull()
  })

  it('survives a circular payload', () => {
    const details: Record<string, unknown> = {}
    details.self = details
    expect(capToolDetails(details)).toBe('[unserializable tool result]')
  })
})