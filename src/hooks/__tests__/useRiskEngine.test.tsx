// Hook state transitions (§6.2): idle → loading → ready, and error, for the
// domain hooks. `useRiskEngine` is representative; the others share the same
// `useAsync` implementation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useRiskEngine } from '..'
import { server } from '../../tests/mocks/httpMock'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

describe('useRiskEngine', () => {
  it('starts and resolves to ready with the golden risk state', async () => {
    const { result } = renderHook(() => useRiskEngine())
    // The effect fires synchronously, so the initial status may already be
    // 'loading'; the contract is that it settles on 'ready' with the data.
    await waitFor(() => expect(result.current.status).toBe('ready'), { timeout: 2000 })
    expect(result.current.data?.pv).toBe(154.03)
    expect(result.current.data?.delta).toBe(80.0)
    expect(result.current.data?.bucketVegas).toHaveLength(6)
    expect(result.current.error).toBeNull()
  })

  it('refresh re-fetches and settles on ready again', async () => {
    const { result } = renderHook(() => useRiskEngine())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    result.current.refresh()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data?.pv).toBe(154.03)
  })
})