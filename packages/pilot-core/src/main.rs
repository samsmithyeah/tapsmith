mod adb;
mod agent_comms;
mod device;
mod grpc_server;
mod screenshot;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::RwLock;
use tonic::transport::Server;
use tracing::{info, warn};

use crate::agent_comms::AgentConnection;
use crate::device::DeviceManager;
use crate::grpc_server::PilotServiceImpl;

pub mod proto {
    tonic::include_proto!("pilot");
}

#[derive(Debug)]
struct CliArgs {
    port: u16,
    agent_port: Option<u16>,
    verbose: bool,
}

fn parse_args() -> CliArgs {
    let mut args = std::env::args().skip(1);
    let mut port: u16 = 50051;
    let mut agent_port: Option<u16> = None;
    let mut verbose = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(val) = args.next() {
                    port = val.parse().unwrap_or_else(|_| {
                        eprintln!("Invalid port number: {val}");
                        std::process::exit(1);
                    });
                }
            }
            "--agent-port" => {
                if let Some(val) = args.next() {
                    agent_port = Some(val.parse().unwrap_or_else(|_| {
                        eprintln!("Invalid agent port number: {val}");
                        std::process::exit(1);
                    }));
                }
            }
            "--verbose" | "-v" => {
                verbose = true;
            }
            "--help" | "-h" => {
                eprintln!("Usage: pilot-core [--port PORT] [--agent-port PORT] [--verbose]");
                eprintln!();
                eprintln!("Options:");
                eprintln!("  --port PORT         gRPC listen port (default: 50051)");
                eprintln!("  --agent-port PORT   Local port for ADB forwarding to on-device agent (default: 18700)");
                eprintln!("  --verbose           Enable debug logging");
                std::process::exit(0);
            }
            other => {
                eprintln!("Unknown argument: {other}");
                eprintln!("Run with --help for usage information.");
                std::process::exit(1);
            }
        }
    }

    CliArgs {
        port,
        agent_port,
        verbose,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args();

    let filter = if args.verbose {
        "pilot_core=debug,tonic=info"
    } else {
        "pilot_core=info,tonic=warn"
    };

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter)),
        )
        .init();

    // Verify ADB is available
    match adb::find_adb().await {
        Ok(path) => info!(path = %path.display(), "Found ADB"),
        Err(e) => warn!("ADB not found on PATH: {e}. Device operations will fail."),
    }

    let device_manager = Arc::new(RwLock::new(DeviceManager::new()));
    let agent_connection = Arc::new(RwLock::new(match args.agent_port {
        Some(port) => AgentConnection::with_port(port),
        None => AgentConnection::new(),
    }));

    let service = PilotServiceImpl::new(device_manager, agent_connection);

    let addr: SocketAddr = format!("127.0.0.1:{}", args.port)
        .parse()
        .context("Invalid listen address")?;

    info!(%addr, "Starting Pilot gRPC server");

    Server::builder()
        .add_service(proto::pilot_service_server::PilotServiceServer::new(
            service,
        ))
        .serve_with_shutdown(addr, shutdown_signal())
        .await
        .context("gRPC server failed")?;

    info!("Pilot daemon shut down cleanly");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to install SIGTERM handler");

    tokio::select! {
        _ = ctrl_c => { info!("Received Ctrl+C, shutting down"); }
        _ = sigterm.recv() => { info!("Received SIGTERM, shutting down"); }
    }
}
