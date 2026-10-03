// TileRenderer table test (§6.2 / I-7): every tile type in the catalog must
// render without throwing — the direct enforcement that a refactor did not
// break a tile nobody mounted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { TILE_CATALOG } from '../../dashboards/catalog'
import { TileRenderer } from '../components/TileRenderer'
import { useSimulationStore } from '../../../store/simulationStore'
import { server } from '../../../tests/mocks/httpMock'
import { golden } from '../../../tests/mocks/goldenBundle'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

// Preload the bundle so tiles reach their data hooks instead of only the
// loading skeleton.
useSimulationStore.setState({ status: 'ready', bundle: golden().simulationBundle as never, error: null })

describe('TileRenderer (I-7: every tile renders)', () => {
  it(`renders all ${TILE_CATALOG.length} tile types without throwing`, () => {
    const types = [...new Set(TILE_CATALOG.map((t) => t.type))]
    for (const type of types) {
      expect(() => render(<TileRenderer type={type} />), `type ${type}`).not.toThrow()
    }
  })
})