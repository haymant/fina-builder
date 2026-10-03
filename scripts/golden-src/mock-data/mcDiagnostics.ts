export const MC_PATH_COUNTS = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
export type MCPoint = { paths: number; pv: number; se: number; lower: number; upper: number; ki: number; ko: number; p05: number; p50: number; p95: number }
const pv = [97.5, 96.7, 96.2, 96.05, 95.91, 95.82, 95.78, 95.75, 95.74, 95.74]
const ki = [25, 23.8, 23, 22.5, 22.25, 22.18, 22.12, 22.1, 22.1, 22.1]
const ko = [60.5, 62.1, 63.4, 64.1, 64.7, 64.9, 65, 65, 65, 65]
export const mcDiagnostics: MCPoint[] = MC_PATH_COUNTS.map((paths, i) => { const se = +(0.22 * Math.sqrt(100000 / paths)).toFixed(3); const estimate = pv[i]!; return { paths, pv: estimate, se, lower: +(estimate - 1.96 * se).toFixed(2), upper: +(estimate + 1.96 * se).toFixed(2), ki: ki[i]!, ko: ko[i]!, p05: +(72 - 8 / Math.sqrt(i + 1)).toFixed(2), p50: +(estimate).toFixed(2), p95: +(116 - 5 / Math.sqrt(i + 1)).toFixed(2) } })
export const finalMC = mcDiagnostics[mcDiagnostics.length - 1]!
export const mcEfficiency = [{ name: 'Pseudo Random', paths: 500000 }, { name: 'Antithetic', paths: 250000 }, { name: 'Sobol', paths: 60000 }, { name: 'Control Variates', paths: 80000 }]
