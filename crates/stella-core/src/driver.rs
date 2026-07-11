//! The step-driver: `Engine::run_turn` (`02-architecture.md` §2, §5). One
//! model call per step, message accumulation, `AgentEvent` emission at
//! every boundary, retry+backoff, compaction, tool-output budget checks,
//! loop detection, and (a first, structural cut of) malformed-call repair —
//! wiring together every other module in this crate.
//!
//! `Engine` drives through `&dyn Provider` (`stella_protocol`) and
//! `&dyn ToolExecutor` (`crate::ports`) — no adapter-specific code, no
//! filesystem call, lives here (`02-architecture.md` §1.1). Everything
//! *inside* one step (compaction, loop detection, budget evaluation) is the
//! plain synchronous logic from the other modules in this crate; `run_turn`
//! is the one place that sequences them against real I/O.
//!
//! # Deferred-flush events (L-E10)
//!
//! [`crate::retry::retry_with_backoff`] already implements the contract:
//! on success it returns the *full* retry history (so a step that failed
//! twice then succeeded still reports two `Retry` events — the attempts
//! were real, they just didn't fail the step); on failure it returns only
//! the terminal error. `run_turn` emits events straight from that outcome,
//! so a step that never commits emits nothing about its doomed attempts —
//! there is nothing extra to build here, the discipline is inherited.
//!
//! # Retry never re-executes a tool call
//!
//! [`crate::retry::retry_with_backoff`] wraps *only* the model call
//! (`Provider::complete`). Tool execution happens exactly once, after a
//! model call has already succeeded and returned tool calls to run — it is
//! never inside the retried closure. A retried step therefore structurally
//! cannot re-execute a non-idempotent tool call; see the property test
//! `retry_never_re_executes_a_tool_call` below, which proves it by
//! counting real executions against a flaky scripted provider.
//!
//! # Budget is checked between steps, never mid-tool
//!
//! Per [`crate::budget`]'s module contract, `run_turn` only consults
//! [`crate::budget::BudgetGuard::evaluate`]/`record_spend` immediately
//! after a model call completes and before the next one (or before
//! executing this step's tool calls) — an `AbortTurn` outcome ends the turn
//! cleanly, it never interrupts a tool already in flight.
//!
//! # Malformed-call repair
//!
//! Every existing adapter's stream aggregator falls back to
//! `serde_json::Value::Null` when a tool call's streamed argument JSON
//! doesn't parse (`stella-model/src/{zai,anthropic}.rs`). `run_turn`
//! recognizes that sentinel structurally: rather than handing `Null` to a
//! tool that expects an object, it short-circuits to a named
//! `ToolOutput::Error` telling the model its own JSON was malformed, so the
//! model can retry with corrected syntax on the next step. This is a real,
//! if first-cut, repair — dialect-specific tuning (`07-model-matrix.md`
//! §4.2: "malformed-call repair tuned to the failure shapes GLM actually
//! produces") is a documented follow-up, not faked here.

use std::future::Future;
use std::pin::Pin;

use stella_protocol::{
    AgentEvent, CompletionMessage, CompletionRequest, MessageRole, Provider, ProviderError,
    ReasoningEffort, StageKind, ToolCall, ToolOutput, ToolResult,
};
use tokio::sync::mpsc::UnboundedSender;

use crate::budget::{BudgetGuard, BudgetOutcome};
use crate::compaction::compact;
use crate::loop_detect::{LoopDetectionConfig, detect_loop};
use crate::ports::ToolExecutor;
use crate::retry::{RetryOutcome, RetryPolicy, Sleeper, TokioSleeper, retry_with_backoff};

/// Everything about a turn's execution that isn't the provider/tools
/// themselves: prompt shape, retry/compaction/loop tuning, and hard
/// backstops. `Default` gives sensible starting values for `stella-cli`.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub effort: Option<ReasoningEffort>,
    pub retry_policy: RetryPolicy,
    pub loop_detection: LoopDetectionConfig,
    /// Compaction fires once the estimated conversation size exceeds this
    /// many tokens (`crate::estimator`).
    pub compaction_budget_tokens: u64,
    /// Hard backstop on step count, independent of loop detection — belt
    /// and suspenders, never the *primary* stuck-loop defense (that's
    /// `crate::loop_detect`).
    pub max_steps: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            max_output_tokens: Some(8192),
            temperature: Some(0.0),
            effort: None,
            retry_policy: RetryPolicy::standard(),
            loop_detection: LoopDetectionConfig::default(),
            compaction_budget_tokens: 150_000,
            max_steps: 200,
        }
    }
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    /// The model produced a final text response with no further tool
    /// calls.
    Completed { text: String, cost_usd: f64 },
    /// The turn ended before completion: budget enforced, a loop was
    /// detected, retries were exhausted, or the step cap was hit. Always a
    /// *clean* abort — never mid-tool (see module docs).
    Aborted { reason: String },
}

/// The step-driver. Holds no conversation state of its own — `run_turn`
/// takes the message history by `&mut` reference so callers (one-shot CLI,
/// REPL, fleet worker) own persistence and can inspect history after an
/// aborted turn.
pub struct Engine<'a> {
    provider: &'a dyn Provider,
    tools: &'a dyn ToolExecutor,
    sleeper: &'a dyn Sleeper,
    config: EngineConfig,
}

impl<'a> Engine<'a> {
    /// Construct an engine with the production [`TokioSleeper`]. Use
    /// [`Engine::with_sleeper`] in tests to run retries with zero real
    /// wall-clock delay.
    pub fn new(
        provider: &'a dyn Provider,
        tools: &'a dyn ToolExecutor,
        config: EngineConfig,
    ) -> Self {
        Self::with_sleeper(provider, tools, config, &TokioSleeper)
    }

    /// Construct an engine with an injected [`Sleeper`] — the seam that
    /// makes `run_turn`'s retry loop testable without real sleeping.
    pub fn with_sleeper(
        provider: &'a dyn Provider,
        tools: &'a dyn ToolExecutor,
        config: EngineConfig,
        sleeper: &'a dyn Sleeper,
    ) -> Self {
        Self {
            provider,
            tools,
            sleeper,
            config,
        }
    }

    /// Drive one turn to completion or a clean abort, appending every
    /// message to `messages` and streaming an `AgentEvent` for every
    /// boundary over `events`. `budget` is `&mut` because spend
    /// accumulates across the turn (and, via `BudgetGuard::begin_turn`,
    /// across turns in the same session — the caller decides when to reset
    /// it, `run_turn` only reads and records).
    pub async fn run_turn(
        &self,
        messages: &mut Vec<CompletionMessage>,
        budget: &mut BudgetGuard,
        events: &UnboundedSender<AgentEvent>,
    ) -> TurnOutcome {
        let _ = events.send(AgentEvent::Stage {
            name: StageKind::Execute,
        });

        let mut total_cost_usd = 0.0f64;

        for _step in 0..self.config.max_steps {
            // ---- Compaction (before every model call, per the running
            // ---- estimate; L-E3 dedup+evict, stable system prefix — the
            // ---- system message is index 0 and compact() never touches it).
            if let Some(report) = compact(messages, self.config.compaction_budget_tokens) {
                let _ = events.send(AgentEvent::Compaction {
                    before_tokens: report.before_tokens,
                    after_tokens: report.after_tokens,
                    evicted: report.evicted,
                    deduped: report.deduped,
                });
            }

            // ---- Loop detection (before spending a model call on a step
            // ---- that's already stuck).
            let recent_calls = recent_tool_calls(messages);
            let verdict = detect_loop(&recent_calls, self.config.loop_detection);
            if verdict.is_loop() {
                let reason = verdict
                    .evidence()
                    .unwrap_or_else(|| "loop detected".to_string());
                let _ = events.send(AgentEvent::Error {
                    message: reason.clone(),
                    retryable: false,
                });
                return TurnOutcome::Aborted {
                    reason: format!("stuck-loop detected: {reason}"),
                };
            }

            // ---- Budget (between steps, never mid-tool — see module docs).
            if let BudgetOutcome::AbortTurn {
                spent_usd,
                limit_usd,
                ..
            } = budget.evaluate()
            {
                let reason = format!(
                    "budget exceeded: spent ${spent_usd:.4} against a ${limit_usd:.2} limit"
                );
                let _ = events.send(AgentEvent::Error {
                    message: reason.clone(),
                    retryable: false,
                });
                return TurnOutcome::Aborted { reason };
            }

            // ---- The model call, with retry+backoff.
            let tools_schema = self.tools.schemas();
            let messages_snapshot = messages.clone();
            let req_config = &self.config;
            let attempt: RetryAttemptFn = Box::new(move || {
                let req = CompletionRequest {
                    messages: messages_snapshot.clone(),
                    max_output_tokens: req_config.max_output_tokens,
                    temperature: req_config.temperature,
                    effort: req_config.effort,
                    tools: tools_schema.clone(),
                };
                Box::pin(self.provider.complete(req))
            });

            let outcome =
                retry_with_backoff(&self.config.retry_policy, self.sleeper, attempt).await;

            let RetryOutcome {
                value: result,
                retries,
                ..
            } = match outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    let message = error.to_string();
                    let _ = events.send(AgentEvent::Error {
                        message: message.clone(),
                        retryable: error.is_retryable(),
                    });
                    return TurnOutcome::Aborted {
                        reason: format!("model call failed: {message}"),
                    };
                }
            };

            // Deferred-flush: these `Retry` events only reach the wire now
            // that the step has actually committed (see module docs).
            for attempt in &retries {
                let _ = events.send(AgentEvent::Retry {
                    attempt: attempt.attempt,
                    reason: attempt.reason.clone(),
                });
            }

            // ---- Budget accounting for the call that just committed.
            let outcome = budget.record_spend(result.cost_usd);
            total_cost_usd += result.cost_usd;
            let _ = events.send(AgentEvent::BudgetTick {
                spent_usd: budget.spent_usd(),
                limit_usd: budget.turn_limit_usd(),
                mode: budget.mode(),
            });
            if let BudgetOutcome::AbortTurn {
                spent_usd,
                limit_usd,
                ..
            } = outcome
            {
                // The call that just landed is the one that pushed spend
                // over the limit — it already committed (its result is
                // real, its cost already happened), so record it, THEN
                // abort before dispatching anything further. Still not a
                // mid-tool kill: no tool from *this* result has run yet.
                let reason = format!(
                    "budget exceeded after this call: spent ${spent_usd:.4} against a ${limit_usd:.2} limit"
                );
                let _ = events.send(AgentEvent::Error {
                    message: reason.clone(),
                    retryable: false,
                });
                return TurnOutcome::Aborted { reason };
            }

            if !result.text.is_empty() {
                let _ = events.send(AgentEvent::Text {
                    delta: result.text.clone(),
                });
            }

            if result.tool_calls.is_empty() {
                messages.push(CompletionMessage {
                    role: MessageRole::Assistant,
                    content: result.text.clone(),
                    tool_calls: Vec::new(),
                    tool_results: Vec::new(),
                });
                let _ = events.send(AgentEvent::Stage {
                    name: StageKind::Complete,
                });
                let _ = events.send(AgentEvent::Complete {
                    model: result.model.clone(),
                    cost_usd: total_cost_usd,
                });
                return TurnOutcome::Completed {
                    text: result.text,
                    cost_usd: total_cost_usd,
                };
            }

            messages.push(CompletionMessage {
                role: MessageRole::Assistant,
                content: result.text.clone(),
                tool_calls: result.tool_calls.clone(),
                tool_results: Vec::new(),
            });

            let mut tool_results = Vec::with_capacity(result.tool_calls.len());
            for call in &result.tool_calls {
                let _ = events.send(AgentEvent::ToolStart { call: call.clone() });
                let start = std::time::Instant::now();
                let output = self.execute_with_repair(call).await;
                let duration_ms = start.elapsed().as_millis() as u64;
                let _ = events.send(AgentEvent::ToolResult {
                    call_id: call.call_id.clone(),
                    output: output.clone(),
                    duration_ms,
                });
                tool_results.push(ToolResult {
                    call_id: call.call_id.clone(),
                    output,
                });
            }

            messages.push(CompletionMessage {
                role: MessageRole::Tool,
                content: String::new(),
                tool_calls: Vec::new(),
                tool_results,
            });
        }

        let reason = format!(
            "reached the step cap ({}) without completing — this is the belt-and-suspenders \
             backstop; loop detection should normally catch a stuck turn first",
            self.config.max_steps
        );
        let _ = events.send(AgentEvent::Error {
            message: reason.clone(),
            retryable: false,
        });
        TurnOutcome::Aborted { reason }
    }

    /// Execute one tool call, first checking for the malformed-input
    /// sentinel every adapter's stream aggregator falls back to (see module
    /// docs) rather than handing a tool `Null` and getting back a confusing
    /// tool-specific error.
    async fn execute_with_repair(&self, call: &ToolCall) -> ToolOutput {
        if call.input.is_null() {
            return ToolOutput::Error {
                message: format!(
                    "malformed tool call: `{}`'s arguments were not valid JSON (the model's \
                     streamed output didn't parse) — retry this call with well-formed JSON \
                     arguments",
                    call.name
                ),
            };
        }
        self.tools.execute(&call.name, &call.input).await
    }
}

/// The boxed-future shape `retry_with_backoff` needs from its `attempt_fn`
/// — named here purely to keep the call site in `run_turn` readable.
type RetryAttemptFn<'a> = Box<
    dyn FnMut() -> Pin<Box<dyn Future<Output = Result<CompletionResultAlias, ProviderError>> + 'a>>
        + 'a,
>;
type CompletionResultAlias = stella_protocol::CompletionResult;

/// Flatten the recent tool calls out of message history, in chronological
/// order, for `crate::loop_detect::detect_loop`. Pulled out as a free
/// function since it's plain data-shape massaging, not driver state.
fn recent_tool_calls(messages: &[CompletionMessage]) -> Vec<ToolCall> {
    messages
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .flat_map(|m| m.tool_calls.iter().cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use async_trait::async_trait;
    use serde_json::Value;
    use stella_protocol::CompletionUsage;
    use stella_protocol::ToolSchema;
    use stella_protocol::event::BudgetMode;
    use tokio::sync::Mutex as TokioMutex;
    use tokio::sync::mpsc;

    use super::*;
    use crate::retry::Sleeper;

    /// A `Sleeper` that records but never actually waits.
    #[derive(Default)]
    struct NoopSleeper;
    #[async_trait]
    impl Sleeper for NoopSleeper {
        async fn sleep(&self, _duration_ms: u64) {}
    }

    /// A `ToolExecutor` that always succeeds and counts real invocations —
    /// the counter is what `retry_never_re_executes_a_tool_call` asserts
    /// against.
    struct CountingTools {
        calls: Arc<AtomicU32>,
    }
    #[async_trait]
    impl ToolExecutor for CountingTools {
        fn schemas(&self) -> Vec<ToolSchema> {
            vec![ToolSchema {
                name: "bash".into(),
                description: "run a command".into(),
                input_schema: serde_json::json!({"type": "object"}),
            }]
        }
        async fn execute(&self, _name: &str, _input: &Value) -> ToolOutput {
            self.calls.fetch_add(1, Ordering::SeqCst);
            ToolOutput::Ok {
                content: "ok".into(),
            }
        }
    }

    /// A scripted `Provider`: pops one `Result` per call from a queue,
    /// looping the last entry once exhausted. Used both for the flaky-retry
    /// property test and the synthetic multi-dialect survival test.
    struct ScriptedProvider {
        id: String,
        script: TokioMutex<Vec<Result<CompletionResultAlias, ProviderError>>>,
        calls: Arc<AtomicU32>,
    }
    #[async_trait]
    impl Provider for ScriptedProvider {
        fn id(&self) -> &str {
            &self.id
        }
        async fn complete(
            &self,
            _req: CompletionRequest,
        ) -> Result<CompletionResultAlias, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut script = self.script.lock().await;
            if script.len() > 1 {
                script.remove(0)
            } else {
                clone_result(&script[0])
            }
        }
    }

    fn clone_result(
        r: &Result<CompletionResultAlias, ProviderError>,
    ) -> Result<CompletionResultAlias, ProviderError> {
        match r {
            Ok(v) => Ok(v.clone()),
            Err(e) => Err(clone_provider_error(e)),
        }
    }

    fn clone_provider_error(e: &ProviderError) -> ProviderError {
        match e {
            ProviderError::Transport(m) => ProviderError::Transport(m.clone()),
            ProviderError::RateLimited {
                message,
                retry_after_ms,
            } => ProviderError::RateLimited {
                message: message.clone(),
                retry_after_ms: *retry_after_ms,
            },
            ProviderError::Auth(m) => ProviderError::Auth(m.clone()),
            ProviderError::UnknownModel { slug } => {
                ProviderError::UnknownModel { slug: slug.clone() }
            }
            ProviderError::Malformed(m) => ProviderError::Malformed(m.clone()),
            ProviderError::Cancelled => ProviderError::Cancelled,
            ProviderError::Terminal(m) => ProviderError::Terminal(m.clone()),
        }
    }

    fn text_result(text: &str) -> CompletionResultAlias {
        CompletionResultAlias {
            text: text.into(),
            tool_calls: vec![],
            usage: CompletionUsage::default(),
            model: "scripted".into(),
            cost_usd: 0.0001,
        }
    }

    fn tool_call_result(call_id: &str, name: &str) -> CompletionResultAlias {
        CompletionResultAlias {
            text: String::new(),
            tool_calls: vec![ToolCall {
                call_id: call_id.into(),
                name: name.into(),
                input: serde_json::json!({"cmd": "echo hi"}),
            }],
            usage: CompletionUsage::default(),
            model: "scripted".into(),
            cost_usd: 0.0001,
        }
    }

    fn drain_events(rx: &mut mpsc::UnboundedReceiver<AgentEvent>) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        while let Ok(event) = rx.try_recv() {
            out.push(event);
        }
        out
    }

    #[tokio::test]
    async fn simple_turn_with_no_tool_calls_completes() {
        let provider = ScriptedProvider {
            id: "scripted".into(),
            script: TokioMutex::new(vec![Ok(text_result("hello!"))]),
            calls: Arc::new(AtomicU32::new(0)),
        };
        let tools = CountingTools {
            calls: Arc::new(AtomicU32::new(0)),
        };
        let sleeper = NoopSleeper;
        let engine = Engine::with_sleeper(&provider, &tools, EngineConfig::default(), &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("hi"),
        ];
        let mut budget = BudgetGuard::new(BudgetMode::Off, None, None);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let outcome = engine.run_turn(&mut messages, &mut budget, &tx).await;
        assert_eq!(
            outcome,
            TurnOutcome::Completed {
                text: "hello!".into(),
                cost_usd: 0.0001
            }
        );

        let events = drain_events(&mut rx);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::Complete { .. }))
        );
    }

    #[tokio::test]
    async fn tool_calls_execute_and_feed_back_into_history() {
        let provider = ScriptedProvider {
            id: "scripted".into(),
            script: TokioMutex::new(vec![
                Ok(tool_call_result("call_1", "bash")),
                Ok(text_result("done")),
            ]),
            calls: Arc::new(AtomicU32::new(0)),
        };
        let tool_calls = Arc::new(AtomicU32::new(0));
        let tools = CountingTools {
            calls: tool_calls.clone(),
        };
        let sleeper = NoopSleeper;
        let engine = Engine::with_sleeper(&provider, &tools, EngineConfig::default(), &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("hi"),
        ];
        let mut budget = BudgetGuard::new(BudgetMode::Off, None, None);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let outcome = engine.run_turn(&mut messages, &mut budget, &tx).await;
        assert_eq!(
            outcome,
            TurnOutcome::Completed {
                text: "done".into(),
                cost_usd: 0.0002
            }
        );
        assert_eq!(tool_calls.load(Ordering::SeqCst), 1);

        let events = drain_events(&mut rx);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolStart { .. }))
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolResult { .. }))
        );
    }

    #[tokio::test]
    async fn retry_never_re_executes_a_tool_call() {
        // Property: a step's tool call is executed exactly once, even when
        // the model call surrounding it needed retries elsewhere in the
        // turn. Script: transient failures, then a tool call, then success
        // — the tool must be counted exactly once, never per retry.
        let provider = ScriptedProvider {
            id: "scripted".into(),
            script: TokioMutex::new(vec![
                Err(ProviderError::Transport("blip".into())),
                Err(ProviderError::Transport("blip again".into())),
                Ok(tool_call_result("call_1", "bash")),
                Ok(text_result("done")),
            ]),
            calls: Arc::new(AtomicU32::new(0)),
        };
        let tool_calls = Arc::new(AtomicU32::new(0));
        let tools = CountingTools {
            calls: tool_calls.clone(),
        };
        let sleeper = NoopSleeper;
        let engine = Engine::with_sleeper(&provider, &tools, EngineConfig::default(), &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("hi"),
        ];
        let mut budget = BudgetGuard::new(BudgetMode::Off, None, None);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let outcome = engine.run_turn(&mut messages, &mut budget, &tx).await;
        assert_eq!(
            outcome,
            TurnOutcome::Completed {
                text: "done".into(),
                cost_usd: 0.0002
            }
        );
        assert_eq!(
            tool_calls.load(Ordering::SeqCst),
            1,
            "the tool call must execute exactly once, never once per model-call retry"
        );

        // And the doomed early attempts produced no per-attempt wire event
        // beyond the two `Retry` entries for the step that actually
        // committed (L-E10 — see module docs).
        let events = drain_events(&mut rx);
        let retry_events = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Retry { .. }))
            .count();
        assert_eq!(retry_events, 2);
    }

    #[tokio::test]
    async fn malformed_tool_call_input_is_repaired_not_executed_blindly() {
        let mut malformed_call = tool_call_result("call_1", "bash");
        malformed_call.tool_calls[0].input = Value::Null;
        let provider = ScriptedProvider {
            id: "scripted".into(),
            script: TokioMutex::new(vec![Ok(malformed_call), Ok(text_result("done"))]),
            calls: Arc::new(AtomicU32::new(0)),
        };
        let tool_calls = Arc::new(AtomicU32::new(0));
        let tools = CountingTools {
            calls: tool_calls.clone(),
        };
        let sleeper = NoopSleeper;
        let engine = Engine::with_sleeper(&provider, &tools, EngineConfig::default(), &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("hi"),
        ];
        let mut budget = BudgetGuard::new(BudgetMode::Off, None, None);
        let (tx, _rx) = mpsc::unbounded_channel();

        let _ = engine.run_turn(&mut messages, &mut budget, &tx).await;
        assert_eq!(
            tool_calls.load(Ordering::SeqCst),
            0,
            "a malformed (Null-input) call must never reach the real tool executor"
        );
        // The synthesized error result must be visible in history so the
        // model sees it and can retry with valid JSON.
        let tool_message = messages
            .iter()
            .find(|m| m.role == MessageRole::Tool)
            .expect("a tool message was appended");
        match &tool_message.tool_results[0].output {
            ToolOutput::Error { message } => assert!(message.contains("malformed")),
            other => panic!("expected a malformed-call error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stuck_loop_aborts_the_turn_cleanly_before_the_step_cap() {
        // Every call returns the identical tool call — well past the
        // default exact-repeat threshold (3) — so loop detection must
        // abort long before EngineConfig::default()'s 200-step cap.
        let repeated = tool_call_result("call_1", "bash");
        let provider = ScriptedProvider {
            id: "scripted".into(),
            script: TokioMutex::new(vec![Ok(repeated)]),
            calls: Arc::new(AtomicU32::new(0)),
        };
        let tool_calls = Arc::new(AtomicU32::new(0));
        let tools = CountingTools {
            calls: tool_calls.clone(),
        };
        let sleeper = NoopSleeper;
        let engine = Engine::with_sleeper(&provider, &tools, EngineConfig::default(), &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("hi"),
        ];
        let mut budget = BudgetGuard::new(BudgetMode::Off, None, None);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let outcome = engine.run_turn(&mut messages, &mut budget, &tx).await;
        match outcome {
            TurnOutcome::Aborted { reason } => assert!(reason.contains("stuck-loop")),
            other => panic!("expected a stuck-loop abort, got {other:?}"),
        }
        // Well under the 200-step cap — loop detection caught it early.
        assert!(tool_calls.load(Ordering::SeqCst) < 10);

        let events = drain_events(&mut rx);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
    }

    #[tokio::test]
    async fn enforced_budget_aborts_the_turn_cleanly_between_steps() {
        let provider = ScriptedProvider {
            id: "scripted".into(),
            script: TokioMutex::new(vec![Ok(tool_call_result("call_1", "bash"))]),
            calls: Arc::new(AtomicU32::new(0)),
        };
        let tools = CountingTools {
            calls: Arc::new(AtomicU32::new(0)),
        };
        let sleeper = NoopSleeper;
        let engine = Engine::with_sleeper(&provider, &tools, EngineConfig::default(), &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("hi"),
        ];
        // Budget of $0.00005 is below a single $0.0001 call's cost, so the
        // very first call's spend trips enforced mode.
        let mut budget = BudgetGuard::new(BudgetMode::Enforced, Some(0.00005), None);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let outcome = engine.run_turn(&mut messages, &mut budget, &tx).await;
        match outcome {
            TurnOutcome::Aborted { reason } => assert!(reason.contains("budget")),
            other => panic!("expected a budget abort, got {other:?}"),
        }
        let events = drain_events(&mut rx);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::BudgetTick { .. }))
        );
    }

    /// Exit criterion (`03-plan.md` Phase 2): "synthetic 200-step turn
    /// (scripted provider incl. 429s, stream drop, context pressure)
    /// survives across three dialects (GLM 5.2, Anthropic, OpenAI
    /// shapes)". "Dialect" at this layer (`stella-core`, which never
    /// touches HTTP/SSE — that's `stella-model`'s job, tested there) means
    /// varying provider *behavior*: call-id conventions, injected 429s
    /// (`RateLimited`), injected transport drops, and steadily growing tool
    /// output that forces repeated compaction — the shapes a real
    /// GLM/Anthropic/OpenAI backend can actually produce at this seam.
    async fn run_synthetic_survival_turn(
        dialect: &str,
        id_style: fn(u32) -> String,
    ) -> TurnOutcome {
        const STEPS: u32 = 200;
        let mut script: Vec<Result<CompletionResultAlias, ProviderError>> = Vec::new();
        for i in 0..STEPS {
            match i % 10 {
                // A 429 that must be retried, not fatal.
                3 => script.push(Err(ProviderError::RateLimited {
                    message: format!("{dialect} rate limited"),
                    retry_after_ms: Some(1),
                })),
                // A transport-level "stream drop" — also retried.
                7 => script.push(Err(ProviderError::Transport(format!(
                    "{dialect} stream drop"
                )))),
                _ => {}
            }
            // Growing tool output simulates context pressure — compaction
            // must keep the turn alive rather than the provider choking on
            // an ever-larger prompt.
            let big_output_call_id = id_style(i);
            script.push(Ok(CompletionResultAlias {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    call_id: big_output_call_id,
                    name: "bash".into(),
                    input: serde_json::json!({"cmd": format!("step {i}")}),
                }],
                usage: CompletionUsage::default(),
                model: format!("{dialect}-model"),
                cost_usd: 0.00001,
            }));
        }
        script.push(Ok(text_result(&format!("{dialect} turn complete"))));

        let provider = ScriptedProvider {
            id: dialect.into(),
            script: TokioMutex::new(script),
            calls: Arc::new(AtomicU32::new(0)),
        };
        // A tool executor whose output grows with each call — the context
        // pressure half of the exit criterion.
        struct GrowingTools;
        #[async_trait]
        impl ToolExecutor for GrowingTools {
            fn schemas(&self) -> Vec<ToolSchema> {
                vec![ToolSchema {
                    name: "bash".into(),
                    description: "run a command".into(),
                    input_schema: serde_json::json!({"type": "object"}),
                }]
            }
            async fn execute(&self, _name: &str, _input: &Value) -> ToolOutput {
                ToolOutput::Ok {
                    content: "x".repeat(600), // consistently "large" per compaction's threshold
                }
            }
        }
        let tools = GrowingTools;
        let sleeper = NoopSleeper;
        let config = EngineConfig {
            // Keep the retry backoff floor at 0 so 200 steps with injected
            // 429s/drops still runs near-instantly under NoopSleeper.
            retry_policy: RetryPolicy::new(3, 0, 0),
            // A tight-ish compaction budget so the growing tool output
            // actually forces multiple compaction passes over 200 steps.
            compaction_budget_tokens: 4_000,
            // 200 tool-call steps plus the final text response is 201 model
            // calls — one more than EngineConfig::default()'s own step cap
            // (200), which exists as an *independent* backstop above loop
            // detection, not a ceiling this test should be fighting.
            max_steps: STEPS as usize + 1,
            ..EngineConfig::default()
        };
        let engine = Engine::with_sleeper(&provider, &tools, config, &sleeper);
        let mut messages = vec![
            CompletionMessage::system("sys"),
            CompletionMessage::user("run the long task"),
        ];
        let mut budget = BudgetGuard::new(BudgetMode::Observed, None, None);
        let (tx, _rx) = mpsc::unbounded_channel();

        engine.run_turn(&mut messages, &mut budget, &tx).await
    }

    #[tokio::test]
    async fn synthetic_200_step_turn_survives_glm_shape() {
        let outcome = run_synthetic_survival_turn("glm", |i| format!("call_{i}")).await;
        assert!(
            matches!(outcome, TurnOutcome::Completed { .. }),
            "GLM-shaped turn must survive 200 steps with injected 429s/drops/context pressure, got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn synthetic_200_step_turn_survives_anthropic_shape() {
        // Anthropic's tool_use ids are its own `toolu_...` convention —
        // varying the id shape alone is enough to prove the driver never
        // assumes anything about call-id format.
        let outcome = run_synthetic_survival_turn("anthropic", |i| format!("toolu_{i:08x}")).await;
        assert!(
            matches!(outcome, TurnOutcome::Completed { .. }),
            "Anthropic-shaped turn must survive 200 steps, got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn synthetic_200_step_turn_survives_openai_shape() {
        let outcome = run_synthetic_survival_turn("openai", |i| format!("call_{i:016x}")).await;
        assert!(
            matches!(outcome, TurnOutcome::Completed { .. }),
            "OpenAI-shaped turn must survive 200 steps, got {outcome:?}"
        );
    }
}
