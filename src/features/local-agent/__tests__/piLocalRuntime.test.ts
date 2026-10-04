// Regression tests for the local agent's tool-request parser. Small local
// models wrap the JSON tool call in prose and markdown fences, and they often
// omit the `mcp_` prefix that the MCP tools carry.

import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Message, TranscriptContext } from '@earendil-works/pi-ai'
import { jsonObjectSlices, mergeTools, toNativeMessages, toolRequest } from '../piLocalRuntime'

const tool = (name: string): AgentTool =>
  ({
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: async () => ({ content: [], details: undefined }),
  }) as unknown as AgentTool

const builtIns = [tool('get_mc_diagnostics')]
const mcpTools = [tool('mcp_get_mc_diagnostics'), tool('mcp_compute_risk')]
const tools = mergeTools(builtIns, mcpTools)

describe('jsonObjectSlices', () => {
  it('extracts a fenced JSON object surrounded by prose', () => {
    const text = 'Here is the request:\n```json\n{"tool":"x","arguments":{}}\n```\nPlease wait.'
    expect(jsonObjectSlices(text)).toEqual(['{"tool":"x","arguments":{}}'])
  })

  it('ignores braces inside strings', () => {
    expect(jsonObjectSlices('{"a":"}{"}')).toEqual(['{"a":"}{"}'])
  })

  it('returns nothing for prose without an object', () => {
    expect(jsonObjectSlices('no tool here')).toEqual([])
  })
})

describe('mergeTools', () => {
  it('drops a built-in that an MCP tool already covers', () => {
    expect(tools.map((entry) => entry.name)).toEqual(['mcp_get_mc_diagnostics', 'mcp_compute_risk'])
  })

  it('keeps built-ins that have no MCP twin', () => {
    const merged = mergeTools([tool('health'), tool('get_mc_diagnostics')], mcpTools)
    expect(merged.map((entry) => entry.name)).toEqual(['health', 'mcp_get_mc_diagnostics', 'mcp_compute_risk'])
  })
})

describe('toolRequest', () => {
  it('parses a fenced request wrapped in prose', () => {
    const text = 'Here is the request:\n```json\n{"tool":"mcp_get_mc_diagnostics","arguments":{}}\n```\nPlease wait.'
    expect(toolRequest(text, tools)).toEqual({ name: 'mcp_get_mc_diagnostics', args: {} })
  })

  it('resolves a bare MCP tool name to its mcp_-prefixed tool', () => {
    expect(toolRequest('{"tool":"compute_risk","arguments":{}}', tools)).toEqual({
      name: 'mcp_compute_risk',
      args: {},
    })
  })

  it('resolves a bare name to the MCP twin in the merged loadout', () => {
    expect(toolRequest('{"tool":"get_mc_diagnostics","arguments":{}}', tools)).toEqual({
      name: 'mcp_get_mc_diagnostics',
      args: {},
    })
  })

  it('accepts the `name` field as an alias for `tool`', () => {
    expect(toolRequest('{"name":"mcp_compute_risk","arguments":{"x":1}}', tools)).toEqual({
      name: 'mcp_compute_risk',
      args: { x: 1 },
    })
  })

  it('returns undefined for plain prose', () => {
    expect(toolRequest('I will not call a tool.', tools)).toBeUndefined()
  })

  it('falls back to the built-in tool when no MCP twin is registered', () => {
    expect(toolRequest('{"tool":"get_mc_diagnostics","arguments":{}}', builtIns)).toEqual({
      name: 'get_mc_diagnostics',
      args: {},
    })
  })

  it('parses the model echo of a rendered toolCall object', () => {
    const echoed = '{"toolCall":{"arguments":{},"id":"59e8cb72","name":"mcp_get_mc_diagnostics","type":"toolCall"}}'
    expect(toolRequest(echoed, tools)).toEqual({ name: 'mcp_get_mc_diagnostics', args: {} })
  })

  it('parses a toolCall echo without the mcp prefix', () => {
    const echoed = '{"toolCall":{"name":"compute_risk","arguments":{"x":2}}}'
    expect(toolRequest(echoed, tools)).toEqual({ name: 'mcp_compute_risk', args: { x: 2 } })
  })
})

// A full payoff path from `get_path` is ~50k characters (~13k tokens). Feeding
// that back verbatim overflowed the 4096-token context, so the first tool call
// succeeded and every later turn in the same chat failed. `toNativeMessages`
// must clamp per-message content and window the whole transcript.
const context = (messages: Message[]): TranscriptContext => ({ messages }) as TranscriptContext

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })
const toolResult = (text: string): Message =>
  ({ role: 'toolResult', toolCallId: 'call-1', toolName: 'mcp_get_path', content: text, isError: false }) as unknown as Message

describe('toNativeMessages', () => {
  it('clamps an oversized tool result and marks the truncation', () => {
    const messages = toNativeMessages(context([toolResult('x'.repeat(50_801))]))
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('Tool result:\n')
    expect(messages[0].content).toContain('truncated:')
    expect(messages[0].content.length).toBeLessThan(3_000)
  })

  it('leaves a small message untouched', () => {
    expect(toNativeMessages(context([user('call get_path')]))).toEqual([{ role: 'user', content: 'call get_path' }])
  })

  it('keeps the system message and drops the oldest turns first', () => {
    const system = { role: 'system', content: 'You are the payoff agent.' } as Message
    const many = Array.from({ length: 20 }, (_, index) => user(`turn-${index} ${'y'.repeat(1_500)}`))
    const messages = toNativeMessages(context([system, ...many]))

    expect(messages[0]).toEqual({ role: 'system', content: 'You are the payoff agent.' })
    // The newest turn always survives, the oldest does not.
    expect(messages.at(-1)?.content).toContain('turn-19')
    expect(messages.some((message) => message.content.includes('turn-0 '))).toBe(false)
  })

  it('preserves order with the newest turn last', () => {
    const many = Array.from({ length: 8 }, (_, index) => user(`turn-${index} ${'z'.repeat(40_000)}`))
    const messages = toNativeMessages(context(many))
    expect(messages.at(-1)?.content).toContain('turn-7')
    expect(messages.every((message) => message.content.includes('truncated:'))).toBe(true)
    const keptOrder = messages.map((message) => Number(/turn-(\d+)/.exec(message.content)?.[1]))
    expect(keptOrder).toEqual([...keptOrder].sort((a, b) => a - b))
  })

  it('stays inside the transcript budget for a long tool-heavy chat', () => {
    const messages = toNativeMessages(
      context([
        user('call get_path'),
        toolResult('p'.repeat(50_000)),
        { role: 'assistant', content: [{ type: 'text', text: 'Here is path 1.' }] } as Message,
        user('and path 2?'),
        toolResult('p'.repeat(50_000)),
        { role: 'assistant', content: [{ type: 'text', text: 'Here is path 2.' }] } as Message,
        user('thanks'),
      ]),
    )
    const total = messages.reduce((sum, message) => sum + message.content.length, 0)
    expect(total).toBeLessThanOrEqual(12_000)
    expect(messages.at(-1)?.content).toBe('thanks')
  })

  it('drops empty turns', () => {
    expect(toNativeMessages(context([user('   '), user('real question')]))).toEqual([{ role: 'user', content: 'real question' }])
  })
})
