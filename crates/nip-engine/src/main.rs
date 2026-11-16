use std::process::ExitCode;

use nip_engine::{NipConfig, NipService};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("nip-engine: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "--health".to_owned());
    if !matches!(command.as_str(), "--health" | "--capabilities") {
        return Err("usage: nip-engine [--health|--capabilities]".to_owned());
    }

    let config = NipConfig::from_env().map_err(|_| "NIP configuration is invalid".to_owned())?;
    let service =
        NipService::open(config).map_err(|_| "NIP service initialization failed".to_owned())?;
    let response = if command == "--health" {
        serde_json::to_value(service.health())
            .map_err(|_| "health response serialization failed".to_owned())?
    } else {
        serde_json::to_value(service.capabilities())
            .map_err(|_| "capability response serialization failed".to_owned())?
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&response)
            .map_err(|_| "response serialization failed".to_owned())?
    );
    Ok(())
}
