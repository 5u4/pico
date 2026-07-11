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

const SUBAGENT_LABEL_MAX: usize = 28;
const SUBAGENT_ARGS_MAX: usize = 40;
const SUBAGENT_INTENT_MAX: usize = 40;
const SUBAGENT_MODEL_MAX: usize = 30;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    InProgress,
    Done,
    Failed,
    Detached,
}

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

pub fn detach_rows(rows: &mut [SubagentRow]) {
    for row in rows.iter_mut().filter(|r| r.status == SubagentStatus::InProgress) {
        row.status = SubagentStatus::Detached;
    }
}

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

fn async_state(scope: &serde_json::Value) -> Option<&str> {
    let inner = match scope.get("details") {
        Some(details) if details.is_object() => details,
        _ => scope,
    };
    inner.get("async")?.get("state")?.as_str()
}

pub fn is_spawn_ack(result: &serde_json::Value) -> bool {
    async_state(result) == Some("running")
}

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

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

pub fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or(s)
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

fn hard_wrap(line: &str, budget: usize, in_fence: bool, open_info: &str) -> Vec<String> {
    let max = if in_fence {
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
        assert!(split_to_budget("", 1800).is_empty());
        assert!(split_to_budget("   \n  \t ", 1800).is_empty());
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
            "agent": "scout",
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
        assert!(content.contains("  └ [0] scout \"map the router\"  ⏳ idle"));
        assert!(content.contains("  └ [1] scout \"map the db\"  ⏳ idle"));
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
        assert!(content.contains("  └ [1] scout \"map the db\"  ⏳ Scanning schema  · 1 tool"));
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
        assert!(content.contains("  └ [0] scout \"map the router\"  ✅ done  · 5 tools"));
        assert!(content.contains("  └ [1] scout \"map the db\"  ✅ done  · 2 tools"));
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
        assert!(content.contains("  └ [0] scout \"map the router\"  ❌ failed  · 4 tools"));
        assert!(content.contains("  └ [1] scout \"map the db\"  ❌ failed  · 1 tool"));
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
        assert!(content.contains("  └ [0] scout \"map the router\"  ✅ done  · 3 tools"));
    }

    #[test]
    fn multiline_fields_stay_one_row() {
        let args = serde_json::json!({
            "agent": "scout",
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
        assert!(content.contains("scout \"map\"  🔧 bash echo hi"));
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
        let args = json!({ "agent": "scout", "tasks": [{ "id": "ReadHello", "description": "read the file" }] });
        let frame = |astate: &str, pstatus: &str| {
            json!({
                "content": [{ "type": "text", "text": "..." }],
                "details": {
                    "async": { "state": astate, "jobId": "ReadHello", "type": "task" },
                    "progress": [{ "index": 0, "id": "ReadHello", "agent": "scout", "status": pstatus }],
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
