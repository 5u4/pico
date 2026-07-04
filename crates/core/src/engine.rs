use std::{
    collections::HashMap,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use crate::{
    cancel::CancelRegistry,
    config::StreamingBehavior,
    mid_turn::MidTurnQueue,
    omp::{
        client::OmpSessionHandle,
        pool::ThreadSession,
        protocol::{
            AssistantMessageEvent, ImageAttachment, OmpEvent, ToolCall, ToolCallEnd, ToolCallUpdate, UiRequest,
            UiResponse,
        },
    },
    render,
    surface::{ConversationId, PostOpts, Surface, UiOutcome, UiReply},
};

const STALL_TIMEOUT: Duration = Duration::from_secs(900);
const TOOL_STALL_TIMEOUT: Duration = Duration::from_secs(3600);
const SETTLE_GRACE: Duration = Duration::from_secs(1);
const ACTIVITY_THROTTLE: Duration = Duration::from_secs(1);
const SUBAGENT_THROTTLE: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    Live,
    Dead,
}

pub struct TurnRequest<'a> {
    pub conversation: &'a ConversationId,
    pub prompt: &'a str,
    pub images: &'a [ImageAttachment],
    pub mode: StreamingBehavior,
    pub cancel: &'a CancellationToken,
}

pub struct TurnRuntime<'a> {
    pub mid_turn: &'a MidTurnQueue,
    pub cancels: &'a CancelRegistry,
}

pub async fn drive_turn<S: Surface>(
    surface: &S,
    session: &mut ThreadSession,
    req: TurnRequest<'_>,
    rt: TurnRuntime<'_>,
    title_seed: &mut Option<String>,
) -> color_eyre::Result<TurnOutcome> {
    let _typing = surface.typing();
    session.client.prompt(req.prompt, req.images).await?;
    let (mut rx, _sink_guard) = rt.mid_turn.register(req.conversation, req.mode);
    let (interrupt, streaming, _cancel_guard) = rt.cancels.register(req.conversation);
    let mut aborted = false;
    let mut held: Option<String> = None;
    let mut answer_delivered = false;
    let mut suppress_text = false;
    let mut settling = false;
    let mut explicit_runs_pending: usize = 1;
    let mut awaiting_deferred = false;
    let mut deferred: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut committed_any = false;
    let mut last_stop: Option<crate::omp::protocol::AssistantStop> = None;
    let mut tools_running: usize = 0;
    let mut tool_seen = false;
    let mut activity_shown = false;

    let mut reply = String::new();
    let mut activity = Activity::new(surface);
    let mut subagents = SubagentFeed::new(surface);

    loop {
        let idle_wait = if settling && !awaiting_deferred {
            SETTLE_GRACE
        } else if tools_running > 0 {
            TOOL_STALL_TIMEOUT
        } else {
            STALL_TIMEOUT
        };
        let event = tokio::select! {
            () = req.cancel.cancelled() => {
                activity.flush().await;
                subagents.flush_all(false).await;
                let _ = flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered).await;
                surface.say("worker is restarting; resend your message to continue").await;
                return Ok(TurnOutcome::Live);
            }
            () = interrupt.cancelled(), if !aborted => {
                aborted = true;
                if let Err(e) = session.client.abort().await {
                    tracing::warn!(error = %format!("{e:#}"), "abort on /cancel failed");
                }
                continue;
            }
            Some((text, mode)) = rx.recv() => {
                let forwarded = match mode {
                    StreamingBehavior::FollowUp => session.client.follow_up(&text).await,
                    StreamingBehavior::Steer => session.client.steer(&text).await,
                    StreamingBehavior::Queue => {
                        deferred.push_back(text);
                        continue;
                    }
                };
                if let Err(e) = forwarded {
                    tracing::warn!(error = %format!("{e:#}"), mode = ?mode, "forwarding mid-turn message to omp failed");
                }
                continue;
            }
            recv = tokio::time::timeout(idle_wait, session.events.recv()) => match recv {
                Ok(event) => event,
                Err(_) if settling => {
                    if forward_next_pending(&session.client, &mut deferred, &mut rx).await? {
                        explicit_runs_pending += 1;
                        settling = false;
                        continue;
                    }
                    break;
                }
                Err(_) => {
                    tracing::warn!(timeout = ?idle_wait, "turn made no progress; resetting wedged OMP session");
                    activity.flush().await;
                    subagents.flush_all(true).await;
                    let _ = flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered).await;
                    surface
                        .say("the turn stalled with no progress and was reset; resend your message to continue")
                        .await;
                    return Ok(TurnOutcome::Dead);
                }
            },
        };
        if event.is_some() {
            settling = false;
        }
        match event {
            Some(OmpEvent::Message(AssistantMessageEvent::TextDelta { delta })) => {
                if !suppress_text {
                    reply.push_str(&delta);
                }
            }
            Some(OmpEvent::Message(AssistantMessageEvent::TextEnd { content })) => {
                if suppress_text {
                    reply.clear();
                } else {
                    let seg = if content.is_empty() {
                        std::mem::take(&mut reply)
                    } else {
                        content
                    };
                    reply.clear();
                    committed_any |=
                        hold_segment(surface, &mut activity, &mut held, title_seed, answer_delivered, seg).await;
                }
            }
            Some(OmpEvent::Message(AssistantMessageEvent::ThinkingEnd { content })) => {
                if !suppress_text {
                    activity.thinking(&content).await;
                    activity_shown = true;
                }
            }
            Some(OmpEvent::ToolStart(tool)) => {
                tool_seen = true;
                tools_running += 1;
                if !reply.trim().is_empty() {
                    let seg = std::mem::take(&mut reply);
                    committed_any |=
                        hold_segment(surface, &mut activity, &mut held, title_seed, answer_delivered, seg).await;
                }
                if let Some(prev) = held.take() {
                    committed_any |= commit_text(surface, &mut activity, &prev, false, true).await;
                }
                if tool.tool_name == "task" {
                    activity.flush().await;
                    if subagents.start(&tool).await {
                        activity.seal();
                    }
                } else {
                    activity.start(&tool).await;
                }
            }
            Some(OmpEvent::ToolUpdate(tool)) => {
                if tool.tool_name == "task" {
                    subagents.update(&tool).await;
                }
            }
            Some(OmpEvent::ToolEnd(tool)) => {
                tools_running = tools_running.saturating_sub(1);
                match tool.tool_name.as_str() {
                    "task" => subagents.end(&tool).await,
                    _ => activity.end(&tool).await,
                }
            }
            Some(OmpEvent::UiRequest(ui_req)) => {
                if aborted {
                    continue;
                }
                activity.flush().await;
                streaming.store(false, Ordering::Release);
                let disposition = handle_ui(surface, &session.client, &ui_req).await;
                streaming.store(true, Ordering::Release);
                match disposition {
                    UiDisposition::Cancelled => {
                        subagents.flush_all(false).await;
                        let _ =
                            flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered)
                                .await;
                        surface
                            .say("worker restarted, so the pending question was discarded; resend your message to continue")
                            .await;
                        return Ok(TurnOutcome::Live);
                    }
                    UiDisposition::Continue { posted } => {
                        if posted {
                            activity.seal();
                        }
                    }
                }
            }
            Some(OmpEvent::TurnEnd) => {
                if !reply.trim().is_empty() {
                    let seg = std::mem::take(&mut reply);
                    committed_any |=
                        hold_segment(surface, &mut activity, &mut held, title_seed, answer_delivered, seg).await;
                }
            }
            Some(OmpEvent::AgentEnd) => {
                committed_any |=
                    flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered).await;
                answer_delivered = true;
                suppress_text = false;
                if explicit_runs_pending > 0 {
                    explicit_runs_pending -= 1;
                } else {
                    subagents.clear_one_backgrounded();
                }
                if forward_next_pending(&session.client, &mut deferred, &mut rx).await? {
                    explicit_runs_pending += 1;
                } else {
                    awaiting_deferred = subagents.has_pending_background();
                    settling = true;
                }
            }
            Some(OmpEvent::Error(e)) => {
                tracing::error!(error = %e, "omp reported a turn error");
                activity.flush().await;
                subagents.flush_all(true).await;
                let _ = flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered).await;
                surface.say(&format!("OMP error: {e}")).await;
                return Ok(TurnOutcome::Live);
            }
            Some(OmpEvent::CustomMessage { custom_type }) => {
                if aborted_capture_turn(aborted, &custom_type) {
                    suppress_text = true;
                    if let Err(e) = session.client.abort().await {
                        tracing::warn!(error = %format!("{e:#}"), "aborting autolearn capture turn after /cancel failed");
                    }
                } else if answer_delivered && custom_type == "autolearn-nudge" {
                    suppress_text = true;
                }
            }
            Some(OmpEvent::MessageEnd(stop)) => {
                last_stop = Some(stop);
            }
            Some(OmpEvent::AgentStart | OmpEvent::Message(AssistantMessageEvent::Other)) => {}
            None => {
                tracing::error!("omp host channel closed mid-turn; session is dead");
                activity.flush().await;
                subagents.flush_all(true).await;
                let _ = flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered).await;
                surface
                    .say("the OMP session ended unexpectedly; send another message to restart it")
                    .await;
                return Ok(TurnOutcome::Dead);
            }
        }
    }
    activity.flush().await;
    subagents.settle_backgrounded();
    subagents.flush_all(false).await;
    committed_any |= flush_final(surface, &mut activity, &mut reply, &mut held, title_seed, answer_delivered).await;
    if !committed_any && let Some(msg) = empty_turn_notice(last_stop.as_ref(), tool_seen || activity_shown) {
        surface.say(&msg).await;
    }
    Ok(TurnOutcome::Live)
}

fn empty_turn_notice(stop: Option<&crate::omp::protocol::AssistantStop>, showed_activity: bool) -> Option<String> {
    let stop = stop?;
    let reason = stop.stop_reason.as_deref();
    let detail = stop.stop_details_type.as_deref();
    match (reason, detail) {
        (Some("error"), Some("sensitive")) => Some(
            "The model declined to respond because the input was flagged as sensitive. Try rephrasing and resend."
                .to_owned(),
        ),
        (Some("error"), Some("refusal")) => {
            Some("The model refused this request. Try rephrasing and resend.".to_owned())
        }
        (Some("error"), _) => Some(format!(
            "The model returned an error and produced no reply{}.",
            stop.error_message
                .as_deref()
                .map(|m| format!(": {m}"))
                .unwrap_or_default(),
        )),
        (Some("stop"), _) if !showed_activity => {
            Some("The model produced no visible content this turn. Try again or rephrase.".to_owned())
        }
        _ => None,
    }
}

async fn forward_next_pending(
    client: &OmpSessionHandle,
    deferred: &mut std::collections::VecDeque<String>,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, StreamingBehavior)>,
) -> color_eyre::Result<bool> {
    let next = deferred
        .pop_front()
        .map(|text| (text, StreamingBehavior::Queue))
        .or_else(|| rx.try_recv().ok());
    let Some((text, mode)) = next else {
        return Ok(false);
    };
    match mode {
        StreamingBehavior::Queue => client.prompt(&text, &[]).await?,
        StreamingBehavior::FollowUp => client.follow_up(&text).await?,
        StreamingBehavior::Steer => client.steer(&text).await?,
    }
    Ok(true)
}

fn aborted_capture_turn(aborted: bool, custom_type: &str) -> bool {
    aborted && custom_type == "autolearn-nudge"
}

enum UiDisposition {
    Continue { posted: bool },
    Cancelled,
}

fn ui_request_id(req: &UiRequest) -> Option<&str> {
    match req {
        UiRequest::Select { id, .. }
        | UiRequest::Confirm { id, .. }
        | UiRequest::Input { id, .. }
        | UiRequest::Editor { id, .. } => Some(id),
        _ => None,
    }
}

async fn handle_ui<S: Surface>(surface: &S, client: &OmpSessionHandle, req: &UiRequest) -> UiDisposition {
    match req {
        UiRequest::Cancel { .. } | UiRequest::Ignore => UiDisposition::Continue { posted: false },
        UiRequest::Unknown { id, method } => {
            tracing::warn!(%method, "unrecognised extension_ui_request; auto-cancelled");
            if let Some(id) = id {
                let _ = client
                    .ui_response(&UiResponse::cancelled(client.session_id(), id, false))
                    .await;
            }
            UiDisposition::Continue { posted: false }
        }
        _ => match surface.ui(req).await {
            UiOutcome::Cancelled => {
                if let Some(id) = ui_request_id(req) {
                    let _ = client
                        .ui_response(&UiResponse::cancelled(client.session_id(), id, false))
                        .await;
                }
                UiDisposition::Cancelled
            }
            UiOutcome::Notified { posted } => UiDisposition::Continue { posted },
            UiOutcome::Respond { reply, posted } => {
                if let Some(id) = ui_request_id(req) {
                    let resp = match &reply {
                        UiReply::Value(v) => UiResponse::value(client.session_id(), id, v),
                        UiReply::Confirmed(b) => UiResponse::confirmed(client.session_id(), id, *b),
                        UiReply::Dismissed { timed_out } => UiResponse::cancelled(client.session_id(), id, *timed_out),
                    };
                    let _ = client.ui_response(&resp).await;
                }
                UiDisposition::Continue { posted }
            }
        },
    }
}

async fn commit_text<S: Surface>(
    surface: &S,
    activity: &mut Activity<'_, S>,
    text: &str,
    as_reply: bool,
    silent: bool,
) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    activity.flush().await;
    surface.post_reply(text, as_reply, silent).await;
    activity.seal();
    true
}

async fn hold_segment<S: Surface>(
    surface: &S,
    activity: &mut Activity<'_, S>,
    held: &mut Option<String>,
    title_seed: &mut Option<String>,
    title_locked: bool,
    seg: String,
) -> bool {
    if seg.trim().is_empty() {
        return false;
    }
    let mut posted = false;
    if let Some(prev) = held.take() {
        posted |= commit_text(surface, activity, &prev, false, true).await;
    }
    if !title_locked {
        *title_seed = Some(seg.clone());
    }
    *held = Some(seg);
    posted
}

async fn flush_final<S: Surface>(
    surface: &S,
    activity: &mut Activity<'_, S>,
    reply: &mut String,
    held: &mut Option<String>,
    title_seed: &mut Option<String>,
    title_locked: bool,
) -> bool {
    let mut posted = false;
    if !reply.trim().is_empty() {
        let seg = std::mem::take(reply);
        posted |= hold_segment(surface, activity, held, title_seed, title_locked, seg).await;
    }
    if let Some(text) = held.take() {
        posted |= commit_text(surface, activity, &text, true, false).await;
    }
    posted
}

struct Activity<'a, S: Surface> {
    surface: &'a S,
    hosts: Vec<ActivityHost<S::Msg>>,
    placements: HashMap<String, (usize, usize)>,
    last_edit: Instant,
    sealed: bool,
}

struct ActivityHost<M> {
    message: M,
    lines: Vec<String>,
    rendered: String,
    dirty: bool,
}

impl<M> ActivityHost<M> {
    fn text(&self, send_max: usize) -> String {
        let body = crate::platform_render::defang_mentions(&self.lines.join("\n"));
        if body.chars().count() <= send_max {
            return body;
        }
        body.chars().take(send_max).collect()
    }

    fn char_count(&self) -> usize {
        let body: usize = self.lines.iter().map(|l| l.chars().count()).sum();
        body + self.lines.len().saturating_sub(1)
    }
}

impl<'a, S: Surface> Activity<'a, S> {
    fn new(surface: &'a S) -> Self {
        Activity {
            surface,
            hosts: Vec::new(),
            placements: HashMap::new(),
            last_edit: Instant::now(),
            sealed: false,
        }
    }

    fn seal(&mut self) {
        self.sealed = true;
    }

    async fn start(&mut self, tool: &ToolCall) {
        let Some(line) = self.surface.tool_activity_line(tool) else {
            return;
        };
        if let Some(placement) = self.append(line).await {
            self.placements.insert(tool.tool_call_id.clone(), placement);
        }
    }

    async fn thinking(&mut self, content: &str) {
        let Some(line) = self.surface.thinking_line(content) else {
            return;
        };
        self.append(line).await;
    }

    async fn end(&mut self, tool: &ToolCallEnd) {
        let Some((host_idx, line_idx)) = self.placements.remove(&tool.tool_call_id) else {
            return;
        };
        if !tool.is_error {
            return;
        }
        let error = render::error_text(&tool.result);
        let Some(host) = self.hosts.get_mut(host_idx) else {
            return;
        };
        let Some(current) = host.lines.get(line_idx) else {
            return;
        };
        let next = self.surface.failure_line(current, error.as_deref());
        if next == *current {
            return;
        }
        host.lines[line_idx] = next;
        host.dirty = true;
        self.maybe_flush().await;
    }

    async fn append(&mut self, line: String) -> Option<(usize, usize)> {
        let limits = self.surface.limits();
        let rollover = self.sealed
            || match self.hosts.last() {
                None => true,
                Some(host) => {
                    let count = host.lines.len();
                    let projected = host.char_count() + line.chars().count() + usize::from(count > 0);
                    count + 1 > limits.activity_line_cap || projected > limits.activity_char_cap
                }
            };
        if rollover {
            let sent = crate::platform_render::defang_mentions(&line);
            let message = self.surface.post(&sent, PostOpts::SILENT).await?;
            self.hosts.push(ActivityHost {
                message,
                lines: vec![line],
                rendered: sent,
                dirty: false,
            });
            self.sealed = false;
            self.last_edit = Instant::now();
            return Some((self.hosts.len() - 1, 0));
        }
        let host_idx = self.hosts.len() - 1;
        let line_idx = {
            let host = self.hosts.last_mut().expect("host present when not rolling over");
            let idx = host.lines.len();
            host.lines.push(line);
            host.dirty = true;
            idx
        };
        self.maybe_flush().await;
        Some((host_idx, line_idx))
    }

    async fn maybe_flush(&mut self) {
        if self.last_edit.elapsed() >= ACTIVITY_THROTTLE {
            self.flush().await;
        }
    }

    async fn flush(&mut self) {
        let surface = self.surface;
        let send_max = surface.limits().activity_send_max;
        for host in &mut self.hosts {
            if !host.dirty {
                continue;
            }
            let text = host.text(send_max);
            if text == host.rendered {
                host.dirty = false;
                continue;
            }
            if surface.edit(&host.message, &text).await {
                host.rendered = text;
                host.dirty = false;
            }
        }
        self.last_edit = Instant::now();
    }
}

struct SubagentFeed<'a, S: Surface> {
    surface: &'a S,
    batches: HashMap<String, SubagentBatch<S::Msg>>,
}

struct SubagentBatch<M> {
    message: M,
    rows: Vec<render::SubagentRow>,
    started_at: Instant,
    last_edit: Instant,
    rendered: String,
    backgrounded: bool,
}

impl<'a, S: Surface> SubagentFeed<'a, S> {
    fn new(surface: &'a S) -> Self {
        SubagentFeed {
            surface,
            batches: HashMap::new(),
        }
    }

    async fn start(&mut self, call: &ToolCall) -> bool {
        let rows = render::extract_subagent_rows(&call.args);
        if rows.is_empty() {
            return false;
        }
        let content = subagent_send_text(
            &render::render_subagent_batch(&rows, 0),
            self.surface.limits().activity_send_max,
        );
        let Some(message) = self.surface.post(&content, PostOpts::SILENT).await else {
            return false;
        };
        let now = Instant::now();
        self.batches.insert(
            call.tool_call_id.clone(),
            SubagentBatch {
                message,
                rows,
                started_at: now,
                last_edit: now,
                rendered: content,
                backgrounded: false,
            },
        );
        true
    }

    async fn update(&mut self, tool: &ToolCallUpdate) {
        let Some(batch) = self.batches.get_mut(&tool.tool_call_id) else {
            return;
        };
        render::apply_progress(&mut batch.rows, &tool.partial_result);
        if let Some(is_error) = render::async_terminal(&tool.partial_result) {
            render::settle_rows(&mut batch.rows, is_error);
            self.edit(&tool.tool_call_id).await;
            self.batches.remove(&tool.tool_call_id);
        } else if batch.last_edit.elapsed() >= SUBAGENT_THROTTLE {
            self.edit(&tool.tool_call_id).await;
        }
    }

    async fn end(&mut self, tool: &ToolCallEnd) {
        if render::is_spawn_ack(&tool.result) {
            if let Some(batch) = self.batches.get_mut(&tool.tool_call_id) {
                batch.backgrounded = true;
            }
            return;
        }
        let Some(batch) = self.batches.get_mut(&tool.tool_call_id) else {
            return;
        };
        render::settle_rows(&mut batch.rows, tool.is_error);
        self.edit(&tool.tool_call_id).await;
        self.batches.remove(&tool.tool_call_id);
    }

    async fn flush_all(&mut self, settle_failed: bool) {
        let keys: Vec<String> = self.batches.keys().cloned().collect();
        for key in keys {
            if settle_failed && let Some(batch) = self.batches.get_mut(&key) {
                render::settle_rows(&mut batch.rows, true);
            }
            self.edit(&key).await;
        }
    }

    fn settle_backgrounded(&mut self) {
        for batch in self.batches.values_mut() {
            if batch.backgrounded {
                render::detach_rows(&mut batch.rows);
            }
        }
    }

    fn has_pending_background(&self) -> bool {
        self.batches.values().any(|batch| batch.backgrounded)
    }

    fn clear_one_backgrounded(&mut self) {
        if let Some(batch) = self.batches.values_mut().find(|batch| batch.backgrounded) {
            batch.backgrounded = false;
            render::detach_rows(&mut batch.rows);
        }
    }

    async fn edit(&mut self, key: &str) {
        let surface = self.surface;
        let Some(batch) = self.batches.get_mut(key) else {
            return;
        };
        let elapsed = batch.started_at.elapsed().as_millis() as u64;
        let content = subagent_send_text(
            &render::render_subagent_batch(&batch.rows, elapsed),
            surface.limits().activity_send_max,
        );
        if content == batch.rendered {
            batch.last_edit = Instant::now();
            return;
        }
        if surface.edit(&batch.message, &content).await {
            batch.rendered = content;
            batch.last_edit = Instant::now();
        }
    }
}

fn subagent_send_text(raw: &str, send_max: usize) -> String {
    let defanged = crate::platform_render::defang_mentions(raw);
    if defanged.chars().count() <= send_max {
        defanged
    } else {
        defanged.chars().take(send_max).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, atomic::AtomicU64};

    use super::*;
    use crate::surface::SizeLimits;

    #[derive(Default)]
    struct FakeSurface {
        posts: Mutex<Vec<(String, PostOpts)>>,
        edits: Mutex<Vec<(u64, String)>>,
        next_id: AtomicU64,
    }

    struct FakeTyping;

    impl Surface for FakeSurface {
        type Msg = u64;
        type Typing = FakeTyping;

        fn typing(&self) -> FakeTyping {
            FakeTyping
        }

        fn limits(&self) -> SizeLimits {
            SizeLimits {
                message_cap: 1900,
                activity_line_cap: 20,
                activity_char_cap: 1800,
                activity_send_max: 1990,
            }
        }

        async fn post(&self, text: &str, opts: PostOpts) -> Option<u64> {
            self.posts.lock().unwrap().push((text.to_owned(), opts));
            Some(self.next_id.fetch_add(1, Ordering::Relaxed))
        }

        async fn edit(&self, msg: &u64, text: &str) -> bool {
            self.edits.lock().unwrap().push((*msg, text.to_owned()));
            true
        }

        async fn ui(&self, _req: &UiRequest) -> UiOutcome {
            UiOutcome::Notified { posted: false }
        }

        fn tool_activity_line(&self, call: &ToolCall) -> Option<String> {
            Some(format!("🔧 {}", call.tool_name))
        }

        fn thinking_line(&self, content: &str) -> Option<String> {
            let t = content.trim();
            (!t.is_empty()).then(|| format!("🧠 {t}"))
        }

        fn failure_line(&self, current: &str, error: Option<&str>) -> String {
            let body = current.find(' ').map_or("", |i| &current[i..]);
            match error {
                Some(e) => format!("❌{body} — {e}"),
                None => format!("❌{body}"),
            }
        }
    }

    #[tokio::test]
    async fn intermediate_segments_are_silent_and_only_final_pings() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        let mut held = None;
        let mut reply = String::new();
        let mut title_seed = None;
        hold_segment(&surface, &mut activity, &mut held, &mut title_seed, false, "first".to_owned()).await;
        hold_segment(&surface, &mut activity, &mut held, &mut title_seed, false, "second".to_owned()).await;
        flush_final(&surface, &mut activity, &mut reply, &mut held, &mut title_seed, false).await;
        let posts = surface.posts.lock().unwrap();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].0, "first");
        assert!(posts[0].1.silent && !posts[0].1.as_reply);
        assert_eq!(posts[1].0, "second");
        assert!(posts[1].1.as_reply && !posts[1].1.silent);
        assert_eq!(title_seed.as_deref(), Some("second"));
    }

    #[tokio::test]
    async fn title_seed_survives_turn_ending_on_a_tool() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        let mut held = None;
        let mut reply = String::new();
        let mut title_seed = None;
        hold_segment(
            &surface,
            &mut activity,
            &mut held,
            &mut title_seed,
            false,
            "the substantive answer".to_owned(),
        )
        .await;
        let prev = held.take().unwrap();
        commit_text(&surface, &mut activity, &prev, false, true).await;
        flush_final(&surface, &mut activity, &mut reply, &mut held, &mut title_seed, false).await;
        assert_eq!(title_seed.as_deref(), Some("the substantive answer"));
    }

    #[tokio::test]
    async fn final_reply_is_handed_whole_to_post_reply() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        let mut held = Some("x".repeat(4000));
        let mut reply = String::new();
        let mut title_seed = None;
        flush_final(&surface, &mut activity, &mut reply, &mut held, &mut title_seed, false).await;
        let posts = surface.posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].0.chars().count(), 4000);
        assert!(posts[0].1.as_reply && !posts[0].1.silent);
    }

    #[tokio::test]
    async fn whitespace_only_segment_posts_nothing() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        let mut held = Some("   ".to_owned());
        let mut reply = String::new();
        let mut title_seed = None;
        flush_final(&surface, &mut activity, &mut reply, &mut held, &mut title_seed, false).await;
        assert!(surface.posts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn locked_title_seed_survives_a_post_answer_segment() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        let mut held = None;
        let mut reply = String::new();
        let mut title_seed = None;
        hold_segment(
            &surface,
            &mut activity,
            &mut held,
            &mut title_seed,
            false,
            "the real answer".to_owned(),
        )
        .await;
        flush_final(&surface, &mut activity, &mut reply, &mut held, &mut title_seed, false).await;
        hold_segment(
            &surface,
            &mut activity,
            &mut held,
            &mut title_seed,
            true,
            "autolearn reflection".to_owned(),
        )
        .await;
        flush_final(&surface, &mut activity, &mut reply, &mut held, &mut title_seed, true).await;
        assert_eq!(title_seed.as_deref(), Some("the real answer"));
        let posts = surface.posts.lock().unwrap();
        assert_eq!(posts[0].0, "the real answer");
        assert_eq!(posts.last().unwrap().0, "autolearn reflection");
    }

    #[tokio::test]
    async fn sealing_activity_starts_a_fresh_host() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        activity.thinking("alpha").await;
        let after_alpha = surface.posts.lock().unwrap().len();
        activity.thinking("beta").await;
        let after_beta = surface.posts.lock().unwrap().len();
        activity.seal();
        activity.thinking("gamma").await;
        let after_gamma = surface.posts.lock().unwrap().len();
        assert_eq!(after_alpha, 1);
        assert_eq!(after_beta, 1);
        assert_eq!(after_gamma, 2);
    }

    #[tokio::test]
    async fn tool_failure_rewrites_its_activity_line() {
        let surface = FakeSurface::default();
        let mut activity = Activity::new(&surface);
        let call = ToolCall {
            tool_call_id: "t1".to_owned(),
            tool_name: "bash".to_owned(),
            args: serde_json::json!({}),
            intent: None,
        };
        activity.start(&call).await;
        let end = ToolCallEnd {
            tool_call_id: "t1".to_owned(),
            tool_name: "bash".to_owned(),
            result: serde_json::json!({ "content": [{ "type": "text", "text": "boom" }] }),
            is_error: true,
        };
        activity.end(&end).await;
        activity.flush().await;
        let edits = surface.edits.lock().unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].1, "❌ bash — boom");
    }

    #[test]
    fn ui_request_id_is_present_only_for_prompting_variants() {
        let select = UiRequest::Select {
            id: "abc".to_owned(),
            title: String::new(),
            options: Vec::new(),
            timeout: None,
        };
        assert_eq!(ui_request_id(&select), Some("abc"));
        let notify = UiRequest::Notify {
            message: String::new(),
            notify_type: None,
        };
        assert_eq!(ui_request_id(&notify), None);
        assert_eq!(ui_request_id(&UiRequest::Ignore), None);
    }

    #[test]
    fn only_aborted_autolearn_nudge_kills_the_capture_turn() {
        assert!(aborted_capture_turn(true, "autolearn-nudge"));
        assert!(!aborted_capture_turn(false, "autolearn-nudge"));
        assert!(!aborted_capture_turn(true, "other"));
    }
}
