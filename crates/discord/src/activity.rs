use pico_core::{
    omp::protocol::ToolCall,
    render::{first_line, truncate},
};
use serde::Deserialize;

#[derive(Debug, Clone)]
pub(crate) enum ToolCallStart<'a> {
    Read(&'a ToolCall),
    Search(&'a ToolCall),
    Find(&'a ToolCall),
    Lsp(&'a ToolCall),
    Edit(&'a ToolCall),
    Write(&'a ToolCall),
    Bash(&'a ToolCall),
    Browser(&'a ToolCall),
    Eval(&'a ToolCall),
    WebSearch(&'a ToolCall),
    Learn(&'a ToolCall),
    Recall(&'a ToolCall),
    Reflect(&'a ToolCall),
    Retain(&'a ToolCall),
    Task(&'a ToolCall),
    Job(&'a ToolCall),
    Todo(&'a ToolCall),
    Github(&'a ToolCall),
    Irc(&'a ToolCall),
    AstGrep(&'a ToolCall),
    AstEdit(&'a ToolCall),
    Debug(&'a ToolCall),
    InspectImage(&'a ToolCall),
    ManageSkill(&'a ToolCall),
    Resolve(&'a ToolCall),
    GenerateImage(&'a ToolCall),
    Camo(&'a ToolCall),
    Schedule(&'a ToolCall),
    Unknown(&'a ToolCall),
}

impl<'a> From<&'a ToolCall> for ToolCallStart<'a> {
    fn from(call: &'a ToolCall) -> Self {
        match call.tool_name.as_str() {
            "read" => Self::Read(call),
            "search" => Self::Search(call),
            "find" => Self::Find(call),
            "lsp" => Self::Lsp(call),
            "edit" => Self::Edit(call),
            "write" => Self::Write(call),
            "bash" => Self::Bash(call),
            "browser" => Self::Browser(call),
            "eval" => Self::Eval(call),
            "web_search" => Self::WebSearch(call),
            "task" => Self::Task(call),
            "job" => Self::Job(call),
            "todo" => Self::Todo(call),
            "github" => Self::Github(call),
            "irc" => Self::Irc(call),
            "ast_grep" => Self::AstGrep(call),
            "ast_edit" => Self::AstEdit(call),
            "debug" => Self::Debug(call),
            "inspect_image" => Self::InspectImage(call),
            "manage_skill" => Self::ManageSkill(call),
            "resolve" => Self::Resolve(call),
            "generate_image" => Self::GenerateImage(call),
            "learn" => Self::Learn(call),
            "recall" => Self::Recall(call),
            "reflect" => Self::Reflect(call),
            "retain" => Self::Retain(call),
            name if name.starts_with("camo_") => Self::Camo(call),
            name if name.starts_with("schedule_") => Self::Schedule(call),
            _ => Self::Unknown(call),
        }
    }
}

impl<'a> ToolCallStart<'a> {
    pub(crate) fn call(&self) -> &'a ToolCall {
        match self {
            Self::Read(c)
            | Self::Search(c)
            | Self::Find(c)
            | Self::Lsp(c)
            | Self::Edit(c)
            | Self::Write(c)
            | Self::Bash(c)
            | Self::Browser(c)
            | Self::Eval(c)
            | Self::WebSearch(c)
            | Self::Learn(c)
            | Self::Recall(c)
            | Self::Reflect(c)
            | Self::Retain(c)
            | Self::Task(c)
            | Self::Job(c)
            | Self::Todo(c)
            | Self::Github(c)
            | Self::Irc(c)
            | Self::AstGrep(c)
            | Self::AstEdit(c)
            | Self::Debug(c)
            | Self::InspectImage(c)
            | Self::ManageSkill(c)
            | Self::Resolve(c)
            | Self::GenerateImage(c)
            | Self::Camo(c)
            | Self::Schedule(c)
            | Self::Unknown(c) => c,
        }
    }
}

const ACTIVITY_DETAIL: usize = 60;
const ERROR_DETAIL: usize = 60;

pub(crate) fn tool_activity_line(tool: &ToolCallStart<'_>) -> String {
    let raw = &tool.call().args;
    let a = Args::deserialize(raw).unwrap_or_default();
    let first_path = a.paths.first().map(String::as_str).unwrap_or_default();
    match tool {
        ToolCallStart::Read(_) => locate("🔍", prefer([a.path, first_path])),
        ToolCallStart::Search(_) => locate("🔍", prefer([a.pattern, a.query])),
        ToolCallStart::Find(_) => locate("🔍", prefer([first_path, a.path])),
        ToolCallStart::Lsp(_) => locate("🔍", prefer([a.uri, a.symbol, a.query])),
        ToolCallStart::Edit(_) => locate("✏️", edit_path_arg(a.path, a.input)),
        ToolCallStart::Write(_) => locate("✏️", a.path),
        ToolCallStart::Bash(_) => locate("💻", first_line(a.command)),
        ToolCallStart::Browser(_) => {
            let detail = prefer([a.url, a.selector]);
            if detail.is_empty() {
                format!("🌐 {}", a.action)
            } else {
                format!("🌐 {} {}", a.action, truncate(detail, ACTIVITY_DETAIL))
            }
        }
        ToolCallStart::Eval(_) => {
            if a.code.is_empty() {
                format!("🧪 {}", a.language)
            } else {
                format!("🧪 {} {}", a.language, truncate(first_line(a.code), ACTIVITY_DETAIL))
            }
        }
        ToolCallStart::WebSearch(_) => locate("🔎", a.query),
        ToolCallStart::Job(call) => job_line(&call.args),
        ToolCallStart::Todo(call) => todo_line(&call.args),
        ToolCallStart::Github(call) => github_line(&call.args),
        ToolCallStart::Irc(call) => irc_line(&call.args),
        ToolCallStart::AstGrep(call) => locate("🌳", prefer([str_arg(&call.args, "pat"), "ast_grep"])),
        ToolCallStart::AstEdit(call) => locate("🌳", prefer([ops_pat(&call.args), "ast_edit"])),
        ToolCallStart::Debug(call) => debug_line(&call.args),
        ToolCallStart::InspectImage(call) => locate("🖼️", prefer([str_arg(&call.args, "path"), "inspect_image"])),
        ToolCallStart::ManageSkill(call) => manage_skill_line(&call.args),
        ToolCallStart::Resolve(call) => resolve_line(&call.args),
        ToolCallStart::GenerateImage(call) => locate("🎨", prefer([str_arg(&call.args, "subject"), "generate_image"])),
        ToolCallStart::Camo(call) => camo_line(&call.tool_name, &call.args),
        ToolCallStart::Schedule(call) => schedule_line(&call.tool_name, &call.args),
        ToolCallStart::Learn(call) => locate("🎓", str_arg(&call.args, "memory")),
        ToolCallStart::Recall(call) => locate("🗃️", str_arg(&call.args, "query")),
        ToolCallStart::Reflect(call) => locate("🪞", str_arg(&call.args, "query")),
        ToolCallStart::Retain(call) => locate("💾", retain_content(&call.args)),
        ToolCallStart::Task(call) | ToolCallStart::Unknown(call) => {
            format!("🛠️ {}", truncate(&call.tool_name, ACTIVITY_DETAIL))
        }
    }
}

fn retain_content(args: &serde_json::Value) -> &str {
    args.get("items")
        .and_then(serde_json::Value::as_array)
        .and_then(|a| a.first())
        .map(|first| str_arg(first, "content"))
        .unwrap_or_default()
}

fn job_line(args: &serde_json::Value) -> String {
    let ids = |key: &str| {
        args.get(key)
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty())
    };
    let detail = if args.get("list").and_then(serde_json::Value::as_bool) == Some(true) {
        "list".to_owned()
    } else if let Some(cancel) = ids("cancel") {
        format!("cancel {cancel}")
    } else if let Some(poll) = ids("poll") {
        format!("poll {poll}")
    } else {
        return "⚙️ job".to_owned();
    };
    format!("⚙️ job {}", truncate(&detail, ACTIVITY_DETAIL))
}

fn github_line(args: &serde_json::Value) -> String {
    verb_line(
        "🐙",
        "github",
        str_arg(args, "op"),
        prefer([
            str_arg(args, "query"),
            str_arg(args, "pr"),
            str_arg(args, "repo"),
            str_arg(args, "branch"),
        ]),
    )
}

fn irc_line(args: &serde_json::Value) -> String {
    verb_line(
        "💬",
        "irc",
        str_arg(args, "op"),
        prefer([str_arg(args, "to"), str_arg(args, "from")]),
    )
}

fn debug_line(args: &serde_json::Value) -> String {
    verb_line(
        "🐞",
        "debug",
        str_arg(args, "action"),
        prefer([
            str_arg(args, "program"),
            str_arg(args, "expression"),
            str_arg(args, "file"),
        ]),
    )
}

fn manage_skill_line(args: &serde_json::Value) -> String {
    verb_line("📘", "manage_skill", str_arg(args, "action"), str_arg(args, "name"))
}

fn resolve_line(args: &serde_json::Value) -> String {
    verb_line("☑️", "resolve", str_arg(args, "action"), "")
}

fn verb_line(emoji: &str, fallback: &str, verb: &str, target: &str) -> String {
    let detail = match (verb.is_empty(), target.is_empty()) {
        (false, false) => format!("{verb} {target}"),
        (false, true) => verb.to_owned(),
        (true, _) => fallback.to_owned(),
    };
    format!("{emoji} {}", truncate(&detail, ACTIVITY_DETAIL))
}

fn camo_line(name: &str, args: &serde_json::Value) -> String {
    let action = name.strip_prefix("camo_").unwrap_or(name).replace('_', " ");
    let detail = match name {
        "camo_open" | "camo_navigate" => prefer([str_arg(args, "url"), str_arg(args, "query"), str_arg(args, "macro")]),
        "camo_click" => prefer([str_arg(args, "ref"), str_arg(args, "selector")]),
        "camo_type" => str_arg(args, "text"),
        "camo_scroll" => str_arg(args, "direction"),
        _ => "",
    };
    if detail.is_empty() {
        format!("🌐 {action}")
    } else {
        format!("🌐 {action} {}", truncate(detail, ACTIVITY_DETAIL))
    }
}

fn schedule_line(name: &str, args: &serde_json::Value) -> String {
    let action = name.strip_prefix("schedule_").unwrap_or(name);
    let detail = match name {
        "schedule_create" => str_arg(args, "name"),
        "schedule_remove" | "schedule_enable" | "schedule_disable" => str_arg(args, "id"),
        _ => "",
    };
    verb_line("📅", "schedule", action, detail)
}

fn todo_line(args: &serde_json::Value) -> String {
    let op = str_arg(args, "op");
    let detail = match op {
        "init" => format!("init {} tasks", todo_init_count(args)),
        "append" => {
            let phase = str_arg(args, "phase");
            let n = args
                .get("items")
                .and_then(serde_json::Value::as_array)
                .map_or(0, Vec::len);
            if phase.is_empty() {
                format!("append {n}")
            } else {
                format!("append {phase} ({n})")
            }
        }
        "done" | "start" | "drop" => {
            let what = prefer([str_arg(args, "task"), str_arg(args, "phase")]);
            if what.is_empty() {
                op.to_owned()
            } else {
                format!("{op}: {what}")
            }
        }
        "" => "todo".to_owned(),
        other => other.to_owned(),
    };
    format!("📋 {}", truncate(&detail, ACTIVITY_DETAIL))
}

fn todo_init_count(args: &serde_json::Value) -> usize {
    if let Some(items) = args.get("items").and_then(serde_json::Value::as_array) {
        return items.len();
    }
    let Some(phases) = args.get("list").and_then(serde_json::Value::as_array) else {
        return 0;
    };
    phases
        .iter()
        .filter_map(|p| p.get("items").and_then(serde_json::Value::as_array))
        .map(Vec::len)
        .sum()
}

fn ops_pat(args: &serde_json::Value) -> &str {
    args.get("ops")
        .and_then(serde_json::Value::as_array)
        .and_then(|o| o.first())
        .and_then(|first| first.get("pat"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

fn str_arg<'a>(args: &'a serde_json::Value, key: &str) -> &'a str {
    args.get(key).and_then(serde_json::Value::as_str).unwrap_or_default()
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct Args<'a> {
    path: &'a str,
    pattern: &'a str,
    query: &'a str,
    uri: &'a str,
    symbol: &'a str,
    command: &'a str,
    action: &'a str,
    url: &'a str,
    selector: &'a str,
    language: &'a str,
    code: &'a str,
    input: &'a str,
    #[serde(default, deserialize_with = "string_or_seq")]
    paths: Vec<String>,
}

fn locate(emoji: &str, detail: &str) -> String {
    format!("{emoji} {}", truncate(detail, ACTIVITY_DETAIL))
}

fn prefer<'a>(candidates: impl IntoIterator<Item = &'a str>) -> &'a str {
    candidates.into_iter().find(|s| !s.is_empty()).unwrap_or_default()
}

fn string_or_seq<'de, D>(de: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OneOrMany;
    impl<'de> serde::de::Visitor<'de> for OneOrMany {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a string or array of strings")
        }
        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
            Ok(vec![value.to_owned()])
        }
        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let first = seq.next_element::<String>()?;
            while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok(first.into_iter().collect())
        }
    }
    de.deserialize_any(OneOrMany)
}

pub(crate) fn thinking_line(content: &str) -> String {
    let detail = truncate(first_line(content.trim()), ACTIVITY_DETAIL);
    if detail.is_empty() {
        String::new()
    } else {
        format!("🧠 {detail}")
    }
}

pub(crate) fn failure_line(current: &str, error: Option<&str>) -> String {
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

fn edit_path_arg<'a>(path: &'a str, input: &'a str) -> &'a str {
    if !path.is_empty() {
        return path;
    }
    for line in input.lines() {
        if let Some(rest) = line.trim_start().strip_prefix('[')
            && let Some(close) = rest.find(']')
        {
            let inner = &rest[..close];
            if !inner.is_empty() {
                return strip_hashline_tag(inner);
            }
        }
    }
    for line in input.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("*** Update File:") {
            let resolved = rest.trim();
            if !resolved.is_empty() {
                return resolved;
            }
        }
    }
    ""
}

fn strip_hashline_tag(inner: &str) -> &str {
    if let Some((path, tag)) = inner.rsplit_once('#')
        && tag.len() == 4
        && tag.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return path;
    }
    inner
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(name: &str, args: serde_json::Value) -> String {
        let call = pico_core::omp::protocol::ToolCall {
            tool_call_id: "id".to_owned(),
            tool_name: name.to_owned(),
            args,
            intent: None,
        };
        tool_activity_line(&ToolCallStart::from(&call))
    }

    #[test]
    fn tool_lines_pick_emoji_and_primary_arg() {
        use serde_json::json;
        assert_eq!(line("read", json!({ "paths": ["a.rs", "b.rs"] })), "🔍 a.rs");
        assert_eq!(line("search", json!({ "pattern": "TODO" })), "🔍 TODO");
        assert_eq!(line("write", json!({ "path": "x.rs" })), "✏️ x.rs");
        assert_eq!(line("bash", json!({ "command": "echo hi\nrm -rf" })), "💻 echo hi");
        assert_eq!(
            line("browser", json!({ "action": "open", "url": "https://x" })),
            "🌐 open https://x"
        );
        assert_eq!(
            line("eval", json!({ "language": "py", "code": "print(1)\nmore" })),
            "🧪 py print(1)"
        );
        assert_eq!(line("web_search", json!({ "query": "rust" })), "🔎 rust");
        assert_eq!(line("totally_unknown", json!({ "a": 1 })), "🛠️ totally_unknown");
        assert_eq!(line("task", json!({ "agent": "explore" })), "🛠️ task");
    }

    #[test]
    fn previously_unknown_tools_get_dedicated_lines() {
        use serde_json::json;
        assert_eq!(
            line(
                "todo",
                json!({ "op": "init", "list": [{ "phase": "A", "items": ["x", "y"] }, { "phase": "B", "items": ["z"] }] })
            ),
            "📋 init 3 tasks"
        );
        assert_eq!(line("todo", json!({ "op": "init", "items": ["a", "b"] })), "📋 init 2 tasks");
        assert_eq!(
            line("todo", json!({ "op": "done", "task": "Wire workspace" })),
            "📋 done: Wire workspace"
        );
        assert_eq!(
            line("todo", json!({ "op": "append", "phase": "Auth", "items": ["a", "b"] })),
            "📋 append Auth (2)"
        );
        assert_eq!(line("todo", json!({ "op": "view" })), "📋 view");
        assert_eq!(
            line("github", json!({ "op": "search_issues", "query": "rust async" })),
            "🐙 search_issues rust async"
        );
        assert_eq!(line("github", json!({ "op": "pr_create" })), "🐙 pr_create");
        assert_eq!(line("irc", json!({ "op": "send", "to": "AuthLoader" })), "💬 send AuthLoader");
        assert_eq!(line("ast_grep", json!({ "pat": "foo($$$)", "paths": ["src"] })), "🌳 foo($$$)");
        assert_eq!(
            line("ast_edit", json!({ "ops": [{ "pat": "a", "out": "b" }], "paths": ["src"] })),
            "🌳 a"
        );
        assert_eq!(
            line("debug", json!({ "action": "launch", "program": "./app" })),
            "🐞 launch ./app"
        );
        assert_eq!(line("inspect_image", json!({ "path": "a.png" })), "🖼️ a.png");
        assert_eq!(
            line("manage_skill", json!({ "action": "create", "name": "foo" })),
            "📘 create foo"
        );
        assert_eq!(line("resolve", json!({ "action": "apply", "reason": "ok" })), "☑️ apply");
        assert_eq!(line("generate_image", json!({ "subject": "a calico cat" })), "🎨 a calico cat");
        assert_eq!(line("camo_open", json!({ "url": "https://x" })), "🌐 open https://x");
        assert_eq!(line("camo_scroll", json!({ "direction": "down" })), "🌐 scroll down");
        assert_eq!(line("camo_type", json!({ "text": "hi" })), "🌐 type hi");
        assert_eq!(line("camo_list_tabs", json!({})), "🌐 list tabs");
        assert_eq!(line("todo", json!({})), "📋 todo");
        assert_eq!(line("todo", json!({ "op": "append", "items": ["a"] })), "📋 append 1");
        assert_eq!(line("todo", json!({ "op": "done" })), "📋 done");
        assert_eq!(line("todo", json!({ "op": "" })), "📋 todo");
        assert_eq!(
            line("github", json!({ "op": "pr_view", "pr": 42, "repo": "o/r" })),
            "🐙 pr_view o/r"
        );
        assert_eq!(line("irc", json!({ "op": "wait", "from": "AuthLoader" })), "💬 wait AuthLoader");
        assert_eq!(line("ast_grep", json!({ "paths": ["src"] })), "🌳 ast_grep");
        assert_eq!(line("ast_edit", json!({ "paths": ["src"] })), "🌳 ast_edit");
        assert_eq!(
            line("debug", json!({ "action": "evaluate", "expression": "x+1" })),
            "🐞 evaluate x+1"
        );
        assert_eq!(line("camo_click", json!({ "ref": "e1" })), "🌐 click e1");
        assert_eq!(
            line("camo_navigate", json!({ "macro": "@google_search", "query": "rust" })),
            "🌐 navigate rust"
        );
        assert_eq!(
            line("schedule_create", json!({ "name": "daily digest", "mode": "fresh" })),
            "📅 create daily digest"
        );
        assert_eq!(line("schedule_list", json!({})), "📅 list");
        assert_eq!(line("schedule_remove", json!({ "id": "01ABC" })), "📅 remove 01ABC");
        assert_eq!(line("schedule_enable", json!({ "id": "01ABC" })), "📅 enable 01ABC");
        assert_eq!(line("schedule_disable", json!({ "id": "01ABC" })), "📅 disable 01ABC");
    }

    #[test]
    fn search_tolerates_string_or_array_paths() {
        use serde_json::json;
        assert_eq!(line("search", json!({ "pattern": "TODO", "paths": "src" })), "🔍 TODO");
        assert_eq!(line("search", json!({ "pattern": "TODO", "paths": ["src", "lib"] })), "🔍 TODO");
        assert_eq!(line("find", json!({ "paths": "src/**/*.rs" })), "🔍 src/**/*.rs");
    }

    #[test]
    fn edit_line_resolves_the_target_path() {
        use serde_json::json;
        assert_eq!(
            line("edit", json!({ "input": "[src/foo.rs#1A2B]\nreplace 1..1:\n+x" })),
            "✏️ src/foo.rs"
        );
        assert_eq!(line("edit", json!({ "input": "[src/bare.rs]\n+x" })), "✏️ src/bare.rs");
        assert_eq!(line("edit", json!({ "path": "given.rs" })), "✏️ given.rs");
        assert_eq!(
            line("edit", json!({ "input": "*** Begin Patch\n*** Update File: lib/x.rs\n+y" })),
            "✏️ lib/x.rs"
        );
        assert_eq!(
            line(
                "edit",
                json!({ "input": "*** Begin Patch\n*** Update File: src/main.rs\n+    let x = arr[0];" })
            ),
            "✏️ src/main.rs"
        );
    }

    #[test]
    fn detail_trims_to_sixty_chars_on_char_boundaries() {
        let out = line("read", serde_json::json!({ "path": "a".repeat(70) }));
        let detail: String = out.chars().skip(2).collect();
        assert_eq!(detail.chars().count(), 60);
        assert!(detail.ends_with('\u{2026}'));
        let wide = line("read", serde_json::json!({ "path": "中".repeat(70) }));
        assert!(wide.starts_with("🔍 中"));
        assert!(wide.ends_with('\u{2026}'));
    }

    #[test]
    fn memory_tools_get_dedicated_lines() {
        use serde_json::json;
        assert_eq!(
            line("learn", json!({ "memory": "X uses nightly fmt" })),
            "🎓 X uses nightly fmt"
        );
        assert_eq!(line("recall", json!({ "query": "deploy steps" })), "🗃️ deploy steps");
        assert_eq!(line("reflect", json!({ "query": "preferences" })), "🪞 preferences");
        assert_eq!(
            line("retain", json!({ "items": [{ "content": "decided on A" }] })),
            "💾 decided on A"
        );
    }

    #[test]
    fn thinking_line_takes_first_line_and_skips_blank() {
        assert_eq!(thinking_line("first line\nsecond"), "🧠 first line");
        assert_eq!(thinking_line("  \n  "), "");
        assert_eq!(thinking_line(""), "");
    }

    #[test]
    fn failure_line_swaps_emoji_and_appends_error() {
        assert_eq!(failure_line("🔍 src/foo.rs", Some("boom")), "❌ src/foo.rs — boom");
        assert_eq!(failure_line("💻 echo hi", None), "❌ echo hi");
        assert_eq!(failure_line("🔍 x", Some("")), "❌ x");
        assert_eq!(failure_line("🔍 x", Some("line one\nline two")), "❌ x — line one");
    }

    #[test]
    fn job_lines_label_the_action_never_bare_emoji() {
        use serde_json::json;
        assert_eq!(line("job", json!({ "poll": ["ReadHello"] })), "⚙️ job poll ReadHello");
        assert_eq!(line("job", json!({ "poll": ["A", "B"] })), "⚙️ job poll A, B");
        assert_eq!(line("job", json!({ "list": true })), "⚙️ job list");
        assert_eq!(line("job", json!({ "cancel": ["Stuck"] })), "⚙️ job cancel Stuck");
        assert_eq!(line("job", json!({})), "⚙️ job");
        assert_eq!(line("job", json!({ "poll": [] })), "⚙️ job");
    }
}
