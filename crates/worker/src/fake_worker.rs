use std::path::PathBuf;

use pico_shared::proto::{self, ReadyAck, Request};
use tokio::{io::BufReader, net::UnixStream};

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    if std::env::args().skip(1).any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("PICO_VERSION"));
        return Ok(());
    }
    let mut socket: Option<PathBuf> = None;
    let mut token = String::new();
    let mut root: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = args.next().map(PathBuf::from),
            "--ready-token" => token = args.next().unwrap_or_default(),
            "--path" => root = args.next().map(PathBuf::from),
            _ => {}
        }
    }

    if let Some(socket) = socket {
        let stream = UnixStream::connect(&socket).await?;
        let (read_half, mut write_half) = stream.into_split();
        proto::write_frame(&mut write_half, &Request::Ready { token }).await?;
        let mut reader = BufReader::new(read_half);
        if let Ok(Some(ack)) = proto::read_frame::<ReadyAck, _>(&mut reader).await
            && let (Some(report), Some(root)) = (ack.report, root.as_ref())
        {
            let _ = std::fs::create_dir_all(root);
            let _ = std::fs::write(root.join("relay-report.txt"), report.text.as_bytes());
        }
    }

    pico_shared::signal::wait_for_shutdown().await
}
