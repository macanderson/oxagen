//! The only way the webview starts `tacho` or `oxagen`.
//!
//! The webview used to spawn both sidecars through the shell plugin, with a
//! capability that allowed any arguments and passed any environment the page
//! asked for. Any script that ran in the page could start either binary with
//! `daemon`, `hook`, `credential issue` or `NODE_OPTIONS` (audit D-12, #4318).
//! The shell plugin's scope cannot narrow that: it takes the first scope entry
//! whose name matches, so each sidecar gets one argument list of one fixed
//! length, and it never checks the environment.
//!
//! So the capability no longer grants `shell:allow-spawn` or
//! `shell:allow-kill`, and the page asks this module instead. `check_call`
//! holds the allowlist: each subcommand the app runs, the flags it passes to
//! it, and what each flag's value may be. The environment is the app's own
//! plus what `cli_install::sidecar_env` adds (`TACHO_BIN_DIR`), and nothing
//! from the page. `src/commands.ts` builds every argv the app sends, and
//! `sidecar-calls.json`, which its test keeps in step with those builders,
//! lists one of each for the test below.

use crate::activity::Activity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The two bundled binaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sidecar {
    Tacho,
    Oxagen,
}

impl Sidecar {
    fn name(self) -> &'static str {
        match self {
            Sidecar::Tacho => "tacho",
            Sidecar::Oxagen => "oxagen",
        }
    }
}

/// A flag a subcommand accepts: a switch, or a flag followed by one value.
enum Flag {
    Switch(&'static str),
    Value(&'static str, fn(&str) -> bool),
}

impl Flag {
    fn name(&self) -> &'static str {
        match self {
            Flag::Switch(name) | Flag::Value(name, _) => name,
        }
    }
}

/// One command the app runs: the sidecar, the subcommand words, the flags
/// it may carry in any order, each at most once, the flags it must carry,
/// and whether it changes the machine. Only a command that does holds a
/// close until it ends (see `activity`): stopping a read changes nothing.
struct Allowed {
    sidecar: Sidecar,
    command: &'static [&'static str],
    flags: &'static [Flag],
    required: &'static [&'static str],
    writes: bool,
}

/// The harnesses `tacho` wraps, as `src/commands.ts` names them.
const HARNESSES: [&str; 5] = ["claude-code", "codex", "cursor", "stella", "claude-desktop"];

fn is_harness(value: &str) -> bool {
    HARNESSES.contains(&value)
}

/// A comma-separated list of known harnesses, none of them empty.
fn is_harness_list(value: &str) -> bool {
    !value.is_empty() && value.split(',').all(is_harness)
}

/// An organization or workspace slug. The contracts allow lowercase letters,
/// digits and hyphens. This accepts a little more (upper case, `.` and `_`)
/// so an older slug still works, and never a leading `-`, a space, a `=` or
/// anything else a parser could read as another flag.
fn is_slug(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 64
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

const TARGET_FLAGS: [Flag; 3] = [
    Flag::Value("--org", is_slug),
    Flag::Value("--workspace", is_slug),
    Flag::Value("--harness", is_harness_list),
];

/// Every command the app runs, and nothing else.
const ALLOWED: &[Allowed] = &[
    // `tacho status --json`, the poll's read of hooks and service.
    Allowed {
        sidecar: Sidecar::Tacho,
        command: &["status"],
        flags: &[Flag::Switch("--json")],
        required: &["--json"],
        writes: false,
    },
    // `tacho detect --json`, the wizard's scan.
    Allowed {
        sidecar: Sidecar::Tacho,
        command: &["detect"],
        flags: &[Flag::Switch("--json")],
        required: &["--json"],
        writes: false,
    },
    // `tacho verify --harness <h> --json`, a first run.
    Allowed {
        sidecar: Sidecar::Tacho,
        command: &["verify"],
        flags: &[Flag::Value("--harness", is_harness), Flag::Switch("--json")],
        required: &["--harness", "--json"],
        writes: true,
    },
    // `tacho enroll`: the wizard's register step, which names the harnesses,
    // and Re-apply, which sends it bare. On an enrolled host a bare enroll
    // keeps the enrolled list and writes the hooks and the collector again.
    Allowed {
        sidecar: Sidecar::Tacho,
        command: &["enroll"],
        flags: &TARGET_FLAGS,
        required: &[],
        writes: true,
    },
    // `tacho reassign`: a workspace change, adding or removing a harness.
    Allowed {
        sidecar: Sidecar::Tacho,
        command: &["reassign"],
        flags: &TARGET_FLAGS,
        required: &[],
        writes: true,
    },
    // `tacho unenroll`, the last de-register and Uninstall.
    Allowed {
        sidecar: Sidecar::Tacho,
        command: &["unenroll"],
        flags: &[Flag::Switch("--purge")],
        required: &[],
        writes: true,
    },
    // `oxagen login --browser`, Sign in and Create an account.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["login"],
        flags: &[Flag::Switch("--browser"), Flag::Switch("--signup")],
        required: &["--browser"],
        writes: true,
    },
    // `oxagen logout`, Sign out.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["logout"],
        flags: &[],
        required: &[],
        writes: true,
    },
    // `oxagen tacho reassign ... --default`, a workspace change that also
    // becomes the CLI's default.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["tacho", "reassign"],
        flags: &[
            Flag::Value("--org", is_slug),
            Flag::Value("--workspace", is_slug),
            Flag::Value("--harness", is_harness_list),
            Flag::Switch("--default"),
        ],
        required: &["--default"],
        writes: true,
    },
];

/// Whether the app runs `args` on `sidecar`: `Ok(true)` for a command that
/// changes the machine, `Ok(false)` for a read. `Err` names why not.
pub fn check_call(sidecar: Sidecar, args: &[String]) -> Result<bool, String> {
    let refused = |why: &str| {
        Err(format!(
            "Oxagen does not run `{} {}`: {why}",
            sidecar.name(),
            args.join(" ")
        ))
    };
    let Some(allowed) = ALLOWED.iter().find(|allowed| {
        allowed.sidecar == sidecar
            && args.len() >= allowed.command.len()
            && allowed
                .command
                .iter()
                .zip(args)
                .all(|(word, arg)| *word == arg.as_str())
    }) else {
        return refused("not a command the app sends");
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut rest = args[allowed.command.len()..].iter();
    while let Some(arg) = rest.next() {
        let Some(flag) = allowed.flags.iter().find(|flag| flag.name() == arg.as_str()) else {
            return refused(&format!("{arg} is not a flag it passes"));
        };
        if seen.contains(&flag.name()) {
            return refused(&format!("{arg} is given twice"));
        }
        seen.push(flag.name());
        if let Flag::Value(name, valid) = flag {
            match rest.next() {
                Some(value) if valid(value) => {}
                Some(value) => return refused(&format!("{value:?} is not a value {name} takes")),
                None => return refused(&format!("{name} has no value")),
            }
        }
    }
    if let Some(missing) = allowed.required.iter().find(|flag| !seen.contains(flag)) {
        return refused(&format!("{missing} is missing"));
    }
    Ok(allowed.writes)
}

/// What a running sidecar reports to the page, one line at a time.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "lowercase")]
pub enum SidecarEvent {
    Stdout(String),
    Stderr(String),
    Error(String),
    Terminated { code: Option<i32> },
}

/// A line without its line ending. The shell plugin hands each line over
/// with its `\n`, and the page used to add another.
fn line_text(bytes: Vec<u8>) -> String {
    let text = String::from_utf8_lossy(&bytes);
    text.trim_end_matches(['\r', '\n']).to_string()
}

/// The sidecars running now, by process id, so the page can stop one that
/// outlived its deadline.
#[derive(Default)]
pub struct Running(Mutex<HashMap<u32, CommandChild>>);

/// Start `args` on `sidecar` once `check_call` allows it, and stream its
/// output to `on_event`. Returns the process id `kill_sidecar` takes. A
/// running command that changes the machine counts as work in progress for
/// the close guard: see `activity::Activity`.
#[tauri::command]
pub fn run_sidecar(
    app: tauri::AppHandle,
    running: tauri::State<Running>,
    activity: tauri::State<Activity>,
    sidecar: Sidecar,
    args: Vec<String>,
    on_event: Channel<SidecarEvent>,
) -> Result<u32, String> {
    let writes = check_call(sidecar, &args)?;
    let command = app
        .shell()
        .sidecar(sidecar.name())
        .map_err(|e| e.to_string())?
        .args(&args)
        .envs(crate::cli_install::sidecar_env());
    if writes {
        activity.begin();
    }
    let (mut events, child) = match command.spawn() {
        Ok(spawned) => spawned,
        Err(e) => {
            if writes {
                crate::activity::end_job(&app);
            }
            return Err(e.to_string());
        }
    };
    let pid = child.pid();
    running.0.lock().unwrap_or_else(|e| e.into_inner()).insert(pid, child);
    tauri::async_runtime::spawn(async move {
        let mut ended = false;
        while let Some(event) = events.recv().await {
            let out = match event {
                CommandEvent::Stdout(bytes) => SidecarEvent::Stdout(line_text(bytes)),
                CommandEvent::Stderr(bytes) => SidecarEvent::Stderr(line_text(bytes)),
                CommandEvent::Error(error) => SidecarEvent::Error(error),
                CommandEvent::Terminated(payload) => {
                    ended = true;
                    SidecarEvent::Terminated { code: payload.code }
                }
                _ => continue,
            };
            let _ = on_event.send(out);
            if ended {
                break;
            }
        }
        if let Some(running) = app.try_state::<Running>() {
            running.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
        }
        if writes {
            crate::activity::end_job(&app);
        }
    });
    Ok(pid)
}

/// Stop a sidecar `run_sidecar` started. A process that has already ended
/// is not an error.
#[tauri::command]
pub fn kill_sidecar(running: tauri::State<Running>, id: u32) -> Result<(), String> {
    let child = running.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match child {
        Some(child) => child.kill().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(sidecar: Sidecar, args: &[&str]) -> Result<bool, String> {
        check_call(sidecar, &args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[derive(Deserialize)]
    struct Call {
        sidecar: Sidecar,
        args: Vec<String>,
    }

    /// One of each argv `src/commands.ts` builds. `commands.test.ts` fails
    /// when a builder changes and this file does not.
    #[test]
    fn every_command_the_app_builds_is_allowed() {
        let calls: Vec<Call> = serde_json::from_str(include_str!("../sidecar-calls.json")).unwrap();
        assert!(calls.len() >= 20, "{} calls", calls.len());
        for call in calls {
            assert!(check_call(call.sidecar, &call.args).is_ok(), "{:?}", call.args);
        }
    }

    #[test]
    fn a_command_the_app_does_not_send_is_refused() {
        use Sidecar::{Oxagen, Tacho};
        for (sidecar, args) in [
            // Subcommands the app never runs.
            (Tacho, vec!["daemon"]),
            (Tacho, vec!["hook"]),
            (Tacho, vec!["credential", "issue", "--harness", "claude-code"]),
            (Tacho, vec!["mcp-stdio"]),
            (Oxagen, vec!["tacho", "unenroll", "--purge"]),
            (Oxagen, vec!["api", "post", "/v1/anything"]),
            (Tacho, vec![]),
            // A known command with a flag it never passes.
            (Tacho, vec!["status", "--json", "--api-url", "https://evil.example"]),
            (
                Tacho,
                vec!["enroll", "--harness", "codex", "--credentials", "passthrough"],
            ),
            (Oxagen, vec!["login", "--browser", "--token", "x"]),
            // A required flag missing.
            (Tacho, vec!["status"]),
            (Tacho, vec!["verify", "--json"]),
            (Oxagen, vec!["login"]),
            (Oxagen, vec!["tacho", "reassign", "--workspace", "core"]),
            // A value that could be read as a flag or smuggle one in.
            (Tacho, vec!["verify", "--harness", "x,--purge", "--json"]),
            (Tacho, vec!["verify", "--harness", "claude-code,codex", "--json"]),
            (Tacho, vec!["enroll", "--harness", ""]),
            (Tacho, vec!["enroll", "--harness", "codex,"]),
            (Tacho, vec!["reassign", "--org", "--purge"]),
            (Tacho, vec!["reassign", "--workspace", "core space"]),
            (Tacho, vec!["reassign", "--workspace", "a=b"]),
            (Tacho, vec!["reassign", "--workspace"]),
            // A flag twice, and a positional argument.
            (Tacho, vec!["unenroll", "--purge", "--purge"]),
            (Tacho, vec!["unenroll", "extra"]),
            // The wrong sidecar for the command.
            (Oxagen, vec!["status", "--json"]),
            (Tacho, vec!["login", "--browser"]),
        ] {
            assert!(call(sidecar, &args).is_err(), "{sidecar:?} {args:?} was allowed");
        }
    }

    /// Re-apply sends `tacho enroll` with no flags. The allowlist once
    /// required `--harness`, so the button failed with "--harness is
    /// missing".
    #[test]
    fn re_apply_runs_a_bare_enroll() {
        assert_eq!(call(Sidecar::Tacho, &["enroll"]), Ok(true));
    }

    #[test]
    fn flags_may_come_in_any_order() {
        assert!(call(Sidecar::Tacho, &["verify", "--json", "--harness", "codex"]).is_ok());
        assert!(call(
            Sidecar::Tacho,
            &["enroll", "--harness", "codex", "--workspace", "core", "--org", "acme"]
        )
        .is_ok());
    }

    /// A read holds no close: stopping `tacho status` or a scan changes
    /// nothing on the machine. Everything else is a write.
    #[test]
    fn only_the_two_reads_leave_a_close_alone() {
        assert_eq!(call(Sidecar::Tacho, &["status", "--json"]), Ok(false));
        assert_eq!(call(Sidecar::Tacho, &["detect", "--json"]), Ok(false));
        assert_eq!(
            call(Sidecar::Tacho, &["verify", "--harness", "codex", "--json"]),
            Ok(true)
        );
        assert_eq!(call(Sidecar::Tacho, &["enroll", "--harness", "codex"]), Ok(true));
        assert_eq!(call(Sidecar::Tacho, &["unenroll", "--purge"]), Ok(true));
        assert_eq!(call(Sidecar::Oxagen, &["login", "--browser"]), Ok(true));
    }

    #[test]
    fn the_refusal_names_the_command_and_why() {
        let error = call(Sidecar::Tacho, &["daemon"]).unwrap_err();
        assert_eq!(error, "Oxagen does not run `tacho daemon`: not a command the app sends");
        let error = call(Sidecar::Tacho, &["status", "--json", "--x"]).unwrap_err();
        assert!(error.ends_with("--x is not a flag it passes"), "{error}");
    }

    #[test]
    fn a_line_loses_only_its_line_ending() {
        assert_eq!(line_text(b"{\"ok\":true}\n".to_vec()), "{\"ok\":true}");
        assert_eq!(line_text(b"done\r\n".to_vec()), "done");
        assert_eq!(line_text(b"  indented  ".to_vec()), "  indented  ");
    }
}
