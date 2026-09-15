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
//! `decide_shim_action`, `is_oxagen_managed_path`, `upsert_path_block`,
//! `remove_path_block`, `profile_path_for`, `detect_shell_kind`,
//! `path_var_contains`, `auto_link_cli_enabled`.

use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
/// mounted disk image (`/Volumes/*`), or App Translocation (a quarantined
/// app opened where it was downloaded). `tacho enroll` bakes the sidecar's
/// directory into the hook commands and the service unit, and PATH links
/// point into it, so nothing durable may reference such a directory.
pub fn is_transient_dir(dir: &Path, appimage_env: bool) -> bool {
    let text = dir.to_string_lossy().replace('\\', "/");
    text.starts_with("/tmp/.mount_")
        || text.contains("/AppTranslocation/")
        || text.starts_with("/Volumes/")
        || appimage_env
}

pub fn sidecar_dir_is_transient() -> bool {
    sidecar_dir()
        .map(|dir| is_transient_dir(&dir, std::env::var_os("APPIMAGE").is_some()))
        .unwrap_or(false)
}

/// A per-user directory the app copies the sidecars into when it runs from
/// a transient one: `~/Library/Application Support/oxagen/bin` on macOS,
/// `~/.local/share/oxagen/bin` on Linux. Windows installs are never
/// transient (the shims embed the Program Files path).
pub fn durable_bin_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("oxagen")
        .join("bin")
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

/// Point every sidecar the app spawns at the durable copy (they inherit the
/// app's environment): with `TACHO_BIN_DIR` set, `tacho` writes that path
/// into hooks and the service unit instead of its own transient one.
pub fn export_bin_dir() {
    if sidecar_dir_is_transient() {
        if let Some(dir) = bin_dir() {
            std::env::set_var("TACHO_BIN_DIR", dir);
        }
    }
}

pub fn on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe(name));
        if candidate.is_file() {
            return Some(candidate.display().to_string());
        }
        if cfg!(windows) {
            let cmd = dir.join(format!("{name}.cmd"));
            if cmd.is_file() {
                return Some(cmd.display().to_string());
            }
        }
    }
    None
}

/// Where the PATH links go: a directory the user owns on every platform.
pub fn cli_install_dir() -> PathBuf {
    if cfg!(windows) {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Oxagen")
            .join("bin")
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local")
            .join("bin")
    }
}

/// `~/.config/oxagen/desktop.json`: the one preference this module owns.
fn desktop_config_path() -> PathBuf {
    crate::oxagen_dir().join("desktop.json")
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    crate::read_json(path)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_json_object(path: &Path, obj: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(obj.clone())).unwrap_or_else(|_| "{}".to_string());
    fs::write(path, text).map_err(|e| e.to_string())
}

/// Pure: whether automatic linking is enabled, defaulting to on for a
/// config file that doesn't mention it yet.
pub fn auto_link_cli_enabled(config: &Map<String, Value>) -> bool {
    config.get("autoLinkCli").and_then(Value::as_bool).unwrap_or(true)
}

/// Pure: merge `autoLinkCli` into an existing config map, keeping every
/// other key untouched.
pub fn set_auto_link_cli(mut config: Map<String, Value>, enabled: bool) -> Map<String, Value> {
    config.insert("autoLinkCli".to_string(), Value::Bool(enabled));
    config
}

fn write_auto_link_cli(enabled: bool) -> Result<(), String> {
    let path = desktop_config_path();
    let config = set_auto_link_cli(read_json_object(&path), enabled);
    write_json_object(&path, &config)
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

/// Whether `path` looks like somewhere only this app's installer could have
/// pointed a link at: the app bundle, an AppImage/AppTranslocation/mounted
/// image, a Windows Program Files install, or the durable
/// `<data-local>/oxagen/bin` copy — as opposed to a Homebrew Cellar path (or
/// any other third-party `oxagen`), which happens to contain the literal
/// word "oxagen" too but never puts it directly ahead of a `bin` segment or
/// inside an `Oxagen.app` bundle.
pub fn is_oxagen_managed_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().replace('\\', "/").to_lowercase();
    lower.contains("oxagen.app/contents/macos")
        || lower.contains("/oxagen/bin/")
        || lower.ends_with("/oxagen/bin")
        || lower.contains(".mount_oxagen")
        || (lower.contains("apptranslocation") && lower.contains("oxagen.app"))
        || (lower.starts_with("/volumes/") && lower.contains("oxagen"))
        || lower.contains("program files/oxagen/")
        || lower.contains("program files (x86)/oxagen/")
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
pub fn decide_symlink_action(existing: &ExistingLink, target: &Path) -> LinkAction {
    match existing {
        ExistingLink::Absent => LinkAction::Create,
        ExistingLink::Other => LinkAction::Skip,
        ExistingLink::Symlink(current) => {
            if current == target {
                LinkAction::AlreadyCorrect
            } else if is_oxagen_managed_path(current) {
                LinkAction::Replace
            } else {
                LinkAction::Skip
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShimAction {
    Create,
    Replace,
    AlreadyCorrect,
    Skip,
}

/// The Windows `.cmd` shim body `install_cli` writes for `target`.
pub fn windows_shim_content(target: &Path) -> String {
    format!("@\"{}\" %*\r\n", target.display())
}

/// Decide what to do with a would-be `.cmd` shim given its current content:
/// rewrite only when it was written by us (starts with the `@"` form we
/// write), so a hand-written shim or another vendor's `oxagen.cmd` is left
/// alone.
pub fn decide_shim_action(existing: Option<&str>, desired: &str) -> ShimAction {
    match existing {
        None => ShimAction::Create,
        Some(text) if text == desired => ShimAction::AlreadyCorrect,
        Some(text) if text.starts_with("@\"") => ShimAction::Replace,
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

fn path_export_line(dir: &str) -> String {
    format!("export PATH=\"{dir}:$PATH\"")
}

fn block_text(dir: &str) -> String {
    format!("{MARKER_BEGIN}\n{}\n{MARKER_END}\n", path_export_line(dir))
}

/// The whole-file content for the fish profile: fish's own `conf.d` file is
/// entirely ours, so there is no marker block, just `fish_add_path`.
pub fn fish_add_path_content(dir: &str) -> String {
    format!("{MARKER_BEGIN}\nfish_add_path {dir}\n{MARKER_END}\n")
}

/// Remove exactly the marker block (and the line ending right after it) from
/// `existing`, restoring everything else byte-for-byte. A no-op (returns
/// `existing` unchanged) when no block is present.
pub fn remove_path_block(existing: &str) -> String {
    let Some(start) = existing.find(MARKER_BEGIN) else {
        return existing.to_string();
    };
    let Some(end_rel) = existing[start..].find(MARKER_END) else {
        return existing.to_string();
    };
    let mut end = start + end_rel + MARKER_END.len();
    if existing[end..].starts_with("\r\n") {
        end += 2;
    } else if existing[end..].starts_with('\n') {
        end += 1;
    }
    let before = &existing[..start];
    let begin = if let Some(trimmed) = before.strip_suffix("\r\n\r\n") {
        trimmed.len() + 2
    } else if let Some(trimmed) = before.strip_suffix("\n\n") {
        trimmed.len() + 1
    } else {
        start
    };
    format!("{}{}", &existing[..begin], &existing[end..])
}

/// Insert (or move, if already present) the marker block for `dir` into
/// `existing`. Idempotent: calling it twice with the same `dir` yields the
/// same content as calling it once. Content outside the block is preserved
/// byte-for-byte.
pub fn upsert_path_block(existing: &str, dir: &str) -> String {
    let without = remove_path_block(existing);
    let block = block_text(dir);
    if without.is_empty() {
        block
    } else if without.ends_with("\n\n") || without.ends_with("\r\n\r\n") {
        format!("{without}{block}")
    } else if without.ends_with('\n') {
        format!("{without}\n{block}")
    } else {
        format!("{without}\n\n{block}")
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
            note: "Checking whether the CLIs are on PATH…".to_string(),
        }
    }
}

/// Holds the outcome of the last automatic or manual install/uninstall so
/// `desktop_state` can report it without redoing the work on every poll.
pub struct CliInstallState(pub Mutex<CliInstallView>);

impl Default for CliInstallState {
    fn default() -> Self {
        Self(Mutex::new(CliInstallView::default()))
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
fn link_one(dir: &Path, name: &str, target: &Path) -> LinkOutcome {
    let link = dir.join(name);
    let existing = read_existing_link(&link);
    match decide_symlink_action(&existing, target) {
        LinkAction::AlreadyCorrect => LinkOutcome::AlreadyCorrect,
        LinkAction::Skip => {
            LinkOutcome::Skipped(format!("{name}: {} was not created by Oxagen, left alone", link.display()))
        }
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
fn link_one(dir: &Path, name: &str, target: &Path) -> LinkOutcome {
    let shim = dir.join(format!("{name}.cmd"));
    let desired = windows_shim_content(target);
    let existing = fs::read_to_string(&shim).ok();
    match decide_shim_action(existing.as_deref(), &desired) {
        ShimAction::AlreadyCorrect => LinkOutcome::AlreadyCorrect,
        ShimAction::Skip => {
            LinkOutcome::Skipped(format!("{name}: {} was not written by Oxagen, left alone", shim.display()))
        }
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
fn keep_sidecars(sidecars: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let durable = durable_bin_dir();
    fs::create_dir_all(&durable).map_err(|e| format!("cannot create {}: {e}", durable.display()))?;
    for name in ["oxagen", "tacho"] {
        let from = sidecars.join(exe(name));
        let to = durable.join(exe(name));
        // Copy beside, then rename: a running daemon keeps its old inode
        // and the link never points at a half-written file.
        let staging = durable.join(format!(".{}.tmp", exe(name)));
        fs::copy(&from, &staging).map_err(|e| format!("cannot copy {} to {}: {e}", from.display(), staging.display()))?;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot chmod {}: {e}", staging.display()))?;
        fs::rename(&staging, &to).map_err(|e| format!("cannot move {} to {}: {e}", staging.display(), to.display()))?;
    }
    Ok(durable)
}

/// The PowerShell that appends a directory to the user PATH. The directory
/// travels out-of-band in `$env:OXAGEN_BIN`, never spliced into the script:
/// `%LOCALAPPDATA%` carries the user name, and `O'Brien` is a legal one
/// whose apostrophe would end a single-quoted literal and fail the parse.
#[allow(dead_code)]
const ADD_TO_USER_PATH_PS: &str = "$d=$env:OXAGEN_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(($p -split ';') -notcontains $d){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d), 'User') }";

#[cfg(windows)]
fn add_to_user_path_windows(dir: &str) -> Result<(), String> {
    // setx truncates at 1024 characters; the .NET API does not.
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ADD_TO_USER_PATH_PS])
        .env("OXAGEN_BIN", dir)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("powershell exited {status}"))
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn add_to_user_path_windows(_dir: &str) -> Result<(), String> {
    Ok(())
}

/// Wait up to `timeout` for `child`, killing it if it outlives the deadline.
/// Returns the collected stdout on a clean, zero-status exit.
#[cfg(not(windows))]
fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Option<Vec<u8>> {
    let start = std::time::Instant::now();
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
    use std::io::Read;
    let mut buf = Vec::new();
    child.stdout.take()?.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// `$SHELL -lc 'printf %s "$PATH"'`: what PATH looks like for a *new*
/// terminal, which differs from this process's own PATH (Tauri apps launch
/// without sourcing shell profiles at all on macOS/Linux). Falls back to the
/// process's own PATH when the probe fails or times out.
#[cfg(not(windows))]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let child = std::process::Command::new(&shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let bytes = wait_with_timeout(child, Duration::from_secs(5))?;
    let text = String::from_utf8(bytes).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Add (or move) the marker block into the right profile file for the
/// user's login shell, unless `dir` is already on the login-shell PATH.
/// Returns the profile file touched, or an error note when the shell isn't
/// one we know how to edit.
#[cfg(not(windows))]
fn ensure_profile_block(dir: &Path) -> Result<Option<String>, String> {
    let path_var = login_shell_path().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    if path_var_contains(&path_var, dir) {
        return Ok(None);
    }
    let shell = std::env::var("SHELL").unwrap_or_default();
    let kind = detect_shell_kind(&shell);
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    let platform = std::env::consts::OS;
    let Some(profile_path) = profile_path_for(kind, &home, platform) else {
        return Err(format!(
            "{}: not on PATH for new terminals; add it to your shell's profile manually",
            dir.display()
        ));
    };
    if let Some(parent) = profile_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let dir_text = dir.display().to_string();
    if kind == ShellKind::Fish {
        fs::write(&profile_path, fish_add_path_content(&dir_text)).map_err(|e| e.to_string())?;
    } else {
        let existing = fs::read_to_string(&profile_path).unwrap_or_default();
        let updated = upsert_path_block(&existing, &dir_text);
        fs::write(&profile_path, updated).map_err(|e| e.to_string())?;
    }
    Ok(Some(profile_path.display().to_string()))
}

/// Remove the marker block (or, for fish, the whole ours-only file) from
/// every profile file we might have written it to. Safe to call whichever
/// shell is current now, since we don't know which one wrote it.
#[cfg(not(windows))]
fn remove_all_profile_blocks() -> Vec<String> {
    let mut touched = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return touched;
    };
    for candidate in [home.join(".zprofile"), home.join(".bash_profile"), home.join(".bashrc")] {
        if let Ok(existing) = fs::read_to_string(&candidate) {
            let updated = remove_path_block(&existing);
            if updated != existing {
                if fs::write(&candidate, &updated).is_ok() {
                    touched.push(candidate.display().to_string());
                }
            }
        }
    }
    let fish = home.join(".config").join("fish").join("conf.d").join("oxagen.fish");
    if fish.is_file() && fs::remove_file(&fish).is_ok() {
        touched.push(fish.display().to_string());
    }
    touched
}

fn note_for(state: &str, view: &CliInstallView) -> String {
    match state {
        "already" => "The bundled binaries are already on PATH.".to_string(),
        "opted_out" => "Automatic linking is turned off; use \"Link into PATH\" to link manually.".to_string(),
        "linked" => {
            if let Some(profile) = &view.profile {
                format!("Linked into {}; added to {} for new terminals.", view.dir, profile)
            } else if cfg!(windows) {
                "Linked into your user PATH; open a new terminal.".to_string()
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
/// sure the directory is on PATH for new terminals.
fn install_cli_core() -> CliInstallView {
    let dir = cli_install_dir();
    let mut view = CliInstallView {
        state: "pending".to_string(),
        dir: dir.display().to_string(),
        files: Vec::new(),
        skipped: Vec::new(),
        profile: None,
        note: String::new(),
    };

    let Some(bundled) = sidecar_dir() else {
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

    // Linux .deb/.rpm etc: externalBin already lives on PATH.
    if let Some(path_var) = std::env::var_os("PATH") {
        if path_var_contains(&path_var.to_string_lossy(), &bundled) {
            view.state = "already".to_string();
            view.dir = bundled.display().to_string();
            view.note = note_for("already", &view);
            return view;
        }
    }

    #[cfg(not(windows))]
    let sidecars = if sidecar_dir_is_transient() {
        match keep_sidecars(&bundled) {
            Ok(kept) => {
                std::env::set_var("TACHO_BIN_DIR", &kept);
                kept
            }
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

    if let Err(e) = fs::create_dir_all(&dir) {
        view.state = "failed".to_string();
        view.note = format!("cannot create {}: {e}", dir.display());
        return view;
    }

    for name in ["oxagen", "tacho"] {
        let target = sidecars.join(exe(name));
        match link_one(&dir, name, &target) {
            LinkOutcome::Linked(path) => view.files.push(path),
            LinkOutcome::AlreadyCorrect => {}
            LinkOutcome::Skipped(note) => view.skipped.push(note),
            LinkOutcome::Failed(err) => {
                view.state = "failed".to_string();
                view.note = err;
                return view;
            }
        }
    }

    #[cfg(windows)]
    {
        let already = std::env::var_os("PATH")
            .map(|p| path_var_contains(&p.to_string_lossy(), &dir))
            .unwrap_or(false);
        if !already {
            if let Err(e) = add_to_user_path_windows(&dir.display().to_string()) {
                view.skipped.push(format!("user PATH: {e}"));
            }
        }
    }
    #[cfg(not(windows))]
    {
        match ensure_profile_block(&dir) {
            Ok(profile) => view.profile = profile,
            Err(note) => view.skipped.push(note),
        }
    }

    view.state = if view.files.is_empty() && !view.skipped.is_empty() {
        "skipped".to_string()
    } else {
        "linked".to_string()
    };
    view.note = note_for(&view.state, &view);
    view
}

/// The one entry point `lib.rs`'s `setup` calls on every launch, off the
/// main thread. Honours the `autoLinkCli` opt-out and never overwrites
/// anything the user or another tool put on PATH.
pub fn ensure_cli_installed() -> CliInstallView {
    let config = read_json_object(&desktop_config_path());
    if !auto_link_cli_enabled(&config) {
        let dir = cli_install_dir();
        let mut view = CliInstallView {
            state: "opted_out".to_string(),
            dir: dir.display().to_string(),
            files: Vec::new(),
            skipped: Vec::new(),
            profile: None,
            note: String::new(),
        };
        view.note = note_for("opted_out", &view);
        return view;
    }
    install_cli_core()
}

// ---------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------

#[derive(Serialize)]
pub struct InstallResult {
    pub dir: String,
    pub files: Vec<String>,
    pub on_path: bool,
    pub note: String,
    pub profile: Option<String>,
}

/// "Link into PATH": always runs (it re-enables `autoLinkCli` first, so an
/// opted-out user clicking it explicitly gets what they asked for), and
/// updates the managed state `desktop_state` reports.
#[tauri::command]
pub fn install_cli(state: tauri::State<CliInstallState>) -> Result<InstallResult, String> {
    write_auto_link_cli(true)?;
    let view = install_cli_core();
    if view.state == "failed" {
        *state.0.lock().unwrap() = view.clone();
        return Err(view.note);
    }
    let on_path = view.state == "already" || cfg!(windows);
    let result = InstallResult {
        dir: view.dir.clone(),
        files: view.files.clone(),
        on_path,
        note: view.note.clone(),
        profile: view.profile.clone(),
    };
    *state.0.lock().unwrap() = view;
    Ok(result)
}

/// "Remove links": removes the symlinks/shims this installer wrote, strips
/// the profile block(s) it added, and turns off automatic re-linking on the
/// next launch. The sidecars themselves stay with the app.
#[tauri::command]
pub fn uninstall_cli(state: tauri::State<CliInstallState>) -> Result<Vec<String>, String> {
    let dir = cli_install_dir();
    let mut removed = Vec::new();
    for name in ["oxagen", "tacho"] {
        for candidate in [dir.join(name), dir.join(format!("{name}.cmd"))] {
            if candidate.symlink_metadata().is_ok() {
                fs::remove_file(&candidate).map_err(|e| e.to_string())?;
                removed.push(candidate.display().to_string());
            }
        }
    }
    #[cfg(not(windows))]
    removed.extend(remove_all_profile_blocks());
    write_auto_link_cli(false)?;
    *state.0.lock().unwrap() = CliInstallView {
        state: "opted_out".to_string(),
        dir: dir.display().to_string(),
        files: Vec::new(),
        skipped: Vec::new(),
        profile: None,
        note: note_for("opted_out", &CliInstallView::default()),
    };
    Ok(removed)
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
        assert!(is_oxagen_managed_path(Path::new(
            "/Applications/Oxagen.app/Contents/MacOS/oxagen"
        )));
        assert!(is_oxagen_managed_path(Path::new(
            "/Users/dev/Library/Application Support/oxagen/bin/oxagen"
        )));
        assert!(is_oxagen_managed_path(Path::new("/home/dev/.local/share/oxagen/bin/tacho")));
        assert!(is_oxagen_managed_path(Path::new("/tmp/.mount_OxagenAb12Cd/usr/bin/oxagen")));
        assert!(is_oxagen_managed_path(Path::new(
            "/private/var/folders/x/T/AppTranslocation/1234/d/Oxagen.app/Contents/MacOS/oxagen"
        )));
        assert!(is_oxagen_managed_path(Path::new("/Volumes/Oxagen/Oxagen.app/Contents/MacOS/oxagen")));
        assert!(is_oxagen_managed_path(Path::new("C:\\Program Files\\Oxagen\\bin\\oxagen.exe")));
    }

    #[test]
    fn rejects_third_party_locations_that_merely_contain_the_word() {
        // Homebrew: the segment right before "bin" is a version, not
        // "oxagen" — same literal word, different shape.
        assert!(!is_oxagen_managed_path(Path::new(
            "/opt/homebrew/Cellar/oxagen/1.4.0/bin/oxagen"
        )));
        assert!(!is_oxagen_managed_path(Path::new("/opt/homebrew/bin/oxagen")));
        assert!(!is_oxagen_managed_path(Path::new("/usr/local/bin/oxagen")));
        assert!(!is_oxagen_managed_path(Path::new("/home/dev/bin/oxagen")));
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
        // An older app location or the durable copy: recognized, replace.
        let stale = PathBuf::from("/Users/dev/Library/Application Support/oxagen/bin/oxagen");
        assert_eq!(decide_symlink_action(&ExistingLink::Symlink(stale), target), LinkAction::Replace);
        // A Homebrew install: not recognized, leave it.
        let foreign = PathBuf::from("/opt/homebrew/Cellar/oxagen/1.4.0/bin/oxagen");
        assert_eq!(decide_symlink_action(&ExistingLink::Symlink(foreign), target), LinkAction::Skip);
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
        assert_eq!(decide_shim_action(None, &desired), ShimAction::Create);
        assert_eq!(decide_shim_action(Some(desired.as_str()), &desired), ShimAction::AlreadyCorrect);
        let stale = windows_shim_content(Path::new(r"C:\Users\dev\AppData\Local\Oxagen\bin\oxagen.exe"));
        assert_eq!(decide_shim_action(Some(stale.as_str()), &desired), ShimAction::Replace);
        assert_eq!(decide_shim_action(Some("@echo off\r\nsomething-else.exe %*\r\n"), &desired), ShimAction::Skip);
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
        assert_eq!(profile_path_for(ShellKind::Zsh, home, "macos"), Some(home.join(".zprofile")));
        assert_eq!(profile_path_for(ShellKind::Zsh, home, "linux"), Some(home.join(".zprofile")));
        assert_eq!(profile_path_for(ShellKind::Bash, home, "macos"), Some(home.join(".bash_profile")));
        assert_eq!(profile_path_for(ShellKind::Bash, home, "linux"), Some(home.join(".bashrc")));
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
        assert!(once.contains("export PATH=\"/home/dev/.local/bin:$PATH\""));
        let twice = upsert_path_block(&once, "/home/dev/.local/bin");
        assert_eq!(once, twice, "a second identical upsert must not change the file");
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
    fn upsert_then_remove_round_trips_to_the_original() {
        let original = "export EDITOR=vim\n";
        let inserted = upsert_path_block(original, "/home/dev/.local/bin");
        let removed = remove_path_block(&inserted);
        assert_eq!(removed, original);
    }

    #[test]
    fn fish_content_is_whole_file_ownership() {
        let content = fish_add_path_content("/home/dev/.local/bin");
        assert!(content.contains("fish_add_path /home/dev/.local/bin"));
        assert!(content.contains(MARKER_BEGIN));
    }

    // ---- autoLinkCli config merge ----

    #[test]
    fn auto_link_defaults_to_enabled_when_unset() {
        assert!(auto_link_cli_enabled(&Map::new()));
    }

    #[test]
    fn set_auto_link_cli_preserves_other_keys() {
        let mut config = Map::new();
        config.insert("someOtherPref".to_string(), Value::Bool(true));
        let updated = set_auto_link_cli(config, false);
        assert_eq!(updated.get("autoLinkCli"), Some(&Value::Bool(false)));
        assert_eq!(updated.get("someOtherPref"), Some(&Value::Bool(true)));
        assert!(!auto_link_cli_enabled(&updated));

        let restored = set_auto_link_cli(updated, true);
        assert!(auto_link_cli_enabled(&restored));
        assert_eq!(restored.get("someOtherPref"), Some(&Value::Bool(true)));
    }

    // ---- transient-directory classification (moved from lib.rs) ----

    #[test]
    fn transient_directories_are_the_per_launch_ones() {
        let t = |p: &str| is_transient_dir(Path::new(p), false);
        assert!(t("/tmp/.mount_OxagenAb12Cd/usr/bin"));
        assert!(t("/Volumes/Oxagen/Oxagen.app/Contents/MacOS"));
        assert!(t("/private/var/folders/x/T/AppTranslocation/1234-abcd/d/Oxagen.app/Contents/MacOS"));
        assert!(is_transient_dir(Path::new("/usr/lib/oxagen"), true));
        assert!(!t("/Applications/Oxagen.app/Contents/MacOS"));
        assert!(!t("/usr/lib/oxagen"));
        assert!(!t("C:\\Program Files\\Oxagen"));
        assert!(!t("/home/dev/.local/share/oxagen/bin"));
    }

    #[test]
    fn the_path_script_reads_the_directory_from_the_environment() {
        // No user-derived text is spliced into the script, so a directory
        // with an apostrophe cannot end a literal.
        assert!(ADD_TO_USER_PATH_PS.contains("$env:OXAGEN_BIN"));
        assert!(!ADD_TO_USER_PATH_PS.contains("{dir}"));
        assert!(!ADD_TO_USER_PATH_PS.contains("{}"));
    }

    // ---- link_one against a real (temp) directory, Unix only ----

    #[cfg(not(windows))]
    #[test]
    fn link_one_creates_replaces_and_skips_on_real_symlinks() {
        let dir = unique_temp_dir("link-one");
        // A directory shaped like a durable Oxagen bin dir, so
        // is_oxagen_managed_path recognizes links into it as ours.
        let old_oxagen_dir = std::env::temp_dir().join(format!("oxagen-cli-install-test-old-app-{}", std::process::id()));
        fs::create_dir_all(old_oxagen_dir.join("oxagen").join("bin")).unwrap();
        let stale_target = old_oxagen_dir.join("oxagen").join("bin").join("oxagen");
        fs::write(&stale_target, b"stale").unwrap();

        let foreign_dir = std::env::temp_dir().join("not-oxagen-at-all");
        fs::create_dir_all(&foreign_dir).unwrap();
        let foreign_target = foreign_dir.join("oxagen");
        fs::write(&foreign_target, b"foreign").unwrap();

        let current_target = dir.join("target-current");
        fs::write(&current_target, b"current").unwrap();

        // Absent -> Created.
        assert!(matches!(link_one(&dir, "oxagen", &current_target), LinkOutcome::Linked(_)));
        assert_eq!(fs::read_link(dir.join("oxagen")).unwrap(), current_target);

        // Same target again -> AlreadyCorrect, no error, link unchanged.
        assert!(matches!(link_one(&dir, "oxagen", &current_target), LinkOutcome::AlreadyCorrect));

        // Points at a recognizably Oxagen-owned path that isn't the current
        // target (an older app location, or the durable copy) -> Replace.
        let _ = fs::remove_file(dir.join("oxagen"));
        std::os::unix::fs::symlink(&stale_target, dir.join("oxagen")).unwrap();
        assert!(matches!(link_one(&dir, "oxagen", &current_target), LinkOutcome::Linked(_)));
        assert_eq!(fs::read_link(dir.join("oxagen")).unwrap(), current_target);

        // Points somewhere we don't recognize (a third-party install) ->
        // Skip, left untouched.
        let _ = fs::remove_file(dir.join("oxagen"));
        std::os::unix::fs::symlink(&foreign_target, dir.join("oxagen")).unwrap();
        assert!(matches!(link_one(&dir, "oxagen", &current_target), LinkOutcome::Skipped(_)));
        assert_eq!(fs::read_link(dir.join("oxagen")).unwrap(), foreign_target);

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&old_oxagen_dir);
        let _ = fs::remove_dir_all(&foreign_dir);
    }
}
