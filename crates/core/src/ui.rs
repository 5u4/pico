//! Renders OMP's extension-UI requests (the `ask` tool's `select`/`editor`
//! prompts, plus confirm/input/notify) as Discord components and replies over
//! RPC. The host MUST answer: `ask.timeout` is `0`, so an unanswered prompt
//! blocks the turn forever. Handled inline — `ask` is `exclusive` and turns
//! serialise, so one prompt is open at a time; the collector races `cancel`.

use std::{fmt::Write as _, time::Duration};

use poise::serenity_prelude as serenity;
use tokio_util::sync::CancellationToken;

use crate::{
    omp::{
        client::OmpClient,
        protocol::{UiRequest, UiResponse},
    },
    render,
};

const MSG_CONTENT_CAP: usize = 1900;
const OPTION_LABEL_CAP: usize = 100;
const MODAL_TITLE_CAP: usize = 45;
const MODAL_LABEL_CAP: usize = 45;
const MODAL_VALUE_CAP: usize = 4000;
const ANSWER_PREVIEW_CAP: usize = 200;
const SELECT_MAX_OPTIONS: usize = 25;
/// Below Discord's ~15 min modal auto-close, so an abandoned modal can't pin a turn.
const MODAL_SUBMIT_WINDOW: Duration = Duration::from_secs(14 * 60);

const ID_SELECT: &str = "ui:select";
const ID_CANCEL: &str = "ui:cancel";
const ID_ANSWER: &str = "ui:answer";
const ID_YES: &str = "ui:yes";
const ID_NO: &str = "ui:no";

/// Outcome of handling one UI request.
pub enum Handled {
    Continue,
    /// The worker `cancel` token fired mid-prompt; the caller runs the restart cleanup.
    Cancelled,
}

/// One thread's open value-bearing `ask` dialog: the router hands the asker's
/// next message to `tx` so it answers the dialog instead of starting a turn.
pub struct PendingAnswer {
    author: serenity::UserId,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
}

/// Per-thread registry of open `select`/`input`/`editor` dialogs, keyed by the
/// Discord thread channel. see also: crate::discord (route_message delivers here).
pub type PendingAnswers =
    std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<serenity::ChannelId, PendingAnswer>>>;

/// Deliver `text` as the answer to the dialog open on `channel`, if one waits on
/// `author`. Returns whether consumed. Consuming *takes* the entry, so a same-author
/// follow-up before the guard drops falls through to a new turn, not a dead buffer.
pub fn deliver_pending_answer(
    pending: &PendingAnswers,
    channel: serenity::ChannelId,
    author: serenity::UserId,
    text: &str,
) -> bool {
    let mut registry = pending.lock();
    if !matches!(registry.get(&channel), Some(p) if p.author == author) {
        return false;
    }
    let entry = registry
        .remove(&channel)
        .expect("entry present: just matched under the lock");
    entry.tx.send(text.to_owned()).is_ok()
}

/// Removes its `channel` entry on drop, so a post-dialog message starts a new turn.
struct AnswerGuard<'a> {
    pending: &'a PendingAnswers,
    channel: serenity::ChannelId,
}

impl Drop for AnswerGuard<'_> {
    fn drop(&mut self) {
        self.pending.lock().remove(&self.channel);
    }
}

fn register_answer(
    pending: &PendingAnswers,
    channel: serenity::ChannelId,
    author: serenity::UserId,
) -> (AnswerGuard<'_>, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    pending.lock().insert(channel, PendingAnswer { author, tx });
    (AnswerGuard { pending, channel }, rx)
}

/// Render `req` on Discord and reply over RPC. Only `author` (this turn's sender) can answer.
pub async fn handle_request(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    client: &OmpClient,
    author: serenity::UserId,
    req: &UiRequest,
    cancel: &CancellationToken,
    pending: &PendingAnswers,
) -> Handled {
    match req {
        UiRequest::Select {
            id,
            title,
            options,
            timeout,
        } => {
            let (_guard, mut rx) = register_answer(pending, channel, author);
            select(ctx, channel, client, author, id, title, options, *timeout, cancel, &mut rx).await
        }
        UiRequest::Confirm {
            id,
            title,
            message,
            timeout,
        } => confirm(ctx, channel, client, author, id, title, message, *timeout, cancel).await,
        UiRequest::Input {
            id,
            title,
            placeholder,
            timeout,
        } => {
            let (_guard, mut rx) = register_answer(pending, channel, author);
            let field = TextField {
                multiline: false,
                value: None,
                placeholder: placeholder.as_deref(),
            };
            text_prompt(ctx, channel, client, author, id, title, field, *timeout, cancel, &mut rx).await
        }
        UiRequest::Editor { id, title, prefill } => {
            let (_guard, mut rx) = register_answer(pending, channel, author);
            let field = TextField {
                multiline: true,
                value: prefill.as_deref(),
                placeholder: None,
            };
            text_prompt(ctx, channel, client, author, id, title, field, None, cancel, &mut rx).await
        }
        UiRequest::Notify { message, notify_type } => {
            notify(ctx, channel, message, notify_type.as_deref()).await;
            Handled::Continue
        }
        // Recognised but with no Discord surface (`set_status`, …), or OMP
        // withdrawing a pending request: nothing to reply.
        UiRequest::Cancel { .. } | UiRequest::Ignore => Handled::Continue,
        // A method this build doesn't recognise: reply `cancelled` so a new
        // response-bearing dialog resolves to its dismissed value instead of
        // hanging the turn. Harmless for a fire-and-forget method — OMP drops a
        // reply whose id has no pending dialog.
        UiRequest::Unknown { id, method } => {
            tracing::warn!(%method, "unrecognised extension_ui_request; auto-cancelled");
            if let Some(id) = id {
                let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
            }
            Handled::Continue
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn select(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    client: &OmpClient,
    author: serenity::UserId,
    id: &str,
    title: &str,
    options: &[String],
    timeout: Option<u64>,
    cancel: &CancellationToken,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
) -> Handled {
    // Empty list: OMP's `select` resolves to a cancel, so mirror it, not a dead menu.
    if options.is_empty() {
        let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
        return Handled::Continue;
    }

    let Some(msg) = post(ctx, channel, &select_prompt_text(title, options), select_components(options)).await else {
        let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
        return Handled::Continue;
    };

    let interaction = match collect(ctx, msg.id, author, timeout, cancel, Some(rx)).await {
        Collected::Cancelled => {
            let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
            return Handled::Cancelled;
        }
        Collected::Ended { timed_out } => {
            finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
            let _ = client.ui_response(&UiResponse::cancelled(id, timed_out)).await;
            return Handled::Continue;
        }
        Collected::Text(text) => {
            finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
            let _ = client.ui_response(&UiResponse::value(id, &text)).await;
            return Handled::Continue;
        }
        Collected::Interaction(i) => *i,
    };

    // Option values are indices into the full list; map back to the verbatim
    // label so the `ask` tool can match it. The cancel button yields no pick.
    let picked = if interaction.data.custom_id == ID_SELECT {
        match &interaction.data.kind {
            serenity::ComponentInteractionDataKind::StringSelect { values } => values
                .first()
                .and_then(|v| v.parse::<usize>().ok())
                .and_then(|idx| options.get(idx))
                .map(String::as_str),
            _ => None,
        }
    } else {
        None
    };

    ack_update(ctx, &interaction, &resolved_line(title, picked)).await;
    match picked {
        Some(value) => {
            let _ = client.ui_response(&UiResponse::value(id, value)).await;
        }
        None => {
            let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
        }
    }
    Handled::Continue
}

#[allow(clippy::too_many_arguments)]
async fn confirm(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    client: &OmpClient,
    author: serenity::UserId,
    id: &str,
    title: &str,
    message: &str,
    timeout: Option<u64>,
    cancel: &CancellationToken,
) -> Handled {
    let content = clamp_content(&if message.is_empty() {
        format!("❓ {title}")
    } else {
        format!("❓ {title}\n\n{message}")
    });
    let components = vec![serenity::CreateActionRow::Buttons(vec![
        serenity::CreateButton::new(ID_YES)
            .label("Yes")
            .style(serenity::ButtonStyle::Success),
        serenity::CreateButton::new(ID_NO)
            .label("No")
            .style(serenity::ButtonStyle::Danger),
    ])];
    let Some(msg) = post(ctx, channel, &content, components).await else {
        let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
        return Handled::Continue;
    };

    let interaction = match collect(ctx, msg.id, author, timeout, cancel, None).await {
        Collected::Cancelled => {
            let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
            return Handled::Cancelled;
        }
        Collected::Ended { timed_out } => {
            // No interaction (a timeout, or shard drop): show it as cancelled, not a
            // chosen "No". OMP still resolves confirm to `false`; flag the timeout
            // so it can run `onTimeout`.
            finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
            let _ = if timed_out {
                client.ui_response(&UiResponse::cancelled(id, true)).await
            } else {
                client.ui_response(&UiResponse::confirmed(id, false)).await
            };
            return Handled::Continue;
        }
        // `confirm` is button-only (yes/no), so it registers no answer channel.
        Collected::Text(_) => unreachable!("confirm registers no text answer channel"),
        Collected::Interaction(i) => *i,
    };

    let yes = interaction.data.custom_id == ID_YES;
    ack_update(ctx, &interaction, &resolved_line(title, Some(if yes { "Yes" } else { "No" }))).await;
    let _ = client.ui_response(&UiResponse::confirmed(id, yes)).await;
    Handled::Continue
}

struct TextField<'a> {
    multiline: bool,
    value: Option<&'a str>,
    placeholder: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
async fn text_prompt(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    client: &OmpClient,
    author: serenity::UserId,
    id: &str,
    title: &str,
    field: TextField<'_>,
    timeout: Option<u64>,
    cancel: &CancellationToken,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
) -> Handled {
    let hint = field.placeholder.map(|p| format!(" ({p})")).unwrap_or_default();
    let content = clamp_content(&format!("❓ {title}{hint}\n_Reply here, or click **Answer** for a form._"));
    let components = vec![serenity::CreateActionRow::Buttons(vec![
        serenity::CreateButton::new(ID_ANSWER)
            .label("Answer")
            .style(serenity::ButtonStyle::Primary),
        serenity::CreateButton::new(ID_CANCEL)
            .label("✖ cancel")
            .style(serenity::ButtonStyle::Secondary),
    ])];
    let Some(msg) = post(ctx, channel, &content, components).await else {
        let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
        return Handled::Continue;
    };

    let mut interaction = match collect(ctx, msg.id, author, timeout, cancel, Some(&mut *rx)).await {
        Collected::Cancelled => {
            let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
            return Handled::Cancelled;
        }
        Collected::Ended { timed_out } => {
            finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
            let _ = client.ui_response(&UiResponse::cancelled(id, timed_out)).await;
            return Handled::Continue;
        }
        Collected::Text(text) => {
            finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
            let _ = client.ui_response(&UiResponse::value(id, &text)).await;
            return Handled::Continue;
        }
        Collected::Interaction(i) => *i,
    };

    loop {
        if interaction.data.custom_id != ID_ANSWER {
            ack_update(ctx, &interaction, &resolved_line(title, None)).await;
            let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
            return Handled::Continue;
        }
        match run_modal(ctx, msg.id, author, title, &field, interaction, cancel, &mut *rx).await {
            ModalStep::Answered(text) => {
                finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
                let _ = client.ui_response(&UiResponse::value(id, &text)).await;
                return Handled::Continue;
            }
            ModalStep::Restart => {
                let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
                return Handled::Cancelled;
            }
            ModalStep::Reclick(next) => interaction = *next,
            // Modal closed with no click: keep the prompt open for the next click.
            ModalStep::Closed => {
                interaction = match collect(ctx, msg.id, author, None, cancel, Some(&mut *rx)).await {
                    Collected::Interaction(i) => *i,
                    Collected::Cancelled => {
                        let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
                        return Handled::Cancelled;
                    }
                    Collected::Ended { .. } => {
                        finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
                        let _ = client.ui_response(&UiResponse::cancelled(id, false)).await;
                        return Handled::Continue;
                    }
                    Collected::Text(text) => {
                        finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
                        let _ = client.ui_response(&UiResponse::value(id, &text)).await;
                        return Handled::Continue;
                    }
                };
            }
        }
    }
}

/// Outcome of opening one modal off a still-live carrier message.
enum ModalStep {
    Answered(String),
    Reclick(Box<serenity::ComponentInteraction>),
    /// Modal closed with no carrier click; the prompt stays open.
    Closed,
    Restart,
}

/// Open a modal off the Answer-click `interaction` and await its submit while a
/// fresh carrier collector runs concurrently: Discord emits no event on modal
/// dismiss, so the concurrent collector keeps Answer/cancel — and a typed answer
/// in the channel — responsive instead of stranding the turn until the modal's
/// 14-minute timeout.
#[allow(clippy::too_many_arguments)]
async fn run_modal(
    ctx: &serenity::Context,
    message_id: serenity::MessageId,
    author: serenity::UserId,
    title: &str,
    field: &TextField<'_>,
    interaction: serenity::ComponentInteraction,
    cancel: &CancellationToken,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
) -> ModalStep {
    let modal = serenity::CreateQuickModal::new(modal_title(title))
        .timeout(MODAL_SUBMIT_WINDOW)
        .field(modal_field(title, field));
    tokio::select! {
        () = cancel.cancelled() => ModalStep::Restart,
        r = interaction.quick_modal(ctx, modal) => match r {
            Ok(Some(response)) => {
                let text = response.inputs.into_iter().next().unwrap_or_default();
                // Ack the submit (else "interaction failed"); the carrier is edited separately.
                let _ = response
                    .interaction
                    .create_response(ctx, serenity::CreateInteractionResponse::Acknowledge)
                    .await;
                ModalStep::Answered(text)
            }
            Ok(None) | Err(_) => ModalStep::Closed,
        },
        next = collect(ctx, message_id, author, None, cancel, Some(&mut *rx)) => match next {
            Collected::Interaction(i) => ModalStep::Reclick(i),
            Collected::Cancelled => ModalStep::Restart,
            Collected::Ended { .. } => ModalStep::Closed,
            // A typed answer resolves the editor; a still-open modal becomes a stale submit.
            Collected::Text(text) => ModalStep::Answered(text),
        },
    }
}

async fn notify(ctx: &serenity::Context, channel: serenity::ChannelId, message: &str, notify_type: Option<&str>) {
    let emoji = match notify_type {
        Some("warning") => "⚠️",
        Some("error") => "❌",
        _ => "ℹ️",
    };
    let content = clamp_content(&format!("{emoji} {message}"));
    let msg = serenity::CreateMessage::new()
        .content(content)
        .flags(serenity::MessageFlags::SUPPRESS_NOTIFICATIONS);
    if let Err(e) = channel.send_message(ctx, msg).await {
        tracing::warn!(error = %e, "ui notify send failed");
    }
}

enum Collected {
    Interaction(Box<serenity::ComponentInteraction>),
    Text(String),
    /// Ended with no pick. `timed_out` only when a timeout was set and fired.
    Ended {
        timed_out: bool,
    },
    Cancelled,
}

async fn collect(
    ctx: &serenity::Context,
    message_id: serenity::MessageId,
    author: serenity::UserId,
    timeout: Option<u64>,
    cancel: &CancellationToken,
    answer: Option<&mut tokio::sync::mpsc::UnboundedReceiver<String>>,
) -> Collected {
    let mut collector = serenity::ComponentInteractionCollector::new(ctx)
        .message_id(message_id)
        .author_id(author);
    if let Some(ms) = timeout {
        collector = collector.timeout(Duration::from_millis(ms));
    }
    let answered = async {
        match answer {
            Some(rx) => rx.recv().await,
            None => std::future::pending::<Option<String>>().await,
        }
    };
    tokio::select! {
        () = cancel.cancelled() => Collected::Cancelled,
        text = answered => match text {
            Some(t) => Collected::Text(t),
            // Sender dropped (dialog ending): treat as a plain end, not a pick.
            None => Collected::Ended { timed_out: false },
        },
        result = collector.next() => match result {
            Some(interaction) => Collected::Interaction(Box::new(interaction)),
            None => Collected::Ended { timed_out: timeout.is_some() },
        },
    }
}

async fn post(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    content: &str,
    components: Vec<serenity::CreateActionRow>,
) -> Option<serenity::Message> {
    let msg = serenity::CreateMessage::new()
        .content(content.to_owned())
        .components(components);
    match channel.send_message(ctx, msg).await {
        Ok(message) => Some(message),
        Err(e) => {
            tracing::warn!(error = %e, "ui prompt send failed");
            None
        }
    }
}

/// Ack a component interaction by collapsing its message to the resolved line.
async fn ack_update(ctx: &serenity::Context, interaction: &serenity::ComponentInteraction, content: &str) {
    let response = serenity::CreateInteractionResponse::UpdateMessage(
        serenity::CreateInteractionResponseMessage::new()
            .content(content.to_owned())
            .components(vec![]),
    );
    if let Err(e) = interaction.create_response(ctx, response).await {
        tracing::warn!(error = %e, "ui interaction update failed");
    }
}

/// Collapse a carrier no interaction can update (a timeout, or a modal submit).
async fn finalize(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    message_id: serenity::MessageId,
    content: &str,
) {
    let edit = serenity::EditMessage::new()
        .content(content.to_owned())
        .components(vec![]);
    if let Err(e) = channel.edit_message(ctx, message_id, edit).await {
        tracing::warn!(error = %e, "ui carrier finalize failed");
    }
}

/// Defang model-controlled mentions, THEN cap to Discord's message limit. Order
/// matters: defang inserts a zero-width space per mention, so capping first could
/// leave the result back over the limit.
fn clamp_content(text: &str) -> String {
    render::truncate(&render::defang_mentions(text), MSG_CONTENT_CAP)
}

fn select_prompt_text(title: &str, options: &[String]) -> String {
    let mut out = format!("❓ {title}");
    // Only the options the menu shows (capped at 25); numbering unpickable extras would mislead.
    for (i, opt) in options.iter().take(SELECT_MAX_OPTIONS).enumerate() {
        let _ = write!(out, "\n**{}.** {opt}", i + 1);
    }
    clamp_content(&out)
}

fn select_components(options: &[String]) -> Vec<serenity::CreateActionRow> {
    let menu_options = options
        .iter()
        .take(SELECT_MAX_OPTIONS)
        .enumerate()
        .map(|(i, opt)| {
            serenity::CreateSelectMenuOption::new(
                render::truncate(&format!("{}. {opt}", i + 1), OPTION_LABEL_CAP),
                i.to_string(),
            )
        })
        .collect();
    let menu =
        serenity::CreateSelectMenu::new(ID_SELECT, serenity::CreateSelectMenuKind::String { options: menu_options })
            .placeholder("Pick one");
    vec![
        serenity::CreateActionRow::SelectMenu(menu),
        serenity::CreateActionRow::Buttons(vec![
            serenity::CreateButton::new(ID_CANCEL)
                .label("✖ cancel")
                .style(serenity::ButtonStyle::Secondary),
        ]),
    ]
}

/// The settled-prompt line: the question plus the chosen answer or a cancel marker.
fn resolved_line(title: &str, choice: Option<&str>) -> String {
    let title = render::truncate(title, MSG_CONTENT_CAP - 300);
    let body = match choice {
        Some(choice) => format!("✅ {title}  → {}", render::truncate(choice, ANSWER_PREVIEW_CAP)),
        None => format!("⊘ {title}  · cancelled"),
    };
    clamp_content(&body)
}

fn modal_title(title: &str) -> String {
    let title = title.trim();
    render::truncate(if title.is_empty() { "Answer" } else { title }, MODAL_TITLE_CAP)
}

fn modal_field(title: &str, field: &TextField<'_>) -> serenity::CreateInputText {
    let style = if field.multiline {
        serenity::InputTextStyle::Paragraph
    } else {
        serenity::InputTextStyle::Short
    };
    // The custom id is overwritten by `CreateQuickModal`; an empty one is fine.
    let mut input = serenity::CreateInputText::new(style, modal_title(title), "").required(true);
    if let Some(value) = field.value {
        input = input.value(render::truncate(value, MODAL_VALUE_CAP));
    }
    if let Some(placeholder) = field.placeholder {
        input = input.placeholder(render::truncate(placeholder, MODAL_LABEL_CAP * 2));
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_prompt_numbers_and_defangs_options() {
        let options = vec!["Yes".to_owned(), "No, ping @everyone".to_owned()];
        let text = select_prompt_text("Proceed?", &options);
        assert!(text.starts_with("❓ Proceed?"));
        assert!(text.contains("**1.** Yes"));
        assert!(text.contains("**2.** No,"));
        assert!(!text.contains("@everyone"));
    }

    #[test]
    fn clamp_content_defangs_before_capping() {
        // A near-cap string full of mentions must stay within the cap: defang
        // inserts a zero-width space per mention, so defang must precede the cap.
        let raw = "@everyone ".repeat(MSG_CONTENT_CAP);
        let out = clamp_content(&raw);
        assert!(out.chars().count() <= MSG_CONTENT_CAP, "over cap: {}", out.chars().count());
        assert!(!out.contains("@everyone"), "mentions not defanged");
    }

    #[test]
    fn select_prompt_text_lists_only_shown_options() {
        // The menu shows at most 25; the prompt text must not number unpickable extras.
        let options: Vec<String> = (0..30).map(|i| format!("opt{i}")).collect();
        let text = select_prompt_text("Pick", &options);
        assert!(text.contains("opt24"));
        assert!(!text.contains("opt25"));
    }

    #[test]
    fn select_menu_carries_index_values_and_caps_at_25() {
        let options: Vec<String> = (0..30).map(|i| format!("opt {i}")).collect();
        let rows = serde_json::to_value(select_components(&options)).expect("serialize components");
        let select = &rows[0]["components"][0];
        assert_eq!(select["custom_id"], ID_SELECT);
        let menu_options = select["options"].as_array().expect("options array");
        assert_eq!(menu_options.len(), SELECT_MAX_OPTIONS);
        assert_eq!(menu_options[0]["value"], "0");
        assert_eq!(menu_options[24]["value"], "24");
        assert_eq!(rows[1]["components"][0]["custom_id"], ID_CANCEL);
    }

    #[test]
    fn resolved_line_marks_choice_and_cancel() {
        assert!(resolved_line("Pick", Some("Option A")).contains("→ Option A"));
        assert!(resolved_line("Pick", None).contains("cancelled"));
    }

    #[test]
    fn deliver_pending_answer_routes_text_to_the_asker() {
        let pending = PendingAnswers::default();
        let channel = serenity::ChannelId::new(7);
        let author = serenity::UserId::new(42);
        let (_guard, mut rx) = register_answer(&pending, channel, author);

        assert!(deliver_pending_answer(&pending, channel, author, "blue"));
        assert_eq!(rx.try_recv().ok(), Some("blue".to_owned()));
        assert!(!deliver_pending_answer(&pending, channel, author, "green"));
        assert!(!pending.lock().contains_key(&channel));
    }

    #[test]
    fn deliver_pending_answer_ignores_other_authors_and_channels() {
        let pending = PendingAnswers::default();
        let channel = serenity::ChannelId::new(7);
        let author = serenity::UserId::new(42);
        let (_guard, _rx) = register_answer(&pending, channel, author);

        assert!(!deliver_pending_answer(&pending, channel, serenity::UserId::new(99), "blue"));
        assert!(!deliver_pending_answer(&pending, serenity::ChannelId::new(8), author, "blue"));
        assert!(deliver_pending_answer(&pending, channel, author, "blue"));
    }

    #[test]
    fn answer_guard_deregisters_on_drop() {
        let pending = PendingAnswers::default();
        let channel = serenity::ChannelId::new(7);
        let author = serenity::UserId::new(42);
        {
            let (_guard, _rx) = register_answer(&pending, channel, author);
            assert!(pending.lock().contains_key(&channel));
        }
        assert!(!pending.lock().contains_key(&channel));
        assert!(!deliver_pending_answer(&pending, channel, author, "blue"));
    }
}
