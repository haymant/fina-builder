//! fina-server library: the routes and handlers, factored out of `main` so the
//! integration tests drive the exact wiring the binary serves.
//!
//! Still a thin transport shim: no formulas, no domain defaults, no branching
//! on domain values — every command is one call into
//! [`fina_kernel::dispatch`].

use actix_cors::Cors;
use actix_web::http::StatusCode;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use fina_kernel::api::CommandId;
use fina_kernel::progress::ProgressEvent;
use fina_kernel::{FinaError, WireError};

/// The §8.2 error-to-status mapping, mirrored from `error.rs`'s code table.
#[must_use]
pub fn http_status(e: &FinaError) -> StatusCode {
    match e.code() {
        "PATH_OUT_OF_RANGE" => StatusCode::NOT_FOUND,
        "GENERATION" => StatusCode::INTERNAL_SERVER_ERROR,
        // INVALID_BARRIERS, INVALID_MARKET, INVALID_REQUEST, UNKNOWN_NODE
        _ => StatusCode::BAD_REQUEST,
    }
}

/// The wire error body with the mapped status.
#[must_use]
pub fn error_response(e: &FinaError) -> HttpResponse {
    HttpResponse::build(http_status(e)).json(WireError::from(e))
}

/// `POST /api/cmd/{command}`: the single dispatcher.
pub async fn cmd(req: HttpRequest, body: web::Bytes) -> HttpResponse {
    let Some(command) = req.match_info().get("command") else {
        return error_response(&FinaError::InvalidRequest("missing command".to_string()));
    };
    match fina_kernel::api::dispatch(command, &body, &mut |_| {}) {
        Ok(bytes) => HttpResponse::Ok()
            .content_type("application/json")
            .body(bytes),
        Err(e) => error_response(&e),
    }
}

/// `GET /health` and `GET /api/version`.
pub async fn health() -> impl Responder {
    let out = fina_kernel::api::dispatch_sync("health", b"{}").expect("health never fails");
    HttpResponse::Ok()
        .content_type("application/json")
        .body(out)
}

/// `POST /api/stream/{command}`: SSE progress + final result frame.
pub async fn stream_cmd(req: HttpRequest, body: web::Bytes) -> HttpResponse {
    use actix_web::rt;
    use futures_util::stream;

    let Some(command) = req.match_info().get("command") else {
        return error_response(&FinaError::InvalidRequest("missing command".to_string()));
    };
    let command = command.to_string();
    let body = body.to_vec();

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let tx_progress = tx.clone();

    rt::spawn(async move {
        let result = rt::task::spawn_blocking(move || {
            fina_kernel::api::dispatch(&command, &body, &mut |e: ProgressEvent| {
                let frame = format!(
                    "data: {}\n\n",
                    serde_json::to_string(&e).unwrap_or_default()
                );
                let _ = tx_progress.send(frame);
            })
        })
        .await;

        let final_frame = match result {
            Ok(Ok(bytes)) => format!("data: {}\n\n", String::from_utf8_lossy(&bytes)),
            Ok(Err(e)) => format!(
                "data: {}\n\n",
                serde_json::to_string(&WireError::from(&e)).unwrap_or_default()
            ),
            Err(join) => format!(
                "data: {}\n\n",
                serde_json::to_string(&WireError::from(FinaError::Generation(join.to_string())))
                    .unwrap_or_default()
            ),
        };
        let _ = tx.send(final_frame);
    });

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .streaming(stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|frame| (Ok::<_, actix_web::Error>(web::Bytes::from(frame)), rx))
        }))
}

/// CORS for the Vite dev origin; permissive for a local tool.
pub fn cors() -> Cors {
    Cors::permissive()
}

/// The routes, factored out so the binary and the integration tests serve the
/// same configuration.
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("")
            .route("/health", web::get().to(health))
            .route("/api/version", web::get().to(health))
            .route("/api/cmd/{command}", web::post().to(cmd))
            .route("/api/stream/{command}", web::post().to(stream_cmd)),
    );
}

/// The fully configured App, in one macro (the App type is unnameable in the
/// 4.9 API, so a function return type does not work).
#[macro_export]
macro_rules! make_app {
    () => {
        actix_web::App::new()
            .wrap($crate::cors())
            .configure($crate::configure)
    };
}

/// The command surface, for logging.
#[must_use]
pub fn command_count() -> usize {
    CommandId::ALL.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test;

    #[actix_web::test]
    async fn health_returns_version() {
        let app = test::init_service(crate::make_app!()).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        let v: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(v["version"], "0.1.0");
    }

    #[actix_web::test]
    async fn cmd_dispatches_compute_risk() {
        let app = test::init_service(crate::make_app!()).await;
        let body = serde_json::json!({
            "trade": serde_json::json!(fina_kernel::TradeEconomics::default()),
            "market": serde_json::json!(fina_kernel::MarketSnapshot::demo()),
        });
        let req = test::TestRequest::post()
            .uri("/api/cmd/compute_risk")
            .set_json(&body)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["pv"], 154.03);
    }

    #[actix_web::test]
    async fn path_out_of_range_is_404_with_wire_shape() {
        let app = test::init_service(crate::make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/get_path")
            .set_json(serde_json::json!({ "pathIndex": 500 }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["code"], "PATH_OUT_OF_RANGE");
    }

    #[actix_web::test]
    async fn malformed_body_is_400() {
        let app = test::init_service(crate::make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/compute_risk")
            .set_payload("not json")
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["code"], "INVALID_REQUEST");
    }

    #[actix_web::test]
    async fn unknown_command_is_400() {
        let app = test::init_service(crate::make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/nope")
            .set_payload("{}")
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["code"], "INVALID_REQUEST");
    }

    #[actix_web::test]
    async fn stream_emits_progress_then_result() {
        let app = test::init_service(crate::make_app!()).await;
        let body = serde_json::json!({
            "config": serde_json::json!(fina_kernel::path_generator::SimulationConfig::demo()),
        });
        let req = test::TestRequest::post()
            .uri("/api/stream/generate_paths")
            .set_json(&body)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        let buf = test::read_body(resp).await;
        let text = String::from_utf8_lossy(&buf);
        let frames: Vec<&str> = text
            .split('\n')
            .filter(|l| l.starts_with("data: "))
            .collect();
        assert!(frames.len() >= 2, "progress + final frame");
        for frame in frames.iter().take(frames.len() - 1) {
            let e: ProgressEvent =
                serde_json::from_str(frame.strip_prefix("data: ").unwrap().trim()).unwrap();
            assert!(e.completed <= e.total);
        }
        let last = frames.last().unwrap();
        let bundle: serde_json::Value =
            serde_json::from_str(last.strip_prefix("data: ").unwrap().trim()).unwrap();
        assert_eq!(bundle["paths"].as_array().unwrap().len(), 100);
    }
}
