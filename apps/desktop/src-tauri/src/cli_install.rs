//! Automatic PATH installation for the bundled `oxagen` and `tacho`
//! sidecars. `ensure_cli_installed` runs once per launch (off the main
//! thread, from `lib.rs`'s `setup`): idempotent, never elevates, never
//! clobbers a file it did not write. `install_cli` / `uninstall_cli` are the
//! explicit "Link into PATH" / "Remove links" commands the Command line
//! panel calls; they share the same decision functions so a manual click and
//! an automatic launch never disagree about what counts as "ours".
//!
//! The orchestration functions here do real filesystem and process I/O and
//! are exercised through the Tauri commands and `ensure_cli_installed`. The
//! functions that decide *what to do* — given what is already on disk — are
//! plain, pure and unit-tested below: `decide_symlink_action`,
//! `decide_unlink_action`, `decide_shim_action`, `shim_is_ours`,
//! `decide_path_precedence`, `is_oxagen_managed_path`, `upsert_path_block`,
//! `remove_path_block`, `profile_path_for`, `fish_file_is_ours`,
//! `detect_shell_kind`, `path_var_contains`, `auto_link_cli_enabled`.

use crate::machine::Roots;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
#[cfg(not(windows))]
use std::time::Duration;

// ---------------------------------------------------------------------
// Shared small helpers (also used by the state read in lib.rs)
// ---------------------------------------------------------------------

pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Where Tauri put the sidecars: next to the app executable.
pub fn sidecar_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Whether a directory exists only for this launch: an AppImage's squashfs
/// mount (`/tmp/.mount_*`, or the `APPIMAGE` variable the runtime sets), a
/// mounted disk image, or App Translocation (a quarantined app opened where
/// it was downloaded). `tacho enroll` bakes the sidecar's directory into the
/// hook commands and the service unit, and PATH links point into it, so
/// nothing durable may reference such a directory.
///
/// A disk image mounts read-only under `/Volumes`. An external disk mounts
/// there too, writable, and an app copied onto it stays: counting every
/// `/Volumes` path copied 240 MB on each launch. `volume_read_only` answers
/// for the volume a `/Volumes` path is on.
pub fn is_transient_dir(dir: &Path, appimage_env: bool, volume_read_only: &dyn Fn(&Path) -> bool) -> bool {
    let text = dir.to_string_lossy().replace('\\', "/");
    text.starts_with("/tmp/.mount_")
        || text.contains("/AppTranslocation/")
        || (text.starts_with("/Volumes/") && volume_read_only(dir))
        || appimage_env
}

/// Pure: whether `mount`'s table (the macOS form, `<device> on <mount
/// point> (<type>, <flag>, ...)`) has the volume `dir` is on mounted
/// read-only. The volume is the deepest mount point `dir` is under other
/// than `/`, which on macOS is the sealed read-only system volume. `None`
/// when the table lists no such mount point.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mount_table_read_only(table: &str, dir: &Path) -> Option<bool> {
    let mut deepest: Option<(usize, bool)> = None;
    for line in table.lines() {
        let Some((_, rest)) = line.split_once(" on ") else {
            continue;
        };
        let Some(open) = rest.rfind(" (") else {
            continue;
        };
        let point = &rest[..open];
        if point == "/" || !dir.starts_with(point) {
            continue;
        }
        let read_only = rest[open + 2..]
            .trim_end_matches(')')
            .split(',')
            .any(|flag| flag.trim() == "read-only");
        match deepest {
            Some((len, _)) if len >= point.len() => {}
            _ => deepest = Some((point.len(), read_only)),
        }
    }
    deepest.map(|(_, read_only)| read_only)
}

/// Whether the volume `dir` is on is mounted read-only, from `/sbin/mount`.
/// A volume the table does not answer for counts as read-only, the safe
/// side: a copy that was not needed costs disk space, and a hook pointing
/// into an image that is gone costs every session.
#[cfg(target_os = "macos")]
fn volume_is_read_only(dir: &Path) -> bool {
    std::process::Command::new("/sbin/mount")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|out| mount_table_read_only(&String::from_utf8_lossy(&out.stdout), dir))
        .unwrap_or(true)
}

#[cfg(not(target_os = "macos"))]
fn volume_is_read_only(_dir: &Path) -> bool {
    true
}

/// Worked out once per launch: the sidecar directory and the volume it is on
/// do not change while the app runs, and `desktop_state` asks on every poll.
pub fn sidecar_dir_is_transient() -> bool {
    static TRANSIENT: OnceLock<bool> = OnceLock::new();
    *TRANSIENT.get_or_init(|| {
        sidecar_dir()
            .map(|dir| is_transient_dir(&dir, std::env::var_os("APPIMAGE").is_some(), &volume_is_read_only))
            .unwrap_or(false)
    })
}

/// A per-user directory the app copies the sidecars into when it runs from
/// a transient one: `~/Library/Application Support/oxagen/bin` on macOS,
/// `~/.local/share/oxagen/bin` on Linux. Windows installs are never
/// transient (the shims embed the Program Files path).
pub fn durable_bin_dir() -> PathBuf {
    Roots::real().durable_bin_dir()
}

pub fn has_both_sidecars(dir: &Path) -> bool {
    ["oxagen", "tacho"].iter().all(|name| dir.join(exe(name)).is_file())
}

/// The directory `tacho` should derive its hook and daemon commands from:
/// the sidecar directory when it lasts, else the durable copy when one
/// exists, else nothing (enrolling is refused by tacho itself until
/// `ensure_cli_installed` / `install_cli` makes the copy or the app is
/// moved).
pub fn bin_dir() -> Option<PathBuf> {
    let sidecars = sidecar_dir()?;
    if !sidecar_dir_is_transient() {
        return Some(sidecars);
    }
    let durable = durable_bin_dir();
    has_both_sidecars(&durable).then_some(durable)
}

/// What one install or uninstall pass runs against: the machine's roots, the
/// directory the sidecars are in, whether that directory outlives this
/// launch, and the two PATH values the decisions read. `real()` reads the
/// process. A test builds one over a scratch directory.
pub struct InstallEnv {
    pub roots: Roots,
    pub sidecars: Option<PathBuf>,
    pub transient: bool,
    /// This process's own PATH.
    pub process_path: String,
    /// What a new terminal's PATH would be. `None` asks the login shell,
    /// which can take seconds, so it is only asked when it is needed.
    pub login_path: Option<String>,
}

impl InstallEnv {
    pub fn real() -> Self {
        Self {
            roots: Roots::real(),
            sidecars: sidecar_dir(),
            transient: sidecar_dir_is_transient(),
            process_path: std::env::var("PATH").unwrap_or_default(),
            login_path: None,
        }
    }
}

/// Point every sidecar the app spawns at the durable copy an earlier launch
/// made (they inherit the app's environment): with `TACHO_BIN_DIR` set,
/// `tacho` writes that path into hooks and the service unit instead of its
/// own transient one.
///
/// Called first thing in `run()`, before any thread exists. Changing the
/// environment once other threads run is unsound on Unix (a concurrent
/// `getenv` in WebKit or the async runtime can read freed memory), so a copy
/// made later in the launch is not exported here: the webview asks
/// `sidecar_env` for it and passes it to each sidecar it spawns.
pub fn export_bin_dir() {
    for (key, value) in sidecar_env() {
        std::env::set_var(key, value);
    }
}

/// What a sidecar needs in its environment on top of the app's own, asked
/// for each spawn (the `sidecar_env` command) so a copy made during this
/// launch is used at once.
pub fn sidecar_env() -> std::collections::BTreeMap<String, String> {
    sidecar_env_for(sidecar_dir_is_transient(), bin_dir().as_deref())
}

/// Pure: `TACHO_BIN_DIR` at the durable copy while the app runs from a
/// transient directory. Nothing otherwise: from a directory that lasts,
/// tacho derives the right path itself, and with no copy yet it refuses to
/// enroll, which is the point.
pub fn sidecar_env_for(transient: bool, bin_dir: Option<&Path>) -> std::collections::BTreeMap<String, String> {
    let mut env = std::collections::BTreeMap::new();
    if let (true, Some(dir)) = (transient, bin_dir) {
        env.insert("TACHO_BIN_DIR".to_string(), dir.display().to_string());
    }
    env
}

/// Search a `PATH`-shaped string for an executable named `name`, the way a
/// shell's own lookup would: first directory that has it wins. Shared by
/// `on_path` (the current process's own PATH, for `desktop_state`) and the
/// shadow check in `install_cli_locked` (the *login shell's* PATH, which can
/// differ from this process's own).
fn resolve_in_path_var(name: &str, path_var: &str) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        let candidate = dir.join(exe(name));
        if candidate.is_file() {
            return Some(candidate);
        }
        if cfg!(windows) {
            let cmd = dir.join(format!("{name}.cmd"));
            if cmd.is_file() {
                return Some(cmd);
            }
        }
    }
    None
}

pub fn on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    resolve_in_path_var(name, &path.to_string_lossy()).map(|p| p.display().to_string())
}

/// Where the PATH links go: a directory the user owns on every platform.
pub fn cli_install_dir() -> PathBuf {
    Roots::real().cli_install_dir()
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    crate::read_json(path)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// `desktop.json`'s key for "this app created `~/.config`".
const CONFIG_DIR_CREATED: &str = "configDirCreated";

/// Write `desktop.json`. When `~/.config` is not there yet, this write is what
/// creates it, and the file records that under `configDirCreated`, so
/// Uninstall removes an empty `~/.config` only when Oxagen made it.
fn write_desktop_config(roots: &Roots, config: &Map<String, Value>) -> Result<(), String> {
    let mut config = config.clone();
    if !roots.home.join(".config").exists() {
        config.insert(CONFIG_DIR_CREATED.to_string(), Value::Bool(true));
    }
    let path = roots.desktop_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(config)).unwrap_or_else(|_| "{}".to_string());
    crate::machine::write_atomic(&path, &text)
}

/// Run at launch, before any sidecar can write under `~/.config/oxagen`.
/// `oxagen login` and `tacho enroll` create `~/.config` when it is missing and
/// record nothing, so Uninstall could not tell a `~/.config` Oxagen made from
/// an empty one the person already had, and removed both (#4318). When it is
/// missing, the app writes `desktop.json` first, and that write records it.
pub fn record_config_dir(roots: &Roots) -> Result<(), String> {
    if roots.home.join(".config").exists() {
        return Ok(());
    }
    write_desktop_config(roots, &read_json_object(&roots.desktop_config_path()))
}

/// Whether `desktop.json` says this app created `~/.config`.
fn config_dir_created(roots: &Roots) -> bool {
    read_json_object(&roots.desktop_config_path())
        .get(CONFIG_DIR_CREATED)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Pure: whether automatic linking is enabled, given an explicit setting and,
/// when there is none, whether this machine looks like a developer's.
///
/// The default used to be unconditional on. That was right when the app only
/// wrapped coding agents: anyone installing it already had a terminal and a
/// harness on PATH. It is wrong now that the app also connects apps like
/// Claude Desktop (ADR-078), because the person connecting one may never open
/// a terminal, and linking two binaries into `~/.local/bin` and editing their
/// shell profile to reach them is a change they did not ask for and cannot
/// evaluate.
///
/// So the default follows the machine: on where a coding agent is already
/// installed, off otherwise. Either way it is a *default* — an explicit
/// `autoLinkCli` in `desktop.json` always wins, in both directions, so
/// "Remove links" stays removed and "Link into PATH" stays linked.
pub fn auto_link_cli_default(developer_harness_present: bool) -> bool {
    developer_harness_present
}

/// Pure: whether automatic linking is enabled, resolving an absent setting
/// through `auto_link_cli_default`.
pub fn auto_link_cli_enabled_with(config: &Map<String, Value>, developer_harness_present: bool) -> bool {
    config
        .get("autoLinkCli")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| auto_link_cli_default(developer_harness_present))
}

/// The coding agents whose presence makes this a developer's machine. Matches
/// the harnesses Tacho wraps with a hook (`WRAPPED_HARNESSES` in
/// `packages/tacho/src/wire.ts`); a connected app is deliberately not on this
/// list, because someone who has only Claude Desktop is exactly the person
/// this default exists for.
const DEVELOPER_BINARIES: [&str; 4] = ["claude", "codex", "cursor-agent", "stella"];

/// Pure: does any of the well-known install directories hold a coding agent?
/// Takes the directory list and an existence probe so a test is not answered
/// by whatever happens to be installed on the machine running it.
pub fn developer_harness_in(dirs: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> bool {
    for dir in dirs {
        for name in DEVELOPER_BINARIES {
            if exists(&dir.join(exe(name))) {
                return true;
            }
        }
    }
    false
}

/// Where the harness installers put their binaries. Mirrors
/// `wellKnownBinDirs` in `packages/tacho/src/cli/deps.ts`: the app launches
/// from Finder with the bare system PATH, and Claude Code's PATH line lives
/// in `.zshrc`, which no non-interactive shell reads — so this is a disk
/// check, not a PATH check.
#[cfg(test)]
pub fn well_known_harness_dirs() -> Vec<PathBuf> {
    well_known_harness_dirs_in(&Roots::real().home)
}

/// `well_known_harness_dirs` for a given home directory.
pub fn well_known_harness_dirs_in(home: &Path) -> Vec<PathBuf> {
    let home = home.to_path_buf();
    if cfg!(windows) {
        let app_data = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        vec![
            app_data.join("npm"),
            local.join("Programs").join("claude"),
            home.join(".local").join("bin"),
            home.join(".codex").join("bin"),
            home.join(".cargo").join("bin"),
        ]
    } else {
        vec![
            home.join(".local").join("bin"),
            home.join(".claude").join("local"),
            home.join(".codex").join("bin"),
            home.join(".cargo").join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            home.join(".npm-global").join("bin"),
            home.join(".volta").join("bin"),
            home.join(".bun").join("bin"),
        ]
    }
}

/// Pure: merge `autoLinkCli` into an existing config map, keeping every
/// other key untouched.
pub fn set_auto_link_cli(mut config: Map<String, Value>, enabled: bool) -> Map<String, Value> {
    config.insert("autoLinkCli".to_string(), Value::Bool(enabled));
    config
}

pub(crate) fn write_auto_link_cli(roots: &Roots, enabled: bool) -> Result<(), String> {
    let config = set_auto_link_cli(read_json_object(&roots.desktop_config_path()), enabled);
    write_desktop_config(roots, &config)
}

/// The persisted `autoLinkCli` preference.
pub(crate) fn read_auto_link_cli(roots: &Roots) -> bool {
    auto_link_cli_enabled_with(
        &read_json_object(&roots.desktop_config_path()),
        developer_harness_in(&well_known_harness_dirs_in(&roots.home), &|p: &Path| p.exists()),
    )
}

// ---------------------------------------------------------------------
// PATH-variable membership (pure)
// ---------------------------------------------------------------------

/// Whether `dir` appears in a `PATH`-shaped string, using the platform path
/// separator (`:` on Unix, `;` on Windows).
pub fn path_var_contains(path_var: &str, dir: &Path) -> bool {
    std::env::split_paths(path_var).any(|d| d == dir)
}

// ---------------------------------------------------------------------
// "Is this ours to replace" (pure)
// ---------------------------------------------------------------------

/// Whether `path` is somewhere only this app's installer points a link at,
/// so a link into it is ours to replace. Exact locations, never a substring
/// guess: the durable copy (`durable_bin_dir()`, compared as a path), an
/// `Oxagen.app/Contents/MacOS` bundle wherever it sits (which covers
/// /Applications, a mounted .dmg and App Translocation), an AppImage mount
/// (`/tmp/.mount_Oxagen*`), or `Program Files\Oxagen`. A developer checkout
/// (`~/src/oxagen/bin/oxagen`), a Homebrew Cellar path, another user's data
/// directory or a volume that merely has "oxagen" in its name is someone
/// else's.
#[cfg(test)]
pub fn is_oxagen_managed_path(path: &Path) -> bool {
    is_oxagen_managed_path_in(path, &durable_bin_dir())
}

/// `is_oxagen_managed_path` with the durable directory passed in, so the
/// rule is testable without the real user's data directory.
pub fn is_oxagen_managed_path_in(path: &Path, durable: &Path) -> bool {
    if path.starts_with(durable) {
        return true;
    }
    let lower = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let segments: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    let in_bundle = segments.windows(3).any(|w| w == ["oxagen.app", "contents", "macos"]);
    let in_appimage = lower.starts_with("/tmp/.mount_oxagen");
    let in_program_files = segments
        .windows(2)
        .any(|w| (w[0] == "program files" || w[0] == "program files (x86)") && w[1] == "oxagen");
    in_bundle || in_appimage || in_program_files
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExistingLink {
    /// Nothing at this path.
    Absent,
    /// A symlink, resolved to its (unread, possibly dangling) target.
    Symlink(PathBuf),
    /// A regular file, or anything else that isn't a symlink.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkAction {
    Create,
    Replace,
    AlreadyCorrect,
    Skip,
}

/// Decide what to do with a would-be symlink given what's already there.
#[cfg(test)]
pub fn decide_symlink_action(existing: &ExistingLink, target: &Path) -> LinkAction {
    decide_symlink_action_in(existing, target, &durable_bin_dir())
}

/// `decide_symlink_action` with the durable directory passed in.
pub fn decide_symlink_action_in(existing: &ExistingLink, target: &Path, durable: &Path) -> LinkAction {
    match existing {
        ExistingLink::Absent => LinkAction::Create,
        ExistingLink::Other => LinkAction::Skip,
        ExistingLink::Symlink(current) => {
            if current == target {
                LinkAction::AlreadyCorrect
            } else if is_oxagen_managed_path_in(current, durable) {
                LinkAction::Replace
            } else {
                LinkAction::Skip
            }
        }
    }
}

/// What "Remove links" should do with one candidate path.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlinkAction {
    /// Nothing is there.
    Absent,
    Remove,
    /// Something we did not write: left where it is, reported as skipped.
    Keep,
}

/// The mirror of `decide_symlink_action`: remove only a symlink this
/// installer could have written, meaning one pointing at a target we link to
/// (`ours`) or at any Oxagen-owned location. A regular file, or a symlink
/// into a Homebrew prefix or a developer checkout that happens to share the
/// name, survives "Remove links" the same way it survives an install.
#[allow(dead_code)]
#[cfg(test)]
pub fn decide_unlink_action(existing: &ExistingLink, ours: &[PathBuf]) -> UnlinkAction {
    decide_unlink_action_in(existing, ours, &durable_bin_dir())
}

/// `decide_unlink_action` with the durable directory passed in.
#[allow(dead_code)]
pub fn decide_unlink_action_in(existing: &ExistingLink, ours: &[PathBuf], durable: &Path) -> UnlinkAction {
    match existing {
        ExistingLink::Absent => UnlinkAction::Absent,
        ExistingLink::Other => UnlinkAction::Keep,
        ExistingLink::Symlink(current) => {
            if ours.iter().any(|t| t == current) || is_oxagen_managed_path_in(current, durable) {
                UnlinkAction::Remove
            } else {
                UnlinkAction::Keep
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathPrecedence {
    /// Nothing on PATH claims this name yet: safe to link.
    Clear,
    /// Whatever already claims this name is ours — our own link inside
    /// `install_dir`, or (once a symlink is followed through) an
    /// Oxagen-owned location — so linking/replacing is safe.
    Ours,
    /// Something else already claims this name (a Homebrew install, a
    /// manual copy, anything not ours). Leave it alone: it wins over a link
    /// in the install dir, which the profile block appends to PATH.
    Shadowed,
}

/// Decide whether it's safe to link `name` given what it already resolves
/// to on PATH. `resolved` should be the *canonicalized* (symlinks followed)
/// path a PATH lookup for `name` found, if any — canonicalizing is what lets
/// a `~/.local/bin/oxagen` symlink that ultimately points at the app bundle
/// read as `Ours` even though canonicalizing walks it outside `install_dir`.
#[cfg(test)]
pub fn decide_path_precedence(resolved: Option<&Path>, install_dir: &Path) -> PathPrecedence {
    decide_path_precedence_in(resolved, install_dir, &durable_bin_dir())
}

/// `decide_path_precedence` with the durable directory passed in.
pub fn decide_path_precedence_in(resolved: Option<&Path>, install_dir: &Path, durable: &Path) -> PathPrecedence {
    match resolved {
        None => PathPrecedence::Clear,
        Some(p) if p.starts_with(install_dir) => PathPrecedence::Ours,
        Some(p) if is_oxagen_managed_path_in(p, durable) => PathPrecedence::Ours,
        Some(_) => PathPrecedence::Shadowed,
    }
}

// These three are exercised by `link_one`'s `#[cfg(windows)]` branch and by
// the unit tests below; a plain `cargo clippy --lib` on a non-Windows host
// checks neither, so the items are genuinely unreferenced from that build's
// perspective — the same situation `ADD_TO_USER_PATH_PS` is in, below.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShimAction {
    Create,
    Replace,
    AlreadyCorrect,
    Skip,
}

/// The Windows `.cmd` shim body `install_cli` writes for `target`.
#[allow(dead_code)]
pub fn windows_shim_content(target: &Path) -> String {
    format!("@\"{}\" %*\r\n", target.display())
}

/// Whether the `.cmd` shim for `name` is one Oxagen wrote. Every release has
/// written one shape, `windows_shim_content`'s `@"<dir>\<name>.exe" %*` and a
/// CRLF, so that shape is the only one that counts: a quoted path to
/// `<name>.exe` with no quote or line break in it, nothing before it and
/// nothing after it. A test checked only the `@"` prefix, so a hand-written
/// shim that starts the same way and does more was replaced on install and
/// deleted on uninstall.
#[allow(dead_code)]
pub fn shim_is_ours(text: &str, name: &str) -> bool {
    let Some(target) = text.strip_prefix("@\"").and_then(|rest| rest.strip_suffix("\" %*\r\n")) else {
        return false;
    };
    if target.contains(['"', '\r', '\n']) {
        return false;
    }
    let file = target.rsplit(['\\', '/']).next().unwrap_or_default();
    file.eq_ignore_ascii_case(&format!("{name}.exe"))
}

/// Decide what to do with a would-be `.cmd` shim given its current content:
/// rewrite only when it was written by us, so a hand-written shim or another
/// vendor's `oxagen.cmd` is left alone.
#[allow(dead_code)]
pub fn decide_shim_action(existing: Option<&str>, desired: &str, name: &str) -> ShimAction {
    match existing {
        None => ShimAction::Create,
        Some(text) if text == desired => ShimAction::AlreadyCorrect,
        Some(text) if shim_is_ours(text, name) => ShimAction::Replace,
        Some(_) => ShimAction::Skip,
    }
}

// ---------------------------------------------------------------------
// Profile-file targeting (pure)
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Other,
}

/// Classify a `$SHELL` value (a path or a bare name) by its basename.
pub fn detect_shell_kind(shell_path: &str) -> ShellKind {
    let name = shell_path.rsplit('/').next().unwrap_or(shell_path);
    match name {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "fish" => ShellKind::Fish,
        _ => ShellKind::Other,
    }
}

/// The one profile file we edit for a shell kind, or `None` when we make no
/// edit and hand back a manual instruction instead.
pub fn profile_path_for(kind: ShellKind, home: &Path, platform: &str) -> Option<PathBuf> {
    match kind {
        ShellKind::Zsh => Some(home.join(".zprofile")),
        ShellKind::Bash => {
            if platform == "macos" {
                Some(home.join(".bash_profile"))
            } else {
                Some(home.join(".bashrc"))
            }
        }
        ShellKind::Fish => Some(home.join(".config").join("fish").join("conf.d").join("oxagen.fish")),
        ShellKind::Other => None,
    }
}

const MARKER_BEGIN: &str = "# >>> oxagen >>>";
const MARKER_END: &str = "# <<< oxagen <<<";

/// A directory as the inside of a bash or zsh double-quoted string, where
/// `$`, `` ` ``, `"` and `\` are special. Unescaped, a `$` in a home
/// directory expands and a `"` ends the string.
pub fn sh_double_quote_escape(dir: &str) -> String {
    let mut out = String::with_capacity(dir.len());
    for c in dir.chars() {
        if matches!(c, '$' | '`' | '"' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The directory goes at the end of PATH. At the front it changed which
/// `python` or `claude` every new terminal found, for any other tool that
/// happens to live in `~/.local/bin`. Our own two names do not need the
/// front: the shadow check in `install_cli_locked` links a name only when
/// nothing earlier on PATH already answers to it.
fn path_export_line(dir: &str) -> String {
    format!("export PATH=\"$PATH:{}\"", sh_double_quote_escape(dir))
}

/// The line break a profile already uses, so an inserted block matches it.
fn eol_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn block_text(dir: &str, eol: &str) -> String {
    format!("{MARKER_BEGIN}{eol}{}{eol}{MARKER_END}{eol}", path_export_line(dir))
}

/// A directory as a fish single-quoted string, where only `\` and `'` are
/// special. Unquoted, a home directory with a space in it (`/Users/First
/// Last/.local/bin`) word-splits into two directories that do not exist
/// while the install still reports success. `path_export_line` does the same
/// job for bash and zsh.
pub fn fish_quote(dir: &str) -> String {
    format!("'{}'", dir.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// The whole-file content for the fish profile: fish's own `conf.d` file is
/// entirely ours, so there is no marker block, just `fish_add_path`. With no
/// flags it prepends to the universal `fish_user_paths`, which outlives this
/// file, so removing the file left the directory on PATH. `--global --path`
/// changes this session's PATH only, and `--append` puts it at the end for
/// the reason `path_export_line` gives.
pub fn fish_add_path_content(dir: &str) -> String {
    format!(
        "{MARKER_BEGIN}\nfish_add_path --global --path --append {}\n{MARKER_END}\n",
        fish_quote(dir)
    )
}

/// Whether an existing `conf.d/oxagen.fish` is one we wrote. The file is
/// whole-file ours, so there is no block to splice: either it opens with our
/// begin marker and may be rewritten or deleted, or someone else owns the
/// name and it is left exactly as it is.
#[allow(dead_code)]
pub fn fish_file_is_ours(text: &str) -> bool {
    text.starts_with(MARKER_BEGIN)
}

/// Whether a line is the one line our block carries between its markers:
/// the appending form `path_export_line` writes, or the prepending form an
/// earlier version wrote, so that block is still moved and removed.
fn is_path_export_line(line: &str) -> bool {
    (line.starts_with("export PATH=\"$PATH:") && line.ends_with('"'))
        || (line.starts_with("export PATH=\"") && line.ends_with(":$PATH\""))
}

/// The byte ranges of every block this module wrote: exactly a start marker
/// line, one `export PATH=` line (`is_path_export_line`) and an end marker
/// line. Anything else is not ours and is never used as a range boundary: a
/// start marker whose end line the user deleted, or a block the user added
/// lines to. So a user's own line can never fall inside a range. Each range
/// also covers the one line break `upsert_path_block` puts in front of a
/// block, which is what makes removal restore the file byte for byte.
fn find_path_blocks(text: &str) -> Vec<(usize, usize)> {
    // (start of line, the line without its break, end including its break)
    let mut lines: Vec<(usize, &str, usize)> = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let rest = &text[pos..];
        let (len, brk) = match rest.find('\n') {
            Some(i) if i > 0 && rest.as_bytes()[i - 1] == b'\r' => (i - 1, 2),
            Some(i) => (i, 1),
            None => (rest.len(), 0),
        };
        lines.push((pos, &rest[..len], pos + len + brk));
        pos += len + brk;
    }
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + 2 < lines.len() {
        let begin = lines[i].0;
        if lines[i].1 == MARKER_BEGIN && is_path_export_line(lines[i + 1].1) && lines[i + 2].1 == MARKER_END {
            let floor = ranges.last().map_or(0, |r| r.1);
            let before = &text[floor..begin];
            let start = if before.ends_with("\r\n") {
                begin - 2
            } else if before.ends_with('\n') {
                begin - 1
            } else {
                begin
            };
            ranges.push((start, lines[i + 2].2));
            i += 3;
        } else {
            i += 1;
        }
    }
    ranges
}

/// Remove every block this module wrote, and the one line break in front of
/// each, leaving every other byte as it was. A no-op without a block.
pub fn remove_path_block(existing: &str) -> String {
    let mut out = String::with_capacity(existing.len());
    let mut cursor = 0;
    for (start, end) in find_path_blocks(existing) {
        out.push_str(&existing[cursor..start]);
        cursor = end;
    }
    out.push_str(&existing[cursor..]);
    out
}

/// Append the block for `dir`, replacing any block this module wrote before.
/// Exactly one line break separates it from what precedes it (none in an
/// empty file) and it uses the file's own line endings, so
/// `remove_path_block(&upsert_path_block(x, d)) == x` for every `x`, and a
/// second identical upsert changes nothing.
pub fn upsert_path_block(existing: &str, dir: &str) -> String {
    let without = remove_path_block(existing);
    let eol = eol_of(&without);
    let block = block_text(dir, eol);
    if without.is_empty() {
        block
    } else {
        format!("{without}{eol}{block}")
    }
}

// ---------------------------------------------------------------------
// Managed state + the outcome shape `desktop_state` returns
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CliInstallView {
    /// `"linked" | "already" | "skipped" | "opted_out" | "failed" | "pending"`.
    pub state: String,
    pub dir: String,
    pub files: Vec<String>,
    pub skipped: Vec<String>,
    /// The shell profile file we edited, if any.
    pub profile: Option<String>,
    /// Windows: the install directory is on the user PATH — it already was,
    /// or the edit that put it there succeeded. A failed PowerShell edit
    /// leaves this false, so nothing tells the user they are linked when the
    /// shims sit in a directory no shell will look in. Always false on Unix,
    /// which reports the same thing through `profile`.
    pub path_updated: bool,
    pub note: String,
}

impl Default for CliInstallView {
    fn default() -> Self {
        Self {
            state: "pending".to_string(),
            dir: cli_install_dir().display().to_string(),
            files: Vec::new(),
            skipped: Vec::new(),
            profile: None,
            path_updated: false,
            note: "Checking whether the CLIs are on PATH…".to_string(),
        }
    }
}

/// One process-wide lock over the filesystem work: the launch-time install
/// runs on its own thread and can sit for seconds inside the login-shell
/// PATH probe, and `CliInstallState`'s mutex is only held long enough to
/// assign the view. Without this, a "Remove links" click landing inside that
/// window is undone the moment the probe returns.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// The guard every install/uninstall pass holds. A panic in an earlier pass
/// must not lock out every later one, and there is no state to be poisoned:
/// the lock guards `()`, not data.
fn install_guard() -> std::sync::MutexGuard<'static, ()> {
    INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Holds the outcome of the last automatic or manual install/uninstall so
/// `desktop_state` can report it without redoing the work on every poll.
pub struct CliInstallState(pub Mutex<CliInstallView>);

impl Default for CliInstallState {
    fn default() -> Self {
        Self(Mutex::new(CliInstallView::default()))
    }
}

impl CliInstallState {
    /// Replace the reported outcome. Every caller does this with
    /// `INSTALL_LOCK` still held, so the view stored last is the one from
    /// the pass that ran last. Stored after the lock was released, the
    /// launch-time install's "Linked" could land after a "Remove links" that
    /// ran in between and report links that were gone.
    pub fn set(&self, view: CliInstallView) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = view;
    }
}

// ---------------------------------------------------------------------
// Orchestration: copy sidecars, link/shim, and (Unix) the profile block
// ---------------------------------------------------------------------

#[cfg(not(windows))]
fn read_existing_link(path: &Path) -> ExistingLink {
    match fs::symlink_metadata(path) {
        Err(_) => ExistingLink::Absent,
        Ok(meta) if meta.file_type().is_symlink() => match fs::read_link(path) {
            Ok(target) => ExistingLink::Symlink(target),
            Err(_) => ExistingLink::Other,
        },
        Ok(_) => ExistingLink::Other,
    }
}

enum LinkOutcome {
    Linked(String),
    AlreadyCorrect,
    Skipped(String),
    Failed(String),
}

#[cfg(not(windows))]
fn link_one(dir: &Path, name: &str, target: &Path, durable: &Path) -> LinkOutcome {
    let link = dir.join(name);
    let existing = read_existing_link(&link);
    match decide_symlink_action_in(&existing, target, durable) {
        LinkAction::AlreadyCorrect => LinkOutcome::AlreadyCorrect,
        LinkAction::Skip => LinkOutcome::Skipped(format!(
            "{name}: {} was not created by Oxagen, left alone",
            link.display()
        )),
        LinkAction::Create | LinkAction::Replace => {
            let _ = fs::remove_file(&link);
            match std::os::unix::fs::symlink(target, &link) {
                Ok(()) => LinkOutcome::Linked(link.display().to_string()),
                Err(e) => LinkOutcome::Failed(format!("cannot link {}: {e}", link.display())),
            }
        }
    }
}

#[cfg(windows)]
fn link_one(dir: &Path, name: &str, target: &Path, _durable: &Path) -> LinkOutcome {
    let shim = dir.join(format!("{name}.cmd"));
    let desired = windows_shim_content(target);
    let existing = fs::read_to_string(&shim).ok();
    match decide_shim_action(existing.as_deref(), &desired, name) {
        ShimAction::AlreadyCorrect => LinkOutcome::AlreadyCorrect,
        ShimAction::Skip => LinkOutcome::Skipped(format!(
            "{name}: {} was not written by Oxagen, left alone",
            shim.display()
        )),
        ShimAction::Create | ShimAction::Replace => match fs::write(&shim, &desired) {
            Ok(()) => LinkOutcome::Linked(shim.display().to_string()),
            Err(e) => LinkOutcome::Failed(format!("cannot write {}: {e}", shim.display())),
        },
    }
}

/// Copy the two sidecars out of a transient directory into `durable_bin_dir`
/// so links, hooks and the service unit have a path that outlives this
/// launch. Returns the directory the links should target.
#[cfg(not(windows))]
fn keep_sidecars(sidecars: &Path, durable: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let durable = durable.to_path_buf();
    fs::create_dir_all(&durable).map_err(|e| format!("cannot create {}: {e}", durable.display()))?;
    for name in ["oxagen", "tacho"] {
        let from = sidecars.join(exe(name));
        let to = durable.join(exe(name));
        // Copy beside, then rename: a running daemon keeps its old inode
        // and the link never points at a half-written file.
        let staging = durable.join(staging_name(&exe(name)));
        let staged = fs::copy(&from, &staging)
            .map_err(|e| format!("cannot copy {} to {}: {e}", from.display(), staging.display()))
            .and_then(|_| {
                fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("cannot chmod {}: {e}", staging.display()))
            })
            .and_then(|()| {
                fs::rename(&staging, &to)
                    .map_err(|e| format!("cannot move {} to {}: {e}", staging.display(), to.display()))
            });
        if let Err(e) = staged {
            let _ = fs::remove_file(&staging);
            return Err(e);
        }
    }
    Ok(durable)
}

/// A staging name no other copy uses: this process's id and the time.
/// `INSTALL_LOCK` only orders the threads of one process, and a second app
/// instance copying at the same moment used to write into the same
/// `.tacho.tmp` as this one and rename a half-written binary into place.
#[cfg(not(windows))]
fn staging_name(file: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(".{file}.{}-{nanos}.tmp", std::process::id())
}

/// The PowerShell that appends a directory to the user PATH. The directory
/// travels out-of-band in `$env:OXAGEN_BIN`, never spliced into the script:
/// `%LOCALAPPDATA%` carries the user name, and `O'Brien` is a legal one
/// whose apostrophe would end a single-quoted literal and fail the parse.
///
/// An account that has never had a user-scoped `Path` reads back `$null`,
/// and calling `.TrimEnd` on it throws, so the value is normalized to an
/// empty string first and the separator is only written when there is
/// something to separate from.
///
/// The value is read and written in `HKCU\Environment` itself.
/// `[Environment]::GetEnvironmentVariable` returns it with every
/// `%USERPROFILE%` already expanded and `SetEnvironmentVariable` writes it
/// back as `REG_SZ`, so one edit froze the user's other entries to today's
/// paths for good. Read unexpanded, written as `REG_EXPAND_SZ`. Writing the
/// registry directly tells no one, so setting and clearing a throwaway user
/// variable afterward broadcasts `WM_SETTINGCHANGE` the way the .NET call
/// does, and a new terminal sees the change without a sign-out.
///
/// The directory is appended after a `;` and nothing else changes: the
/// value keeps a trailing `;` and any empty entries it had, so removing the
/// directory again gives back the value it held before, byte for byte.
#[allow(dead_code)]
const ADD_TO_USER_PATH_PS: &str = "$d=$env:OXAGEN_BIN; $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $p=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($null -eq $p){ $p='' }; if(($p -split ';') -notcontains $d){ if($p.Length -gt 0){ $p=$p+';'+$d } else { $p=$d }; $k.SetValue('Path',$p,[Microsoft.Win32.RegistryValueKind]::ExpandString); [Environment]::SetEnvironmentVariable('OXAGEN_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('OXAGEN_PATH_CHANGED',$null,'User') }; $k.Close()";

/// Run one of the two user-PATH scripts with the directory in
/// `$env:OXAGEN_BIN`. `CREATE_NO_WINDOW`: the app has no console, so
/// Windows would otherwise open one for PowerShell and flash it on screen.
#[cfg(windows)]
fn run_user_path_script(script: &str, dir: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("OXAGEN_BIN", dir)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("powershell exited {status}"))
    }
}

#[cfg(windows)]
fn add_to_user_path_windows(dir: &str) -> Result<(), String> {
    // setx truncates at 1024 characters; the registry API does not.
    run_user_path_script(ADD_TO_USER_PATH_PS, dir)
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn add_to_user_path_windows(_dir: &str) -> Result<(), String> {
    Ok(())
}

/// The inverse of `ADD_TO_USER_PATH_PS`: drop every entry equal to the
/// directory from the user PATH. "Remove links" used to leave the entry
/// behind, pointing at a directory with nothing in it. Same out-of-band
/// `$env:OXAGEN_BIN`, the same `$null` guard, and the same unexpanded read,
/// `REG_EXPAND_SZ` write and broadcast.
///
/// Only the directory's own entries go. Every other entry stays byte for
/// byte, empty ones and a trailing `;` included, and the value is written
/// only when an entry was dropped. When nothing else is left, the value is
/// deleted: it used to be written back as an empty string (#4318).
#[allow(dead_code)]
const REMOVE_FROM_USER_PATH_PS: &str = "$d=$env:OXAGEN_BIN; $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $p=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($null -ne $p){ $all=@($p -split ';'); $e=@($all | Where-Object { $_ -ne $d }); if($e.Count -ne $all.Count){ $n=($e -join ';'); if($n -eq ''){ $k.DeleteValue('Path') } else { $k.SetValue('Path',$n,[Microsoft.Win32.RegistryValueKind]::ExpandString) }; [Environment]::SetEnvironmentVariable('OXAGEN_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('OXAGEN_PATH_CHANGED',$null,'User') } }; $k.Close()";

#[cfg(windows)]
fn remove_from_user_path_windows(dir: &str) -> Result<(), String> {
    run_user_path_script(REMOVE_FROM_USER_PATH_PS, dir)
}

/// Wait up to `timeout` for `child`, killing it if it outlives the deadline.
/// Returns the collected stdout on a clean, zero-status exit.
///
/// stdout is read on its own thread while the child runs. Read only after
/// the exit, a login profile that printed more than a pipe holds (64 KiB)
/// blocked on its write, never exited, and the probe waited out the whole
/// timeout on every launch (#4318). The read after the exit is bounded by
/// what is left of the timeout too, because a background process the profile
/// started can hold the pipe open after the shell is gone.
#[cfg(not(windows))]
fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    let start = std::time::Instant::now();
    let (sender, received) = std::sync::mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            let _ = sender.send(buf);
        });
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    received.recv_timeout(timeout.saturating_sub(start.elapsed())).ok()
}

const PATH_BEGIN: &str = "__OXAGEN_PATH_BEGIN__";
const PATH_END: &str = "__OXAGEN_PATH_END__";

/// Pure: the PATH a login shell printed between `PATH_BEGIN` and `PATH_END`.
/// A profile that prints a banner, a fortune or an `nvm` notice writes to the
/// same stdout before (and a logout script after) the probe does, and all of
/// it used to be read as PATH.
#[cfg_attr(windows, allow(dead_code))]
pub fn path_between_sentinels(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_BEGIN)? + PATH_BEGIN.len();
    let len = stdout[start..].find(PATH_END)?;
    let path = stdout[start..start + len].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// `$SHELL -lc 'printf ...'`: what PATH looks like for a *new* terminal,
/// which differs from this process's own PATH (Tauri apps launch without
/// sourcing shell profiles at all on macOS/Linux). Falls back to the
/// process's own PATH when the probe fails or times out.
#[cfg(not(windows))]
fn login_shell_path(shell: &str) -> Option<String> {
    if shell.is_empty() {
        return None;
    }
    let child = std::process::Command::new(shell)
        .args(["-lc", &format!("printf '%s%s%s' '{PATH_BEGIN}' \"$PATH\" '{PATH_END}'")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let bytes = wait_with_timeout(child, Duration::from_secs(5))?;
    path_between_sentinels(&String::from_utf8_lossy(&bytes))
}

/// The PATH the shadow check and the profile-block decision both reason
/// about: the login shell's PATH on Unix (a Tauri app never sources shell
/// profiles itself, so this process's own PATH is not what a new terminal
/// sees), or simply the process's own PATH on Windows, where there is no
/// equivalent login-shell/process split. Computed once per install pass —
/// `login_shell_path` spawns a shell and waits up to 5s, so callers share
/// this rather than each probing separately.
fn effective_path_var(env: &InstallEnv) -> String {
    if let Some(path) = &env.login_path {
        return path.clone();
    }
    #[cfg(not(windows))]
    {
        login_shell_path(&env.roots.shell).unwrap_or_else(|| env.process_path.clone())
    }
    #[cfg(windows)]
    {
        env.process_path.clone()
    }
}

/// The profile bash reads at login on macOS. bash reads the FIRST of
/// `.bash_profile`, `.bash_login` and `.profile` that exists and stops, so
/// creating `.bash_profile` on a machine whose environment lives in
/// `.profile` switched that environment off: the user's own PATH, their
/// `nvm` and their aliases were gone from every new terminal, and removing
/// our block left the empty file still shadowing theirs. The block goes into
/// the file bash already reads. `.bash_profile` is created only when none of
/// the three exists.
pub fn bash_login_profile(home: &Path, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    for name in [".bash_profile", ".bash_login", ".profile"] {
        let candidate = home.join(name);
        if exists(&candidate) {
            return candidate;
        }
    }
    home.join(".bash_profile")
}

/// `desktop.json`'s `created` list: the files and directories an install had
/// to make, so removing the links can remove those too and leave the machine
/// as it found it. Anything the user has since put content in stays.
fn read_created(roots: &Roots) -> Vec<String> {
    read_json_object(&roots.desktop_config_path())
        .get("created")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn record_created(roots: &Roots, paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let path = roots.desktop_config_path();
    let mut config = read_json_object(&path);
    let mut created = read_created(roots);
    for item in paths {
        let text = item.display().to_string();
        if !created.contains(&text) {
            created.push(text);
        }
    }
    config.insert(
        "created".to_string(),
        Value::Array(created.into_iter().map(Value::String).collect()),
    );
    write_desktop_config(roots, &config)
}

/// Create `dir` and every missing parent, returning the ones that were made,
/// outermost first.
fn create_dir_tracking(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut missing = Vec::new();
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if current.exists() {
            break;
        }
        missing.push(current.to_path_buf());
        cursor = current.parent();
    }
    missing.reverse();
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(missing)
}

/// Add (or move) the marker block into the right profile file for the
/// user's login shell, unless `dir` is already on `path_var`. Returns the
/// profile file touched, or an error note when the shell isn't one we know
/// how to edit. Anything created on the way is pushed onto `created`.
#[cfg(not(windows))]
fn ensure_profile_block(
    roots: &Roots,
    dir: &Path,
    path_var: &str,
    created: &mut Vec<PathBuf>,
) -> Result<Option<String>, String> {
    if path_var_contains(path_var, dir) {
        return Ok(None);
    }
    let kind = detect_shell_kind(&roots.shell);
    let profile_path = if kind == ShellKind::Bash && roots.os == "macos" {
        bash_login_profile(&roots.home, &|p: &Path| p.exists())
    } else {
        let Some(path) = profile_path_for(kind, &roots.home, roots.os) else {
            return Err(format!(
                "{}: not on PATH for new terminals; add it to your shell's profile manually",
                dir.display()
            ));
        };
        path
    };
    // Read before anything is created or written. A profile that cannot be
    // read as text is left alone: see `machine::read_text`.
    let existing = crate::machine::read_text(&profile_path)?;
    let dir_text = dir.display().to_string();
    let updated = if kind == ShellKind::Fish {
        // This file is whole-file ours, so a file of the same name we did
        // not write is never replaced.
        if matches!(&existing, Some(text) if !fish_file_is_ours(text)) {
            return Err(format!("{}: not written by Oxagen, left alone", profile_path.display()));
        }
        fish_add_path_content(&dir_text)
    } else {
        upsert_path_block(existing.as_deref().unwrap_or(""), &dir_text)
    };
    if existing.as_deref() == Some(updated.as_str()) {
        return Ok(Some(profile_path.display().to_string()));
    }
    if let Some(parent) = profile_path.parent() {
        created.extend(create_dir_tracking(parent)?);
    }
    if existing.is_none() {
        created.push(profile_path.clone());
    }
    crate::machine::write_atomic(&profile_path, &updated)?;
    Ok(Some(profile_path.display().to_string()))
}

/// Remove the marker block (or, for fish, the whole ours-only file) from
/// every profile file we might have written it to. Safe to call whichever
/// shell is current now, since we don't know which one wrote it. Returns the
/// files changed and, separately, the ones that could not be: a block left
/// behind used to be reported as removed.
#[cfg(not(windows))]
fn remove_all_profile_blocks(roots: &Roots) -> (Vec<String>, Vec<String>) {
    let mut touched = Vec::new();
    let mut failed = Vec::new();
    let home = &roots.home;
    for name in [".zprofile", ".bash_profile", ".bash_login", ".profile", ".bashrc"] {
        let candidate = home.join(name);
        match crate::machine::read_text(&candidate) {
            Ok(Some(existing)) => {
                let updated = remove_path_block(&existing);
                if updated != existing {
                    match crate::machine::write_atomic(&candidate, &updated) {
                        Ok(()) => touched.push(candidate.display().to_string()),
                        Err(e) => failed.push(e),
                    }
                }
            }
            Ok(None) => {}
            // Not text we could have written a block into.
            Err(_) => {}
        }
    }
    let fish = home.join(".config").join("fish").join("conf.d").join("oxagen.fish");
    if matches!(crate::machine::read_text(&fish), Ok(Some(text)) if fish_file_is_ours(&text)) {
        match fs::remove_file(&fish) {
            Ok(()) => touched.push(fish.display().to_string()),
            Err(e) => failed.push(format!("cannot remove {}: {e}", fish.display())),
        }
    }
    (touched, failed)
}

/// Undo what `record_created` remembers: a file an install created is
/// removed once it is empty again, a directory once nothing is in it. What
/// could not be removed because the user now uses it stays, silently: it is
/// theirs.
fn remove_created(roots: &Roots) -> Vec<String> {
    let mut removed = Vec::new();
    let mut created = read_created(roots);
    // Deepest first, so a directory is looked at after what was in it.
    created.sort_by_key(|p| std::cmp::Reverse(p.len()));
    for item in &created {
        let path = PathBuf::from(item);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let gone = if meta.is_dir() {
            crate::machine::remove_dir_if_empty(&path)
        } else {
            meta.len() == 0 && fs::remove_file(&path).is_ok()
        };
        if gone {
            removed.push(item.clone());
        }
    }
    let mut config = read_json_object(&roots.desktop_config_path());
    if config.remove("created").is_some() {
        let _ = write_desktop_config(roots, &config);
    }
    removed
}

fn note_for(state: &str, view: &CliInstallView) -> String {
    match state {
        // Two routes land here: the bundled sidecar dir itself already on
        // PATH (Linux .deb/.rpm — dir is overridden to that bundled dir
        // before this is called), or both names already resolving to our
        // own link in cli_install_dir(). Either way view.dir is already the
        // right directory to name by the time this runs.
        "already" => format!("oxagen and tacho are on PATH from {}.", view.dir),
        "opted_out" => "Automatic linking is turned off; use \"Link into PATH\" to link manually.".to_string(),
        "linked" => {
            if let Some(profile) = &view.profile {
                format!("Linked into {}; added to {} for new terminals.", view.dir, profile)
            } else if cfg!(windows) {
                if view.path_updated {
                    "Linked into your user PATH; open a new terminal.".to_string()
                } else {
                    format!(
                        "Linked into {}, but it could not be added to your user PATH; see skipped.",
                        view.dir
                    )
                }
            } else {
                format!("Linked into {}, already on PATH.", view.dir)
            }
        }
        "skipped" => "Existing binaries were left alone; see skipped for details.".to_string(),
        _ => String::new(),
    }
}

/// The install itself, regardless of the opt-out flag: copy sidecars out of
/// a transient directory if needed, link or shim each one, and (Unix) make
/// sure the directory is on PATH for new terminals. For callers that
/// already hold `INSTALL_LOCK`, which is not reentrant, so nothing here may
/// take it again.
pub(crate) fn install_cli_locked(env: &InstallEnv) -> CliInstallView {
    let roots = &env.roots;
    let dir = roots.cli_install_dir();
    let durable = roots.durable_bin_dir();
    let mut view = CliInstallView {
        state: "pending".to_string(),
        dir: dir.display().to_string(),
        files: Vec::new(),
        skipped: Vec::new(),
        profile: None,
        path_updated: false,
        note: String::new(),
    };

    let Some(bundled) = env.sidecars.clone() else {
        view.state = "failed".to_string();
        view.note = "cannot locate the bundled binaries".to_string();
        return view;
    };
    for name in ["oxagen", "tacho"] {
        let target = bundled.join(exe(name));
        if !target.is_file() {
            view.state = "failed".to_string();
            view.note = format!("bundled {name} is missing at {}", target.display());
            return view;
        }
    }

    // Linux .deb/.rpm etc: externalBin already lives on PATH. Only a
    // durable sidecar directory counts. An AppImage mount, a mounted .dmg or
    // an App Translocation directory can be on PATH for this launch and be
    // gone by the next one, so that case falls through to the durable copy
    // and the links below rather than reporting itself installed.
    if !env.transient && path_var_contains(&env.process_path, &bundled) {
        view.state = "already".to_string();
        view.dir = bundled.display().to_string();
        view.note = note_for("already", &view);
        return view;
    }

    let mut created: Vec<PathBuf> = Vec::new();

    #[cfg(not(windows))]
    let sidecars = if env.transient {
        // Not exported to this process: see `export_bin_dir`.
        match create_dir_tracking(&durable).and_then(|made| {
            created.extend(made);
            keep_sidecars(&bundled, &durable)
        }) {
            Ok(kept) => kept,
            Err(e) => {
                view.state = "failed".to_string();
                view.note = e;
                return view;
            }
        }
    } else {
        bundled
    };
    #[cfg(windows)]
    let sidecars = bundled;

    // What a *new terminal* would resolve each name to, computed once
    // (login_shell_path spawns a shell). Linking into `dir` where `dir`
    // already comes early on PATH would silently shadow anything else that
    // already claims the name — e.g. a Homebrew `oxagen` later on PATH —
    // in every terminal opened from then on, even though the link
    // itself never overwrites a file. So a name that already resolves to
    // something that isn't ours is left alone entirely: not linked, and
    // (below) not allowed to trigger the profile-PATH edit on its own.
    let path_var = effective_path_var(env);

    // The probe above can take seconds, and the caller read the opt-out
    // before it. Re-read it here, with the lock held and nothing linked yet,
    // so a "Remove links" that landed in between is not undone.
    if !read_auto_link_cli(roots) {
        view.state = "opted_out".to_string();
        view.note = note_for("opted_out", &view);
        return view;
    }

    let mut shadowed = Vec::new();
    for name in ["oxagen", "tacho"] {
        let Some(found) = resolve_in_path_var(name, &path_var) else {
            continue;
        };
        let canonical = fs::canonicalize(&found).unwrap_or_else(|_| found.clone());
        if decide_path_precedence_in(Some(&canonical), &dir, &durable) == PathPrecedence::Shadowed {
            view.skipped
                .push(format!("{name} already on PATH at {}; left in place", found.display()));
            shadowed.push(name);
        }
    }

    // Nothing to link means nothing to create: a machine whose own `oxagen`
    // and `tacho` both win is left without a new `~/.local/bin`.
    if shadowed.len() < 2 {
        match create_dir_tracking(&dir) {
            Ok(made) => created.extend(made),
            Err(e) => {
                view.state = "failed".to_string();
                view.note = e;
                return view;
            }
        }
    }

    let mut any_ours = false;
    for name in ["oxagen", "tacho"] {
        if shadowed.contains(&name) {
            continue;
        }
        let target = sidecars.join(exe(name));
        match link_one(&dir, name, &target, &durable) {
            LinkOutcome::Linked(path) => {
                view.files.push(path);
                any_ours = true;
            }
            LinkOutcome::AlreadyCorrect => any_ours = true,
            LinkOutcome::Skipped(note) => view.skipped.push(note),
            LinkOutcome::Failed(err) => {
                let _ = record_created(roots, &created);
                view.state = "failed".to_string();
                view.note = err;
                return view;
            }
        }
    }

    // The profile/user-PATH edit only makes sense when at least one name
    // actually is (or now is) ours to answer for; if every name was
    // shadowed or otherwise skipped, touching PATH would only get a
    // still-foreign binary found faster, not fix anything.
    if any_ours {
        #[cfg(windows)]
        {
            let already = path_var_contains(&env.process_path, &dir);
            view.path_updated = already;
            if !already {
                match add_to_user_path_windows(&dir.display().to_string()) {
                    Ok(()) => view.path_updated = true,
                    Err(e) => view.skipped.push(format!("user PATH: {e}")),
                }
            }
        }
        #[cfg(not(windows))]
        {
            match ensure_profile_block(roots, &dir, &path_var, &mut created) {
                Ok(profile) => {
                    // On PATH for new terminals either way: it already was,
                    // or the profile now puts it there.
                    view.path_updated = true;
                    view.profile = profile;
                }
                Err(note) => view.skipped.push(note),
            }
        }
    }
    if let Err(e) = record_created(roots, &created) {
        view.skipped.push(format!("could not record what was created: {e}"));
    }

    view.state = if view.files.is_empty() && view.skipped.is_empty() {
        // Both names already resolved to us: nothing changed this launch.
        "already".to_string()
    } else if view.files.is_empty() && !any_ours {
        "skipped".to_string()
    } else {
        "linked".to_string()
    };
    view.note = note_for(&view.state, &view);
    view
}

/// The one entry point `lib.rs`'s `setup` calls on every launch, off the
/// main thread. Honours the `autoLinkCli` opt-out and never overwrites
/// anything the user or another tool put on PATH. The outcome goes into
/// `state` before the lock is released: see `CliInstallState::set`.
pub fn ensure_cli_installed(state: &CliInstallState) {
    ensure_cli_installed_in(&InstallEnv::real(), state);
}

pub(crate) fn ensure_cli_installed_in(env: &InstallEnv, state: &CliInstallState) -> CliInstallView {
    let _guard = install_guard();
    let view = if read_auto_link_cli(&env.roots) {
        install_cli_locked(env)
    } else {
        let dir = env.roots.cli_install_dir();
        let mut view = CliInstallView {
            state: "opted_out".to_string(),
            dir: dir.display().to_string(),
            files: Vec::new(),
            skipped: Vec::new(),
            profile: None,
            path_updated: false,
            note: String::new(),
        };
        view.note = note_for("opted_out", &view);
        view
    };
    state.set(view.clone());
    view
}

// ---------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------

#[derive(Serialize)]
pub struct InstallResult {
    /// `CliInstallView::state`: "linked", "already" or "skipped". A caller
    /// that read only `files` could not tell "both already linked" from
    /// "both left alone because a Homebrew `oxagen` wins".
    pub state: String,
    pub dir: String,
    pub files: Vec<String>,
    pub skipped: Vec<String>,
    pub on_path: bool,
    pub note: String,
    pub profile: Option<String>,
}

/// "Link into PATH" against an explicit environment: re-enables
/// `autoLinkCli` first, so an opted-out user clicking it explicitly gets
/// what they asked for. The outcome goes into `state` before the lock is
/// released: see `CliInstallState::set`.
pub(crate) fn link_cli_in(env: &InstallEnv, state: &CliInstallState) -> Result<CliInstallView, String> {
    // Re-enable inside the lock, so a concurrent "Remove links" cannot turn
    // the flag back off between this write and the re-read in
    // `install_cli_locked` and make an explicit click do nothing.
    let _guard = install_guard();
    write_auto_link_cli(&env.roots, true)?;
    let view = install_cli_locked(env);
    state.set(view.clone());
    Ok(view)
}

/// "Link into PATH": always runs, and updates the managed state
/// `desktop_state` reports. `async` so Tauri runs it off the main thread: it
/// can wait on `INSTALL_LOCK` while the launch-time pass probes the login
/// shell, then copy 240 MB of sidecars, and a synchronous command freezes
/// the window for all of it.
#[tauri::command(async)]
pub fn install_cli(state: tauri::State<CliInstallState>) -> Result<InstallResult, String> {
    let view = link_cli_in(&InstallEnv::real(), &state)?;
    if view.state == "failed" {
        return Err(view.note);
    }
    let result = InstallResult {
        state: view.state.clone(),
        dir: view.dir.clone(),
        files: view.files.clone(),
        skipped: view.skipped.clone(),
        // "already" with nothing skipped, or the PATH edit landed (Windows)
        // or was not needed or was made (Unix).
        on_path: view.state == "already" || view.path_updated,
        note: view.note,
        profile: view.profile,
    };
    Ok(result)
}

/// Every target a link we wrote can point at: this launch's sidecars and the
/// durable copy. A link at one of these is ours even when the app has since
/// moved, which is what `is_oxagen_managed_path` alone cannot tell us about
/// an unbundled (Linux tarball, developer) sidecar directory.
#[cfg(not(windows))]
fn our_link_targets(env: &InstallEnv) -> Vec<PathBuf> {
    let durable = env.roots.durable_bin_dir();
    let mut targets: Vec<PathBuf> = ["oxagen", "tacho"].iter().map(|name| durable.join(exe(name))).collect();
    if let Some(sidecars) = &env.sidecars {
        targets.extend(["oxagen", "tacho"].iter().map(|name| sidecars.join(exe(name))));
    }
    targets
}

/// Every candidate "Remove links" considers, each with the verdict from the
/// same ownership test the install path uses: the symlink per name on Unix,
/// the `.cmd` shim per name on Windows (the only platform that ever gets
/// one). `uninstall_cli` acts on this; `cli_links_present` only counts it,
/// so what the button says and what it does cannot disagree.
fn unlink_plan(env: &InstallEnv) -> Vec<(&'static str, PathBuf, UnlinkAction)> {
    let dir = env.roots.cli_install_dir();
    #[cfg(not(windows))]
    {
        let ours = our_link_targets(env);
        let durable = env.roots.durable_bin_dir();
        ["oxagen", "tacho"]
            .iter()
            .map(|name| {
                let link = dir.join(name);
                let action = decide_unlink_action_in(&read_existing_link(&link), &ours, &durable);
                (*name, link, action)
            })
            .collect()
    }
    #[cfg(windows)]
    {
        ["oxagen", "tacho"]
            .iter()
            .map(|name| {
                let shim = dir.join(format!("{name}.cmd"));
                let action = match fs::read_to_string(&shim) {
                    Ok(text) if shim_is_ours(&text, name) => UnlinkAction::Remove,
                    Ok(_) => UnlinkAction::Keep,
                    Err(_) => UnlinkAction::Absent,
                };
                (*name, shim, action)
            })
            .collect()
    }
}

/// Whether the install directory holds at least one link this app owns.
/// `on_path` cannot answer this: a GUI launch on macOS or Linux never
/// sources a shell profile, so the process's own PATH is missing the
/// install directory even in the second after we linked into it.
pub fn cli_links_present() -> bool {
    unlink_plan(&InstallEnv::real())
        .iter()
        .any(|(_, _, action)| *action == UnlinkAction::Remove)
}

/// What removing the links did.
#[derive(Debug, Default, Serialize)]
pub struct UnlinkOutcome {
    pub removed: Vec<String>,
    /// Left alone because Oxagen did not write it.
    pub skipped: Vec<String>,
    /// Ours, and still there: the reason for each.
    pub failed: Vec<String>,
}

/// Remove the links, the profile block, and whatever an install had to
/// create for them. Every step runs even when an earlier one failed: one
/// link that would not unlink used to return early, leaving the profile
/// block in place and the opt-out unwritten, so the next launch relinked.
pub(crate) fn unlink_cli_in(env: &InstallEnv) -> UnlinkOutcome {
    let mut outcome = UnlinkOutcome::default();
    for (name, candidate, action) in unlink_plan(env) {
        match action {
            UnlinkAction::Absent => {}
            UnlinkAction::Remove => match fs::remove_file(&candidate) {
                Ok(()) => outcome.removed.push(candidate.display().to_string()),
                Err(e) => outcome
                    .failed
                    .push(format!("cannot remove {}: {e}", candidate.display())),
            },
            UnlinkAction::Keep => outcome.skipped.push(format!(
                "{name}: {} was not created by Oxagen, left alone",
                candidate.display()
            )),
        }
    }
    #[cfg(not(windows))]
    {
        let (touched, failed) = remove_all_profile_blocks(&env.roots);
        outcome.removed.extend(touched);
        outcome.failed.extend(failed);
    }
    #[cfg(windows)]
    if let Err(e) = remove_from_user_path_windows(&env.roots.cli_install_dir().display().to_string()) {
        outcome.failed.push(format!("user PATH: {e}"));
    }
    outcome.removed.extend(remove_created(&env.roots));
    outcome
}

/// "Remove links": removes the symlinks/shims this installer wrote, strips
/// the profile block(s) it added, and turns off automatic re-linking on the
/// next launch. The sidecars themselves stay with the app. Ownership is
/// tested exactly as it is on the way in, so a `oxagen` in the same directory
/// that we refused to overwrite is also one we refuse to delete. `async` for
/// the same reason as `install_cli`.
#[tauri::command(async)]
pub fn uninstall_cli(state: tauri::State<CliInstallState>) -> Result<Vec<String>, String> {
    let _guard = install_guard();
    let env = InstallEnv::real();
    let outcome = unlink_cli_in(&env);
    write_auto_link_cli(&env.roots, false)?;
    state.set(CliInstallView {
        state: "opted_out".to_string(),
        dir: env.roots.cli_install_dir().display().to_string(),
        files: Vec::new(),
        skipped: outcome.skipped,
        profile: None,
        path_updated: false,
        note: note_for("opted_out", &CliInstallView::default()),
    });
    if !outcome.failed.is_empty() {
        return Err(outcome.failed.join("; "));
    }
    Ok(outcome.removed)
}

/// What "Uninstall" took off the machine, and what it could not.
#[derive(Debug, Default, Serialize)]
pub struct RemovalReport {
    pub removed: Vec<String>,
    /// Still on the machine, each with why.
    pub left: Vec<String>,
    /// The revoke a retired `host.json` still owed when Uninstall removed it.
    /// Nothing on the machine can finish it after that, so the report names
    /// the agent key for the person to revoke on the fleet page (audit D-06).
    pub pending_revoke: Option<crate::machine::PendingRevoke>,
}

/// Everything the app itself put on this machine, after `tacho unenroll` has
/// taken out the hooks and the service: the PATH links and the profile block,
/// the durable copy of the sidecars, and `~/.config/oxagen`. Refused while
/// the machine is still enrolled. A host `tacho unenroll` has retired (the
/// revoke could not reach the control plane) is not enrolled: refusing it
/// made an offline uninstall impossible, forever. What `desktop_state`
/// reports afterward goes into `state` before the lock is released: see
/// `CliInstallState::set`.
pub(crate) fn remove_everything_in(env: &InstallEnv, state: &CliInstallState) -> Result<RemovalReport, String> {
    use crate::machine::Enrollment;
    let _guard = install_guard();
    let roots = &env.roots;
    if crate::machine::enrollment(roots) == Enrollment::Live {
        return Err("this machine is still enrolled; unenroll first".into());
    }
    let mut report = RemovalReport {
        // Read now: `host.json` goes with the Tacho root below.
        pending_revoke: crate::machine::pending_revoke(roots),
        ..RemovalReport::default()
    };
    // Read now as well: `desktop.json` goes with `~/.config/oxagen`.
    let config_dir_created = config_dir_created(roots);
    // The durable copy: two ~120 MB binaries that nothing removed. Only when
    // the app is not running from it (it never is: the app runs its bundled
    // sidecars), and only the two files we copied plus the directories made
    // for them.
    let durable = roots.durable_bin_dir();
    for name in ["oxagen", "tacho"] {
        let file = durable.join(exe(name));
        if file.is_file() {
            match fs::remove_file(&file) {
                Ok(()) => report.removed.push(file.display().to_string()),
                Err(e) => report.left.push(format!("cannot remove {}: {e}", file.display())),
            }
        }
    }
    // The directories made for it go with `remove_created`, below.

    let links = unlink_cli_in(env);
    report.removed.extend(links.removed);
    report.left.extend(links.failed);
    report.left.extend(links.skipped);

    for dir in [roots.tacho_root(), roots.oxagen_dir()] {
        if fs::symlink_metadata(&dir).is_ok() {
            match fs::remove_dir_all(&dir) {
                Ok(()) => report.removed.push(dir.display().to_string()),
                Err(e) => report.left.push(format!("cannot remove {}: {e}", dir.display())),
            }
        }
    }
    // `~/.config` itself, only when the app recorded creating it and nothing
    // else is in it. An empty one the person already had stays (#4318).
    let config_dir = roots.home.join(".config");
    if config_dir_created && crate::machine::remove_dir_if_empty(&config_dir) {
        report.removed.push(config_dir.display().to_string());
    }
    state.set(CliInstallView {
        state: "opted_out".to_string(),
        dir: roots.cli_install_dir().display().to_string(),
        note: "Removed. Oxagen links the command line tools again the next time it opens.".to_string(),
        ..Default::default()
    });
    Ok(report)
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("oxagen-cli-install-test-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---- is_oxagen_managed_path ----

    #[test]
    fn recognizes_oxagen_owned_locations() {
        let durable = Path::new("/Users/dev/Library/Application Support/oxagen/bin");
        let ours = |p: &str| is_oxagen_managed_path_in(Path::new(p), durable);
        assert!(ours("/Applications/Oxagen.app/Contents/MacOS/oxagen"));
        assert!(ours("/Users/dev/Library/Application Support/oxagen/bin/oxagen"));
        assert!(is_oxagen_managed_path_in(
            Path::new("/home/dev/.local/share/oxagen/bin/tacho"),
            Path::new("/home/dev/.local/share/oxagen/bin"),
        ));
        assert!(ours("/tmp/.mount_OxagenAb12Cd/usr/bin/oxagen"));
        assert!(ours(
            "/private/var/folders/x/T/AppTranslocation/1234/d/Oxagen.app/Contents/MacOS/oxagen"
        ));
        assert!(ours("/Volumes/Oxagen/Oxagen.app/Contents/MacOS/oxagen"));
        assert!(ours("C:\\Program Files\\Oxagen\\bin\\oxagen.exe"));
        // The real durable directory, through the public wrapper.
        assert!(is_oxagen_managed_path(&durable_bin_dir().join("oxagen")));
    }

    #[test]
    fn rejects_third_party_locations_that_merely_contain_the_word() {
        let durable = Path::new("/Users/dev/Library/Application Support/oxagen/bin");
        let ours = |p: &str| is_oxagen_managed_path_in(Path::new(p), durable);
        assert!(!ours("/opt/homebrew/Cellar/oxagen/1.4.0/bin/oxagen"));
        assert!(!ours("/opt/homebrew/bin/oxagen"));
        assert!(!ours("/usr/local/bin/oxagen"));
        assert!(!ours("/home/dev/bin/oxagen"));
        // A developer checkout has an `oxagen/bin` pair but is not the copy.
        assert!(!ours("/Users/dev/src/oxagen/bin/oxagen"));
        // Another user's durable copy is not this user's.
        assert!(!ours("/Users/other/Library/Application Support/oxagen/bin/oxagen"));
        // A volume with the word in its name but no app bundle.
        assert!(!ours("/Volumes/oxagen-tools/bin/oxagen"));
        // Names that only resemble the bundle or the install directory.
        assert!(!ours("/Applications/NotOxagen.app/Contents/MacOS/oxagen"));
        assert!(!ours("C:\\Program Files\\OxagenTools\\oxagen.exe"));
    }

    // ---- decide_symlink_action ----

    #[test]
    fn symlink_action_covers_every_branch() {
        let target = Path::new("/Applications/Oxagen.app/Contents/MacOS/oxagen");
        assert_eq!(decide_symlink_action(&ExistingLink::Absent, target), LinkAction::Create);
        assert_eq!(decide_symlink_action(&ExistingLink::Other, target), LinkAction::Skip);
        assert_eq!(
            decide_symlink_action(&ExistingLink::Symlink(target.to_path_buf()), target),
            LinkAction::AlreadyCorrect
        );
        // An older app location (a mounted .dmg) or the durable copy:
        // recognized, replace.
        let stale = PathBuf::from("/Volumes/Oxagen/Oxagen.app/Contents/MacOS/oxagen");
        assert_eq!(
            decide_symlink_action(&ExistingLink::Symlink(stale), target),
            LinkAction::Replace
        );
        let durable = durable_bin_dir().join("oxagen");
        assert_eq!(
            decide_symlink_action(&ExistingLink::Symlink(durable), target),
            LinkAction::Replace
        );
        // A developer checkout: not ours, leave it.
        let checkout = PathBuf::from("/Users/dev/src/oxagen/bin/oxagen");
        assert_eq!(
            decide_symlink_action(&ExistingLink::Symlink(checkout), target),
            LinkAction::Skip
        );
        // A Homebrew install: not recognized, leave it.
        let foreign = PathBuf::from("/opt/homebrew/Cellar/oxagen/1.4.0/bin/oxagen");
        assert_eq!(
            decide_symlink_action(&ExistingLink::Symlink(foreign), target),
            LinkAction::Skip
        );
    }

    // ---- decide_unlink_action ----

    #[test]
    fn unlink_action_covers_every_branch() {
        let current = PathBuf::from("/Applications/Oxagen.app/Contents/MacOS/oxagen");
        let ours = vec![current.clone()];
        assert_eq!(decide_unlink_action(&ExistingLink::Absent, &ours), UnlinkAction::Absent);
        // A real binary someone dropped in under our name, not a link.
        assert_eq!(decide_unlink_action(&ExistingLink::Other, &ours), UnlinkAction::Keep);
        assert_eq!(
            decide_unlink_action(&ExistingLink::Symlink(current), &ours),
            UnlinkAction::Remove
        );
        // Locations we no longer link to but still recognize as ours.
        let stale = PathBuf::from("/Volumes/Oxagen/Oxagen.app/Contents/MacOS/oxagen");
        assert_eq!(
            decide_unlink_action(&ExistingLink::Symlink(stale), &ours),
            UnlinkAction::Remove
        );
        let durable = durable_bin_dir().join("oxagen");
        assert_eq!(
            decide_unlink_action(&ExistingLink::Symlink(durable), &ours),
            UnlinkAction::Remove
        );
    }

    #[test]
    fn uninstall_keeps_exactly_what_install_refuses_to_replace() {
        let target = Path::new("/Applications/Oxagen.app/Contents/MacOS/oxagen");
        let ours = vec![target.to_path_buf()];
        for existing in [
            ExistingLink::Other,
            ExistingLink::Symlink(PathBuf::from("/opt/homebrew/Cellar/oxagen/1.4.0/bin/oxagen")),
            ExistingLink::Symlink(PathBuf::from("/usr/local/bin/oxagen")),
            ExistingLink::Symlink(PathBuf::from("/Users/dev/src/oxagen/bin/oxagen")),
        ] {
            assert_eq!(decide_symlink_action(&existing, target), LinkAction::Skip);
            assert_eq!(decide_unlink_action(&existing, &ours), UnlinkAction::Keep);
        }
    }

    // ---- decide_path_precedence (PATH-shadow avoidance) ----

    #[test]
    fn path_precedence_covers_every_branch() {
        let install_dir = Path::new("/home/dev/.local/bin");

        // Nothing on PATH claims the name yet: fine to link.
        assert_eq!(decide_path_precedence(None, install_dir), PathPrecedence::Clear);

        // The existing resolution IS our own link in ~/.local/bin (the raw,
        // pre-canonicalize resolution would look like this on Windows,
        // where a shim is a regular file with no further symlink to
        // follow; a canonicalized Unix symlink through our own link would
        // instead show its ultimate target, covered by the next case).
        let ours_in_install_dir = install_dir.join("oxagen");
        assert_eq!(
            decide_path_precedence(Some(&ours_in_install_dir), install_dir),
            PathPrecedence::Ours
        );

        // Canonicalizing our own symlink walks it through to the app
        // bundle or the durable copy, outside install_dir — still ours,
        // recognized via is_oxagen_managed_path.
        let ours_elsewhere = PathBuf::from("/Applications/Oxagen.app/Contents/MacOS/oxagen");
        assert_eq!(
            decide_path_precedence(Some(&ours_elsewhere), install_dir),
            PathPrecedence::Ours
        );

        // A Homebrew install (or any other third party): shadowed, leave it.
        let foreign = PathBuf::from("/opt/homebrew/Cellar/oxagen/1.4.0/bin/oxagen");
        assert_eq!(
            decide_path_precedence(Some(&foreign), install_dir),
            PathPrecedence::Shadowed
        );
    }

    // ---- decide_shim_action / windows_shim_content ----

    #[test]
    fn shim_content_matches_the_documented_form() {
        let content = windows_shim_content(Path::new(r"C:\Program Files\Oxagen\oxagen.exe"));
        assert_eq!(content, "@\"C:\\Program Files\\Oxagen\\oxagen.exe\" %*\r\n");
    }

    #[test]
    fn shim_action_covers_every_branch() {
        let desired = windows_shim_content(Path::new(r"C:\Program Files\Oxagen\oxagen.exe"));
        assert_eq!(decide_shim_action(None, &desired, "oxagen"), ShimAction::Create);
        assert_eq!(
            decide_shim_action(Some(desired.as_str()), &desired, "oxagen"),
            ShimAction::AlreadyCorrect
        );
        let stale = windows_shim_content(Path::new(r"C:\Users\dev\AppData\Local\Oxagen\bin\oxagen.exe"));
        assert_eq!(
            decide_shim_action(Some(stale.as_str()), &desired, "oxagen"),
            ShimAction::Replace
        );
        assert_eq!(
            decide_shim_action(Some("@echo off\r\nsomething-else.exe %*\r\n"), &desired, "oxagen"),
            ShimAction::Skip
        );
    }

    /// #4318: only the one shape every release wrote is Oxagen's. A `.cmd`
    /// someone wrote by hand that also starts with `@"` is left alone.
    #[test]
    fn only_the_released_shim_shape_is_ours() {
        // The shape `windows_shim_content` has written since #3081, the only
        // released format: the durable copy and a bundled sidecar directory.
        for target in [
            r"C:\Users\dev\AppData\Local\oxagen\bin\oxagen.exe",
            r"C:\Program Files\Oxagen\oxagen.exe",
        ] {
            assert!(
                shim_is_ours(&windows_shim_content(Path::new(target)), "oxagen"),
                "{target}"
            );
        }
        assert!(shim_is_ours(
            &windows_shim_content(Path::new(r"C:\Program Files\Oxagen\tacho.exe")),
            "tacho"
        ));
        // Hand-written shims that start with `@"`.
        for text in [
            "@\"C:\\tools\\oxagen.exe\" --profile work %*\r\n",
            "@\"C:\\tools\\oxagen.exe\" %*\r\necho done\r\n",
            "@\"C:\\tools\\my-wrapper.exe\" %*\r\n",
            "@\"C:\\tools\\oxagen.exe\" %*\n",
            "@\"C:\\tools\\oxagen.exe\"\" %*\r\n",
            "@\"\" %*\r\n",
        ] {
            assert!(!shim_is_ours(text, "oxagen"), "{text:?}");
        }
        // The tacho shim is not the oxagen shim.
        assert!(!shim_is_ours(
            &windows_shim_content(Path::new(r"C:\Program Files\Oxagen\tacho.exe")),
            "oxagen"
        ));
        // Install leaves a hand-written one alone rather than replacing it.
        let desired = windows_shim_content(Path::new(r"C:\Program Files\Oxagen\oxagen.exe"));
        assert_eq!(
            decide_shim_action(
                Some("@\"C:\\tools\\oxagen.exe\" --profile work %*\r\n"),
                &desired,
                "oxagen"
            ),
            ShimAction::Skip
        );
    }

    // ---- PATH membership ----

    #[test]
    fn path_var_contains_matches_platform_separator() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let dir = Path::new("/home/dev/.local/bin");
        let path_var = format!("/usr/bin{sep}{}{sep}/bin", dir.display());
        assert!(path_var_contains(&path_var, dir));
        assert!(!path_var_contains(&path_var, Path::new("/opt/other")));
    }

    // ---- shell / profile targeting ----

    #[test]
    fn detects_known_shells_and_falls_back_to_other() {
        assert_eq!(detect_shell_kind("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(detect_shell_kind("/usr/bin/zsh"), ShellKind::Zsh);
        assert_eq!(detect_shell_kind("/bin/bash"), ShellKind::Bash);
        assert_eq!(detect_shell_kind("/usr/local/bin/fish"), ShellKind::Fish);
        assert_eq!(detect_shell_kind("/bin/dash"), ShellKind::Other);
        assert_eq!(detect_shell_kind(""), ShellKind::Other);
    }

    #[test]
    fn profile_path_matches_shell_and_platform() {
        let home = Path::new("/home/dev");
        assert_eq!(
            profile_path_for(ShellKind::Zsh, home, "macos"),
            Some(home.join(".zprofile"))
        );
        assert_eq!(
            profile_path_for(ShellKind::Zsh, home, "linux"),
            Some(home.join(".zprofile"))
        );
        assert_eq!(
            profile_path_for(ShellKind::Bash, home, "macos"),
            Some(home.join(".bash_profile"))
        );
        assert_eq!(
            profile_path_for(ShellKind::Bash, home, "linux"),
            Some(home.join(".bashrc"))
        );
        assert_eq!(
            profile_path_for(ShellKind::Fish, home, "linux"),
            Some(home.join(".config").join("fish").join("conf.d").join("oxagen.fish"))
        );
        assert_eq!(profile_path_for(ShellKind::Other, home, "linux"), None);
    }

    // ---- marker block insert/remove ----

    #[test]
    fn upsert_is_idempotent_and_preserves_surrounding_content() {
        let original = "export EDITOR=vim\nexport FOO=bar\n";
        let once = upsert_path_block(original, "/home/dev/.local/bin");
        assert!(once.starts_with(original));
        assert!(once.contains(MARKER_BEGIN));
        assert!(once.contains("export PATH=\"$PATH:/home/dev/.local/bin\""));
        let twice = upsert_path_block(&once, "/home/dev/.local/bin");
        assert_eq!(once, twice, "a second identical upsert must not change the file");
    }

    /// At the front of PATH the directory decided which `python` or `claude`
    /// every new terminal ran.
    #[test]
    fn the_block_appends_the_directory_to_path() {
        let block = upsert_path_block("", "/home/dev/.local/bin");
        assert!(
            block.contains("export PATH=\"$PATH:/home/dev/.local/bin\"\n"),
            "{block}"
        );
        assert!(!block.contains(":$PATH\""), "{block}");
    }

    #[test]
    fn a_prepending_block_from_an_earlier_version_is_moved_and_removed() {
        let old = "export FOO=bar\n\n# >>> oxagen >>>\nexport PATH=\"/home/dev/.local/bin:$PATH\"\n# <<< oxagen <<<\n";
        let upserted = upsert_path_block(old, "/home/dev/.local/bin");
        assert_eq!(upserted.matches(MARKER_BEGIN).count(), 1, "{upserted}");
        assert!(upserted.contains("export PATH=\"$PATH:/home/dev/.local/bin\""));
        assert_eq!(remove_path_block(&upserted), "export FOO=bar\n");
        assert_eq!(remove_path_block(old), "export FOO=bar\n");
    }

    #[test]
    fn the_directory_is_escaped_inside_the_double_quotes() {
        // Unescaped, `$HOME` expands, a backtick runs a command and `"` ends
        // the string.
        let dir = r#"/Users/a$HOME`id`"q\b/.local/bin"#;
        assert_eq!(sh_double_quote_escape(dir), r#"/Users/a\$HOME\`id\`\"q\\b/.local/bin"#);
        let block = upsert_path_block("export FOO=bar\n", dir);
        assert!(
            block.contains(r#"export PATH="$PATH:/Users/a\$HOME\`id\`\"q\\b/.local/bin""#),
            "{block}"
        );
        // Still recognized as ours: moved, not duplicated, and removable.
        assert_eq!(upsert_path_block(&block, dir), block);
        assert_eq!(remove_path_block(&block), "export FOO=bar\n");
    }

    /// The line bash reads back is the directory, byte for byte.
    #[cfg(not(windows))]
    #[test]
    fn a_shell_reading_the_block_gets_the_directory_back() {
        let dir = r#"/tmp/a b$HOME`id`"q\x"#;
        let script = format!("PATH=/usr/bin\n{}printf %s \"$PATH\"", upsert_path_block("", dir));
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("/usr/bin:{dir}"));
    }

    #[test]
    fn upsert_moves_a_stale_block_to_the_new_directory() {
        let once = upsert_path_block("", "/old/bin");
        assert!(once.contains("/old/bin"));
        let moved = upsert_path_block(&once, "/new/bin");
        assert!(!moved.contains("/old/bin"));
        assert!(moved.contains("/new/bin"));
        // Only ever one block.
        assert_eq!(moved.matches(MARKER_BEGIN).count(), 1);
    }

    #[test]
    fn remove_is_a_no_op_without_a_block() {
        let content = "# a normal profile\nexport FOO=bar\n";
        assert_eq!(remove_path_block(content), content);
    }

    #[test]
    fn remove_strips_exactly_the_block_we_own() {
        let content = "export FOO=bar\n\n# >>> oxagen >>>\nexport PATH=\"/x/bin:$PATH\"\n# <<< oxagen <<<\n";
        let removed = remove_path_block(content);
        assert_eq!(removed, "export FOO=bar\n");
    }

    #[test]
    fn remove_handles_crlf_line_endings() {
        let content = "export FOO=bar\r\n\r\n# >>> oxagen >>>\r\nexport PATH=\"/x/bin:$PATH\"\r\n# <<< oxagen <<<\r\n";
        let removed = remove_path_block(content);
        assert_eq!(removed, "export FOO=bar\r\n");
    }

    #[test]
    fn upsert_then_remove_restores_every_file_byte_for_byte() {
        for original in [
            "",
            "a",
            "a\n",
            "a\n\n",
            "\n",
            "a\r\n",
            "a\r\n\r\n",
            "export EDITOR=vim\n",
        ] {
            let inserted = upsert_path_block(original, "/home/dev/.local/bin");
            assert_eq!(remove_path_block(&inserted), original, "round trip of {original:?}");
            assert_eq!(
                upsert_path_block(&inserted, "/home/dev/.local/bin"),
                inserted,
                "second upsert of {original:?}"
            );
        }
        // A CRLF profile gets a CRLF block.
        assert!(upsert_path_block("a\r\n", "/x").ends_with("# <<< oxagen <<<\r\n"));
    }

    #[test]
    fn an_orphan_start_marker_is_never_a_range_boundary() {
        // The user deleted our end line; their own lines follow the orphan.
        let original = "# >>> oxagen >>>\nexport PATH=\"/old:$PATH\"\nexport KEEP=me\n";
        assert_eq!(remove_path_block(original), original);
        let once = upsert_path_block(original, "/home/dev/.local/bin");
        let twice = upsert_path_block(&once, "/home/dev/.local/bin");
        assert!(twice.contains("export KEEP=me"));
        assert_eq!(twice, once);
        assert_eq!(remove_path_block(&twice), original);
    }

    #[test]
    fn a_block_the_user_edited_is_left_alone() {
        let edited = "# >>> oxagen >>>\nexport PATH=\"/x/bin:$PATH\"\nexport MINE=1\n# <<< oxagen <<<\n";
        assert_eq!(remove_path_block(edited), edited);
        let upserted = upsert_path_block(edited, "/x/bin");
        assert!(upserted.starts_with(edited));
        assert_eq!(remove_path_block(&upserted), edited);
    }

    #[test]
    fn fish_content_is_whole_file_ownership() {
        let content = fish_add_path_content("/home/dev/.local/bin");
        assert!(content.contains("fish_add_path --global --path --append '/home/dev/.local/bin'"));
        assert!(content.contains(MARKER_BEGIN));
    }

    /// With no flags `fish_add_path` writes the universal `fish_user_paths`,
    /// which outlives `conf.d/oxagen.fish`, so removing the file left the
    /// directory on every fish's PATH.
    #[test]
    fn fish_changes_this_session_path_and_nothing_universal() {
        let content = fish_add_path_content("/home/dev/.local/bin");
        let line = content.lines().find(|l| l.starts_with("fish_add_path")).unwrap();
        for flag in ["--global", "--path", "--append"] {
            assert!(line.split(' ').any(|word| word == flag), "{line}");
        }
        assert!(!line.contains("-U") && !line.contains("--universal"), "{line}");
    }

    #[test]
    fn fish_quotes_the_directory_so_a_space_cannot_split_it() {
        let content = fish_add_path_content("/Users/First Last/.local/bin");
        assert!(content.contains("'/Users/First Last/.local/bin'"));
        // Inside fish single quotes only these two characters are special.
        assert_eq!(fish_quote(r"/tmp/o'brien\bin"), r"'/tmp/o\'brien\\bin'");
        // Backslashes are doubled before quotes are escaped, so the escape
        // we add is never doubled in turn.
        assert_eq!(fish_quote(r"a\b"), r"'a\\b'");
    }

    #[test]
    fn a_fish_file_we_did_not_write_is_not_ours() {
        assert!(fish_file_is_ours(&fish_add_path_content("/home/dev/.local/bin")));
        // Someone else's conf.d/oxagen.fish, and an empty one.
        assert!(!fish_file_is_ours("fish_add_path /opt/homebrew/bin\n"));
        assert!(!fish_file_is_ours("# my own oxagen setup\n"));
        assert!(!fish_file_is_ours(""));
    }

    // ---- autoLinkCli config merge ----

    #[test]
    fn auto_link_defaults_to_enabled_when_unset() {
        assert!(auto_link_cli_enabled_with(&Map::new(), true));
    }

    /// ADR-078: a machine with no coding agent on it belongs to someone who
    /// may never open a terminal, and linking two binaries into ~/.local/bin
    /// and editing their shell profile is a change they did not ask for.
    #[test]
    fn linking_defaults_off_on_a_machine_with_no_coding_agent() {
        assert!(!auto_link_cli_default(false));
        assert!(auto_link_cli_default(true));
        assert!(!auto_link_cli_enabled_with(&Map::new(), false));
        assert!(auto_link_cli_enabled_with(&Map::new(), true));
    }

    #[test]
    fn an_explicit_setting_beats_the_machine_in_both_directions() {
        // "Remove links" has to stay removed on a developer's machine, and
        // "Link into PATH" has to stay linked on anyone else's.
        let off = set_auto_link_cli(Map::new(), false);
        assert!(!auto_link_cli_enabled_with(&off, true));
        let on = set_auto_link_cli(Map::new(), true);
        assert!(auto_link_cli_enabled_with(&on, false));
    }

    #[test]
    fn a_coding_agent_in_any_well_known_directory_counts() {
        let dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/nope")];
        assert!(!developer_harness_in(&dirs, &|_p: &Path| false));
        let claude = PathBuf::from("/opt/homebrew/bin").join(exe("claude"));
        assert!(developer_harness_in(&dirs, &|p: &Path| p == claude));
        // Stella from cargo, in a directory that is not first in the list.
        let stella = PathBuf::from("/nope").join(exe("stella"));
        assert!(developer_harness_in(&dirs, &|p: &Path| p == stella));
        // Cursor's CLI ships as `cursor-agent`, not `cursor`.
        let cursor = PathBuf::from("/nope").join(exe("cursor-agent"));
        assert!(developer_harness_in(&dirs, &|p: &Path| p == cursor));
        // A connected app is not a coding agent: someone who has only Claude
        // Desktop is exactly who the off-by-default is for.
        let desktop = PathBuf::from("/opt/homebrew/bin").join(exe("claude-desktop"));
        assert!(!developer_harness_in(&dirs, &|p: &Path| p == desktop));
    }

    #[test]
    fn the_well_known_directories_are_real_absolute_paths() {
        let dirs = well_known_harness_dirs();
        assert!(dirs.len() >= 5);
        assert!(dirs.iter().all(|d| d.is_absolute()));
    }

    #[test]
    fn set_auto_link_cli_preserves_other_keys() {
        let mut config = Map::new();
        config.insert("someOtherPref".to_string(), Value::Bool(true));
        let updated = set_auto_link_cli(config, false);
        assert_eq!(updated.get("autoLinkCli"), Some(&Value::Bool(false)));
        assert_eq!(updated.get("someOtherPref"), Some(&Value::Bool(true)));
        assert!(!auto_link_cli_enabled_with(&updated, true));

        let restored = set_auto_link_cli(updated, true);
        assert!(auto_link_cli_enabled_with(&restored, true));
        assert_eq!(restored.get("someOtherPref"), Some(&Value::Bool(true)));
    }

    // ---- transient-directory classification (moved from lib.rs) ----

    #[test]
    fn transient_directories_are_the_per_launch_ones() {
        let read_only = |_: &Path| true;
        let t = |p: &str| is_transient_dir(Path::new(p), false, &read_only);
        assert!(t("/tmp/.mount_OxagenAb12Cd/usr/bin"));
        assert!(t("/Volumes/Oxagen/Oxagen.app/Contents/MacOS"));
        assert!(t(
            "/private/var/folders/x/T/AppTranslocation/1234-abcd/d/Oxagen.app/Contents/MacOS"
        ));
        assert!(is_transient_dir(Path::new("/usr/lib/oxagen"), true, &read_only));
        assert!(!t("/Applications/Oxagen.app/Contents/MacOS"));
        assert!(!t("/usr/lib/oxagen"));
        assert!(!t("C:\\Program Files\\Oxagen"));
        assert!(!t("/home/dev/.local/share/oxagen/bin"));
    }

    #[test]
    fn a_sidecar_gets_the_durable_copy_only_while_the_app_is_transient() {
        let durable = Path::new("/home/dev/.local/share/oxagen/bin");
        let env = sidecar_env_for(true, Some(durable));
        assert_eq!(
            env.get("TACHO_BIN_DIR").map(String::as_str),
            Some("/home/dev/.local/share/oxagen/bin")
        );
        assert_eq!(env.len(), 1);
        // No copy yet: tacho refuses to enroll from the transient directory.
        assert!(sidecar_env_for(true, None).is_empty());
        // A directory that lasts: tacho derives it itself.
        assert!(sidecar_env_for(false, Some(Path::new("/Applications/Oxagen.app/Contents/MacOS"))).is_empty());
    }

    /// An app copied to an external disk stays there, and counting it as a
    /// disk image copied 240 MB of sidecars on every launch.
    #[test]
    fn an_app_on_a_writable_external_disk_is_not_transient() {
        let writable = |_: &Path| false;
        assert!(!is_transient_dir(
            Path::new("/Volumes/External/Applications/Oxagen.app/Contents/MacOS"),
            false,
            &writable
        ));
        // Translocation is transient whatever the volume says.
        assert!(is_transient_dir(
            Path::new("/private/var/folders/x/T/AppTranslocation/1234/d/Oxagen.app/Contents/MacOS"),
            false,
            &writable
        ));
        // Only a `/Volumes` path asks about its volume: `/` is the sealed
        // read-only system volume on every Mac.
        let asked = std::cell::Cell::new(false);
        let probe = |_: &Path| {
            asked.set(true);
            true
        };
        assert!(!is_transient_dir(
            Path::new("/Applications/Oxagen.app/Contents/MacOS"),
            false,
            &probe
        ));
        assert!(!asked.get());
    }

    #[test]
    fn the_mount_table_tells_a_disk_image_from_an_external_disk() {
        let table = "\
/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)
/dev/disk5s1 on /Volumes/Oxagen (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by dev)
/dev/disk6s2 on /Volumes/Backup on Tuesday (apfs, local, nodev, nosuid, journaled, noowners)
/dev/disk7s1 on /Volumes/Oxagen 1 (apfs, local, nodev, nosuid, journaled, noowners)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
";
        let ro = |p: &str| mount_table_read_only(table, Path::new(p));
        assert_eq!(ro("/Volumes/Oxagen/Oxagen.app/Contents/MacOS"), Some(true));
        assert_eq!(ro("/Volumes/Backup on Tuesday/Oxagen.app/Contents/MacOS"), Some(false));
        // A name that merely starts with another volume's is its own volume.
        assert_eq!(ro("/Volumes/Oxagen 1/Oxagen.app/Contents/MacOS"), Some(false));
        // Not a volume the table lists: `/` alone does not answer.
        assert_eq!(ro("/Volumes/Gone/Oxagen.app/Contents/MacOS"), None);
    }

    #[test]
    fn the_path_script_reads_the_directory_from_the_environment() {
        // No user-derived text is spliced into the script, so a directory
        // with an apostrophe cannot end a literal.
        assert!(ADD_TO_USER_PATH_PS.contains("$env:OXAGEN_BIN"));
        assert!(!ADD_TO_USER_PATH_PS.contains("{dir}"));
        assert!(!ADD_TO_USER_PATH_PS.contains("{}"));
    }

    /// `[Environment]::GetEnvironmentVariable('Path','User')` expands every
    /// `%USERPROFILE%` and `SetEnvironmentVariable` writes `REG_SZ`, so one
    /// edit froze the user's other PATH entries for good.
    #[test]
    fn the_path_scripts_keep_the_user_path_unexpanded() {
        for script in [ADD_TO_USER_PATH_PS, REMOVE_FROM_USER_PATH_PS] {
            assert!(script.contains("CurrentUser.CreateSubKey('Environment')"), "{script}");
            assert!(
                script.contains(
                    "GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)"
                ),
                "{script}"
            );
            assert!(
                script.contains("SetValue('Path',")
                    && script.contains("[Microsoft.Win32.RegistryValueKind]::ExpandString"),
                "{script}"
            );
            assert!(!script.contains("GetEnvironmentVariable('Path'"), "{script}");
            assert!(!script.contains("SetEnvironmentVariable('Path'"), "{script}");
            // The registry write tells no one; setting and clearing a user
            // variable broadcasts WM_SETTINGCHANGE, after the write.
            let write = script.find("SetValue('Path',").unwrap();
            let set = script
                .find("SetEnvironmentVariable('OXAGEN_PATH_CHANGED','1','User')")
                .unwrap();
            let clear = script
                .find("SetEnvironmentVariable('OXAGEN_PATH_CHANGED',$null,'User')")
                .unwrap();
            assert!(write < set && set < clear, "{script}");
        }
    }

    #[test]
    fn the_path_script_survives_an_account_with_no_user_path() {
        // `GetValue('Path', ...)` is null on an account that has never had
        // one, and a method call on it throws: the shims get written and
        // nothing puts their directory on PATH. The script has to normalize
        // null first, and must not leave a leading separator.
        assert!(ADD_TO_USER_PATH_PS.contains("if($null -eq $p){ $p='' }"));
        let normalize = ADD_TO_USER_PATH_PS.find("$null -eq $p").expect("null check");
        let split = ADD_TO_USER_PATH_PS.find("($p -split ';')").expect("split");
        assert!(normalize < split, "null must be normalized before the value is used");
        assert!(ADD_TO_USER_PATH_PS.contains("if($p.Length -gt 0){ $p=$p+';'+$d } else { $p=$d }"));
    }

    /// #4318: neither script trims the value or drops its empty entries, and
    /// removing the last entry deletes the value instead of writing `''`.
    #[test]
    fn the_path_scripts_keep_every_other_entry_as_it_was() {
        for script in [ADD_TO_USER_PATH_PS, REMOVE_FROM_USER_PATH_PS] {
            assert!(!script.contains("TrimEnd"), "{script}");
            assert!(!script.contains("$_ -ne ''"), "{script}");
        }
        assert!(REMOVE_FROM_USER_PATH_PS.contains("if($n -eq ''){ $k.DeleteValue('Path') }"));
        // The value is written only when an entry was dropped.
        assert!(REMOVE_FROM_USER_PATH_PS.contains("if($e.Count -ne $all.Count)"));
    }

    /// #4318: both scripts against this runner's real `HKCU\Environment`.
    /// Each case writes a starting value, adds and removes a scratch
    /// directory, and reads the value back. The account's own value goes
    /// back afterward, whatever happens. The Windows leg of desktop-rig.yml
    /// runs it.
    #[cfg(windows)]
    #[test]
    fn the_user_path_scripts_round_trip_the_real_registry_value() {
        use std::process::Command;
        fn ps(script: &str, value: Option<&str>) -> String {
            let mut command = Command::new("powershell");
            command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            if let Some(value) = value {
                command.env("OXAGEN_RIG_VALUE", value);
            }
            let out = command.output().expect("powershell runs");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout)
                .trim_end_matches(['\r', '\n'])
                .to_string()
        }
        const READ: &str = "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); $v=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($null -eq $v){ [Console]::Out.Write('ABSENT') } else { [Console]::Out.Write([string]$k.GetValueKind('Path') + '|' + $v) }";
        const WRITE: &str = "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $k.SetValue('Path',$env:OXAGEN_RIG_VALUE,[Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()";
        const WRITE_SZ: &str = "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $k.SetValue('Path',$env:OXAGEN_RIG_VALUE,[Microsoft.Win32.RegistryValueKind]::String); $k.Close()";
        const DELETE: &str = "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $k.DeleteValue('Path',$false); $k.Close()";
        let read = || ps(READ, None);
        let set = |value: Option<&str>| match value {
            Some(value) => {
                ps(WRITE, Some(value));
            }
            None => {
                ps(DELETE, None);
            }
        };

        /// Puts the account's own value back when the test ends, even on a
        /// failed assertion.
        struct Restore(String);
        impl Drop for Restore {
            fn drop(&mut self) {
                match self.0.split_once('|') {
                    None => {
                        ps(DELETE, None);
                    }
                    Some(("String", value)) => {
                        ps(WRITE_SZ, Some(value));
                    }
                    Some((_, value)) => {
                        ps(WRITE, Some(value));
                    }
                }
            }
        }
        let _restore = Restore(read());

        let dir = r"C:\oxagen-rig-4318\Oxagen\bin";
        // (starting value, after add, after remove)
        let cases: [(Option<&str>, String, Option<&str>); 4] = [
            (None, format!("ExpandString|{dir}"), None),
            (
                Some(r"C:\a;;%USERPROFILE%\b;"),
                format!(r"ExpandString|C:\a;;%USERPROFILE%\b;;{dir}"),
                Some(r"C:\a;;%USERPROFILE%\b;"),
            ),
            (
                Some(r"%USERPROFILE%\bin"),
                format!(r"ExpandString|%USERPROFILE%\bin;{dir}"),
                Some(r"%USERPROFILE%\bin"),
            ),
            (Some(r";C:\a"), format!(r"ExpandString|;C:\a;{dir}"), Some(r";C:\a")),
        ];
        for (start, added, removed) in cases {
            set(start);
            add_to_user_path_windows(dir).unwrap();
            assert_eq!(read(), added, "add to {start:?}");
            // A second add changes nothing.
            add_to_user_path_windows(dir).unwrap();
            assert_eq!(read(), added, "second add to {start:?}");
            remove_from_user_path_windows(dir).unwrap();
            let want = removed.map_or("ABSENT".to_string(), |v| format!("ExpandString|{v}"));
            assert_eq!(read(), want, "remove from {start:?}");
        }

        // Oxagen's directory as the only entry: the value goes, not ''.
        set(Some(dir));
        remove_from_user_path_windows(dir).unwrap();
        assert_eq!(read(), "ABSENT");
        // In the middle, with a trailing `;`: only its own entry goes.
        let middle = format!(r"C:\a;{dir};C:\b;");
        set(Some(middle.as_str()));
        remove_from_user_path_windows(dir).unwrap();
        assert_eq!(read(), r"ExpandString|C:\a;C:\b;");
        // Not there: the value is not rewritten, so a plain REG_SZ stays one.
        ps(WRITE_SZ, Some(r"C:\a;;"));
        remove_from_user_path_windows(dir).unwrap();
        assert_eq!(read(), r"String|C:\a;;");
    }

    #[test]
    fn a_failed_user_path_edit_is_not_reported_as_linked() {
        // The Windows branch only claims the PATH when the edit landed; the
        // note has to say so too, or a user whose PowerShell failed is told
        // to open a new terminal that will still not find the shims.
        let mut view = CliInstallView {
            state: "linked".to_string(),
            dir: "C:\\Users\\a\\AppData\\Local\\Oxagen\\bin".to_string(),
            files: vec!["oxagen.cmd".to_string()],
            skipped: vec!["user PATH: powershell exited 1".to_string()],
            profile: None,
            path_updated: false,
            note: String::new(),
        };
        view.note = note_for("linked", &view);
        if cfg!(windows) {
            assert!(view.note.contains("could not be added"), "{}", view.note);
            view.path_updated = true;
            view.note = note_for("linked", &view);
            assert!(view.note.contains("Linked into your user PATH"), "{}", view.note);
        } else {
            // Unix never reads path_updated: PATH is the profile's business.
            assert!(view.note.contains("already on PATH"), "{}", view.note);
        }
    }

    // ---- link_one against a real (temp) directory, Unix only ----

    #[cfg(not(windows))]
    #[test]
    fn link_one_creates_replaces_and_skips_on_real_symlinks() {
        let dir = unique_temp_dir("link-one");
        // An older app bundle's MacOS directory, so is_oxagen_managed_path
        // recognizes links into it as ours.
        let old_oxagen_dir =
            std::env::temp_dir().join(format!("oxagen-cli-install-test-old-app-{}", std::process::id()));
        let old_macos = old_oxagen_dir.join("Oxagen.app").join("Contents").join("MacOS");
        fs::create_dir_all(&old_macos).unwrap();
        let stale_target = old_macos.join("oxagen");
        fs::write(&stale_target, b"stale").unwrap();

        let foreign_dir = std::env::temp_dir().join("not-oxagen-at-all");
        fs::create_dir_all(&foreign_dir).unwrap();
        let foreign_target = foreign_dir.join("oxagen");
        fs::write(&foreign_target, b"foreign").unwrap();

        let current_target = dir.join("target-current");
        fs::write(&current_target, b"current").unwrap();

        // Absent -> Created.
        assert!(matches!(
            link_one(&dir, "oxagen", &current_target, &durable_bin_dir()),
            LinkOutcome::Linked(_)
        ));
        assert_eq!(fs::read_link(dir.join("oxagen")).unwrap(), current_target);

        // Same target again -> AlreadyCorrect, no error, link unchanged.
        assert!(matches!(
            link_one(&dir, "oxagen", &current_target, &durable_bin_dir()),
            LinkOutcome::AlreadyCorrect
        ));

        // Points at a recognizably Oxagen-owned path that isn't the current
        // target (an older app location, or the durable copy) -> Replace.
        let _ = fs::remove_file(dir.join("oxagen"));
        std::os::unix::fs::symlink(&stale_target, dir.join("oxagen")).unwrap();
        assert!(matches!(
            link_one(&dir, "oxagen", &current_target, &durable_bin_dir()),
            LinkOutcome::Linked(_)
        ));
        assert_eq!(fs::read_link(dir.join("oxagen")).unwrap(), current_target);

        // Points somewhere we don't recognize (a third-party install) ->
        // Skip, left untouched.
        let _ = fs::remove_file(dir.join("oxagen"));
        std::os::unix::fs::symlink(&foreign_target, dir.join("oxagen")).unwrap();
        assert!(matches!(
            link_one(&dir, "oxagen", &current_target, &durable_bin_dir()),
            LinkOutcome::Skipped(_)
        ));
        assert_eq!(fs::read_link(dir.join("oxagen")).unwrap(), foreign_target);

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&old_oxagen_dir);
        let _ = fs::remove_dir_all(&foreign_dir);
    }

    // ---- the durable copy ----

    /// A second app instance copying at the same moment: its staging file is
    /// not this one's to write into or rename away.
    #[cfg(not(windows))]
    #[test]
    fn the_durable_copy_stages_under_a_name_no_other_instance_uses() {
        let base = unique_temp_dir("keep");
        let sidecars = base.join("mount");
        let durable = base.join("durable");
        fs::create_dir_all(&sidecars).unwrap();
        fs::create_dir_all(&durable).unwrap();
        for name in ["oxagen", "tacho"] {
            fs::write(sidecars.join(name), format!("{name} v2")).unwrap();
        }
        // Where every instance used to stage, mid-copy in another process.
        let theirs = durable.join(".tacho.tmp");
        fs::write(&theirs, b"half a binary").unwrap();

        assert_eq!(keep_sidecars(&sidecars, &durable).unwrap(), durable);
        assert_eq!(fs::read(durable.join("tacho")).unwrap(), b"tacho v2");
        assert_eq!(fs::read(&theirs).unwrap(), b"half a binary");
        let mut left: Vec<String> = fs::read_dir(&durable)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, [".tacho.tmp", "oxagen", "tacho"]);

        let staged = staging_name("tacho");
        assert!(
            staged.starts_with(&format!(".tacho.{}-", std::process::id())),
            "{staged}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(not(windows))]
    #[test]
    fn a_failed_durable_copy_leaves_no_staging_file_behind() {
        let base = unique_temp_dir("keep-fail");
        let sidecars = base.join("mount");
        let durable = base.join("durable");
        fs::create_dir_all(&sidecars).unwrap();
        for name in ["oxagen", "tacho"] {
            fs::write(sidecars.join(name), name).unwrap();
        }
        // A directory where the binary goes: the copy lands, the rename fails.
        fs::create_dir_all(durable.join("oxagen").join("in-use")).unwrap();
        let err = keep_sidecars(&sidecars, &durable).unwrap_err();
        assert!(err.contains("cannot move"), "{err}");
        let stray: Vec<_> = fs::read_dir(&durable)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "{stray:?}");
        let _ = fs::remove_dir_all(&base);
    }

    // ---- the login-shell PATH probe ----

    /// #4318: a login profile that prints 128 KiB, twice what a pipe holds,
    /// used to block on its write until the 5 s timeout killed it, and the
    /// probe fell back to the process PATH. It now answers at once.
    #[cfg(not(windows))]
    #[test]
    fn a_login_profile_that_prints_128_kib_does_not_stall_the_path_probe() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_temp_dir("chatty-profile");
        let shell = dir.join("chatty-sh");
        // Called as `<shell> -lc <command>`: print 128 KiB the way a noisy
        // profile does, then run the command without a login profile.
        fs::write(
            &shell,
            "#!/bin/sh\nhead -c 131072 /dev/zero | tr '\\0' x\nexec /bin/sh -c \"$2\"\n",
        )
        .unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
        // A few tries, for the "text file busy" race described in
        // `a_profile_banner_is_not_read_as_path`. Each try is timed on its own.
        let answer = (0..5).find_map(|_| {
            let start = std::time::Instant::now();
            login_shell_path(&shell.display().to_string()).map(|path| (path, start.elapsed()))
        });
        let (path, elapsed) = answer.expect("the probe read no PATH back");
        assert!(!path.is_empty());
        assert!(elapsed < Duration::from_secs(3), "the probe took {elapsed:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_login_path_is_read_between_the_sentinels() {
        let path = "/usr/local/bin:/usr/bin:/bin";
        let wrapped = format!("{PATH_BEGIN}{path}{PATH_END}");
        assert_eq!(path_between_sentinels(&wrapped).as_deref(), Some(path));
        // A profile banner before it and a logout message after it.
        let noisy = format!("Welcome back!\nnvm: using node 22\n{wrapped}\nlogout\n");
        assert_eq!(path_between_sentinels(&noisy).as_deref(), Some(path));
        // No sentinels, an unterminated probe, or an empty PATH: no answer,
        // and the caller falls back to this process's own PATH.
        assert_eq!(path_between_sentinels(path), None);
        assert_eq!(path_between_sentinels(&format!("{PATH_BEGIN}{path}")), None);
        assert_eq!(path_between_sentinels(&format!("{PATH_BEGIN}{PATH_END}")), None);
    }

    /// A real shell whose profile prints a banner, run the way the probe
    /// runs `$SHELL`.
    #[cfg(not(windows))]
    #[test]
    fn a_profile_banner_is_not_read_as_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_temp_dir("login-shell");
        let shell = dir.join("chatty-sh");
        fs::write(
            &shell,
            "#!/bin/sh\necho 'Last login: today'\nPATH=/opt/probe/bin:/usr/bin\nexport PATH\n/bin/sh -c \"$2\"\necho bye\n",
        )
        .unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
        // A few tries: a test on another thread that forks while the script
        // is still open for writing makes the first exec fail with "text
        // file busy", which the probe reports as no answer.
        let path = (0..5).find_map(|_| login_shell_path(&shell.display().to_string()));
        assert_eq!(path.as_deref(), Some("/opt/probe/bin:/usr/bin"));
        let _ = fs::remove_dir_all(&dir);
    }
}
