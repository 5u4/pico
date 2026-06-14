//! Test-double worker for the supervisor's e2e suite: it speaks the ready
//! handshake and then waits for SIGTERM, with none of the real worker's Discord
//! dependency, so the orchestration tests stay hermetic. Gated behind the
//! `test-stub` feature so it never ships in a normal build.

use std::path::PathBuf;

use pico_shared::proto::{self, Request};
use tokio::net::UnixStream;

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    if std::env::args().skip(1).any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("PICO_VERSION"));
        return Ok(());
    }
    let mut socket: Option<PathBuf> = None;
    let mut token = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = args.next().map(PathBuf::from),
            "--ready-token" => token = args.next().unwrap_or_default(),
            "--path" => {
                args.next();
            }
            _ => {}
        }
    }

    if let Some(socket) = socket {
        let mut stream = UnixStream::connect(&socket).await?;
        proto::write_frame(&mut stream, &Request::Ready { token }).await?;
    }

    pico_shared::signal::wait_for_shutdown().await
}
