// tauriTransport contract (§6.2): invoke gets the right command + camelCase
// payload; kernel errors propagate as ApiError; Channel streaming forwards
// progress and resolves with the final payload.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tauriTransport } from '../tauriTransport'
import { invoke, Channel } from '../../tests/mocks/tauriMock'

describe('tauriTransport', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes the kernel command name with the request as `req`', async () => {
    vi.mocked(invoke).mockResolvedValue({ pv: 154.03 })
    const out = await tauriTransport.call('compute_risk', { trade: {}, market: {} })
    expect(out).toEqual({ pv: 154.03 })
    expect(invoke).toHaveBeenCalledWith('compute_risk', { req: { trade: {}, market: {} } })
  })

  it('sends an empty object for commands without inputs', async () => {
    vi.mocked(invoke).mockResolvedValue({ version: '0.1.0' })
    await tauriTransport.call('health', undefined)
    expect(invoke).toHaveBeenCalledWith('health', { req: {} })
  })

  it('propagates kernel errors in the wire shape', async () => {
    vi.mocked(invoke).mockRejectedValue({ code: 'PATH_OUT_OF_RANGE', message: 'path index 500 out of range (bundle has 100)' })
    await expect(tauriTransport.call('get_path', { pathIndex: 500 })).rejects.toEqual({
      code: 'PATH_OUT_OF_RANGE',
      message: 'path index 500 out of range (bundle has 100)',
    })
  })

  it('streams progress events through the Channel and resolves with the result', async () => {
    const progress: unknown[] = []
    const events = [
      { phase: 'generate_series', completed: 0, total: 2, message: '' },
      { phase: 'generate_series', completed: 2, total: 2, message: 'done' },
    ]
    vi.mocked(invoke).mockImplementation(async (_cmd: string, args: Record<string, unknown> | undefined) => {
      const onEvent = args?.onEvent as Channel<unknown> | undefined
      for (const e of events) onEvent?.send(e)
      return { paths: [] }
    })

    const result = await tauriTransport.generatePaths({ config: {} }, (e) => progress.push(e))
    expect(progress).toEqual(events)
    expect(result).toEqual({ paths: [] })
  })

  it('fails loudly for an unmocked command', async () => {
    // invoke default mock throws; a missing test mock must not silently pass.
    await expect(tauriTransport.call('sudo_rm_rf', {})).rejects.toThrow(/unmocked tauri command/)
  })
})