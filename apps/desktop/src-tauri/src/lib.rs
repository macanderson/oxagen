//! The Oxagen desktop shell. It owns no state of its own: every panel reads
//! the files the CLIs write (`~/.config/oxagen/config.json` from
//! `oxagen login`, `~/.config/oxagen/tacho/host.json` from `tacho enroll`)
//! and every action shells out to the bundled sidecars, so a user who works
//! from the terminal and a user who works from the app end up in identical
//! files. The commands here are the reads the UI polls, the two control-plane
//! calls the pickers need, and the PATH install that a sidecar cannot do for
//! itself.
mod activity;
mod cli_install;
// Symlinks and shell profiles: the rig runs where they exist.
#[cfg(all(test, unix))]
mod install_rig_tests;
mod machine;
mod sidecar;

use activity::{Activity, ExitDecision};
use cli_install::{CliInstallState, CliInstallView};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};

/// `~/.config/oxagen` on every platform, matching `oxagenConfigPath` in
/// packages/tacho and `CONFIG_DIR` in apps/cli.
pub(crate) fn oxagen_dir() -> PathBuf {
    machine::Roots::real().oxagen_dir()
}

fn tacho_root() -> PathBuf {
    machine::Roots::real().tacho_root()
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[derive(Serialize)]
struct CliConfigView {
    path: String,
    logged_in: bool,
    org_slug: Option<String>,
    workspace_slug: Option<String>,
    api_url: String,
    app_url: String,
}

fn cli_config() -> (CliConfigView, Option<String>) {
    let path = oxagen_dir().join("config.json");
    let value = read_json(&path).unwrap_or(Value::Null);
    let token = str_field(&value, "token").filter(|t| !t.is_empty());
    let api_url = std::env::var("OXAGEN_API_URL")
        .ok()
        .or_else(|| str_field(&value, "apiUrl"))
        .unwrap_or_else(|| "https://api.oxagen.sh".to_string());
    let app_url = str_field(&value, "appUrl").unwrap_or_else(|| "https://app.oxagen.sh".to_string());
    (
        CliConfigView {
            path: path.display().to_string(),
            logged_in: token.is_some(),
            org_slug: str_field(&value, "orgSlug"),
            workspace_slug: str_field(&value, "workspaceSlug"),
            api_url: api_url.trim_end_matches('/').to_string(),
            app_url,
        },
        token,
    )
}

/// `host.json` without its secrets (host API key, local bearer, signed
/// bundle): what the Connection panel shows.
fn host_view(host: &Value) -> Value {
    let keys = [
        "host_enrollment_id",
        "agent_key",
        "organization_id",
        "workspace_id",
        "org_slug",
        "workspace_slug",
        "api_url",
        "host_status",
        "port",
        "hostname",
        "os_user",
        "platform",
        "harnesses",
        "managed",
        "claude_version",
        "claude_execpath",
        "codex_version",
        "codex_execpath",
        "cursor_version",
        "cursor_execpath",
        "stella_version",
        "stella_execpath",
        "wrapper_version",
        "hook_command",
        "daemon_command",
        "enrolled_at",
        "expires_at",
        "revoked_at",
        "bundle_fetched_at",
        "device_key_fingerprint",
    ];
    let mut out = serde_json::Map::new();
    for key in keys {
        if let Some(v) = host.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if let Some(bundle) = host.get("bundle") {
        out.insert(
            "bundle".into(),
            json!({
                "version": bundle.get("version"),
                "mode": bundle.get("mode"),
                "expires_at": bundle.get("expires_at"),
            }),
        );
    }
    Value::Object(out)
}

/// An HTTP agent whose whole request, connect to last body byte, is bounded
/// by `timeout`. A 4xx or 5xx comes back as a response rather than an error,
/// so the caller can read the body the server sent with it.
fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

/// The daemon's `/status` on the loopback port with the per-install bearer.
fn daemon_status(host: &Value) -> Option<Value> {
    let port = host.get("port")?.as_u64()?;
    let token = host.get("local_token")?.as_str()?;
    let mut res = http_agent(Duration::from_millis(1500))
        .get(&format!("http://127.0.0.1:{port}/status"))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.body_mut().read_json::<Value>().ok()
}

#[derive(Serialize)]
struct DesktopState {
    platform: &'static str,
    arch: &'static str,
    app_version: String,
    config: CliConfigView,
    host: Option<Value>,
    /// Why `host.json` is there and cannot be read, when it is. `host` is
    /// then None, which alone reads as "not enrolled".
    host_error: Option<String>,
    host_path: String,
    daemon: Option<Value>,
    log_path: String,
    /// Whether `log_path` exists yet. The collector writes it on its first
    /// run, so a machine that has not been set up has no log to open, and
    /// handing that path to the system opener only produces a launcher
    /// error about a missing file.
    log_present: bool,
    sidecar_dir: Option<String>,
    /// The sidecar directory is gone after this launch (AppImage mount,
    /// mounted .dmg, App Translocation); see `is_transient_dir`.
    sidecar_transient: bool,
    /// The directory hooks and the service may reference: the sidecar
    /// directory, or the durable copy `install_cli` made; None while the
    /// app runs from a transient directory with no copy yet.
    bin_dir: Option<String>,
    oxagen_on_path: Option<String>,
    tacho_on_path: Option<String>,
    cli_install_dir: String,
    /// Whether `cli_install_dir` holds a link this app owns. The two
    /// `*_on_path` fields cannot stand in for it: they resolve against this
    /// process's PATH, and a GUI launch on macOS or Linux never sources a
    /// shell profile, so they read as absent even right after we linked.
    cli_links_present: bool,
    /// The outcome of the automatic (or most recent manual) PATH install;
    /// see `cli_install::CliInstallView`.
    cli_install: CliInstallView,
}

/// `async` so Tauri runs it off the main thread: a synchronous command blocks
/// the window's event loop, and this one waits on the daemon's loopback
/// `/status` (up to 1.5s) every time the UI polls.
#[tauri::command(async)]
fn desktop_state(app: tauri::AppHandle, install_state: tauri::State<CliInstallState>) -> DesktopState {
    let (config, _) = cli_config();
    let root = tacho_root();
    let host_path = root.join("host.json");
    let (host, host_error) = match machine::read_host(&host_path) {
        Ok(host) => (host, None),
        Err(e) => (None, Some(e)),
    };
    let daemon = host.as_ref().and_then(daemon_status);
    let log_path = root.join("tachod.log");
    DesktopState {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: app.package_info().version.to_string(),
        config,
        host: host.as_ref().map(host_view),
        host_error,
        host_path: host_path.display().to_string(),
        daemon,
        log_path: log_path.display().to_string(),
        log_present: log_path.is_file(),
        sidecar_dir: cli_install::sidecar_dir().map(|p| p.display().to_string()),
        sidecar_transient: cli_install::sidecar_dir_is_transient(),
        bin_dir: cli_install::bin_dir().map(|p| p.display().to_string()),
        oxagen_on_path: cli_install::on_path("oxagen"),
        tacho_on_path: cli_install::on_path("tacho"),
        cli_install_dir: cli_install::cli_install_dir().display().to_string(),
        cli_links_present: cli_install::cli_links_present(),
        cli_install: install_state.0.lock().unwrap_or_else(|e| e.into_inner()).clone(),
    }
}

/// The only control-plane routes the webview may reach, by exact match. A
/// prefix check on the raw string is not a route check: an HTTP client or
/// proxy may resolve `..` and `%2e%2e` segments before the request reaches
/// the server (ureq 2 did, through the `url` crate), so
/// `/v1/user/../../v1/<org>/...` would have passed `starts_with("/v1/user/")`
/// and reached an org-scoped route with the session token.
const USER_ROUTES: [&str; 2] = ["/v1/user/organizations", "/v1/user/workspaces"];

fn is_user_route(path: &str) -> bool {
    USER_ROUTES.contains(&path)
}

/// POST to a user-scoped control-plane route with the CLI's session token.
/// Only the two picker routes in `USER_ROUTES` are reachable from the app.
/// `async` for the same reason as `desktop_state`, and more so: this waits on
/// the control plane for up to 15 seconds, which is 15 seconds of a frozen
/// window if it runs on the main thread.
#[tauri::command(async)]
fn api_post(path: String, body: Value) -> Result<Value, String> {
    if !is_user_route(&path) {
        return Err(format!("{path} is not a user-scoped route"));
    }
    let (config, token) = cli_config();
    let token = token.ok_or_else(|| "not signed in".to_string())?;
    let mut res = http_agent(Duration::from_secs(15))
        .post(&format!("{}{}", config.api_url, path))
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", "oxagen-desktop")
        .send_json(body)
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status.is_success() {
        return res.body_mut().read_json::<Value>().map_err(|e| e.to_string());
    }
    let text = res.body_mut().read_to_string().unwrap_or_default();
    Err(format!(
        "{}: {}",
        status.as_u16(),
        text.chars().take(300).collect::<String>()
    ))
}

/// "Uninstall": everything the app put on this machine that `tacho unenroll`
/// does not own. See `cli_install::remove_everything_in`. The report names
/// what was removed and what is still there, so the UI says what happened
/// instead of "everything is gone". `async` so Tauri runs it off the main
/// thread: it can wait on the launch-time install, and `remove_dir_all` over
/// the collector's spool and WAL is no quicker.
#[tauri::command(async)]
fn remove_local_data(
    app: tauri::AppHandle,
    install_state: tauri::State<CliInstallState>,
) -> Result<cli_install::RemovalReport, String> {
    let _job = activity::Job::start(&app);
    cli_install::remove_everything_in(&cli_install::InstallEnv::real(), &install_state)
}

/// The end of the collector log. Bounded: see `machine::tail_lines`.
#[tauri::command(async)]
fn log_tail(lines: usize) -> String {
    machine::tail_lines(&tacho_root().join("tachod.log"), lines, 256 * 1024)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any sidecar is spawned, and before any thread exists: a durable
    // copy from an earlier launch is what tacho must write into hooks when
    // the app runs from an AppImage or a mounted .dmg. A copy
    // `ensure_cli_installed` makes later in this launch reaches the sidecars
    // through `sidecar::run_sidecar` instead; see `cli_install::export_bin_dir`.
    cli_install::export_bin_dir();
    // Before any sidecar can create `~/.config`, so Uninstall knows whether
    // the person had one already. See `cli_install::record_config_dir`.
    let _ = cli_install::record_config_dir(&machine::Roots::real());
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(CliInstallState::default())
        .manage(Activity::default())
        .manage(sidecar::Running::default())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Oxagen", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Oxagen", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("Oxagen")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        // The person is back: a close that was waiting for
                        // work to end no longer quits the app.
                        app.state::<Activity>().cancel_exit();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Auto-install on every launch, off the main thread so the
            // window is never blocked (the login-shell PATH probe alone can
            // take up to 5s). `install_cli` / `uninstall_cli` update the
            // same managed state afterward if the user acts manually.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _job = activity::Job::start(&handle);
                if let Some(state) = handle.try_state::<CliInstallState>() {
                    cli_install::ensure_cli_installed(&state);
                }
            });

            Ok(())
        })
        // Closing the window while work runs hides it, and the app exits
        // when the work ends: see `activity`.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Activity>().request_exit() == ExitDecision::WhenIdle {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            api_post,
            cli_install::install_cli,
            cli_install::uninstall_cli,
            remove_local_data,
            sidecar::run_sidecar,
            sidecar::kill_sidecar,
            activity::set_busy,
            log_tail
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Oxagen desktop app")
        .run(|app, event| {
            // The tray's Quit, and the last window closing, while work runs:
            // the same as a close.
            if let RunEvent::ExitRequested { api, .. } = &event {
                if app.state::<Activity>().request_exit() == ExitDecision::WhenIdle {
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_picker_routes_are_user_routes() {
        assert!(is_user_route("/v1/user/organizations"));
        assert!(is_user_route("/v1/user/workspaces"));
        // What a prefix check let through: dot-segments the URL parser
        // resolves before the request line is built, and their encodings.
        assert!(!is_user_route("/v1/user/../../v1/acme/core/tacho/enrollments"));
        assert!(!is_user_route("/v1/user/%2e%2e/%2e%2e/v1/acme/core/tacho/enrollments"));
        assert!(!is_user_route("/v1/user//organizations"));
        assert!(!is_user_route("/v1/user/organizations?x=1"));
        assert!(!is_user_route("/v1/user/organizations#f"));
        assert!(!is_user_route("/v1/user/"));
        assert!(!is_user_route("/v1/acme/core/tacho/enrollments"));
    }
}
