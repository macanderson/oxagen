//! Where this app reads and writes on the machine, and how it edits a file it
//! does not own.
//!
//! Every path the shell touches hangs off a `Roots` value. `Roots::real()` is
//! the user's machine. A test builds one over a scratch directory, so the
//! install and the uninstall run for real, against real files, without going
//! near the real home directory, `~/.local/bin` or a shell profile. Before
//! this module the paths came from `dirs::home_dir()` and `$SHELL` deep inside
//! the functions that used them, and the only way to exercise "Link into
//! PATH" was to do it to the developer's own machine.

use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Roots {
    /// The user's home directory.
    pub home: PathBuf,
    /// `~/Library/Application Support` (macOS), `$XDG_DATA_HOME` or
    /// `~/.local/share` (Linux), `%LOCALAPPDATA%` (Windows).
    pub data_local: PathBuf,
    /// `$SHELL`, empty when unset. Read only where a login shell exists.
    #[cfg_attr(windows, allow(dead_code))]
    pub shell: String,
    /// `std::env::consts::OS`: "macos", "linux" or "windows".
    pub os: &'static str,
    /// `$TACHO_HOME`, when the Tacho root is not under `oxagen_dir`.
    pub tacho_home: Option<PathBuf>,
}

impl Roots {
    pub fn real() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            data_local: dirs::data_local_dir().unwrap_or_else(|| home.clone()),
            home,
            shell: std::env::var("SHELL").unwrap_or_default(),
            os: std::env::consts::OS,
            tacho_home: std::env::var_os("TACHO_HOME").map(PathBuf::from),
        }
    }

    /// `~/.config/oxagen` on every platform, matching `oxagenConfigPath` in
    /// packages/tacho and `CONFIG_DIR` in apps/cli.
    pub fn oxagen_dir(&self) -> PathBuf {
        self.home.join(".config").join("oxagen")
    }

    pub fn tacho_root(&self) -> PathBuf {
        self.tacho_home
            .clone()
            .unwrap_or_else(|| self.oxagen_dir().join("tacho"))
    }

    /// Where the PATH links go: a directory the user owns on every platform.
    pub fn cli_install_dir(&self) -> PathBuf {
        if self.os == "windows" {
            self.data_local.join("Oxagen").join("bin")
        } else {
            self.home.join(".local").join("bin")
        }
    }

    /// The per-user copy of the sidecars, made when the app runs from a
    /// directory that is gone after this launch.
    pub fn durable_bin_dir(&self) -> PathBuf {
        self.data_local.join("oxagen").join("bin")
    }

    /// `~/.config/oxagen/desktop.json`: the app's own preferences.
    pub fn desktop_config_path(&self) -> PathBuf {
        self.oxagen_dir().join("desktop.json")
    }
}

/// A file's text. `Ok(None)` means it does not exist. Anything else that
/// stops it being read as text (no permission, bytes that are not UTF-8) is
/// an `Err`, never an empty string: the caller is about to write the file
/// back, and "could not read it" treated as "it is empty" replaced a whole
/// shell profile with three lines.
pub fn read_text(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("{} is not UTF-8 text, left alone", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// The file `path` names once symlinks are followed, whether or not the file
/// at the end exists yet.
fn real_target(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    for _ in 0..16 {
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => match fs::read_link(&current) {
                Ok(target) => {
                    current = match current.parent() {
                        Some(parent) => parent.join(target),
                        None => target,
                    }
                }
                Err(_) => return current,
            },
            _ => return current,
        }
    }
    current
}

/// Replace a file's content without ever leaving it half written: a sibling
/// temp file, flushed to disk, then a rename. The write goes through a
/// symlink to the file it names (a profile kept in a dotfiles checkout stays
/// a link) and an existing file keeps its mode. `fs::write` truncates first,
/// so a crash or a full disk between the truncate and the write left an empty
/// `.zprofile`. The flush matters for the same reason: a rename can reach the
/// disk before the data it names, and a power cut then leaves the new name on
/// an empty file.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let target = real_target(path);
    let dir = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let staging = dir.join(format!(".{name}.oxagen-{}.tmp", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&staging)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&staging, meta.permissions())?;
        }
        fs::rename(&staging, &target)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&staging);
        return Err(format!("cannot write {}: {e}", target.display()));
    }
    Ok(())
}

/// The last `lines` lines of a log, reading at most `max_bytes` from its end.
/// The collector log is unbounded and this is polled by the UI, so reading
/// the whole file each time grew without limit, and one byte that was not
/// UTF-8 turned the whole tail into an empty string.
pub fn tail_lines(path: &Path, lines: usize, max_bytes: u64) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.take(max_bytes).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut all: Vec<&str> = text.lines().collect();
    // A read that started mid-file starts mid-line: drop the fragment.
    if start > 0 && !all.is_empty() {
        all.remove(0);
    }
    let from = all.len().saturating_sub(lines.min(5_000));
    all[from..].join("\n")
}

/// What one agent's `host.json` says about its enrollment. `enrollment`
/// adds the agents up into one answer for the machine.
#[derive(Debug, PartialEq, Eq)]
pub enum Enrollment {
    /// No agent: no `host.json` under `agents/` and no legacy file.
    None,
    /// Enrolled: hooks and a service are on the machine.
    Live,
    /// `revoked_at` is set. `tacho unenroll` already took the hooks and the
    /// service out. It kept the file only so a revoke that could not reach
    /// the control plane can be finished later.
    Retired,
    /// The file is there and cannot be understood. `tacho unenroll` strips
    /// the hooks and the service for such a file too, and keeps it.
    Unreadable,
}

/// The id the legacy enrollment goes by. A machine enrolled before ADR-202
/// keeps it at `<tachoDir>/host.json`, and tachod moves it under `agents/`
/// at startup. Until then it is an agent like any other. `LEGACY_AGENT_ID`
/// in packages/tacho is the same name.
pub const LEGACY_AGENT_ID: &str = "legacy";

/// One enrollment on this machine: `<tachoDir>/agents/<id>/host.json`, or
/// the legacy `<tachoDir>/host.json`.
#[derive(Debug)]
pub struct Agent {
    /// The directory name under `agents/`, or `LEGACY_AGENT_ID`. When
    /// `agents/` itself cannot be listed, one stand-in agent reports that,
    /// and its id is `agents`.
    pub id: String,
    pub host_path: PathBuf,
    /// The file as a JSON object, or why it could not be read.
    pub host: Result<Value, String>,
}

impl Agent {
    pub fn enrollment(&self) -> Enrollment {
        match &self.host {
            Ok(Value::Object(host)) => match host.get("revoked_at") {
                Some(Value::String(_)) => Enrollment::Retired,
                _ if host.contains_key("host_enrollment_id") => Enrollment::Live,
                _ => Enrollment::Unreadable,
            },
            _ => Enrollment::Unreadable,
        }
    }

    /// A string field of the file, when it read and holds one.
    fn field(&self, key: &str) -> Option<&str> {
        self.host.as_ref().ok()?.get(key)?.as_str()
    }
}

/// Every enrollment on this machine, in the order `listAgents` in
/// packages/tacho gives: agents whose file reads, by `enrolled_at` and then
/// id, followed by the rest by id.
///
/// An agent is a directory under `<tachoDir>/agents/` that holds a
/// `host.json`, plus the legacy `<tachoDir>/host.json` while it is there. A
/// name that starts with a dot is not an agent. tachod builds a moved
/// enrollment in `agents/.migrating-<id>/` and renames it into place.
pub fn agents(roots: &Roots) -> Vec<Agent> {
    let root = roots.tacho_root();
    let agents_dir = root.join("agents");
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let mut agents: Vec<Agent> = Vec::new();
    match fs::read_dir(&agents_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let id = entry.file_name().to_string_lossy().into_owned();
                if id.starts_with('.') {
                    continue;
                }
                let host_path = entry.path().join("host.json");
                if host_path.exists() {
                    found.push((id, host_path));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // A directory that is there and cannot be listed may hold a live
        // agent. It counts as an unreadable one, never as no agent.
        Err(e) => agents.push(Agent {
            id: "agents".to_string(),
            host: Err(format!("cannot list {}: {e}", agents_dir.display())),
            host_path: agents_dir,
        }),
    }
    let legacy = root.join("host.json");
    if legacy.exists() {
        found.push((LEGACY_AGENT_ID.to_string(), legacy));
    }
    for (id, host_path) in found {
        // `Ok(None)` is a file removed since the listing: no agent.
        if let Some(host) = read_host(&host_path).transpose() {
            agents.push(Agent { id, host_path, host });
        }
    }
    agents.sort_by(|a, b| match (&a.host, &b.host) {
        (Ok(_), Ok(_)) => a
            .field("enrolled_at")
            .unwrap_or("")
            .cmp(b.field("enrolled_at").unwrap_or(""))
            .then_with(|| a.id.cmp(&b.id)),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        (Err(_), Err(_)) => a.id.cmp(&b.id),
    });
    agents
}

/// The agent a reader that needs one enrollment's fields uses: the first
/// live one in `agents` order, else the first. `defaultAgentPaths` in
/// packages/tacho picks the same one. `None` when nothing is enrolled.
pub fn default_agent(roots: &Roots) -> Option<Agent> {
    let agents = agents(roots);
    let live = agents.iter().position(|a| a.enrollment() == Enrollment::Live);
    agents.into_iter().nth(live.unwrap_or(0))
}

/// What the machine's agents add up to. One live agent makes the machine
/// live. Below that, an unreadable file outranks a retired one. With a
/// single agent this is that agent's state.
pub fn enrollment(roots: &Roots) -> Enrollment {
    let agents = agents(roots);
    let any = |state: Enrollment| agents.iter().any(|agent| agent.enrollment() == state);
    if any(Enrollment::Live) {
        Enrollment::Live
    } else if any(Enrollment::Unreadable) {
        Enrollment::Unreadable
    } else if any(Enrollment::Retired) {
        Enrollment::Retired
    } else {
        Enrollment::None
    }
}

/// An enrollment `tacho unenroll` retired while its revoke could not reach
/// the control plane: the fleet page still lists it as active.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PendingRevoke {
    pub agent_key: String,
    pub host_enrollment_id: String,
}

/// The revoke a retired agent still owes, read before anything removes its
/// file. With more than one retired agent, this is the first in `agents`
/// order. `None` when no agent is retired, and when no retired file names
/// an enrollment.
pub fn pending_revoke(roots: &Roots) -> Option<PendingRevoke> {
    agents(roots)
        .iter()
        .filter(|agent| agent.enrollment() == Enrollment::Retired)
        .find_map(|agent| {
            let host_enrollment_id = agent.field("host_enrollment_id")?;
            let agent_key = agent.field("agent_key").unwrap_or(host_enrollment_id);
            Some(PendingRevoke {
                agent_key: agent_key.to_owned(),
                host_enrollment_id: host_enrollment_id.to_owned(),
            })
        })
}

/// `host.json` as the Connection panel reads it. `Ok(None)` means there is
/// no file. A file that is there and cannot be read, or is not a JSON
/// object, is an `Err` naming why: read as absent, it sent an enrolled
/// machine back to the setup wizard.
pub fn read_host(path: &Path) -> Result<Option<Value>, String> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(host @ Value::Object(_)) => Ok(Some(host)),
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(e) => Err(format!("{} is not valid JSON: {e}", path.display())),
    }
}

/// Remove `dir` when it is empty. Anything in it is somebody's, so it stays.
pub fn remove_dir_if_empty(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none() && fs::remove_dir(dir).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::collections::BTreeMap;

    /// A `Roots` over a fresh scratch directory that looks like a Mac.
    pub fn scratch_roots(label: &str, shell: &str) -> Roots {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!(
            "oxagen-desktop-rig-{label}-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        let home = fs::canonicalize(&base).unwrap();
        Roots {
            data_local: home.join("Library").join("Application Support"),
            home,
            shell: shell.to_string(),
            os: "macos",
            tacho_home: None,
        }
    }

    /// Every path under `root`: kind, permission bits, and the bytes (a
    /// file) or the target (a link). Two equal maps are a byte-identical tree.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn snapshot(root: &Path) -> BTreeMap<String, String> {
        fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
            let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
            entries.sort();
            for path in entries {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                let meta = fs::symlink_metadata(&path).unwrap();
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    meta.permissions().mode() & 0o777
                };
                #[cfg(not(unix))]
                let mode = 0;
                if meta.file_type().is_symlink() {
                    let target = fs::read_link(&path).unwrap();
                    out.insert(rel, format!("link {mode:o} -> {}", target.display()));
                } else if meta.is_dir() {
                    out.insert(rel, format!("dir {mode:o}"));
                    walk(&path, root, out);
                } else {
                    let bytes = fs::read(&path).unwrap();
                    out.insert(rel, format!("file {mode:o} {bytes:?}"));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::scratch_roots;
    use super::*;

    #[test]
    fn a_profile_that_is_not_utf8_is_an_error_not_an_empty_string() {
        let roots = scratch_roots("latin1", "/bin/zsh");
        let profile = roots.home.join(".zprofile");
        fs::write(&profile, b"export NAME=Jos\xe9\n").unwrap();
        assert!(read_text(&profile).unwrap_err().contains("not UTF-8"));
        assert_eq!(read_text(&roots.home.join("absent")).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_goes_through_a_symlink_and_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let roots = scratch_roots("atomic", "/bin/zsh");
        let real = roots.home.join("dotfiles").join("zprofile");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, "old\n").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = roots.home.join(".zprofile");
        std::os::unix::fs::symlink(Path::new("dotfiles").join("zprofile"), &link).unwrap();
        write_atomic(&link, "new\n").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new\n");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        // No temp file is left beside it.
        let left: Vec<_> = fs::read_dir(real.parent().unwrap()).unwrap().collect();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn the_log_tail_is_bounded_and_survives_a_bad_byte() {
        let roots = scratch_roots("tail", "/bin/zsh");
        let log = roots.home.join("tachod.log");
        let mut body = Vec::new();
        for i in 0..10_000 {
            body.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        body.extend_from_slice(b"bad \xff byte\nlast\n");
        fs::write(&log, &body).unwrap();
        let tail = tail_lines(&log, 3, 4096);
        assert_eq!(tail.lines().count(), 3);
        assert!(tail.ends_with("last"));
        assert!(tail.contains("bad"));
        // Asking for more lines than the byte window holds never reads more.
        assert!(tail_lines(&log, usize::MAX, 4096).len() <= 4096);
        assert_eq!(tail_lines(&roots.home.join("absent.log"), 10, 4096), "");
    }

    /// Agent `id`'s `host.json` under `agents/`, with its directory made.
    fn agent_host(roots: &Roots, id: &str) -> PathBuf {
        let host = roots.tacho_root().join("agents").join(id).join("host.json");
        fs::create_dir_all(host.parent().unwrap()).unwrap();
        host
    }

    #[test]
    fn enrollment_tells_a_retired_host_from_a_live_one() {
        let roots = scratch_roots("enrollment", "/bin/zsh");
        assert_eq!(enrollment(&roots), Enrollment::None);
        let host = agent_host(&roots, "0a1b2c3d");
        fs::write(&host, r#"{"host_enrollment_id":"tch_1","revoked_at":null}"#).unwrap();
        assert_eq!(enrollment(&roots), Enrollment::Live);
        fs::write(
            &host,
            r#"{"host_enrollment_id":"tch_1","revoked_at":"2026-09-18T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(enrollment(&roots), Enrollment::Retired);
        fs::write(&host, "{ truncated").unwrap();
        assert_eq!(enrollment(&roots), Enrollment::Unreadable);
    }

    #[test]
    fn a_host_file_that_cannot_be_read_is_an_error_not_an_absent_host() {
        let roots = scratch_roots("host-read", "/bin/zsh");
        let host = agent_host(&roots, "0a1b2c3d");
        assert_eq!(read_host(&host), Ok(None));
        fs::write(&host, r#"{"host_enrollment_id":"tch_1"}"#).unwrap();
        assert_eq!(read_host(&host).unwrap().unwrap()["host_enrollment_id"], "tch_1");
        // A write cut short, bytes that are not text, and JSON that is not a
        // host: each says why, and none reads as "not enrolled".
        fs::write(&host, "{ truncated").unwrap();
        assert!(read_host(&host).unwrap_err().contains("not valid JSON"));
        fs::write(&host, b"\xff\xfe").unwrap();
        assert!(read_host(&host).unwrap_err().contains("not UTF-8"));
        fs::write(&host, "[]").unwrap();
        assert!(read_host(&host).unwrap_err().contains("not a JSON object"));
    }

    #[test]
    fn two_agents_are_read_in_enrollment_order_and_the_live_one_is_the_default() {
        let roots = scratch_roots("two-agents", "/bin/zsh");
        let old = r#"{"host_enrollment_id":"tch_old","enrolled_at":"2026-09-01","revoked_at":"2026-09-02"}"#;
        let new = r#"{"host_enrollment_id":"tch_new","enrolled_at":"2026-09-20","revoked_at":null}"#;
        let gone = r#"{"host_enrollment_id":"tch_new","enrolled_at":"2026-09-20","revoked_at":"2026-09-21"}"#;
        // The id that sorts last enrolled first, so the order is by date.
        fs::write(agent_host(&roots, "ffff0001"), old).unwrap();
        let newer = agent_host(&roots, "0000aaaa");
        fs::write(&newer, new).unwrap();
        let ids: Vec<String> = agents(&roots).into_iter().map(|agent| agent.id).collect();
        assert_eq!(ids, ["ffff0001", "0000aaaa"]);
        // One live agent makes the machine live, and it is the one shown.
        assert_eq!(enrollment(&roots), Enrollment::Live);
        assert_eq!(default_agent(&roots).unwrap().id, "0000aaaa");
        // The retired one still owes its revoke. It names no agent key.
        let pending = pending_revoke(&roots).unwrap();
        assert_eq!(pending.host_enrollment_id, "tch_old");
        assert_eq!(pending.agent_key, "tch_old");
        // With no live agent, the default is the first by date.
        fs::write(&newer, gone).unwrap();
        assert_eq!(enrollment(&roots), Enrollment::Retired);
        assert_eq!(default_agent(&roots).unwrap().id, "ffff0001");
    }

    #[test]
    fn a_legacy_host_file_alone_is_one_agent() {
        let roots = scratch_roots("legacy", "/bin/zsh");
        let legacy = roots.tacho_root().join("host.json");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, r#"{"host_enrollment_id":"tch_1","revoked_at":null}"#).unwrap();
        let found = agents(&roots);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, LEGACY_AGENT_ID);
        assert_eq!(found[0].host_path, legacy);
        assert_eq!(enrollment(&roots), Enrollment::Live);
        assert_eq!(default_agent(&roots).unwrap().id, LEGACY_AGENT_ID);
    }

    #[test]
    fn a_dot_directory_under_agents_is_not_an_agent() {
        let roots = scratch_roots("migrating", "/bin/zsh");
        let live = r#"{"host_enrollment_id":"tch_1","revoked_at":null}"#;
        // tachod moving the legacy file, stopped before its rename.
        fs::write(agent_host(&roots, ".migrating-x"), live).unwrap();
        // A directory with no `host.json` is not an agent either.
        fs::create_dir_all(roots.tacho_root().join("agents").join("0a1b2c3d")).unwrap();
        assert!(agents(&roots).is_empty());
        assert_eq!(enrollment(&roots), Enrollment::None);
        assert!(default_agent(&roots).is_none());
        // A real agent beside it is still found.
        fs::write(agent_host(&roots, "0a1b2c3d"), live).unwrap();
        let ids: Vec<String> = agents(&roots).into_iter().map(|agent| agent.id).collect();
        assert_eq!(ids, ["0a1b2c3d"]);
    }
}
