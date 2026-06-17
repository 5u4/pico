use serde::Deserialize;

use crate::omp::protocol::ToolCallStart;

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

/// Rewrite GitHub-flavored markdown tables into nested bullet lists, since
/// Discord renders neither the table syntax nor the pipes. Each data row becomes
/// a block: the first column bolded as title, the rest as `header: value`
/// sub-bullets. Conservative — text in ``` / ~~~ fences, and any header/delimiter
/// pair that isn't an unambiguous table, passes through untouched.
pub fn tables_to_lists(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut fence: Option<char> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(marker) = fence_marker(line) {
            // A fence closes only on its own marker char: ``` can't end a ~~~ block.
            match fence {
                Some(open) if open == marker => fence = None,
                Some(_) => {}
                None => fence = Some(marker),
            }
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if fence.is_none()
            && let Some(headers) = lines.get(i + 1).and_then(|next| table_header(line, next))
        {
            let mut j = i + 2;
            let mut rows: Vec<Vec<String>> = Vec::new();
            while j < lines.len() && fence_marker(lines[j]).is_none() && is_table_row(lines[j]) {
                rows.push(split_cells(lines[j]));
                j += 1;
            }
            if !rows.is_empty() {
                render_table_as_list(&headers, &rows, &mut out);
                i = j;
                continue;
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

/// The fence marker char (`` ` `` or `~`) when `line` opens or closes a code
/// fence (≤3 leading spaces, three+ of the marker), else `None`.
fn fence_marker(line: &str) -> Option<char> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    if rest.starts_with("```") {
        Some('`')
    } else if rest.starts_with("~~~") {
        Some('~')
    } else {
        None
    }
}

/// The header cells when `header`/`delim` form a GFM table head: `header` holds a
/// pipe, every `delim` cell is an alignment marker (`-`/`:-`/`-:`/`:-:`), and the
/// two split to the same column count. `None` otherwise.
fn table_header(header: &str, delim: &str) -> Option<Vec<String>> {
    if !is_table_row(header) {
        return None;
    }
    let cells = split_cells(header);
    let delim_cells = split_cells(delim);
    if cells.is_empty() || cells.len() != delim_cells.len() {
        return None;
    }
    delim_cells.iter().all(|c| is_delimiter_cell(c)).then_some(cells)
}

fn is_table_row(line: &str) -> bool {
    line.contains('|')
}

fn is_delimiter_cell(cell: &str) -> bool {
    let body = cell.strip_prefix(':').unwrap_or(cell);
    let body = body.strip_suffix(':').unwrap_or(body);
    !body.is_empty() && body.chars().all(|c| c == '-')
}

/// Split a table row into trimmed cells on unescaped `|`, unescaping `\|`/`\\`
/// and dropping the empty cells the optional outer pipes produce.
fn split_cells(line: &str) -> Vec<String> {
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if matches!(chars.peek().copied(), Some('|' | '\\')) => {
                cur.push(chars.next().unwrap());
            }
            '|' => {
                cells.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    cells.push(cur.trim().to_string());
    if cells.first().is_some_and(String::is_empty) {
        cells.remove(0);
    }
    if cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    cells
}

fn render_table_as_list(headers: &[String], rows: &[Vec<String>], out: &mut Vec<String>) {
    for row in rows {
        // No title cell → flatten its fields to top-level bullets; a bare "-" is
        // not a valid list marker.
        let (indent, start) = match row.first() {
            Some(title) if !title.is_empty() => {
                out.push(format!("- **{title}**"));
                ("  ", 1)
            }
            _ => ("", 0),
        };
        for (j, value) in row.iter().enumerate().skip(start) {
            if value.is_empty() {
                continue;
            }
            match headers.get(j) {
                Some(h) if !h.is_empty() => out.push(format!("{indent}- {h}: {value}")),
                _ => out.push(format!("{indent}- {value}")),
            }
        }
    }
}

/// Per-line detail budget for the tool/thinking activity feed; the leading
/// emoji sits outside it. Matches the TS reference's `ACTIVITY_DETAIL`.
const ACTIVITY_DETAIL: usize = 60;
const ERROR_DETAIL: usize = 60;
/// Activity message rollover caps; the char cap leaves headroom under
/// Discord's 2000 limit for the rolling edits.
pub const ACTIVITY_LINE_CAP: usize = 20;
pub const ACTIVITY_CHAR_CAP: usize = 1800;

/// One activity-feed line for a tool call: a per-tool emoji plus the primary arg
/// trimmed to [`ACTIVITY_DETAIL`]. Matches the decode-time [`ToolCallStart`]
/// classification and reads typed [`Args`] fields. `task` is routed away by the
/// turn loop, so it shares the generic render.
pub fn tool_activity_line(tool: &ToolCallStart) -> String {
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
        ToolCallStart::Task(call) | ToolCallStart::Unknown(call) => {
            format!("🛠️ {}", truncate(&call.tool_name, ACTIVITY_DETAIL))
        }
    }
}

/// The `job` activity line: ⚙️ plus the action, so a poll never renders as a bare emoji.
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

/// Borrowed view over the `args` fields the activity line reads. serde fills
/// only what's present (missing → `""`) and ignores unknown args; borrowing
/// keeps a large `command`/`code` from being cloned just to take its first line.
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

/// `emoji` + the detail trimmed to [`ACTIVITY_DETAIL`]. An empty detail renders
/// as just the emoji and a trailing space, matching the per-field arms.
fn locate(emoji: &str, detail: &str) -> String {
    format!("{emoji} {}", truncate(detail, ACTIVITY_DETAIL))
}

/// First non-empty candidate (typed field preference, replacing the per-tool
/// key list), or `""` when all are empty.
fn prefer<'a>(candidates: impl IntoIterator<Item = &'a str>) -> &'a str {
    candidates.into_iter().find(|s| !s.is_empty()).unwrap_or_default()
}

/// Deserialize `string | array-of-strings` (OMP's `search` `paths`) into a
/// `Vec`. Without it a bare-string `paths` aborts the whole [`Args`] decode and
/// blanks the line. Owned — entries are short and only the first is read.
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
            // Only the first path is rendered; clone it and drain the rest.
            let first = seq.next_element::<String>()?;
            while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok(first.into_iter().collect())
        }
    }
    de.deserialize_any(OneOrMany)
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

/// Per-row detail caps for the subagent batch render; the leading marker/emoji
/// sits outside each.
const SUBAGENT_LABEL_MAX: usize = 28;
const SUBAGENT_ARGS_MAX: usize = 40;
const SUBAGENT_INTENT_MAX: usize = 40;
const SUBAGENT_MODEL_MAX: usize = 30;

/// Lifecycle of one subagent row, folded from `AgentProgress.status`:
/// `completed` → [`SubagentStatus::Done`], `failed`/`aborted` →
/// [`SubagentStatus::Failed`], `running`/`pending` →
/// [`SubagentStatus::InProgress`]. `Detached` is assigned at turn end (see [`detach_rows`]).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    InProgress,
    Done,
    Failed,
    Detached,
}

/// One subagent's live render state in a `task` batch. Seeded from the tool args
/// at start (`index`, `agent`, `description`), then folded forward from each
/// `tool_execution_update` snapshot matched by `index`.
pub struct SubagentRow {
    pub index: u64,
    pub agent: String,
    pub description: String,
    pub status: SubagentStatus,
    pub tool_count: u64,
    pub current_tool: Option<String>,
    pub current_tool_args: Option<String>,
    pub last_intent: Option<String>,
    pub resolved_model: Option<String>,
}

/// One row per subagent from a `task` call's args (`{ agent, tasks: [...] }`, or
/// a single `{ id, description }`). Array position becomes `index` — preserved
/// across id-less skips — to match `AgentProgress.index`. Empty if not a batch.
pub fn extract_subagent_rows(args: &serde_json::Value) -> Vec<SubagentRow> {
    let Some(obj) = args.as_object() else {
        return Vec::new();
    };
    let agent = obj.get("agent").and_then(serde_json::Value::as_str).unwrap_or("agent");
    if let Some(list) = obj.get("tasks").and_then(serde_json::Value::as_array) {
        return list
            .iter()
            .enumerate()
            .filter(|(_, entry)| has_id(entry))
            .map(|(index, entry)| seed_row(index as u64, agent, entry))
            .collect();
    }
    if has_id(args) {
        return vec![seed_row(0, agent, args)];
    }
    Vec::new()
}

fn has_id(value: &serde_json::Value) -> bool {
    value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| !s.is_empty())
}

fn seed_row(index: u64, agent: &str, entry: &serde_json::Value) -> SubagentRow {
    SubagentRow {
        index,
        agent: agent.to_owned(),
        description: entry
            .get("description")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        status: SubagentStatus::InProgress,
        tool_count: 0,
        current_tool: None,
        current_tool_args: None,
        last_intent: None,
        resolved_model: None,
    }
}

/// Fold an update's per-subagent snapshots onto rows by `index`. Tolerates
/// `{ details: { progress } }` and bare `{ progress }`. The four live fields are
/// overwritten every snapshot (omitted clears) so the row mirrors the latest.
pub fn apply_progress(rows: &mut [SubagentRow], partial: &serde_json::Value) {
    let Some(progress) = read_progress(partial) else {
        return;
    };
    for entry in progress {
        let Some(index) = entry.get("index").and_then(serde_json::Value::as_u64) else {
            continue;
        };
        let Some(row) = rows.iter_mut().find(|r| r.index == index) else {
            continue;
        };
        if let Some(status) = entry
            .get("status")
            .and_then(serde_json::Value::as_str)
            .and_then(normalize_status)
        {
            row.status = status;
        }
        row.current_tool = str_field(entry, "currentTool");
        row.current_tool_args = str_field(entry, "currentToolArgs");
        row.last_intent = str_field(entry, "lastIntent");
        row.resolved_model = str_field(entry, "resolvedModel");
        if let Some(count) = entry.get("toolCount").and_then(serde_json::Value::as_u64) {
            row.tool_count = count;
        }
        if row.description.is_empty()
            && let Some(desc) = entry.get("description").and_then(serde_json::Value::as_str)
        {
            row.description = desc.to_owned();
        }
        if let Some(agent) = str_field(entry, "agent") {
            row.agent = agent;
        }
    }
}

/// At batch end settle any row still [`SubagentStatus::InProgress`] — to
/// [`SubagentStatus::Failed`] when the whole `task` call errored, else
/// [`SubagentStatus::Done`]. The update stream may not deliver a terminal
/// snapshot for every row before the end frame lands.
pub fn settle_rows(rows: &mut [SubagentRow], is_error: bool) {
    let fallback = if is_error {
        SubagentStatus::Failed
    } else {
        SubagentStatus::Done
    };
    for row in rows.iter_mut().filter(|r| r.status == SubagentStatus::InProgress) {
        row.status = fallback;
    }
}

/// Settle still-running rows to [`SubagentStatus::Detached`] at a backgrounded turn end.
pub fn detach_rows(rows: &mut [SubagentRow]) {
    for row in rows.iter_mut().filter(|r| r.status == SubagentStatus::InProgress) {
        row.status = SubagentStatus::Detached;
    }
}

/// The `task` batch message: a header (emoji + `Running`/`Spawned`/`Ran`; `👥` while
/// any row is live, else `❌` if one failed / `🚀` if backgrounded — never `✅`) then
/// one row per subagent.
pub fn render_subagent_batch(rows: &[SubagentRow], elapsed_ms: u64) -> String {
    let elapsed = format_duration(elapsed_ms);
    let plural = if rows.len() == 1 { "" } else { "s" };
    let n = rows.len();
    let live = rows.iter().any(|r| r.status == SubagentStatus::InProgress);
    let failed = rows.iter().any(|r| r.status == SubagentStatus::Failed);
    let detached = rows.iter().any(|r| r.status == SubagentStatus::Detached);
    let emoji = if live || (!failed && !detached) {
        "👥"
    } else if failed {
        "❌"
    } else {
        "🚀"
    };
    let verb = if live {
        "Running"
    } else if detached {
        "Spawned"
    } else {
        "Ran"
    };
    let mut out = format!("{emoji} {verb} {n} task{plural} · {elapsed}");
    for row in rows {
        out.push('\n');
        out.push_str(&render_subagent_row(row));
    }
    out
}

fn render_subagent_row(row: &SubagentRow) -> String {
    let label = if row.description.is_empty() {
        String::new()
    } else {
        format!(" \"{}\"", truncate(first_line(&row.description), SUBAGENT_LABEL_MAX))
    };
    let action = match row.status {
        SubagentStatus::Done => "✅ done".to_owned(),
        SubagentStatus::Failed => "❌ failed".to_owned(),
        SubagentStatus::Detached => "🚀 backgrounded".to_owned(),
        SubagentStatus::InProgress => match &row.current_tool {
            Some(tool) => {
                let preview = match &row.current_tool_args {
                    Some(args) => format!(" {}", truncate(first_line(args), SUBAGENT_ARGS_MAX)),
                    None => String::new(),
                };
                format!("🔧 {tool}{preview}")
            }
            None => format!(
                "⏳ {}",
                truncate(first_line(row.last_intent.as_deref().unwrap_or("idle")), SUBAGENT_INTENT_MAX)
            ),
        },
    };
    let counter = if row.tool_count > 0 {
        let plural = if row.tool_count == 1 { "" } else { "s" };
        format!("  · {} tool{plural}", row.tool_count)
    } else {
        String::new()
    };
    let model = match &row.resolved_model {
        Some(model) => format!("  · {}", truncate(model, SUBAGENT_MODEL_MAX)),
        None => String::new(),
    };
    let (index, agent) = (row.index, &row.agent);
    format!("  └ [{index}] {agent}{label}  {action}{counter}{model}")
}

fn read_progress(partial: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    let scope = match partial.get("details") {
        Some(details) if details.is_object() => details,
        _ => partial,
    };
    scope.get("progress").and_then(serde_json::Value::as_array)
}

/// `details.async.state` from a `task` frame, tolerating a bare or `details`-wrapped envelope.
fn async_state(scope: &serde_json::Value) -> Option<&str> {
    let inner = match scope.get("details") {
        Some(details) if details.is_object() => details,
        _ => scope,
    };
    inner.get("async")?.get("state")?.as_str()
}

/// Whether a `task` end is only the async spawn-ack (`async.state == "running"`):
/// the batch must stay open for the terminal that lands later via `update`.
pub fn is_spawn_ack(result: &serde_json::Value) -> bool {
    async_state(result) == Some("running")
}

/// Terminal outcome of an async `task` update: `Some(false)` completed, `Some(true)`
/// failed (cancel/abort also fold to `failed`), `None` while running or non-async.
pub fn async_terminal(partial: &serde_json::Value) -> Option<bool> {
    match async_state(partial)? {
        "completed" => Some(false),
        "failed" => Some(true),
        _ => None,
    }
}

fn str_field(entry: &serde_json::Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn normalize_status(value: &str) -> Option<SubagentStatus> {
    match value {
        "completed" => Some(SubagentStatus::Done),
        "failed" | "aborted" => Some(SubagentStatus::Failed),
        "running" | "pending" => Some(SubagentStatus::InProgress),
        _ => None,
    }
}

/// Compact human-facing duration: largest non-zero unit down to seconds,
/// skipping zero components (`1m`, `1h5s`, `1d30m`). Sub-second renders `0s`.
pub fn format_duration(ms: u64) -> String {
    if ms < 1_000 {
        return "0s".to_owned();
    }
    let total_sec = ms / 1_000;
    let (day, hr, min, sec) = (
        total_sec / 86_400,
        (total_sec % 86_400) / 3_600,
        (total_sec % 3_600) / 60,
        total_sec % 60,
    );
    let mut out = String::new();
    for (value, unit) in [(day, 'd'), (hr, 'h'), (min, 'm'), (sec, 's')] {
        if value > 0 {
            let _ = std::fmt::Write::write_fmt(&mut out, format_args!("{value}{unit}"));
        }
    }
    if out.is_empty() { "0s".to_owned() } else { out }
}

/// Char-aware truncation with a trailing ellipsis; `max` counts the ellipsis.
pub(crate) fn truncate(s: &str, max: usize) -> String {
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

/// The edit tool's target path: an explicit `path` arg, else the path parsed
/// from the first hashline header (`[path#TAG]`) or apply-patch directive
/// (`*** Update File: path`) in its `input`. Borrows from the inputs; `""` when
/// nothing resolves.
fn edit_path_arg<'a>(path: &'a str, input: &'a str) -> &'a str {
    if !path.is_empty() {
        return path;
    }
    for line in input.lines() {
        // Anchored to the line start (like picomp's `^\s*\[`): a hashline header
        // opens its line, so a mid-line bracket in an apply-patch diff body
        // (`#[derive]`, `arr[0]`) can't be mistaken for one.
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
    fn table_becomes_titled_nested_bullets() {
        let input =
            "| Name | Role | Status |\n| --- | --- | --- |\n| Alice | Admin | Active |\n| Bob | User | Disabled |";
        let expected =
            "- **Alice**\n  - Role: Admin\n  - Status: Active\n- **Bob**\n  - Role: User\n  - Status: Disabled";
        assert_eq!(tables_to_lists(input), expected);
    }

    #[test]
    fn table_without_outer_pipes_and_aligned_delimiter() {
        let input = "Name | Role\n:--- | ---:\nAlice | Admin";
        assert_eq!(tables_to_lists(input), "- **Alice**\n  - Role: Admin");
    }

    #[test]
    fn surrounding_prose_is_preserved() {
        let input = "Intro line.\n\n| K | V |\n| --- | --- |\n| x | 1 |\n\nOutro line.";
        let expected = "Intro line.\n\n- **x**\n  - V: 1\n\nOutro line.";
        assert_eq!(tables_to_lists(input), expected);
    }

    #[test]
    fn table_inside_fence_is_left_verbatim() {
        let backtick = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```";
        assert_eq!(tables_to_lists(backtick), backtick);
        // A stray ``` inside the ~~~ block must not close the ~~~ fence early.
        let tilde = "~~~\n| a | b |\n| - | - |\n```\n| 1 | 2 |\n~~~";
        assert_eq!(tables_to_lists(tilde), tilde);
    }

    #[test]
    fn non_table_constructs_stay_untouched() {
        let heading = "Heading text\n---\nBody paragraph.";
        assert_eq!(tables_to_lists(heading), heading);
        let mismatch = "a | b | c\n--- | ---";
        assert_eq!(tables_to_lists(mismatch), mismatch);
        let header_only = "| A | B |\n| --- | --- |";
        assert_eq!(tables_to_lists(header_only), header_only);
    }

    #[test]
    fn escaped_pipe_and_empty_cells_handled() {
        let escaped = "| Expr | Meaning |\n| --- | --- |\n| `a \\| b` | or |";
        assert_eq!(tables_to_lists(escaped), "- **`a | b`**\n  - Meaning: or");
        let empty = "| Name | Role | Status |\n| --- | --- | --- |\n| Alice |  | Active |";
        assert_eq!(tables_to_lists(empty), "- **Alice**\n  - Status: Active");
    }

    #[test]
    fn empty_title_cell_flattens_instead_of_bare_marker() {
        let input = "| Name | Role |\n| --- | --- |\n|  | Admin |";
        assert_eq!(tables_to_lists(input), "- Role: Admin");
    }

    fn line(name: &str, args: serde_json::Value) -> String {
        tool_activity_line(&ToolCallStart::from(crate::omp::protocol::ToolCall {
            tool_call_id: "id".to_owned(),
            tool_name: name.to_owned(),
            args,
            intent: None,
        }))
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
        // task is routed to the subagent renderer; reaching the activity feed it renders generically.
        assert_eq!(line("task", json!({ "agent": "explore" })), "🛠️ task");
    }

    #[test]
    fn search_tolerates_string_or_array_paths() {
        use serde_json::json;
        // OMP's `search` schemas `paths` as string|array; a string form must not
        // abort the whole args decode and blank the pattern.
        assert_eq!(line("search", json!({ "pattern": "TODO", "paths": "src" })), "🔍 TODO");
        assert_eq!(line("search", json!({ "pattern": "TODO", "paths": ["src", "lib"] })), "🔍 TODO");
        // A bare-string `paths` still resolves as the primary when it's all there is.
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

    fn batch_args() -> serde_json::Value {
        serde_json::json!({
            "agent": "explore",
            "tasks": [
                { "id": "ExploreRouter", "description": "map the router" },
                { "id": "ExploreDb", "description": "map the db" },
            ],
        })
    }

    fn progress(entries: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "content": [{ "type": "text", "text": "Running..." }], "details": { "progress": entries } })
    }

    #[test]
    fn start_render_has_header_and_one_idle_row_per_subagent() {
        let rows = extract_subagent_rows(&batch_args());
        let content = render_subagent_batch(&rows, 0);
        assert!(content.contains("👥 Running 2 tasks · 0s"));
        assert!(content.contains("  └ [0] explore \"map the router\"  ⏳ idle"));
        assert!(content.contains("  └ [1] explore \"map the db\"  ⏳ idle"));
    }

    #[test]
    fn progress_partial_renders_tool_args_count_and_model() {
        let mut rows = extract_subagent_rows(&batch_args());
        apply_progress(
            &mut rows,
            &progress(serde_json::json!([
                {
                    "index": 0,
                    "status": "running",
                    "currentTool": "read",
                    "currentToolArgs": "packages/agent/src/discord/subagent-render.ts",
                    "toolCount": 3,
                    "resolvedModel": "anthropic/claude",
                },
                { "index": 1, "status": "running", "lastIntent": "Scanning schema", "toolCount": 1 },
            ])),
        );
        let content = render_subagent_batch(&rows, 0);
        assert!(content.contains("🔧 read packages/agent/src/discord/subagent-ren\u{2026}"));
        assert!(content.contains("· 3 tools"));
        assert!(content.contains("· anthropic/claude"));
        assert!(content.contains("  └ [1] explore \"map the db\"  ⏳ Scanning schema  · 1 tool"));
    }

    #[test]
    fn end_freezes_done_header_and_settles_running_rows() {
        let mut rows = extract_subagent_rows(&batch_args());
        apply_progress(
            &mut rows,
            &progress(serde_json::json!([
                { "index": 0, "status": "completed", "toolCount": 5 },
                { "index": 1, "status": "running", "currentTool": "search", "toolCount": 2 },
            ])),
        );
        settle_rows(&mut rows, false);
        let content = render_subagent_batch(&rows, 3_000);
        assert!(content.starts_with("👥 Ran 2 tasks · 3s"));
        assert!(content.contains("  └ [0] explore \"map the router\"  ✅ done  · 5 tools"));
        assert!(content.contains("  └ [1] explore \"map the db\"  ✅ done  · 2 tools"));
    }

    #[test]
    fn errored_batch_settles_running_rows_to_failed() {
        let mut rows = extract_subagent_rows(&batch_args());
        apply_progress(
            &mut rows,
            &progress(serde_json::json!([
                { "index": 0, "status": "failed", "toolCount": 4 },
                { "index": 1, "status": "running", "toolCount": 1 },
            ])),
        );
        settle_rows(&mut rows, true);
        let content = render_subagent_batch(&rows, 1_000);
        assert!(content.starts_with("❌ Ran 2 tasks · 1s"));
        assert!(content.contains("  └ [0] explore \"map the router\"  ❌ failed  · 4 tools"));
        assert!(content.contains("  └ [1] explore \"map the db\"  ❌ failed  · 1 tool"));
    }

    #[test]
    fn one_failure_taints_an_otherwise_done_header() {
        let mut rows = extract_subagent_rows(&batch_args());
        apply_progress(
            &mut rows,
            &progress(serde_json::json!([
                { "index": 0, "status": "completed", "toolCount": 3 },
                { "index": 1, "status": "failed", "toolCount": 1 },
            ])),
        );
        let content = render_subagent_batch(&rows, 2_000);
        assert!(content.starts_with("❌ Ran 2 tasks · 2s"), "got: {content:?}");
        assert!(content.contains("  └ [0] explore \"map the router\"  ✅ done  · 3 tools"));
    }

    #[test]
    fn multiline_fields_stay_one_row() {
        let args = serde_json::json!({
            "agent": "explore",
            "tasks": [{ "id": "A", "description": "map\nthe router" }],
        });
        let mut rows = extract_subagent_rows(&args);
        apply_progress(
            &mut rows,
            &progress(serde_json::json!([
                { "index": 0, "status": "running", "currentTool": "bash", "currentToolArgs": "echo hi\nrm -rf /" },
            ])),
        );
        let content = render_subagent_batch(&rows, 0);
        assert_eq!(content.lines().count(), 2, "header + one row, got: {content:?}");
        assert!(content.contains("explore \"map\"  🔧 bash echo hi"));
    }

    #[test]
    fn non_batch_args_yield_no_rows() {
        assert!(extract_subagent_rows(&serde_json::json!({ "not": "a batch" })).is_empty());
        assert!(extract_subagent_rows(&serde_json::json!({ "tasks": [{ "description": "no id" }] })).is_empty());
    }

    #[test]
    fn single_task_fallback_seeds_one_row() {
        let rows =
            extract_subagent_rows(&serde_json::json!({ "agent": "oracle", "id": "Solo", "description": "do it" }));
        assert_eq!(rows.len(), 1);
        let content = render_subagent_batch(&rows, 0);
        assert!(content.starts_with("👥 Running 1 task · 0s"));
        assert!(content.contains("  └ [0] oracle \"do it\"  ⏳ idle"));
    }

    #[test]
    fn duration_skips_zero_components() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(999), "0s");
        assert_eq!(format_duration(1_000), "1s");
        assert_eq!(format_duration(65_000), "1m5s");
        assert_eq!(format_duration(3_600_000), "1h");
        assert_eq!(format_duration(90_000_000), "1d1h");
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

    #[test]
    fn task_decision_helpers_classify_frames() {
        use serde_json::json;
        let frame = |state: &str| json!({ "details": { "async": { "state": state } } });
        assert!(is_spawn_ack(&frame("running")));
        assert_eq!(async_terminal(&frame("running")), None);
        assert!(!is_spawn_ack(&frame("completed")));
        assert_eq!(async_terminal(&frame("completed")), Some(false));
        assert_eq!(async_terminal(&frame("failed")), Some(true));
        assert!(is_spawn_ack(&json!({ "async": { "state": "running" } })));
        assert!(!is_spawn_ack(&json!({ "details": { "progress": [] } })));
        assert_eq!(async_terminal(&json!({ "content": [] })), None);
    }

    #[test]
    fn async_task_settles_on_terminal_update_not_spawn_ack() {
        use serde_json::json;
        let args = json!({ "agent": "explore", "tasks": [{ "id": "ReadHello", "description": "read the file" }] });
        let frame = |astate: &str, pstatus: &str| {
            json!({
                "content": [{ "type": "text", "text": "..." }],
                "details": {
                    "async": { "state": astate, "jobId": "ReadHello", "type": "task" },
                    "progress": [{ "index": 0, "id": "ReadHello", "agent": "explore", "status": pstatus }],
                }
            })
        };
        let mut rows = extract_subagent_rows(&args);
        for f in [frame("running", "pending"), frame("running", "running")] {
            apply_progress(&mut rows, &f);
            assert_eq!(async_terminal(&f), None);
        }
        assert!(render_subagent_batch(&rows, 0).contains("⏳"));
        let term = frame("completed", "completed");
        apply_progress(&mut rows, &term);
        assert_eq!(async_terminal(&term), Some(false));
        settle_rows(&mut rows, false);
        let done = render_subagent_batch(&rows, 14_000);
        assert!(done.starts_with("👥 Ran 1 task · 14s"), "got: {done:?}");
        assert!(done.contains("✅ done"));
    }

    #[test]
    fn async_task_terminal_failed_renders_failed() {
        use serde_json::json;
        let args = json!({ "agent": "task", "tasks": [{ "id": "SleepAgent", "description": "sleep" }] });
        let term = json!({
            "details": {
                "async": { "state": "failed", "jobId": "SleepAgent", "type": "task" },
                "progress": [{ "index": 0, "id": "SleepAgent", "agent": "task", "status": "aborted" }],
            }
        });
        let mut rows = extract_subagent_rows(&args);
        apply_progress(&mut rows, &term);
        assert_eq!(async_terminal(&term), Some(true));
        settle_rows(&mut rows, true);
        let out = render_subagent_batch(&rows, 8_000);
        assert!(out.starts_with("❌ Ran 1 task · 8s"), "got: {out:?}");
        assert!(out.contains("❌ failed"));
    }

    #[test]
    fn detached_backgrounded_task_settles_off_running() {
        use serde_json::json;
        let args = json!({ "agent": "reviewer", "tasks": [{ "id": "Rev", "description": "review the diff" }] });
        let mut rows = extract_subagent_rows(&args);
        detach_rows(&mut rows);
        let out = render_subagent_batch(&rows, 12_000);
        assert!(out.starts_with("🚀 Spawned 1 task · 12s"), "got: {out:?}");
        assert!(out.contains("🚀 backgrounded"));
        assert!(!out.contains("Running"));
        let mut done = extract_subagent_rows(&args);
        settle_rows(&mut done, false);
        detach_rows(&mut done);
        assert!(render_subagent_batch(&done, 1_000).contains("✅ done"));
    }

    #[test]
    fn failed_plus_detached_header_keeps_failure_emoji_with_spawned_verb() {
        let mut rows = extract_subagent_rows(&batch_args());
        apply_progress(
            &mut rows,
            &progress(serde_json::json!([
                { "index": 0, "status": "failed", "toolCount": 1 },
                { "index": 1, "status": "running" },
            ])),
        );
        detach_rows(&mut rows);
        let out = render_subagent_batch(&rows, 5_000);
        assert!(out.starts_with("❌ Spawned 2 tasks · 5s"), "got: {out:?}");
        assert!(out.contains("❌ failed"));
        assert!(out.contains("🚀 backgrounded"));
    }
}
