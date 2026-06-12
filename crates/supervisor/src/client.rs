//! Control-socket client. `supervisor <deploy|status|stop|rollback>` connects to
//! a running daemon's socket, sends one request, and prints the reply. The
//! daemon itself takes no subcommand (`supervisor` with no arguments).

use std::path::PathBuf;

use color_eyre::eyre::{WrapErr, eyre};
use pico_shared::proto::{self, DeployTarget, Request, Response};
use tokio::{io::BufReader, net::UnixStream};

use crate::config::Config;

/// `deploy <bin>` / `deploy path:<bin>` deploys a prebuilt worker binary;
/// `deploy rev:<git-rev>` builds the revision on the host (needs `repo_path`).
pub async fn deploy(arg: Option<String>) -> color_eyre::Result<()> {
    let arg = arg.ok_or_else(|| eyre!("usage: supervisor deploy <worker-binary> | path:<bin> | rev:<git-rev>"))?;
    let target = match arg.strip_prefix("rev:") {
        Some(rev) => DeployTarget::Rev { rev: rev.to_owned() },
        None => DeployTarget::Path {
            path: PathBuf::from(arg.strip_prefix("path:").unwrap_or(&arg)),
        },
    };
    report(send(Request::Deploy { target }).await?)
}

pub async fn status() -> color_eyre::Result<()> {
    match send(Request::Status).await? {
        Response::Status(s) => {
            println!("running:  {}", s.running);
            if let Some(pid) = s.pid {
                println!("pid:      {pid}");
            }
            if let Some(current) = s.current {
                println!("current:  {current}");
            }
            if let Some(uptime) = s.uptime_secs {
                println!("uptime:   {uptime}s");
            }
            for record in s.deploys {
                println!("deploy:   {} {} @ {}", record.outcome, record.target, record.at_unix);
            }
            Ok(())
        }
        other => report(other),
    }
}

pub async fn stop() -> color_eyre::Result<()> {
    report(send(Request::Stop).await?)
}

pub async fn rollback() -> color_eyre::Result<()> {
    report(send(Request::Rollback).await?)
}

fn report(resp: Response) -> color_eyre::Result<()> {
    match resp {
        Response::Ok { detail } => {
            println!("{detail}");
            Ok(())
        }
        Response::Error { message } => Err(eyre!("{message}")),
        Response::Status(_) => Err(eyre!("unexpected status reply")),
    }
}

async fn send(request: Request) -> color_eyre::Result<Response> {
    let dir = pico_shared::paths::supervisor_dir()?;
    let socket = Config::load(&dir)?.socket_path.unwrap_or_else(|| dir.join("pico.sock"));
    let stream = UnixStream::connect(&socket)
        .await
        .wrap_err_with(|| format!("connect {} (is the supervisor running?)", socket.display()))?;
    let (read_half, mut write_half) = stream.into_split();
    proto::write_frame(&mut write_half, &request).await?;
    let mut reader = BufReader::new(read_half);
    proto::read_frame(&mut reader)
        .await?
        .ok_or_else(|| eyre!("supervisor closed the connection without replying"))
}
