import { expect } from '@playwright/test'
import type { TradeRepositoryPage } from '../pages/TradeRepositoryPage'

export async function expectTradeRepositoryOpen(repository: TradeRepositoryPage): Promise<void> {
  await expect(repository.root).toBeVisible()
  await expect(repository.menu).toBeVisible()
}

export async function expectBlotterLoaded(repository: TradeRepositoryPage): Promise<void> {
  await expect(repository.blotter).toBeVisible()
  await expect(repository.blotterCount).toContainText(/\d+ trades?/)
  await expect(repository.rows().first()).toBeVisible()
}

export async function expectTradeDrawerOpen(repository: TradeRepositoryPage, tradeId: string): Promise<void> {
  await expect(repository.drawer).toBeVisible()
  await expect(repository.drawerTradeId).toHaveText(tradeId)
  await expect(repository.page.getByTestId('drawer-status')).toBeVisible()
}

export async function expectPositionsAggregated(repository: TradeRepositoryPage): Promise<void> {
  await expect(repository.positionsSummary).toContainText(/\d+ positions from \d+ live trades/)
}

export async function expectReconciliationLoaded(repository: TradeRepositoryPage): Promise<void> {
  await expect(repository.reconSummary).toBeVisible()
  await expect(repository.reconBreakCount).toContainText(/\d+/)
}

export async function expectAuditLoaded(repository: TradeRepositoryPage): Promise<void> {
  await expect(repository.auditCount).toContainText(/\d+ entries \(append-only\)/)
}
