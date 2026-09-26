//! Whether this install may update itself without asking, the setting that
//! turns that off, and the collector restart every install ends with.
//! ADR-202 is the policy. The page reads `update_policy` before it acts on an
//! offer from the update watch, and runs `restart_tacho_service` after every
//! install, automatic or clicked.
//!
//! The updater plugin swaps a macOS bundle with two renames through the
//! temporary folder. A rename it may not make sends it to an administrator
//! password prompt, and a rename across volumes fails the install, so the
//! gates here are the conditions under which neither happens.

use crate::cli_install::{read_json_object, write_desktop_config};
use crate::machine::Roots;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// `desktop.json`'s key for automatic updates.
const AUTO_UPDATE: &str = "autoUpdate";

/// Pure: whether automatic updates are on. Absent or `true` is on. Any other
/// value is off, so a mistyped `"false"` stops installs instead of allowing
/// them.
pub fn auto_update_enabled(config: &Map<String, Value>) -> bool {
    match config.get(AUTO_UPDATE) {
        None => true,
        Some(value) => value.as_bool() == Some(true),
    }
}

/// Write `autoUpdate` into `desktop.json`, keeping every other key.
pub(crate) fn write_auto_update(roots: &Roots, enabled: bool) -> Result<(), String> {
    let mut config = read_json_object(&roots.desktop_config_path());
    config.insert(AUTO_UPDATE.to_string(), Value::Bool(enabled));
    write_desktop_config(roots, &config)
}

/// Pure: the `.app` bundle an executable runs from, as the updater plugin
/// finds it: `/Applications/Oxagen.app` for
/// `/Applications/Oxagen.app/Contents/MacOS/oxagen-desktop`.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle =
        macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

/// What the gates read from the machine, gathered before the decision so a
/// test can build any combination.
#[derive(Debug, Clone)]
pub struct Install {
    /// `std::env::consts::OS`.
    pub os: &'static str,
    /// The bundle the executable is in; see `app_bundle`.
    pub bundle: Option<PathBuf>,
    /// The bundle's directory is gone after this launch; see
    /// `cli_install::is_transient_dir`.
    pub transient: bool,
    /// This account can write the bundle and the folder it is in.
    pub writable: bool,
    /// The bundle is on the volume the temporary folder is on.
    pub same_volume_as_temp: bool,
}

/// Pure: the first gate that stops an automatic install, as the sentence the
/// Updates panel shows, or None when every gate passes.
pub fn blocker(install: &Install) -> Option<&'static str> {
    if install.os != "macos" {
        return Some("Automatic installs are macOS-only for now. Oxagen asks before each update.");
    }
    if install.bundle.is_none() {
        return Some("Oxagen is not running from an app bundle, so it asks before each update.");
    }
    if install.transient {
        return Some(
            "Oxagen is running from a disk image or its download folder. Move it to Applications to install updates automatically.",
        );
    }
    if !install.writable {
        return Some(
            "Your account cannot write to the folder Oxagen is in, so an update needs an administrator password. Oxagen asks before each update.",
        );
    }
    if !install.same_volume_as_temp {
        return Some(
            "Oxagen is on a different disk from the system's temporary folder, so it asks before each update.",
        );
    }
    None
}

/// What the page needs to choose between installing on its own and asking.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct UpdatePolicy {
    /// `autoUpdate` in `desktop.json`; see `auto_update_enabled`.
    pub auto_update: bool,
    /// Why this install cannot update itself without asking; see `blocker`.
    pub blocker: Option<&'static str>,
    /// Install without asking: the setting is on and no gate blocks it.
    pub silent: bool,
}

/// Pure: ADR-202's decision from the setting and the install.
pub fn policy(config: &Map<String, Value>, install: &Install) -> UpdatePolicy {
    let auto_update = auto_update_enabled(config);
    let blocker = blocker(install);
    UpdatePolicy {
        auto_update,
        blocker,
        silent: auto_update && blocker.is_none(),
    }
}

/// Whether this account may write `path`. `test -w` asks the kernel the
/// question `rename` will: the owner, the group, and any ACL all count.
#[cfg(target_os = "macos")]
fn can_write(path: &Path) -> bool {
    std::process::Command::new("/bin/test")
        .arg("-w")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

/// The gates' inputs for the running app. Permissions and the volume are read
/// on every call, since the folder's permissions can change while the app
/// runs. The executable's path and whether it is transient hold for the
/// whole launch.
fn this_install() -> Install {
    let bundle = std::env::current_exe().ok().and_then(|exe| app_bundle(&exe));
    // The plugin parks the old bundle under `std::env::temp_dir()`.
    #[cfg(target_os = "macos")]
    let (writable, same_volume_as_temp) = match &bundle {
        Some(b) => (
            can_write(b) && b.parent().is_some_and(can_write),
            same_volume(b, &std::env::temp_dir()),
        ),
        None => (false, false),
    };
    #[cfg(not(target_os = "macos"))]
    let (writable, same_volume_as_temp) = (false, false);
    Install {
        os: std::env::consts::OS,
        bundle,
        transient: crate::cli_install::sidecar_dir_is_transient(),
        writable,
        same_volume_as_temp,
    }
}

/// ADR-202's decision for this install, read fresh each time.
#[tauri::command(async)]
pub fn update_policy() -> UpdatePolicy {
    let roots = Roots::real();
    policy(&read_json_object(&roots.desktop_config_path()), &this_install())
}

/// The Updates panel's checkbox: write `autoUpdate` and answer with the
/// policy it produces.
#[tauri::command(async)]
pub fn set_auto_update(enabled: bool) -> Result<UpdatePolicy, String> {
    let roots = Roots::real();
    write_auto_update(&roots, enabled)?;
    Ok(policy(&read_json_object(&roots.desktop_config_path()), &this_install()))
}

/// What `restart_tacho_service` did.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
// Each platform builds only the variants it can reach.
#[allow(dead_code)]
pub enum ServiceRestart {
    Restarted,
    /// No collector service is loaded or running: the machine is not
    /// enrolled, or the collector is stopped.
    NotRunning,
    /// Windows. The installer exits the app before this could run.
    Unsupported,
}

/// The collector's launchd label, `SERVICE_LABEL` in
/// packages/tacho/src/host/service.ts.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const LAUNCHD_LABEL: &str = "sh.oxagen.tachod";

/// The collector's systemd user unit, as packages/tacho/src/host/service.ts
/// writes it.
#[cfg(target_os = "linux")]
const SYSTEMD_UNIT: &str = "tachod.service";

/// Pure: the collector's service target in a user's GUI domain.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn launchd_target(uid: &str) -> String {
    format!("gui/{uid}/{LAUNCHD_LABEL}")
}

/// Pure: the uid in `id -u`'s output, or None when it printed anything but
/// digits.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_uid(stdout: &str) -> Option<String> {
    let uid = stdout.trim();
    (!uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit())).then(|| uid.to_string())
}

#[cfg(unix)]
fn run(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("cannot run {program}: {e}"))
}

#[cfg(unix)]
fn failed(what: &str, out: &std::process::Output) -> String {
    let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
    format!("{what} failed ({}): {detail}", out.status)
}

/// Restart a loaded collector the way `tacho enroll` does, so it runs the
/// binary the install just put in place.
#[cfg(target_os = "macos")]
fn restart_service() -> Result<ServiceRestart, String> {
    let id = run("/usr/bin/id", &["-u"])?;
    let stdout = String::from_utf8_lossy(&id.stdout);
    let uid = parse_uid(&stdout).ok_or_else(|| format!("`id -u` printed {:?}", stdout.trim()))?;
    let target = launchd_target(&uid);
    if !run("/bin/launchctl", &["print", &target])?.status.success() {
        return Ok(ServiceRestart::NotRunning);
    }
    let kick = run("/bin/launchctl", &["kickstart", "-k", &target])?;
    if !kick.status.success() {
        return Err(failed(&format!("launchctl kickstart -k {target}"), &kick));
    }
    Ok(ServiceRestart::Restarted)
}

/// Restart a running collector. `is-active` exits 0 only for an active unit,
/// so a stopped collector stays stopped.
#[cfg(target_os = "linux")]
fn restart_service() -> Result<ServiceRestart, String> {
    if !run("systemctl", &["--user", "is-active", SYSTEMD_UNIT])?
        .status
        .success()
    {
        return Ok(ServiceRestart::NotRunning);
    }
    let restart = run("systemctl", &["--user", "restart", SYSTEMD_UNIT])?;
    if !restart.status.success() {
        return Err(failed(&format!("systemctl --user restart {SYSTEMD_UNIT}"), &restart));
    }
    Ok(ServiceRestart::Restarted)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn restart_service() -> Result<ServiceRestart, String> {
    Ok(ServiceRestart::Unsupported)
}

/// After an install, restart the collector so hooks and the daemon run the
/// same build. Held as a job, so a quit waits for it.
#[tauri::command(async)]
pub fn restart_tacho_service(app: tauri::AppHandle) -> Result<ServiceRestart, String> {
    let _job = crate::activity::Job::start(&app);
    restart_service()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::test_support::scratch_roots;
    use serde_json::json;

    fn config(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    /// Every gate passes.
    fn mac() -> Install {
        Install {
            os: "macos",
            bundle: Some(PathBuf::from("/Applications/Oxagen.app")),
            transient: false,
            writable: true,
            same_volume_as_temp: true,
        }
    }

    #[test]
    fn auto_update_is_on_unless_set_to_anything_but_true() {
        assert!(auto_update_enabled(&config(json!({}))));
        assert!(auto_update_enabled(&config(json!({ "autoUpdate": true }))));
        assert!(!auto_update_enabled(&config(json!({ "autoUpdate": false }))));
        // A mistyped value stops installs instead of allowing them.
        assert!(!auto_update_enabled(&config(json!({ "autoUpdate": "false" }))));
        assert!(!auto_update_enabled(&config(json!({ "autoUpdate": "true" }))));
        assert!(!auto_update_enabled(&config(json!({ "autoUpdate": 0 }))));
        assert!(!auto_update_enabled(&config(json!({ "autoUpdate": null }))));
    }

    #[test]
    fn finds_the_bundle_the_plugin_would_swap() {
        assert_eq!(
            app_bundle(Path::new("/Applications/Oxagen.app/Contents/MacOS/oxagen-desktop")),
            Some(PathBuf::from("/Applications/Oxagen.app"))
        );
        assert_eq!(
            app_bundle(Path::new("/Users/a/Apps/Oxagen.app/Contents/MacOS/oxagen-desktop")),
            Some(PathBuf::from("/Users/a/Apps/Oxagen.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/bin/oxagen-desktop")), None);
        assert_eq!(
            app_bundle(Path::new("/Applications/Oxagen/Contents/MacOS/oxagen-desktop")),
            None
        );
        assert_eq!(
            app_bundle(Path::new("/Applications/Oxagen.app/Contents/Resources/tacho")),
            None
        );
        assert_eq!(app_bundle(Path::new("oxagen-desktop")), None);
    }

    #[test]
    fn every_gate_passes_on_a_mac_that_can_swap_its_own_bundle() {
        assert_eq!(blocker(&mac()), None);
    }

    #[test]
    fn each_gate_alone_blocks_an_automatic_install() {
        let cases: [(Install, &str); 5] = [
            (Install { os: "windows", ..mac() }, "macOS-only"),
            (Install { bundle: None, ..mac() }, "not running from an app bundle"),
            (
                Install {
                    transient: true,
                    ..mac()
                },
                "Move it to Applications",
            ),
            (
                Install {
                    writable: false,
                    ..mac()
                },
                "administrator password",
            ),
            (
                Install {
                    same_volume_as_temp: false,
                    ..mac()
                },
                "different disk",
            ),
        ];
        for (install, expected) in cases {
            let reason = blocker(&install).unwrap_or_else(|| panic!("{install:?} passed every gate"));
            assert!(reason.contains(expected), "{install:?}: {reason}");
        }
    }

    #[test]
    fn linux_is_blocked_before_any_bundle_check() {
        let linux = Install {
            os: "linux",
            bundle: None,
            transient: true,
            writable: false,
            same_volume_as_temp: false,
        };
        assert!(blocker(&linux).unwrap().contains("macOS-only"));
    }

    #[test]
    fn silent_needs_the_setting_on_and_no_gate_failing() {
        let on = config(json!({}));
        let off = config(json!({ "autoUpdate": false }));
        assert_eq!(
            policy(&on, &mac()),
            UpdatePolicy {
                auto_update: true,
                blocker: None,
                silent: true
            }
        );
        assert!(!policy(&off, &mac()).silent);
        assert!(!policy(&off, &mac()).auto_update);
        let blocked = policy(
            &on,
            &Install {
                writable: false,
                ..mac()
            },
        );
        assert!(blocked.auto_update);
        assert!(!blocked.silent);
        assert!(blocked.blocker.is_some());
    }

    #[test]
    fn writing_the_setting_keeps_every_other_key() {
        let roots = scratch_roots("auto-update", "/bin/zsh");
        let path = roots.desktop_config_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"autoLinkCli":false,"created":["/Users/a/.local/bin/tacho"]}"#,
        )
        .unwrap();

        write_auto_update(&roots, false).unwrap();
        let written = read_json_object(&path);
        assert_eq!(written.get("autoUpdate"), Some(&json!(false)));
        assert_eq!(written.get("autoLinkCli"), Some(&json!(false)));
        assert_eq!(written.get("created"), Some(&json!(["/Users/a/.local/bin/tacho"])));
        assert!(!auto_update_enabled(&written));

        write_auto_update(&roots, true).unwrap();
        assert!(auto_update_enabled(&read_json_object(&path)));
        let _ = std::fs::remove_dir_all(&roots.home);
    }

    #[test]
    fn writing_the_setting_creates_desktop_json_when_it_is_missing() {
        let roots = scratch_roots("auto-update-new", "/bin/zsh");
        write_auto_update(&roots, false).unwrap();
        assert!(!auto_update_enabled(&read_json_object(&roots.desktop_config_path())));
        let _ = std::fs::remove_dir_all(&roots.home);
    }

    #[test]
    fn the_launchd_target_names_the_collector_in_the_gui_domain() {
        assert_eq!(launchd_target("501"), "gui/501/sh.oxagen.tachod");
    }

    #[test]
    fn a_uid_is_digits_only() {
        assert_eq!(parse_uid("501\n"), Some("501".to_string()));
        assert_eq!(parse_uid("  0 "), Some("0".to_string()));
        assert_eq!(parse_uid(""), None);
        assert_eq!(parse_uid("uid=501"), None);
        assert_eq!(parse_uid("501 502"), None);
    }

    #[test]
    fn a_restart_result_reads_as_snake_case_on_the_page() {
        assert_eq!(
            serde_json::to_value(ServiceRestart::NotRunning).unwrap(),
            json!("not_running")
        );
        assert_eq!(
            serde_json::to_value(ServiceRestart::Restarted).unwrap(),
            json!("restarted")
        );
    }
}
