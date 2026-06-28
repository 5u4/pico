use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

use color_eyre::eyre::{WrapErr, bail, eyre};
use dialoguer::FuzzySelect;
use pico_core::{
    bindings::{Binding, BindingKind},
    thread_marker::{self, ThreadMarker, WorktreeOrigin},
    worktree,
};

pub(crate) const PLATFORM: &str = "cli";
const SHORT_ID_LEN: usize = 8;

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

pub(crate) enum Route {
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

pub(crate) fn route_from_binding(binding: Binding) -> Route {
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

pub(crate) struct Thread {
    pub(crate) thread_id: String,
    pub(crate) profile: String,
    pub(crate) cwd: PathBuf,
    pub(crate) worktree_origin: Option<WorktreeOrigin>,
    pub(crate) label: String,
}

pub(crate) async fn resolve_thread(
    db: &sqlx::SqlitePool,
    root: &Path,
    channel: &str,
    route: &Route,
    new: bool,
    resume: Option<&str>,
) -> color_eyre::Result<Option<Thread>> {
    if let Some(id) = resume {
        return resume_thread(db, root, id).await.map(Some);
    }
    if new {
        return new_thread(db, root, channel, route).await.map(Some);
    }
    let entries = thread_marker::list_open(db, PLATFORM, channel).await;
    match entries.len() {
        0 => new_thread(db, root, channel, route).await.map(Some),
        1 => resume_thread(db, root, &entries[0].thread_id).await.map(Some),
        _ => match pick(root, &entries).await? {
            Some(i) => resume_thread(db, root, &entries[i].thread_id).await.map(Some),
            None => Ok(None),
        },
    }
}

async fn pick(root: &Path, entries: &[thread_marker::ThreadEntry]) -> color_eyre::Result<Option<usize>> {
    let labels: Vec<String> = entries.iter().map(|entry| entry_label(root, entry)).collect();
    tokio::task::spawn_blocking(move || FuzzySelect::new().with_prompt("thread").items(&labels).interact_opt())
        .await
        .wrap_err("thread picker task panicked")?
        .wrap_err("thread picker failed")
}

fn entry_label(root: &Path, entry: &thread_marker::ThreadEntry) -> String {
    let short = short_id(&entry.thread_id);
    let kind = if entry.worktree.is_some() { " [worktree]" } else { "" };
    let session_dir = pico_shared::paths::profile_session_dir(root, &entry.profile, PLATFORM, &entry.thread_id);
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
            let path = worktree::ensure(&worktrees_dir, PLATFORM, channel, &thread_id, base_repo, default_branch)
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
    let session_dir = pico_shared::paths::profile_session_dir(root, profile, PLATFORM, thread_id);
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

pub(crate) fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
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
