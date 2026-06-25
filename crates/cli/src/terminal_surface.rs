use std::io::{BufRead, IsTerminal, Write};

use parking_lot::Mutex;
use pico_core::{
    omp::protocol::{ToolCall, UiRequest},
    surface::{PostOpts, SizeLimits, Surface, UiOutcome, UiReply},
};

const ACTIVITY_CHAR_CAP: usize = 1_000_000;
const ACTIVITY_SEND_MAX: usize = 1_000_000;
const DETAIL_CAP: usize = 72;

pub struct Line {
    id: u64,
}

struct RenderState {
    next_id: u64,
    tail: Option<u64>,
    tail_rendered: String,
    parked: bool,
}

pub struct TerminalSurface {
    tty: bool,
    state: Mutex<RenderState>,
}

impl Default for TerminalSurface {
    fn default() -> Self {
        TerminalSurface::new()
    }
}

impl TerminalSurface {
    pub fn new() -> Self {
        TerminalSurface {
            tty: std::io::stdout().is_terminal(),
            state: Mutex::new(RenderState {
                next_id: 1,
                tail: None,
                tail_rendered: String::new(),
                parked: false,
            }),
        }
    }

    pub fn finish(&self) {
        let mut st = self.state.lock();
        if st.parked {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
        st.parked = false;
        st.tail = None;
        st.tail_rendered.clear();
    }

    fn dim(&self, text: &str) -> String {
        if self.tty {
            format!("\x1b[2m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    fn print_prompt(&self, text: &str) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }

    fn emit(&self, rendered: String, id: Option<u64>, rewrite_tail: Option<u64>) {
        let mut st = self.state.lock();
        let mut out = std::io::stdout().lock();
        if !self.tty {
            let _ = out.write_all(rendered.as_bytes());
            let _ = out.write_all(b"\n");
            let _ = out.flush();
            if let Some(id) = id {
                st.tail = Some(id);
            }
            return;
        }
        if rewrite_tail.is_some() && st.parked && st.tail == rewrite_tail {
            rewrite_in_place(&mut out, &st.tail_rendered, &rendered);
        } else {
            if st.parked {
                let _ = out.write_all(b"\n");
            }
            let _ = out.write_all(rendered.as_bytes());
        }
        let _ = out.flush();
        st.parked = true;
        st.tail_rendered = rendered;
        st.tail = id.or(rewrite_tail);
    }
}

fn rewrite_in_place(out: &mut impl Write, prev: &str, next: &str) {
    let extra_lines = prev.matches('\n').count();
    if extra_lines > 0 {
        let _ = write!(out, "\r\x1b[{extra_lines}A\x1b[0J");
    } else {
        let _ = write!(out, "\r\x1b[2K");
    }
    let _ = out.write_all(next.as_bytes());
}

impl Surface for TerminalSurface {
    type Msg = Line;
    type Typing = ();

    fn typing(&self) -> Self::Typing {}

    fn limits(&self) -> SizeLimits {
        SizeLimits {
            activity_line_cap: 1,
            activity_char_cap: ACTIVITY_CHAR_CAP,
            activity_send_max: ACTIVITY_SEND_MAX,
        }
    }

    async fn post(&self, text: &str, opts: PostOpts) -> Option<Self::Msg> {
        let id = {
            let mut st = self.state.lock();
            let id = st.next_id;
            st.next_id += 1;
            id
        };
        let rendered = if opts.silent { self.dim(text) } else { text.to_owned() };
        self.emit(rendered, Some(id), None);
        Some(Line { id })
    }

    async fn edit(&self, msg: &Self::Msg, text: &str) -> bool {
        let rendered = self.dim(text);
        self.emit(rendered, None, Some(msg.id));
        true
    }

    async fn ui(&self, req: &UiRequest) -> UiOutcome {
        self.finish();
        match req {
            UiRequest::Confirm { title, message, .. } => {
                self.print_prompt(&confirm_prompt(title, message));
                match read_stdin_line().await {
                    Some(line) => UiOutcome::Respond {
                        reply: UiReply::Confirmed(parse_confirm(&line)),
                        posted: true,
                    },
                    None => dismissed(),
                }
            }
            UiRequest::Select { title, options, .. } => {
                if options.is_empty() {
                    return UiOutcome::Respond {
                        reply: UiReply::Dismissed { timed_out: false },
                        posted: false,
                    };
                }
                self.print_prompt(&select_prompt(title, options));
                match read_stdin_line()
                    .await
                    .and_then(|line| parse_select(&line, options.len()))
                {
                    Some(idx) => UiOutcome::Respond {
                        reply: UiReply::Value(options[idx].clone()),
                        posted: true,
                    },
                    None => dismissed(),
                }
            }
            UiRequest::Input { title, placeholder, .. } => {
                self.print_prompt(&input_prompt(title, placeholder.as_deref()));
                match read_stdin_line().await {
                    Some(line) => UiOutcome::Respond {
                        reply: UiReply::Value(line),
                        posted: true,
                    },
                    None => dismissed(),
                }
            }
            UiRequest::Editor { title, prefill, .. } => {
                self.print_prompt(&editor_prompt(title, prefill.as_deref()));
                match read_stdin_line().await {
                    Some(line) => UiOutcome::Respond {
                        reply: UiReply::Value(line),
                        posted: true,
                    },
                    None => dismissed(),
                }
            }
            UiRequest::Notify { message, notify_type } => {
                self.print_prompt(&notify_text(message, notify_type.as_deref()));
                UiOutcome::Notified { posted: true }
            }
            UiRequest::Cancel { .. } | UiRequest::Ignore | UiRequest::Unknown { .. } => {
                UiOutcome::Notified { posted: false }
            }
        }
    }

    fn tool_activity_line(&self, call: &ToolCall) -> Option<String> {
        Some(activity_line(call))
    }

    fn thinking_line(&self, content: &str) -> Option<String> {
        let line = thinking_text(content);
        (!line.is_empty()).then_some(line)
    }
}

pub(crate) async fn read_stdin_line() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        let mut buf = String::new();
        match std::io::stdin().lock().read_line(&mut buf) {
            Ok(0) => None,
            Ok(_) => Some(buf.trim_end_matches(['\n', '\r']).to_owned()),
            Err(_) => None,
        }
    })
    .await
    .ok()
    .flatten()
}

fn dismissed() -> UiOutcome {
    UiOutcome::Respond {
        reply: UiReply::Dismissed { timed_out: false },
        posted: true,
    }
}

fn confirm_prompt(title: &str, message: &str) -> String {
    if message.is_empty() {
        format!("\n? {title}\n[y/N]: ")
    } else {
        format!("\n? {title}\n{message}\n[y/N]: ")
    }
}

fn select_prompt(title: &str, options: &[String]) -> String {
    let mut out = format!("\n? {title}\n");
    for (i, opt) in options.iter().enumerate() {
        out.push_str(&format!("  {}) {opt}\n", i + 1));
    }
    out.push_str(&format!("choose 1-{}: ", options.len()));
    out
}

fn input_prompt(title: &str, placeholder: Option<&str>) -> String {
    match placeholder {
        Some(hint) if !hint.is_empty() => format!("\n? {title} ({hint})\n> "),
        _ => format!("\n? {title}\n> "),
    }
}

fn editor_prompt(title: &str, prefill: Option<&str>) -> String {
    match prefill {
        Some(text) if !text.is_empty() => format!("\n? {title}\n(prefill: {text})\n> "),
        _ => format!("\n? {title}\n> "),
    }
}

fn notify_text(message: &str, notify_type: Option<&str>) -> String {
    match notify_type {
        Some(kind) if !kind.is_empty() => format!("\n[{kind}] {message}\n"),
        _ => format!("\n{message}\n"),
    }
}

fn parse_confirm(line: &str) -> bool {
    matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

fn parse_select(line: &str, len: usize) -> Option<usize> {
    let n: usize = line.trim().parse().ok()?;
    (1..=len).contains(&n).then(|| n - 1)
}

fn activity_line(call: &ToolCall) -> String {
    let detail = activity_detail(call);
    let icon = tool_icon(&call.tool_name);
    if detail.is_empty() {
        format!("{icon} {}", call.tool_name)
    } else {
        format!("{icon} {} {detail}", call.tool_name)
    }
}

fn activity_detail(call: &ToolCall) -> String {
    let raw = match &call.intent {
        Some(intent) if !intent.trim().is_empty() => intent.clone(),
        _ => arg_preview(&call.args),
    };
    truncate(first_line(raw.trim()), DETAIL_CAP)
}

fn arg_preview(args: &serde_json::Value) -> String {
    const KEYS: [&str; 9] = [
        "command", "path", "pattern", "query", "url", "file", "subject", "message", "name",
    ];
    for key in KEYS {
        if let Some(value) = args.get(key).and_then(serde_json::Value::as_str)
            && !value.trim().is_empty()
        {
            return value.to_owned();
        }
    }
    String::new()
}

fn thinking_text(content: &str) -> String {
    truncate(first_line(content.trim()), DETAIL_CAP)
}

fn tool_icon(name: &str) -> &'static str {
    match name {
        "read" => "*",
        "search" | "ast_grep" | "find" => "?",
        "bash" | "eval" => "$",
        "edit" | "ast_edit" | "write" => "~",
        "task" => "@",
        _ => ".",
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("")
}

fn truncate(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_owned();
    }
    let kept: String = text.chars().take(cap.saturating_sub(1)).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_confirm_accepts_yes_variants_only() {
        assert!(parse_confirm("y"));
        assert!(parse_confirm("Y"));
        assert!(parse_confirm("  yes "));
        assert!(parse_confirm("YES"));
        assert!(!parse_confirm("n"));
        assert!(!parse_confirm(""));
        assert!(!parse_confirm("yep"));
        assert!(!parse_confirm("ya"));
    }

    #[test]
    fn parse_select_is_one_based_and_bounded() {
        assert_eq!(parse_select("1", 3), Some(0));
        assert_eq!(parse_select(" 3 ", 3), Some(2));
        assert_eq!(parse_select("0", 3), None);
        assert_eq!(parse_select("4", 3), None);
        assert_eq!(parse_select("", 3), None);
        assert_eq!(parse_select("two", 3), None);
    }

    #[test]
    fn activity_line_prefers_intent_then_arg() {
        let call = ToolCall {
            tool_call_id: "1".into(),
            tool_name: "bash".into(),
            args: serde_json::json!({ "command": "ls -la" }),
            intent: Some("Listing files".into()),
        };
        assert_eq!(activity_line(&call), "$ bash Listing files");

        let call = ToolCall {
            tool_call_id: "2".into(),
            tool_name: "bash".into(),
            args: serde_json::json!({ "command": "ls -la" }),
            intent: None,
        };
        assert_eq!(activity_line(&call), "$ bash ls -la");

        let call = ToolCall {
            tool_call_id: "3".into(),
            tool_name: "mystery".into(),
            args: serde_json::json!({}),
            intent: None,
        };
        assert_eq!(activity_line(&call), ". mystery");
    }

    #[test]
    fn truncate_adds_ellipsis_past_cap() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdef", 4), "abc…");
    }

    #[test]
    fn rewrite_single_line_uses_clear_line() {
        let mut buf: Vec<u8> = Vec::new();
        rewrite_in_place(&mut buf, "old", "new");
        assert_eq!(String::from_utf8(buf).unwrap(), "\r\x1b[2Knew");
    }

    #[test]
    fn rewrite_multi_line_moves_cursor_up() {
        let mut buf: Vec<u8> = Vec::new();
        rewrite_in_place(&mut buf, "a\nb\nc", "x");
        assert_eq!(String::from_utf8(buf).unwrap(), "\r\x1b[2A\x1b[0Jx");
    }
}
