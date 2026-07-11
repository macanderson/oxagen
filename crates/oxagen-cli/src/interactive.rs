//! The `ask_user` tool — the agent asking the human a multiple-choice
//! question mid-turn (user-mandated product rule, see
//! `oxagen_protocol::AgentEvent::AskUser`).
//!
//! BINDING contract: every question presents the model's structured options
//! PLUS always exactly one additional free-text option — the user can
//! always answer in their own words, on every question. The free-text
//! affordance is appended by the runtime (here), never by the model; the
//! tool's schema description forbids the model from listing an "Other"
//! option itself so it can't double up.
//!
//! Architecture: `InteractiveToolSet` wraps any inner
//! `oxagen_core::ports::ToolExecutor` (the native `ToolRegistry`, or the
//! MCP-merged set once that lands) and adds the `ask_user` schema. Actual
//! I/O goes through the [`AskUserIo`] port so tests never touch a real
//! terminal, and headless runs (`--output-format json|stream-json`, or a
//! non-TTY stdin) get a named error instead of a hang on input that will
//! never arrive.

use std::io::{BufRead, IsTerminal, Write};

use async_trait::async_trait;
use colored::Colorize;
use oxagen_core::ports::ToolExecutor;
use oxagen_protocol::{AgentEvent, ToolOutput, ToolSchema};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

/// The label the runtime appends as the always-present free-text option.
pub const FREE_TEXT_LABEL: &str = "Type your own answer";

/// How the `ask_user` tool actually reaches the human. Injectable so the
/// tool's selection/parsing logic is unit-testable without a TTY.
#[async_trait]
pub trait AskUserIo: Send + Sync {
    /// Present `question` + `options` (already including the free-text
    /// affordance as the final entry) and return the user's raw line.
    async fn prompt(&self, question: &str, options: &[String]) -> Result<String, String>;
}

/// Production io: prints the card to stdout and reads one line from stdin.
/// Safe to use while a turn is in flight — the REPL's own read loop is
/// suspended awaiting the turn, so stdin has exactly one reader.
pub struct TtyAskUserIo;

#[async_trait]
impl AskUserIo for TtyAskUserIo {
    async fn prompt(&self, question: &str, options: &[String]) -> Result<String, String> {
        println!("\n  {} {}", "?".yellow().bold(), question.bold());
        for (i, option) in options.iter().enumerate() {
            println!("    {} {}", format!("{})", i + 1).cyan(), option);
        }
        print!("  {} ", "answer (number or text):".dimmed());
        std::io::stdout().flush().map_err(|e| e.to_string())?;

        // Blocking stdin read off the async runtime's worker threads.
        tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            std::io::stdin()
                .lock()
                .read_line(&mut line)
                .map(|_| line)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Headless io: always a named error. Chosen when stdin isn't a TTY or the
/// output format is machine-oriented — per the AskUser event's documented
/// contract, headless runs fail the tool loudly rather than hanging.
pub struct HeadlessAskUserIo;

#[async_trait]
impl AskUserIo for HeadlessAskUserIo {
    async fn prompt(&self, _question: &str, _options: &[String]) -> Result<String, String> {
        Err(
            "interactive input is unavailable in this run (no TTY / machine output format) — \
             proceed with your best judgment instead of asking"
                .to_string(),
        )
    }
}

/// Pick the production io for the current process: TTY when stdin is one
/// and the caller wants interactive text output, headless otherwise.
pub fn default_ask_io(interactive_output: bool) -> Box<dyn AskUserIo> {
    if interactive_output && std::io::stdin().is_terminal() {
        Box::new(TtyAskUserIo)
    } else {
        Box::new(HeadlessAskUserIo)
    }
}

/// A `ToolExecutor` that adds `ask_user` on top of an inner executor.
pub struct InteractiveToolSet<'a> {
    inner: &'a dyn ToolExecutor,
    events: UnboundedSender<AgentEvent>,
    io: Box<dyn AskUserIo>,
}

impl<'a> InteractiveToolSet<'a> {
    pub fn new(
        inner: &'a dyn ToolExecutor,
        events: UnboundedSender<AgentEvent>,
        io: Box<dyn AskUserIo>,
    ) -> Self {
        Self { inner, events, io }
    }

    fn ask_user_schema() -> ToolSchema {
        ToolSchema {
            name: "ask_user".into(),
            description: "Ask the user a multiple-choice question when a decision is genuinely \
                          theirs to make and guessing would be costlier than asking. Provide 2-6 \
                          short, distinct options. The UI ALWAYS adds one extra free-text option \
                          automatically, so never include an 'Other' / 'something else' option \
                          yourself. Returns the user's answer as text."
                .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The complete question, ending with a question mark." },
                    "options": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 2,
                        "maxItems": 6,
                        "description": "Distinct, mutually exclusive choices. No 'Other' option — it is added automatically."
                    }
                },
                "required": ["question", "options"]
            }),
        }
    }

    async fn execute_ask_user(&self, call_id: &str, input: &Value) -> ToolOutput {
        let Some(question) = input.get("question").and_then(Value::as_str) else {
            return ToolOutput::Error {
                message: "ask_user: missing required string field `question`".into(),
            };
        };
        let model_options: Vec<String> = input
            .get("options")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if model_options.len() < 2 {
            return ToolOutput::Error {
                message: "ask_user: `options` must contain at least 2 choices".into(),
            };
        }

        // The event carries the model's structured options; the free-text
        // affordance is appended for the prompt itself (the binding
        // always-one-free-text-option rule lives HERE, in the runtime).
        let _ = self.events.send(AgentEvent::AskUser {
            id: call_id.to_string(),
            question: question.to_string(),
            options: model_options.clone(),
        });

        let mut presented = model_options.clone();
        presented.push(format!("{FREE_TEXT_LABEL}…"));

        let raw = match self.io.prompt(question, &presented).await {
            Ok(line) => line,
            Err(e) => {
                return ToolOutput::Error {
                    message: format!("ask_user failed: {e}"),
                };
            }
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return ToolOutput::Error {
                message: "ask_user: the user gave an empty answer — ask again or proceed with \
                          your best judgment"
                    .into(),
            };
        }

        // A bare number selects that option; picking the free-text slot (or
        // typing anything else) is a free-text answer verbatim.
        let answer = match trimmed.parse::<usize>() {
            Ok(n) if (1..=model_options.len()).contains(&n) => model_options[n - 1].clone(),
            Ok(n) if n == model_options.len() + 1 => {
                // They selected the free-text slot by number; re-prompt once
                // for the actual text.
                match self.io.prompt("Your answer:", &[]).await {
                    Ok(text) if !text.trim().is_empty() => text.trim().to_string(),
                    _ => {
                        return ToolOutput::Error {
                            message: "ask_user: no free-text answer provided".into(),
                        };
                    }
                }
            }
            _ => trimmed.to_string(),
        };

        ToolOutput::Ok { content: answer }
    }
}

#[async_trait]
impl ToolExecutor for InteractiveToolSet<'_> {
    fn schemas(&self) -> Vec<ToolSchema> {
        let mut schemas = self.inner.schemas();
        schemas.push(Self::ask_user_schema());
        schemas
    }

    async fn execute(&self, name: &str, input: &Value) -> ToolOutput {
        if name == "ask_user" {
            // The call_id isn't threaded through ToolExecutor::execute; use
            // a per-question counter-free surrogate (the engine's ToolStart
            // event already carries the real call_id for correlation).
            return self.execute_ask_user("ask_user", input).await;
        }
        self.inner.execute(name, input).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tokio::sync::mpsc;

    use super::*;

    /// Scripted io: records every prompt it was shown, pops answers from a
    /// queue.
    struct ScriptedIo {
        answers: Mutex<Vec<&'static str>>,
        seen_options: Mutex<Vec<Vec<String>>>,
    }

    impl ScriptedIo {
        fn new(answers: Vec<&'static str>) -> Self {
            Self {
                answers: Mutex::new(answers),
                seen_options: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl AskUserIo for ScriptedIo {
        async fn prompt(&self, _q: &str, options: &[String]) -> Result<String, String> {
            self.seen_options
                .lock()
                .expect("lock")
                .push(options.to_vec());
            let mut answers = self.answers.lock().expect("lock");
            if answers.is_empty() {
                return Err("script exhausted".into());
            }
            Ok(answers.remove(0).to_string())
        }
    }

    /// Minimal inner executor: one native tool, echoes.
    struct FakeInner;
    #[async_trait]
    impl ToolExecutor for FakeInner {
        fn schemas(&self) -> Vec<ToolSchema> {
            vec![ToolSchema {
                name: "bash".into(),
                description: "run".into(),
                input_schema: serde_json::json!({"type": "object"}),
            }]
        }
        async fn execute(&self, name: &str, _input: &Value) -> ToolOutput {
            ToolOutput::Ok {
                content: format!("inner ran {name}"),
            }
        }
    }

    fn ask_input() -> Value {
        serde_json::json!({
            "question": "Which migration target?",
            "options": ["local (5433)", "staging"]
        })
    }

    #[tokio::test]
    async fn schemas_include_native_tools_plus_ask_user() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(&inner, tx, Box::new(ScriptedIo::new(vec![])));
        let names: Vec<String> = set.schemas().into_iter().map(|s| s.name).collect();
        assert!(names.contains(&"bash".to_string()));
        assert!(names.contains(&"ask_user".to_string()));
    }

    /// An [`AskUserIo`] that shares its scripted state, so tests can keep a
    /// handle and inspect what was presented after the tool ran.
    #[derive(Clone)]
    struct SharedIo(std::sync::Arc<ScriptedIo>);

    #[async_trait]
    impl AskUserIo for SharedIo {
        async fn prompt(&self, q: &str, options: &[String]) -> Result<String, String> {
            self.0.prompt(q, options).await
        }
    }

    #[tokio::test]
    async fn every_question_always_presents_one_extra_free_text_option() {
        // THE user-mandated rule: N model options are always presented as
        // N+1 choices, the last being free text.
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let io = SharedIo(std::sync::Arc::new(ScriptedIo::new(vec!["1"])));
        let handle = io.clone();
        let set = InteractiveToolSet::new(&inner, tx, Box::new(io));
        let _ = set.execute("ask_user", &ask_input()).await;

        let seen = handle.0.seen_options.lock().expect("lock");
        let presented = seen.first().expect("one prompt happened");
        assert_eq!(presented.len(), 3, "2 options + 1 free-text");
        assert!(presented[2].starts_with(FREE_TEXT_LABEL));
    }

    #[tokio::test]
    async fn numeric_answer_selects_that_option() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(&inner, tx, Box::new(ScriptedIo::new(vec!["2"])));
        match set.execute("ask_user", &ask_input()).await {
            ToolOutput::Ok { content } => assert_eq!(content, "staging"),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn free_text_answer_returns_verbatim() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(
            &inner,
            tx,
            Box::new(ScriptedIo::new(vec!["actually use the docker instance"])),
        );
        match set.execute("ask_user", &ask_input()).await {
            ToolOutput::Ok { content } => {
                assert_eq!(content, "actually use the docker instance")
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn selecting_the_free_text_slot_by_number_reprompts_for_text() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        // "3" = the free-text slot (2 options + 1); then the actual text.
        let set = InteractiveToolSet::new(
            &inner,
            tx,
            Box::new(ScriptedIo::new(vec!["3", "my own words"])),
        );
        match set.execute("ask_user", &ask_input()).await {
            ToolOutput::Ok { content } => assert_eq!(content, "my own words"),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn ask_user_emits_the_ask_user_event_with_structured_options() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(&inner, tx, Box::new(ScriptedIo::new(vec!["1"])));
        let _ = set.execute("ask_user", &ask_input()).await;
        let event = rx.try_recv().expect("AskUser event emitted");
        match event {
            AgentEvent::AskUser {
                question, options, ..
            } => {
                assert!(question.contains("migration"));
                assert_eq!(options.len(), 2, "event carries the model's options only");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn headless_io_fails_with_a_named_error_never_hangs() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(&inner, tx, Box::new(HeadlessAskUserIo));
        match set.execute("ask_user", &ask_input()).await {
            ToolOutput::Error { message } => {
                assert!(message.contains("unavailable"), "{message}")
            }
            other => panic!("expected a named error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_input_is_a_named_error() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(&inner, tx, Box::new(ScriptedIo::new(vec![])));
        let out = set
            .execute("ask_user", &serde_json::json!({"question": "?"}))
            .await;
        assert!(out.is_error());
        let out = set
            .execute(
                "ask_user",
                &serde_json::json!({"question": "?", "options": ["only one"]}),
            )
            .await;
        assert!(out.is_error());
    }

    #[tokio::test]
    async fn non_ask_user_tools_fall_through_to_the_inner_executor() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let inner = FakeInner;
        let set = InteractiveToolSet::new(&inner, tx, Box::new(ScriptedIo::new(vec![])));
        match set.execute("bash", &Value::Null).await {
            ToolOutput::Ok { content } => assert_eq!(content, "inner ran bash"),
            other => panic!("expected inner fallthrough, got {other:?}"),
        }
    }
}
