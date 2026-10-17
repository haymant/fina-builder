// Shared ECharts wrapper. Every chart renders through this so tooltips behave
// consistently: confined to the chart box (no spilling over the tile), long text
// wrapped, and scrollable when it still doesn't fit.

import ReactEChartsCore from 'echarts-for-react'
import { useMemo } from 'react'

const TOOLTIP_CSS =
  'max-width:min(460px,92vw);max-height:60vh;overflow:auto;white-space:normal;word-break:break-word;border-radius:6px;'

/** Add confinement + size limits + scrolling to an ECharts tooltip config. */
export function mergeTooltipDefaults(option: unknown): unknown {
  if (!option || typeof option !== 'object') return option
  const source = option as Record<string, unknown>
  const tooltip = source.tooltip as Record<string, unknown> | undefined
  // Honour an explicit `tooltip: { show: false }`.
  if (tooltip && tooltip.show === false) return option
  return {
    ...source,
    tooltip: {
      confine: true,
      enterable: true,
      appendToBody: false,
      extraCssText: TOOLTIP_CSS,
      ...(tooltip ?? { trigger: 'item' }),
    },
  }
}

type ChartProps = React.ComponentProps<typeof ReactEChartsCore>

export default function Chart({ option, ...rest }: ChartProps) {
  const merged = useMemo(() => mergeTooltipDefaults(option) as ChartProps['option'], [option])
  return <ReactEChartsCore option={merged} notMerge {...rest} />
}
