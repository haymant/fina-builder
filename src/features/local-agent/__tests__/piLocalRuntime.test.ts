// Regression tests for the local agent's tool-request parser. Small local
// models wrap the JSON tool call in prose and markdown fences, and they often
// omit the `mcp_` prefix that the MCP tools carry.

import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { jsonObjectSlices, mergeTools, toolRequest } from '../piLocalRuntime'

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
})
