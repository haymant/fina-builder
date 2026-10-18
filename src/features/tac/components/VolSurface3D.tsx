// A dependency-free 3D surface for the tac vol grid.
//
// ECharts' own `series.type: 'surface'` needs `echarts-gl`, and echarts-gl 2.1.0
// is **not** compatible with ECharts 6: it registers through
// `registers.registerChartView`, which ECharts 6 removed, so the surface's
// `points` layout never runs and `SurfaceView` throws
// ("undefined is not an object (evaluating 'pointsArr.length')").
//
// So the surface is drawn here instead: an isometric projection of the grid as
// SVG quads, painter-sorted back-to-front, coloured from the theme ramp. Pure
// React + SVG — no WebGL, no extra dependency, and unit-testable.

import { useId } from 'react'

export interface VolSurface3DProps {
  /** Axis tick labels; geometry is index-based, so strings (e.g. `"3M"`) are fine. */
  strikes: Array<string | number>
  maturities: Array<string | number>
  /** `volatility[row][col]`, rows = maturities, cols = strikes. */
  volatility: number[][]
  /** Low → high colour ramp (`rgb()`/`rgba()` strings). */
  ramp: string[]
  text: string
  muted: string
  border: string
  /** Legend value formatter (defaults to three decimals). */
  format?: (value: number) => string
  width?: number
  height?: number
}

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/rgba?\(([^)]+)\)/)
  if (!match) return [128, 128, 128]
  const [r, g, b] = match[1]!.split(',').map((part) => parseFloat(part))
  return [r || 0, g || 0, b || 0]
}

function mix(from: string, to: string, t: number): string {
  const [r1, g1, b1] = parseRgb(from)
  const [r2, g2, b2] = parseRgb(to)
  const r = Math.round(r1 + (r2 - r1) * t)
  const g = Math.round(g1 + (g2 - g1) * t)
  const b = Math.round(b1 + (b2 - b1) * t)
  return `rgb(${r}, ${g}, ${b})`
}

/** Position `t ∈ [0,1]` on a multi-stop ramp. */
export function rampColor(ramp: string[], t: number): string {
  if (ramp.length === 0) return 'rgb(128, 128, 128)'
  if (ramp.length === 1) return ramp[0]!
  const scaled = Math.max(0, Math.min(1, t)) * (ramp.length - 1)
  const index = Math.floor(scaled)
  const frac = scaled - index
  return index + 1 < ramp.length ? mix(ramp[index]!, ramp[index + 1]!, frac) : ramp[index]!
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export function VolSurface3D({
  strikes,
  maturities,
  volatility,
  ramp,
  text,
  muted,
  border,
  format = (value) => value.toFixed(3),
  width = 360,
  height = 240,
}: VolSurface3DProps) {
  const gradientId = useId().replace(/:/g, '')

  const rows = maturities.length
  const cols = strikes.length
  const values = volatility.flat().filter((value) => Number.isFinite(value))
  if (rows < 2 || cols < 2 || values.length === 0) {
    return <p className="p-3 text-[10px] text-muted">3D surface needs a 2×2 grid.</p>
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const norm = (value: number) => clamp01((value - min) / span)

  // Isometric projection of a unit grid; z lifts the point.
  const project = (cx: number, cy: number, z: number) => {
    const x = cx - 0.5
    const y = cy - 0.5
    return { X: (x - y) * 1, Y: (x + y) * 0.5 - z * 0.95 }
  }

  // Project every node, then fit the bounding box into the viewport.
  const nodes: Array<{ X: number; Y: number }> = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push(project(c / (cols - 1), r / (rows - 1), norm(volatility[r]?.[c] ?? min)))
    }
  }
  const xs = nodes.map((n) => n.X)
  const ys = nodes.map((n) => n.Y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const pad = { left: 34, right: 12, top: 12, bottom: 30 }
  const scale = Math.min(
    (width - pad.left - pad.right) / (maxX - minX || 1),
    (height - pad.top - pad.bottom) / (maxY - minY || 1),
  )
  const fit = (n: { X: number; Y: number }) => ({
    x: pad.left + (n.X - minX) * scale,
    y: pad.top + (n.Y - minY) * scale,
  })
  const at = (r: number, c: number) => fit(project(c / (cols - 1), r / (rows - 1), norm(volatility[r]?.[c] ?? min)))

  // Painter's algorithm: the far corner has the smallest row+col sum.
  const quads: Array<{ path: string; color: string; depth: number }> = []
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const corners = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)]
      const mean =
        ((volatility[r]?.[c] ?? min) +
          (volatility[r]?.[c + 1] ?? min) +
          (volatility[r + 1]?.[c + 1] ?? min) +
          (volatility[r + 1]?.[c] ?? min)) /
        4
      quads.push({
        path: `M${corners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z`,
        color: rampColor(ramp, norm(mean)),
        depth: r + c,
      })
    }
  }
  quads.sort((a, b) => a.depth - b.depth)

  const axisLabel = (r: number, c: number, dx: number, dy: number, label: string, anchor: 'start' | 'middle' | 'end') => {
    const p = at(r, c)
    return (
      <text
        key={`${r}-${c}-${label}`}
        x={p.x + dx}
        y={p.y + dy}
        fill={muted}
        fontSize={8}
        textAnchor={anchor}
      >
        {label}
      </text>
    )
  }

  const strikeTicks = [0, Math.floor((cols - 1) / 2), cols - 1].filter((v, i, a) => a.indexOf(v) === i)
  const maturityTicks = [0, Math.floor((rows - 1) / 2), rows - 1].filter((v, i, a) => a.indexOf(v) === i)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="100%"
        role="img"
        aria-label="3D volatility surface"
        data-testid="vol-surface-3d"
        preserveAspectRatio="xMidYMid meet"
      >
        {quads.map((quad, index) => (
          <path key={index} d={quad.path} fill={quad.color} stroke={border} strokeWidth={0.4} />
        ))}
        {strikeTicks.map((c) => axisLabel(rows - 1, c, 0, 12, String(strikes[c]), 'middle'))}
        {maturityTicks.map((r) => axisLabel(r, cols - 1, 12, 3, String(maturities[r]), 'start'))}
        <text x={pad.left} y={height - 4} fill={text} fontSize={8}>
          strike →
        </text>
        <text x={width - pad.right} y={pad.top + 8} fill={text} fontSize={8} textAnchor="end">
          maturity →
        </text>
      </svg>
      <div className="flex w-full max-w-[280px] items-center gap-2 text-[9px] text-muted">
        <span className="font-mono">{format(min)}</span>
        <span className="relative h-2 flex-1 rounded" style={{ background: `linear-gradient(90deg, ${ramp.join(', ')})` }} data-testid={`${gradientId}-legend`} />
        <span className="font-mono">{format(max)}</span>
        <span className="text-[9px]">vol</span>
      </div>
    </div>
  )
}
