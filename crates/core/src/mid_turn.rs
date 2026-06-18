//! Per-thread sink for a message that lands while a turn is already streaming:
//! the router hands it to the running `drive_turn` (forwarded to omp as
//! `steer`/`follow_up`) instead of serializing a fresh turn behind the lock. The
//! deliver/close race is closed under the registry lock (see `drain_or_close`).

use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use poise::serenity_prelude as serenity;
use tokio::sync::mpsc;

use crate::config::StreamingBehavior;

/// `mode` lets the router pick the ack reaction without reloading config.
struct Sink {
    tx: mpsc::UnboundedSender<String>,
    mode: StreamingBehavior,
}

#[derive(Clone, Default)]
pub struct MidTurnQueue {
    inner: Arc<Mutex<HashMap<serenity::ChannelId, Sink>>>,
}

impl MidTurnQueue {
    /// Hand `text` to the turn on `channel`, returning its mode for the ack
    /// reaction (or `None` if none runs). Locked across the send so it can't race
    /// [`drain_or_close`](Self::drain_or_close) — a delivered message is never lost.
    pub fn deliver(&self, channel: serenity::ChannelId, text: &str) -> Option<StreamingBehavior> {
        let map = self.inner.lock();
        let sink = map.get(&channel)?;
        sink.tx.send(text.to_owned()).ok()?;
        Some(sink.mode)
    }

    /// Register the running turn; the guard unregisters on drop (abnormal exits).
    pub fn register(
        &self,
        channel: serenity::ChannelId,
        mode: StreamingBehavior,
    ) -> (mpsc::UnboundedReceiver<String>, SinkGuard) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.lock().insert(channel, Sink { tx, mode });
        (
            rx,
            SinkGuard {
                queue: self.clone(),
                channel,
            },
        )
    }

    /// At `agent_end`, under the registry lock: hand back a message that raced the
    /// close (loop reruns it as a fresh prompt, sink kept) or remove the sink and
    /// return `None`. The lock makes "empty" and "removed" atomic vs `deliver`.
    pub fn drain_or_close(
        &self,
        channel: serenity::ChannelId,
        rx: &mut mpsc::UnboundedReceiver<String>,
    ) -> Option<String> {
        let mut map = self.inner.lock();
        match rx.try_recv() {
            Ok(text) => Some(text),
            Err(_) => {
                map.remove(&channel);
                None
            }
        }
    }
}

/// Unregisters the sink on drop so an abnormal exit can't leak a dangling sink.
pub struct SinkGuard {
    queue: MidTurnQueue,
    channel: serenity::ChannelId,
}

impl Drop for SinkGuard {
    fn drop(&mut self) {
        self.queue.inner.lock().remove(&self.channel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chan(n: u64) -> serenity::ChannelId {
        serenity::ChannelId::new(n)
    }

    #[test]
    fn deliver_without_running_turn_is_none() {
        let q = MidTurnQueue::default();
        assert!(q.deliver(chan(1), "hi").is_none());
    }

    #[test]
    fn deliver_reaches_registered_turn_and_is_isolated_per_channel() {
        let q = MidTurnQueue::default();
        let (mut rx, _g) = q.register(chan(1), StreamingBehavior::Steer);
        assert_eq!(q.deliver(chan(1), "hello"), Some(StreamingBehavior::Steer));
        assert_eq!(rx.try_recv().unwrap(), "hello");
        assert!(q.deliver(chan(2), "x").is_none());
    }

    #[test]
    fn guard_drop_unregisters() {
        let q = MidTurnQueue::default();
        let (_rx, g) = q.register(chan(1), StreamingBehavior::FollowUp);
        drop(g);
        assert!(q.deliver(chan(1), "late").is_none());
    }

    #[test]
    fn drain_hands_back_straggler_then_closes_when_empty() {
        let q = MidTurnQueue::default();
        let (mut rx, _g) = q.register(chan(1), StreamingBehavior::FollowUp);

        assert_eq!(q.deliver(chan(1), "straggler"), Some(StreamingBehavior::FollowUp));
        assert_eq!(q.drain_or_close(chan(1), &mut rx).as_deref(), Some("straggler"));
        assert!(q.deliver(chan(1), "again").is_some());

        assert_eq!(q.drain_or_close(chan(1), &mut rx).as_deref(), Some("again"));
        assert_eq!(q.drain_or_close(chan(1), &mut rx), None);
        assert!(q.deliver(chan(1), "after").is_none());
    }
}
