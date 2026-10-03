//! JSON-RPC 2.0 MCP stdio adapter over the shared `fina-kernel` command dispatcher.
//!
//! This process writes protocol messages only to stdout. Diagnostics belong on stderr.

use std::io::{self, BufRead, Write};

use fina_kernel::api::{dispatch_sync, CommandId};
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn tool_description(command: CommandId) -> &'static str {
    match command {
        CommandId::GeneratePaths => "Generate the deterministic synthetic structured-product payoff path bundle.",
        CommandId::GetPath => "Read one generated payoff path by its 1-based pathIndex.",
        CommandId::GetBranchStats => "Read population counts by payoff branch and settlement type.",
        CommandId::GetDistributions => "Read the generated payoff distribution statistics.",
        CommandId::ComputeTradeAnalytics => "Calculate the kernel's illustrative analytics for supplied trade terms.",
        CommandId::ComputeRisk => "Calculate the kernel's heuristic risk sensitivities for supplied trade and market inputs.",
        CommandId::GetMcDiagnostics => "Read illustrative Monte Carlo convergence and efficiency diagnostics.",
        CommandId::BuildCashflows => "Build the cashflow schedule and aggregates for a trade and one path.",
        CommandId::ValuationExplain => "Build Taylor and PLVA explain output for a trade, market, path, and as-of date.",
        CommandId::ExplainLedger => "Build the explain ledger and reconciliation for a trade, market, path, and as-of date.",
        CommandId::ExecutionEvents => "Read the lifecycle events for one generated path.",
        CommandId::Health => "Return the fina-kernel version and service health fields.",
    }
}

fn input_schema(command: CommandId) -> Value {
    let object = |properties: Value, required: Vec<&str>| {
        let mut schema =
            json!({"type":"object", "properties":properties, "additionalProperties":false});
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    };
    match command {
        CommandId::GeneratePaths => object(
            json!({"config":{"type":"object","description":"SimulationConfig; provide every required field from fina-kernel::path_generator::SimulationConfig."}}),
            vec!["config"],
        ),
        CommandId::GetPath | CommandId::ExecutionEvents => object(
            json!({"pathIndex":{"type":"integer","minimum":1,"description":"1-based generated path index."}}),
            vec!["pathIndex"],
        ),
        CommandId::ComputeTradeAnalytics => object(
            json!({"trade":{"type":"object","description":"TradeEconomics request object."}}),
            vec!["trade"],
        ),
        CommandId::ComputeRisk => object(
            json!({"trade":{"type":"object","description":"TradeEconomics request object."},"market":{"type":"object","description":"MarketSnapshot request object."}}),
            vec!["trade", "market"],
        ),
        CommandId::BuildCashflows => object(
            json!({"trade":{"type":"object","description":"TradeEconomics request object."},"pathIndex":{"type":"integer","minimum":1}}),
            vec!["trade", "pathIndex"],
        ),
        CommandId::ValuationExplain | CommandId::ExplainLedger => object(
            json!({"trade":{"type":"object","description":"TradeEconomics request object."},"market":{"type":"object","description":"MarketSnapshot request object."},"pathIndex":{"type":"integer","minimum":1},"asOf":{"type":"string","format":"date","description":"ISO calendar date."}}),
            vec!["trade", "market", "pathIndex", "asOf"],
        ),
        CommandId::GetBranchStats
        | CommandId::GetDistributions
        | CommandId::GetMcDiagnostics
        | CommandId::Health => object(json!({}), vec![]),
    }
}

fn tools() -> Value {
    Value::Array(
        CommandId::ALL
            .iter()
            .map(|command| {
                json!({
                    "name": command.as_str(),
                    "description": tool_description(*command),
                    "inputSchema": input_schema(*command)
                })
            })
            .collect(),
    )
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":result})
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
}

fn handle(request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return id.map(|id| rpc_error(id, -32600, "Invalid Request: missing method"));
    };
    match method {
        "initialize" => {
            let requested = request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .filter(|version| SUPPORTED_PROTOCOL_VERSIONS.contains(version))
                .unwrap_or(PROTOCOL_VERSION);
            Some(response(
                id.unwrap_or(Value::Null),
                json!({
                    "protocolVersion": requested,
                    "capabilities":{"tools":{"listChanged":false}},
                    "serverInfo":{"name":"fina-mcp","version":SERVER_VERSION},
                    "instructions":"Tools execute the same deterministic/demo kernel commands used by fina-builder. Results are not production prices, official valuations, or risk measures."
                }),
            ))
        }
        "ping" => Some(response(id.unwrap_or(Value::Null), json!({}))),
        "tools/list" => Some(response(
            id.unwrap_or(Value::Null),
            json!({"tools":tools()}),
        )),
        "tools/call" => {
            let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                return Some(rpc_error(
                    id.unwrap_or(Value::Null),
                    -32602,
                    "Invalid params: expected params.name",
                ));
            };
            if CommandId::parse(name).is_none() {
                return Some(response(
                    id.unwrap_or(Value::Null),
                    json!({
                        "content":[{"type":"text","text":format!("Unknown fina-kernel tool: {name}")}],
                        "isError":true
                    }),
                ));
            }
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let body = serde_json::to_vec(&arguments).unwrap_or_else(|_| b"{}".to_vec());
            let result = match dispatch_sync(name, &body) {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) => json!({
                        "content":[{"type":"text","text":serde_json::to_string_pretty(&value).unwrap_or_default()}],
                        "structuredContent":value,
                        "isError":false
                    }),
                    Err(error) => {
                        json!({"content":[{"type":"text","text":error.to_string()}],"isError":true})
                    }
                },
                Err(error) => {
                    let value = json!({"code":error.code(),"message":error.to_string()});
                    json!({
                        "content":[{"type":"text","text":serde_json::to_string(&value).unwrap_or_default()}],
                        "structuredContent":value,
                        "isError":true
                    })
                }
            };
            Some(response(id.unwrap_or(Value::Null), result))
        }
        // MCP notifications are one-way and must not receive a JSON-RPC reply.
        "notifications/initialized" | "notifications/cancelled" | "notifications/progress" => None,
        _ => id.map(|id| rpc_error(id, -32601, "Method not found")),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("fina-mcp: stdin read error: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let result = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(request),
            Err(error) => Some(rpc_error(
                Value::Null,
                -32700,
                &format!("Parse error: {error}"),
            )),
        };
        if let Some(result) = result {
            if writeln!(stdout, "{result}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_every_kernel_command() {
        assert_eq!(tools().as_array().unwrap().len(), 12);
    }

    #[test]
    fn initialize_and_tools_list_are_json_rpc_responses() {
        let init =
            handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})).unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "fina-mcp");
        let list = handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 12);
    }

    #[test]
    fn initialize_falls_back_to_a_supported_protocol_version() {
        let init = handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}})).unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn tools_call_dispatches_to_the_kernel() {
        let reply = handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"health","arguments":{}}})).unwrap();
        assert_eq!(reply["result"]["isError"], false);
        assert_eq!(
            reply["result"]["structuredContent"]["version"],
            fina_kernel::VERSION
        );
    }

    #[test]
    fn notifications_have_no_response() {
        assert!(handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }
}
