//! Terminal UI — streaming text, tool-call cards, spinner, cost tracking.
//!
//! Designed for speed and engagement: the user sees the model's text
//! streaming in real time, tool calls appear as cards with status, and a
//! spinner runs while waiting for the model to respond.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use colored::Colorize;

/// Spinner frames for the "thinking" indicator.
const SPINNER: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// A simple live spinner that runs on the terminal until dropped.
pub struct Spinner {
    start: Instant,
    message: String,
    active: bool,
}

impl Spinner {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            start: Instant::now(),
            message: message.into(),
            active: true,
        }
    }

    pub fn tick(&self, frame_idx: usize) {
        let frame = SPINNER[frame_idx % SPINNER.len()];
        let elapsed = self.start.elapsed();
        eprint!(
            "\r{} {} {}     ",
            frame.cyan(),
            self.message.dimmed(),
            format!("({:.1}s)", elapsed.as_secs_f64()).dimmed()
        );
        let _ = io::stderr().flush();
    }

    pub fn finish(&mut self, final_msg: &str) {
        if self.active {
            eprint!("\r{}\r", " ".repeat(80));
            let _ = io::stderr().flush();
            if !final_msg.is_empty() {
                eprintln!("  {}", final_msg.dimmed());
            }
            self.active = false;
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        self.finish("");
    }
}

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

/// Print cost + token summary for a turn.
pub fn cost_summary(input_tokens: u64, output_tokens: u64, cost_usd: f64, model: &str) {
    let total = input_tokens + output_tokens;
    println!(
        "\n  {} {} tokens ({} in / {} out) · {} · {:.4}s",
        "◆".dimmed(),
        format!("{total}").bright_white(),
        input_tokens,
        output_tokens,
        model.bright_blue(),
        cost_usd,
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
