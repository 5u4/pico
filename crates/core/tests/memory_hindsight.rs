//! Live Hindsight round-trip: boots a throwaway hindsight container driven by
//! Groq (`E2E_GROQ_KEY` from `.env.e2e`), then retains a fact and recalls it
//! through `pico_core::memory`. `#[ignore]`d; skips cleanly when docker or the
//! key is absent. Run with `cargo test -p pico-core --test memory_hindsight -- --ignored`.

use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

use pico_core::memory::{self, MemoryConfig};

const PORT: u16 = 18888;
const IMAGE: &str = "ghcr.io/vectorize-io/hindsight:latest";

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

/// Removes the container on drop so a panicking assertion never leaks it.
struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.0]).output();
    }
}

/// Bridge IP of a running container. Lets a docker-in-docker test reach a
/// sibling that published its port to the shared docker host, not to us.
fn container_ip(name: &str) -> Option<String> {
    let out = Command::new("docker")
        .args([
            "inspect",
            "-f",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
            name,
        ])
        .output()
        .ok()?;
    let ip = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !ip.is_empty()).then_some(ip)
}

/// Poll candidate base URLs until one serves `/version`; returns the live one.
async fn wait_healthy(bases: &[String], timeout: Duration) -> Option<String> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        for base in bases {
            if let Ok(resp) = client
                .get(format!("{base}/version"))
                .timeout(Duration::from_secs(5))
                .send()
                .await
                && resp.status().is_success()
            {
                return Some(base.clone());
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    None
}

#[tokio::test]
#[ignore]
async fn hindsight_retain_recall_roundtrip() {
    load_env();
    let Ok(groq_key) = std::env::var("E2E_GROQ_KEY") else {
        eprintln!("skip: E2E_GROQ_KEY not set in .env.e2e");
        return;
    };
    let groq_key = groq_key.trim().to_owned();
    if groq_key.is_empty() {
        eprintln!("skip: E2E_GROQ_KEY empty");
        return;
    }
    if !docker_available() {
        eprintln!("skip: docker not available");
        return;
    }

    let name = format!("pico-hindsight-e2e-{}", std::process::id());
    let out = Command::new("docker")
        .args([
            "run",
            "-d",
            "--rm",
            "--name",
            &name,
            "-p",
            &format!("{PORT}:8888"),
            "-e",
            "HINDSIGHT_API_LLM_PROVIDER=groq",
            "-e",
            "HINDSIGHT_API_LLM_MODEL=openai/gpt-oss-20b",
            "-e",
            &format!("HINDSIGHT_API_LLM_API_KEY={groq_key}"),
            IMAGE,
        ])
        .output()
        .expect("docker run");
    if !out.status.success() {
        eprintln!(
            "skip: docker run failed (image unavailable?): {}",
            String::from_utf8_lossy(&out.stderr)
        );
        return;
    }
    let _guard = Container(name.clone());

    // Bare host reaches the published port on localhost; a docker-in-docker
    // runner reaches the sibling by its bridge IP instead.
    let mut bases = vec![format!("http://127.0.0.1:{PORT}")];
    if let Some(ip) = container_ip(&name) {
        bases.insert(0, format!("http://{ip}:8888"));
    }
    let base = wait_healthy(&bases, Duration::from_secs(300))
        .await
        .unwrap_or_else(|| panic!("hindsight never became healthy on any of {bases:?}"));

    let cfg = MemoryConfig {
        endpoint: base,
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

    // Retain processes asynchronously server-side (extract + consolidate), so
    // poll recall until the fact surfaces or we time out.
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
    assert!(found.is_some(), "recall never returned the retained fact within timeout");
}
