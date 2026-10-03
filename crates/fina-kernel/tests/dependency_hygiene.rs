//! Machine-enforced layering rule: `fina-kernel` must have no transport,
//! UI, async-runtime or framework dependencies.
//!
//! FEATURES.md §4 makes this a hard constraint (invariant I-8).
//! Documenting it is not enough — a stray `rand` or `tokio` in `Cargo.toml` would
//! let domain code reach for the network, block a thread, or smuggle transport
//! concerns into the kernel, and every adapter would then diverge. So this is a
//! test rather than a code-review convention.
//!
//! It parses the crate's own manifest at compile time via `CARGO_MANIFEST_DIR`,
//! so it has no filesystem or YAML dependency of its own and runs as part of
//! `cargo test -p fina-kernel`.

use std::collections::BTreeSet;

/// The complete allowlist of `fina-kernel` dependencies.
///
/// Adding an entry here is a **deliberate act that requires updating
/// FEATURES.md §4** and reviewing the rationale. The test
/// `allowlist_matches_the_prompt` cross-checks this list against the document so
/// the two cannot drift apart silently.
const ALLOWED: &[&str] = &["serde", "serde_json", "thiserror"];

/// Substrings that must never appear in a dependency name. Belt-and-braces on
/// top of the allowlist: even if someone adds a crate to [`ALLOWED`] by mistake,
/// these catch the obvious transports.
const FORBIDDEN_SUBSTRINGS: &[&str] = &[
    "tauri",
    "actix",
    "axum",
    "rocket",
    "warp",
    "hyper",
    "tokio",
    "async",
    "clap",
    "structopt",
    "reqwest",
    "ureq",
    "rand",
    "chrono",
    "time-",
    "wasm",
    "diesel",
    "sqlx",
    "sea-orm",
    "redis",
    "postgres",
];

/// Returns the crate's own `Cargo.toml` path.
fn manifest_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")
}

/// Minimal dependency-name extraction from a `Cargo.toml`.
///
/// This is intentionally a tiny scanner, not a TOML parser: `fina-kernel` has no
/// TOML dependency (adding one would violate its own allowlist), and the manifest
/// shape is fixed and tiny. It reads the `[dependencies]` and `[dev-dependencies]`
/// section headers and collects the `key = ` at the start of each following line.
fn dependency_names(manifest: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut in_deps = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_deps = line == "[dependencies]" || line == "[dev-dependencies]";
            continue;
        }
        if !in_deps || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, _)) = line.split_once('=') {
            let key = key.trim();
            // Skip inline tables such as `{ workspace = true }` — those still
            // carry a real name, so keep them. Skip nothing else.
            if !key.is_empty() {
                names.insert(key.to_string());
            }
        }
    }
    names
}

#[test]
fn kernel_dependencies_are_within_the_allowlist() {
    let manifest = std::fs::read_to_string(manifest_path()).expect("kernel Cargo.toml is readable");
    let deps = dependency_names(&manifest);

    assert!(
        !deps.is_empty(),
        "dependency scanner found nothing — the manifest format changed and this \
         test is now vacuous. Fix `dependency_names` before trusting a pass."
    );

    let mut violations = Vec::new();
    for dep in &deps {
        let allowed = ALLOWED.contains(&dep.as_str());
        let forbidden = FORBIDDEN_SUBSTRINGS
            .iter()
            .find(|s| dep.contains(**s))
            .copied();
        match (allowed, forbidden) {
            (true, Some(sub)) => violations.push(format!(
                "{dep} is on the allowlist but contains the forbidden substring `{sub}`"
            )),
            (true, None) => {}
            (false, Some(sub)) => {
                violations.push(format!("{dep} contains the forbidden substring `{sub}`"));
            }
            (false, None) => violations.push(format!(
                "{dep} is not on the allowlist {ALLOWED:?}; every kernel dependency \
                 needs a documented reason"
            )),
        }
    }

    assert!(
        violations.is_empty(),
        "fina-kernel dependency allowlist violated (FEATURES.md section 4):\n  - {}",
        violations.join("\n  - ")
    );
}

#[test]
fn allowlist_matches_the_spec() {
    // Guards against the test drifting from its own documentation: if someone
    // adds `chrono` to ALLOWED but forgets FEATURES.md §4, this fails.
    //
    // Anchored on the full heading text, not just `## 4.`: FEATURES.md is now two
    // documents in one file (Part I inventory, Part II spec), so a bare number
    // could match a Part I heading added later.
    let doc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../FEATURES.md");
    let text = std::fs::read_to_string(&doc).expect("FEATURES.md is readable");

    let section_start = text
        .find("## 4. Target architecture")
        .expect("FEATURES.md Part II has a '## 4. Target architecture' section");
    let section_end = text[section_start..]
        .find("\n## 5.")
        .map(|i| section_start + i)
        .unwrap_or(text.len());
    let section = &text[section_start..section_end];

    for dep in ALLOWED {
        assert!(
            section.contains(dep),
            "dependency `{dep}` is in the test allowlist but FEATURES.md \
             Part II §4 does not mention it. Update the document or remove the dep."
        );
    }
}

#[test]
fn manifest_has_no_workspace_only_traps() {
    // `fina-kernel` must inherit its metadata from the workspace so the crate can
    // be lifted into a standalone git submodule without edits.
    let manifest = std::fs::read_to_string(manifest_path()).unwrap();
    for field in [
        "version.workspace",
        "edition.workspace",
        "rust-version.workspace",
        "license.workspace",
    ] {
        assert!(
            manifest.contains(field),
            "Cargo.toml must set `{field} = true` so the crate is relocatable"
        );
    }
}

#[test]
fn unsafe_is_forbidden_at_crate_level() {
    let lib = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
    )
    .unwrap();
    assert!(
        lib.contains("#![forbid(unsafe_code)]"),
        "lib.rs must keep `#![forbid(unsafe_code)]`"
    );
}

#[test]
fn golden_fixture_is_committed_and_non_trivial() {
    // The whole crate exists to satisfy this file. If it goes missing or gets
    // truncated to a stub, parity is silently unverified.
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden.json");
    let meta = std::fs::metadata(&fixture).expect("golden.json must be committed");
    assert!(
        meta.len() > 1_000_000,
        "golden.json is only {} bytes; the real capture is ~3.1 MB",
        meta.len()
    );
}

#[test]
fn golden_fixture_has_every_section_every_phase_depends_on() {
    // Not a re-implementation check — just that the fixture is parseable JSON
    // with the sections every later phase depends on. Regenerating requires
    // Node; FEATURES.md section 6 runs the generator in CI.
    //
    // The paths and branch statistics live under `simulationBundle`, matching the
    // shape of `SimulationBundle` in `fina_kernel::types`.
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden.json");
    let text = std::fs::read_to_string(&fixture).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).expect("golden.json is valid JSON");

    for key in [
        "meta",
        "simulationBundle",
        "mc",
        "trade",
        "risk",
        "cashflow",
        "valuation",
    ] {
        assert!(
            v.get(key).is_some(),
            "golden.json is missing the `{key}` section"
        );
    }

    // `meta` records how the baseline was captured, so a stale fixture is
    // recognisable rather than silently trusted.
    assert_eq!(v["meta"]["sourceSeed"], 42);
    assert!(
        v["meta"]["generatedBy"]
            .as_str()
            .is_some_and(|s| s.contains("generate-golden-fixture")),
        "golden.json must name the script that produced it"
    );

    let bundle = &v["simulationBundle"];
    for key in [
        "productName",
        "tagline",
        "underlyings",
        "barriers",
        "paths",
        "branchStats",
        "distributions",
    ] {
        assert!(
            bundle.get(key).is_some(),
            "simulationBundle is missing `{key}`"
        );
    }

    let paths = bundle["paths"].as_array().expect("paths is an array");
    assert_eq!(paths.len(), 100, "the demo sample is 100 paths");
    assert_eq!(bundle["branchStats"]["totalPaths"], 100_000);

    // `branchStats` has EXACTLY these seven keys. An earlier draft of
    // `types.rs` invented `samplePathCount` and `scaled`; asserting the exact key
    // set here stops that class of parity break from recurring silently.
    let bs = bundle["branchStats"]
        .as_object()
        .expect("branchStats is an object");
    let mut keys: Vec<&str> = bs.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "alive",
            "cashSettlement",
            "knockIn",
            "koTriggered",
            "noKnockIn",
            "physicalDelivery",
            "totalPaths"
        ],
        "branchStats key set drifted from the TypeScript original"
    );
    // The partition identities hold on the real fixture.
    assert_eq!(
        bs["noKnockIn"].as_u64().unwrap() + bs["knockIn"].as_u64().unwrap(),
        bs["alive"].as_u64().unwrap()
    );
    assert_eq!(
        bs["cashSettlement"].as_u64().unwrap() + bs["physicalDelivery"].as_u64().unwrap(),
        bs["knockIn"].as_u64().unwrap()
    );
    assert_eq!(
        bs["koTriggered"].as_u64().unwrap() + bs["alive"].as_u64().unwrap(),
        bs["totalPaths"].as_u64().unwrap()
    );

    // Every path carries the fields `SimulationPath` mirrors. If this drifts, the
    // parity test in Phase 2 will fail with a confusing shape error instead of a
    // clear "the fixture changed" message.
    for (i, p) in paths.iter().enumerate() {
        for key in [
            "id",
            "pathIndex",
            "dates",
            "observations",
            "worstOfPerformance",
            "knockInTriggered",
            "knockedOut",
            "knockOutDateIndex",
            "payoff",
            "redemptionValue",
            "couponValue",
            "putValue",
            "memoryCouponValue",
            "settlementType",
            "traversal",
            "attribution",
            "nodeDetails",
        ] {
            assert!(
                p.get(key).is_some(),
                "golden.json paths[{i}] is missing `{key}`; the fixture was regenerated \
                 against a different domain shape"
            );
        }
        assert_eq!(p["observations"].as_array().unwrap().len(), 60);
        assert_eq!(p["dates"].as_array().unwrap().len(), 60);
        assert_eq!(p["dates"][0], "2024-01-15");
        assert_eq!(p["dates"][59], "2028-12-15");
    }

    // The six attribution components, in the order `PathAttribution::compute_total`
    // sums them.
    for key in [
        "parRedemption",
        "coupon",
        "memoryCoupon",
        "downAndInPut",
        "funding",
        "discounting",
        "totalPv",
    ] {
        assert!(
            paths[0]["attribution"].get(key).is_some(),
            "attribution is missing `{key}`"
        );
    }
}
