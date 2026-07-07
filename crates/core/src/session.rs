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
        protocol::ImageAttachment,
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
    pub images: &'a [ImageAttachment],
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
    let built = build_session(p.root, p.profile, p.cwd, p.identity, p.context_block, p.surface_rules)?;
    if built.browser_enabled {
        p.camofox.ensure_started().await;
    }
    let handle = p.pool.get_or_spawn(p.thread_id, &built.config).await?;
    let mut title_seed: Option<String> = None;
    let result = {
        let (_turn, mut events) = handle.begin_turn().await;
        tracing::Span::current().record("session_id", handle.client().session_id());
        let req = crate::engine::TurnRequest {
            conversation: p.conversation,
            kind: crate::engine::TurnKind::Active {
                prompt: p.wrapped,
                images: p.images,
            },
            mode: p.mode,
            cancel: p.cancel,
        };
        let rt = crate::engine::TurnRuntime {
            mid_turn: p.mid_turn,
            cancels: p.cancels,
        };
        crate::engine::drive_turn(p.surface, handle.client(), &mut events, req, rt, &mut title_seed).await
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

struct BuiltSession {
    config: SessionConfig,
    browser_enabled: bool,
}

fn build_session(
    root: &Path,
    profile: &str,
    cwd: PathBuf,
    identity: SessionIdentity,
    context_block: &str,
    surface_rules: &str,
) -> color_eyre::Result<BuiltSession> {
    let session_dir = pico_shared::paths::profile_session_dir(root, profile, &identity.platform, &identity.thread);
    std::fs::create_dir_all(&session_dir).wrap_err_with(|| format!("create session dir {}", session_dir.display()))?;
    let identity_path = pico_shared::paths::profile_identity(root, profile);
    let append_dest = session_dir.join("append.md");
    let append_prompt = match crate::prompt::assemble_append(
        &append_dest,
        surface_rules,
        identity_path.is_file().then_some(identity_path.as_path()),
        context_block,
    ) {
        Ok(path) => Some(path),
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "assembling pico append prompt failed; spawning omp without it");
            None
        }
    };
    let profile_config = crate::config::load(&pico_shared::paths::profile_config(root, profile))?;
    let browser_enabled = profile_config.browser_enabled;
    let continue_from_file = latest_session_file(&session_dir);
    let config = SessionConfig {
        model: profile_config.model,
        cwd,
        session_dir,
        continue_from_file,
        append_system_prompt: append_prompt,
        identity,
        profile: profile.to_owned(),
    };
    Ok(BuiltSession {
        config,
        browser_enabled,
    })
}

pub fn resumable(root: &std::path::Path, profile: &str, platform: &str, thread_id: &str) -> bool {
    let dir = pico_shared::paths::profile_session_dir(root, profile, platform, thread_id);
    latest_session_file(&dir).is_some()
}

pub struct ResumeSession<'a> {
    pub pool: &'a crate::omp::pool::OmpPool,
    pub root: &'a std::path::Path,
    pub profile: &'a str,
    pub cwd: std::path::PathBuf,
    pub identity: crate::omp::client::SessionIdentity,
    pub context_block: &'a str,
    pub surface_rules: &'a str,
    pub thread_id: &'a str,
}

pub async fn resume(
    r: ResumeSession<'_>,
) -> color_eyre::Result<Option<std::sync::Arc<crate::omp::pool::ThreadHandle>>> {
    if !resumable(r.root, r.profile, &r.identity.platform, r.thread_id) {
        return Ok(None);
    }
    let built = build_session(r.root, r.profile, r.cwd, r.identity, r.context_block, r.surface_rules)?;
    let handle = r.pool.get_or_spawn(r.thread_id, &built.config).await?;
    Ok(Some(handle))
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-session-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resumable_false_when_session_dir_absent() {
        let root = temp_dir("absent");
        assert!(
            !resumable(&root, "default", "discord", "thread-a"),
            "a thread with no session dir must not be resumable"
        );
    }

    #[test]
    fn resumable_false_when_session_dir_empty() {
        let root = temp_dir("empty");
        let dir = pico_shared::paths::profile_session_dir(&root, "default", "discord", "thread-b");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            !resumable(&root, "default", "discord", "thread-b"),
            "an empty session dir must not be resumable"
        );
    }

    #[test]
    fn resumable_false_when_only_non_jsonl_present() {
        let root = temp_dir("nonjsonl");
        let dir = pico_shared::paths::profile_session_dir(&root, "default", "discord", "thread-c");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("append.md"), "poison").unwrap();
        std::fs::write(dir.join("foo.txt"), "noise").unwrap();
        assert!(
            !resumable(&root, "default", "discord", "thread-c"),
            "a session dir holding only non-jsonl files must not be resumable"
        );
    }

    #[test]
    fn resumable_true_when_jsonl_present() {
        let root = temp_dir("jsonl");
        let dir = pico_shared::paths::profile_session_dir(&root, "default", "discord", "thread-d");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("session.jsonl"), "{}\n").unwrap();
        assert!(
            resumable(&root, "default", "discord", "thread-d"),
            "a session dir holding a .jsonl file must be resumable"
        );
    }

    #[test]
    fn resumable_true_when_jsonl_mixed_with_non_jsonl() {
        let root = temp_dir("mixed");
        let dir = pico_shared::paths::profile_session_dir(&root, "default", "discord", "thread-e");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("append.md"), "poison").unwrap();
        std::fs::write(dir.join("foo.txt"), "noise").unwrap();
        std::fs::write(dir.join("history.jsonl"), "{}\n").unwrap();
        assert!(
            resumable(&root, "default", "discord", "thread-e"),
            "a session dir holding a .jsonl alongside other files must be resumable"
        );
    }
}
