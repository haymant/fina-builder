import { expect } from '@playwright/test'
import type { PricerPage } from '../pages/PricerPage'

/** Wait until a tile has rendered live data from the named engine tool. */
export async function expectTileLoaded(pricer: PricerPage, type: string, tool: string): Promise<void> {
  const tile = pricer.tile(type)
  await expect(tile).toBeVisible()
  await expect(tile.getByText(tool, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

/** A KPI is only meaningful once it shows a value, not the `—` placeholder. */
export async function expectKpi(pricer: PricerPage, type: string, label: string, pattern: RegExp = /\d/): Promise<void> {
  await expect(pricer.kpi(type, label)).toHaveText(pattern, { timeout: 30_000 })
}

/** Assert that two tiles reading the same composed request agree on a value. */
export async function expectKpisAgree(
  pricer: PricerPage,
  left: { type: string; label: string },
  right: { type: string; label: string },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const [leftValue, rightValue] = await Promise.all([
          pricer.readKpi(left.type, left.label),
          pricer.readKpi(right.type, right.label),
        ])
        return leftValue === rightValue && /\d/.test(leftValue)
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}
