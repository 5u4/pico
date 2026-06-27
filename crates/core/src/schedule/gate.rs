use std::{path::Path, process::Stdio, time::Duration};

use tokio::io::AsyncReadExt;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Gate {
    Skip,
    Proceed { context: Option<String> },
    Failure { reason: String, stderr_tail: String },
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct RunCapture {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: Option<i32>,
}

#[derive(serde::Deserialize)]
struct GateJson {
    #[serde(default)]
    skip: bool,
    #[serde(default)]
    context: Option<String>,
}

const STDERR_TAIL_LIMIT: usize = 600;

const CAPTURE_LIMIT: usize = 256 * 1024;

pub(super) async fn run_script(script: Option<&str>, cwd: &Path, timeout: Duration) -> (Gate, RunCapture) {
    let Some(script) = script else {
        return (Gate::Proceed { context: None }, RunCapture::default());
    };
    let mut command = tokio::process::Command::new("bash");
    command
        .arg("-lc")
        .arg(script)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return (
                Gate::Failure {
                    reason: format!("failed to spawn script: {e}"),
                    stderr_tail: String::new(),
                },
                RunCapture::default(),
            );
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let collected = tokio::time::timeout(timeout, async {
        tokio::join!(drain_capped(stdout), drain_capped(stderr), child.wait())
    })
    .await;
    let (stdout_bytes, stderr_bytes, status) = match collected {
        Ok(joined) => joined,
        Err(_) => {
            return (
                Gate::Failure {
                    reason: format!("script timed out after {}s", timeout.as_secs()),
                    stderr_tail: String::new(),
                },
                RunCapture::default(),
            );
        }
    };
    let status = match status {
        Ok(status) => status,
        Err(e) => {
            return (
                Gate::Failure {
                    reason: format!("script i/o error: {e}"),
                    stderr_tail: String::new(),
                },
                RunCapture {
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                    exit: None,
                },
            );
        }
    };
    let exit = status.code();
    let stderr_tail = tail(&String::from_utf8_lossy(&stderr_bytes));
    let gate = if status.success() {
        classify(&String::from_utf8_lossy(&stdout_bytes), stderr_tail)
    } else {
        let code = exit.map(|c| c.to_string()).unwrap_or_else(|| "signal".to_owned());
        Gate::Failure {
            reason: format!("script exited with status {code}"),
            stderr_tail,
        }
    };
    (
        gate,
        RunCapture {
            stdout: stdout_bytes,
            stderr: stderr_bytes,
            exit,
        },
    )
}

async fn drain_capped<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>) -> Vec<u8> {
    let Some(mut reader) = reader else {
        return Vec::new();
    };
    let mut captured = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if captured.len() < CAPTURE_LIMIT {
                    let room = CAPTURE_LIMIT - captured.len();
                    captured.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    }
    captured
}

fn classify(stdout: &str, stderr_tail: String) -> Gate {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Gate::Skip;
    }
    match serde_json::from_str::<GateJson>(trimmed) {
        Ok(parsed) if parsed.skip => Gate::Skip,
        Ok(parsed) => match parsed.context {
            Some(context) if !context.trim().is_empty() => Gate::Proceed { context: Some(context) },
            _ => Gate::Proceed { context: None },
        },
        Err(e) => Gate::Failure {
            reason: format!("script stdout is not valid gate json: {e}"),
            stderr_tail,
        },
    }
}

fn tail(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.len() <= STDERR_TAIL_LIMIT {
        return trimmed.to_owned();
    }
    let mut start = trimmed.len() - STDERR_TAIL_LIMIT;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    trimmed[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    #[tokio::test]
    async fn no_script_proceeds_without_context() {
        let (gate, capture) = run_script(None, &cwd(), Duration::from_secs(5)).await;
        assert_eq!(gate, Gate::Proceed { context: None });
        assert_eq!(capture, RunCapture::default());
    }

    #[tokio::test]
    async fn empty_stdout_skips() {
        let (gate, _) = run_script(Some("true"), &cwd(), Duration::from_secs(5)).await;
        assert_eq!(gate, Gate::Skip);
    }

    #[tokio::test]
    async fn skip_true_json_skips() {
        let (gate, _) = run_script(Some("echo '{\"skip\":true}'"), &cwd(), Duration::from_secs(5)).await;
        assert_eq!(gate, Gate::Skip);
    }

    #[tokio::test]
    async fn skip_false_with_context_proceeds() {
        let (gate, _) = run_script(
            Some("echo '{\"skip\":false,\"context\":\"hello\"}'"),
            &cwd(),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            gate,
            Gate::Proceed {
                context: Some("hello".to_owned())
            }
        );
    }

    #[tokio::test]
    async fn skip_false_without_context_proceeds_empty() {
        let (gate, _) = run_script(Some("echo '{\"skip\":false}'"), &cwd(), Duration::from_secs(5)).await;
        assert_eq!(gate, Gate::Proceed { context: None });
    }

    #[tokio::test]
    async fn nonzero_exit_fails_with_stderr_tail() {
        let (gate, capture) = run_script(Some("echo oops 1>&2; exit 3"), &cwd(), Duration::from_secs(5)).await;
        match gate {
            Gate::Failure { reason, stderr_tail } => {
                assert!(reason.contains("status 3"), "reason: {reason}");
                assert!(stderr_tail.contains("oops"), "stderr: {stderr_tail}");
            }
            other => panic!("expected failure, got {other:?}"),
        }
        assert_eq!(capture.exit, Some(3));
        assert!(String::from_utf8_lossy(&capture.stderr).contains("oops"));
    }

    #[tokio::test]
    async fn exit_zero_non_json_fails() {
        let (gate, _) = run_script(Some("echo not-json-at-all"), &cwd(), Duration::from_secs(5)).await;
        assert!(matches!(gate, Gate::Failure { .. }), "got {gate:?}");
    }

    #[tokio::test]
    async fn timeout_fails() {
        let (gate, _) = run_script(Some("sleep 5"), &cwd(), Duration::from_millis(150)).await;
        match gate {
            Gate::Failure { reason, .. } => assert!(reason.contains("timed out"), "reason: {reason}"),
            other => panic!("expected timeout failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn oversized_stdout_is_bounded_and_completes() {
        let (gate, _) =
            run_script(Some("head -c 1000000 /dev/zero | tr '\\0' 'a'"), &cwd(), Duration::from_secs(5)).await;
        match gate {
            Gate::Failure { reason, .. } => assert!(
                reason.contains("not valid gate json"),
                "oversized stdout must drain to EOF and classify, not hang: {reason}"
            ),
            other => panic!("expected classify failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn capture_returns_stdout_and_zero_exit() {
        let (gate, capture) = run_script(Some("echo '{\"skip\":true}'"), &cwd(), Duration::from_secs(5)).await;
        assert_eq!(gate, Gate::Skip);
        assert!(String::from_utf8_lossy(&capture.stdout).contains("skip"));
        assert_eq!(capture.exit, Some(0));
    }
}
