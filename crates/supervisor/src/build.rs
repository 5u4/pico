use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use color_eyre::eyre::bail;
use pico_shared::{proc, proto::DeployTarget};
use tokio::process::Command;

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

            proc::run(Command::new("git").arg("-C").arg(repo).arg("fetch")).await?;
            let sha = proc::run(Command::new("git").arg("-C").arg(repo).arg("rev-parse").arg(rev)).await?;
            proc::run(Command::new("git").arg("-C").arg(repo).arg("checkout").arg(&sha)).await?;
            proc::run(Command::new("cargo").current_dir(repo).arg("build").arg("--release")).await?;

            let dest = builds_dir.join(&sha).join("worker");
            copy_binary(&repo.join("target").join("release").join("worker"), &dest).await?;
            Ok(dest)
        }
        DeployTarget::Path { path } => {
            let id = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
            let dest = builds_dir.join(format!("dev-{id}")).join("worker");
            copy_binary(path, &dest).await?;
            Ok(dest)
        }
    }
}

async fn copy_binary(src: &Path, dest: &Path) -> color_eyre::Result<()> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(src, dest).await?;
    Ok(())
}
