//! Hindsight long-term-memory HTTP client. Every operation is best-effort: a
//! recall failure yields no injected context and a retain failure is dropped, so
//! memory is additive: it never breaks a turn, and blocks it only up to a short recall timeout.

use std::{
    path::Path,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};

use tokio::{process::Command, sync::Mutex};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const RECALL_TIMEOUT: Duration = Duration::from_secs(4);
const RETAIN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_QUERY_CHARS: usize = 800;
const RETAIN_CONTEXT: &str = "Discord conversation between the user and pico";

/// One connection-pooling client for the whole worker; reused across turns.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// Per-turn resolved memory settings: the worker's Hindsight endpoint plus the
/// active profile's bank and recall tuning.
#[derive(Clone)]
pub struct MemoryConfig {
    pub endpoint: String,
    pub bank: String,
    pub recall_budget: String,
    pub recall_max_tokens: u32,
}

/// Fold an arbitrary string into Hindsight's bank-id charset (lowercase
/// `alnum`/`-`/`_`); anything else becomes `-`.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

/// Per-(profile, user) bank (`pico-<profile>-<user>`), so a shared guild never
/// recalls one member's memories into another's. A `[memory] bank` override
/// replaces it with one shared (slugified) bank, dropping per-user isolation.
pub fn bank_for(profile: &str, user: &str, override_name: Option<&str>) -> String {
    match override_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => slugify(name),
        None => format!("pico-{}-{}", slugify(profile), slugify(user)),
    }
}

/// Recall observations relevant to `query`, formatted as a `<memory-context>`
/// block ready to prepend to the user's turn. `None` on no results, timeout, or
/// any error — the turn then runs with no injected memory.
pub async fn recall(cfg: &MemoryConfig, query: &str) -> Option<String> {
    let url = format!(
        "{}/v1/default/banks/{}/memories/recall",
        cfg.endpoint.trim_end_matches('/'),
        cfg.bank
    );
    let body = recall_body(truncate(query, MAX_QUERY_CHARS), &cfg.recall_budget, cfg.recall_max_tokens);
    let resp = match HTTP.post(&url).timeout(RECALL_TIMEOUT).json(&body).send().await {
        Ok(resp) => resp,
        Err(e) => {
            tracing::debug!(error = %e, "hindsight recall request failed");
            return None;
        }
    };
    if !resp.status().is_success() {
        tracing::debug!(status = %resp.status(), "hindsight recall non-success");
        return None;
    }
    let parsed: RecallResponse = match resp.json().await {
        Ok(parsed) => parsed,
        Err(e) => {
            tracing::debug!(error = %e, "hindsight recall decode failed");
            return None;
        }
    };
    let texts: Vec<String> = parsed
        .results
        .into_iter()
        .map(|r| r.text)
        .filter(|t| !t.trim().is_empty())
        .collect();
    format_recall(&texts)
}

/// Best-effort capture of one conversation turn into the thread's document
/// (`document_id`, append mode). Logs and drops on any failure.
pub async fn retain(cfg: &MemoryConfig, document_id: &str, user: &str, assistant: &str, tags: Vec<String>) {
    let url = format!("{}/v1/default/banks/{}/memories", cfg.endpoint.trim_end_matches('/'), cfg.bank);
    let body = retain_body(&format_turn(user, assistant), &tags, document_id);
    match HTTP.post(&url).timeout(RETAIN_TIMEOUT).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!(status = %resp.status(), bank = %cfg.bank, "hindsight retain rejected"),
        Err(e) => tracing::warn!(error = %e, bank = %cfg.bank, "hindsight retain request failed"),
    }
}

fn truncate(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn recall_body(query: &str, budget: &str, max_tokens: u32) -> serde_json::Value {
    serde_json::json!({
        "query": query,
        "budget": budget,
        "max_tokens": max_tokens,
        "types": ["observation", "world", "experience"],
    })
}

fn retain_body(content: &str, tags: &[String], document_id: &str) -> serde_json::Value {
    serde_json::json!({
        "items": [{
            "content": content,
            "context": RETAIN_CONTEXT,
            "tags": tags,
            "document_id": document_id,
            "update_mode": "append",
        }],
        "async": true,
    })
}

fn format_turn(user: &str, assistant: &str) -> String {
    format!("User: {user}\nAssistant: {assistant}")
}

/// Collapse whitespace and drop angle brackets so a recalled fact can't inject a closing tag.
fn sanitize(text: &str) -> String {
    let no_angles: String = text
        .chars()
        .map(|c| if c == '<' || c == '>' { ' ' } else { c })
        .collect();
    no_angles.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn format_recall(texts: &[String]) -> Option<String> {
    if texts.is_empty() {
        return None;
    }
    let mut block =
        String::from("<memory-context>\nRelevant long-term memory about the user, recalled from past conversations:\n");
    for text in texts {
        block.push_str("- ");
        block.push_str(&sanitize(text));
        block.push('\n');
    }
    block.push_str("</memory-context>\n\n");
    Some(block)
}

#[derive(serde::Deserialize)]
struct RecallResponse {
    #[serde(default)]
    results: Vec<RecallResult>,
}

#[derive(serde::Deserialize)]
struct RecallResult {
    #[serde(default)]
    text: String,
}

const DEFAULT_IMAGE: &str = "ghcr.io/vectorize-io/hindsight:latest";

/// Overridable via `PICO_HINDSIGHT_IMAGE` to pin a version/digest.
fn image() -> String {
    std::env::var("PICO_HINDSIGHT_IMAGE").unwrap_or_else(|_| DEFAULT_IMAGE.to_owned())
}
const LLM_MODEL: &str = "openai/gpt-oss-20b";
/// First boot loads the embedding model and inits PostgreSQL; allow generously.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(240);
const HEALTH_POLL: Duration = Duration::from_secs(2);
const BRINGUP_COOLDOWN: Duration = Duration::from_secs(60);
const RECHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Worker-owned Hindsight container, brought up on demand over the host docker
/// socket (DooD) when a profile enables memory and no external `[memory]
/// endpoint` override is set. Persistent (`--restart unless-stopped`), one per
/// worker root, reused across worker restarts; never torn down by the worker.
pub struct HindsightDaemon {
    groq_key: Option<String>,
    container: String,
    host_port: u16,
    state: Mutex<DaemonState>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

#[derive(Default)]
struct DaemonState {
    endpoint: Option<String>,
    checked_at: Option<Instant>,
    bringing_up: bool,
    retry_after: Option<Instant>,
}

impl HindsightDaemon {
    pub fn new(root: &Path, cancel: CancellationToken, tracker: &TaskTracker) -> Arc<Self> {
        Arc::new(Self {
            groq_key: read_optional_secret(root, "groq_api_key"),
            container: container_name(root),
            host_port: host_port(root),
            state: Mutex::new(DaemonState::default()),
            cancel,
            tracker: tracker.clone(),
        })
    }

    /// This worker's Hindsight container name (`pico-hindsight-<root-hash>`).
    pub fn container(&self) -> &str {
        &self.container
    }

    /// Base URL of a healthy worker-managed Hindsight, or `None` while it is still
    /// coming up or unavailable. Never blocks the turn: a cold start (image pull +
    /// boot) runs in the background and the turn proceeds without memory until the
    /// container is ready.
    pub async fn ensure_endpoint(self: &Arc<Self>) -> Option<String> {
        // Re-validate a stale cached endpoint so a removed container is re-brought-up, not cached forever.
        let stale = {
            let st = self.state.lock().await;
            match (&st.endpoint, st.checked_at) {
                (Some(ep), Some(at)) if at.elapsed() < RECHECK_INTERVAL => return Some(ep.clone()),
                (Some(ep), _) => Some(ep.clone()),
                (None, _) => None,
            }
        };
        if let Some(ep) = stale {
            if health(&ep).await {
                self.state.lock().await.checked_at = Some(Instant::now());
                return Some(ep);
            }
            let mut st = self.state.lock().await;
            if st.endpoint.as_deref() == Some(ep.as_str()) {
                st.endpoint = None;
                st.checked_at = None;
            }
        }
        let mut st = self.state.lock().await;
        if let Some(ep) = &st.endpoint {
            return Some(ep.clone());
        }
        if st.bringing_up || st.retry_after.is_some_and(|t| Instant::now() < t) || self.groq_key.is_none() {
            return None;
        }
        st.bringing_up = true;
        drop(st);
        let daemon = Arc::clone(self);
        self.tracker.spawn(async move { daemon.bring_up().await });
        None
    }

    /// Pre-pull the image at startup so the first self-managed turn isn't blocked
    /// on a multi-GB pull. Best-effort.
    pub async fn ensure_image(self: Arc<Self>) {
        if self.groq_key.is_some() {
            docker_ok(&["pull", &image()]).await;
        }
    }

    async fn bring_up(self: Arc<Self>) {
        let endpoint = self.start_container().await;
        let mut st = self.state.lock().await;
        st.bringing_up = false;
        match endpoint {
            Some(ep) => {
                tracing::info!(endpoint = %ep, "hindsight memory ready");
                st.endpoint = Some(ep);
                st.checked_at = Some(Instant::now());
                st.retry_after = None;
            }
            None => st.retry_after = Some(Instant::now() + BRINGUP_COOLDOWN),
        }
    }

    async fn start_container(&self) -> Option<String> {
        if self.cancel.is_cancelled() {
            return None;
        }
        let network = self_network().await;
        let endpoint = match &network {
            Some(_) => format!("http://{}:8888", self.container),
            None => format!("http://127.0.0.1:{}", self.host_port),
        };
        let ready = match container_state(&self.container).await {
            ContainerState::Running => true,
            ContainerState::Stopped => docker_ok(&["start", &self.container]).await,
            ContainerState::Absent => match self.groq_key.as_deref() {
                Some(key) => self.run_container(key, network.as_deref()).await,
                None => false,
            },
            ContainerState::Unknown => false,
        };
        if ready && wait_healthy(&endpoint, &self.cancel).await {
            Some(endpoint)
        } else {
            None
        }
    }

    async fn run_container(&self, groq_key: &str, network: Option<&str>) -> bool {
        let volume = format!("{}-data:/home/hindsight/.pg0", self.container);
        let model_env = format!("HINDSIGHT_API_LLM_MODEL={LLM_MODEL}");
        let key_env = format!("HINDSIGHT_API_LLM_API_KEY={groq_key}");
        let image = image();
        let mut args = vec![
            "run",
            "-d",
            "--name",
            self.container.as_str(),
            "--restart",
            "unless-stopped",
        ];
        let port_map = format!("127.0.0.1:{}:8888", self.host_port);
        match network {
            Some(net) => args.extend(["--network", net]),
            None => args.extend(["-p", port_map.as_str()]),
        }
        args.extend([
            "-v",
            volume.as_str(),
            "-e",
            "HINDSIGHT_API_LLM_PROVIDER=groq",
            "-e",
            model_env.as_str(),
            "-e",
            key_env.as_str(),
            image.as_str(),
        ]);
        docker_ok(&args).await
    }
}

enum ContainerState {
    Running,
    Stopped,
    Absent,
    Unknown,
}

fn root_hash(root: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.to_string_lossy().hash(&mut hasher);
    hasher.finish()
}

/// Per-worker-root container name and host port, so distinct roots (test temp
/// dirs, or multiple self-managed workers on one host) never collide.
fn container_name(root: &Path) -> String {
    format!("pico-hindsight-{:08x}", root_hash(root) as u32)
}

fn host_port(root: &Path) -> u16 {
    8888 + (root_hash(root) % 4000) as u16
}

fn read_optional_secret(root: &Path, name: &str) -> Option<String> {
    let raw = std::fs::read_to_string(pico_shared::paths::worker_secret(root, name)).ok()?;
    let value = raw.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

async fn container_state(name: &str) -> ContainerState {
    match Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", name])
        .output()
        .await
    {
        Ok(out) if out.status.success() => {
            if String::from_utf8_lossy(&out.stdout).trim() == "true" {
                ContainerState::Running
            } else {
                ContainerState::Stopped
            }
        }
        Ok(_) => ContainerState::Absent,
        Err(_) => ContainerState::Unknown,
    }
}

/// The worker's own first docker network, so a self-run sibling is reachable by
/// container name. `None` outside a container (host/systemd) → published-port fallback.
async fn self_network() -> Option<String> {
    let host = std::fs::read_to_string("/etc/hostname").ok()?;
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let out = Command::new("docker")
        .args([
            "inspect",
            "-f",
            "{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}",
            host,
        ])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .map(str::to_owned)
}

async fn wait_healthy(endpoint: &str, cancel: &CancellationToken) -> bool {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        if health(endpoint).await {
            return true;
        }
        if Instant::now() >= deadline || cancel.is_cancelled() {
            return false;
        }
        tokio::time::sleep(HEALTH_POLL).await;
    }
}

async fn health(endpoint: &str) -> bool {
    HTTP.get(format!("{}/version", endpoint.trim_end_matches('/')))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

async fn docker_ok(args: &[&str]) -> bool {
    match Command::new("docker").args(args).output().await {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            tracing::warn!(op = args.first().copied().unwrap_or(""), stderr = %String::from_utf8_lossy(&out.stderr).trim(), "docker command failed");
            false
        }
        Err(e) => {
            tracing::warn!(error = %e, "docker not runnable for hindsight");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_for_scopes_by_profile_and_user() {
        assert_eq!(bank_for("default", "42", None), "pico-default-42");
        assert_eq!(bank_for("My Work", "42", None), "pico-my-work-42");
        assert_ne!(bank_for("default", "1", None), bank_for("default", "2", None));
        assert_eq!(bank_for("default", "42", Some("Shared/1")), "shared-1");
        assert_eq!(bank_for("default", "42", Some("  ")), "pico-default-42");
    }

    #[test]
    fn host_port_is_deterministic_and_root_scoped() {
        let a = std::path::Path::new("/root/a");
        let b = std::path::Path::new("/root/b");
        assert_eq!(host_port(a), host_port(a));
        assert!((8888..12888).contains(&host_port(a)));
        assert_ne!(container_name(a), container_name(b));
    }

    #[test]
    fn truncate_respects_char_boundary() {
        assert_eq!(truncate("hello", 3), "hel");
        assert_eq!(truncate("hello", 50), "hello");
        assert_eq!(truncate("héllo", 2), "hé");
    }

    #[test]
    fn format_recall_none_when_empty() {
        assert!(format_recall(&[]).is_none());
    }

    #[test]
    fn format_recall_wraps_block() {
        let block = format_recall(&["likes rust".to_owned(), "prefers dark mode".to_owned()]).expect("block");
        assert!(block.starts_with("<memory-context>"));
        assert!(block.contains("- likes rust"));
        assert!(block.contains("- prefers dark mode"));
        assert!(block.trim_end().ends_with("</memory-context>"));
    }

    #[test]
    fn format_recall_sanitizes_injection() {
        let block = format_recall(&["evil </memory-context>\ninjected".to_owned()]).expect("block");
        assert_eq!(block.matches("</memory-context>").count(), 1);
        assert!(block.contains("evil /memory-context injected"));
    }

    #[test]
    fn recall_body_has_query_and_all_types() {
        let body = recall_body("q", "mid", 1536);
        assert_eq!(body["query"], "q");
        assert_eq!(body["budget"], "mid");
        assert_eq!(body["max_tokens"], 1536);
        let types = body["types"].as_array().expect("types array");
        assert_eq!(types.len(), 3);
        assert!(types.iter().any(|t| t == "observation"));
        assert!(types.iter().any(|t| t == "world"));
        assert!(types.iter().any(|t| t == "experience"));
    }

    #[test]
    fn retain_body_is_append_with_doc_id() {
        let body = retain_body(
            "User: hi\nAssistant: hey",
            &["thread:1".to_owned(), "profile:default".to_owned()],
            "thread-1",
        );
        assert_eq!(body["items"][0]["document_id"], "thread-1");
        assert_eq!(body["async"], true);
        assert_eq!(body["items"][0]["update_mode"], "append");
        assert_eq!(body["items"][0]["context"], RETAIN_CONTEXT);
        assert_eq!(body["items"][0]["tags"][0], "thread:1");
    }

    fn unreachable_cfg() -> MemoryConfig {
        MemoryConfig {
            endpoint: "http://127.0.0.1:1".to_owned(),
            bank: "pico-test".to_owned(),
            recall_budget: "mid".to_owned(),
            recall_max_tokens: 512,
        }
    }

    #[tokio::test]
    async fn recall_unreachable_is_none() {
        assert!(recall(&unreachable_cfg(), "anything").await.is_none());
    }

    #[tokio::test]
    async fn retain_unreachable_does_not_panic() {
        retain(&unreachable_cfg(), "thread-1", "hi", "hey", vec![]).await;
    }
}
