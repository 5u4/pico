use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct Bubble {
    pub id: u64,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerFrame {
    Opened {
        thread_id: String,
        title: String,
    },
    History {
        bubbles: Vec<Bubble>,
    },
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
    Open { thread_id: String },
    New,
    Prompt { text: String },
    Cancel,
}
