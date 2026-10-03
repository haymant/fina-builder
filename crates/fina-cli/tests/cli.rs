//! Adapter test for `fina-cli`: spawn the real binary and assert the transport
//! contract (FEATURES.md §6.1) — stdout carries exactly one JSON
//! document, progress goes to stderr as NDJSON, errors exit non-zero with the
//! wire shape. No formulas are tested here; the kernel already owns those.

use std::process::Command;

/// Spawns the CLI for a subcommand and captures stdout/stderr/exit.
fn run(args: &[&str]) -> (String, String, i32) {
    let out = Command::new(env!("CARGO_BIN_EXE_fina-cli"))
        .args(args)
        .output()
        .expect("spawning fina-cli");
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code().unwrap_or(-1),
    )
}

#[test]
fn health_prints_valid_json_on_stdout_and_exits_zero() {
    let (stdout, stderr, code) = run(&["health"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("stdout is valid JSON");
    assert_eq!(v["version"], "0.1.0");
    assert_eq!(v["coreVersion"], "0.1.0");
    assert!(stderr.is_empty(), "health must not write progress");
}

#[test]
fn get_path_returns_the_requested_path_as_one_json_document() {
    let (stdout, stderr, code) = run(&["get-path", "--index", "1"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("stdout is valid JSON");
    assert_eq!(v["id"], "path-001");
    assert_eq!(v["pathIndex"], 1);
    assert_eq!(v["observations"].as_array().unwrap().len(), 60);
}

#[test]
fn out_of_range_path_exits_nonzero_with_wire_error_on_stderr() {
    let (stdout, stderr, code) = run(&["get-path", "--index", "500"]);
    assert_ne!(code, 0);
    assert!(stdout.trim().is_empty(), "errors must not pollute stdout");
    let v: serde_json::Value =
        serde_json::from_str(stderr.trim()).expect("stderr carries the wire error JSON");
    assert_eq!(v["code"], "PATH_OUT_OF_RANGE");
    assert_eq!(v["message"], "path index 500 out of range (bundle has 100)");
}

#[test]
fn generate_paths_streams_ndjson_progress_to_stderr_and_bundle_to_stdout() {
    let (stdout, stderr, code) = run(&["generate-paths", "--paths", "10"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let bundle: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout is the bundle JSON");
    assert_eq!(bundle["paths"].as_array().unwrap().len(), 10);

    // Each stderr line is a valid NDJSON ProgressEvent; completed is monotonic.
    let lines: Vec<&str> = stderr.lines().collect();
    assert!(
        !lines.is_empty(),
        "generate-paths must emit progress on stderr"
    );
    let events: Vec<fina_kernel::progress::ProgressEvent> = lines
        .iter()
        .map(|l| serde_json::from_str(l).expect("stderr line is a ProgressEvent"))
        .collect();
    assert!(
        events.windows(2).all(|w| w[0].completed <= w[1].completed),
        "progress completed must be monotonic"
    );
    assert_eq!(events.last().unwrap().total, 10);
}

#[test]
fn verbose_subcommands_follow_the_kebab_to_snake_mapping() {
    // `--out` writes pretty JSON to a file instead of stdout.
    let dir = std::env::temp_dir().join(format!("fina-cli-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out_path = dir.join("health.json");
    let (stdout, stderr, code) = run(&["health", "--out", out_path.to_str().unwrap()]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.trim().is_empty(), "--out must suppress stdout");
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out_path).unwrap()).unwrap();
    assert_eq!(v["version"], "0.1.0");

    // A malformed --trade file is a local error (non-zero exit, message on
    // stderr) — not a panic and not stdout pollution.
    let bad = dir.join("bad.json");
    std::fs::write(&bad, "not json").unwrap();
    let (stdout, stderr, code) = run(&[
        "compute-risk",
        "--trade",
        bad.to_str().unwrap(),
        "--market",
        bad.to_str().unwrap(),
    ]);
    assert_ne!(code, 0);
    assert!(stdout.trim().is_empty());
    assert!(!stderr.trim().is_empty());
}

/// Every subcommand with a valid fixture request returns exit 0 and a parseable
/// JSON document on stdout. This drives the CLI's command table (and its
/// main.rs) as CI would.
#[test]
fn every_subcommand_returns_two_hundred_and_json() {
    let dir = std::env::temp_dir().join(format!("fina-cli-table-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let trade = dir.join("trade.json");
    let market = dir.join("market.json");
    std::fs::write(
        &trade,
        serde_json::to_vec(&fina_kernel::TradeEconomics::default()).unwrap(),
    )
    .unwrap();
    std::fs::write(
        &market,
        serde_json::to_vec(&fina_kernel::MarketSnapshot::demo()).unwrap(),
    )
    .unwrap();

    let trade = trade.to_str().unwrap();
    let market = market.to_str().unwrap();

    let ok: &[&[&str]] = &[
        &["health"],
        &["generate-paths", "--paths", "5"],
        &["get-path", "--index", "1"],
        &["branch-stats"],
        &["distributions"],
        &["compute-trade-analytics", "--trade", trade],
        &["compute-risk", "--trade", trade, "--market", market],
        &["mc-diagnostics"],
        &["cashflows", "--path-index", "1", "--trade", trade],
        &[
            "explain",
            "--path-index",
            "1",
            "--trade",
            trade,
            "--market",
            market,
            "--as-of",
            "2026-01-15",
        ],
        &[
            "explain-ledger",
            "--path-index",
            "1",
            "--trade",
            trade,
            "--market",
            market,
            "--as-of",
            "2026-01-15",
        ],
        &["execution-events", "--index", "1"],
    ];
    for args in ok {
        let (stdout, stderr, code) = run(args);
        assert_eq!(code, 0, "{args:?} failed: {stderr}");
        let v: serde_json::Value = serde_json::from_str(stdout.trim())
            .unwrap_or_else(|e| panic!("{args:?} stdout not JSON: {e}"));
        assert!(!v.is_null(), "{args:?} returned null");
    }
}
