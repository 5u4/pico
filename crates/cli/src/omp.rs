use std::{path::Path, process::Stdio, time::Duration};

use clap::Args;
use color_eyre::eyre::{WrapErr, bail};
use pico_core::{
    bindings,
    omp::camofox::CamofoxDaemon,
    prompt::{self, RuntimeContext},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::thread::{self, DEFAULT_PROFILE, PLATFORM, Route};

#[derive(Args)]
pub struct OmpArgs {
    #[arg(long)]
    new: bool,
    #[arg(long, value_name = "THREAD_ID")]
    resume: Option<String>,
}

pub async fn run(args: OmpArgs) -> color_eyre::Result<()> {
    let dir = thread::current_dir()?;
    let channel = thread::channel_id(&dir);
    let root = pico_shared::paths::worker_root()?;
    let db = thread::open_db(&root).await?;

    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let camofox = CamofoxDaemon::new(&root, cancel.clone(), &tracker);

    let result = launch(&db, &root, &camofox, &dir, &channel, args).await;

    cancel.cancel();
    tracker.close();
    let _ = tokio::time::timeout(Duration::from_secs(6), tracker.wait()).await;

    if let Some(status) = result?
        && !status.success()
    {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

async fn launch(
    db: &sqlx::SqlitePool,
    root: &Path,
    camofox: &CamofoxDaemon,
    dir: &Path,
    channel: &str,
    args: OmpArgs,
) -> color_eyre::Result<Option<std::process::ExitStatus>> {
    let cli_js = pico_core::omp::client::locked_omp_cli();
    if !cli_js.exists() {
        let host_dir = pico_core::omp::client::omp_host_dir();
        bail!(
            "omp-host not installed; run `cd {} && bun install` (or re-run scripts/install-cli.sh)",
            host_dir.display()
        );
    }

    let route = match bindings::get(db, PLATFORM, channel).await? {
        Some(binding) => thread::route_from_binding(binding),
        None => {
            bindings::set_regular(db, PLATFORM, channel, DEFAULT_PROFILE, dir).await?;
            println!("No binding for this folder — auto-bound profile '{DEFAULT_PROFILE}' (regular, cwd = {channel}).");
            println!(
                "Run `pico bind --worktree <base_repo> [--branch <ref>] [--profile <name>]` for worktree isolation."
            );
            Route::Regular {
                profile: DEFAULT_PROFILE.to_owned(),
                cwd: dir.to_path_buf(),
            }
        }
    };

    let Some(thread) = thread::resolve_thread(db, root, channel, &route, args.new, args.resume.as_deref()).await?
    else {
        return Ok(None);
    };

    let session_dir = pico_shared::paths::profile_session_dir(root, &thread.profile, &thread.thread_id);
    std::fs::create_dir_all(&session_dir).wrap_err_with(|| format!("create session dir {}", session_dir.display()))?;

    let timezone = pico_core::config::load_root(&pico_shared::paths::worker_config(root))?.timezone();
    let context_block = prompt::runtime_context_block(&RuntimeContext {
        platform: PLATFORM,
        extra: &[],
        channel: &prompt::escape_text(channel),
        thread: &prompt::escape_text(&thread.label),
        profile: &thread.profile,
        cwd: &thread.cwd,
        worktree: thread
            .worktree_origin
            .as_ref()
            .map(|w| (w.base_repo.as_path(), w.default_branch.as_str())),
        timezone,
    });

    let identity_path = pico_shared::paths::profile_identity(root, &thread.profile);
    let append = prompt::assemble_append(
        &session_dir.join("append.md"),
        "",
        identity_path.is_file().then_some(identity_path.as_path()),
        &context_block,
    )?;

    let profile_config = pico_core::config::load(&pico_shared::paths::profile_config(root, &thread.profile))?;

    if profile_config.browser_enabled {
        camofox.ensure_started().await;
    }
    let env = camofox.host_env(profile_config.browser_enabled);

    let resume = thread::newest_jsonl(&session_dir).is_some();

    let camofox_ext = profile_config
        .browser_enabled
        .then(|| pico_core::omp::client::omp_host_dir().join("camofox-extension.ts"));

    let argv = build_omp_argv(
        &cli_js,
        &thread.cwd,
        &session_dir,
        resume,
        &append,
        profile_config.model.as_deref(),
        camofox_ext.as_deref(),
    );

    let status = tokio::process::Command::new("bun")
        .args(&argv)
        .envs(env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .wrap_err("spawn omp TUI")?;

    Ok(Some(status))
}

fn build_omp_argv(
    cli_js: &Path,
    cwd: &Path,
    session_dir: &Path,
    resume: bool,
    append: &Path,
    model: Option<&str>,
    camofox_ext: Option<&Path>,
) -> Vec<String> {
    let mut argv = vec![
        cli_js.display().to_string(),
        "--cwd".to_owned(),
        cwd.display().to_string(),
        "--session-dir".to_owned(),
        session_dir.display().to_string(),
    ];
    if resume {
        argv.push("--continue".to_owned());
    }
    argv.push("--append-system-prompt".to_owned());
    argv.push(append.display().to_string());
    if let Some(model) = model {
        argv.push("--model".to_owned());
        argv.push(model.to_owned());
    }
    if let Some(ext) = camofox_ext {
        argv.push("-e".to_owned());
        argv.push(ext.display().to_string());
    }
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_omp_argv_includes_continue_model_and_camofox() {
        let argv = build_omp_argv(
            Path::new("/host/dist/cli.js"),
            Path::new("/work"),
            Path::new("/sessions/t"),
            true,
            Path::new("/sessions/t/append.md"),
            Some("anthropic/claude"),
            Some(Path::new("/host/camofox-extension.ts")),
        );
        assert_eq!(
            argv,
            [
                "/host/dist/cli.js",
                "--cwd",
                "/work",
                "--session-dir",
                "/sessions/t",
                "--continue",
                "--append-system-prompt",
                "/sessions/t/append.md",
                "--model",
                "anthropic/claude",
                "-e",
                "/host/camofox-extension.ts",
            ]
        );
    }

    #[test]
    fn build_omp_argv_omits_continue_model_and_camofox() {
        let argv = build_omp_argv(
            Path::new("/host/dist/cli.js"),
            Path::new("/work"),
            Path::new("/sessions/t"),
            false,
            Path::new("/sessions/t/append.md"),
            None,
            None,
        );
        assert_eq!(
            argv,
            [
                "/host/dist/cli.js",
                "--cwd",
                "/work",
                "--session-dir",
                "/sessions/t",
                "--append-system-prompt",
                "/sessions/t/append.md",
            ]
        );
    }
}
