use crate::omp::protocol::UiRequest;

#[allow(async_fn_in_trait)]
pub trait Surface: Send + Sync {
    type Msg: Send + Sync;
    type Typing: Send;

    fn typing(&self) -> Self::Typing;

    async fn post(&self, text: &str, opts: PostOpts) -> Option<Self::Msg>;

    async fn edit(&self, msg: &Self::Msg, text: &str) -> bool;

    async fn ui(&self, req: &UiRequest) -> UiOutcome;

    async fn say(&self, text: &str) {
        self.post(text, PostOpts::PLAIN).await;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PostOpts {
    pub as_reply: bool,
    pub silent: bool,
}

impl PostOpts {
    pub const PLAIN: PostOpts = PostOpts {
        as_reply: false,
        silent: false,
    };
    pub const SILENT: PostOpts = PostOpts {
        as_reply: false,
        silent: true,
    };
    pub const REPLY: PostOpts = PostOpts {
        as_reply: true,
        silent: false,
    };
}

#[derive(Debug, PartialEq, Eq)]
pub enum UiOutcome {
    Respond { reply: UiReply, posted: bool },
    Notified { posted: bool },
    Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UiReply {
    Value(String),
    Confirmed(bool),
    Dismissed { timed_out: bool },
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ConversationId(String);

impl ConversationId {
    pub fn new(platform: &str, native: &str) -> Self {
        ConversationId(format!("{platform}:{native}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ConversationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
