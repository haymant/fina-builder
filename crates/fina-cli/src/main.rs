//! Command-line adapter over [`fina_kernel`].
//!
//! **stdout carries only the JSON result** so it stays pipeable into `jq`.
//! Progress (NDJSON) and errors go to stderr. Non-zero exit on error, with the
//! wire error shape (`{"code": ..., "message": ...}`) on stderr.
//!
//! Every subcommand is a pure pass-through to [`fina_kernel::dispatch`], which
//! owns the command table: this binary contributes no mapping of its own, so
//! its names and responses cannot drift from the HTTP and Tauri transports
//! (invariant I-3).

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use fina_kernel::api::{dispatch, CommandId};
use fina_kernel::progress::ProgressEvent;
use fina_kernel::WireError;

/// The fina-builder headless CLI.
#[derive(Debug, Parser)]
#[command(
    name = "fina-cli",
    version,
    about = "Headless fina-builder over fina-kernel"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Generate the full simulation bundle.
    GeneratePaths {
        /// PRNG seed.
        #[arg(long, default_value_t = 42)]
        seed: u32,
        /// Number of paths.
        #[arg(long, default_value_t = 100)]
        paths: usize,
        /// Write pretty JSON here instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// One path by index.
    GetPath {
        #[arg(long)]
        index: usize,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Population branch counts.
    ///
    /// The primary name is the kebab of the wire command (`get_branch_stats`);
    /// the alias is the shorter form the §5a examples use.
    #[command(name = "get-branch-stats", alias = "branch-stats")]
    BranchStats {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// The four payoff distributions.
    #[command(name = "get-distributions", alias = "distributions")]
    Distributions {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Trade analytics for a trade JSON file.
    ComputeTradeAnalytics {
        #[arg(long)]
        trade: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Risk panel Greeks for a trade and a market.
    ComputeRisk {
        #[arg(long)]
        trade: PathBuf,
        #[arg(long)]
        market: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// MC convergence series + efficiency + final row.
    #[command(name = "get-mc-diagnostics", alias = "mc-diagnostics")]
    McDiagnostics {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Cashflows + analytics for one path.
    #[command(alias = "cashflows")]
    BuildCashflows {
        #[arg(long)]
        path_index: usize,
        #[arg(long)]
        trade: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Taylor + PLVA explain for one path.
    #[command(alias = "explain")]
    ValuationExplain {
        #[arg(long)]
        path_index: usize,
        #[arg(long)]
        trade: PathBuf,
        #[arg(long)]
        market: PathBuf,
        #[arg(long)]
        as_of: String,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Ten-entry explain ledger for one path.
    ExplainLedger {
        #[arg(long)]
        path_index: usize,
        #[arg(long)]
        trade: PathBuf,
        #[arg(long)]
        market: PathBuf,
        #[arg(long)]
        as_of: String,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Per-observation event stream for one path.
    ExecutionEvents {
        #[arg(long)]
        index: usize,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Service liveness + version.
    Health {
        #[arg(long)]
        out: Option<PathBuf>,
    },
}

impl Command {
    /// The clap subcommand name, which the §5a mapping rule ties to the kernel's
    /// snake_case [`CommandId`] by `-` → `_`.
    fn kernel_name(&self) -> &'static str {
        match self {
            Self::GeneratePaths { .. } => CommandId::GeneratePaths.as_str(),
            Self::GetPath { .. } => CommandId::GetPath.as_str(),
            Self::BranchStats { .. } => CommandId::GetBranchStats.as_str(),
            Self::Distributions { .. } => CommandId::GetDistributions.as_str(),
            Self::ComputeTradeAnalytics { .. } => CommandId::ComputeTradeAnalytics.as_str(),
            Self::ComputeRisk { .. } => CommandId::ComputeRisk.as_str(),
            Self::McDiagnostics { .. } => CommandId::GetMcDiagnostics.as_str(),
            Self::BuildCashflows { .. } => CommandId::BuildCashflows.as_str(),
            Self::ValuationExplain { .. } => CommandId::ValuationExplain.as_str(),
            Self::ExplainLedger { .. } => CommandId::ExplainLedger.as_str(),
            Self::ExecutionEvents { .. } => CommandId::ExecutionEvents.as_str(),
            Self::Health { .. } => CommandId::Health.as_str(),
        }
    }

    /// The request body for this command, built from its flags. `--trade` /
    /// `--market` files are parsed as the kernel's (camelCase) JSON.
    fn request(&self) -> Result<Vec<u8>, String> {
        let read = |p: &PathBuf| std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()));
        match self {
            Self::GeneratePaths { seed, paths, .. } => {
                let mut config = fina_kernel::path_generator::SimulationConfig::demo();
                config.seed = *seed;
                config.path_count = *paths;
                serde_json::to_vec(&fina_kernel::api::GeneratePathsRequest { config })
                    .map_err(|e| e.to_string())
            }
            Self::GetPath { index, .. } | Self::ExecutionEvents { index, .. } => {
                serde_json::to_vec(&fina_kernel::api::PathRequest { path_index: *index })
                    .map_err(|e| e.to_string())
            }
            Self::BranchStats { .. }
            | Self::Distributions { .. }
            | Self::McDiagnostics { .. }
            | Self::Health { .. } => Ok(br#"{}"#.to_vec()),
            Self::ComputeTradeAnalytics { trade, .. } => {
                let raw = read(trade)?;
                serde_json::to_vec(&fina_kernel::api::TradeRequest {
                    trade: serde_json::from_slice(&raw)
                        .map_err(|e| format!("{}: {e}", trade.display()))?,
                })
                .map_err(|e| e.to_string())
            }
            Self::ComputeRisk { trade, market, .. } => {
                serde_json::to_vec(&fina_kernel::api::ComputeRiskRequest {
                    trade: serde_json::from_slice(&read(trade)?).map_err(|e| e.to_string())?,
                    market: serde_json::from_slice(&read(market)?).map_err(|e| e.to_string())?,
                })
                .map_err(|e| e.to_string())
            }
            Self::BuildCashflows {
                path_index, trade, ..
            } => serde_json::to_vec(&fina_kernel::api::CashflowRequest {
                trade: serde_json::from_slice(&read(trade)?).map_err(|e| e.to_string())?,
                path_index: *path_index,
            })
            .map_err(|e| e.to_string()),
            Self::ValuationExplain {
                path_index,
                trade,
                market,
                as_of,
                ..
            }
            | Self::ExplainLedger {
                path_index,
                trade,
                market,
                as_of,
                ..
            } => serde_json::to_vec(&fina_kernel::api::ExplainRequest {
                trade: serde_json::from_slice(&read(trade)?).map_err(|e| e.to_string())?,
                market: serde_json::from_slice(&read(market)?).map_err(|e| e.to_string())?,
                path_index: *path_index,
                as_of: as_of.clone(),
            })
            .map_err(|e| e.to_string()),
        }
    }

    /// Renders the output destination of this invocation.
    fn out(&self) -> Option<&PathBuf> {
        match self {
            Self::GeneratePaths { out, .. }
            | Self::GetPath { out, .. }
            | Self::BranchStats { out, .. }
            | Self::Distributions { out, .. }
            | Self::ComputeTradeAnalytics { out, .. }
            | Self::ComputeRisk { out, .. }
            | Self::McDiagnostics { out, .. }
            | Self::BuildCashflows { out, .. }
            | Self::ValuationExplain { out, .. }
            | Self::ExplainLedger { out, .. }
            | Self::ExecutionEvents { out, .. }
            | Self::Health { out, .. } => out.as_ref(),
        }
    }
}

/// Progress NDJSON to stderr, so stdout stays a single valid JSON document.
fn on_progress(e: ProgressEvent) {
    if let Ok(line) = serde_json::to_string(&e) {
        let mut err = std::io::stderr();
        let _ = writeln!(err, "{line}");
    }
}

/// Writes the result: pretty JSON to `--out`, compact JSON to stdout otherwise.
fn write_result(bytes: &[u8], out: Option<&PathBuf>) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("response is not JSON: {e}"))?;
    match out {
        Some(path) => {
            let pretty = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
            std::fs::write(path, pretty).map_err(|e| format!("{}: {e}", path.display()))
        }
        None => {
            let mut stdout = std::io::stdout();
            stdout
                .write_all(bytes)
                .and_then(|_| stdout.write_all(b"\n"))
                .map_err(|e| e.to_string())
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let command = cli.command;
    let body = command.request()?;
    let result =
        dispatch(command.kernel_name(), &body, &mut on_progress).map_err(|e| WireError::from(&e));
    match result {
        Ok(bytes) => write_result(&bytes, command.out()),
        Err(wire) => {
            let json = serde_json::to_string(&wire).map_err(|e| e.to_string())?;
            Err(json)
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory; // test-only: enumerating subcommand names

    /// §5a: "Add a test asserting the mapping table is complete and unique"
    /// (prevents a new core command being forgotten). Each clap subcommand's
    /// **primary** name must be exactly the kernel's snake_case command name
    /// with `-` for `_` — the shorter names like `mc-diagnostics` and `cashflows`
    /// are aliases, not the mapping.
    #[test]
    fn clap_subcommands_cover_the_kernel_command_surface_exactly() {
        let cli_cmd = Cli::command();
        let mut clap_names: Vec<String> = cli_cmd
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .collect();
        clap_names.sort_unstable();

        let mut kernel_names: Vec<String> = CommandId::ALL
            .iter()
            .map(|c| c.as_str().replace('_', "-"))
            .collect();
        kernel_names.sort_unstable();

        assert_eq!(
            clap_names, kernel_names,
            "clap subcommands must match the kernel command table"
        );
        assert_eq!(clap_names.len(), CommandId::ALL.len());
        assert_eq!(
            clap_names
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            clap_names.len(),
            "names must be unique"
        );
    }
}
