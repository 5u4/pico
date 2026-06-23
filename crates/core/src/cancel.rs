use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::surface::ConversationId;

struct Turn {
    token: CancellationToken,
    streaming: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct CancelRegistry {
    inner: Arc<Mutex<HashMap<ConversationId, Turn>>>,
}

impl CancelRegistry {
    pub fn request(&self, conversation: &ConversationId) -> bool {
        let token = match self.inner.lock().get(conversation) {
            Some(turn) if turn.streaming.load(Ordering::Acquire) => turn.token.clone(),
            _ => return false,
        };
        token.cancel();
        true
    }

    pub fn register(&self, conversation: &ConversationId) -> (CancellationToken, Arc<AtomicBool>, CancelGuard) {
        let token = CancellationToken::new();
        let streaming = Arc::new(AtomicBool::new(true));
        self.inner.lock().insert(
            conversation.clone(),
            Turn {
                token: token.clone(),
                streaming: Arc::clone(&streaming),
            },
        );
        (
            token,
            streaming,
            CancelGuard {
                registry: self.clone(),
                conversation: conversation.clone(),
            },
        )
    }
}

pub struct CancelGuard {
    registry: CancelRegistry,
    conversation: ConversationId,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.registry.inner.lock().remove(&self.conversation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(n: u64) -> ConversationId {
        ConversationId::new("test", &n.to_string())
    }

    #[test]
    fn request_without_running_turn_is_false() {
        let registry = CancelRegistry::default();
        assert!(!registry.request(&conv(1)));
    }

    #[test]
    fn request_cancels_registered_token_and_is_isolated_per_channel() {
        let registry = CancelRegistry::default();
        let (token, _streaming, _guard) = registry.register(&conv(1));
        assert!(!token.is_cancelled());
        assert!(registry.request(&conv(1)));
        assert!(token.is_cancelled());
        assert!(!registry.request(&conv(2)));
    }

    #[test]
    fn request_is_rejected_while_paused_on_a_dialog() {
        let registry = CancelRegistry::default();
        let (token, streaming, _guard) = registry.register(&conv(1));
        streaming.store(false, Ordering::Release);
        assert!(!registry.request(&conv(1)));
        assert!(!token.is_cancelled());
        streaming.store(true, Ordering::Release);
        assert!(registry.request(&conv(1)));
        assert!(token.is_cancelled());
    }

    #[test]
    fn guard_drop_unregisters() {
        let registry = CancelRegistry::default();
        let (_token, _streaming, guard) = registry.register(&conv(1));
        drop(guard);
        assert!(!registry.request(&conv(1)));
    }
}
