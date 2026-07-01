use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::{config::StreamingBehavior, surface::ConversationId};

struct Sink {
    tx: mpsc::UnboundedSender<(String, StreamingBehavior)>,
    default_mode: StreamingBehavior,
}

#[derive(Clone, Default)]
pub struct MidTurnQueue {
    inner: Arc<Mutex<HashMap<ConversationId, Sink>>>,
}

impl MidTurnQueue {
    pub fn deliver(
        &self,
        conversation: &ConversationId,
        text: &str,
        mode_override: Option<StreamingBehavior>,
    ) -> Option<StreamingBehavior> {
        let map = self.inner.lock();
        let sink = map.get(conversation)?;
        let mode = mode_override.unwrap_or(sink.default_mode);
        sink.tx.send((text.to_owned(), mode)).ok()?;
        Some(mode)
    }

    pub fn is_active(&self, conversation: &ConversationId) -> bool {
        self.inner.lock().contains_key(conversation)
    }

    pub fn register(
        &self,
        conversation: &ConversationId,
        default_mode: StreamingBehavior,
    ) -> (mpsc::UnboundedReceiver<(String, StreamingBehavior)>, SinkGuard) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner
            .lock()
            .insert(conversation.clone(), Sink { tx, default_mode });
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
        assert!(q.deliver(&conv(1), "hi", None).is_none());
    }

    #[test]
    fn deliver_reaches_registered_turn_and_is_isolated_per_channel() {
        let q = MidTurnQueue::default();
        let (mut rx, _g) = q.register(&conv(1), StreamingBehavior::Steer);
        assert_eq!(q.deliver(&conv(1), "hello", None), Some(StreamingBehavior::Steer));
        assert_eq!(rx.try_recv().unwrap(), ("hello".to_owned(), StreamingBehavior::Steer));
        assert!(q.deliver(&conv(2), "x", None).is_none());
    }

    #[test]
    fn mode_override_wins_over_registered_default() {
        let q = MidTurnQueue::default();
        let (mut rx, _g) = q.register(&conv(1), StreamingBehavior::Steer);
        assert_eq!(
            q.deliver(&conv(1), "x", Some(StreamingBehavior::Queue)),
            Some(StreamingBehavior::Queue)
        );
        assert_eq!(rx.try_recv().unwrap(), ("x".to_owned(), StreamingBehavior::Queue));
    }

    #[test]
    fn guard_drop_unregisters() {
        let q = MidTurnQueue::default();
        let (_rx, g) = q.register(&conv(1), StreamingBehavior::FollowUp);
        drop(g);
        assert!(q.deliver(&conv(1), "late", None).is_none());
    }

    #[test]
    fn is_active_false_by_default() {
        let q = MidTurnQueue::default();
        assert!(!q.is_active(&conv(1)));
    }

    #[test]
    fn is_active_true_while_guard_held_then_false_after_drop() {
        let q = MidTurnQueue::default();
        let (_rx, g) = q.register(&conv(1), StreamingBehavior::Steer);
        assert!(q.is_active(&conv(1)));
        drop(g);
        assert!(!q.is_active(&conv(1)));
    }

    #[test]
    fn is_active_is_isolated_per_conversation() {
        let q = MidTurnQueue::default();
        let (_rx, _g) = q.register(&conv(1), StreamingBehavior::Steer);
        assert!(q.is_active(&conv(1)));
        assert!(!q.is_active(&conv(2)));
    }
}
