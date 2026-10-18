// TileRenderer table test (§6.2 / I-7): every tile type in the catalog must
// render without throwing — the direct enforcement that a refactor did not
// break a tile nobody mounted.

import { afterAll, beforeAll, describe, it } from 'vitest'
import { render } from '@testing-library/react'
import { TILE_CATALOG } from '../../dashboards/catalog'
import { TileRenderer } from '../components/TileRenderer'
import { installRigaTranscript, installTacTranscript, preloadTacMarket, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeAll(() => {
  installRigaTranscript()
  installTacTranscript()
  preloadTacMarket()
})
afterAll(() => {
  resetTranscripts()
})

describe('TileRenderer (I-7: every tile renders)', () => {
  it(`renders all ${TILE_CATALOG.length} tile types without throwing`, () => {
    const types = [...new Set(TILE_CATALOG.map((t) => t.type))]
    for (const type of types) {
      const { unmount } = render(<TileRenderer type={type} />)
      unmount()
    }
  })
})