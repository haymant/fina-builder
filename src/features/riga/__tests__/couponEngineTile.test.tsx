// Coupon Engine tile: the nominal Diagram 1 strip from `get_path.couponLedger`,
// with the discounted fallback for engines that predate the field.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaCouponEngineTile } from '../components/RigaCouponEngineTile'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { RIGA_TRANSCRIPT, installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

const tools = RIGA_TRANSCRIPT.tools as Record<string, unknown>
const originalGetPath = tools.get_path

const ledger = [
  { period: 0, years: 0.0833, qualified_steps: 1, period_steps: 1, accrual: 0.009642, memory_paid: 0, paid: 0.009642, memory_accrued: 0, discount_factor: 0.99, pv: 0.0095, knocked_out: false },
  { period: 1, years: 0.1667, qualified_steps: 1, period_steps: 1, accrual: 0.009642, memory_paid: 0.004, paid: 0.013642, memory_accrued: 0, discount_factor: 0.99, pv: 0.013, knocked_out: false },
  { period: 2, years: 0.25, qualified_steps: 0, period_steps: 1, accrual: 0, memory_paid: 0, paid: 0, memory_accrued: 0.009642, discount_factor: 0.99, pv: 0, knocked_out: false },
  { period: 3, years: 0.3333, qualified_steps: 1, period_steps: 1, accrual: 0.009642, memory_paid: 0.009642, paid: 0.019284, memory_accrued: 0, discount_factor: 0.99, pv: 0.018, knocked_out: false },
]

beforeEach(() => {
  installRigaTranscript()
  useRigaSelectionStore.setState({
    selectedPathId: 0,
    pathCount: 1024,
    cachedPath: null,
    selectedObservation: { pathId: 0, step: 3 },
  })
})
afterEach(() => {
  tools.get_path = originalGetPath
  resetTranscripts()
})

describe('coupon engine tile', () => {
  it('falls back to discounted PV when the engine has no nominal strip', async () => {
    render(<RigaCouponEngineTile />)
    expect(await screen.findByTestId('coupon-engine-fallback')).toBeTruthy()
    expect(screen.getAllByText('Coupon PV').length).toBeGreaterThan(0)
    expect(screen.getByText(/does not return the nominal coupon strip/)).toBeTruthy()
  })

  it('renders the C01/C02/C03 strip with totals and the selected period', async () => {
    tools.get_path = { ...(originalGetPath as Record<string, unknown>), coupon_ledger: ledger }
    render(<RigaCouponEngineTile />)
    expect(await screen.findByText('C02 qualifier')).toBeTruthy()
    expect(screen.getByText('C01/C02 accrual')).toBeTruthy()
    expect(screen.getByText('C03 memory')).toBeTruthy()
    // Nominal total = 0.009642 + 0.013642 + 0.019284.
    expect(screen.getAllByText('0.042568').length).toBeGreaterThan(0)
    // Observation step 3 (9 steps / 9 periods) highlights P4.
    expect(screen.getByTestId('coupon-period-3').className).toContain('bg-primary/10')
    expect(screen.getByText(/falls in period P4/)).toBeTruthy()
  })

  it('switches to the graph view', async () => {
    tools.get_path = { ...(originalGetPath as Record<string, unknown>), coupon_ledger: ledger }
    render(<RigaCouponEngineTile />)
    expect(await screen.findByText('C02 qualifier')).toBeTruthy()
    fireEvent.click(screen.getByTestId('coupon-engine-view-graph'))
    expect(screen.getByTestId('coupon-engine-graph')).toBeTruthy()
  })
})
