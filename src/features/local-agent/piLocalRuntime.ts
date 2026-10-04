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
import type { ChatModelAdapter, ChatModelRunOptions, ChatModelRunResult, TextMessagePart, ThreadMessageLike, ToolCallMessagePart } from '@assistant-ui/react'
import { getMcpConnection, MAX_TOOL_RESULT_CHARS } from './mcpClient'
import type { AgentSkill } from './skills'

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

/**
 * The MCP tool loadout is resolved lazily: the adapter awaits the first
 * connection (and its `tools/list`) on the first prompt, so the local model
 * only ever sees tools the running `fina-mcp` server actually advertises.
 */
async function loadMcpTools(): Promise<AgentTool[]> {
  try {
    const connection = await getMcpConnection()
    return connection.tools
  } catch (error) {
    console.warn('fina-mcp unavailable; continuing with built-in kernel tools only', error)
    return []
  }
}

/**
 * Merge the built-in tools with the MCP tools. When the MCP server exposes a
 * tool whose normalized name matches a built-in, the MCP tool wins: it is the
 * canonical path and avoids listing two tools that do the same thing. The
 * built-in stays only when no MCP twin is present (e.g. sidecar unavailable).
 */
export function mergeTools(builtIns: AgentTool[], mcpTools: AgentTool[]): AgentTool[] {
  const mcpNames = new Set(mcpTools.map((tool) => normalizeToolName(tool.name)))
  const remainingBuiltIns = builtIns.filter(
    (tool) => !mcpNames.has(normalizeToolName(`mcp_${tool.name}`)) && !mcpNames.has(normalizeToolName(tool.name)),
  )
  return [...remainingBuiltIns, ...mcpTools]
}

function describeTools(tools: AgentTool[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description ?? tool.label ?? ''}`).join('\n')
}

function buildSystemPrompt(tools: AgentTool[], skills: readonly AgentSkill[]): string {
  const skillSection = skills.length > 0
    ? `\n\nActive skills (apply their guidance):\n${skills.map((skill) => `- ${skill.name}: ${skill.instructions}`).join('\n')}`
    : ''
  return `You are Fina Builder's offline structured-products assistant. Answer from the local conversation and the supplied tool results. Be explicit that this repository is a demonstrator: its synthetic paths and heuristic analytics are not production prices, official valuations, or risk measures. Do not give trading instructions.
${skillSection}

Tools you may call (read-only):
${describeTools(tools)}

TOOL CALL FORMAT: To call a tool, reply with exactly one JSON object and nothing else:
{"tool":"<tool-name>","arguments":{}}
Use the exact tool name from the list. Do not add prose, explanations, or markdown code fences around the JSON. Wait for the tool result before answering. If no tool is needed, answer normally in plain language.`
}

/**
 * A single-slot async queue for the latest assistant part snapshot. Producers
 * overwrite the slot (only the newest snapshot matters); the consumer awaits the
 * next one. Terminal states close the queue so the generator ends deterministically.
 */
class LatestSnapshotQueue<T> {
  private slot: { value: T } | undefined
  private waiter: (() => void) | undefined
  private isClosed = false

  get closed() {
    return this.isClosed
  }

  push(value: T) {
    if (this.isClosed) return
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      this.slot = { value }
      waiter()
      return
    }
    this.slot = { value }
  }

  close() {
    if (this.isClosed) return
    this.isClosed = true
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Resolves with the next snapshot, or `undefined` once closed and drained. */
  take(): Promise<T | undefined> {
    if (this.slot) {
      const value = this.slot.value
      this.slot = undefined
      return Promise.resolve(value)
    }
    if (this.isClosed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      this.waiter = () => {
        const value = this.slot?.value
        this.slot = undefined
        resolve(value)
      }
    })
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'object' && part !== null && 'text' in part) return String(part.text)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function toPiMessage(message: ChatModelRunOptions['messages'][number]) {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  return { role, content: contentText(message.content), timestamp: Date.now() }
}

/**
 * Clamp a restored transcript's oversized tool results.
 *
 * Sessions written before the tool-result cap still contain the full payload
 * (`get_path` stored 28 kB of `content` plus 19 kB of `details`). Reopening
 * one of those chats re-seeds the agent with the oversized transcript, so every
 * later turn fails with "Conversation too long" again — the cap at the MCP
 * boundary only helps chats started after it shipped. Normalizing on load means
 * an old chat becomes usable and is rewritten in capped form on the next save.
 */
export function normalizeStoredMessages(raw: readonly unknown[]): unknown[] {
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) return item
    const envelope = item as { type?: unknown; message?: unknown }
    // Sessions wrap each Pi message in a { id, type, message } envelope.
    const body = (envelope.type === 'message' && envelope.message ? envelope.message : item) as Record<string, unknown>
    if (body.role !== 'toolResult') return item

    const capped = { ...body }
    if (typeof capped.content === 'string') {
      capped.content = capForRestore(capped.content)
    } else if (Array.isArray(capped.content)) {
      capped.content = capped.content.map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? { ...part, text: capForRestore((part as { text: string }).text) }
          : part,
      )
    }
    if (capped.details !== undefined && capped.details !== null) {
      // Only stringify when the serialized form is actually too big: the UI
      // reads `details` as an object, so a small result must keep its shape.
      if (typeof capped.details === 'string') {
        capped.details = capForRestore(capped.details)
      } else {
        const json = safeJson(capped.details)
        capped.details = json.length > MAX_TOOL_RESULT_CHARS ? capForRestore(json) : capped.details
      }
    }
    return envelope.type === 'message' ? { ...envelope, message: capped } : capped
  })
}

/** Cap a restored tool result to the same budget a fresh call would get. */
function capForRestore(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (${text.length - MAX_TOOL_RESULT_CHARS} more characters truncated; call the tool again with a narrower request for the rest)`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Cap a single message's content before it is sent to native inference. A
 * tool result can be tens of kilobytes (~13k tokens for a full payoff path),
 * which overflows the model's 4096-token context and makes every later turn
 * in the chat fail. The full result stays in the UI; the model sees a head
 * with an explicit truncation marker.
 */
const MAX_NATIVE_MESSAGE_CHARS = 2400

/**
 * Whole-transcript budget (~3k tokens of the 4096-token context). Older
 * non-system messages are dropped, newest first, so a long chat keeps working
 * instead of failing every turn with "conversation too long".
 */
const MAX_NATIVE_TOTAL_CHARS = 12000

function clampForNative(content: string): string {
  if (content.length <= MAX_NATIVE_MESSAGE_CHARS) return content
  return `${content.slice(0, MAX_NATIVE_MESSAGE_CHARS)}\n… (truncated: ${content.length - MAX_NATIVE_MESSAGE_CHARS} more characters)`
}

/**
 * Build the message array for native inference. Tool results are delivered as
 * user turns with an explicit prefix: `LlamaChatMessage` carries only role and
 * content, and many GGUF chat templates expect a tool_call_id on real `tool`
 * turns, so a prefixed user turn is the portable choice across the catalog.
 * A character-budgeted window keeps the prompt inside the model's context.
 */
export function toNativeMessages(context: TranscriptContext) {
  const clamped = context.messages
    .map((message) => {
      const content = clampForNative(contentText(message.content))
      if (message.role === 'system') return { role: 'system', content }
      if (message.role === 'assistant') return { role: 'assistant', content }
      if (message.role === 'toolResult') return { role: 'user', content: `Tool result:\n${content}` }
      return { role: 'user', content }
    })
    .filter((message) => message.content.trim().length > 0)

  const system = clamped.filter((message) => message.role === 'system')
  const conversation = clamped.filter((message) => message.role !== 'system')
  const budget = MAX_NATIVE_TOTAL_CHARS - system.reduce((sum, message) => sum + message.content.length, 0)

  const kept: typeof conversation = []
  let used = 0
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i]
    if (used + message.content.length > budget && kept.length > 0) break
    kept.unshift(message)
    used += message.content.length
  }
  return [...system, ...kept]
}

/**
 * Extract every top-level brace-balanced `{...}` slice from arbitrary text.
 * Small local models wrap the tool request in prose and markdown fences, so a
 * whole-string `JSON.parse` is too brittle to rely on.
 */
export function jsonObjectSlices(text: string): string[] {
  const slices: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          slices.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return slices
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Resolve a model-requested tool name to a registered tool. Handles the
 * built-in vs `mcp_`-prefixed MCP split: a model that asks for
 * `get_mc_diagnostics` still reaches the MCP tool, and a prefixed MCP name
 * resolves to its built-in twin when only that exists.
 */
function resolveTool(name: string, tools: AgentTool[]): AgentTool | undefined {
  const exact = tools.find((tool) => tool.name === name)
  if (exact) return exact
  const wanted = normalizeToolName(name)
  const candidates = tools.filter((tool) => {
    const normalized = normalizeToolName(tool.name)
    return normalized === wanted || normalized === normalizeToolName(`mcp_${name}`) || `mcp_${normalized}` === normalizeToolName(tool.name)
  })
  // Prefer the MCP tool when both a built-in and an MCP variant match.
  return candidates.find((tool) => tool.name.startsWith('mcp_')) ?? candidates[0]
}

export function toolRequest(text: string, tools: AgentTool[]): { name: string; args: Record<string, never> } | undefined {
  for (const slice of jsonObjectSlices(text)) {
    let value: unknown
    try {
      value = JSON.parse(slice)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const outer = value as Record<string, unknown>
    // Accept the plain protocol object and the model's common echo of an
    // already-rendered tool-call part: {"toolCall":{"name":"...","arguments":{}}}.
    const item = (typeof outer.toolCall === 'object' && outer.toolCall !== null ? outer.toolCall : outer) as {
      tool?: unknown
      arguments?: unknown
      name?: unknown
    }
    const requested = typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : undefined
    if (!requested) continue
    const tool = resolveTool(requested, tools)
    if (!tool) continue
    return {
      name: tool.name,
      args: (typeof item.arguments === 'object' && item.arguments !== null ? item.arguments : {}) as Record<string, never>,
    }
  }
  return undefined
}

function createLocalStream(
  onLiveText: (text: string) => void,
  abortSignal: AbortSignal,
  tools: AgentTool[],
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
        const requestedTool = toolRequest(text, tools)
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

const agentsBySession = new Map<string, Agent>()

/**
 * Drop a cached agent so the next prompt rebuilds it from the transcript it is
 * given. Call this when switching or starting a chat: without it, reopening a
 * session reuses the *previous* in-memory agent for that id, so a restored
 * chat silently keeps the old (possibly oversized) transcript instead of what
 * was just loaded from disk.
 */
export function resetLocalAgentSession(sessionId?: string): void {
  if (sessionId === undefined) agentsBySession.clear()
  else agentsBySession.delete(sessionId)
}

export type LocalAgentAdapterOptions = {
  /** Stable id for the loaded/active chat session; also the session file name in Rust. */
  sessionId: string
  /** Raw Pi messages restored from disk, used to seed the agent transcript. */
  initialMessages?: readonly unknown[]
  /** Skills whose instructions are injected into the system prompt. */
  skills?: readonly AgentSkill[]
  /** Called after a successful save so the host can refresh its session list. */
  onSaved?: () => void
}

/**
 * Convert stored Pi transcript messages into the shape assistant-ui renders.
 * Assistant tool calls become tool-call parts (paired with the following
 * `toolResult`), user/assistant text becomes text; system turns are dropped.
 */
export function storedMessagesToThreadMessages(raw: readonly unknown[]): ThreadMessageLike[] {
  const result: ThreadMessageLike[] = []
  // Pi tool results arrive as a separate `toolResult` message after the
  // assistant turn; index them by toolCallId so they attach to the call.
  const resultsByCallId = new Map<string, { result: unknown; isError: boolean }>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const message = item as { role?: unknown; toolCallId?: unknown; content?: unknown; isError?: unknown }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      resultsByCallId.set(message.toolCallId, {
        result: contentText(message.content),
        isError: message.isError === true,
      })
    }
  }

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const message = item as { role?: unknown; content?: unknown }
    if (message.role === 'user') {
      const text = contentText(message.content)
      if (text) result.push({ role: 'user', content: text })
    } else if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const parts: Array<TextMessagePart | ToolCallMessagePart> = []
      for (const rawPart of content) {
        if (typeof rawPart !== 'object' || rawPart === null) continue
        const part = rawPart as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: part.text })
        } else if (part.type === 'toolCall' && typeof part.name === 'string') {
          const callId = typeof part.id === 'string' ? part.id : crypto.randomUUID()
          const settled = resultsByCallId.get(callId)
          parts.push({
            type: 'tool-call',
            toolCallId: callId,
            toolName: part.name,
            args: (part.arguments ?? {}) as never,
            argsText: JSON.stringify(part.arguments ?? {}),
            result: settled?.result as never,
            isError: settled?.isError,
          })
        }
      }
      if (parts.length > 0) result.push({ role: 'assistant', content: parts })
    }
  }
  return result
}

export function createLocalAgentAdapter({ sessionId, initialMessages, skills = [], onSaved }: LocalAgentAdapterOptions): ChatModelAdapter {
  return {
    async *run(options: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult, void> {
      const queue = new LatestSnapshotQueue<ChatModelRunResult>()
      let liveText = ''

      // Accumulated assistant-ui content parts for the in-flight assistant turn.
      // Text and tool-call parts are both surfaced so the thread renders a
      // tool-call disclosure instead of the raw request JSON. These are mutable
      // drafts converted to immutable parts on each yield.
      type Draft =
        | { kind: 'text'; text: string }
        | { kind: 'tool'; toolCallId: string; toolName: string; args: unknown; argsText: string; result?: unknown; isError?: boolean }
      const drafts: Draft[] = []
      let textDraft: Extract<Draft, { kind: 'text' }> | undefined
      const snapshot = (): ChatModelRunResult => ({
        content: drafts.map((draft): TextMessagePart | ToolCallMessagePart =>
          draft.kind === 'text'
            ? { type: 'text', text: draft.text }
            : {
                type: 'tool-call',
                toolCallId: draft.toolCallId,
                toolName: draft.toolName,
                args: draft.args as never,
                argsText: draft.argsText,
                result: draft.result as never,
                isError: draft.isError,
              },
        ),
      })
      const publish = () => queue.push(snapshot())
      const setLiveText = (text: string) => {
        liveText = text
        if (textDraft) textDraft.text = text
        else {
          textDraft = { kind: 'text', text }
          drafts.push(textDraft)
        }
        publish()
      }

      // Resolve the tool loadout once per adapter: the built-in kernel tools
      // plus every tool the `fina-mcp` stdio server advertises. The MCP
      // connection is memoized, so this is cheap after the first prompt.
      const mcpTools = await loadMcpTools()
      const tools = mergeTools(kernelTools, mcpTools)
      const systemPrompt = buildSystemPrompt(tools, skills)

      const messages = [...options.messages]
      const last = messages.pop()
      const userText = last ? contentText(last.content) : ''
      const history = messages.map(toPiMessage)
      let agent = agentsBySession.get(sessionId)
      if (!agent) {
        // Normalize on load so a chat stored before the tool-result cap does not
        // re-seed the agent with a transcript that overflows the context.
        const seed = initialMessages && initialMessages.length > 0 ? normalizeStoredMessages(initialMessages) : history
        agent = new Agent({
          initialState: {
            systemPrompt,
            model: localModel,
            tools,
            messages: seed as never,
          },
          sessionId,
          streamFn: createLocalStream(setLiveText, options.abortSignal, tools),
          toolExecution: 'sequential',
        })
        agentsBySession.set(sessionId, agent)
      } else {
        // Keep the tool loadout current if the MCP server was (re)connected.
        agent.state.tools = tools
        agent.streamFunction = createLocalStream(setLiveText, options.abortSignal, tools)
      }

      const draftByToolCallId = new Map<string, Extract<Draft, { kind: 'tool' }>>()
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          // The assistant's pre-tool text is the constrained JSON request (or a
          // stray echo). Drop it so the thread shows the tool call, not the
          // protocol payload, and start a fresh text part for the follow-up.
          if (textDraft) {
            const index = drafts.indexOf(textDraft)
            const looksLikeProtocol = textDraft.text.trim().startsWith('{') || textDraft.text.includes('"tool"')
            if (looksLikeProtocol && index >= 0) drafts.splice(index, 1)
            textDraft = undefined
          }
          const draft: Extract<Draft, { kind: 'tool' }> = {
            kind: 'tool',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args ?? {},
            argsText: JSON.stringify(event.args ?? {}),
          }
          draftByToolCallId.set(event.toolCallId, draft)
          drafts.push(draft)
          publish()
        } else if (event.type === 'tool_execution_end') {
          const draft = draftByToolCallId.get(event.toolCallId)
          if (draft) {
            draft.result = event.result
            draft.isError = event.isError === true
            publish()
          }
        }
      })

      const runPromise = agent.prompt(userText)
      void runPromise.then(
        () => queue.close(),
        () => queue.close(),
      )
      try {
        for (;;) {
          const next = await queue.take()
          if (next === undefined) break
          yield next
        }
        await runPromise
        // Fall back to the agent's final assistant text if streaming missed it.
        const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === 'assistant')
        const finalText = finalMessage ? contentText(finalMessage.content) : liveText
        if (finalText && finalText !== liveText) setLiveText(finalText)
        yield snapshot()
        await invoke('save_local_agent_session', {
          sessionId,
          title: userText.slice(0, 80) || 'Local chat',
          messages: agent.state.messages as unknown[],
        })
        onSaved?.()
      } finally {
        unsubscribe()
      }
    },
  }
}
