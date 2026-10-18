// P3g-iii — observation/schedule tiles (frontend-only, from path_series).

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaObservationScheduleTile, RigaScheduleExplorerTile } from '../components/RigaScheduleTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga schedule tiles', () => {
  it('observation schedule renders the steps and barriers', async () => {
    render(<RigaObservationScheduleTile />)
    expect(await screen.findByText('Steps')).toBeTruthy()
    expect(screen.getByText('KI barrier')).toBeTruthy()
    expect(screen.getByText('Below KI')).toBeTruthy()
  })

  it('schedule explorer renders', async () => {
    render(<RigaScheduleExplorerTile />)
    expect(await screen.findByText('Schedule Explorer')).toBeTruthy()
  })
})
