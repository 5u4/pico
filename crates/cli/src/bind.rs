use std::path::PathBuf;

use clap::Args;
use pico_core::bindings::{self, Binding, BindingKind, DEFAULT_BRANCH, DEFAULT_BRANCH_PREFIX};

const PLATFORM: &str = "cli";

#[derive(Args)]
pub struct BindArgs {
    #[arg(long)]
    profile: Option<String>,
    #[arg(long, value_name = "BASE_REPO")]
    worktree: Option<PathBuf>,
    #[arg(long, requires = "worktree")]
    branch: Option<String>,
    #[arg(long, value_name = "BRANCH_PREFIX", requires = "worktree")]
    branch_prefix: Option<String>,
    #[arg(long, conflicts_with_all = ["worktree", "branch", "branch_prefix", "profile", "show"])]
    unset: bool,
    #[arg(long, conflicts_with_all = ["worktree", "branch", "branch_prefix", "profile", "unset"])]
    show: bool,
}

pub async fn run(args: BindArgs) -> color_eyre::Result<()> {
    let dir = crate::thread::current_dir()?;
    let channel = crate::thread::channel_id(&dir);
    let root = pico_shared::paths::worker_root()?;
    let db = crate::thread::open_db(&root).await?;

    if args.show {
        return show(&db, &channel).await;
    }
    if args.unset {
        if bindings::unset(&db, PLATFORM, &channel).await? {
            println!("unbound {channel}");
        } else {
            println!("no binding for {channel}");
        }
        return Ok(());
    }

    let profile = args
        .profile
        .unwrap_or_else(|| pico_shared::paths::DEFAULT_PROFILE.to_owned());
    match args.worktree {
        Some(base_repo) => {
            let branch = args.branch.unwrap_or_else(|| DEFAULT_BRANCH.to_owned());
            let branch_prefix = args.branch_prefix.unwrap_or_else(|| DEFAULT_BRANCH_PREFIX.to_owned());
            bindings::set_worktree(&db, PLATFORM, &channel, &profile, &base_repo, &branch, &branch_prefix).await?;
            println!("bound {channel}");
            println!("  profile: {profile}");
            println!("  worktree: base_repo {}, default_branch {branch}", base_repo.display());
            println!("  branch_prefix: {branch_prefix}");
        }
        None => {
            bindings::set_regular(&db, PLATFORM, &channel, &profile, &dir).await?;
            println!("bound {channel}");
            println!("  profile: {profile}");
            println!("  regular cwd: {}", dir.display());
        }
    }
    Ok(())
}

async fn show(db: &sqlx::SqlitePool, channel: &str) -> color_eyre::Result<()> {
    match bindings::get(db, PLATFORM, channel).await? {
        Some(Binding { profile, kind }) => {
            println!("binding for {channel}");
            println!("  profile: {profile}");
            match kind {
                BindingKind::Regular { cwd } => println!("  regular cwd: {}", cwd.display()),
                BindingKind::Worktree {
                    base_repo,
                    default_branch,
                    branch_prefix,
                } => println!(
                    "  worktree: base_repo {}, default_branch {default_branch}, branch_prefix {branch_prefix}",
                    base_repo.display()
                ),
            }
        }
        None => println!("no binding for {channel}"),
    }
    Ok(())
}
