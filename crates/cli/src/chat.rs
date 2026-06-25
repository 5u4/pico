use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use clap::Args;
use color_eyre::eyre::{WrapErr, bail, eyre};
use pico_core::{
    bindings::{self, Binding, BindingKind},
    cancel::CancelRegistry,
    config::StreamingBehavior,
    engine::TurnOutcome,
    mid_turn::MidTurnQueue,
    omp::{
        camofox::CamofoxDaemon,
        client::{HostConfig, SessionIdentity},
        pool::OmpPool,
    },
    prompt::{self, RuntimeContext},
    session::{self, RunTurn},
    surface::ConversationId,
    thread_marker::{self, ThreadMarker, WorktreeOrigin},
    worktree,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::terminal_surface::{TerminalSurface, read_stdin_line};

const PLATFORM: &str = "cli";
const DEFAULT_PROFILE: &str = "default";
const SURFACE_RULES: &str = include_str!("cli_surface.md");
const SHORT_ID_LEN: usize = 8;

#[derive(Args)]
pub struct ChatArgs {
    #[command(subcommand)]
    action: Option<ChatAction>,
    #[arg(long)]
    new: bool,
    #[arg(long, value_name = "THREAD_ID")]
    resume: Option<String>,
}

#[derive(clap::Subcommand)]
enum ChatAction {
    Bind(crate::bind::BindArgs),
}

pub(crate) fn current_dir() -> color_eyre::Result<PathBuf> {
    let dir = std::env::current_dir().wrap_err("determine current directory")?;
    Ok(std::fs::canonicalize(&dir).unwrap_or(dir))
}

pub(crate) fn channel_id(dir: &Path) -> String {
    dir.display().to_string()
}

pub(crate) async fn open_db(root: &Path) -> color_eyre::Result<sqlx::SqlitePool> {
    std::fs::create_dir_all(root).wrap_err_with(|| format!("create worker root {}", root.display()))?;
    pico_core::db::open(root).await.wrap_err("opening worker database")
}

pub async fn run(mut args: ChatArgs) -> color_eyre::Result<()> {
    if let Some(action) = args.action.take() {
        return match action {
            ChatAction::Bind(bind_args) => crate::bind::run(bind_args).await,
        };
    }
    let dir = current_dir()?;
    let channel = channel_id(&dir);
    let root = pico_shared::paths::worker_root()?;
    let db = open_db(&root).await?;

    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let camofox = CamofoxDaemon::new(&root, cancel.clone(), &tracker);
    let host_config = HostConfig {
        env: camofox.host_env(pico_core::config::any_browser_enabled(&root)),
    };
    let pool = OmpPool::new(host_config, cancel.clone(), &tracker);

    let result = run_session(&db, &root, &pool, &camofox, &cancel, &dir, &channel, args).await;

    cancel.cancel();
    tracker.close();
    let _ = tokio::time::timeout(Duration::from_secs(6), tracker.wait()).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    db: &sqlx::SqlitePool,
    root: &Path,
    pool: &OmpPool,
    camofox: &CamofoxDaemon,
    app_cancel: &CancellationToken,
    dir: &Path,
    channel: &str,
    args: ChatArgs,
) -> color_eyre::Result<()> {
    let route = match bindings::get(db, PLATFORM, channel).await? {
        Some(binding) => route_from_binding(binding),
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

    let Some(thread) = resolve_thread(db, root, channel, &route, &args).await? else {
        return Ok(());
    };

    repl(root, pool, camofox, app_cancel, channel, thread).await
}

enum Route {
    Regular {
        profile: String,
        cwd: PathBuf,
    },
    Worktree {
        profile: String,
        base_repo: PathBuf,
        default_branch: String,
    },
}

fn route_from_binding(binding: Binding) -> Route {
    match binding.kind {
        BindingKind::Regular { cwd } => Route::Regular {
            profile: binding.profile,
            cwd,
        },
        BindingKind::Worktree {
            base_repo,
            default_branch,
        } => Route::Worktree {
            profile: binding.profile,
            base_repo,
            default_branch,
        },
    }
}

struct Thread {
    thread_id: String,
    profile: String,
    cwd: PathBuf,
    worktree_origin: Option<WorktreeOrigin>,
    label: String,
}

enum Pick {
    New,
    Existing(usize),
    Quit,
}

async fn resolve_thread(
    db: &sqlx::SqlitePool,
    root: &Path,
    channel: &str,
    route: &Route,
    args: &ChatArgs,
) -> color_eyre::Result<Option<Thread>> {
    if let Some(id) = &args.resume {
        return resume_thread(db, root, id).await.map(Some);
    }
    if args.new {
        return new_thread(db, root, channel, route).await.map(Some);
    }
    let entries = thread_marker::list_open(db, PLATFORM, channel).await;
    match pick(root, &entries).await? {
        Pick::New => new_thread(db, root, channel, route).await.map(Some),
        Pick::Existing(i) => resume_thread(db, root, &entries[i].thread_id).await.map(Some),
        Pick::Quit => Ok(None),
    }
}

async fn pick(root: &Path, entries: &[thread_marker::ThreadEntry]) -> color_eyre::Result<Pick> {
    use std::io::Write as _;
    if entries.is_empty() {
        println!("No open threads in this folder; starting a new one.");
        return Ok(Pick::New);
    }
    println!("Open threads in this folder:");
    for (i, entry) in entries.iter().enumerate() {
        println!("  {}) {}", i + 1, entry_label(root, entry));
    }
    println!("  0) + new thread");
    loop {
        print!("select [0-{}]: ", entries.len());
        std::io::stdout().flush().ok();
        let Some(line) = read_stdin_line().await else {
            return Ok(Pick::Quit);
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match trimmed.parse::<usize>() {
            Ok(0) => return Ok(Pick::New),
            Ok(n) if n <= entries.len() => return Ok(Pick::Existing(n - 1)),
            _ => println!("invalid selection"),
        }
    }
}

fn entry_label(root: &Path, entry: &thread_marker::ThreadEntry) -> String {
    let short = short_id(&entry.thread_id);
    let kind = if entry.worktree.is_some() { " [worktree]" } else { "" };
    let session_dir = pico_shared::paths::profile_session_dir(root, &entry.profile, &entry.thread_id);
    match jsonl_title(&session_dir) {
        Some(title) => format!("{title}  [{short}]  ({}){kind}", entry.profile),
        None => format!("{short}  ({}){kind}", entry.profile),
    }
}

async fn new_thread(db: &sqlx::SqlitePool, root: &Path, channel: &str, route: &Route) -> color_eyre::Result<Thread> {
    let thread_id = ulid::Ulid::new().to_string();
    let (profile, cwd, worktree_origin) = match route {
        Route::Regular { profile, cwd } => {
            if !cwd.is_dir() {
                bail!("working directory {} is missing or not a directory", cwd.display());
            }
            (profile.clone(), cwd.clone(), None)
        }
        Route::Worktree {
            profile,
            base_repo,
            default_branch,
        } => {
            let worktrees_dir = worktrees_dir(root);
            let path = worktree::ensure(&worktrees_dir, channel, &thread_id, base_repo, default_branch)
                .await
                .wrap_err("worktree setup failed")?;
            (
                profile.clone(),
                path,
                Some(WorktreeOrigin {
                    base_repo: base_repo.clone(),
                    default_branch: default_branch.clone(),
                }),
            )
        }
    };
    thread_marker::save(
        db,
        PLATFORM,
        &thread_id,
        &ThreadMarker {
            profile: profile.clone(),
            cwd: cwd.clone(),
            worktree: worktree_origin.clone(),
            closed_at: None,
            channel_id: Some(channel.to_owned()),
        },
    )
    .await;
    let label = thread_label(root, &profile, &thread_id);
    Ok(Thread {
        thread_id,
        profile,
        cwd,
        worktree_origin,
        label,
    })
}

async fn resume_thread(db: &sqlx::SqlitePool, root: &Path, thread_id: &str) -> color_eyre::Result<Thread> {
    let marker = thread_marker::load(db, PLATFORM, thread_id)
        .await
        .ok_or_else(|| eyre!("no cli thread {thread_id} found"))?;
    if let Some(closed) = &marker.closed_at {
        bail!("thread {thread_id} was closed at {closed}; start a new one");
    }
    match &marker.worktree {
        Some(wt) => worktree::ensure_at(&marker.cwd, thread_id, &wt.base_repo, &wt.default_branch)
            .await
            .wrap_err("worktree setup failed")?,
        None => {
            if !marker.cwd.is_dir() {
                bail!("working directory {} is missing or not a directory", marker.cwd.display());
            }
        }
    }
    let label = thread_label(root, &marker.profile, thread_id);
    Ok(Thread {
        thread_id: thread_id.to_owned(),
        profile: marker.profile,
        cwd: marker.cwd,
        worktree_origin: marker.worktree,
        label,
    })
}

async fn repl(
    root: &Path,
    pool: &OmpPool,
    camofox: &CamofoxDaemon,
    app_cancel: &CancellationToken,
    channel: &str,
    thread: Thread,
) -> color_eyre::Result<()> {
    use std::io::Write as _;
    let Thread {
        thread_id,
        profile,
        cwd,
        worktree_origin,
        label,
    } = thread;

    let mid_turn = MidTurnQueue::default();
    let cancels = CancelRegistry::default();
    let conversation = ConversationId::new(PLATFORM, &thread_id);
    let user = std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "local".to_owned());
    let tz = pico_core::config::load_root(&pico_shared::paths::worker_config(root))
        .map(|c| c.timezone())
        .unwrap_or(chrono_tz::UTC);
    let channel_line = prompt::escape_text(channel);
    let thread_line = prompt::escape_text(&label);

    println!();
    println!("pico chat — thread {} ({profile}) — {}", short_id(&thread_id), cwd.display());
    println!("Type a message and press Enter. Ctrl-D exits; Ctrl-C aborts a running turn.");

    loop {
        println!();
        print!("» ");
        std::io::stdout().flush().ok();
        let Some(line) = read_stdin_line().await else {
            println!();
            break;
        };
        if line.trim().is_empty() {
            continue;
        }

        let sent_at = prompt::format_sent_at(now_secs(), tz);
        let wrapped = prompt::wrap_cli_message(&user, &sent_at, &line);
        let context_block = prompt::runtime_context_block(&RuntimeContext {
            platform: PLATFORM,
            extra: &[],
            channel: &channel_line,
            thread: &thread_line,
            profile: &profile,
            cwd: &cwd,
            worktree: worktree_origin
                .as_ref()
                .map(|w| (w.base_repo.as_path(), w.default_branch.as_str())),
        });
        let identity = SessionIdentity {
            platform: PLATFORM.to_owned(),
            guild: String::new(),
            channel: channel.to_owned(),
            thread: thread_id.clone(),
            user: user.clone(),
        };

        let turn_token = app_cancel.child_token();
        let done = CancellationToken::new();
        let sig = spawn_ctrlc(cancels.clone(), conversation.clone(), done.clone());

        let term = TerminalSurface::new();
        let outcome = session::run_turn(RunTurn {
            surface: &term,
            pool,
            root,
            profile: &profile,
            cwd: cwd.clone(),
            identity,
            context_block: &context_block,
            surface_rules: SURFACE_RULES,
            wrapped: &wrapped,
            surface_thinking: false,
            mode: StreamingBehavior::default(),
            camofox,
            mid_turn: &mid_turn,
            cancels: &cancels,
            cancel: &turn_token,
            conversation: &conversation,
            thread_id: &thread_id,
        })
        .await;

        done.cancel();
        let _ = sig.await;
        term.finish();

        match outcome {
            Ok(spawn) => match spawn.result {
                Ok(TurnOutcome::Dead) => pool.forget(&thread_id).await,
                Ok(_) => {}
                Err(e) => eprintln!("turn error: {e:#}"),
            },
            Err(e) => eprintln!("turn failed: {e:#}"),
        }
    }
    Ok(())
}

fn spawn_ctrlc(
    cancels: CancelRegistry,
    conversation: ConversationId,
    done: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = tokio::signal::ctrl_c() => {
                    if result.is_err() {
                        break;
                    }
                    cancels.request(&conversation);
                }
                () = done.cancelled() => break,
            }
        }
    })
}

fn worktrees_dir(root: &Path) -> PathBuf {
    match pico_core::config::load_root(&pico_shared::paths::worker_config(root)) {
        Ok(cfg) => cfg
            .worktrees_dir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| pico_shared::paths::default_worktrees_dir(root)),
        Err(_) => pico_shared::paths::default_worktrees_dir(root),
    }
}

fn thread_label(root: &Path, profile: &str, thread_id: &str) -> String {
    let session_dir = pico_shared::paths::profile_session_dir(root, profile, thread_id);
    jsonl_title(&session_dir).unwrap_or_else(|| short_id(thread_id))
}

fn jsonl_title(session_dir: &Path) -> Option<String> {
    let newest = newest_jsonl(session_dir)?;
    let file = std::fs::File::open(newest).ok()?;
    let mut first = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(file), &mut first).ok()?;
    parse_title(&first)
}

fn parse_title(first_line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    let title = value.get("title")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if newest.as_ref().is_none_or(|(t, _)| mtime > *t) {
            newest = Some((mtime, path));
        }
    }
    newest.map(|(_, path)| path)
}

fn short_id(id: &str) -> String {
    let count = id.chars().count();
    if count <= SHORT_ID_LEN {
        id.to_owned()
    } else {
        id.chars().skip(count - SHORT_ID_LEN).collect()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_id_is_the_canonical_dir_display() {
        let dir = std::env::temp_dir().join(format!("pico-cli-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(channel_id(&canonical), canonical.display().to_string());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_title_reads_title_field_only() {
        assert_eq!(
            parse_title(r#"{"title":"Fix the parser","titleSource":"llm"}"#),
            Some("Fix the parser".to_owned())
        );
        assert_eq!(parse_title(r#"{"title":"  "}"#), None);
        assert_eq!(parse_title(r#"{"other":"x"}"#), None);
        assert_eq!(parse_title("not json"), None);
        assert_eq!(parse_title(""), None);
    }

    #[test]
    fn jsonl_title_picks_newest_file_first_line() {
        let dir = std::env::temp_dir().join(format!("pico-cli-jsonl-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(jsonl_title(&dir), None);

        std::fs::write(dir.join("a.jsonl"), "{\"title\":\"older\"}\n{\"type\":\"x\"}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("b.jsonl"), "{\"title\":\"newer\"}\n").unwrap();
        std::fs::write(dir.join("ignore.txt"), "{\"title\":\"nope\"}\n").unwrap();

        assert_eq!(jsonl_title(&dir), Some("newer".to_owned()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn short_id_keeps_tail() {
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id("0123456789ABCDEF"), "89ABCDEF");
    }
}
