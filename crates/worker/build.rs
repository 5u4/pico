use std::process::Command;

/// Embed `PICO_VERSION` = `<pkg>+<sha>` / `+<sha>-dirty` / `+unknown`; never fails the build.
fn main() {
    let version = git_version().unwrap_or_else(|| "unknown".to_owned());
    let pkg = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    println!("cargo:rustc-env=PICO_VERSION={pkg}+{version}");
    // `--git-path` resolves HEAD/reflog inside a linked worktree too (where `.git`
    // is a file); logs/HEAD moves on every commit, so the embedded sha refreshes.
    for path in [
        git(&["rev-parse", "--git-path", "HEAD"]),
        git(&["rev-parse", "--git-path", "logs/HEAD"]),
    ]
    .into_iter()
    .flatten()
    {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn git_version() -> Option<String> {
    let sha = git(&["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty())?;
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    Some(if dirty { format!("{sha}-dirty") } else { sha })
}
