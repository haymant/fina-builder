// Market & run metadata tiles (§7): `RigaMarketSnapshot` and `RigaHealthRun`.
// Both carry the determinism envelope in the footer.

import { memo } from 'react'
import { useRigaHealth, useRigaMarket, useRigaMarkets } from '../hooks'
import { useRigaRequestStore } from '../../../store/rigaRequestStore'
import { DataTable, Kpi, num, RigaPanel } from './primitives'
import { PanelCard } from '../../shared/components/PanelCard'

export const RigaMarketSnapshotTile = memo(function RigaMarketSnapshotTile() {
  const state = useRigaMarket()
  const markets = useRigaMarkets()
  return (
    <RigaPanel
      title="Market Snapshot"
      subtitle="get_market · list_markets"
      tool="get_market"
      runId={state.data?.id}
      state={state}
    >
      {(market) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Kpi label="Market id" value={market.id} tone="primary" />
            <Kpi label="As of" value={market.asOf} />
            <Kpi label="Risk-free rate" value={num(market.riskFreeRate)} />
            {market.spots.map((spot, index) => (
              <Kpi key={`s${index}`} label={`Spot ${index}`} value={num(spot, 2)} />
            ))}
            {market.vols.map((vol, index) => (
              <Kpi key={`v${index}`} label={`Vol ${index}`} value={num(vol)} />
            ))}
          </div>
          <div>
            <p className="eyebrow mb-1">Correlation</p>
            <DataTable
              columns={[
                { key: 'asset', label: 'Asset' },
                ...market.correlation.map((_, col) => ({
                  key: `c${col}`,
                  label: `#${col}`,
                  render: (row: { row: number }) => num(market.correlation[row.row]?.[col]),
                })),
              ]}
              rows={market.correlation.map((_, row) => ({ row }))}
            />
          </div>
          {markets.data?.markets?.length ? (
            <div>
              <p className="eyebrow mb-1">Known markets</p>
              <DataTable
                columns={[
                  { key: 'id', label: 'Id' },
                  { key: 'asOf', label: 'As of' },
                ]}
                rows={markets.data.markets}
              />
            </div>
          ) : null}
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaHealthRunTile = memo(function RigaHealthRunTile() {
  const state = useRigaHealth()
  const request = useRigaRequestStore((s) => s.request)
  return (
    <RigaPanel title="Health & Run" subtitle="engine + determinism envelope" tool="health" state={state}>
      {(health) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Kpi label="Status" value={health.status} tone={health.status === 'ok' ? 'success' : 'warning'} />
            <Kpi label="Version" value={health.version} />
            <Kpi label="Git SHA" value={health.gitSha?.slice(0, 8) ?? '—'} />
            <Kpi label="Engine" value={health.engine} />
            <Kpi label="CPU GBM" value={health.features?.cpuGbm ? 'yes' : 'no'} />
            <Kpi label="GPU" value={health.features?.gpu ? 'yes' : 'no'} />
            <Kpi label="AAD" value={health.features?.aad ? 'yes' : 'no'} />
          </div>
          <div>
            <p className="eyebrow mb-1">Active request</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Kpi label="Seed" value={request.config.seed} />
              <Kpi label="Paths" value={request.config.paths.toLocaleString()} />
              <Kpi label="Trace level" value={request.config.traceLevel} tone="primary" />
              <Kpi label="Variance reduction" value={request.config.varianceReduction.kind} />
              <Kpi label="As of" value={request.market.asOf} />
              <Kpi label="Maturity (y)" value={num(request.trade.maturityYears, 2)} />
            </div>
          </div>
        </div>
      )}
    </RigaPanel>
  )
})

/** A one-line run footer reused by riga tiles that have no payload footer. */
export function RigaRunFooter() {
  const request = useRigaRequestStore((s) => s.request)
  return (
    <PanelCard title="Determinism envelope" subtitle="seed · as_of · trace" className="h-full">
      <div className="grid grid-cols-3 gap-2 p-3">
        <Kpi label="Seed" value={request.config.seed} />
        <Kpi label="As of" value={request.market.asOf} />
        <Kpi label="Trace" value={request.config.traceLevel} />
      </div>
    </PanelCard>
  )
}
