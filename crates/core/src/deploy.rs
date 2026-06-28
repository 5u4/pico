use std::time::Duration;

use color_eyre::eyre::{WrapErr, bail, eyre};
use pico_shared::proto;

pub async fn request_deploy(
    socket: &std::path::Path,
    path: std::path::PathBuf,
    report_to: Option<String>,
) -> color_eyre::Result<proto::Response> {
    let stream = tokio::time::timeout(Duration::from_secs(5), tokio::net::UnixStream::connect(socket))
        .await
        .map_err(|_| eyre!("connecting to supervisor timed out"))?
        .wrap_err("connect to supervisor socket")?;
    let (read_half, mut write_half) = stream.into_split();
    proto::write_frame(&mut write_half, &proto::Request::Deploy { path, report_to }).await?;
    let mut reader = tokio::io::BufReader::new(read_half);
    tokio::time::timeout(Duration::from_secs(180), proto::read_frame::<proto::Response, _>(&mut reader))
        .await
        .map_err(|_| eyre!("deploy did not complete within 180s"))?
        .wrap_err("read deploy response")?
        .ok_or_else(|| eyre!("supervisor closed the connection without replying"))
}

static DEPLOY_BUILD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub async fn build_worker(build_dir: &std::path::Path) -> color_eyre::Result<std::path::PathBuf> {
    let target_dir = pico_shared::paths::pico_build_target_dir()?;
    let _build = DEPLOY_BUILD_LOCK.lock().await;
    let child = tokio::process::Command::new("cargo")
        .args(["build", "--release", "-p", "pico-worker", "--target-dir"])
        .arg(&target_dir)
        .current_dir(build_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .wrap_err("spawn cargo build")?;
    let out = match tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output()).await {
        Ok(res) => res.wrap_err("wait for cargo build")?,
        Err(_) => bail!("cargo build timed out after {}s", BUILD_TIMEOUT.as_secs()),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr
            .chars()
            .rev()
            .take(1500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        bail!("cargo build failed ({}):\n{tail}", out.status);
    }
    install_cli(build_dir, &target_dir).await;
    bun_install_host(build_dir).await;
    snapshot(&target_dir).await
}

async fn install_cli(build_dir: &std::path::Path, target_dir: &std::path::Path) {
    let root = match pico_shared::paths::local_install_root() {
        Ok(root) => root,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "cannot resolve local install root; skipping pico CLI install");
            return;
        }
    };
    let child = tokio::process::Command::new("cargo")
        .args(["install", "--locked", "--path"])
        .arg(build_dir.join("crates").join("cli"))
        .arg("--root")
        .arg(&root)
        .arg("--target-dir")
        .arg(target_dir)
        .arg("--force")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "spawning `cargo install` for pico CLI failed; schedule extension may not find pico");
            return;
        }
    };
    match tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => tracing::info!("pico CLI install ok"),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!(status = %out.status, %stderr, "pico CLI `cargo install` failed; schedule extension may not find pico");
        }
        Ok(Err(e)) => tracing::warn!(error = %format!("{e:#}"), "waiting on pico CLI `cargo install` failed"),
        Err(_) => tracing::warn!("pico CLI `cargo install` timed out"),
    }
}

async fn bun_install_host(build_dir: &std::path::Path) {
    let host_dir = build_dir.join("omp-host");
    let child = tokio::process::Command::new("bun")
        .arg("install")
        .current_dir(&host_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), dir = %host_dir.display(), "spawning `bun install` for omp-host failed; keeping existing node_modules");
            return;
        }
    };
    match tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => tracing::info!("omp-host `bun install` ok"),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!(status = %out.status, %stderr, "omp-host `bun install` failed; keeping existing node_modules");
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %format!("{e:#}"), "waiting on omp-host `bun install` failed; keeping existing node_modules")
        }
        Err(_) => tracing::warn!("omp-host `bun install` timed out; keeping existing node_modules"),
    }
}

async fn snapshot(target_dir: &std::path::Path) -> color_eyre::Result<std::path::PathBuf> {
    let staging = target_dir.with_file_name("pico-deploy-staging");
    prune_staging(&staging).await;
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let dir = staging.join(id.to_string());
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join("pico-worker");
    tokio::fs::copy(target_dir.join("release").join("pico-worker"), &dest)
        .await
        .wrap_err("snapshot built worker")?;
    Ok(dest)
}

async fn prune_staging(staging: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(staging).await else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(3600);
    while let Ok(Some(entry)) = entries.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .is_some_and(|m| m < cutoff);
        if stale {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

pub async fn update_repo(repo: &std::path::Path) -> color_eyre::Result<()> {
    if !repo.join(".git").exists() {
        bail!("{} is not a git checkout", repo.display());
    }
    crate::worktree::run_git(repo, ["fetch", "origin"], Duration::from_secs(120)).await?;
    crate::worktree::run_git(repo, ["reset", "--hard", "origin/main"], Duration::from_secs(30)).await?;
    Ok(())
}
