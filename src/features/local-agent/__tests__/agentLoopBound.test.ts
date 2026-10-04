import { describe, expect, it } from 'vitest'
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, Type, type Api, type Model } from '@earendil-works/pi-ai'
import { createTurnGuard } from '../piLocalRuntime'

/**
 * Integration coverage for the agent-loop bound.
 *
 * `runLoop` in pi-agent-core has no step limit: it continues whenever the last
 * assistant message carried a tool call and only exits early on `error`/`aborted`
 * or when every tool result sets `terminate`. A model stuck requesting the same
 * tool therefore loops forever, and because the transcript cap keeps the prompt
 * valid, nothing else ends the run. These tests drive a real `Agent` with a
 * stream function that always asks for a tool, which is the failure the guard
 * has to break.
 */

const model: Model<Api> = {
  id: 'test-local',
  name: 'Test local',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'test://local',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 4096,
  maxTokens: 512,
}

/** A tool whose result never varies, so repeat detection has something to match. */
const constantTool = (calls: string[]): AgentTool => ({
  name: 'mcp_get_path',
  label: 'Get path',
  description: 'Always returns the same rows.',
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async () => {
    calls.push('called')
    return { content: [{ type: 'text', text: 'path:1,2,3' }], details: { rows: 3 } }
  },
})

/** A stream function that never stops asking for `toolName`. */
const alwaysCallsTool = (toolName: string) => () => {
  const stream = createAssistantMessageEventStream()
  const base = {
    role: 'assistant' as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  // `toolCallId` is fresh every round, exactly as a real loop emits.
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`
  const message = {
    ...base,
    content: [{ type: 'toolCall' as const, id: toolCallId, name: toolName, arguments: {} }],
    stopReason: 'toolUse' as const,
  }
  stream.push({ type: 'start', partial: { ...base, content: [], stopReason: 'pending' as const } })
  stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
  stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message })
  stream.push({ type: 'done', reason: 'toolUse', message })
  stream.end(message)
  return stream
}

/** A stream function that answers in plain text on the first round. */
const answersPlainly = () => () => {
  const stream = createAssistantMessageEventStream()
  const base = {
    role: 'assistant' as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  const message = {
    ...base,
    content: [{ type: 'text' as const, text: 'No tool needed.' }],
    stopReason: 'stop' as const,
  }
  stream.push({ type: 'start', partial: { ...base, content: [], stopReason: 'pending' as const } })
  stream.push({ type: 'text_start', contentIndex: 0, partial: message })
  stream.push({ type: 'text_end', contentIndex: 0, content: 'No tool needed.', partial: message })
  stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}

const buildAgent = (streamFn: ReturnType<typeof alwaysCallsTool>, finishTurn?: Agent['finishTurn']) => {
  const calls: string[] = []
  const agent = new Agent({
    initialState: { systemPrompt: 'test', model, tools: [constantTool(calls)] },
    streamFn: streamFn as never,
    toolExecution: 'sequential',
    finishTurn,
  })
  return { agent, calls }
}

describe('agent loop bound', () => {
  it('terminates a model that keeps requesting the same tool', async () => {
    const reasons: string[] = []
    const { agent, calls } = buildAgent(alwaysCallsTool('mcp_get_path'), createTurnGuard({
      maxToolRounds: 6,
      onLimit: (reason) => reasons.push(reason),
    }))

    // Without a bound this never settles. A rejected promise here would hang the
    // suite rather than fail it, so the race makes a regression visible.
    await expect(
      Promise.race([
        agent.prompt('try again'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('agent loop did not terminate')), 5000)),
      ]),
    ).resolves.toBeUndefined()

    // One wasted round, then the repeat is caught.
    expect(calls.length).toBe(2)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('repeated the same tool call')
  })

  it('terminates a model that varies the call every round', async () => {
    // A result that changes on every call defeats repeat detection, so only the
    // round budget can stop this — which is why both stops are needed.
    let calls = 0
    const varyingTool: AgentTool = {
      name: 'mcp_get_path',
      label: 'Get path',
      description: 'Returns a different result on every call.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        calls += 1
        return { content: [{ type: 'text', text: `path:${calls}` }], details: { calls } }
      },
    }
    const reasons: string[] = []
    const agent = new Agent({
      initialState: { systemPrompt: 'test', model, tools: [varyingTool] },
      streamFn: alwaysCallsTool('mcp_get_path') as never,
      toolExecution: 'sequential',
      finishTurn: createTurnGuard({ maxToolRounds: 3, onLimit: (reason) => reasons.push(reason) }),
    })

    await expect(
      Promise.race([
        agent.prompt('go'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('agent loop did not terminate')), 5000)),
      ]),
    ).resolves.toBeUndefined()

    expect(calls).toBe(3)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('3 tool calls')
  })

  it('leaves the event loop responsive while a tool turn runs', async () => {
    // The freeze was not a slow frame: an unbounded loop is a microtask chain
    // that never yields to the macrotask queue, so the webview stops servicing
    // anything at all. A 0ms timer scheduled before the prompt never fires in
    // that case, and `prompt` never resolves — so this test fails by timeout.
    // With the guard the run settles and the loop keeps working afterwards.
    const { agent } = buildAgent(alwaysCallsTool('mcp_get_path'), createTurnGuard({ maxToolRounds: 6 }))
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 0)

    await agent.prompt('try again')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(timerFired).toBe(true)
  })

  it('still ends a plain answer immediately', async () => {
    const { agent, calls } = buildAgent(answersPlainly(), createTurnGuard({ onLimit: () => undefined }))

    await expect(agent.prompt('hello')).resolves.toBeUndefined()

    expect(calls).toEqual([])
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' })
  })

  it('saves the turn the guard ends, so the session is not lost', async () => {
    // The wedge was partly destructive: `save_local_agent_session` runs after the
    // generator finishes, so an unbounded loop never persisted the transcript.
    // Once the guard ends the run, that code path is reached again.
    const { agent } = buildAgent(alwaysCallsTool('mcp_get_path'), createTurnGuard({ maxToolRounds: 6 }))
    let agentEnded = false
    agent.subscribe((event) => {
      if (event.type === 'agent_end') agentEnded = true
    })

    await agent.prompt('try again')

    expect(agentEnded).toBe(true)
    expect(agent.state.messages.some((message) => message.role === 'toolResult')).toBe(true)
  })
})
