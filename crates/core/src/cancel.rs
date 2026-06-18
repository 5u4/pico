//! Per-thread registry of the in-flight turn's cancellation token: `drive_turn`
//! registers one per turn (a drop-guard unregisters it) and `/cancel` fires it.
//! Turns serialise behind the session mutex, so the keyed removal can't clobber a
//! successor. `streaming`, cleared across a tool-approval dialog, keeps `/cancel`
//! from latching a deferred abort on a non-streaming turn (the dialog self-cancels).

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use parking_lot::Mutex;
use poise::serenity_prelude as serenity;
use tokio_util::sync::CancellationToken;

struct Turn {
    token: CancellationToken,
    streaming: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct CancelRegistry {
    inner: Arc<Mutex<HashMap<serenity::ChannelId, Turn>>>,
}

impl CancelRegistry {
    /// Cancel the turn on `channel` iff it is actively streaming; returns whether
    /// it was. False when nothing runs there or it is paused on a dialog.
    pub fn request(&self, channel: serenity::ChannelId) -> bool {
        match self.inner.lock().get(&channel) {
            Some(turn) if turn.streaming.load(Ordering::Acquire) => {
                turn.token.cancel();
                true
            }
            _ => false,
        }
    }

    /// Register the running turn with a fresh token; the guard unregisters on
    /// drop. `drive_turn` clears the returned flag while it blocks on a dialog.
    pub fn register(&self, channel: serenity::ChannelId) -> (CancellationToken, Arc<AtomicBool>, CancelGuard) {
        let token = CancellationToken::new();
        let streaming = Arc::new(AtomicBool::new(true));
        self.inner.lock().insert(
            channel,
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
                channel,
            },
        )
    }
}

/// Unregisters the token on drop so a finished turn can't leak a dangling entry.
pub struct CancelGuard {
    registry: CancelRegistry,
    channel: serenity::ChannelId,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.registry.inner.lock().remove(&self.channel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chan(n: u64) -> serenity::ChannelId {
        serenity::ChannelId::new(n)
    }

    #[test]
    fn request_without_running_turn_is_false() {
        let registry = CancelRegistry::default();
        assert!(!registry.request(chan(1)));
    }

    #[test]
    fn request_cancels_registered_token_and_is_isolated_per_channel() {
        let registry = CancelRegistry::default();
        let (token, _streaming, _guard) = registry.register(chan(1));
        assert!(!token.is_cancelled());
        assert!(registry.request(chan(1)));
        assert!(token.is_cancelled());
        assert!(!registry.request(chan(2)));
    }

    #[test]
    fn request_is_rejected_while_paused_on_a_dialog() {
        let registry = CancelRegistry::default();
        let (token, streaming, _guard) = registry.register(chan(1));
        streaming.store(false, Ordering::Release);
        assert!(!registry.request(chan(1)));
        assert!(!token.is_cancelled());
        streaming.store(true, Ordering::Release);
        assert!(registry.request(chan(1)));
        assert!(token.is_cancelled());
    }

    #[test]
    fn guard_drop_unregisters() {
        let registry = CancelRegistry::default();
        let (_token, _streaming, guard) = registry.register(chan(1));
        drop(guard);
        assert!(!registry.request(chan(1)));
    }
}
