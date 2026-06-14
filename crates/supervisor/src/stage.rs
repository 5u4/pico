use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use color_eyre::eyre::bail;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command};

/// A `--version` probe must return fast; a binary that blocks is reaped, not awaited.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Copy a worker binary into `builds_dir/<id>/worker`, before the live worker is touched.
pub async fn stage(src: &Path, builds_dir: &Path) -> color_eyre::Result<PathBuf> {
    let id = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let dest = builds_dir.join(id.to_string()).join("worker");
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(src, &dest).await?;
    Ok(dest)
}

/// Embedded `<bin> --version`, bounded and reaped on timeout; failure is non-fatal.
pub async fn worker_version(bin: &Path) -> color_eyre::Result<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    match tokio::time::timeout(VERSION_TIMEOUT, child.wait()).await {
        Ok(status) => {
            let status = status?;
            if !status.success() {
                bail!("`{} --version` failed ({status})", bin.display());
            }
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            bail!("`{} --version` did not exit within {VERSION_TIMEOUT:?}", bin.display());
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        stdout.read_to_string(&mut out).await?;
    }
    Ok(out.trim().to_owned())
}

/// SHA-256[:12] of the binary — a per-artifact id that separates same-`--version` builds.
pub async fn build_id(bin: &Path) -> color_eyre::Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut file = tokio::fs::File::open(bin).await?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut id = String::with_capacity(12);
    for &byte in &digest[..6] {
        id.push(HEX[(byte >> 4) as usize] as char);
        id.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(id)
}
