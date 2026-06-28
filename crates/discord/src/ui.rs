use std::{fmt::Write as _, time::Duration};

use pico_core::{omp::protocol::UiRequest, render};
use poise::serenity_prelude as serenity;
use tokio_util::sync::CancellationToken;

const OPTION_LABEL_CAP: usize = 100;
const MODAL_TITLE_CAP: usize = 45;
const MODAL_LABEL_CAP: usize = 45;
const MODAL_VALUE_CAP: usize = 4000;
const ANSWER_PREVIEW_CAP: usize = 200;
const SELECT_MAX_OPTIONS: usize = 25;
const MODAL_SUBMIT_WINDOW: Duration = Duration::from_secs(14 * 60);

const ID_SELECT: &str = "ui:select";
const ID_CANCEL: &str = "ui:cancel";
const ID_ANSWER: &str = "ui:answer";
const ID_YES: &str = "ui:yes";
const ID_NO: &str = "ui:no";

pub struct PendingAnswer {
    author: serenity::UserId,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
}

pub type PendingAnswers =
    std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<serenity::ChannelId, PendingAnswer>>>;

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

pub(crate) async fn run(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    author: serenity::UserId,
    pending: &PendingAnswers,
    cancel: &CancellationToken,
    req: &UiRequest,
) -> pico_core::surface::UiOutcome {
    match req {
        UiRequest::Select {
            title,
            options,
            timeout,
            ..
        } => {
            let (_guard, mut rx) = register_answer(pending, channel, author);
            select(ctx, channel, author, title, options, *timeout, cancel, &mut rx).await
        }
        UiRequest::Confirm {
            title,
            message,
            timeout,
            ..
        } => confirm(ctx, channel, author, title, message, *timeout, cancel).await,
        UiRequest::Input {
            title,
            placeholder,
            timeout,
            ..
        } => {
            let (_guard, mut rx) = register_answer(pending, channel, author);
            let field = TextField {
                multiline: false,
                value: None,
                placeholder: placeholder.as_deref(),
            };
            text_prompt(ctx, channel, author, title, field, *timeout, cancel, &mut rx).await
        }
        UiRequest::Editor { title, prefill, .. } => {
            let (_guard, mut rx) = register_answer(pending, channel, author);
            let field = TextField {
                multiline: true,
                value: prefill.as_deref(),
                placeholder: None,
            };
            text_prompt(ctx, channel, author, title, field, None, cancel, &mut rx).await
        }
        UiRequest::Notify { message, notify_type } => pico_core::surface::UiOutcome::Notified {
            posted: notify(ctx, channel, message, notify_type.as_deref()).await,
        },
        UiRequest::Cancel { .. } | UiRequest::Ignore | UiRequest::Unknown { .. } => {
            pico_core::surface::UiOutcome::Notified { posted: false }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn select(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    author: serenity::UserId,
    title: &str,
    options: &[String],
    timeout: Option<u64>,
    cancel: &CancellationToken,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
) -> pico_core::surface::UiOutcome {
    if options.is_empty() {
        return pico_core::surface::UiOutcome::Respond {
            reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
            posted: false,
        };
    }

    let Some(msg) = post(ctx, channel, &select_prompt_text(title, options), select_components(options)).await else {
        return pico_core::surface::UiOutcome::Respond {
            reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
            posted: false,
        };
    };

    let interaction = match collect(ctx, msg.id, author, timeout, cancel, Some(rx)).await {
        Collected::Cancelled => {
            return pico_core::surface::UiOutcome::Cancelled;
        }
        Collected::Ended { timed_out } => {
            finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
            return pico_core::surface::UiOutcome::Respond {
                reply: pico_core::surface::UiReply::Dismissed { timed_out },
                posted: true,
            };
        }
        Collected::Text(text) => {
            finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
            return pico_core::surface::UiOutcome::Respond {
                reply: pico_core::surface::UiReply::Value(text),
                posted: true,
            };
        }
        Collected::Interaction(i) => *i,
    };

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
        Some(value) => pico_core::surface::UiOutcome::Respond {
            reply: pico_core::surface::UiReply::Value(value.to_owned()),
            posted: true,
        },
        None => pico_core::surface::UiOutcome::Respond {
            reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
            posted: true,
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn confirm(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    author: serenity::UserId,
    title: &str,
    message: &str,
    timeout: Option<u64>,
    cancel: &CancellationToken,
) -> pico_core::surface::UiOutcome {
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
        return pico_core::surface::UiOutcome::Respond {
            reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
            posted: false,
        };
    };

    let interaction = match collect(ctx, msg.id, author, timeout, cancel, None).await {
        Collected::Cancelled => {
            return pico_core::surface::UiOutcome::Cancelled;
        }
        Collected::Ended { timed_out } => {
            finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
            return if timed_out {
                pico_core::surface::UiOutcome::Respond {
                    reply: pico_core::surface::UiReply::Dismissed { timed_out: true },
                    posted: true,
                }
            } else {
                pico_core::surface::UiOutcome::Respond {
                    reply: pico_core::surface::UiReply::Confirmed(false),
                    posted: true,
                }
            };
        }
        Collected::Text(_) => unreachable!("confirm registers no text answer channel"),
        Collected::Interaction(i) => *i,
    };

    let yes = interaction.data.custom_id == ID_YES;
    ack_update(ctx, &interaction, &resolved_line(title, Some(if yes { "Yes" } else { "No" }))).await;
    pico_core::surface::UiOutcome::Respond {
        reply: pico_core::surface::UiReply::Confirmed(yes),
        posted: true,
    }
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
    author: serenity::UserId,
    title: &str,
    field: TextField<'_>,
    timeout: Option<u64>,
    cancel: &CancellationToken,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
) -> pico_core::surface::UiOutcome {
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
        return pico_core::surface::UiOutcome::Respond {
            reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
            posted: false,
        };
    };

    let mut interaction = match collect(ctx, msg.id, author, timeout, cancel, Some(&mut *rx)).await {
        Collected::Cancelled => {
            return pico_core::surface::UiOutcome::Cancelled;
        }
        Collected::Ended { timed_out } => {
            finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
            return pico_core::surface::UiOutcome::Respond {
                reply: pico_core::surface::UiReply::Dismissed { timed_out },
                posted: true,
            };
        }
        Collected::Text(text) => {
            finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
            return pico_core::surface::UiOutcome::Respond {
                reply: pico_core::surface::UiReply::Value(text),
                posted: true,
            };
        }
        Collected::Interaction(i) => *i,
    };

    loop {
        if interaction.data.custom_id != ID_ANSWER {
            ack_update(ctx, &interaction, &resolved_line(title, None)).await;
            return pico_core::surface::UiOutcome::Respond {
                reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
                posted: true,
            };
        }
        match run_modal(ctx, msg.id, author, title, &field, interaction, cancel, &mut *rx).await {
            ModalStep::Answered(text) => {
                finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
                return pico_core::surface::UiOutcome::Respond {
                    reply: pico_core::surface::UiReply::Value(text),
                    posted: true,
                };
            }
            ModalStep::Restart => {
                return pico_core::surface::UiOutcome::Cancelled;
            }
            ModalStep::Reclick(next) => interaction = *next,
            ModalStep::Closed => {
                interaction = match collect(ctx, msg.id, author, None, cancel, Some(&mut *rx)).await {
                    Collected::Interaction(i) => *i,
                    Collected::Cancelled => {
                        return pico_core::surface::UiOutcome::Cancelled;
                    }
                    Collected::Ended { .. } => {
                        finalize(ctx, channel, msg.id, &resolved_line(title, None)).await;
                        return pico_core::surface::UiOutcome::Respond {
                            reply: pico_core::surface::UiReply::Dismissed { timed_out: false },
                            posted: true,
                        };
                    }
                    Collected::Text(text) => {
                        finalize(ctx, channel, msg.id, &resolved_line(title, Some(&text))).await;
                        return pico_core::surface::UiOutcome::Respond {
                            reply: pico_core::surface::UiReply::Value(text),
                            posted: true,
                        };
                    }
                };
            }
        }
    }
}

enum ModalStep {
    Answered(String),
    Reclick(Box<serenity::ComponentInteraction>),
    Closed,
    Restart,
}

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
                let _ = response
                    .interaction
                    .create_response(ctx, serenity::CreateInteractionResponse::Acknowledge)
                    .await;
                ModalStep::Answered(text)
            }
            Ok(None) => ModalStep::Closed,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "modal failed");
                ModalStep::Closed
            }
        },
        next = collect(ctx, message_id, author, None, cancel, Some(&mut *rx)) => match next {
            Collected::Interaction(i) => ModalStep::Reclick(i),
            Collected::Cancelled => ModalStep::Restart,
            Collected::Ended { .. } => ModalStep::Closed,
            Collected::Text(text) => ModalStep::Answered(text),
        },
    }
}

async fn notify(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    message: &str,
    notify_type: Option<&str>,
) -> bool {
    let emoji = match notify_type {
        Some("warning") => "⚠️",
        Some("error") => "❌",
        _ => "ℹ️",
    };
    let content = clamp_content(&format!("{emoji} {message}"));
    let msg = serenity::CreateMessage::new()
        .content(content)
        .flags(serenity::MessageFlags::SUPPRESS_NOTIFICATIONS);
    match channel.send_message(ctx, msg).await {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "ui notify send failed");
            false
        }
    }
}

enum Collected {
    Interaction(Box<serenity::ComponentInteraction>),
    Text(String),
    Ended { timed_out: bool },
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
            tracing::warn!(error = %format!("{e:#}"), "ui prompt send failed");
            None
        }
    }
}

async fn ack_update(ctx: &serenity::Context, interaction: &serenity::ComponentInteraction, content: &str) {
    let response = serenity::CreateInteractionResponse::UpdateMessage(
        serenity::CreateInteractionResponseMessage::new()
            .content(content.to_owned())
            .components(vec![]),
    );
    if let Err(e) = interaction.create_response(ctx, response).await {
        tracing::warn!(error = %format!("{e:#}"), "ui interaction update failed");
    }
}

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
        tracing::warn!(error = %format!("{e:#}"), "ui carrier finalize failed");
    }
}

fn clamp_content(text: &str) -> String {
    render::truncate(&render::defang_mentions(text), crate::consts::MSG_CONTENT_CAP)
}

fn select_prompt_text(title: &str, options: &[String]) -> String {
    let mut out = format!("❓ {title}");
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

fn resolved_line(title: &str, choice: Option<&str>) -> String {
    let title = render::truncate(title, crate::consts::MSG_CONTENT_CAP - 300);
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
        let raw = "@everyone ".repeat(crate::consts::MSG_CONTENT_CAP);
        let out = clamp_content(&raw);
        assert!(
            out.chars().count() <= crate::consts::MSG_CONTENT_CAP,
            "over cap: {}",
            out.chars().count()
        );
        assert!(!out.contains("@everyone"), "mentions not defanged");
    }

    #[test]
    fn select_prompt_text_lists_only_shown_options() {
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
