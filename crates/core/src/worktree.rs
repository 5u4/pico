//! Per-thread git worktrees for worktree-kind bindings. Each Discord thread in a
//! worktree channel runs in `<worktrees_dir>/<channel_id>/<thread_id>`, forked
//! off `base_repo`'s `origin/<default_branch>` onto branch `pico/<thread_id>`.
//! The path is derived from ids (no DB): an existing worktree dir is reused, a
//! missing one is created on demand.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use color_eyre::eyre::{WrapErr, bail};
use tokio::process::Command;

const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Serialises worktree creation process-wide. It closes the dir-exists → `git
/// worktree add` race (this runs before the pool's per-thread lock, so that can't
/// cover it) and keeps concurrent `worktree add` off one repo's lock. One global
/// mutex is coarser than per-repo: a slow `fetch` (bounded by FETCH_TIMEOUT)
/// head-of-line-blocks new threads in other channels too — simple and correct
/// for a single-bot process, revisit if many distinct base repos are served.
static CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The branch a thread's worktree checks out. Snowflake-derived so a respawn
/// resolves it with no stored mapping.
fn branch_name(thread_id: &str) -> String {
    format!("pico/{thread_id}")
}

/// Where a thread's worktree lives. Pure id derivation, no IO.
pub fn worktree_path(worktrees_dir: &Path, channel_id: &str, thread_id: &str) -> PathBuf {
    worktrees_dir.join(channel_id).join(thread_id)
}

/// Resolve the git worktree for a thread, creating it if absent, and return its
/// derived path for use as the turn's cwd.
pub async fn ensure(
    worktrees_dir: &Path,
    channel_id: &str,
    thread_id: &str,
    base_repo: &Path,
    default_branch: &str,
) -> color_eyre::Result<PathBuf> {
    let path = worktree_path(worktrees_dir, channel_id, thread_id);
    ensure_at(&path, thread_id, base_repo, default_branch).await?;
    Ok(path)
}

/// Create the worktree at an explicit `path` (idempotent: an existing worktree is
/// reused; a missing one is forked off `default_branch` after a best-effort `git
/// fetch origin` for `origin/…` refs). Used to recreate a thread's frozen
/// worktree path if it was torn down out from under the worker.
pub async fn ensure_at(path: &Path, thread_id: &str, base_repo: &Path, default_branch: &str) -> color_eyre::Result<()> {
    let _guard = CREATE_LOCK.lock().await;
    if path.join(".git").exists() {
        return Ok(());
    }
    if path.exists() {
        bail!(
            "worktree path {} exists but is not a git worktree; remove it and resend",
            path.display()
        );
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .wrap_err_with(|| format!("create worktree parent {}", parent.display()))?;
    }

    // Drop registrations for worktree dirs deleted out from under git, so a
    // manual `rm -rf` of a prior worktree doesn't wedge `worktree add`.
    run_git(base_repo, ["worktree", "prune"], GIT_TIMEOUT)
        .await
        .wrap_err("git worktree prune")?;
    // Refresh the remote-tracking ref before forking it — but best-effort: an
    // offline/auth-failed fetch logs a warning and forks the possibly-stale ref
    // rather than blocking the turn. A bare local `default_branch` skips it.
    if default_branch.starts_with("origin/")
        && let Err(e) = run_git(base_repo, ["fetch", "origin"], FETCH_TIMEOUT).await
    {
        tracing::warn!(error = %format!("{e:#}"), %default_branch, "git fetch origin failed; forking possibly-stale ref");
    }

    let branch = branch_name(thread_id);
    if branch_exists(base_repo, &branch).await? {
        // Reattach a branch left by a prior worktree — never `-B`, which resets
        // it and loses commits.
        run_git(
            base_repo,
            [
                OsStr::new("worktree"),
                OsStr::new("add"),
                path.as_os_str(),
                OsStr::new(&branch),
            ],
            GIT_TIMEOUT,
        )
        .await
        .wrap_err("git worktree add")?;
    } else {
        run_git(
            base_repo,
            [
                OsStr::new("worktree"),
                OsStr::new("add"),
                path.as_os_str(),
                OsStr::new("-b"),
                OsStr::new(&branch),
                OsStr::new(default_branch),
            ],
            GIT_TIMEOUT,
        )
        .await
        .wrap_err("git worktree add")?;
    }
    Ok(())
}

/// Validate a worktree base at bind time so `/bind worktree` rejects a bad setup
/// up front instead of failing at the first message. `base_repo` must be a git
/// repo; an `origin/…` `default_branch` additionally requires an `origin` remote
/// (a bare local branch needs none).
pub async fn validate_base_repo(base_repo: &Path, default_branch: &str) -> color_eyre::Result<()> {
    if !git_ok(base_repo, ["rev-parse", "--git-dir"], GIT_TIMEOUT).await? {
        bail!("{} is not a git repository", base_repo.display());
    }
    if default_branch.starts_with("origin/") {
        let remotes = git_output(base_repo, ["remote"], GIT_TIMEOUT).await?;
        let has_origin = String::from_utf8_lossy(&remotes.stdout)
            .lines()
            .any(|line| line.trim() == "origin");
        if !has_origin {
            bail!(
                "{} has no 'origin' remote; pass a local branch (e.g. branch:main) or add an origin",
                base_repo.display()
            );
        }
    }
    Ok(())
}

/// What `/worktree close` would permanently destroy for a thread's worktree.
pub struct LossSummary {
    pub dirty: bool,
    /// Branch commits reachable from neither a remote-tracking ref (pushed) nor HEAD (in trunk) — the work this close would not preserve; `None` ⇒ unknown count, treated as loss.
    pub unmerged: Option<u32>,
}

impl LossSummary {
    pub fn needs_confirmation(&self) -> bool {
        self.dirty || self.unmerged.is_none_or(|n| n > 0)
    }

    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if self.dirty {
            parts.push("uncommitted changes".to_owned());
        }
        match self.unmerged {
            Some(n) if n > 0 => parts.push(format!("{n} commit(s) not pushed or merged")),
            None => parts.push("possibly-unsaved commits".to_owned()),
            Some(_) => {}
        }
        if parts.is_empty() {
            "uncommitted or unmerged work".to_owned()
        } else {
            parts.join(" and ")
        }
    }
}

/// Inspect — read-only — what closing the thread's worktree would destroy. The
/// unmerged probe uses `base_repo`'s branch ref, so it reports even if the dir is gone.
pub async fn close_would_lose(base_repo: &Path, worktree: &Path, thread_id: &str) -> color_eyre::Result<LossSummary> {
    let dirty = if worktree.join(".git").exists() {
        let out = git_output(worktree, ["status", "--porcelain"], GIT_TIMEOUT).await?;
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    } else {
        false
    };
    let branch = branch_name(thread_id);
    let unmerged = if branch_exists(base_repo, &branch).await? {
        // Pushed to any remote (recoverable even after a squash-merge) or reachable from HEAD (in trunk) ⇒ safe; the rest is work this close would not preserve.
        let out = git_output(
            base_repo,
            ["rev-list", "--count", &branch, "--not", "--remotes", "HEAD"],
            GIT_TIMEOUT,
        )
        .await?;
        if out.status.success() {
            String::from_utf8_lossy(&out.stdout).trim().parse().ok()
        } else {
            None
        }
    } else {
        Some(0)
    };
    Ok(LossSummary { dirty, unmerged })
}

/// Tear down a thread's worktree: force-remove the working tree, then delete its
/// branch. Idempotent; `--force` so a dirty tree can't block the close. Serialised
/// against [`ensure_at`] so a concurrent recreate can't race the removal.
pub async fn remove(base_repo: &Path, worktree: &Path, thread_id: &str) -> color_eyre::Result<()> {
    let _guard = CREATE_LOCK.lock().await;
    if worktree.exists() {
        run_git(
            base_repo,
            [
                OsStr::new("worktree"),
                OsStr::new("remove"),
                OsStr::new("--force"),
                worktree.as_os_str(),
            ],
            GIT_TIMEOUT,
        )
        .await
        .wrap_err("git worktree remove")?;
    } else {
        // Dir deleted out from under git (host rebuild): drop the stale registration.
        run_git(base_repo, ["worktree", "prune"], GIT_TIMEOUT)
            .await
            .wrap_err("git worktree prune")?;
    }
    let branch = branch_name(thread_id);
    if branch_exists(base_repo, &branch).await? {
        run_git(base_repo, ["branch", "-D", &branch], GIT_TIMEOUT)
            .await
            .wrap_err("git branch -D")?;
    }
    Ok(())
}

async fn branch_exists(repo: &Path, branch: &str) -> color_eyre::Result<bool> {
    git_ok(
        repo,
        ["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")],
        GIT_TIMEOUT,
    )
    .await
}

async fn run_git<I, S>(repo: &Path, args: I, timeout: Duration) -> color_eyre::Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_output(repo, args, timeout).await?;
    if !output.status.success() {
        bail!("git: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

async fn git_ok<I, S>(repo: &Path, args: I, timeout: Duration) -> color_eyre::Result<bool>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Ok(git_output(repo, args, timeout).await?.status.success())
}

async fn git_output<I, S>(repo: &Path, args: I, timeout: Duration) -> color_eyre::Result<std::process::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().wrap_err("spawn git")?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(res) => res.wrap_err("wait for git"),
        Err(_) => bail!("git timed out after {}s", timeout.as_secs()),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-worktree-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(repo: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// A base_repo with an `origin` remote and a seeded `main`, built by cloning a
    /// throwaway upstream — mirrors a real clone a worktree channel forks from.
    fn base_repo_with_origin(root: &Path) -> PathBuf {
        let upstream = root.join("upstream");
        std::fs::create_dir_all(&upstream).unwrap();
        git(&upstream, &["init", "-b", "main"]);
        git(&upstream, &["config", "user.email", "test@pico"]);
        git(&upstream, &["config", "user.name", "pico test"]);
        std::fs::write(upstream.join("seed.txt"), "hello").unwrap();
        git(&upstream, &["add", "."]);
        git(&upstream, &["commit", "-m", "seed"]);

        let base = root.join("base");
        git(root, &["clone", upstream.to_str().unwrap(), base.to_str().unwrap()]);
        base
    }

    /// A local repo with a seeded `main` and no remote — a worktree base for the
    /// offline path (a bare-local `default_branch`).
    fn local_repo(root: &Path) -> PathBuf {
        let repo = root.join("local");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@pico"]);
        git(&repo, &["config", "user.name", "pico test"]);
        std::fs::write(repo.join("seed.txt"), "hello").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "seed"]);
        repo
    }

    #[tokio::test]
    async fn ensure_creates_then_reuses_worktree() {
        let root = temp_dir("ensure");
        let base = base_repo_with_origin(&root);
        let wt_dir = root.join("worktrees");

        let path = super::ensure(&wt_dir, "111111111111111111", "222222222222222222", &base, "origin/main")
            .await
            .unwrap();

        assert_eq!(path, wt_dir.join("111111111111111111").join("222222222222222222"));
        assert!(path.join(".git").exists(), "worktree .git missing");
        assert!(path.join("seed.txt").exists(), "fork did not check out main");

        // Idempotent: a second call reuses the same worktree without erroring.
        let again = super::ensure(&wt_dir, "111111111111111111", "222222222222222222", &base, "origin/main")
            .await
            .unwrap();
        assert_eq!(again, path);

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn ensure_distinct_threads_get_distinct_worktrees() {
        let root = temp_dir("distinct");
        let base = base_repo_with_origin(&root);
        let wt_dir = root.join("worktrees");

        let a = super::ensure(&wt_dir, "111111111111111111", "222222222222222222", &base, "main")
            .await
            .unwrap();
        let b = super::ensure(&wt_dir, "111111111111111111", "333333333333333333", &base, "main")
            .await
            .unwrap();
        assert_ne!(a, b);
        assert!(b.join("seed.txt").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn validate_base_repo_checks_repo_and_conditional_origin() {
        let root = temp_dir("validate");

        // Not a git repo: rejected regardless of ref.
        assert!(super::validate_base_repo(&root, "origin/main").await.is_err());

        // No origin: rejected for an origin/ ref, accepted for a local branch.
        let no_origin = root.join("no-origin");
        std::fs::create_dir_all(&no_origin).unwrap();
        git(&no_origin, &["init", "-b", "main"]);
        assert!(super::validate_base_repo(&no_origin, "origin/main").await.is_err());
        assert!(super::validate_base_repo(&no_origin, "main").await.is_ok());

        // A clone has an origin: origin/ ref accepted.
        let base = base_repo_with_origin(&root);
        assert!(super::validate_base_repo(&base, "origin/main").await.is_ok());

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn ensure_reattaches_branch_preserving_commits() {
        let root = temp_dir("reattach");
        let base = base_repo_with_origin(&root);
        let wt_dir = root.join("worktrees");
        let channel = "111111111111111111";
        let thread = "222222222222222222";

        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        // Commit on the thread's branch, then delete the worktree dir out from
        // under git so the branch (pico/<thread>) survives but its checkout is gone.
        std::fs::write(path.join("work.txt"), "wip").unwrap();
        git(&path, &["config", "user.email", "test@pico"]);
        git(&path, &["config", "user.name", "pico test"]);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "wip"]);
        std::fs::remove_dir_all(&path).unwrap();

        // Re-ensure must reattach the branch at its tip, never reset it (`-B`).
        let again = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        assert_eq!(again, path);
        assert!(again.join("work.txt").exists(), "reattach lost the branch's commit");

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn ensure_forks_local_branch_offline() {
        let root = temp_dir("offline");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        // A bare-local `default_branch` skips the fetch and needs no origin remote.
        let path = super::ensure(&wt_dir, "111111111111111111", "222222222222222222", &base, "main")
            .await
            .unwrap();
        assert!(path.join("seed.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn loss_summary_confirmation_and_describe() {
        use super::LossSummary;
        assert!(
            !LossSummary {
                dirty: false,
                unmerged: Some(0)
            }
            .needs_confirmation()
        );
        assert!(
            LossSummary {
                dirty: true,
                unmerged: Some(0)
            }
            .needs_confirmation()
        );
        assert!(
            LossSummary {
                dirty: false,
                unmerged: Some(2)
            }
            .needs_confirmation()
        );
        assert!(
            LossSummary {
                dirty: false,
                unmerged: None
            }
            .needs_confirmation()
        );
        assert_eq!(
            LossSummary {
                dirty: true,
                unmerged: Some(2)
            }
            .describe(),
            "uncommitted changes and 2 commit(s) not pushed or merged"
        );
        assert_eq!(
            LossSummary {
                dirty: false,
                unmerged: None
            }
            .describe(),
            "possibly-unsaved commits"
        );
    }

    #[tokio::test]
    async fn close_would_lose_clean_worktree_needs_no_confirmation() {
        let root = temp_dir("loss-clean");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();

        let loss = super::close_would_lose(&base, &path, thread).await.unwrap();
        assert!(!loss.dirty);
        assert_eq!(loss.unmerged, Some(0));
        assert!(!loss.needs_confirmation());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn close_would_lose_flags_uncommitted_changes() {
        let root = temp_dir("loss-dirty");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        std::fs::write(path.join("scratch.txt"), "wip").unwrap();

        let loss = super::close_would_lose(&base, &path, thread).await.unwrap();
        assert!(loss.dirty, "untracked file should read as dirty");
        assert!(loss.needs_confirmation());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn close_would_lose_counts_unmerged_commits() {
        let root = temp_dir("loss-unmerged");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        std::fs::write(path.join("work.txt"), "wip").unwrap();
        git(&path, &["config", "user.email", "test@pico"]);
        git(&path, &["config", "user.name", "pico test"]);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "wip"]);

        let loss = super::close_would_lose(&base, &path, thread).await.unwrap();
        assert!(!loss.dirty, "a committed tree is clean");
        assert_eq!(loss.unmerged, Some(1));
        assert!(loss.needs_confirmation());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn close_would_lose_treats_pushed_commits_as_safe() {
        let root = temp_dir("loss-pushed");
        let base = base_repo_with_origin(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "origin/main")
            .await
            .unwrap();
        // Push the branch (opening a PR): its commit never lands in trunk — the squash-merge case the old `trunk..branch` range falsely flagged.
        std::fs::write(path.join("work.txt"), "wip").unwrap();
        git(&path, &["config", "user.email", "test@pico"]);
        git(&path, &["config", "user.name", "pico test"]);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "wip"]);
        let branch = super::branch_name(thread);
        git(&path, &["push", "origin", &branch]);

        let loss = super::close_would_lose(&base, &path, thread).await.unwrap();
        assert_eq!(loss.unmerged, Some(0), "pushed commits must read as safe");
        assert!(!loss.needs_confirmation());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn close_would_lose_treats_merged_commits_as_safe() {
        let root = temp_dir("loss-merged");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        std::fs::write(path.join("work.txt"), "wip").unwrap();
        git(&path, &["config", "user.email", "test@pico"]);
        git(&path, &["config", "user.name", "pico test"]);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "wip"]);
        // Fast-forward base trunk (HEAD) onto the branch tip: now reachable from HEAD ⇒ safe.
        git(&base, &["merge", "--ff-only", &super::branch_name(thread)]);

        let loss = super::close_would_lose(&base, &path, thread).await.unwrap();
        assert_eq!(loss.unmerged, Some(0), "commits merged into trunk are safe");
        assert!(!loss.needs_confirmation());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn close_would_lose_fails_closed_when_count_uncomputable() {
        let root = temp_dir("loss-failclosed");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        // Point base HEAD at an unborn branch so `rev-list … HEAD` errors while
        // pico/<thread> still resolves: an uncomputable count must fail closed (confirm).
        git(&base, &["symbolic-ref", "HEAD", "refs/heads/does-not-exist"]);

        let loss = super::close_would_lose(&base, &path, thread).await.unwrap();
        assert_eq!(loss.unmerged, None, "uncomputable count must fail closed");
        assert!(loss.needs_confirmation());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn remove_deletes_worktree_and_branch_idempotently() {
        let root = temp_dir("remove");
        let base = local_repo(&root);
        let wt_dir = root.join("worktrees");
        let (channel, thread) = ("111111111111111111", "222222222222222222");
        let path = super::ensure(&wt_dir, channel, thread, &base, "main").await.unwrap();
        assert!(path.join(".git").exists());

        super::remove(&base, &path, thread).await.unwrap();
        assert!(!path.exists(), "worktree dir should be gone");
        assert!(
            !super::branch_exists(&base, &super::branch_name(thread)).await.unwrap(),
            "branch should be deleted"
        );

        super::remove(&base, &path, thread).await.unwrap();
        std::fs::remove_dir_all(&root).ok();
    }
}
