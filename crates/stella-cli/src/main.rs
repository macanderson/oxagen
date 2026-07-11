//! `stella` — a fast, BYOK, model-agnostic terminal coding agent.
//!
//! Built on the `stella-*` crate stack: `stella-model` for provider
//! abstraction (Z.ai/GLM 5.2, Anthropic, OpenAI, xAI, DeepSeek, Gemini —
//! any OpenAI-compatible endpoint), `stella-tools` for the built-in tool
//! set, and `stella-protocol` for the shared types.
//!
//! Design goals (per docs/specs/oxagen-rust-cli/01-product-spec.md):
//! - No phone-home requirement — works with zero network calls other than
//!   the user's configured model provider.
//! - BYOK: any provider key, any combination, no account.
//! - Speed: streaming first, prompt-cache-aware system prefix, minimal
//!   overhead between model turns.
//! - Engaging TUI: live spinner, streaming text, tool-call cards, cost
//!   tracking.

mod agent;
mod config;
mod tui;

use std::process::ExitCode;

use clap::{Parser, Subcommand};
use colored::Colorize;

#[derive(Parser)]
#[command(
    name = "stella",
    version,
    about = "A fast, BYOK, model-agnostic terminal coding agent"
)]
struct Cli {
    /// Override the worker model for this invocation: provider/model_id
    /// (e.g. zai/glm-5.2, anthropic/claude-fable-5, openai/gpt-5.5)
    #[arg(long, env = "STELLA_MODEL")]
    model: Option<String>,

    /// API key for the selected provider, highest-precedence step of the
    /// credential chain (CLI flag -> env var -> credentials file ->
    /// interactive prompt, 01-product-spec.md §4). Prefer an env var or
    /// ~/.config/stella/credentials.toml for anything long-lived — a flag
    /// value is visible in shell history and `ps`.
    #[arg(long)]
    api_key: Option<String>,

    /// Output format: text (default, interactive) or json (headless)
    #[arg(long, env = "STELLA_OUTPUT_FORMAT", default_value = "text")]
    output_format: String,

    /// Hard per-turn USD spend limit — enforced mode (07-model-matrix.md
    /// §6): the turn aborts cleanly (never mid-tool) once spend exceeds
    /// this. Omit to meter spend for the cost summary without ever
    /// blocking (observed mode).
    #[arg(long, env = "STELLA_BUDGET")]
    budget: Option<f64>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Send a one-shot prompt (non-interactive)
    Run {
        /// The prompt to send
        prompt: String,
    },

    /// Start an interactive REPL session
    Chat,

    /// List configured providers and available models
    Models,

    /// Show current configuration
    Config,

    /// Print the version and exit
    Version,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{} {}", "stella:".red().bold(), e);
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    // Models and Version don't need a configured provider/key.
    match cli.command {
        Some(Command::Models) => {
            config::Config::print_available_models();
            return Ok(());
        }
        Some(Command::Version) => {
            println!("stella v{}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        _ => {}
    }

    // Run/Chat/Config need a resolved config (which requires an API key).
    let cfg = config::Config::load(cli.model.as_deref(), cli.api_key.as_deref())?;

    match cli.command.unwrap_or(Command::Chat) {
        Command::Run { prompt } => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("failed to start runtime: {e}"))?;
            rt.block_on(agent::run_one_shot(&cfg, &prompt, cli.budget))?;
        }
        Command::Chat => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("failed to start runtime: {e}"))?;
            rt.block_on(agent::run_interactive(&cfg, cli.budget))?;
        }
        Command::Models => {
            cfg.print_models();
        }
        Command::Config => {
            cfg.print_config();
        }
        Command::Version => {
            println!("stella v{}", env!("CARGO_PKG_VERSION"));
        }
    }
    Ok(())
}
