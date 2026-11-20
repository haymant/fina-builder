// 2026 Trading Calendar: FOMC, Economic Data Releases & Market Holidays
const Y = "2026";

const d = (month: number, day: number) => `${Y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

// ── Color mapping ──────────────────────────────────────────────────────────
const FED = "#ef4444";      // red – Fed / Central Banks
const ECON = "#3b82f6";     // blue – Economic Data
const HOL = "#f59e0b";      // amber – Market Holidays

// ── Event factory ──────────────────────────────────────────────────────────
const ev = (start: string, title: string, color: string, groupId: string, end?: string) =>
  ({ start, ...(end ? { end } : {}), allDay: true, title, color, groupId });

// ── FOMC Meetings (estimated 2026 schedule) ────────────────────────────────
const fomcMeetings = [
  ev(d(1, 27), "FOMC Meeting (Jan)", FED, "fed", d(1, 29)),
  ev(d(3, 17), "FOMC Meeting (Mar)", FED, "fed", d(3, 19)),
  ev(d(5, 5), "FOMC Meeting (May)", FED, "fed", d(5, 7)),
  ev(d(6, 16), "FOMC Meeting (Jun)", FED, "fed", d(6, 18)),
  ev(d(7, 28), "FOMC Meeting (Jul)", FED, "fed", d(7, 30)),
  ev(d(9, 15), "FOMC Meeting (Sep)", FED, "fed", d(9, 17)),
  ev(d(11, 4), "FOMC Meeting (Nov)", FED, "fed", d(11, 6)),
  ev(d(12, 8), "FOMC Meeting (Dec)", FED, "fed", d(12, 10)),
];

// ── FOMC Minutes (~3 weeks after each meeting) ─────────────────────────────
const fomcMinutes = [
  d(2, 18), d(4, 8), d(5, 27), d(7, 8),
  d(8, 19), d(10, 7), d(11, 25),
].map((s) => ev(s, "FOMC Minutes", FED, "fed-minutes"));

// ── Central Bank Events ────────────────────────────────────────────────────
const centralBankEvents = [
  ev(d(1, 21), "BOJ Policy Meeting", FED, "cb", d(1, 23)),
  ev(d(3, 5), "ECB Rate Decision", FED, "cb"),
  ev(d(4, 16), "ECB Rate Decision", FED, "cb"),
  ev(d(6, 4), "ECB Rate Decision", FED, "cb"),
  ev(d(7, 23), "ECB Rate Decision", FED, "cb"),
  ev(d(9, 10), "ECB Rate Decision", FED, "cb"),
  ev(d(10, 29), "ECB Rate Decision", FED, "cb"),
  ev(d(12, 17), "ECB Rate Decision", FED, "cb"),
  ev(d(8, 20), "Jackson Hole Symposium", FED, "cb", d(8, 23)),
  ev(d(3, 3), "OPEC+ Meeting", FED, "cb", d(3, 5)),
  ev(d(6, 2), "OPEC+ Meeting", FED, "cb", d(6, 4)),
  ev(d(11, 28), "OPEC+ Meeting", FED, "cb", d(11, 30)),
];

// ── CPI Releases (monthly, ~mid-month, estimated) ─────────────────────────
const cpiReleases = [
  d(1, 14), d(2, 12), d(3, 12), d(4, 14),
  d(5, 13), d(6, 11), d(7, 15), d(8, 12),
  d(9, 11), d(10, 14), d(11, 13), d(12, 11),
].map((s) => ev(s, "CPI Release", ECON, "cpi"));

// ── PPI Releases ───────────────────────────────────────────────────────────
const ppiReleases = [
  d(1, 15), d(2, 13), d(3, 13), d(4, 15),
  d(5, 14), d(6, 12), d(7, 16), d(8, 13),
  d(9, 12), d(10, 15), d(11, 14), d(12, 12),
].map((s) => ev(s, "PPI Release", ECON, "ppi"));

// ── Non-Farm Payrolls (first Friday each month) ────────────────────────────
const nfpReleases = (() => {
  const dates: string[] = [];
  for (let m = 0; m < 12; m++) {
    const dt = new Date(2026, m, 1);
    while (dt.getDay() !== 5) dt.setDate(dt.getDate() + 1);
    const mm = String(m + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    dates.push(`${Y}-${mm}-${dd}`);
  }
  return dates.map((s) => ev(s, "Non-Farm Payrolls", ECON, "nfp"));
})();

// ── ISM Manufacturing PMI (1st business day) ──────────────────────────────
const ismMfg = [
  d(1, 2), d(2, 2), d(3, 2), d(4, 1),
  d(5, 1), d(6, 1), d(7, 1), d(8, 3),
  d(9, 1), d(10, 1), d(11, 2), d(12, 1),
].map((s) => ev(s, "ISM Manufacturing PMI", ECON, "ism"));

// ── ISM Services PMI (3rd business day) ───────────────────────────────────
const ismSvc = [
  d(1, 6), d(2, 4), d(3, 4), d(4, 3),
  d(5, 5), d(6, 3), d(7, 3), d(8, 5),
  d(9, 3), d(10, 5), d(11, 4), d(12, 3),
].map((s) => ev(s, "ISM Services PMI", ECON, "ism"));

// ── GDP Releases (quarterly, advance/second/final) ────────────────────────
const gdpReleases = [
  ev(d(1, 29), "GDP Q4-2025 (Advance)", ECON, "gdp"),
  ev(d(2, 26), "GDP Q4-2025 (Second)", ECON, "gdp"),
  ev(d(3, 26), "GDP Q4-2025 (Final)", ECON, "gdp"),
  ev(d(4, 29), "GDP Q1-2026 (Advance)", ECON, "gdp"),
  ev(d(5, 28), "GDP Q1-2026 (Second)", ECON, "gdp"),
  ev(d(6, 25), "GDP Q1-2026 (Final)", ECON, "gdp"),
  ev(d(7, 29), "GDP Q2-2026 (Advance)", ECON, "gdp"),
  ev(d(8, 27), "GDP Q2-2026 (Second)", ECON, "gdp"),
  ev(d(9, 24), "GDP Q2-2026 (Final)", ECON, "gdp"),
  ev(d(10, 28), "GDP Q3-2026 (Advance)", ECON, "gdp"),
  ev(d(11, 25), "GDP Q3-2026 (Second)", ECON, "gdp"),
  ev(d(12, 22), "GDP Q3-2026 (Final)", ECON, "gdp"),
];

// ── Retail Sales ──────────────────────────────────────────────────────────
const retailSales = [
  d(1, 16), d(2, 13), d(3, 17), d(4, 15),
  d(5, 14), d(6, 16), d(7, 16), d(8, 14),
  d(9, 15), d(10, 15), d(11, 16), d(12, 15),
].map((s) => ev(s, "Retail Sales", ECON, "retail"));

// ── Consumer Confidence ───────────────────────────────────────────────────
const confidence = [
  d(1, 27), d(2, 24), d(3, 31), d(4, 28),
  d(5, 26), d(6, 30), d(7, 28), d(8, 25),
  d(9, 29), d(10, 27), d(11, 24), d(12, 22),
].map((s) => ev(s, "Consumer Confidence", ECON, "conf"));

// ── US Market Holidays (NYSE 2026) ────────────────────────────────────────
const marketHolidays = [
  ev(d(1, 1), "New Year's Day", HOL, "holiday"),
  ev(d(1, 19), "MLK Jr. Day", HOL, "holiday"),
  ev(d(2, 16), "Presidents' Day", HOL, "holiday"),
  ev(d(4, 3), "Good Friday", HOL, "holiday"),
  ev(d(5, 25), "Memorial Day", HOL, "holiday"),
  ev(d(6, 19), "Juneteenth", HOL, "holiday"),
  ev(d(7, 3), "Independence Day (observed)", HOL, "holiday"),
  ev(d(9, 7), "Labor Day", HOL, "holiday"),
  ev(d(11, 26), "Thanksgiving", HOL, "holiday"),
  ev(d(12, 25), "Christmas Day", HOL, "holiday"),
];

// ── Early Close ───────────────────────────────────────────────────────────
const earlyClose = [
  ev(d(7, 2), "Early Close (Jul 4 Eve)", HOL, "early-close"),
  ev(d(11, 27), "Early Close (Black Friday)", HOL, "early-close"),
  ev(d(12, 24), "Early Close (Christmas Eve)", HOL, "early-close"),
  ev(d(12, 31), "Early Close (New Year's Eve)", HOL, "early-close"),
];

// ── Combine & Export ───────────────────────────────────────────────────────
export const demoEvents = [
  ...fomcMeetings,
  ...fomcMinutes,
  ...centralBankEvents,
  ...cpiReleases,
  ...ppiReleases,
  ...nfpReleases,
  ...ismMfg,
  ...ismSvc,
  ...gdpReleases,
  ...retailSales,
  ...confidence,
  ...marketHolidays,
  ...earlyClose,
];
