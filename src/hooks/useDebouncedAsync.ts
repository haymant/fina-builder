// Debounced variant of `useAsync` (§9.3). Slider drags and rapid field edits
// coalesce into one call; the returned `refresh` is the immediate path used by
// explicit "Price"/"Fetch" buttons.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AsyncState } from './useAsync'

export function useDebouncedAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  delay = 150,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    status: 'idle',
    error: null,
    refresh: () => {},
  })
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const runId = useRef(0)

  const run = useCallback((immediate: boolean) => {
    const id = ++runId.current
    const execute = () => {
      setState((s) => ({ ...s, status: 'loading', error: null }))
      loaderRef
        .current()
        .then((data) => {
          if (id === runId.current) setState({ data, status: 'ready', error: null, refresh: () => run(true)() })
        })
        .catch((e: unknown) => {
          if (id === runId.current) {
            setState((s) => ({
              ...s,
              status: 'error',
              error: (e as { message?: string }).message ?? String(e),
            }))
          }
        })
    }
    if (immediate) execute()
    return execute
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => run(true)(), [run])

  useEffect(() => {
    const execute = run(false)
    const timer = setTimeout(execute, delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ...state, refresh }
}
