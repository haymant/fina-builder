// A dependency-free, interactive 3D surface for the tac vol grid.
//
// ECharts' own `series.type: 'surface'` needs `echarts-gl`, and echarts-gl 2.1.0
// is **not** compatible with ECharts 6: it registers through
// `registers.registerChartView`, which ECharts 6 removed, so the surface's
// `points` layout never runs and `SurfaceView` throws
// ("undefined is not an object (evaluating 'pointsArr.length')").
//
// So the surface is drawn here instead: an orthographic projection of the grid
// as SVG quads, painter-sorted, coloured from the theme ramp. Pure React + SVG —
// no WebGL, no extra dependency, unit-testable. Drag to rotate, wheel to zoom.

import { useEffect, useMemo, useRef, useState } from 'react'

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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

interface ViewState {
  /** Rotation about the vertical axis (radians). */
  yaw: number
  /** Camera tilt above the surface plane; kept in (0, π/2) so the painter sort holds. */
  pitch: number
  zoom: number
}

export const DEFAULT_VIEW: ViewState = { yaw: -0.6, pitch: 0.72, zoom: 1 }
const MIN_PITCH = 0.15
const MAX_PITCH = 1.45
const PAD = { left: 42, right: 18, top: 14, bottom: 30 }

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
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Wheel must be a real (non-passive) listener to stop the page scrolling.
  useEffect(() => {
    const element = svgRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setView((current) => ({
        ...current,
        zoom: clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), 0.4, 5),
      }))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  const rows = maturities.length
  const cols = strikes.length

  const model = useMemo(() => {
    const values = volatility.flat().filter((value) => Number.isFinite(value))
    if (rows < 2 || cols < 2 || values.length === 0) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const norm = (r: number, c: number) => clamp(((volatility[r]?.[c] ?? min) - min) / span, 0, 1)

    const cosYaw = Math.cos(view.yaw)
    const sinYaw = Math.sin(view.yaw)
    const cosPitch = Math.cos(view.pitch)
    const sinPitch = Math.sin(view.pitch)
    const raw = (r: number, c: number) => {
      const x = c / (cols - 1) - 0.5
      const y = r / (rows - 1) - 0.5
      const z = (norm(r, c) - 0.5) * 0.9
      const x1 = x * cosYaw - y * sinYaw
      const y1 = x * sinYaw + y * cosYaw
      return { X: x1, Y: y1 * cosPitch - z * sinPitch }
    }

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const point = raw(r, c)
        minX = Math.min(minX, point.X)
        maxX = Math.max(maxX, point.X)
        minY = Math.min(minY, point.Y)
        maxY = Math.max(maxY, point.Y)
      }
    }
    const scale =
      Math.min(
        (width - PAD.left - PAD.right) / (maxX - minX || 1),
        (height - PAD.top - PAD.bottom) / (maxY - minY || 1),
      ) * view.zoom
    const offsetX = PAD.left + ((width - PAD.left - PAD.right) - (maxX - minX) * scale) / 2
    const offsetY = PAD.top + ((height - PAD.top - PAD.bottom) - (maxY - minY) * scale) / 2
    const at = (r: number, c: number) => {
      const point = raw(r, c)
      return { x: offsetX + (point.X - minX) * scale, y: offsetY + (point.Y - minY) * scale }
    }

    // Painter's algorithm: with the camera above the plane, larger screen-Y is
    // nearer, so draw ascending Y (far → near).
    const quads: Array<{ path: string; color: string; depth: number }> = []
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const corners = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)]
        const mean = (norm(r, c) + norm(r, c + 1) + norm(r + 1, c + 1) + norm(r + 1, c)) / 4
        quads.push({
          path: `M${corners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z`,
          color: rampColor(ramp, mean),
          depth: corners.reduce((sum, p) => sum + p.y, 0) / corners.length,
        })
      }
    }
    quads.sort((a, b) => a.depth - b.depth)
    return { at, quads, min, max }
  }, [rows, cols, volatility, ramp, view, width, height])

  if (!model) {
    return <p className="p-3 text-[10px] text-muted">3D surface needs a 2×2 grid.</p>
  }
  const { at, quads, min, max } = model

  const tick = (r: number, c: number, dx: number, dy: number, label: string, anchor: 'start' | 'middle' | 'end') => {
    const point = at(r, c)
    return (
      <text key={`${r}-${c}-${label}`} x={point.x + dx} y={point.y + dy} fill={muted} fontSize={8} textAnchor={anchor}>
        {label}
      </text>
    )
  }
  const ticks = (count: number) => [0, Math.floor((count - 1) / 2), count - 1].filter((v, i, a) => a.indexOf(v) === i)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-2">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="100%"
        role="img"
        aria-label="3D volatility surface (drag to rotate, scroll to zoom)"
        data-testid="vol-surface-3d"
        preserveAspectRatio="xMidYMid meet"
        style={{ touchAction: 'none', cursor: 'grab' }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId)
          drag.current = { x: event.clientX, y: event.clientY }
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          const dx = event.clientX - drag.current.x
          const dy = event.clientY - drag.current.y
          drag.current = { x: event.clientX, y: event.clientY }
          setView((current) => ({
            ...current,
            yaw: current.yaw - dx * 0.01,
            pitch: clamp(current.pitch + dy * 0.01, MIN_PITCH, MAX_PITCH),
          }))
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
      >
        {quads.map((quad, index) => (
          <path key={index} d={quad.path} fill={quad.color} stroke={border} strokeWidth={0.4} />
        ))}
        {ticks(cols).map((c) => tick(rows - 1, c, 0, 12, String(strikes[c]), 'middle'))}
        {ticks(rows).map((r) => tick(r, cols - 1, 12, 3, String(maturities[r]), 'start'))}
        <text x={width - 6} y={height - 4} fill={muted} fontSize={8} textAnchor="end">
          drag · scroll to zoom
        </text>
        <text x={6} y={12} fill={text} fontSize={9}>
          vol
        </text>
      </svg>
      <div className="flex w-full max-w-[300px] items-center gap-2 text-[9px] text-muted">
        <span className="font-mono">{format(min)}</span>
        <span className="h-2 flex-1 rounded" style={{ background: `linear-gradient(90deg, ${ramp.join(', ')})` }} />
        <span className="font-mono">{format(max)}</span>
      </div>
      <div className="flex items-center gap-2 text-[9px] text-muted">
        <button type="button" className="shock-button" onClick={() => setView(DEFAULT_VIEW)}>
          reset view
        </button>
      </div>
    </div>
  )
}
