# NIP financial retrieval benchmark

Generated: 2026-11-16T23:28:40.284Z

Corpus: 15 SEC filing excerpts from five issuers. Queries: 12. Metrics are averaged over queries at k=5.

| System | Recall@5 | Precision@5 | MRR | nDCG@5 |
|---|---:|---:|---:|---:|
| Qdrant hybrid dense + lexical | 100.0% | 25.0% | 0.806 | 0.855 |
| Token-overlap lexical baseline | 100.0% | 25.0% | 1.000 | 0.993 |

The Qdrant run used model identity `benchmark-financial-hash-v3` with 8 dimensions and a deterministic local embedding fixture. This is an integration and ranking-regression benchmark, not evidence of BGE-M3 quality; a production-quality model endpoint must be benchmarked separately before enabling quality claims.

## Per-query results

- **q01 — higher interest rates net interest income credit losses**
  - Relevant: jpm-rates-credit-2024
  - Hybrid top-5: jpm-rates-credit-2024, nvda-supply-chain-concentration-2025, xom-energy-transition-2024, msft-cloud-ai-investment-2024, xom-commodity-demand-2024
  - Lexical top-5: jpm-rates-credit-2024, jpm-risk-models-2024, jpm-capital-liquidity-2024, msft-cloud-ai-investment-2024, msft-cloud-margin-risk-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q02 — stress testing risk models capital liquidity regulatory scrutiny**
  - Relevant: jpm-risk-models-2024, jpm-capital-liquidity-2024
  - Hybrid top-5: jpm-risk-models-2024, jpm-capital-liquidity-2024, cat-construction-outlook-2024, nvda-demand-supply-2025, cat-supplier-components-2024
  - Lexical top-5: jpm-risk-models-2024, jpm-rates-credit-2024, jpm-capital-liquidity-2024, cat-supplier-components-2024, msft-cloud-ai-investment-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q03 — AI infrastructure cloud datacenters GPUs capital investment**
  - Relevant: msft-cloud-ai-investment-2024, msft-datacenter-supply-2024
  - Hybrid top-5: msft-datacenter-supply-2024, msft-cloud-ai-investment-2024, msft-cloud-margin-risk-2024, cat-supplier-components-2024, cat-construction-outlook-2024
  - Lexical top-5: msft-datacenter-supply-2024, msft-cloud-ai-investment-2024, msft-cloud-margin-risk-2024, cat-construction-outlook-2024, jpm-rates-credit-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q04 — cloud AI infrastructure costs reduce operating margins**
  - Relevant: msft-cloud-margin-risk-2024
  - Hybrid top-5: msft-cloud-margin-risk-2024, jpm-risk-models-2024, cat-construction-outlook-2024, msft-cloud-ai-investment-2024, msft-datacenter-supply-2024
  - Lexical top-5: msft-cloud-margin-risk-2024, msft-datacenter-supply-2024, jpm-rates-credit-2024, msft-cloud-ai-investment-2024, jpm-risk-models-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q05 — semiconductor manufacturing lead times supply capacity premiums**
  - Relevant: nvda-demand-supply-2025, nvda-supply-chain-concentration-2025
  - Hybrid top-5: nvda-demand-supply-2025, nvda-supply-chain-concentration-2025, xom-energy-transition-2024, xom-refining-margins-2024, cat-backlog-2024
  - Lexical top-5: nvda-demand-supply-2025, nvda-supply-chain-concentration-2025, nvda-inventory-mismatch-2025, xom-refining-margins-2024, xom-commodity-demand-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q06 — demand estimates customer orders excess inventory shortages**
  - Relevant: nvda-inventory-mismatch-2025
  - Hybrid top-5: nvda-inventory-mismatch-2025, jpm-capital-liquidity-2024, cat-construction-outlook-2024, cat-supplier-components-2024, nvda-demand-supply-2025
  - Lexical top-5: nvda-inventory-mismatch-2025, nvda-demand-supply-2025, msft-cloud-ai-investment-2024, msft-datacenter-supply-2024, xom-refining-margins-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q07 — refining margins capacity additions global demand oversupply**
  - Relevant: xom-refining-margins-2024
  - Hybrid top-5: msft-cloud-ai-investment-2024, xom-commodity-demand-2024, xom-refining-margins-2024, nvda-supply-chain-concentration-2025, cat-supplier-components-2024
  - Lexical top-5: xom-refining-margins-2024, xom-commodity-demand-2024, nvda-demand-supply-2025, msft-cloud-ai-investment-2024, msft-cloud-margin-risk-2024
  - Hybrid metrics: Recall 1.000, MRR 0.333, nDCG 0.500
- **q08 — energy demand recession economic growth commodity margins**
  - Relevant: xom-commodity-demand-2024
  - Hybrid top-5: xom-refining-margins-2024, xom-commodity-demand-2024, nvda-inventory-mismatch-2025, cat-supplier-components-2024, cat-backlog-2024
  - Lexical top-5: xom-commodity-demand-2024, msft-datacenter-supply-2024, xom-refining-margins-2024, msft-cloud-ai-investment-2024, msft-cloud-margin-risk-2024
  - Hybrid metrics: Recall 1.000, MRR 0.500, nDCG 0.631
- **q09 — firm order backlog billion construction industries energy transportation**
  - Relevant: cat-backlog-2024
  - Hybrid top-5: cat-backlog-2024, cat-construction-outlook-2024, jpm-capital-liquidity-2024, xom-energy-transition-2024, xom-commodity-demand-2024
  - Lexical top-5: cat-backlog-2024, jpm-capital-liquidity-2024, msft-datacenter-supply-2024, nvda-inventory-mismatch-2025, xom-commodity-demand-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q10 — dealer rental fleet construction demand infrastructure investment**
  - Relevant: cat-construction-outlook-2024
  - Hybrid top-5: nvda-inventory-mismatch-2025, msft-datacenter-supply-2024, cat-construction-outlook-2024, cat-supplier-components-2024, msft-cloud-ai-investment-2024
  - Lexical top-5: cat-construction-outlook-2024, msft-cloud-ai-investment-2024, msft-datacenter-supply-2024, msft-cloud-margin-risk-2024, nvda-demand-supply-2025
  - Hybrid metrics: Recall 1.000, MRR 0.333, nDCG 0.500
- **q11 — supplier financial viability production flexibility component constraints**
  - Relevant: cat-supplier-components-2024
  - Hybrid top-5: cat-supplier-components-2024, nvda-inventory-mismatch-2025, jpm-capital-liquidity-2024, msft-datacenter-supply-2024, nvda-demand-supply-2025
  - Lexical top-5: cat-supplier-components-2024, nvda-inventory-mismatch-2025, jpm-capital-liquidity-2024, jpm-rates-credit-2024, jpm-risk-models-2024
  - Hybrid metrics: Recall 1.000, MRR 1.000, nDCG 1.000
- **q12 — hydrogen carbon capture lithium supportive government policies commercial scale**
  - Relevant: xom-energy-transition-2024
  - Hybrid top-5: cat-construction-outlook-2024, xom-energy-transition-2024, xom-refining-margins-2024, cat-backlog-2024, msft-datacenter-supply-2024
  - Lexical top-5: xom-energy-transition-2024, msft-cloud-ai-investment-2024, cat-construction-outlook-2024, jpm-rates-credit-2024, jpm-risk-models-2024
  - Hybrid metrics: Recall 1.000, MRR 0.500, nDCG 0.631

## Sources

1. https://www.sec.gov/Archives/edgar/data/19617/000001961725000270/jpm-20241231.htm
2. https://www.sec.gov/Archives/edgar/data/789019/000095017024087843/msft-20240630.htm
3. https://www.sec.gov/Archives/edgar/data/1045810/000104581025000023/nvda-20250126.htm
4. https://www.sec.gov/Archives/edgar/data/34088/000003408825000010/xom-20241231.htm
5. https://www.sec.gov/Archives/edgar/data/18230/000001823025000008/cat-20241231.htm
