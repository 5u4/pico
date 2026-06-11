use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use color_eyre::eyre::bail;
use pico_shared::proto::DeployTarget;

/// Resolve a deploy target into a worker binary inside `builds_dir`, returning
/// the path to the copied binary (`builds_dir/<id>/worker`). Runs while the
/// current worker is still serving; any failure returns an error so the caller
/// can abort before touching the running worker.
pub async fn resolve(
    target: &DeployTarget,
    repo_path: Option<&Path>,
    builds_dir: &Path,
) -> color_eyre::Result<PathBuf> {
    match target {
        DeployTarget::Rev { rev } => {
            let Some(repo) = repo_path else {
                bail!("deploy rev: requires repo_path in supervisor.toml");
            };

            run(
                tokio::process::Command::new("git").arg("-C").arg(repo).arg("fetch"),
                "git fetch",
            )
            .await?;

            let output = tokio::process::Command::new("git")
                .arg("-C")
                .arg(repo)
                .arg("rev-parse")
                .arg(rev)
                .output()
                .await?;
            if !output.status.success() {
                bail!("git rev-parse: {}", String::from_utf8_lossy(&output.stderr));
            }
            let sha = String::from_utf8_lossy(&output.stdout).trim().to_owned();

            run(
                tokio::process::Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .arg("checkout")
                    .arg(&sha),
                "git checkout",
            )
            .await?;

            run(
                tokio::process::Command::new("cargo")
                    .current_dir(repo)
                    .arg("build")
                    .arg("--release"),
                "cargo build --release",
            )
            .await?;

            let dest = builds_dir.join(&sha).join("worker");
            copy_binary(&repo.join("target").join("release").join("worker"), &dest).await?;
            Ok(dest)
        }
        DeployTarget::Path { path } => {
            let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            let dest = builds_dir.join(format!("dev-{ts}")).join("worker");
            copy_binary(path, &dest).await?;
            Ok(dest)
        }
    }
}

async fn run(cmd: &mut tokio::process::Command, what: &str) -> color_eyre::Result<()> {
    if !cmd.status().await?.success() {
        bail!("{what} failed");
    }
    Ok(())
}

async fn copy_binary(src: &Path, dest: &Path) -> color_eyre::Result<()> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(src, dest).await?;
    Ok(())
}
