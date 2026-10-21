// Business-day calendars and date rolling shared by every product template's schedule generators.

export const FREQUENCIES = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 }
export const BDCS = ['FOLLOWING', 'MODIFIED_FOLLOWING', 'PRECEDING']
export const KI_OBSERVATION = ['EUROPEAN', 'AMERICAN']
export const CA_TYPES = ['SPLIT', 'REVERSE_SPLIT', 'SPECIAL_DIVIDEND', 'RIGHTS_ISSUE']
/** Demo holiday calendars (fixed-date subset; a real deployment loads these from reference data). */
export const CALENDARS = {
  NYSE: ['01-01', '06-19', '07-04', '12-25', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-09-07', '2026-11-26', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-09-06', '2027-11-25', '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-09-04', '2028-11-23'],
  TARGET: ['01-01', '05-01', '12-25', '12-26', '2026-04-03', '2026-04-06', '2027-03-26', '2027-03-29', '2028-04-14', '2028-04-17', '2029-03-30', '2029-04-02'],
  SGX: ['01-01', '05-01', '08-09', '12-25', '2026-02-17', '2026-02-18', '2026-04-03', '2027-02-08', '2027-02-09', '2028-01-26', '2028-01-27'],
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 864e5))
export const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp

export function isBusinessDay(date, calendar = 'NYSE') {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  if (dow === 0 || dow === 6) return false
  const hol = CALENDARS[calendar] ?? []
  return !hol.includes(date) && !hol.includes(date.slice(5))
}

export function adjust(date, bdc = 'MODIFIED_FOLLOWING', calendar = 'NYSE') {
  const step = bdc === 'PRECEDING' ? -1 : 1
  let d = date
  while (!isBusinessDay(d, calendar)) d = addDays(d, step)
  if (bdc === 'MODIFIED_FOLLOWING' && d.slice(0, 7) !== date.slice(0, 7)) {
    d = date
    while (!isBusinessDay(d, calendar)) d = addDays(d, -1)
  }
  return d
}

export function addBusinessDays(date, n, calendar = 'NYSE') {
  let d = date
  let left = n
  while (left > 0) { d = addDays(d, 1); if (isBusinessDay(d, calendar)) left-- }
  return d
}

export function addMonths(date, m) {
  const [y, mo, day] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, mo - 1 + m, 1))
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  return iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))))
}


export function yearFrac(a, b) { return Math.round(((Date.parse(b) - Date.parse(a)) / 864e5 / 365) * 1e6) / 1e6 }

/** Generic 'periodic' generator: n = 1..count, unadjusted roll from start, adjusted per BDC + calendar. */
export function periodicSchedule({ start, frequency, count, calendar = 'NYSE', bdc = 'MODIFIED_FOLLOWING', paymentLagDays = 0 }) {
  const months = FREQUENCIES[frequency]
  if (!months || !isDate(start) || !(count > 0)) return []
  const out = []
  for (let n = 1; n <= count; n++) {
    const observationDate = adjust(addMonths(start, months * n), bdc, calendar)
    out.push({ n, observationDate, paymentDate: addBusinessDays(observationDate, paymentLagDays, calendar) })
  }
  return out
}
