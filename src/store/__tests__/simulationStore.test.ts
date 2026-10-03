// simulationStore contract (§6.2): idle → load → ready; idempotent double-load;
// error state; selection helpers are null-safe and wrap correctly.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fina } from '../../api'
import { useSimulationStore } from '../simulationStore'
import { golden } from '../../tests/mocks/goldenBundle'

const bundle = golden().simulationBundle

function reset() {
  useSimulationStore.setState({ status: 'idle', bundle: null, error: null, selectedPathIndex: 0 })
  vi.restoreAllMocks()
}

describe('simulationStore', () => {
  beforeEach(reset)

  it('starts idle with no bundle', () => {
    const s = useSimulationStore.getState()
    expect(s.status).toBe('idle')
    expect(s.bundle).toBeNull()
    expect(s.error).toBeNull()
  })

  it('load() transitions to ready with the bundle', async () => {
    vi.spyOn(fina, 'call').mockResolvedValue(bundle)
    await useSimulationStore.getState().load()
    const s = useSimulationStore.getState()
    expect(s.status).toBe('ready')
    expect(s.bundle?.paths).toHaveLength(100)
    expect(s.error).toBeNull()
  })

  it('is idempotent: a double-load issues one request', async () => {
    const spy = vi.spyOn(fina, 'call').mockResolvedValue(bundle)
    const load = useSimulationStore.getState().load
    await Promise.all([load(), load()])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('captures failures as status error + message', async () => {
    vi.spyOn(fina, 'call').mockRejectedValue({ message: 'server exploded' })
    await useSimulationStore.getState().load()
    const s = useSimulationStore.getState()
    expect(s.status).toBe('error')
    expect(s.error).toBe('server exploded')
    expect(s.bundle).toBeNull()
  })

  it('nextPath wraps at both ends', async () => {
    vi.spyOn(fina, 'call').mockResolvedValue(bundle)
    await useSimulationStore.getState().load()
    const store = useSimulationStore.getState()
    store.selectPath(0)
    useSimulationStore.getState().nextPath(-1)
    expect(useSimulationStore.getState().selectedPathIndex).toBe(99)
    useSimulationStore.getState().nextPath(1)
    expect(useSimulationStore.getState().selectedPathIndex).toBe(0)
  })

  it('randomPath stays in range', () => {
    vi.spyOn(fina, 'call').mockResolvedValue(bundle)
    useSimulationStore.setState({ bundle: bundle as never })
    const store = useSimulationStore.getState()
    for (let i = 0; i < 50; i += 1) {
      store.randomPath()
      const idx = useSimulationStore.getState().selectedPathIndex
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(100)
    }
  })

  it('selection helpers are no-ops while the bundle is null (no throw)', () => {
    const store = useSimulationStore.getState()
    expect(() => store.nextPath(1)).not.toThrow()
    expect(() => store.randomPath()).not.toThrow()
  })
})