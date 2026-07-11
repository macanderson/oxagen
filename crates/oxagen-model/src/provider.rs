//! The `Provider` trait — Phase 0 surface. Every adapter implements
//! `complete()`, driving its own SSE/stream parsing internally and
//! returning the aggregated `CompletionResult`. This is the direct
//! ancestor of the fuller `Provider::stream()`/`generate_object()` surface
//! specified in `docs/specs/oxagen-rust-cli/02-architecture.md` §3, which
//! lands in Phase 2 once three dialects exist to generalize from.

use async_trait::async_trait;
use oxagen_protocol::{CompletionRequest, CompletionResult, ProviderError};

/// One model provider adapter. `oxagen-core` (Phase 2+) drives every call
/// through `&dyn Provider` — no adapter-specific code ever lives outside
/// `oxagen-model`.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Stable id for this provider instance, e.g. `"zai"` or `"anthropic"`.
    fn id(&self) -> &str;

    /// Run one completion end-to-end (streams internally, aggregates the
    /// result). Returns a typed, retry-classified error on failure — never
    /// panics on a malformed/erroring HTTP response.
    async fn complete(&self, req: CompletionRequest) -> Result<CompletionResult, ProviderError>;
}
