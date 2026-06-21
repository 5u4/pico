//! Hindsight long-term-memory HTTP client. Every operation is best-effort: a
//! recall failure yields no injected context and a retain failure is dropped, so
//! memory is purely additive and can never block or break a turn.

use std::{sync::LazyLock, time::Duration};

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

/// Resolve a profile's bank: the slugified `[memory] bank` override when set,
/// else the default `pico-<profile>`. Slugifying the override too means a value
/// with spaces/uppercase/slashes can't silently break the request URL.
pub fn bank_for(profile: &str, override_name: Option<&str>) -> String {
    match override_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => slugify(name),
        None => format!("pico-{}", slugify(profile)),
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

fn format_recall(texts: &[String]) -> Option<String> {
    if texts.is_empty() {
        return None;
    }
    let mut block =
        String::from("<memory-context>\nRelevant long-term memory about the user, recalled from past conversations:\n");
    for text in texts {
        block.push_str("- ");
        block.push_str(text.trim());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_for_slugifies_default_and_override() {
        assert_eq!(bank_for("default", None), "pico-default");
        assert_eq!(bank_for("My Work", None), "pico-my-work");
        assert_eq!(bank_for("a.b/c", None), "pico-a-b-c");
        assert_eq!(bank_for("default", Some("Shared Mem/1")), "shared-mem-1");
        assert_eq!(bank_for("default", Some("  ")), "pico-default");
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
