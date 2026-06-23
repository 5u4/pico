use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::{config::StreamingBehavior, surface::ConversationId};

struct Sink {
    tx: mpsc::UnboundedSender<String>,
    mode: StreamingBehavior,
}

#[derive(Clone, Default)]
pub struct MidTurnQueue {
    inner: Arc<Mutex<HashMap<ConversationId, Sink>>>,
}

impl MidTurnQueue {
    pub fn deliver(&self, conversation: &ConversationId, text: &str) -> Option<StreamingBehavior> {
        let map = self.inner.lock();
        let sink = map.get(conversation)?;
        sink.tx.send(text.to_owned()).ok()?;
        Some(sink.mode)
    }

    pub fn register(
        &self,
        conversation: &ConversationId,
        mode: StreamingBehavior,
    ) -> (mpsc::UnboundedReceiver<String>, SinkGuard) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.lock().insert(conversation.clone(), Sink { tx, mode });
        (
            rx,
            SinkGuard {
                queue: self.clone(),
                conversation: conversation.clone(),
            },
        )
    }
}

pub struct SinkGuard {
    queue: MidTurnQueue,
    conversation: ConversationId,
}

impl Drop for SinkGuard {
    fn drop(&mut self) {
        self.queue.inner.lock().remove(&self.conversation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(n: u64) -> ConversationId {
        ConversationId::new("test", &n.to_string())
    }

    #[test]
    fn deliver_without_running_turn_is_none() {
        let q = MidTurnQueue::default();
        assert!(q.deliver(&conv(1), "hi").is_none());
    }

    #[test]
    fn deliver_reaches_registered_turn_and_is_isolated_per_channel() {
        let q = MidTurnQueue::default();
        let (mut rx, _g) = q.register(&conv(1), StreamingBehavior::Steer);
        assert_eq!(q.deliver(&conv(1), "hello"), Some(StreamingBehavior::Steer));
        assert_eq!(rx.try_recv().unwrap(), "hello");
        assert!(q.deliver(&conv(2), "x").is_none());
    }

    #[test]
    fn guard_drop_unregisters() {
        let q = MidTurnQueue::default();
        let (_rx, g) = q.register(&conv(1), StreamingBehavior::FollowUp);
        drop(g);
        assert!(q.deliver(&conv(1), "late").is_none());
    }
}
