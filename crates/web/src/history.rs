use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::proto::Bubble;

pub fn latest_session_file(session_dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(session_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if newest.as_ref().is_none_or(|(t, _)| modified > *t) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

pub fn replay(session_dir: &Path) -> (String, Vec<Bubble>) {
    let Some(path) = latest_session_file(session_dir) else {
        return (String::new(), Vec::new());
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return (String::new(), Vec::new());
    };
    let mut title = String::new();
    let mut bubbles = Vec::new();
    let mut id: u64 = 0;
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("title") => {
                if let Some(t) = value.get("title").and_then(|t| t.as_str())
                    && !t.trim().is_empty()
                {
                    title = t.trim().to_owned();
                }
            }
            Some("message") => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                let role = message.get("role").and_then(|r| r.as_str()).unwrap_or_default();
                if role != "user" && role != "assistant" {
                    continue;
                }
                let text = extract_text(message.get("content"));
                let text = if role == "user" {
                    if text.trim_end() == pico_core::prompt::CONTINUE_NUDGE.trim_end() {
                        ".".to_owned()
                    } else {
                        strip_wrapper(&text)
                    }
                } else {
                    text
                };
                if text.trim().is_empty() {
                    continue;
                }
                bubbles.push(Bubble {
                    id,
                    role: role.to_owned(),
                    text,
                });
                id += 1;
            }
            _ => {}
        }
    }
    (title, bubbles)
}

fn extract_text(content: Option<&serde_json::Value>) -> String {
    let Some(parts) = content.and_then(|c| c.as_array()) else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if part.get("type").and_then(|t| t.as_str()) == Some("text")
            && let Some(text) = part.get("text").and_then(|t| t.as_str())
        {
            out.push_str(text);
        }
    }
    out
}

fn strip_wrapper(text: &str) -> String {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("<web-message")
        && let Some(end) = rest.find("/>")
    {
        return rest[end + 2..].trim_start_matches('\n').to_owned();
    }
    text.to_owned()
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeThread {
    pub thread_id: String,
    pub title: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeChannel {
    pub channel_id: String,
    pub label: String,
    pub threads: Vec<TreeThread>,
}

pub fn thread_updated_at(session_dir: &Path) -> u64 {
    latest_session_file(session_dir)
        .and_then(|p| std::fs::metadata(&p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(dir: &Path, name: &str, lines: &[&str]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), lines.join("\n")).unwrap();
    }

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pico-web-history-{tag}-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replay_strips_user_wrapper_and_keeps_assistant() {
        let dir = tmp("basic");
        write_session(
            &dir,
            "a.jsonl",
            &[
                r#"{"type":"title","title":"My Chat"}"#,
                r#"{"type":"model_change","model":"x"}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"<web-message name=\"you\" sent_at=\"t\" />\nhello"}]}}"#,
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}]}}"#,
            ],
        );
        let (title, bubbles) = replay(&dir);
        assert_eq!(title, "My Chat");
        assert_eq!(bubbles.len(), 2);
        assert_eq!(bubbles[0].role, "user");
        assert_eq!(bubbles[0].text, "hello");
        assert_eq!(bubbles[1].role, "assistant");
        assert_eq!(bubbles[1].text, "hi there");
        assert_eq!(bubbles[0].id, 0);
        assert_eq!(bubbles[1].id, 1);
    }

    #[test]
    fn replay_normalizes_continue_nudge_to_dot() {
        let dir = tmp("nudge");
        let nudge = pico_core::prompt::CONTINUE_NUDGE.replace('\n', "\\n");
        write_session(
            &dir,
            "a.jsonl",
            &[&format!(
                r#"{{"type":"message","message":{{"role":"user","content":[{{"type":"text","text":"{nudge}"}}]}}}}"#
            )],
        );
        let (_title, bubbles) = replay(&dir);
        assert_eq!(bubbles.len(), 1);
        assert_eq!(bubbles[0].role, "user");
        assert_eq!(bubbles[0].text, ".");
    }

    #[test]
    fn replay_skips_empty_and_nonchat_lines() {
        let dir = tmp("skip");
        write_session(
            &dir,
            "a.jsonl",
            &[
                r#"{"type":"session","version":3}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"<web-message name=\"you\" sent_at=\"t\" />\n"}]}}"#,
                r#"{"type":"custom","customType":"session_exit"}"#,
                r#"not json"#,
            ],
        );
        let (title, bubbles) = replay(&dir);
        assert_eq!(title, "");
        assert!(bubbles.is_empty());
    }

    #[test]
    fn replay_prefers_newest_file() {
        let dir = tmp("newest");
        write_session(
            &dir,
            "old.jsonl",
            &[r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"old"}]}}"#],
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_session(
            &dir,
            "new.jsonl",
            &[r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"new"}]}}"#],
        );
        let (_title, bubbles) = replay(&dir);
        assert_eq!(bubbles.len(), 1);
        assert_eq!(bubbles[0].text, "new");
    }

    #[test]
    fn replay_absent_dir_is_empty() {
        let dir = std::env::temp_dir().join(format!("pico-web-absent-{}", ulid::Ulid::new()));
        let (title, bubbles) = replay(&dir);
        assert_eq!(title, "");
        assert!(bubbles.is_empty());
    }
}
