//! The event vocabulary — plain enum variants flowing from `oxagen-core` to
//! whichever renderer (TUI or the JSON serializer) is listening.
//! `--output-format stream-json` is a `serde_json` serialization of this
//! exact enum, one line per event: a stable, versioned machine interface
//! (`docs/specs/oxagen-rust-cli/02-architecture.md` §4).
//!
//! This is deliberately a *subset* at Phase 0 (only what a bare
//! provider-streaming spike needs); later phases append variants as the
//! context/media/fleet crates land — additive only, never a breaking
//! rename, once this ships past Phase 0.

use serde::{Deserialize, Serialize};

use crate::tool::{ToolCall, ToolOutput};

/// A named point in the turn's data flow
/// (`docs/specs/oxagen-rust-cli/02-architecture.md` §5). Exactly one stage
/// vocabulary exists in this workspace — never duplicated per-crate (the
/// TS-era `StageKind` duplication this structurally forbids, L-E1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageKind {
    Triage,
    ContextRecall,
    Plan,
    ScopeReview,
    Execute,
    Verify,
    Judge,
    ContextWrite,
    Complete,
}

/// One event in the turn's stream. Every stage boundary emits an event;
/// nothing user-visible is derived from internal state that isn't also in
/// this stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Stage {
        name: StageKind,
    },
    Text {
        delta: String,
    },
    Reasoning {
        delta: String,
    },
    ToolStart {
        call: ToolCall,
    },
    ToolResult {
        call_id: String,
        output: ToolOutput,
        duration_ms: u64,
    },
    Retry {
        attempt: u32,
        reason: String,
    },
    Error {
        message: String,
        retryable: bool,
    },
    Complete {
        model: String,
        cost_usd: f64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_event_roundtrips_with_type_tag() {
        let event = AgentEvent::ToolStart {
            call: ToolCall {
                call_id: "call_1".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "path": "src/main.rs" }),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"tool_start\""), "{json}");
        let back: AgentEvent = serde_json::from_str(&json).unwrap();
        match back {
            AgentEvent::ToolStart { call } => assert_eq!(call.name, "read_file"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn stream_json_is_one_line_per_event() {
        let events = [
            AgentEvent::Stage {
                name: StageKind::Triage,
            },
            AgentEvent::Text { delta: "hi".into() },
            AgentEvent::Complete {
                model: "glm-5.2".into(),
                cost_usd: 0.001,
            },
        ];
        let lines: Vec<String> = events
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        for line in &lines {
            assert!(!line.contains('\n'));
        }
    }
}
