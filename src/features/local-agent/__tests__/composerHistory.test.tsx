// `unstable_useComposerInputHistory` calls `useAui()`, which throws when there is
// no assistant-ui client scope above it. Calling it in the component that
// *returns* `AssistantRuntimeProvider` therefore crashes the chat panel the
// moment it opens. These tests pin that ordering constraint.

import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  unstable_useComposerInputHistory,
  useLocalRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

const messages: ThreadMessageLike[] = [{ role: 'user', content: 'call get_path' }]

/** A hook wrapper that must run under the provider. */
function HistoryInput({ label }: { label: string }) {
  const history = unstable_useComposerInputHistory()
  return createElement(ComposerPrimitive.Input, { 'aria-label': label, ...history })
}

function Provider({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({ async *run() {} }, { initialMessages: messages })
  return createElement(AssistantRuntimeProvider, { runtime }, children)
}

describe('unstable_useComposerInputHistory placement', () => {
  it('throws when called outside a client scope', async () => {
    // React logs the boundary error and the post-render store updates; both are
    // expected here, so keep the suite output readable.
    const consoleError = console.error
    console.error = () => undefined
    try {
      expect(() => render(createElement(HistoryInput, { label: 'outside' }))).toThrow()
      await act(async () => undefined)
    } finally {
      console.error = consoleError
    }
  })

  it('works when a descendant of the provider, as the panel does it', async () => {
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        createElement(
          Provider,
          null,
          createElement(
            ComposerPrimitive.Root,
            null,
            createElement(HistoryInput, { label: 'Message local assistant' }),
          ),
        ),
      )
    })
    expect(view?.getByLabelText('Message local assistant')).toBeTruthy()
  })
})