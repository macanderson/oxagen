//! The agent loop — ties providers, tools, the step-driver, and TUI
//! together.
//!
//! `run_turn` drives `oxagen_core::Engine::run_turn` (the step-driver: one
//! model call per step, retry+backoff, compaction, loop detection, budget
//! checks — see `crates/oxagen-core/src/driver.rs`) and renders its
//! `AgentEvent` stream live via a spawned draining task. This replaces the
//! Phase 0/1 ad-hoc loop that lived here directly (no retry, no
//! compaction, no budget, a flat iteration cap instead of real loop
//! detection) — see `03-plan.md` Phase 2.

use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use colored::Colorize;
use oxagen_core::ports::ToolExecutor;
use oxagen_core::{BudgetGuard, Engine, EngineConfig, TurnOutcome};
use oxagen_mcp::{McpConfig, McpToolSet};
use oxagen_model::credential::ApiKey;
use oxagen_model::provider::Provider;
use oxagen_protocol::event::BudgetMode;
use oxagen_protocol::{AgentEvent, CompletionMessage, ToolOutput};
use oxagen_tools::ToolRegistry;
use oxagen_tools::custom::{self, CustomTool, CustomToolSet};
use tokio::sync::mpsc;

use crate::OutputFormat;
use crate::config::Config;
use crate::domains::{heuristic_domains, infer_domains};
use crate::interactive::{InteractiveToolSet, SkillRegistry, default_ask_io};
use crate::memory::{SessionMemory, inject_recall_block};
use crate::tui;

const SYSTEM_PROMPT: &str = r#"You are Stella, a fast terminal coding agent. You help the user with software engineering tasks by reading files, writing code, running commands, and searching the codebase.

You have these tools available:
- read_file: Read a file with line numbers (supports offset/limit for ranges)
- write_file: Create or overwrite a file (creates parent dirs)
- edit_file: Replace an exact substring in a file (use replace_all for multiple)
- bash: Run a shell command in the workspace root (with timeout)
- grep: Search file contents with regex (shells to ripgrep)
- glob: Find files matching a glob pattern
- ask_user: Ask the user a multiple-choice question when a decision is genuinely theirs to make (2-6 options; the UI always adds a free-text option automatically — never add an "Other" option yourself)
- search_skills: Search the public skills registry for reusable skills you don't have locally
- install_skill: Install a registry skill into the project (always requires the user's confirmation)

Rules:
- Always read a file before editing it — never edit blind.
- Make minimal, surgical edits. Use edit_file, not write_file, for changes to existing files.
- Run tests after making changes to verify they pass.
- Be concise in your responses. Show the user what you changed and why.
- If a task requires multiple steps, work through them systematically.
- When a choice is ambiguous AND getting it wrong would be costly, use ask_user rather than guessing; otherwise proceed with your best judgment."#;

/// Run a one-shot prompt. `budget_limit` is `--budget` (`main.rs`):
/// `Some(n)` enforces a hard per-turn USD cap, `None` meters spend for the
/// cost summary without ever blocking. `format` selects human rendering vs
/// the two headless modes (json / stream-json) — headless runs also get the
/// headless `ask_user` io, which fails the tool with a named error instead
/// of waiting on stdin.
pub async fn run_one_shot(
    cfg: &Config,
    prompt: &str,
    budget_limit: Option<f64>,
    format: OutputFormat,
) -> Result<(), String> {
    let provider = build_provider(cfg)?;
    let registry: std::sync::Arc<dyn ToolExecutor> =
        std::sync::Arc::new(ToolRegistry::new(cfg.workspace_root.clone()));
    let mcp = connect_mcp(cfg, registry.clone(), format == OutputFormat::Text).await;
    let base_tools: &dyn ToolExecutor = match &mcp {
        Some(set) => set,
        None => &*registry,
    };
    let custom_tools = discover_custom_tools(cfg, format == OutputFormat::Text);
    let mut budget = build_budget_guard(budget_limit);

    if format == OutputFormat::Text {
        tui::section_header("Stella");
        println!("  {}\n", prompt.dimmed());
    }

    let mut messages = vec![
        CompletionMessage::system(SYSTEM_PROMPT),
        CompletionMessage::user(prompt),
    ];

    // The self-improvement loop (memory.rs): recall relevant memories +
    // skills into a volatile block after the stable system prefix (L-E8)…
    let mut memory = SessionMemory::open(&cfg.workspace_root, format == OutputFormat::Text);
    if let Some(m) = &memory {
        inject_recall_block(&mut messages, m.recall_block(prompt).await);
    }

    let outcome = run_turn(
        &*provider,
        base_tools,
        &custom_tools,
        &mut messages,
        &mut budget,
        cfg,
        format,
    )
    .await;
    // …and reflect on the completed turn, recording domain-tagged lessons
    // (recurring ones auto-promote to SKILL.md files). Best-effort: never
    // fails or slows the turn that just ran.
    if outcome.is_ok()
        && let Some(m) = &mut memory
    {
        m.reflect_and_record(&*provider, &messages, format != OutputFormat::Text)
            .await;
    }
    if let Some(set) = &mcp {
        set.close_all().await;
    }
    outcome
}

/// Run an interactive REPL session. `budget_limit` is per-session: the
/// `BudgetGuard`'s session-scoped total accumulates across every turn in
/// the conversation, while `BudgetGuard::begin_turn` resets only the
/// turn-scoped counter at the start of each one.
pub async fn run_interactive(cfg: &Config, budget_limit: Option<f64>) -> Result<(), String> {
    let provider = build_provider(cfg)?;
    let registry: std::sync::Arc<dyn ToolExecutor> =
        std::sync::Arc::new(ToolRegistry::new(cfg.workspace_root.clone()));
    let mcp = connect_mcp(cfg, registry.clone(), true).await;
    let base_tools: &dyn ToolExecutor = match &mcp {
        Some(set) => set,
        None => &*registry,
    };
    let custom_tools = discover_custom_tools(cfg, true);
    let mut budget = build_budget_guard(budget_limit);

    tui::welcome_banner(
        cfg.provider.id,
        &cfg.model_id,
        &cfg.workspace_root.display().to_string(),
    );

    let mut messages = vec![CompletionMessage::system(SYSTEM_PROMPT)];
    let mut memory = SessionMemory::open(&cfg.workspace_root, true);

    loop {
        // The rocket-vs-UFO duel animates one line above the prompt while
        // the REPL waits for input (TTY only; STELLA_FUN=0 opts out), and is
        // stopped the moment a line arrives so nothing ever animates while a
        // turn's event stream is printing — see tui.rs's module doc for why
        // that boundary matters.
        let duel = tui::PromptDuel::start();

        print!("{} ", ">".bright_cyan().bold());
        std::io::stdout().flush().map_err(|e| e.to_string())?;

        let mut input = String::new();
        let read = std::io::stdin().read_line(&mut input);
        if let Some(duel) = duel {
            duel.stop();
        }
        match read {
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

        if let Some(m) = &memory {
            let block = m.recall_block(input).await;
            inject_recall_block(&mut messages, block);
        }

        if let Err(e) = run_turn(
            &*provider,
            base_tools,
            &custom_tools,
            &mut messages,
            &mut budget,
            cfg,
            OutputFormat::Text,
        )
        .await
        {
            eprintln!("  {} {}\n", "Error:".red().bold(), e);
        } else if let Some(m) = &mut memory {
            m.reflect_and_record(&*provider, &messages, false).await;
        }
    }

    if let Some(set) = &mcp {
        set.close_all().await;
    }
    println!("\n  {}", "Goodbye! ✦".magenta());
    Ok(())
}

/// `stella init` — infer the workspace's domain taxonomy and write
/// `.oxagen/domains.toml` (see `crate::domains`). Model-assisted when a
/// provider resolves; deterministic directory heuristic otherwise, so init
/// always succeeds — offline included.
pub async fn run_init(
    model_override: Option<&str>,
    api_key_override: Option<&str>,
    base_url_override: Option<&str>,
) -> Result<(), String> {
    let workspace_root =
        std::env::current_dir().map_err(|e| format!("cannot determine workspace root: {e}"))?;

    tui::section_header("Stella init");

    let domains = match Config::load(model_override, api_key_override, base_url_override) {
        Ok(cfg) => {
            let provider = build_provider(&cfg)?;
            println!(
                "  {} inferring domains with {}/{}…",
                "◈".cyan(),
                cfg.provider.id,
                cfg.model_id
            );
            infer_domains(&*provider, &workspace_root).await
        }
        Err(_) => {
            println!(
                "  {} no provider configured — using the directory heuristic \
                 (re-run `stella init` with a key for a better taxonomy)",
                "!".yellow()
            );
            heuristic_domains(&workspace_root)
        }
    };

    let path = domains.save(&workspace_root)?;
    println!(
        "  {} {} domains ({}) → {}",
        "✓".green(),
        domains.domains.len(),
        domains.inferred_by,
        path.display()
    );
    for domain in &domains.domains {
        println!(
            "    {} {} — {} [{}]",
            "·".dimmed(),
            domain.name.bright_blue(),
            domain.description.dimmed(),
            domain.paths.join(", ").dimmed()
        );
    }
    println!(
        "\n  {}",
        "Domains tag memories, reflections, and every code-graph node/edge; recall uses them \
         for relevance."
            .dimmed()
    );
    Ok(())
}

/// Connect the workspace's MCP servers (.oxagen/mcp.toml), wrapping the
/// native registry so their tools merge into the agent's set under
/// mcp__<server>__<tool> names. Absent config -> None (zero overhead).
/// Connection is best-effort per server (oxagen-mcp isolates failures);
/// failed servers are reported once in text mode, never fatal.
async fn connect_mcp(
    cfg: &Config,
    native: std::sync::Arc<dyn ToolExecutor>,
    print_diagnostics: bool,
) -> Option<McpToolSet> {
    let path = cfg.workspace_root.join(".oxagen").join("mcp.toml");
    let text = std::fs::read_to_string(&path).ok()?;
    let parsed = match McpConfig::from_toml_str(&text) {
        Ok(parsed) => parsed,
        Err(e) => {
            if print_diagnostics {
                eprintln!(
                    "  {} {} is invalid: {e} — MCP servers disabled this session",
                    "!".yellow(),
                    path.display()
                );
            }
            return None;
        }
    };
    let servers = parsed.into_servers();
    if servers.is_empty() {
        return None;
    }
    let set = McpToolSet::connect(&servers, std::time::Duration::from_secs(10))
        .await
        .wrapping(native);
    if print_diagnostics {
        for (name, reason) in set.failed_servers() {
            eprintln!(
                "  {} MCP server `{name}` unavailable: {reason}",
                "!".yellow()
            );
        }
        if set.connected_count() > 0 {
            println!(
                "  {} {} MCP server(s) connected",
                "◆".cyan(),
                set.connected_count()
            );
        }
    }
    Some(set)
}

/// Discover developer-defined custom script tools (.oxagen/tools/*.toml,
/// then ~/.config/oxagen/tools/*.toml — workspace wins on collision; see
/// oxagen_tools::custom). Broken manifests never abort a session: their
/// diagnostics print once (text mode) and show up in `stella tools`.
fn discover_custom_tools(cfg: &Config, print_diagnostics: bool) -> Vec<CustomTool> {
    let report = custom::discover(&cfg.workspace_root);
    if print_diagnostics {
        for diagnostic in &report.diagnostics {
            eprintln!(
                "  {} custom tool skipped: {} — {}",
                "!".yellow(),
                diagnostic.path.display(),
                diagnostic.reason
            );
        }
    }
    report.tools
}

/// `stella tools` — list every tool the agent would have this session:
/// native built-ins, developer custom tools (with their source manifests),
/// ask_user, and any discovery diagnostics for broken manifests.
pub fn run_tools_listing() -> Result<(), String> {
    let workspace_root =
        std::env::current_dir().map_err(|e| format!("cannot determine workspace root: {e}"))?;
    tui::section_header("Stella tools");

    let registry = ToolRegistry::new(workspace_root.clone());
    println!("  {}", "built-in:".dimmed());
    let mut native: Vec<String> = oxagen_core::ports::ToolExecutor::schemas(&registry)
        .into_iter()
        .map(|s| s.name)
        .collect();
    native.sort();
    for name in &native {
        println!("    {} {}", "·".dimmed(), name);
    }
    println!(
        "    {} ask_user {}",
        "·".dimmed(),
        "(interactive sessions)".dimmed()
    );

    let report = custom::discover(&workspace_root);
    println!(
        "\n  {}",
        "custom (.oxagen/tools/, ~/.config/oxagen/tools/):".dimmed()
    );
    if report.tools.is_empty() {
        println!(
            "    {}",
            "none — drop a <name>.toml manifest in .oxagen/tools/ to add one".dimmed()
        );
    }
    for tool in &report.tools {
        println!(
            "    {} {} — {}",
            "·".green(),
            tool.name.bright_blue(),
            tool.description.dimmed()
        );
    }
    for diagnostic in &report.diagnostics {
        println!(
            "    {} {} — {}",
            "✗".red(),
            diagnostic.path.display(),
            diagnostic.reason.red()
        );
    }
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

/// Run one full turn through `oxagen_core::Engine`, rendering its
/// `AgentEvent` stream live via a spawned draining task running
/// concurrently with the engine (the channel is unbounded and `send` never
/// blocks, so events reach the renderer as soon as an `.await` point in
/// `run_turn` yields — same live-feeling output the old inline-print loop
/// had, just sourced from the event stream instead of direct calls).
async fn run_turn(
    provider: &dyn Provider,
    base_tools: &dyn ToolExecutor,
    custom_tools: &[CustomTool],
    messages: &mut Vec<CompletionMessage>,
    budget: &mut BudgetGuard,
    cfg: &Config,
    format: OutputFormat,
) -> Result<(), String> {
    budget.begin_turn();
    let turn_start = Instant::now();

    let (tx, mut rx) = mpsc::unbounded_channel::<AgentEvent>();

    let renderer = tokio::spawn(async move {
        // ToolResult only carries call_id, not the tool's name — tracked
        // here so the result card can still show it (see tui::render_event's
        // doc comment for why this pair is handled inline rather than
        // inside that generic dispatcher).
        let mut tool_names: HashMap<String, String> = HashMap::new();
        let mut collected: Vec<AgentEvent> = Vec::new();
        while let Some(event) = rx.recv().await {
            match format {
                OutputFormat::StreamJson => {
                    // One line per event — the stable machine interface
                    // (02-architecture.md §4). Serialization of a protocol
                    // enum never fails; if it somehow does, surface it on
                    // stderr rather than silently dropping the event.
                    match serde_json::to_string(&event) {
                        Ok(line) => println!("{line}"),
                        Err(e) => {
                            eprintln!("{{\"type\":\"error\",\"message\":\"serialize: {e}\"}}")
                        }
                    }
                }
                OutputFormat::Json => collected.push(event),
                OutputFormat::Text => match &event {
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
                },
            }
        }
        collected
    });

    // The tool set holds a tx clone (for AskUser events), so it must drop
    // before the renderer is awaited — the channel only closes once EVERY
    // sender is gone, and awaiting the renderer with a live sender would
    // deadlock. The inner scope makes the drop order structural.
    let outcome = {
        // The tool stack, innermost out: native registry <- developer
        // custom script tools (.oxagen/tools/, oxagen-tools::custom) <-
        // ask_user (interactive.rs). Headless formats get the io that
        // fails ask_user loudly instead of waiting on stdin that will
        // never answer.
        let customs = CustomToolSet::new(
            base_tools,
            custom_tools.to_vec(),
            cfg.workspace_root.clone(),
        );
        let tools = InteractiveToolSet::new(
            &customs,
            tx.clone(),
            default_ask_io(format == OutputFormat::Text),
        )
        .with_skill_registry(SkillRegistry::from_env(cfg.workspace_root.clone()));
        let engine = Engine::new(provider, &tools, EngineConfig::default());
        engine.run_turn(messages, budget, &tx).await
    };
    // Dropping the last sender closes the channel, ending the renderer's
    // `recv()` loop; awaiting it ensures every already-queued event has
    // actually printed before this function returns (no events lost to a
    // detached task racing process exit).
    drop(tx);
    let collected = renderer.await.unwrap_or_default();

    if format == OutputFormat::Json {
        // One final JSON object: the outcome summary plus the full event
        // log (the same objects stream-json would have emitted line by
        // line).
        let (status, text, cost_usd, reason) = match &outcome {
            TurnOutcome::Completed { text, cost_usd } => {
                ("completed", Some(text.clone()), Some(*cost_usd), None)
            }
            TurnOutcome::Aborted { reason } => ("aborted", None, None, Some(reason.clone())),
        };
        let summary = serde_json::json!({
            "status": status,
            "text": text,
            "cost_usd": cost_usd,
            "reason": reason,
            "model": format!("{}/{}", cfg.provider.id, cfg.model_id),
            "events": collected,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).unwrap_or_else(|e| format!(
                "{{\"status\":\"error\",\"reason\":\"serialize: {e}\"}}"
            ))
        );
    }

    match outcome {
        TurnOutcome::Completed { cost_usd, .. } => {
            if format == OutputFormat::Text {
                tui::cost_summary(
                    cost_usd,
                    &format!("{}/{}", cfg.provider.id, cfg.model_id),
                    turn_start.elapsed(),
                );
                println!();
            }
            Ok(())
        }
        TurnOutcome::Aborted { reason } => Err(reason),
    }
}

/// Build the provider adapter from config. Consults the catalog first
/// (provider-scoped, since the same slug legitimately exists on several
/// providers — `gemini-3-pro` on both `gemini` and `vertex`) so an
/// unrecognized model slug is a hard, immediate, named error — never a
/// silent construction of a provider that will simply fail its first live
/// call (`07-model-matrix.md` §3, L-M1/L-M2). The one exemption is `local`:
/// a local server's models are whatever the user pulled into it — there is
/// no curated catalog to check against, and the anti-phantom-slug rule
/// exists to catch drift in OUR seed data, not to veto the user's own
/// endpoint.
///
/// Each wire dialect gets its own arm: OpenAI (Responses API), Anthropic
/// (Messages), Gemini direct + Vertex (generateContent), Bedrock (Converse,
/// SigV4). Everything else — Z.ai, xAI, DeepSeek, OpenRouter, local — is
/// genuinely the same Chat Completions shape behind different base URLs,
/// served by the shared adapter re-identified per provider so its
/// `Provider::id()` and error messages name the surface actually being
/// called (an xAI 401 must never read "Z.ai rejected the API key").
fn build_provider(cfg: &Config) -> Result<Box<dyn Provider>, String> {
    if cfg.provider.id != "local" {
        oxagen_model::catalog::Catalog::seed()
            .resolve_for(cfg.provider.id, &cfg.model_id)
            .map_err(|e| e.to_string())?;
    }

    let api_key = ApiKey::new(cfg.api_key.clone());
    let base_url = cfg.effective_base_url().to_string();

    match cfg.provider.id {
        "openai" => {
            let provider = oxagen_model::openai::OpenAiProvider::new(api_key, cfg.model_id.clone())
                .with_base_url(base_url);
            Ok(Box::new(provider))
        }
        "anthropic" => {
            let provider =
                oxagen_model::anthropic::AnthropicProvider::new(api_key, cfg.model_id.clone())
                    .with_base_url(base_url);
            Ok(Box::new(provider))
        }
        "gemini" => {
            let provider = oxagen_model::gemini::GeminiProvider::new(api_key, cfg.model_id.clone())
                .with_base_url(base_url);
            Ok(Box::new(provider))
        }
        "vertex" => {
            // The access token is cfg.api_key (VERTEX_ACCESS_TOKEN via the
            // credential chain); project and location are Vertex-specific
            // addressing, resolved here with named errors rather than
            // burying a doomed request.
            let project = std::env::var("VERTEX_PROJECT_ID")
                .or_else(|_| std::env::var("GOOGLE_CLOUD_PROJECT"))
                .ok()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    "Vertex AI needs a project id — set VERTEX_PROJECT_ID (or \
                     GOOGLE_CLOUD_PROJECT)"
                        .to_string()
                })?;
            let location = std::env::var("VERTEX_LOCATION")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "global".to_string());
            let mut provider = oxagen_model::vertex::VertexProvider::new(
                api_key,
                cfg.model_id.clone(),
                project,
                location,
            );
            if let Some(override_url) = &cfg.base_url_override {
                provider = provider.with_base_url(override_url.clone());
            }
            Ok(Box::new(provider))
        }
        "bedrock" => {
            // cfg.api_key is AWS_ACCESS_KEY_ID via the credential chain;
            // the rest of the standard AWS env set is read here. Secret
            // resolution failure is a named error pointing at the exact
            // var, not a doomed unsigned request.
            let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
                .ok()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    "Bedrock needs AWS_SECRET_ACCESS_KEY alongside AWS_ACCESS_KEY_ID".to_string()
                })?;
            let session_token = std::env::var("AWS_SESSION_TOKEN")
                .ok()
                .filter(|v| !v.is_empty())
                .map(ApiKey::new);
            let region = std::env::var("AWS_REGION")
                .or_else(|_| std::env::var("AWS_DEFAULT_REGION"))
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "us-east-1".to_string());
            let mut provider = oxagen_model::bedrock::BedrockProvider::new(
                api_key,
                ApiKey::new(secret),
                session_token,
                region,
                cfg.model_id.clone(),
            );
            if let Some(override_url) = &cfg.base_url_override {
                provider = provider.with_base_url(override_url.clone());
            }
            Ok(Box::new(provider))
        }
        // Z.ai, xAI, DeepSeek, OpenRouter, local — the shared Chat
        // Completions adapter, re-identified per provider.
        other => {
            let label = match other {
                "zai" => "Z.ai",
                "xai" => "xAI",
                "deepseek" => "DeepSeek",
                "openrouter" => "OpenRouter",
                "local" => "the local endpoint",
                _ => cfg.provider.display_name,
            };
            let provider = oxagen_model::zai::ZaiProvider::new(api_key, cfg.model_id.clone())
                .with_base_url(base_url)
                .with_identity(other, label);
            Ok(Box::new(provider))
        }
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
