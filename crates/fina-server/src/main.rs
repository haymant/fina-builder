//! fina-server binary: arguments, logging, and the HTTP server over the
//! `fina_server` library. No domain logic here.

use actix_web::{App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();

    // `--host` / `--port`, defaults 127.0.0.1 / 8787.
    let mut host = "127.0.0.1".to_string();
    let mut port = 8787u16;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => host = args.next().expect("--host needs a value"),
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
        fina_server::command_count()
    );
    HttpServer::new(|| {
        App::new()
            .wrap(fina_server::cors())
            .configure(fina_server::configure)
    })
    .bind((host.as_str(), port))?
    .run()
    .await
}
