use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use pico_core::memory::{self, HindsightDaemon, MemoryConfig};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

fn load_env() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env.e2e");
    let _ = dotenvy::from_path(path);
}

fn docker_available() -> bool {
    Command::new("docker")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

struct Cleanup {
    container: String,
    root: PathBuf,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.container]).output();
        let _ = Command::new("docker")
            .args(["volume", "rm", "-f", &format!("{}-data", self.container)])
            .output();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
#[ignore]
async fn hindsight_daemon_retain_recall_roundtrip() {
    load_env();
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }
    if memory::omp_copilot_token().await.is_none() {
        eprintln!("skip: no omp github-copilot token (log omp into Copilot first)");
        return;
    }

    let root = std::env::temp_dir().join(format!("pico-mem-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("mkdir root");

    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let daemon = HindsightDaemon::new(&root, cancel.clone(), &tracker).await;
    let _cleanup = Cleanup {
        container: daemon.container().to_owned(),
        root: root.clone(),
    };

    let deadline = Instant::now() + Duration::from_secs(300);
    let mut endpoint = None;
    while Instant::now() < deadline {
        if let Some(ep) = daemon.ensure_endpoint().await {
            endpoint = Some(ep);
            break;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let endpoint = endpoint.expect("hindsight daemon never produced a healthy endpoint");

    let cfg = MemoryConfig {
        endpoint,
        bank: format!("pico-e2e-{}", std::process::id()),
        recall_budget: "mid".to_owned(),
        recall_max_tokens: 1024,
    };
    let doc = format!("e2e-thread-{}", std::process::id());

    memory::retain(
        &cfg,
        &doc,
        "What's my favorite programming language?",
        "You've told me your favorite programming language is Rust.",
        vec!["e2e".to_owned()],
    )
    .await;

    let deadline = Instant::now() + Duration::from_secs(180);
    let mut found = None;
    while Instant::now() < deadline {
        if let Some(block) = memory::recall(&cfg, "favorite programming language").await
            && block.to_lowercase().contains("rust")
        {
            found = Some(block);
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    cancel.cancel();
    assert!(found.is_some(), "recall never returned the retained fact within timeout");
}
