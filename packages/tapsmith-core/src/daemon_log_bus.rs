//! In-process broadcast of daemon `tracing` events, consumed by the
//! `StreamDaemonLogs` RPC so the SDK can fold daemon logs into per-test traces.
//!
//! This module is wired into the live tracing subscriber (`main.rs`) and the
//! `StreamDaemonLogs` gRPC handler (`grpc_server.rs`).

use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::broadcast;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

/// One captured daemon log line.
#[derive(Clone, Debug)]
pub struct DaemonLogEntry {
    pub level: String,
    pub message: String,
    pub target: String,
    pub request_id: String,
    pub timestamp_ms: u64,
}

/// Cloneable handle to the broadcast channel. Cloning shares the same sender.
#[derive(Clone)]
pub struct DaemonLogBus {
    tx: broadcast::Sender<DaemonLogEntry>,
}

impl DaemonLogBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Subscribe to the live feed. Lagged receivers drop oldest entries.
    pub fn subscribe(&self) -> broadcast::Receiver<DaemonLogEntry> {
        self.tx.subscribe()
    }

    fn publish(&self, entry: DaemonLogEntry) {
        // Err == no active subscribers; that's fine, drop the entry.
        let _ = self.tx.send(entry);
    }
}

/// A `tracing` layer that forwards every event to the [`DaemonLogBus`].
pub struct DaemonLogLayer {
    bus: DaemonLogBus,
}

impl DaemonLogLayer {
    pub fn new(bus: DaemonLogBus) -> Self {
        Self { bus }
    }
}

/// Extracts the `message` field and any other formatted fields from an event.
///
/// `message` and the structured fields are stored separately and combined only
/// at the end: `tracing` does not guarantee field visit order, so accumulating
/// into a single string risks a `message` visit overwriting fields recorded
/// before it (silent data loss).
#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
    fields: Vec<String>,
}

impl Visit for MessageVisitor {
    // String-valued fields arrive here directly, giving us the raw, unescaped
    // value — no Debug quoting/escaping to undo.
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.fields.push(format!("{}={value}", field.name()));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            // The log message is `fmt::Arguments`, whose Debug output is the
            // formatted text with no surrounding quotes.
            self.message = Some(format!("{value:?}"));
        } else {
            // Keep non-string structured fields as `key=value` so they aren't lost.
            self.fields.push(format!("{}={value:?}", field.name()));
        }
    }
}

impl<S> Layer<S> for DaemonLogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);

        // Combine once all fields are visited: message first, then any
        // structured fields, regardless of the order they were recorded in.
        let mut message = visitor.message.unwrap_or_default();
        if !visitor.fields.is_empty() {
            if !message.is_empty() {
                message.push(' ');
            }
            message.push_str(&visitor.fields.join(" "));
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        self.bus.publish(DaemonLogEntry {
            level: event.metadata().level().to_string().to_lowercase(),
            message,
            target: event.metadata().target().to_string(),
            request_id: String::new(), // a later task fills this from the span scope
            timestamp_ms: now_ms,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::prelude::*;

    #[tokio::test]
    async fn forwards_events_to_subscriber() {
        let bus = DaemonLogBus::new(16);
        let mut rx = bus.subscribe();
        let subscriber = tracing_subscriber::registry().with(DaemonLogLayer::new(bus.clone()));

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("hello daemon");
        });

        let entry = rx.try_recv().expect("entry should be published");
        assert_eq!(entry.level, "info");
        assert_eq!(entry.message, "hello daemon");
    }

    #[tokio::test]
    async fn keeps_message_and_structured_fields() {
        let bus = DaemonLogBus::new(16);
        let mut rx = bus.subscribe();
        let subscriber = tracing_subscriber::registry().with(DaemonLogLayer::new(bus.clone()));

        tracing::subscriber::with_default(subscriber, || {
            // Mixes the message with both a string field and a non-string field;
            // none must be dropped regardless of visit order.
            tracing::info!(serial = "emu-1", count = 3, "starting");
        });

        let entry = rx.try_recv().expect("entry should be published");
        assert!(
            entry.message.contains("starting"),
            "message: {}",
            entry.message
        );
        assert!(
            entry.message.contains("serial=emu-1"),
            "message: {}",
            entry.message
        );
        assert!(
            entry.message.contains("count=3"),
            "message: {}",
            entry.message
        );
    }
}
