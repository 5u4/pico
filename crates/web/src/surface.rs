use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use pico_core::{
    omp::protocol::UiRequest,
    surface::{PostOpts, SizeLimits, Surface, UiOutcome},
};
use tokio::sync::mpsc::UnboundedSender;

use crate::proto::ServerFrame;

const WEB_LIMITS: SizeLimits = SizeLimits {
    message_cap: 1_000_000,
    activity_line_cap: usize::MAX,
    activity_char_cap: 1_000_000,
    activity_send_max: 1_000_000,
};

pub struct WebSurface {
    tx: UnboundedSender<ServerFrame>,
    seq: Arc<AtomicU64>,
}

impl WebSurface {
    pub fn new(tx: UnboundedSender<ServerFrame>, seq: Arc<AtomicU64>) -> Self {
        Self { tx, seq }
    }

    fn next_id(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }
}

impl Surface for WebSurface {
    type Msg = u64;
    type Typing = ();

    fn typing(&self) {}

    fn limits(&self) -> SizeLimits {
        WEB_LIMITS
    }

    async fn post(&self, text: &str, opts: PostOpts) -> Option<u64> {
        let id = self.next_id();
        let frame = ServerFrame::BubbleNew {
            id,
            text: text.to_owned(),
            reply: opts.as_reply,
            silent: opts.silent,
        };
        self.tx.send(frame).ok()?;
        Some(id)
    }

    async fn edit(&self, msg: &u64, text: &str) -> bool {
        self.tx
            .send(ServerFrame::BubblePatch {
                id: *msg,
                text: text.to_owned(),
            })
            .is_ok()
    }

    async fn ui(&self, _req: &UiRequest) -> UiOutcome {
        UiOutcome::Cancelled
    }

    async fn set_title(&self, title: &str) -> bool {
        self.tx
            .send(ServerFrame::Title {
                title: title.to_owned(),
            })
            .is_ok()
    }
}
