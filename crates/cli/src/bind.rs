use std::path::PathBuf;

use clap::Args;
use pico_core::bindings::{self, Binding, BindingKind, DEFAULT_BRANCH};

const PLATFORM: &str = "cli";
const DEFAULT_PROFILE: &str = "default";

#[derive(Args)]
pub struct BindArgs {
    #[arg(long)]
    profile: Option<String>,
    #[arg(long, value_name = "BASE_REPO")]
    worktree: Option<PathBuf>,
    #[arg(long, requires = "worktree")]
    branch: Option<String>,
    #[arg(long, conflicts_with_all = ["worktree", "branch", "profile", "show"])]
    unset: bool,
    #[arg(long, conflicts_with_all = ["worktree", "branch", "profile", "unset"])]
    show: bool,
}

pub async fn run(args: BindArgs) -> color_eyre::Result<()> {
    let dir = crate::chat::current_dir()?;
    let channel = crate::chat::channel_id(&dir);
    let root = pico_shared::paths::worker_root()?;
    let db = crate::chat::open_db(&root).await?;

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

    let profile = args.profile.unwrap_or_else(|| DEFAULT_PROFILE.to_owned());
    match args.worktree {
        Some(base_repo) => {
            let branch = args.branch.unwrap_or_else(|| DEFAULT_BRANCH.to_owned());
            bindings::set_worktree(&db, PLATFORM, &channel, &profile, &base_repo, &branch).await?;
            println!("bound {channel}");
            println!("  profile: {profile}");
            println!("  worktree: base_repo {}, default_branch {branch}", base_repo.display());
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
                } => println!("  worktree: base_repo {}, default_branch {default_branch}", base_repo.display()),
            }
        }
        None => println!("no binding for {channel}"),
    }
    Ok(())
}
