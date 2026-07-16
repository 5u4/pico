use std::{path::PathBuf, time::Duration};

use color_eyre::eyre::{WrapErr, eyre};
use tokio::{io::BufReader, net::UnixStream};

use crate::{
    config::{self, Config},
    proto::{Request, Response, read_frame, write_frame},
};

pub async fn deploy(arg: Option<String>) -> color_eyre::Result<()> {
    let arg = arg.ok_or_else(|| eyre!("usage: pico-supervisor deploy <slot-dir>"))?;
    report(
        send(Request::Deploy {
            path: PathBuf::from(arg),
        })
        .await?,
    )
}

pub async fn rollback() -> color_eyre::Result<()> {
    report(send(Request::Rollback).await?)
}

pub async fn stop() -> color_eyre::Result<()> {
    report(send(Request::Stop).await?)
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
            if let Some(version) = s.version {
                println!("version:  {version}");
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
    let dir = config::supervisor_dir()?;
    let config = Config::load(&dir)?;
    let socket = config.socket_path.clone().unwrap_or_else(|| dir.join("pico.sock"));
    let stream = tokio::time::timeout(Duration::from_secs(5), UnixStream::connect(&socket))
        .await
        .map_err(|_| eyre!("connecting to {} timed out", socket.display()))?
        .wrap_err_with(|| format!("connect {} (is the supervisor running?)", socket.display()))?;
    let (read_half, mut write_half) = stream.into_split();
    write_frame(&mut write_half, &request).await?;
    let mut reader = BufReader::new(read_half);
    let budget = Duration::from_secs(config.health_timeout_secs.saturating_mul(4).saturating_add(10).max(180));
    tokio::time::timeout(budget, read_frame::<Response, _>(&mut reader))
        .await
        .map_err(|_| eyre!("supervisor did not reply within {budget:?}"))??
        .ok_or_else(|| eyre!("supervisor closed the connection without replying"))
}
