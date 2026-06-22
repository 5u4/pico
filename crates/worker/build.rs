use std::process::Command;

fn main() {
    let version = git_version().unwrap_or_else(|| "unknown".to_owned());
    let pkg = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    println!("cargo:rustc-env=PICO_VERSION={pkg}+{version}");
    for path in rerun_paths() {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn rerun_paths() -> Vec<String> {
    let mut paths = Vec::new();
    for target in ["HEAD", "logs/HEAD", "packed-refs"] {
        if let Some(path) = git_path(target) {
            paths.push(path);
        }
    }
    if let Some(branch) = git(&["symbolic-ref", "--quiet", "HEAD"]).filter(|s| !s.is_empty())
        && let Some(path) = git_path(&branch)
    {
        paths.push(path);
    }
    paths
}

fn git_path(target: &str) -> Option<String> {
    if let Some(path) =
        git(&["rev-parse", "--path-format=absolute", "--git-path", target]).filter(|s| !s.is_empty())
    {
        return Some(path);
    }
    let relative = git(&["rev-parse", "--git-path", target]).filter(|s| !s.is_empty())?;
    let absolute = std::env::current_dir().ok()?.join(relative);
    Some(absolute.to_string_lossy().into_owned())
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
