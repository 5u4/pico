use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerFrame {
    BubbleNew {
        id: u64,
        text: String,
        reply: bool,
        silent: bool,
    },
    BubblePatch {
        id: u64,
        text: String,
    },
    Title {
        title: String,
    },
    TurnStart,
    TurnEnd,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClientFrame {
    Prompt { text: String },
    Cancel,
}
