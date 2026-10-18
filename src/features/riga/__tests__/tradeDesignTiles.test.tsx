// P3e — trade-design tiles on the real `trade_design` bump batch.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RigaEconomicsImpactSummaryTile,
  RigaParameterImpactMatrixTile,
  RigaSensitivityTornadoTile,
} from '../components/RigaTradeDesignTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga trade-design tiles', () => {
  it('economics impact summary renders the base economics', async () => {
    render(<RigaEconomicsImpactSummaryTile />)
    expect(await screen.findByText('Expected PV')).toBeTruthy()
    expect(screen.getByText('KO probability')).toBeTruthy()
    expect(screen.getByText('Put PV')).toBeTruthy()
  })

  it('sensitivity tornado and parameter impact matrix render', async () => {
    render(<RigaSensitivityTornadoTile />)
    expect(await screen.findByText('Sensitivity Tornado')).toBeTruthy()

    render(<RigaParameterImpactMatrixTile />)
    expect(await screen.findByText('Parameter Impact Matrix')).toBeTruthy()
    // a bumped parameter row from the transcript (awaited: the header shows while loading)
    expect(await screen.findByText('knock in barrier')).toBeTruthy()
  })
})
