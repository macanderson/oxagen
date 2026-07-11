//! `oxagen-core` — the step-driver (`02-architecture.md` §2). One model call
//! per step, message accumulation, retry+backoff, context compaction,
//! tool-output budget + eviction, loop detection, USD budget metering.
//!
//! NO I/O of its own: the engine drives through the `Provider` and
//! `ToolExecutor` traits and emits `AgentEvent`s over a channel. All
//! decision logic (compaction, eviction, loop detection, budget) is plain
//! synchronous functions over owned data — easy to property-test
//! (`02-architecture.md` §1.3).

pub mod budget;
pub mod compaction;
pub mod estimator;
pub mod loop_detect;
pub mod ports;
pub mod retry;
pub mod router;

pub use budget::{BudgetGuard, BudgetOutcome};
pub use loop_detect::{LoopDetectionConfig, LoopVerdict, detect_loop};
pub use ports::{Clock, ToolExecutor};
pub use retry::{RetryOutcome, RetryPolicy, retry_with_backoff};
pub use router::{RoleTable, Router};
