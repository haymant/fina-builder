// Generic async-data hook: `{ data, status, error, refresh }` per §5d.4.
//
// `refresh` re-runs the loader; `deps` changes re-run it. Data is `null` until
// the first successful load.

import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AsyncState<T> {
  data: T | null
  status: AsyncStatus
  error: string | null
  refresh: () => void
}

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    status: 'idle',
    error: null,
    refresh: () => {},
  })
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const refresh = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading', error: null }))
    loaderRef
      .current()
      .then((data) => setState({ data, status: 'ready', error: null, refresh }))
      .catch((e: unknown) =>
        setState((s) => ({
          ...s,
          status: 'error',
          error: (e as { message?: string }).message ?? String(e),
        })),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}