//! Terminal UI — streaming text, tool-call cards, cost tracking.
//!
//! Designed for speed and engagement: tool calls appear as cards with
//! status, and the model's response prints as soon as it's ready.
//!
//! `render_event` is the TUI's one entry point onto `oxagen_core::Engine`'s
//! event stream (`02-architecture.md` §4, L-T1: the TUI renders exclusively
//! from `AgentEvent`s — no panel owns state that isn't reconstructible by
//! replaying the event log). It's deliberately a thin dispatcher onto the
//! existing per-kind print helpers below, not a rewrite of them.
//!
//! There is deliberately no animated "thinking" spinner: the Phase 0/1
//! version had one, but it only ticked a fixed 3 frames *before* dispatching
//! the network call, then froze for the entire real wait — a decorative
//! pre-roll, not a live indicator. A correct live spinner would need its own
//! concurrent task racing the event-draining task below, both writing to the
//! terminal — real interleaving risk for a cosmetic win. `Stage::Execute`
//! below gives one clean, immediate "thinking" line instead.

use std::io::{self, Write};
use std::time::Duration;

use colored::Colorize;
use oxagen_protocol::AgentEvent;

/// Print a tool-call card: name, input summary, status.
pub fn tool_call_card(name: &str, input: &serde_json::Value, status: &str) {
    let icon = match status {
        "running" => "▶".cyan(),
        "ok" => "✓".green(),
        "error" => "✗".red(),
        _ => "·".dimmed(),
    };
    let input_str = if input.is_object() {
        // Show key fields compactly
        if let Some(obj) = input.as_object() {
            let summary: Vec<String> = obj
                .iter()
                .take(3)
                .map(|(k, v)| {
                    let val_str = if let Some(s) = v.as_str() {
                        if s.len() > 60 {
                            format!("{}…", &s[..57])
                        } else {
                            s.to_string()
                        }
                    } else {
                        v.to_string()
                    };
                    format!("{}={}", k.bright_blue(), val_str)
                })
                .collect();
            summary.join(" ")
        } else {
            input.to_string()
        }
    } else {
        input.to_string()
    };

    println!(
        "  {} {}({})",
        icon,
        name.bright_yellow(),
        input_str.dimmed()
    );
}

/// Print a tool result summary.
pub fn tool_result_card(_name: &str, output: &str, is_error: bool, duration: Duration) {
    let icon = if is_error { "✗".red() } else { "✓".green() };
    let label = if is_error {
        "error".red()
    } else {
        "ok".green()
    };
    let preview = output.lines().next().unwrap_or("(empty)");
    let preview = if preview.len() > 80 {
        format!("{}…", &preview[..77])
    } else {
        preview.to_string()
    };
    println!(
        "    {} {} in {:.0}ms — {}",
        icon,
        label,
        duration.as_secs_f64() * 1000.0,
        preview.dimmed()
    );
}

/// Print streaming text delta (no newline — accumulates on one line).
#[allow(dead_code)]
pub fn print_delta(text: &str) {
    print!("{}", text);
    let _ = io::stdout().flush();
}

/// Print a section header.
pub fn section_header(title: &str) {
    println!("\n{} {}", "─".dimmed().repeat(3), title.cyan().bold());
}

/// Print the assistant's complete response (after streaming).
pub fn assistant_response(text: &str) {
    if !text.is_empty() {
        println!("\n{}", text);
    }
}

/// Print a cost summary for a turn. `AgentEvent::Complete` (the source of
/// this data under `oxagen_core::Engine`) carries `model`/`cost_usd` only —
/// no per-turn token breakdown, unlike the old ad-hoc loop's manual
/// accumulation — so this is deliberately narrower than the Phase 0/1
/// version. Real per-role token/cost accounting lives in `BudgetTick`
/// (`render_event` below), which fires after every call, not just at
/// turn-end.
pub fn cost_summary(cost_usd: f64, model: &str, elapsed: Duration) {
    println!(
        "\n  {} {} · ${cost_usd:.4} · {:.1}s",
        "◆".dimmed(),
        model.bright_blue(),
        elapsed.as_secs_f64(),
    );
}

/// Print the welcome banner.
pub fn welcome_banner(provider: &str, model: &str, workspace: &str) {
    let stella = r#"
   ____  _     _     _ __        __
  / ___|| |__ (_)___| |\ \      / /_ _ _ __ ___
  \___ \| '_ \| / __| __\ \ /\ / / _` | '__/ _ \
   ___) | | | | \__ \ |_ \ V  V / (_| | | |  __/
  |____/|_| |_|_|___/_|__\_/\_/ \__,_|_|  \___|
"#;
    println!("{}", stella.bright_magenta());
    println!(
        "  {} {} · {} · {}",
        "◆".cyan(),
        format!("{provider}/{model}").bright_blue(),
        workspace.dimmed(),
        "type your prompt, Ctrl+D to exit".dimmed(),
    );
    println!("  {}\n", "─".repeat(60).dimmed());
}

/// Render one `AgentEvent` from `oxagen_core::Engine::run_turn`'s stream.
/// `ToolStart`/`ToolResult` are intentionally a no-op here: `ToolResult`
/// doesn't carry the tool's name (only `call_id`), so the call site keeps a
/// small `call_id -> name` map and calls `tool_call_card`/`tool_result_card`
/// directly instead of routing those two through this function — see
/// `agent.rs`'s event-draining task. Every other event kind (including
/// `Text` — the engine emits one per step, not just at turn-end, since a
/// step with tool calls can still carry commentary text) is rendered here.
pub fn render_event(event: &AgentEvent) {
    match event {
        AgentEvent::Stage {
            name: oxagen_protocol::StageKind::Execute,
        } => {
            println!("  {}", "thinking…".dimmed());
        }
        AgentEvent::Stage { .. } | AgentEvent::ToolStart { .. } | AgentEvent::ToolResult { .. } => {
            // Complete-stage and ToolStart/ToolResult: handled inline at the
            // call site or by a more specific event (see the module doc).
        }
        AgentEvent::Text { delta } => assistant_response(delta),
        AgentEvent::Reasoning { .. } => {}
        AgentEvent::Retry { attempt, reason } => {
            println!("  {} retry #{attempt}: {}", "↻".yellow(), reason.dimmed());
        }
        AgentEvent::Compaction {
            before_tokens,
            after_tokens,
            evicted,
            deduped,
        } => {
            println!(
                "  {} compacted context: {before_tokens} → {after_tokens} tokens ({evicted} evicted, {deduped} deduped)",
                "⤵".cyan(),
            );
        }
        AgentEvent::BudgetTick {
            spent_usd,
            limit_usd,
            mode,
        } => {
            if matches!(mode, oxagen_protocol::BudgetMode::Off) {
                return;
            }
            match limit_usd {
                Some(limit) => println!("  {} spend: ${spent_usd:.4} / ${limit:.2}", "$".dimmed()),
                None => println!("  {} spend: ${spent_usd:.4}", "$".dimmed()),
            }
        }
        AgentEvent::ProviderFallback { from, to, reason } => {
            println!(
                "  {} provider fallback {} → {}: {}",
                "⚠".yellow().bold(),
                from.bright_yellow(),
                to.bright_green(),
                reason.dimmed()
            );
        }
        AgentEvent::FileChange { path, kind, .. } => {
            let verb = match kind {
                oxagen_protocol::FileChangeKind::Created => "created",
                oxagen_protocol::FileChangeKind::Modified => "modified",
                oxagen_protocol::FileChangeKind::Deleted => "deleted",
            };
            println!("  {} {} {}", "±".cyan(), verb.dimmed(), path);
        }
        AgentEvent::ContextRecall {
            frames,
            provider_mix,
            tokens,
        } => {
            let mix = provider_mix
                .iter()
                .map(|share| format!("{}×{}", share.frames, share.provider))
                .collect::<Vec<_>>()
                .join(", ");
            println!(
                "  {} recalled {} frames ({tokens} tokens: {mix})",
                "◈".cyan(),
                frames.len()
            );
        }
        AgentEvent::ContextWrite {
            provider,
            upserts,
            superseded,
        } => {
            println!(
                "  {} context write-back via {provider}: {upserts} upserts, {superseded} superseded",
                "◈".dimmed()
            );
        }
        AgentEvent::MediaProgress {
            artifact_id,
            kind,
            state,
        } => {
            let state_str = match state {
                oxagen_protocol::MediaJobState::Queued => "queued".dimmed(),
                oxagen_protocol::MediaJobState::Running => "running".cyan(),
                oxagen_protocol::MediaJobState::Succeeded => "succeeded".green(),
                oxagen_protocol::MediaJobState::Failed { reason } => {
                    println!(
                        "  {} {kind:?} job {artifact_id} failed: {reason}",
                        "✗".red()
                    );
                    return;
                }
            };
            println!("  {} {kind:?} job {artifact_id}: {state_str}", "▣".cyan());
        }
        AgentEvent::MediaComplete { artifact } => {
            println!(
                "  {} {} ready: {} ({})",
                "▣".green(),
                artifact.label,
                artifact.path,
                format!("{:?}", artifact.kind).to_lowercase()
            );
        }
        AgentEvent::JudgeVerdict { passed, evidence } => {
            let icon = if *passed { "✓".green() } else { "✗".red() };
            let source = if evidence.deterministic {
                "deterministic"
            } else {
                "model judge"
            };
            println!("  {icon} verify ({source}): {}", evidence.summary.dimmed());
        }
        AgentEvent::ScopeReview { proposal } => {
            println!(
                "  {} scope review: {} ({} steps, ~{} files{})",
                "⌾".yellow().bold(),
                proposal.summary,
                proposal.steps.len(),
                proposal.estimated_files,
                proposal
                    .estimated_cost_usd
                    .map(|c| format!(", ~${c:.2}"))
                    .unwrap_or_default()
            );
        }
        AgentEvent::AskUser {
            question, options, ..
        } => {
            // The interactive ask_user tool prints the numbered options and
            // collects the answer itself (it owns stdin while the turn is
            // in flight); this render arm exists for replay/stream-json
            // consumers of the event log. The binding free-text contract
            // (every question always offers a type-your-own option) is
            // enforced at the prompt site, not here.
            println!("  {} {}", "?".yellow().bold(), question.bold());
            for (i, option) in options.iter().enumerate() {
                println!("    {} {}", format!("{})", i + 1).dimmed(), option);
            }
        }
        AgentEvent::Commit { sha, message } => {
            let short = sha.get(..8).unwrap_or(sha.as_str());
            println!("  {} committed {short} {}", "●".green(), message.dimmed());
        }
        AgentEvent::Pr { url, status } => {
            println!(
                "  {} PR {}: {url}",
                "⇡".cyan(),
                format!("{status:?}").to_lowercase()
            );
        }
        AgentEvent::Error { message, retryable } => {
            let label = if *retryable { "warning" } else { "error" };
            eprintln!("  {} {}: {}", "✗".red(), label.red().bold(), message);
        }
        AgentEvent::Complete { .. } => {
            // The call site prints `cost_summary` from `TurnOutcome`
            // directly (it has the same model/cost_usd this event carries,
            // plus wall-clock elapsed time this event doesn't).
        }
    }
}
