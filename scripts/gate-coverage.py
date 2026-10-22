#!/usr/bin/env python3
"""Enforces the FEATURES.md §6.1/§6.3 coverage gates on an
`lcov.info` produced by `cargo llvm-cov --workspace --lcov`.

Gates (line coverage):
  - payoff-explorer (src-tauri): >= 75% across the testable MCP runtime and command adapters

Tauri entry-point glue (`src/main.rs`, `src/lib.rs`) and the optional embedded
agent runtime (`src/riga_agent.rs`) are excluded: they are not the MCP adapters
this gate measures and require a webview/model runtime to exercise.

Usage: scripts/gate-coverage.py <lcov.info>
Exit 1 with a summary on any gate miss.
"""
import sys
from collections import defaultdict

MIN = {
    # Keep the existing threshold; apply it to the current MCP runtime and
    # command-adapter implementation rather than Tauri startup/agent glue.
    "payoff-explorer": 75.0,
}
# Crate directory prefixes (the tauri package lives in `src-tauri/`).
DIRS = {
    "payoff-explorer": "src-tauri/",
}
# Files excluded from a crate's denominator: Tauri setup/entry-point glue and
# the optional embedded agent runtime are outside this MCP adapter coverage gate.
EXCLUDE = {
    "src-tauri/src/main.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/riga_agent.rs",
}


def main() -> int:
    report = sys.argv[1] if len(sys.argv) > 1 else "lcov.info"
    crate_lf: dict[str, int] = defaultdict(int)
    crate_lh: dict[str, int] = defaultdict(int)
    crate: str | None = None
    current: list[str] = []  # SF / LF / LH records of the current SF block

    with open(report, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if line.startswith("SF:"):
                crate = None
                for key, prefix in DIRS.items():
                    if prefix in line:
                        crate = key
                        break
                current = [line]
            elif line.startswith(("LF:", "LH:")):
                current.append(line)
                if line.startswith("LH:"):
                    lf = int(next((x[3:] for x in current if x.startswith("LF:")), "0"))
                    lh = int(line[3:])
                    sf = next((x[3:] for x in current if x.startswith("SF:")), None)
                    if crate and sf and not any(frag in sf for frag in EXCLUDE):
                        crate_lf[crate] += lf
                        crate_lh[crate] += lh

    failures = []
    for crate, min_pct in MIN.items():
        lf = crate_lf[crate]
        lh = crate_lh[crate]
        pct = 100.0 * lh / lf if lf else 0.0
        if pct < min_pct:
            failures.append(f"{crate}: {lh}/{lf} lines = {pct:.1f}% < {min_pct:.0f}%")
        else:
            print(f"OK   {crate}: {lh}/{lf} lines = {pct:.1f}% (gate {min_pct:.0f}%)")

    if failures:
        print("\nCOVERAGE GATE FAILURES:")
        for f in failures:
            print(f"  {f}")
        return 1
    print("\nAll coverage gates met.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
