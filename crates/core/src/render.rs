pub const DISCORD_BUDGET: usize = 1800;

pub fn split_to_budget(text: &str, budget: usize) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut content: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut open_info = String::new();

    for line in text.lines() {
        let fence = is_fence_line(line);
        let next_in_fence = if fence { !in_fence } else { in_fence };
        let next_open_info = if fence && !in_fence {
            fence_info(line)
        } else {
            open_info.clone()
        };

        // A line longer than the budget (minified JSON, a long URL) is hard-
        // wrapped first, else it yields an oversized chunk Discord drops.
        if fence {
            emit_line(line, next_in_fence, in_fence, &open_info, budget, &mut content, &mut chunks);
        } else {
            for piece in hard_wrap(line, budget, in_fence, &open_info) {
                emit_line(&piece, next_in_fence, in_fence, &open_info, budget, &mut content, &mut chunks);
            }
        }

        in_fence = next_in_fence;
        open_info = next_open_info;
    }

    if !content.is_empty() {
        chunks.push(content.join("\n"));
    }

    chunks
}

pub fn defang_mentions(text: &str) -> String {
    text.replace("<@", "<@\u{200b}")
        .replace("@everyone", "@\u{200b}everyone")
        .replace("@here", "@\u{200b}here")
}

/// Per-line detail budget for the tool/thinking activity feed; the leading
/// emoji sits outside it. Matches the TS reference's `ACTIVITY_DETAIL`.
const ACTIVITY_DETAIL: usize = 60;
const ERROR_DETAIL: usize = 60;
/// Activity message rollover caps; the char cap leaves headroom under
/// Discord's 2000 limit for the rolling edits.
pub const ACTIVITY_LINE_CAP: usize = 20;
pub const ACTIVITY_CHAR_CAP: usize = 1800;

/// The tools pico renders with a bespoke emoji. Everything else (MCP tools,
/// custom tools, anything OMP grows later) is [`ToolName::Unknown`] and renders
/// generically — the set is open, so a catch-all is intrinsic, not a gap. The
/// `Unknown` payload borrows the name, so an unknown tool costs no allocation.
#[derive(Clone, Copy)]
enum ToolName<'a> {
    Read,
    Search,
    Find,
    Lsp,
    Edit,
    Write,
    Bash,
    Browser,
    Eval,
    WebSearch,
    Task,
    Ask,
    Unknown(&'a str),
}

impl<'a> From<&'a str> for ToolName<'a> {
    fn from(name: &'a str) -> Self {
        match name {
            "read" => Self::Read,
            "search" => Self::Search,
            "find" => Self::Find,
            "lsp" => Self::Lsp,
            "edit" => Self::Edit,
            "write" => Self::Write,
            "bash" => Self::Bash,
            "browser" => Self::Browser,
            "eval" => Self::Eval,
            "web_search" => Self::WebSearch,
            "task" => Self::Task,
            "ask" => Self::Ask,
            other => Self::Unknown(other),
        }
    }
}

/// One activity-feed line for a tool call: a per-tool emoji plus the tool's
/// primary argument trimmed to [`ACTIVITY_DETAIL`]. Adding a known
/// [`ToolName`] variant makes this match non-exhaustive, so a new tool can't
/// silently slip through without a deliberate emoji choice.
pub fn tool_activity_line(tool_name: &str, args: &serde_json::Value) -> String {
    match ToolName::from(tool_name) {
        tool @ (ToolName::Read | ToolName::Search | ToolName::Find | ToolName::Lsp) => {
            format!("🔍 {}", truncate(&first_positional(tool, args), ACTIVITY_DETAIL))
        }
        ToolName::Edit => format!("✏️ {}", truncate(&edit_path_arg(args).unwrap_or_default(), ACTIVITY_DETAIL)),
        ToolName::Write => format!("✏️ {}", truncate(&field_string(args, "path"), ACTIVITY_DETAIL)),
        ToolName::Bash => format!("💻 {}", truncate(first_line(&field_string(args, "command")), ACTIVITY_DETAIL)),
        ToolName::Browser => {
            let action = field_string(args, "action");
            let url = field_string(args, "url");
            let detail = if url.is_empty() {
                field_string(args, "selector")
            } else {
                url
            };
            if detail.is_empty() {
                format!("🌐 {action}")
            } else {
                format!("🌐 {action} {}", truncate(&detail, ACTIVITY_DETAIL))
            }
        }
        ToolName::Eval => {
            let lang = field_string(args, "language");
            let code = field_string(args, "code");
            if code.is_empty() {
                format!("🧪 {lang}")
            } else {
                format!("🧪 {lang} {}", truncate(first_line(&code), ACTIVITY_DETAIL))
            }
        }
        ToolName::WebSearch => format!("🔎 {}", truncate(&field_string(args, "query"), ACTIVITY_DETAIL)),
        ToolName::Task => {
            let agent = field_string(args, "agent");
            let detail = if agent.is_empty() { json_preview(args) } else { agent };
            format!("🤖 {}", truncate(&detail, ACTIVITY_DETAIL))
        }
        ToolName::Ask => format!("❓ {}", truncate(&json_preview(args), ACTIVITY_DETAIL)),
        ToolName::Unknown(name) => format!("🛠️ {}", truncate(name, ACTIVITY_DETAIL)),
    }
}

/// One activity-feed line for a reasoning block: the first line of the thinking
/// text trimmed to [`ACTIVITY_DETAIL`]. Empty when the block has no text.
pub fn thinking_line(content: &str) -> String {
    let detail = truncate(first_line(content.trim()), ACTIVITY_DETAIL);
    if detail.is_empty() {
        String::new()
    } else {
        format!("🧠 {detail}")
    }
}

/// Rewrite an activity line into its failed form: swap the leading emoji for
/// ❌, keep the original detail, and append the error. One physical line so a
/// caller's line-index mapping stays 1:1. The caller applies it once per tool
/// (it drops the line's placement first), so the error is never re-appended.
pub fn with_failure_line(current: &str, error: Option<&str>) -> String {
    let body = current.find(' ').map_or("", |i| &current[i..]);
    let head = format!("❌{body}");
    match error
        .map(|e| truncate(first_line(e), ERROR_DETAIL))
        .filter(|e| !e.is_empty())
    {
        Some(err) => format!("{head} — {err}"),
        None => head,
    }
}

/// Pull the human-readable message out of an OMP tool-failure result
/// (`{ content: [{ type: "text", text }] }`, or a bare string).
pub fn error_text(result: &serde_json::Value) -> Option<String> {
    if let Some(s) = result.as_str() {
        return Some(s.to_owned());
    }
    let content = result.get("content")?.as_array()?;
    content.iter().find_map(|part| {
        (part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .then(|| part.get("text").and_then(serde_json::Value::as_str))
            .flatten()
            .map(str::to_owned)
    })
}

/// Char-aware truncation with a trailing ellipsis; `max` counts the ellipsis.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or(s)
}

fn field_string(args: &serde_json::Value, key: &str) -> String {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default()
}

fn json_preview(args: &serde_json::Value) -> String {
    serde_json::to_string(args).unwrap_or_default()
}

/// The tool's primary positional argument, by tool: `read`→path, `search`→
/// pattern, etc. A single ordered key list would pick the wrong field, so the
/// preference order is per-tool, falling back to the first string value.
fn first_positional(tool: ToolName<'_>, args: &serde_json::Value) -> String {
    let Some(obj) = args.as_object() else {
        return String::new();
    };
    let keys: &[&str] = match tool {
        ToolName::Read => &["path", "paths"],
        ToolName::Search => &["pattern", "query"],
        ToolName::Find => &["paths", "path"],
        ToolName::Lsp => &["uri", "symbol", "query"],
        _ => &[],
    };
    for key in keys {
        match obj.get(*key) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => return s.clone(),
            Some(serde_json::Value::Array(a)) => {
                if let Some(serde_json::Value::String(s)) = a.first()
                    && !s.is_empty()
                {
                    return s.clone();
                }
            }
            _ => {}
        }
    }
    for value in obj.values() {
        if let serde_json::Value::String(s) = value
            && !s.is_empty()
        {
            return s.clone();
        }
    }
    String::new()
}

/// The edit tool's target path: an explicit `path` field, else the path parsed
/// from the first hashline header (`[path#TAG]`) or apply-patch directive
/// (`*** Update File: path`) in its `input`.
fn edit_path_arg(args: &serde_json::Value) -> Option<String> {
    let obj = args.as_object()?;
    if let Some(serde_json::Value::String(path)) = obj.get("path") {
        return Some(path.clone());
    }
    let raw = obj.get("input")?.as_str()?;
    for line in raw.lines() {
        // Anchored to the line start (like picomp's `^\s*\[`): a hashline header
        // opens its line, so a mid-line bracket in an apply-patch diff body
        // (`#[derive]`, `arr[0]`) can't be mistaken for one.
        if let Some(rest) = line.trim_start().strip_prefix('[')
            && let Some(close) = rest.find(']')
        {
            let inner = &rest[..close];
            if !inner.is_empty() {
                return Some(strip_hashline_tag(inner).to_owned());
            }
        }
    }
    for line in raw.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("*** Update File:") {
            let path = rest.trim();
            if !path.is_empty() {
                return Some(path.to_owned());
            }
        }
    }
    None
}

/// Drop a trailing `#XXXX` snapshot tag (exactly four hex digits) from a
/// hashline header's inner text, leaving the bare path.
fn strip_hashline_tag(inner: &str) -> &str {
    if let Some((path, tag)) = inner.rsplit_once('#')
        && tag.len() == 4
        && tag.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return path;
    }
    inner
}

fn projected_len(content: &[String], line: &str, next_in_fence: bool) -> usize {
    let mut n: usize = content.iter().map(|l| l.chars().count()).sum();
    if !content.is_empty() {
        n += content.len() - 1;
        n += 1;
    }
    n += line.chars().count();
    if next_in_fence {
        n += 1 + 3;
    }
    n
}

fn is_fence_line(line: &str) -> bool {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    indent <= 3 && line[indent..].starts_with("```")
}

fn fence_info(line: &str) -> String {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    line[indent + 3..].trim().to_string()
}

fn reopen_fence(info: &str) -> String {
    format!("```{info}")
}

fn emit_line(
    line: &str,
    next_in_fence: bool,
    in_fence: bool,
    open_info: &str,
    budget: usize,
    content: &mut Vec<String>,
    chunks: &mut Vec<String>,
) {
    if !content.is_empty() && projected_len(content, line, next_in_fence) > budget {
        if in_fence {
            content.push("```".to_string());
        }
        chunks.push(content.join("\n"));
        content.clear();
        if in_fence {
            content.push(reopen_fence(open_info));
        }
    }
    content.push(line.to_string());
}

/// Break an over-budget line into budget-sized char pieces; inside a fence the
/// budget drops by the reopen/close marker length so each piece survives them.
fn hard_wrap(line: &str, budget: usize, in_fence: bool, open_info: &str) -> Vec<String> {
    let max = if in_fence {
        // reopen "```<info>" + the two join newlines + the closing "```".
        budget.saturating_sub(open_info.chars().count() + 8)
    } else {
        budget
    }
    .max(1);

    if line.chars().count() <= max {
        return vec![line.to_string()];
    }

    let mut pieces = Vec::new();
    let mut piece = String::new();
    let mut n = 0;
    for ch in line.chars() {
        if n == max {
            pieces.push(std::mem::take(&mut piece));
            n = 0;
        }
        piece.push(ch);
        n += 1;
    }
    if !piece.is_empty() {
        pieces.push(piece);
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_returns_empty_vec() {
        assert!(split_to_budget("", DISCORD_BUDGET).is_empty());
        assert!(split_to_budget("   \n  \t ", DISCORD_BUDGET).is_empty());
    }

    #[test]
    fn never_exceeds_budget_and_never_splits_lines() {
        let text = "aaaa\nbbbb\ncccc\ndddd\neeee\nffff";
        let budget = 10;
        let chunks = split_to_budget(text, budget);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
        }
        assert_eq!(chunks.join("\n"), text);
    }

    #[test]
    fn straddling_rust_fence_closes_and_reopens() {
        let text = "```rust\nlet a = 1;\nlet b = 2;\nlet c = 3;\n```";
        let budget = 30;
        let chunks = split_to_budget(text, budget);
        assert!(chunks.len() >= 2);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
        }
        assert!(chunks[0].ends_with("```"));
        assert!(chunks[1].starts_with("```rust"));
    }

    #[test]
    fn hard_splits_an_overlong_line_outside_a_fence() {
        let text = "x".repeat(50);
        let budget = 20;
        let chunks = split_to_budget(&text, budget);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
        }
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn hard_splits_an_overlong_line_inside_a_fence() {
        let text = format!("```\n{}\n```", "y".repeat(60));
        let budget = 25;
        let chunks = split_to_budget(&text, budget);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
            assert!(chunk.starts_with("```"));
            assert!(chunk.ends_with("```"));
        }
    }

    #[test]
    fn defang_neutralizes_pings_and_spares_plain_text() {
        assert_eq!(defang_mentions("@everyone"), "@\u{200b}everyone");
        assert_eq!(defang_mentions("@here"), "@\u{200b}here");
        assert_eq!(defang_mentions("<@123>"), "<@\u{200b}123>");
        assert_eq!(defang_mentions("<@!123>"), "<@\u{200b}!123>");
        assert_eq!(defang_mentions("<@&456>"), "<@\u{200b}&456>");
        assert_eq!(defang_mentions("email@example.com"), "email@example.com");
        assert_eq!(defang_mentions("plain text"), "plain text");
    }

    #[test]
    fn tool_lines_pick_emoji_and_primary_arg() {
        use serde_json::json;
        assert_eq!(tool_activity_line("read", &json!({ "paths": ["a.rs", "b.rs"] })), "🔍 a.rs");
        assert_eq!(tool_activity_line("search", &json!({ "pattern": "TODO" })), "🔍 TODO");
        assert_eq!(tool_activity_line("write", &json!({ "path": "x.rs" })), "✏️ x.rs");
        assert_eq!(
            tool_activity_line("bash", &json!({ "command": "echo hi\nrm -rf" })),
            "💻 echo hi"
        );
        assert_eq!(
            tool_activity_line("browser", &json!({ "action": "open", "url": "https://x" })),
            "🌐 open https://x"
        );
        assert_eq!(
            tool_activity_line("eval", &json!({ "language": "py", "code": "print(1)\nmore" })),
            "🧪 py print(1)"
        );
        assert_eq!(tool_activity_line("web_search", &json!({ "query": "rust" })), "🔎 rust");
        assert_eq!(tool_activity_line("task", &json!({ "agent": "explore" })), "🤖 explore");
        assert!(tool_activity_line("ask", &json!({ "questions": [] })).starts_with("❓ "));
        assert_eq!(tool_activity_line("totally_unknown", &json!({ "a": 1 })), "🛠️ totally_unknown");
    }

    #[test]
    fn edit_line_resolves_the_target_path() {
        use serde_json::json;
        assert_eq!(
            tool_activity_line("edit", &json!({ "input": "[src/foo.rs#1A2B]\nreplace 1..1:\n+x" })),
            "✏️ src/foo.rs"
        );
        assert_eq!(
            tool_activity_line("edit", &json!({ "input": "[src/bare.rs]\n+x" })),
            "✏️ src/bare.rs"
        );
        assert_eq!(tool_activity_line("edit", &json!({ "path": "given.rs" })), "✏️ given.rs");
        assert_eq!(
            tool_activity_line("edit", &json!({ "input": "*** Begin Patch\n*** Update File: lib/x.rs\n+y" })),
            "✏️ lib/x.rs"
        );
        assert_eq!(
            tool_activity_line(
                "edit",
                &json!({ "input": "*** Begin Patch\n*** Update File: src/main.rs\n+    let x = arr[0];" })
            ),
            "✏️ src/main.rs"
        );
    }

    #[test]
    fn detail_trims_to_sixty_chars_on_char_boundaries() {
        let line = tool_activity_line("read", &serde_json::json!({ "path": "a".repeat(70) }));
        let detail: String = line.chars().skip(2).collect(); // drop "🔍 "
        assert_eq!(detail.chars().count(), 60);
        assert!(detail.ends_with('\u{2026}'));
        let wide = tool_activity_line("read", &serde_json::json!({ "path": "中".repeat(70) }));
        assert!(wide.starts_with("🔍 中"));
        assert!(wide.ends_with('\u{2026}'));
    }

    #[test]
    fn thinking_line_takes_first_line_and_skips_blank() {
        assert_eq!(thinking_line("first line\nsecond"), "🧠 first line");
        assert_eq!(thinking_line("  \n  "), "");
        assert_eq!(thinking_line(""), "");
    }

    #[test]
    fn failure_line_swaps_emoji_and_appends_error() {
        assert_eq!(with_failure_line("🔍 src/foo.rs", Some("boom")), "❌ src/foo.rs — boom");
        assert_eq!(with_failure_line("💻 echo hi", None), "❌ echo hi");
        assert_eq!(with_failure_line("🔍 x", Some("")), "❌ x");
        assert_eq!(with_failure_line("🔍 x", Some("line one\nline two")), "❌ x — line one");
    }

    #[test]
    fn error_text_extracts_first_text_block() {
        use serde_json::json;
        assert_eq!(
            error_text(&json!({ "content": [{ "type": "text", "text": "oops" }] })).as_deref(),
            Some("oops")
        );
        assert_eq!(error_text(&json!("bare string")).as_deref(), Some("bare string"));
        assert_eq!(error_text(&json!({ "content": [] })), None);
        assert_eq!(error_text(&json!({ "unrelated": 1 })), None);
    }
}
