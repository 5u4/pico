use std::{path::Path, process::Command};

fn main() {
    let ui_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");
    let dist_dir = ui_dir.join("dist");

    for rel in [
        "src",
        "index.html",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "vite.config.ts",
        "tsconfig.json",
    ] {
        println!("cargo:rerun-if-changed={}", ui_dir.join(rel).display());
    }

    if std::env::var_os("PICO_WEB_SKIP_UI_BUILD").is_some() {
        std::fs::create_dir_all(&dist_dir).expect("create dist placeholder");
        return;
    }

    let pnpm = which_pnpm();

    run(
        Command::new(&pnpm)
            .arg("install")
            .arg("--frozen-lockfile")
            .current_dir(&ui_dir),
        "pnpm install",
    );
    run(Command::new(&pnpm).arg("build").current_dir(&ui_dir), "pnpm build");

    assert!(
        dist_dir.join("index.html").is_file(),
        "pnpm build did not produce ui/dist/index.html"
    );
}

fn which_pnpm() -> String {
    std::env::var("PICO_PNPM").unwrap_or_else(|_| "pnpm".to_owned())
}

fn run(cmd: &mut Command, label: &str) {
    let status = cmd.status().unwrap_or_else(|e| panic!("failed to spawn {label}: {e}"));
    assert!(status.success(), "{label} failed with {status}");
}
