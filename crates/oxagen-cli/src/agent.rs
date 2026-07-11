//! The agent loop — ties providers, tools, and TUI together.
//!
//! Flow per turn:
//! 1. Build messages (system prompt + conversation history + user prompt)
//! 2. Call provider.complete() with tool schemas
//! 3. If the model returned tool calls, execute them, feed results back,
//!    and loop (up to a max-iterations cap)
//! 4. If the model returned text, stream it to the user and done
//!
//! This is the Phase 0/1 simplified loop — the full step-driver with
//! triage/plan/judge stages, compaction, and budget eviction is Phase 2+
//! per 03-plan.md.

use std::io::Write;
use std::time::Instant;

use colored::Colorize;
use oxagen_model::credential::ApiKey;
use oxagen_model::provider::Provider;
use oxagen_protocol::{CompletionMessage, CompletionRequest, MessageRole, ToolOutput, ToolResult};
use oxagen_tools::ToolRegistry;

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

const MAX_TOOL_ITERATIONS: usize = 20;

/// Run a one-shot prompt (non-interactive).
pub async fn run_one_shot(cfg: &Config, prompt: &str) -> Result<(), String> {
    let provider = build_provider(cfg)?;
    let registry = ToolRegistry::new(cfg.workspace_root.clone());

    tui::section_header("Stella");
    println!("  {}\n", prompt.dimmed());

    let mut messages = vec![
        CompletionMessage::system(SYSTEM_PROMPT),
        CompletionMessage::user(prompt),
    ];

    run_turn(&*provider, &registry, &mut messages, cfg).await
}

/// Run an interactive REPL session.
pub async fn run_interactive(cfg: &Config) -> Result<(), String> {
    let provider = build_provider(cfg)?;
    let registry = ToolRegistry::new(cfg.workspace_root.clone());

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

        if let Err(e) = run_turn(&*provider, &registry, &mut messages, cfg).await {
            eprintln!("  {} {}\n", "Error:".red().bold(), e);
        }
    }

    println!("\n  {}", "Goodbye! ✦".magenta());
    Ok(())
}

/// Run one full turn: model call → tool execution → loop until text response.
async fn run_turn(
    provider: &dyn Provider,
    registry: &ToolRegistry,
    messages: &mut Vec<CompletionMessage>,
    cfg: &Config,
) -> Result<(), String> {
    let tools = registry.schemas();
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cost = 0.0f64;
    let turn_start = Instant::now();

    for iteration in 0..MAX_TOOL_ITERATIONS {
        let spinner = tui::Spinner::new(if iteration == 0 {
            "thinking".to_string()
        } else {
            format!("thinking (step {})", iteration + 1)
        });

        // Animate spinner briefly while waiting
        let spinner_handle = {
            let spinner = spinner;
            for i in 0..3 {
                spinner.tick(i);
                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            }
            spinner
        };

        let req = CompletionRequest {
            messages: messages.clone(),
            max_output_tokens: Some(8192),
            temperature: Some(0.0),
            effort: None,
            tools: tools.clone(),
        };

        let result = provider.complete(req).await.map_err(|e| e.to_string())?;
        drop(spinner_handle);

        total_input += result.usage.input_tokens;
        total_output += result.usage.output_tokens;
        total_cost += result.cost_usd;

        // If the model returned tool calls, execute them
        if !result.tool_calls.is_empty() {
            // Add the assistant's message (with tool calls) to history
            messages.push(CompletionMessage {
                role: MessageRole::Assistant,
                content: result.text.clone(),
                tool_calls: result.tool_calls.clone(),
                tool_results: vec![],
            });

            // Execute each tool call
            let mut tool_results = Vec::new();
            for call in &result.tool_calls {
                tui::tool_call_card(&call.name, &call.input, "running");

                let tool_start = Instant::now();
                let output = registry.execute(&call.name, &call.input).await;
                let duration = tool_start.elapsed();

                let output_str = match &output {
                    ToolOutput::Ok { content } => content.clone(),
                    ToolOutput::Error { message } => message.clone(),
                };
                tui::tool_result_card(&call.name, &output_str, output.is_error(), duration);

                tool_results.push(ToolResult {
                    call_id: call.call_id.clone(),
                    output,
                });
            }

            // Feed tool results back as a tool message
            let tool_message = CompletionMessage {
                role: MessageRole::Tool,
                content: String::new(),
                tool_calls: vec![],
                tool_results,
            };
            messages.push(tool_message);

            // If the model also produced text, show it
            if !result.text.is_empty() {
                tui::assistant_response(&result.text);
            }

            continue; // Loop back for the next model call
        }

        // No tool calls — this is the final text response
        tui::assistant_response(&result.text);

        // Add the assistant response to history
        messages.push(CompletionMessage {
            role: MessageRole::Assistant,
            content: result.text.clone(),
            tool_calls: vec![],
            tool_results: vec![],
        });

        // Print cost summary
        tui::cost_summary(
            total_input,
            total_output,
            total_cost,
            &format!("{}/{}", cfg.provider.id, cfg.model_id),
        );
        let elapsed = turn_start.elapsed();
        println!(
            "  {} turn completed in {:.1}s\n",
            "◆".dimmed(),
            elapsed.as_secs_f64()
        );

        return Ok(());
    }

    eprintln!(
        "  {} reached max tool iterations ({}) — stopping",
        "!".yellow().bold(),
        MAX_TOOL_ITERATIONS
    );
    Ok(())
}

/// Build the provider adapter from config. Consults the catalog first so an
/// unrecognized model slug is a hard, immediate, named error — never a
/// silent construction of a provider that will simply fail its first live
/// call (`07-model-matrix.md` §3, L-M1/L-M2: this hard-error rule existed in
/// `oxagen_model::catalog` since Phase 0 but was never actually called from
/// the request path, so it was unenforced in practice).
///
/// OpenAI gets its own arm ahead of the `openai_compatible` bool: real
/// OpenAI speaks the Responses API (`oxagen_model::openai`), a wire shape
/// (and tool-call dialect, see `catalog.rs`'s `ToolDialect::OpenaiResponses`)
/// genuinely distinct from the Chat Completions shape every other
/// `openai_compatible` row (Z.ai, xAI, DeepSeek, Gemini's OpenAI-compat
/// shim, OpenRouter) actually speaks — see `openai.rs`'s module doc for why
/// reusing `ZaiProvider` for OpenAI was wrong even though it happened to
/// work.
fn build_provider(cfg: &Config) -> Result<Box<dyn Provider>, String> {
    oxagen_model::catalog::Catalog::seed()
        .resolve(&cfg.model_id)
        .map_err(|e| e.to_string())?;

    let api_key = ApiKey::new(cfg.api_key.clone());

    if cfg.provider.id == "openai" {
        let provider = oxagen_model::openai::OpenAiProvider::new(api_key, cfg.model_id.clone())
            .with_base_url(cfg.provider.base_url.to_string());
        Ok(Box::new(provider))
    } else if cfg.provider.openai_compatible {
        // Z.ai, xAI, DeepSeek, Gemini (OpenAI-compat shim), OpenRouter all
        // use the same Chat Completions adapter shape — only the base URL
        // differs.
        let provider = oxagen_model::zai::ZaiProvider::new(api_key, cfg.model_id.clone())
            .with_base_url(cfg.provider.base_url.to_string());
        Ok(Box::new(provider))
    } else {
        // Anthropic Messages API
        let provider =
            oxagen_model::anthropic::AnthropicProvider::new(api_key, cfg.model_id.clone())
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
