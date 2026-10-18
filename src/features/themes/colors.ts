// Chart colour bridge.
//
// The app's theme tokens are authored in `oklch()` (index.css / ThemeProvider).
// Browsers render those fine, but **zrender (ECharts' canvas engine) cannot parse
// `oklch()`** — `parse('oklch(…)')` returns `undefined` and every chart colour
// silently falls back to black. So charts (heatmaps, axes, labels, tooltips) do
// not follow the theme.
//
// This module converts the oklch tokens to their sRGB equivalents once, so the
// chart layer gets strings zrender understands while the CSS layer keeps oklch.

/** CSS `oklch(L C H[ / A])` → `rgb()` / `rgba()`. Non-oklch input is returned as-is. */
export function oklchToRgb(css: string): string {
  const match = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/i.exec(
    css.trim(),
  )
  if (!match) return css
  const partial = match[1]!.endsWith('%') ? parseFloat(match[1]!) / 100 : parseFloat(match[1]!)
  // CSS maps a `C` percentage against the 0.4 reference for oklch.
  const chroma = match[2]!.endsWith('%') ? (parseFloat(match[2]!) / 100) * 0.4 : parseFloat(match[2]!)
  const hue = (parseFloat(match[3]!) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)

  // oklch → oklab → LMS³ → linear sRGB (CSS Color 4 / Ottosson matrices).
  const lPrime = partial + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = partial - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = partial - 0.0894841775 * a - 1.291485548 * b
  const l = lPrime ** 3
  const m = mPrime ** 3
  const s = sPrime ** 3
  const linearRed = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const linearGreen = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const linearBlue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
  const channel = (x: number) => Math.max(0, Math.min(255, Math.round(gamma(x) * 255)))
  const red = channel(linearRed)
  const green = channel(linearGreen)
  const blue = channel(linearBlue)

  const raw = match[4]
  if (raw === undefined) return `rgb(${red}, ${green}, ${blue})`
  const alpha = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
  return alpha >= 1 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

/** A token record with every value converted to a zrender-parseable colour. */
export function toChartTokens<T extends Record<string, string>>(tokens: T): T {
  return Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [key, oklchToRgb(value)]),
  ) as T
}
