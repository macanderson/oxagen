//! `oxagen-core` — the step-driver (`02-architecture.md` §2). One model call
//! per step, message accumulation, retry+backoff, context compaction,
//! tool-output budget + eviction, loop detection, USD budget metering.
//!
//! NO I/O of its own: the engine drives through the `Provider` and
//! `ToolExecutor` traits and emits `AgentEvent`s over a channel. All
//! decision logic (compaction, eviction, loop detection, budget) is plain
//! synchronous functions over owned data — easy to property-test
//! (`02-architecture.md` §1.3).

pub mod compaction;
pub mod estimator;
pub mod ports;

pub use ports::{Clock, ToolExecutor};
