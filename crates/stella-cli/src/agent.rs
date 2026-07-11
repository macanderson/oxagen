//! The agent loop — ties providers, tools, the step-driver, and TUI
//! together.
//!
//! `run_turn` drives `stella_core::Engine::run_turn` (the step-driver: one
//! model call per step, retry+backoff, compaction, loop detection, budget
//! checks — see `crates/stella-core/src/driver.rs`) and renders its
//! `AgentEvent` stream live via a spawned draining task. This replaces the
//! Phase 0/1 ad-hoc loop that lived here directly (no retry, no
//! compaction, no budget, a flat iteration cap instead of real loop
//! detection) — see `03-plan.md` Phase 2.

use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use colored::Colorize;
use stella_core::{BudgetGuard, Engine, EngineConfig, TurnOutcome};
use stella_model::credential::ApiKey;
use stella_model::provider::Provider;
use stella_protocol::event::BudgetMode;
use stella_protocol::{AgentEvent, CompletionMessage, ToolOutput};
use stella_tools::ToolRegistry;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::tui;

const SYSTEM_PROMPT: &str = r#"You are Stella, a fast terminal coding agent. You help the user with software engineering tasks by reading files, writing code, running commands, and searching the codebase.

You have these tools available:
- read_file: Read a file with line numbers (supports offset/limit for ranges)
- write_file: Create or overwrite a file (creates parent dirs)
- edit_file: Replace an exact substring in a file (use replace_all for multiple)
- bash: Run a shell command in the workspace root (with timeout)
- grep: Search file contents with regex (shells to ripgrep)
- glob: Find files matching a glob pattern

Rules:
- Always read a file before editing it — never edit blind.
- Make minimal, surgical edits. Use edit_file, not write_file, for changes to existing files.
- Run tests after making changes to verify they pass.
- Be concise in your responses. Show the user what you changed and why.
- If a task requires multiple steps, work through them systematically."#;

/// Run a one-shot prompt (non-interactive). `budget_limit` is `--budget`
/// (`main.rs`): `Some(n)` enforces a hard per-turn USD cap, `None` meters
/// spend for the cost summary without ever blocking.
pub async fn run_one_shot(
    cfg: &Config,
    prompt: &str,
    budget_limit: Option<f64>,
) -> Result<(), String> {
    let provider = build_provider(cfg)?;
    let registry = ToolRegistry::new(cfg.workspace_root.clone());
    let mut budget = build_budget_guard(budget_limit);

    tui::section_header("Stella");
    println!("  {}\n", prompt.dimmed());

    let mut messages = vec![
        CompletionMessage::system(SYSTEM_PROMPT),
        CompletionMessage::user(prompt),
    ];

    run_turn(&*provider, &registry, &mut messages, &mut budget, cfg).await
}

/// Run an interactive REPL session. `budget_limit` is per-session: the
/// `BudgetGuard`'s session-scoped total accumulates across every turn in
/// the conversation, while `BudgetGuard::begin_turn` resets only the
/// turn-scoped counter at the start of each one.
pub async fn run_interactive(cfg: &Config, budget_limit: Option<f64>) -> Result<(), String> {
    let provider = build_provider(cfg)?;
    let registry = ToolRegistry::new(cfg.workspace_root.clone());
    let mut budget = build_budget_guard(budget_limit);

    tui::welcome_banner(
        cfg.provider.id,
        &cfg.model_id,
        &cfg.workspace_root.display().to_string(),
    );

    let mut messages = vec![CompletionMessage::system(SYSTEM_PROMPT)];

    loop {
        // Read user input
        print!("{} ", ">".bright_cyan().bold());
        std::io::stdout().flush().map_err(|e| e.to_string())?;

        let mut input = String::new();
        match std::io::stdin().read_line(&mut input) {
            Ok(0) => break, // EOF (Ctrl+D)
            Ok(_) => {}
            Err(e) => return Err(format!("read error: {e}")),
        }

        let input = input.trim();
        if input.is_empty() {
            continue;
        }
        if input == "/exit" || input == "/quit" || input == "exit" {
            break;
        }
        if input == "/models" {
            cfg.print_models();
            continue;
        }
        if input == "/config" {
            cfg.print_config();
            continue;
        }
        if input == "/help" {
            print_help();
            continue;
        }
        if input == "/clear" {
            messages = vec![CompletionMessage::system(SYSTEM_PROMPT)];
            println!("  {}\n", "conversation cleared".dimmed());
            continue;
        }

        messages.push(CompletionMessage::user(input));
        println!();

        if let Err(e) = run_turn(&*provider, &registry, &mut messages, &mut budget, cfg).await {
            eprintln!("  {} {}\n", "Error:".red().bold(), e);
        }
    }

    println!("\n  {}", "Goodbye! ✦".magenta());
    Ok(())
}

/// Construct the turn/session budget guard from `--budget`. No limit at
/// all still meters spend (`BudgetMode::Observed`) so the cost summary and
/// `BudgetTick` events stay meaningful even when nothing is enforced.
fn build_budget_guard(budget_limit: Option<f64>) -> BudgetGuard {
    match budget_limit {
        Some(limit) => BudgetGuard::new(BudgetMode::Enforced, Some(limit), None),
        None => BudgetGuard::new(BudgetMode::Observed, None, None),
    }
}

/// Run one full turn through `stella_core::Engine`, rendering its
/// `AgentEvent` stream live via a spawned draining task running
/// concurrently with the engine (the channel is unbounded and `send` never
/// blocks, so events reach the renderer as soon as an `.await` point in
/// `run_turn` yields — same live-feeling output the old inline-print loop
/// had, just sourced from the event stream instead of direct calls).
async fn run_turn(
    provider: &dyn Provider,
    registry: &ToolRegistry,
    messages: &mut Vec<CompletionMessage>,
    budget: &mut BudgetGuard,
    cfg: &Config,
) -> Result<(), String> {
    budget.begin_turn();
    let turn_start = Instant::now();

    let engine = Engine::new(provider, registry, EngineConfig::default());
    let (tx, mut rx) = mpsc::unbounded_channel::<AgentEvent>();

    let renderer = tokio::spawn(async move {
        // ToolResult only carries call_id, not the tool's name — tracked
        // here so the result card can still show it (see tui::render_event's
        // doc comment for why this pair is handled inline rather than
        // inside that generic dispatcher).
        let mut tool_names: HashMap<String, String> = HashMap::new();
        while let Some(event) = rx.recv().await {
            match &event {
                AgentEvent::ToolStart { call } => {
                    tool_names.insert(call.call_id.clone(), call.name.clone());
                    tui::tool_call_card(&call.name, &call.input, "running");
                }
                AgentEvent::ToolResult {
                    call_id,
                    output,
                    duration_ms,
                } => {
                    let name = tool_names
                        .get(call_id)
                        .map(String::as_str)
                        .unwrap_or("tool");
                    let content = match output {
                        ToolOutput::Ok { content } => content.clone(),
                        ToolOutput::Error { message } => message.clone(),
                    };
                    tui::tool_result_card(
                        name,
                        &content,
                        output.is_error(),
                        Duration::from_millis(*duration_ms),
                    );
                }
                other => tui::render_event(other),
            }
        }
    });

    let outcome = engine.run_turn(messages, budget, &tx).await;
    // Dropping the sender closes the channel, ending the renderer's
    // `recv()` loop; awaiting it ensures every already-queued event has
    // actually printed before this function returns (no events lost to a
    // detached task racing process exit).
    drop(tx);
    let _ = renderer.await;

    match outcome {
        TurnOutcome::Completed { cost_usd, .. } => {
            tui::cost_summary(
                cost_usd,
                &format!("{}/{}", cfg.provider.id, cfg.model_id),
                turn_start.elapsed(),
            );
            println!();
            Ok(())
        }
        TurnOutcome::Aborted { reason } => Err(reason),
    }
}

/// Build the provider adapter from config. Consults the catalog first so an
/// unrecognized model slug is a hard, immediate, named error — never a
/// silent construction of a provider that will simply fail its first live
/// call (`07-model-matrix.md` §3, L-M1/L-M2: this hard-error rule existed in
/// `stella_model::catalog` since Phase 0 but was never actually called from
/// the request path, so it was unenforced in practice).
///
/// OpenAI gets its own arm ahead of the `openai_compatible` bool: real
/// OpenAI speaks the Responses API (`stella_model::openai`), a wire shape
/// (and tool-call dialect, see `catalog.rs`'s `ToolDialect::OpenaiResponses`)
/// genuinely distinct from the Chat Completions shape every other
/// `openai_compatible` row (Z.ai, xAI, DeepSeek, Gemini's OpenAI-compat
/// shim, OpenRouter) actually speaks — see `openai.rs`'s module doc for why
/// reusing `ZaiProvider` for OpenAI was wrong even though it happened to
/// work.
fn build_provider(cfg: &Config) -> Result<Box<dyn Provider>, String> {
    stella_model::catalog::Catalog::seed()
        .resolve(&cfg.model_id)
        .map_err(|e| e.to_string())?;

    let api_key = ApiKey::new(cfg.api_key.clone());

    if cfg.provider.id == "openai" {
        let provider = stella_model::openai::OpenAiProvider::new(api_key, cfg.model_id.clone())
            .with_base_url(cfg.provider.base_url.to_string());
        Ok(Box::new(provider))
    } else if cfg.provider.openai_compatible {
        // Z.ai, xAI, DeepSeek, Gemini (OpenAI-compat shim), OpenRouter all
        // use the same Chat Completions adapter shape — only the base URL
        // differs.
        let provider = stella_model::zai::ZaiProvider::new(api_key, cfg.model_id.clone())
            .with_base_url(cfg.provider.base_url.to_string());
        Ok(Box::new(provider))
    } else {
        // Anthropic Messages API
        let provider =
            stella_model::anthropic::AnthropicProvider::new(api_key, cfg.model_id.clone())
                .with_base_url(cfg.provider.base_url.to_string());
        Ok(Box::new(provider))
    }
}

fn print_help() {
    println!("  {}\n", "Stella Commands".cyan().bold());
    println!("  {}  Send a prompt to the agent", "type message".dimmed());
    println!(
        "  {}       List configured providers and models",
        "/models".bright_blue()
    );
    println!(
        "  {}        Show current configuration",
        "/config".bright_blue()
    );
    println!(
        "  {}         Clear conversation history",
        "/clear".bright_blue()
    );
    println!("  {}          Show this help", "/help".bright_blue());
    println!("  {}          Exit Stella", "/exit".bright_blue());
    println!("  {}         Exit Stella", "Ctrl+D".dimmed());
    println!();
}
