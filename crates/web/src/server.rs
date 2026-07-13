use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use color_eyre::eyre::WrapErr;
use pico_core::{
    cancel::CancelRegistry,
    config::StreamingBehavior,
    mid_turn::MidTurnQueue,
    omp::{camofox::CamofoxDaemon, client::SessionIdentity, pool::OmpPool},
    prompt::{self, RuntimeContext},
    surface::ConversationId,
    thread_marker::{self, ThreadMarker},
};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{
    history,
    proto::{ClientFrame, ServerFrame},
    surface::WebSurface,
};

const PLATFORM: &str = "web";
const SURFACE_RULES: &str = include_str!("web_surface.md");

#[derive(rust_embed::Embed)]
#[folder = "ui/dist"]
struct Assets;

pub struct WebState {
    pub root: PathBuf,
    pub db: sqlx::SqlitePool,
    pub pool: Arc<OmpPool>,
    pub camofox: Arc<CamofoxDaemon>,
    pub mid_turn: MidTurnQueue,
    pub cancels: CancelRegistry,
    pub cancel: CancellationToken,
    pub cwd: PathBuf,
    pub timezone: chrono_tz::Tz,
}

pub async fn serve(
    root: PathBuf,
    cwd: PathBuf,
    bind: std::net::IpAddr,
    port: u16,
    cancel: CancellationToken,
    on_bound: Option<tokio::sync::oneshot::Sender<()>>,
) -> color_eyre::Result<()> {
    let tracker = TaskTracker::new();
    let db = pico_core::db::open(&root).await.wrap_err("opening worker database")?;
    let camofox = CamofoxDaemon::new(&root, cancel.clone(), &tracker);
    let host_config = pico_core::omp::client::HostConfig {
        env: camofox.host_env(pico_core::config::any_browser_enabled(&root)),
    };
    let pool = OmpPool::new(root.clone(), host_config, cancel.clone(), &tracker);
    let timezone = pico_core::config::load_root(&pico_shared::paths::worker_config(&root))?.timezone();

    let state = Arc::new(WebState {
        root,
        db,
        pool,
        camofox,
        mid_turn: MidTurnQueue::default(),
        cancels: CancelRegistry::default(),
        cancel: cancel.clone(),
        cwd,
        timezone,
    });

    let app = Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/api/tree", get(tree))
        .fallback(get(static_asset))
        .with_state(state);

    let addr = SocketAddr::new(bind, port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .wrap_err_with(|| format!("binding web server to {addr}"))?;
    tracing::info!(%addr, "web console listening");
    if let Some(tx) = on_bound {
        let _ = tx.send(());
    }

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await
        .wrap_err("web server error");
    tracker.close();
    tracker.wait().await;
    result
}

async fn static_asset(uri: axum::http::Uri) -> axum::response::Response {
    let path = uri.path().trim_start_matches('/');
    let key = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = Assets::get(key) {
        return asset_response(file);
    }
    if path.starts_with("assets/") || path.rsplit('/').next().is_some_and(|f| f.contains('.')) {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    asset_response(Assets::get("index.html").expect("embedded index.html"))
}

fn asset_response(file: rust_embed::EmbeddedFile) -> axum::response::Response {
    let mime = file.metadata.mimetype().to_owned();
    let body = match file.data {
        std::borrow::Cow::Borrowed(bytes) => axum::body::Bytes::from_static(bytes),
        std::borrow::Cow::Owned(bytes) => axum::body::Bytes::from(bytes),
    };
    ([(axum::http::header::CONTENT_TYPE, mime)], body).into_response()
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<Arc<WebState>>) -> axum::response::Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

fn session_dir(state: &WebState, thread_id: &str) -> std::path::PathBuf {
    pico_shared::paths::profile_session_dir(&state.root, pico_shared::paths::DEFAULT_PROFILE, PLATFORM, thread_id)
}

async fn record_marker(state: &WebState, thread_id: &str) {
    thread_marker::save(
        &state.db,
        PLATFORM,
        thread_id,
        &ThreadMarker {
            profile: pico_shared::paths::DEFAULT_PROFILE.to_owned(),
            cwd: state.cwd.clone(),
            worktree: None,
            closed_at: None,
            channel_id: Some(state.cwd.display().to_string()),
        },
    )
    .await;
}

async fn tree(State(state): State<Arc<WebState>>) -> axum::response::Response {
    let channel_id = state.cwd.display().to_string();
    let entries = thread_marker::list_open(&state.db, PLATFORM, &channel_id).await;
    let mut threads: Vec<history::TreeThread> = entries
        .into_iter()
        .map(|entry| {
            let dir = session_dir(&state, &entry.thread_id);
            let (title, _) = history::replay(&dir);
            history::TreeThread {
                thread_id: entry.thread_id,
                title,
                updated_at: history::thread_updated_at(&dir),
            }
        })
        .collect();
    threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
    let channels = vec![history::TreeChannel {
        channel_id,
        label: state.cwd.display().to_string(),
        threads,
    }];
    axum::Json(channels).into_response()
}

async fn handle_socket(mut socket: WebSocket, state: Arc<WebState>) {
    let (tx, mut rx) = unbounded_channel::<ServerFrame>();
    let seq = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut current: Option<String> = None;
    let mut in_flight: Option<tokio::task::JoinHandle<()>> = None;

    loop {
        tokio::select! {
            () = state.cancel.cancelled() => break,
            frame = rx.recv() => match frame {
                Some(frame) => {
                    if send_frame(&mut socket, &frame).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            res = async { in_flight.as_mut().expect("guarded by is_some").await }, if in_flight.is_some() => {
                if let Err(e) = res {
                    tracing::warn!(error = %format!("{e:#}"), "web turn task panicked");
                }
                in_flight = None;
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<ClientFrame>(&text) {
                        Ok(ClientFrame::Open { thread_id }) => {
                            if in_flight.is_some() {
                                let _ = tx.send(ServerFrame::Error {
                                    message: "a turn is running; wait for it to finish before switching chats".to_owned(),
                                });
                            } else if !is_valid_thread_id(&thread_id) {
                                let _ = tx.send(ServerFrame::Error {
                                    message: "invalid thread id".to_owned(),
                                });
                            } else {
                                current = Some(thread_id.clone());
                                let (title, bubbles) = history::replay(&session_dir(&state, &thread_id));
                                seq.store(bubbles.len() as u64, std::sync::atomic::Ordering::Relaxed);
                                let _ = tx.send(ServerFrame::Opened { thread_id, title });
                                let _ = tx.send(ServerFrame::History { bubbles });
                            }
                        }
                        Ok(ClientFrame::New) => {
                            if in_flight.is_some() {
                                let _ = tx.send(ServerFrame::Error {
                                    message: "a turn is running; wait for it to finish before starting a new chat".to_owned(),
                                });
                            } else {
                                let thread_id = ulid::Ulid::new().to_string();
                                record_marker(&state, &thread_id).await;
                                current = Some(thread_id.clone());
                                seq.store(0, std::sync::atomic::Ordering::Relaxed);
                                let _ = tx.send(ServerFrame::Opened {
                                    thread_id,
                                    title: String::new(),
                                });
                                let _ = tx.send(ServerFrame::History { bubbles: Vec::new() });
                            }
                        }
                        Ok(ClientFrame::Prompt { text }) => {
                            if in_flight.is_some() {
                                let _ = tx.send(ServerFrame::Error {
                                    message: "a turn is already running in this thread".to_owned(),
                                });
                            } else {
                                let thread_id = match &current {
                                    Some(id) => id.clone(),
                                    None => {
                                        let id = ulid::Ulid::new().to_string();
                                        seq.store(0, std::sync::atomic::Ordering::Relaxed);
                                        let _ = tx.send(ServerFrame::Opened {
                                            thread_id: id.clone(),
                                            title: String::new(),
                                        });
                                        current = Some(id.clone());
                                        id
                                    }
                                };
                                record_marker(&state, &thread_id).await;
                                in_flight = Some(tokio::spawn(run_prompt(
                                    Arc::clone(&state),
                                    thread_id,
                                    text,
                                    tx.clone(),
                                    Arc::clone(&seq),
                                )));
                            }
                        }
                        Ok(ClientFrame::Cancel) => {
                            if let Some(thread_id) = &current {
                                let conversation = ConversationId::new(PLATFORM, thread_id);
                                state.cancels.request(&conversation);
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %format!("{e:#}"), "undecodable web client frame");
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    tracing::warn!(error = %format!("{e:#}"), "web socket error");
                    break;
                }
            },
        }
    }

    if let Some(handle) = in_flight {
        handle.abort();
    }
}

fn is_valid_thread_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

async fn run_prompt(
    state: Arc<WebState>,
    thread_id: String,
    text: String,
    tx: UnboundedSender<ServerFrame>,
    seq: Arc<std::sync::atomic::AtomicU64>,
) {
    let text = text.as_str();
    let sent_at = pico_core::prompt::format_sent_at(chrono::Utc::now().timestamp(), state.timezone);
    let wrapped = if pico_core::prompt::is_continue_trigger(text) {
        pico_core::prompt::CONTINUE_NUDGE.to_owned()
    } else {
        prompt::wrap_web_message("you", &sent_at, text)
    };
    let context_block = prompt::runtime_context_block(&RuntimeContext {
        platform: PLATFORM,
        extra: &[],
        channel: &prompt::escape_text(&state.cwd.display().to_string()),
        thread: &prompt::escape_text(&thread_id),
        profile: pico_shared::paths::DEFAULT_PROFILE,
        cwd: &state.cwd,
        worktree: None,
        timezone: state.timezone,
    });
    let identity = SessionIdentity {
        platform: PLATFORM.to_owned(),
        guild: String::new(),
        channel: state.cwd.display().to_string(),
        thread: thread_id.clone(),
        user: "local".to_owned(),
    };
    let conversation = ConversationId::new(PLATFORM, &thread_id);
    let surface = WebSurface::new(tx.clone(), seq);

    let _ = tx.send(ServerFrame::TurnStart);
    let spawn = pico_core::session::run_turn(pico_core::session::RunTurn {
        surface: &surface,
        pool: &state.pool,
        root: &state.root,
        profile: pico_shared::paths::DEFAULT_PROFILE,
        cwd: state.cwd.clone(),
        identity,
        context_block: &context_block,
        surface_rules: SURFACE_RULES,
        wrapped: &wrapped,
        images: &[],
        mode: StreamingBehavior::default(),
        camofox: &state.camofox,
        mid_turn: &state.mid_turn,
        cancels: &state.cancels,
        cancel: &state.cancel,
        conversation: &conversation,
        thread_id: &thread_id,
    })
    .await;
    match spawn {
        Ok(spawn) => {
            let answer = spawn.title_seed.clone();
            pico_core::title::generate_and_apply(
                WebSurface::new(tx.clone(), Arc::new(std::sync::atomic::AtomicU64::new(0))),
                Arc::clone(&spawn.handle),
                Arc::clone(&state.pool),
                text.to_owned(),
                answer,
                state.cancel.clone(),
            )
            .await;
        }
        Err(e) => {
            let _ = tx.send(ServerFrame::Error {
                message: format!("{e:#}"),
            });
        }
    }
    let _ = tx.send(ServerFrame::TurnEnd);
}

async fn send_frame(socket: &mut WebSocket, frame: &ServerFrame) -> Result<(), ()> {
    let json = serde_json::to_string(frame).map_err(|_| ())?;
    socket.send(Message::Text(json.into())).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;

    use super::*;

    #[tokio::test]
    #[cfg_attr(pico_web_skip_ui_build, ignore = "no real SPA build in skip mode")]
    async fn root_serves_spa_index() {
        let res = static_asset("/".parse().expect("uri")).await;
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let ct = res
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .expect("content-type")
            .to_str()
            .expect("utf8");
        assert!(ct.starts_with("text/html"), "unexpected content-type: {ct}");
        let body = to_bytes(res.into_body(), usize::MAX).await.expect("body");
        let html = String::from_utf8(body.to_vec()).expect("utf8 body");
        assert!(html.contains("<div id=\"root\">"), "missing SPA mount point");
        assert!(html.contains("/assets/"), "missing hashed asset reference");
    }

    #[tokio::test]
    #[cfg_attr(pico_web_skip_ui_build, ignore = "no real SPA build in skip mode")]
    async fn unknown_route_falls_back_to_index() {
        let res = static_asset("/threads/abc".parse().expect("uri")).await;
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.expect("body");
        assert!(
            String::from_utf8_lossy(&body).contains("<div id=\"root\">"),
            "SPA fallback did not serve index"
        );
    }

    #[tokio::test]
    async fn missing_hashed_asset_returns_404() {
        let res = static_asset("/assets/index-deadbeef.js".parse().expect("uri")).await;
        assert_eq!(res.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_file_with_extension_returns_404() {
        let res = static_asset("/favicon.ico".parse().expect("uri")).await;
        assert_eq!(res.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    #[cfg_attr(pico_web_skip_ui_build, ignore = "no real SPA build in skip mode")]
    async fn hashed_js_asset_has_javascript_mime() {
        let name = Assets::iter().find(|p| p.ends_with(".js")).expect("a bundled js asset");
        let res = static_asset(format!("/{name}").parse().expect("uri")).await;
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let ct = res
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .expect("content-type")
            .to_str()
            .expect("utf8")
            .to_owned();
        assert!(ct.contains("javascript"), "js asset served with wrong mime: {ct}");
    }
}
