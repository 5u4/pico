use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use color_eyre::eyre::WrapErr;
use tokio_util::sync::CancellationToken;

use crate::{
    cancel::CancelRegistry,
    config::StreamingBehavior,
    engine::TurnOutcome,
    mid_turn::MidTurnQueue,
    omp::{
        camofox::CamofoxDaemon,
        client::{SessionConfig, SessionIdentity},
        pool::{OmpPool, ThreadHandle},
    },
    surface::{ConversationId, Surface},
};

pub struct RunTurn<'a, S: Surface> {
    pub surface: &'a S,
    pub pool: &'a OmpPool,
    pub root: &'a Path,
    pub profile: &'a str,
    pub cwd: PathBuf,
    pub identity: SessionIdentity,
    pub context_block: &'a str,
    pub surface_rules: &'a str,
    pub wrapped: &'a str,
    pub surface_thinking: bool,
    pub mode: StreamingBehavior,
    pub camofox: &'a CamofoxDaemon,
    pub mid_turn: &'a MidTurnQueue,
    pub cancels: &'a CancelRegistry,
    pub cancel: &'a CancellationToken,
    pub conversation: &'a ConversationId,
    pub thread_id: &'a str,
}

pub struct TurnSpawn {
    pub handle: Arc<ThreadHandle>,
    pub title_seed: Option<String>,
    pub result: color_eyre::Result<TurnOutcome>,
}

#[tracing::instrument(
    level = "info",
    skip_all,
    fields(thread_id = %p.thread_id, profile = %p.profile, session_id = tracing::field::Empty)
)]
pub async fn run_turn<S: Surface>(p: RunTurn<'_, S>) -> color_eyre::Result<TurnSpawn> {
    let started = std::time::Instant::now();
    let session_dir = pico_shared::paths::profile_session_dir(p.root, p.profile, p.thread_id);
    std::fs::create_dir_all(&session_dir).wrap_err_with(|| format!("create session dir {}", session_dir.display()))?;
    let identity_path = pico_shared::paths::profile_identity(p.root, p.profile);
    let append_dest = session_dir.join("append.md");
    let append_prompt = match crate::prompt::assemble_append(
        &append_dest,
        p.surface_rules,
        identity_path.is_file().then_some(identity_path.as_path()),
        p.context_block,
    ) {
        Ok(path) => Some(path),
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "assembling pico append prompt failed; spawning omp without it");
            None
        }
    };
    let profile_config = crate::config::load(&pico_shared::paths::profile_config(p.root, p.profile))?;
    if profile_config.browser_enabled {
        p.camofox.ensure_started().await;
    }
    let continue_from_file = latest_session_file(&session_dir);
    let config = SessionConfig {
        model: profile_config.model,
        cwd: p.cwd,
        session_dir,
        continue_from_file,
        append_system_prompt: append_prompt,
        identity: p.identity,
        profile: p.profile.to_owned(),
    };

    let handle = p.pool.get_or_spawn(p.thread_id, &config).await?;
    let mut title_seed: Option<String> = None;
    let result = {
        let mut session = handle.lock().await;
        tracing::Span::current().record("session_id", session.client.session_id());
        let req = crate::engine::TurnRequest {
            conversation: p.conversation,
            prompt: p.wrapped,
            surface_thinking: p.surface_thinking,
            mode: p.mode,
            cancel: p.cancel,
        };
        let rt = crate::engine::TurnRuntime {
            mid_turn: p.mid_turn,
            cancels: p.cancels,
        };
        crate::engine::drive_turn(p.surface, &mut session, req, rt, &mut title_seed).await
    };
    match &result {
        Ok(outcome) => {
            tracing::info!(outcome = ?outcome, elapsed = ?started.elapsed(), "turn finished");
        }
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), elapsed = ?started.elapsed(), "turn failed");
        }
    }
    Ok(TurnSpawn {
        handle,
        title_seed,
        result,
    })
}

fn latest_session_file(session_dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(session_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        let replace = match &newest {
            Some((latest, _)) => modified > *latest,
            None => true,
        };
        if replace {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}
