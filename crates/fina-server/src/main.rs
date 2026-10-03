//! HTTP/REST adapter over [`fina_kernel`].
//!
//! This crate is a **thin transport shim** and nothing else: it deserialises a
//! request body, calls [`fina_kernel::dispatch`] (which owns all command
//! routing), and serialises the result. No formulas, no domain defaults, no
//! branching on domain values — otherwise the CLI and Tauri adapters silently
//! diverge from the web transport (invariant I-3).
//!
//! Routes:
//!
//! - `GET /health` — liveness + version.
//! - `GET /api/version` — the kernel version.
//! - `POST /api/cmd/{command}` — one JSON request, one JSON response, or the
//!   [`fina_kernel::WireError`] shape with the §8.2 HTTP status.
//! - `POST /api/stream/{command}` — `text/event-stream`; one `data:` frame per
//!   [`fina_kernel::progress::ProgressEvent`], ending with a final frame
//!   carrying the response JSON.

use actix_cors::Cors;
use actix_web::http::StatusCode;
use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use fina_kernel::api::{dispatch, CommandId};
use fina_kernel::progress::ProgressEvent;
use fina_kernel::{FinaError, WireError};

/// The §8.2 error-to-status mapping, mirrored from `error.rs`'s code table.
fn http_status(e: &FinaError) -> StatusCode {
    match e.code() {
        "PATH_OUT_OF_RANGE" => StatusCode::NOT_FOUND,
        "GENERATION" => StatusCode::INTERNAL_SERVER_ERROR,
        // INVALID_BARRIERS, INVALID_MARKET, INVALID_REQUEST, UNKNOWN_NODE
        _ => StatusCode::BAD_REQUEST,
    }
}

fn error_response(e: &FinaError) -> HttpResponse {
    HttpResponse::build(http_status(e)).json(WireError::from(e))
}

/// `POST /api/cmd/{command}`: the single dispatcher.
async fn cmd(req: HttpRequest, body: web::Bytes) -> HttpResponse {
    let Some(command) = req.match_info().get("command") else {
        return error_response(&FinaError::InvalidRequest("missing command".to_string()));
    };
    match dispatch(command, &body, &mut |_| {}) {
        Ok(bytes) => HttpResponse::Ok()
            .content_type("application/json")
            .body(bytes),
        Err(e) => error_response(&e),
    }
}

/// `GET /health` and `GET /api/version`.
async fn health() -> impl Responder {
    let out = fina_kernel::api::dispatch_sync("health", b"{}").expect("health never fails");
    HttpResponse::Ok()
        .content_type("application/json")
        .body(out)
}

/// `POST /api/stream/{command}`: SSE progress + final result frame.
///
/// The kernel's progress callback is bridged one frame per [`ProgressEvent`];
/// the final frame carries the command's response (or the wire error). No
/// business logic lives here — the handler only translates callback → frame.
async fn stream_cmd(req: HttpRequest, body: web::Bytes) -> HttpResponse {
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
            dispatch(&command, &body, &mut |e: ProgressEvent| {
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

fn cors() -> Cors {
    // Local tooling: allow the Vite dev origin and any other local caller.
    Cors::permissive()
}

/// The routes, factored out so the integration tests drive the same wiring as
/// the binary.
fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("")
            .route("/health", web::get().to(health))
            .route("/api/version", web::get().to(health))
            .route("/api/cmd/{command}", web::post().to(cmd))
            .route("/api/stream/{command}", web::post().to(stream_cmd)),
    );
}

/// The App, configured and CORS-wrapped, in one place. A macro rather than a
/// function because actix's `App` service types are unnameable concrete types
/// and `impl Trait` return positions do not match `ServiceFactory`'s bounds in
/// the 4.9 API.
macro_rules! make_app {
    () => {
        App::new().wrap(cors()).configure(configure)
    };
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();

    // `--host` / `--port`, defaults 127.0.0.1 / 8787.
    let mut host = "127.0.0.1".to_string();
    let mut port = 8787u16;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => {
                host = args.next().expect("--host needs a value");
            }
            "--port" => {
                port = args
                    .next()
                    .expect("--port needs a value")
                    .parse()
                    .expect("--port must be a number");
            }
            other => {
                eprintln!("fina-server: unknown argument `{other}` (use --host / --port)");
                std::process::exit(1);
            }
        }
    }

    log::info!(
        "fina-server {} on http://{host}:{port} ({} commands)",
        fina_kernel::VERSION,
        CommandId::ALL.len()
    );
    HttpServer::new(|| make_app!())
        .bind((host.as_str(), port))?
        .run()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test;

    #[actix_web::test]
    async fn health_returns_version() {
        let app = test::init_service(make_app!()).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        let body = test::read_body(resp).await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["version"], "0.1.0");
        assert_eq!(v["coreVersion"], "0.1.0");
    }

    #[actix_web::test]
    async fn cmd_dispatches_compute_risk() {
        let app = test::init_service(make_app!()).await;
        let body = serde_json::json!({
            "trade": serde_json::json!(fina_kernel::TradeEconomics::default()),
            "market": serde_json::json!(fina_kernel::MarketSnapshot::demo()),
        });
        let req = test::TestRequest::post()
            .uri("/api/cmd/compute_risk")
            .set_json(&body)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success(), "{resp:?}");
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["pv"], 154.03);
        assert_eq!(json["delta"], 80.0);
    }

    /// §8.2 status mapping: out-of-range path → 404 with the wire error shape.
    #[actix_web::test]
    async fn path_out_of_range_is_404_with_wire_shape() {
        let app = test::init_service(make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/get_path")
            .set_json(serde_json::json!({ "pathIndex": 500 }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["code"], "PATH_OUT_OF_RANGE");
        assert_eq!(
            json["message"],
            "path index 500 out of range (bundle has 100)"
        );
    }

    /// A malformed body is 400, not 500, on every command.
    #[actix_web::test]
    async fn malformed_body_is_400() {
        let app = test::init_service(make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/compute_risk")
            .set_payload("not json")
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["code"], "INVALID_REQUEST");
    }

    /// Unknown commands are 400 with INVALID_REQUEST.
    #[actix_web::test]
    async fn unknown_command_is_400() {
        let app = test::init_service(make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/nope")
            .set_payload("{}")
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let json: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(json["code"], "INVALID_REQUEST");
    }

    /// CLI and HTTP must produce identical bytes for the same command/body
    /// (I-3), which holds by construction here — both call `dispatch`. Spot
    /// check that the HTTP body for `get_path` equals dispatch's own output.
    #[actix_web::test]
    async fn http_bytes_are_dispatch_bytes() {
        let app = test::init_service(make_app!()).await;
        let req = test::TestRequest::post()
            .uri("/api/cmd/get_path")
            .set_json(serde_json::json!({ "pathIndex": 1 }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        let body = test::read_body(resp).await;
        let expected = fina_kernel::api::dispatch_sync("get_path", br#"{"pathIndex":1}"#).unwrap();
        assert_eq!(
            body.to_vec(),
            expected,
            "HTTP must not reshape the response"
        );
    }

    /// The SSE stream emits progress frames and a final result frame.
    #[actix_web::test]
    async fn stream_emits_progress_then_result() {
        let app = test::init_service(make_app!()).await;
        let body = serde_json::json!({
            "config": serde_json::json!(fina_kernel::path_generator::SimulationConfig::demo()),
        });
        let req = test::TestRequest::post()
            .uri("/api/stream/generate_paths")
            .set_json(&body)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        assert_eq!(
            resp.headers()
                .get("content-type")
                .map(|v| v.to_str().unwrap()),
            Some("text/event-stream")
        );

        let buf = test::read_body(resp).await;
        let text = String::from_utf8_lossy(&buf);
        let frames: Vec<&str> = text
            .split('\n')
            .filter(|l| l.starts_with("data: "))
            .collect();
        assert!(
            frames.len() >= 2,
            "progress + final frame, got {}",
            frames.len()
        );

        // Every progress frame parses as a ProgressEvent; the final frame is the
        // bundle JSON.
        let last = frames.last().unwrap();
        let bundle: serde_json::Value =
            serde_json::from_str(last.strip_prefix("data: ").unwrap().trim()).unwrap();
        assert_eq!(bundle["paths"].as_array().unwrap().len(), 100);

        for frame in frames.iter().take(frames.len() - 1) {
            let e: fina_kernel::progress::ProgressEvent =
                serde_json::from_str(frame.strip_prefix("data: ").unwrap().trim()).unwrap();
            assert!(e.completed <= e.total);
        }
    }
}
