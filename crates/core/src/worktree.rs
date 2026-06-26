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

static CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn branch_name(thread_id: &str) -> String {
    format!("pico/{thread_id}")
}

fn safe_component(channel_id: &str) -> String {
    let mapped: String = channel_id
        .chars()
        .map(|c| if std::path::is_separator(c) || c == ':' { '_' } else { c })
        .collect();
    let trimmed = mapped.trim_start_matches('_');
    if trimmed.is_empty() {
        "_".to_owned()
    } else {
        trimmed.to_owned()
    }
}

pub fn worktree_path(worktrees_dir: &Path, channel_id: &str, thread_id: &str) -> PathBuf {
    worktrees_dir.join(safe_component(channel_id)).join(thread_id)
}

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

    run_git(base_repo, ["worktree", "prune"], GIT_TIMEOUT)
        .await
        .wrap_err("git worktree prune")?;
    if default_branch.starts_with("origin/")
        && let Err(e) = run_git(base_repo, ["fetch", "origin"], FETCH_TIMEOUT).await
    {
        tracing::warn!(error = %format!("{e:#}"), %default_branch, "git fetch origin failed; forking possibly-stale ref");
    }

    let branch = branch_name(thread_id);
    if branch_exists(base_repo, &branch).await? {
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
    tracing::debug!(thread_id, "created worktree");
    Ok(())
}

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

pub struct LossSummary {
    pub dirty: bool,
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

pub async fn close_would_lose(base_repo: &Path, worktree: &Path, thread_id: &str) -> color_eyre::Result<LossSummary> {
    let dirty = if worktree.join(".git").exists() {
        let out = git_output(worktree, ["status", "--porcelain"], GIT_TIMEOUT).await?;
        !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    } else {
        false
    };
    let branch = branch_name(thread_id);
    let unmerged = if branch_exists(base_repo, &branch).await? {
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
    tracing::debug!(thread_id, "removed worktree");
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

pub async fn run_git<I, S>(repo: &Path, args: I, timeout: Duration) -> color_eyre::Result<()>
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

    #[test]
    fn worktree_path_keeps_path_channel_under_worktrees_dir() {
        let wt = Path::new("/srv/worktrees");
        let numeric = super::worktree_path(wt, "111111111111111111", "abc");
        assert_eq!(numeric, wt.join("111111111111111111").join("abc"));

        let abs = super::worktree_path(wt, "/home/sen/project", "abc");
        assert!(abs.starts_with(wt), "absolute channel escaped worktrees_dir: {}", abs.display());
        assert_eq!(abs, wt.join("home_sen_project").join("abc"));
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

        assert!(super::validate_base_repo(&root, "origin/main").await.is_err());

        let no_origin = root.join("no-origin");
        std::fs::create_dir_all(&no_origin).unwrap();
        git(&no_origin, &["init", "-b", "main"]);
        assert!(super::validate_base_repo(&no_origin, "origin/main").await.is_err());
        assert!(super::validate_base_repo(&no_origin, "main").await.is_ok());

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
        std::fs::write(path.join("work.txt"), "wip").unwrap();
        git(&path, &["config", "user.email", "test@pico"]);
        git(&path, &["config", "user.name", "pico test"]);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "wip"]);
        std::fs::remove_dir_all(&path).unwrap();

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
