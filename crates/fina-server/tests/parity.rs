//! Cross-transport parity (PHASE1_MIGRATION_PROMPT.md §6.1, invariant I-3):
//! the HTTP endpoint must emit the exact JSON bytes `fina_kernel::api::dispatch`
//! produces, because the CLI and Tauri both call the same dispatch. Any adapter
//! that reshapes, rounds or defaults differently fails here.

use actix_web::test;
use fina_kernel::api::dispatch_sync;
use serde_json::Value;

async fn http_call(command: &str, body: &[u8]) -> Vec<u8> {
    let app = test::init_service(fina_server::make_app!()).await;
    let req = test::TestRequest::post()
        .uri(&format!("/api/cmd/{command}"))
        .set_payload(body.to_vec())
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert!(resp.status().is_success(), "{command}: {resp:?}");
    test::read_body(resp).await.to_vec()
}

fn demo_requests() -> Vec<(&'static str, Vec<u8>)> {
    let path = br#"{"pathIndex":1}"#.to_vec();
    vec![
        ("get_path", path),
        ("get_branch_stats", br#"{}"#.to_vec()),
        ("get_distributions", br#"{}"#.to_vec()),
        (
            "compute_trade_analytics",
            serde_json::to_vec(&fina_kernel::api::TradeRequest {
                trade: fina_kernel::TradeEconomics::default(),
            })
            .unwrap(),
        ),
        (
            "compute_risk",
            serde_json::to_vec(&fina_kernel::api::ComputeRiskRequest {
                trade: fina_kernel::TradeEconomics::default(),
                market: fina_kernel::MarketSnapshot::demo(),
            })
            .unwrap(),
        ),
        ("get_mc_diagnostics", br#"{}"#.to_vec()),
        (
            "build_cashflows",
            serde_json::to_vec(&fina_kernel::api::CashflowRequest {
                trade: fina_kernel::TradeEconomics::default(),
                path_index: 1,
            })
            .unwrap(),
        ),
        (
            "valuation_explain",
            serde_json::to_vec(&fina_kernel::api::ExplainRequest {
                trade: fina_kernel::TradeEconomics::default(),
                market: fina_kernel::MarketSnapshot::demo(),
                path_index: 1,
                as_of: "2026-01-15".to_string(),
            })
            .unwrap(),
        ),
        (
            "explain_ledger",
            serde_json::to_vec(&fina_kernel::api::ExplainRequest {
                trade: fina_kernel::TradeEconomics::default(),
                market: fina_kernel::MarketSnapshot::demo(),
                path_index: 1,
                as_of: "2026-01-15".to_string(),
            })
            .unwrap(),
        ),
        ("execution_events", br#"{"pathIndex":1}"#.to_vec()),
        ("health", br#"{}"#.to_vec()),
        (
            "generate_paths",
            serde_json::to_vec(&fina_kernel::api::GeneratePathsRequest {
                config: fina_kernel::path_generator::SimulationConfig::demo(),
            })
            .unwrap(),
        ),
    ]
}

/// Every command: HTTP bytes == dispatch bytes, byte for byte.
#[actix_web::test]
async fn every_command_http_bytes_equal_dispatch_bytes() {
    for (command, body) in demo_requests() {
        let http = http_call(command, &body).await;
        let core = dispatch_sync(command, &body).unwrap_or_else(|e| panic!("{command}: {e}"));
        assert_eq!(
            http, core,
            "HTTP must not reshape `{command}`; core and transport diverged"
        );
    }
}

/// And the parsed values are equal (belt: byte equality already implies it).
#[actix_web::test]
async fn every_command_http_value_equal_core_value() {
    for (command, body) in demo_requests() {
        let http = http_call(command, &body).await;
        let core = dispatch_sync(command, &body).unwrap();
        let h: Value = serde_json::from_slice(&http).unwrap();
        let c: Value = serde_json::from_slice(&core).unwrap();
        assert_eq!(h, c, "{command} values diverged");
    }
}

/// Error parity: the HTTP error body carries the same wire shape dispatch
/// reports, at the §8.2 status.
#[actix_web::test]
async fn error_bodies_match_dispatch() {
    let app = test::init_service(fina_server::make_app!()).await;
    let req = test::TestRequest::post()
        .uri("/api/cmd/get_path")
        .set_json(serde_json::json!({ "pathIndex": 500 }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);
    let body = test::read_body(resp).await;
    let core_err = dispatch_sync("get_path", br#"{"pathIndex":500}"#).unwrap_err();
    let core: Value = serde_json::from_slice(
        &serde_json::to_vec(&fina_kernel::WireError::from(&core_err)).unwrap(),
    )
    .unwrap();
    let http: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(http, core);
}
