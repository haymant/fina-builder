import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  Type,
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ChatModelAdapter, ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react'

type NativeTokenEvent = { generationId: string; delta: string; text: string }
type KernelToolName = 'get_branch_stats' | 'get_distributions' | 'get_mc_diagnostics'

const localModel: Model<Api> = {
  id: 'active-local-gguf',
  name: 'Active local GGUF',
  api: 'openai-completions',
  provider: 'fina-local',
  baseUrl: 'tauri://llama-cpp-2',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 4096,
  maxTokens: 512,
}

function localTool(name: KernelToolName, label: string, description: string): AgentTool {
  return {
    name,
    label,
    description,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const result = await invoke<unknown>(name)
      const serialized = JSON.stringify(result, null, 2)
      return {
        content: [{ type: 'text', text: serialized }],
        details: result,
        structuredContent: result as never,
      }
    },
  }
}

const kernelTools: AgentTool[] = [
  localTool(
    'get_branch_stats',
    'Path branch statistics',
    'Read the current demo bundle counts for knock-outs, knock-ins, alive paths, and settlement types.',
  ),
  localTool(
    'get_distributions',
    'Payoff distributions',
    'Read the demo payoff distribution summary, including mean, median, standard deviation, percentiles, and sample values.',
  ),
  localTool(
    'get_mc_diagnostics',
    'Monte Carlo diagnostics',
    'Read the kernel diagnostic series and efficiency summary. These are illustrative demo diagnostics, not a live large simulation.',
  ),
]

const systemPrompt = `You are Fina Builder's offline structured-products assistant. Answer from the local conversation and the supplied kernel tool results. Be explicit that this repository is a demonstrator: its synthetic paths and heuristic analytics are not production prices, official valuations, or risk measures. Do not give trading instructions.\n\nYou may call one of these read-only local tools when relevant: ${kernelTools.map((tool) => `${tool.name}: ${tool.description}`).join('\n')}. To request a tool, return exactly one JSON object and no surrounding prose: {"tool":"<tool-name>","arguments":{}}. Only use listed tools. After receiving a tool result, explain it in plain language and distinguish displayed demo values from market-calibrated outputs. Otherwise answer normally.`

class AsyncTextQueue {
  private items: string[] = []
  private waiters: Array<(value: IteratorResult<string>) => void> = []
  private closed = false

  push(value: string) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.items.push(value)
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const value = this.items.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'object' && part !== null && 'text' in part) return String(part.text)
      if (typeof part === 'object' && part !== null && 'arguments' in part) {
        return JSON.stringify({ toolCall: part })
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function toPiMessage(message: ChatModelRunOptions['messages'][number]) {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  return { role, content: contentText(message.content), timestamp: Date.now() }
}

function toNativeMessages(context: TranscriptContext) {
  return context.messages.map((message) => {
    const content = contentText(message.content)
    const role = message.role === 'system' || message.role === 'assistant' ? message.role : 'user'
    const text = message.role === 'toolResult' ? `Local tool result:\n${content}` : content
    return { role, content: text }
  })
}

function toolRequest(text: string): { name: KernelToolName; args: Record<string, never> } | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value !== 'object' || value === null || !('tool' in value)) return undefined
    const item = value as { tool?: unknown; arguments?: unknown }
    if (!kernelTools.some((tool) => tool.name === item.tool)) return undefined
    return {
      name: item.tool as KernelToolName,
      args: (typeof item.arguments === 'object' && item.arguments !== null ? item.arguments : {}) as Record<string, never>,
    }
  } catch {
    return undefined
  }
}

function createLocalStream(
  onLiveText: (text: string) => void,
  abortSignal: AbortSignal,
): (model: Model<Api>, context: TranscriptContext) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model, context) => {
    const stream = createAssistantMessageEventStream()
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending',
    }
    stream.push({ type: 'start', partial: message })

    void (async () => {
      const generationId = crypto.randomUUID()
      let unlisten: (() => void) | undefined
      let cancel: (() => void) | undefined
      try {
        unlisten = await listen<NativeTokenEvent>('llm-token', (event) => {
          if (event.payload.generationId === generationId) onLiveText(event.payload.text)
        })
        cancel = () => {
          void invoke('cancel_local_inference', { generationId }).catch(() => undefined)
        }
        abortSignal.addEventListener('abort', cancel, { once: true })
        const text = await invoke<string>('run_local_inference', {
          request: {
            generationId,
            messages: toNativeMessages(context),
            maxTokens: 512,
          },
        })
        const requestedTool = toolRequest(text)
        if (requestedTool) {
          const toolCall = {
            type: 'toolCall' as const,
            id: crypto.randomUUID(),
            name: requestedTool.name,
            arguments: requestedTool.args,
          }
          const index = 0
          message.content = [toolCall]
          message.stopReason = 'toolUse'
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: message })
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message })
          stream.push({ type: 'done', reason: 'toolUse', message })
          stream.end(message)
          return
        }
        message.content = [{ type: 'text', text }]
        message.stopReason = 'stop'
        stream.push({ type: 'text_start', contentIndex: 0, partial: message })
        if (text) stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message })
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end(message)
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        message.stopReason = abortSignal.aborted ? 'aborted' : 'error'
        message.errorMessage = messageText
        stream.push({ type: 'error', reason: message.stopReason, error: message })
        stream.end(message)
      } finally {
        if (cancel) abortSignal.removeEventListener('abort', cancel)
        unlisten?.()
      }
    })()
    return stream
  }
}

const agentsByThread = new Map<string, Agent>()

function makeAdapter(): ChatModelAdapter {
  return {
    async *run(options: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult, void> {
      const threadId = options.unstable_threadId ?? crypto.randomUUID()
      const sessionId = `chat_${threadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`
      const queue = new AsyncTextQueue()
      let liveText = ''
      const pushText = (text: string) => {
        liveText = text
        queue.push(text)
      }

      const messages = [...options.messages]
      const last = messages.pop()
      const userText = last ? contentText(last.content) : ''
      const history = messages.map(toPiMessage)
      let agent = agentsByThread.get(sessionId)
      if (!agent) {
        agent = new Agent({
          initialState: {
            systemPrompt,
            model: localModel,
            tools: kernelTools,
            messages: history as never,
          },
          sessionId,
          streamFn: createLocalStream(pushText, options.abortSignal),
          toolExecution: 'sequential',
        })
        agentsByThread.set(sessionId, agent)
      } else {
        agent.streamFunction = createLocalStream(pushText, options.abortSignal)
      }
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          pushText(`Calling local tool ${event.toolName}…`)
        }
      })

      const runPromise = agent.prompt(userText)
      void runPromise.then(() => queue.close(), () => queue.close())
      try {
        for await (const text of queue) {
          yield { content: [{ type: 'text', text }] }
        }
        await runPromise
        const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === 'assistant')
        const finalText = finalMessage ? contentText(finalMessage.content) : liveText
        if (finalText) yield { content: [{ type: 'text', text: finalText }] }
        await invoke('save_local_agent_session', {
          sessionId,
          title: userText.slice(0, 80) || 'Local chat',
          messages: agent.state.messages as unknown[],
        })
      } finally {
        unsubscribe()
      }
    },
  }
}

export const localAgentAdapter: ChatModelAdapter = makeAdapter()
