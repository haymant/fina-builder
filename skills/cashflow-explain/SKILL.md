---
name: cashflow-explain
description: Break down the riga-flow PV legs and coupon timeline from explain_pv_attribution / price_put evidence.
---

# Cashflow / leg explain

Explain how the priced value decomposes into its cashflow legs, using riga-flow
evidence. Do not sum anything yourself — read the legs.

## Tools

- `explain_pv_attribution` → `legs` (`par_redemption`, `coupon`, `memory_coupon`,
  `down_and_in_put`, `funding`, `discounting`, `total`), `ledger[]`, `stats[]`,
  `ki_probability`, `determinism`.
- `price_put` → the same `result.legs` plus `result.ledger` and `result.stats`.
- `get_branch_stats` → per-transition `mean_payoff` and `probability` (the coupon /
  put / funding accrual), which the **Statistics** tile shows.

## How to present

1. Name each leg with its value and sign; the **Attribution** view is this six-leg
   decomposition.
2. `total` must reconcile the legs — quote the engine's `total`, and if it does not
   equal the sum, say the decomposition is partial rather than "fixing" it.
   (Coupon legs are reported on a legacy ×10 quote scale.)
3. Cross-reference the Explain Ledger (`get_ledger`) for *which transition* paid
   each leg, and `get_market` for the discounting assumption.

## Caution

- The dashboard's demo Cashflow/P&L tiles come from the **fina-kernel demo**, not
  riga-flow. When the user means those, say they are synthetic demonstrator data;
  when they mean the priced trade, use the riga-flow legs above.
