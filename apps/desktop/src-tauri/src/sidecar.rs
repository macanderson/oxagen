//! The only way the webview starts the bundled `oxagen` sidecar.
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
//! plus what `cli_install::sidecar_env` adds (`TACHO_BIN_DIR` and
//! `OXAGEN_DESKTOP_SIDECAR`), and nothing from the page. `src/commands.ts`
//! builds every argv the app sends, and `sidecar-calls.json`, which its test
//! keeps in step with those builders, lists one of each for the test below.
//!
//! Every recorder command runs as `oxagen agent <verb>`, the command a person
//! types (#4891). The page cannot start the bundled `tacho` at all: it stays
//! in the bundle only so the per-user copy still carries it for machines
//! enrolled before #4879, whose hooks run it until they move.

use crate::activity::Activity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The bundled binary the page may start. `tacho` is not one: a page that
/// names it fails to deserialize before `check_call` runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sidecar {
    Oxagen,
}

impl Sidecar {
    fn name(self) -> &'static str {
        match self {
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
/// and whether stopping it partway could leave a file half written. Only a
/// command that could holds a close until it ends (see `activity`).
struct Allowed {
    sidecar: Sidecar,
    command: &'static [&'static str],
    flags: &'static [Flag],
    required: &'static [&'static str],
    writes: bool,
}

/// The harnesses the recorder wraps, as `src/commands.ts` names them.
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
    // `oxagen agent status --json`, the poll's read of hooks and service. On
    // a machine whose hooks still run `tacho`, the first one moves them to
    // `oxagen hook` and `oxagen daemon`. It holds no close: holding a Quit
    // on every poll costs more than a move cut short, which leaves each hook
    // on a name that still works, and the next poll finishes the move.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["agent", "status"],
        flags: &[Flag::Switch("--json")],
        required: &["--json"],
        writes: false,
    },
    // `oxagen agent detect --json`, the wizard's scan.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["agent", "detect"],
        flags: &[Flag::Switch("--json")],
        required: &["--json"],
        writes: false,
    },
    // `oxagen agent verify --harness <h> --json`, a first run. It drives one
    // headless turn and reads the daemon's answer, and writes no file of its
    // own, so it holds no close. It can take four minutes.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["agent", "verify"],
        flags: &[Flag::Value("--harness", is_harness), Flag::Switch("--json")],
        required: &["--harness", "--json"],
        writes: false,
    },
    // `oxagen agent enroll`: the wizard's register step, which names the
    // harnesses, and Re-apply, which sends it bare. On an enrolled host a
    // bare enroll keeps the enrolled list and writes the hooks and the
    // collector again as `oxagen hook` and `oxagen daemon`.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["agent", "enroll"],
        flags: &TARGET_FLAGS,
        required: &[],
        writes: true,
    },
    // `oxagen agent reassign`: a workspace change, adding or removing a
    // harness. `--default` also makes the new pair the CLI's default.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["agent", "reassign"],
        flags: &[
            Flag::Value("--org", is_slug),
            Flag::Value("--workspace", is_slug),
            Flag::Value("--harness", is_harness_list),
            Flag::Switch("--default"),
        ],
        required: &[],
        writes: true,
    },
    // `oxagen agent unenroll`: the last de-register names its one harness,
    // and Uninstall passes `--all` for every agent on the machine (ADR-203).
    // Never an agent argument: that form revokes a registered agent's hosts
    // on the server.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["agent", "unenroll"],
        flags: &[
            Flag::Switch("--purge"),
            Flag::Switch("--all"),
            Flag::Value("--harness", is_harness),
        ],
        required: &[],
        writes: true,
    },
    // `oxagen login --browser`, Sign in and Create an account. It waits up
    // to five minutes for the browser, and its one write, `config.json`, is a
    // temp file and a rename, so it holds no close.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["login"],
        flags: &[Flag::Switch("--browser"), Flag::Switch("--signup")],
        required: &["--browser"],
        writes: false,
    },
    // `oxagen logout`, Sign out.
    Allowed {
        sidecar: Sidecar::Oxagen,
        command: &["logout"],
        flags: &[],
        required: &[],
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
        use Sidecar::Oxagen;
        for args in [
            // Machine commands the app never runs.
            vec!["daemon"],
            vec!["hook"],
            vec!["credential", "issue", "--harness", "claude-code"],
            vec!["mcp-stdio"],
            vec!["agent", "run", "--name", "x"],
            vec!["agent", "export", "--list"],
            vec!["api", "post", "/v1/anything"],
            vec![],
            vec!["agent"],
            // The old spelling, which the app no longer sends.
            vec!["tacho", "reassign", "--workspace", "core", "--default"],
            vec!["tacho", "status", "--json"],
            // A recorder verb without its `agent` group.
            vec!["status", "--json"],
            vec!["enroll"],
            // An agent argument: the server-scoped forms of status and
            // unenroll, which the app never runs.
            vec!["agent", "status", "some-agent", "--json"],
            vec!["agent", "unenroll", "agt_x"],
            // A known command with a flag it never passes.
            vec!["agent", "status", "--json", "--api-url", "https://evil.example"],
            vec!["agent", "enroll", "--harness", "codex", "--credentials", "passthrough"],
            vec!["agent", "enroll", "--token", "oxe_1time_x"],
            vec!["agent", "reassign", "--token", "x", "--workspace", "core"],
            vec!["agent", "unenroll", "--all", "--token", "x"],
            vec!["login", "--browser", "--token", "x"],
            // A required flag missing.
            vec!["agent", "status"],
            vec!["agent", "verify", "--json"],
            vec!["login"],
            // A value that could be read as a flag or smuggle one in.
            vec!["agent", "verify", "--harness", "x,--purge", "--json"],
            vec!["agent", "verify", "--harness", "claude-code,codex", "--json"],
            vec!["agent", "enroll", "--harness", ""],
            vec!["agent", "enroll", "--harness", "codex,"],
            vec!["agent", "reassign", "--org", "--purge"],
            vec!["agent", "reassign", "--workspace", "core space"],
            vec!["agent", "reassign", "--workspace", "a=b"],
            vec!["agent", "reassign", "--workspace"],
            // A flag twice, and a positional argument.
            vec!["agent", "unenroll", "--purge", "--purge"],
            vec!["agent", "unenroll", "extra"],
            // Unenroll names one agent, by one harness.
            vec!["agent", "unenroll", "--harness", "claude-code,codex"],
            vec!["agent", "unenroll", "--harness", "--purge"],
        ] {
            assert!(call(Oxagen, &args).is_err(), "{args:?} was allowed");
        }
    }

    /// The page names the sidecar, and `tacho` is not one it may name: the
    /// call fails to deserialize before the allowlist is read.
    #[test]
    fn the_page_cannot_start_tacho() {
        assert!(serde_json::from_str::<Sidecar>("\"tacho\"").is_err());
        assert_eq!(serde_json::from_str::<Sidecar>("\"oxagen\"").unwrap(), Sidecar::Oxagen);
        let calls: Vec<Call> = serde_json::from_str(include_str!("../sidecar-calls.json")).unwrap();
        assert!(
            calls
                .iter()
                .all(|call| call.args.first().map(String::as_str) != Some("tacho")),
            "a call still runs the old `oxagen tacho` spelling"
        );
    }

    /// Re-apply sends `oxagen agent enroll` with no flags. The allowlist once
    /// required `--harness`, so the button failed with "--harness is
    /// missing".
    #[test]
    fn re_apply_runs_a_bare_enroll() {
        assert_eq!(call(Sidecar::Oxagen, &["agent", "enroll"]), Ok(true));
    }

    #[test]
    fn flags_may_come_in_any_order() {
        assert!(call(Sidecar::Oxagen, &["agent", "verify", "--json", "--harness", "codex"]).is_ok());
        assert!(call(
            Sidecar::Oxagen,
            &[
                "agent",
                "enroll",
                "--harness",
                "codex",
                "--workspace",
                "core",
                "--org",
                "acme"
            ]
        )
        .is_ok());
        assert!(call(
            Sidecar::Oxagen,
            &[
                "agent",
                "reassign",
                "--default",
                "--workspace",
                "ops",
                "--org",
                "globex"
            ]
        )
        .is_ok());
    }

    /// Only a command that could leave a file half written holds a close.
    /// A read changes nothing. A sign-in writes `config.json` with a rename
    /// and a first run writes nothing, and both can wait minutes: holding
    /// them kept the app running for up to five minutes after a Quit.
    #[test]
    fn only_a_command_that_writes_files_holds_a_close() {
        use Sidecar::Oxagen;
        assert_eq!(call(Oxagen, &["agent", "status", "--json"]), Ok(false));
        assert_eq!(call(Oxagen, &["agent", "detect", "--json"]), Ok(false));
        assert_eq!(
            call(Oxagen, &["agent", "verify", "--harness", "codex", "--json"]),
            Ok(false)
        );
        assert_eq!(call(Oxagen, &["login", "--browser"]), Ok(false));
        assert_eq!(call(Oxagen, &["login", "--browser", "--signup"]), Ok(false));
        assert_eq!(call(Oxagen, &["agent", "enroll", "--harness", "codex"]), Ok(true));
        assert_eq!(call(Oxagen, &["agent", "enroll"]), Ok(true));
        assert_eq!(call(Oxagen, &["agent", "reassign", "--workspace", "core"]), Ok(true));
        assert_eq!(
            call(Oxagen, &["agent", "reassign", "--workspace", "core", "--default"]),
            Ok(true)
        );
        assert_eq!(call(Oxagen, &["agent", "unenroll", "--purge"]), Ok(true));
        assert_eq!(call(Oxagen, &["agent", "unenroll", "--all", "--purge"]), Ok(true));
        assert_eq!(call(Oxagen, &["agent", "unenroll", "--harness", "codex"]), Ok(true));
        assert_eq!(call(Oxagen, &["logout"]), Ok(true));
    }

    #[test]
    fn the_refusal_names_the_command_and_why() {
        let error = call(Sidecar::Oxagen, &["daemon"]).unwrap_err();
        assert_eq!(
            error,
            "Oxagen does not run `oxagen daemon`: not a command the app sends"
        );
        let error = call(Sidecar::Oxagen, &["agent", "status", "--json", "--x"]).unwrap_err();
        assert!(error.ends_with("--x is not a flag it passes"), "{error}");
    }

    #[test]
    fn a_line_loses_only_its_line_ending() {
        assert_eq!(line_text(b"{\"ok\":true}\n".to_vec()), "{\"ok\":true}");
        assert_eq!(line_text(b"done\r\n".to_vec()), "done");
        assert_eq!(line_text(b"  indented  ".to_vec()), "  indented  ");
    }
}
