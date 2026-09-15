//! The Oxagen desktop shell. It owns no state of its own: every panel reads
//! the files the CLIs write (`~/.config/oxagen/config.json` from
//! `oxagen login`, `~/.config/oxagen/tacho/host.json` from `tacho enroll`)
//! and every action shells out to the bundled sidecars, so a user who works
//! from the terminal and a user who works from the app end up in identical
//! files. The commands here are the reads the UI polls, the two control-plane
//! calls the pickers need, and the PATH install that a sidecar cannot do for
//! itself.
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// `~/.config/oxagen` on every platform, matching `oxagenConfigPath` in
/// packages/tacho and `CONFIG_DIR` in apps/cli.
fn oxagen_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("oxagen")
}

fn tacho_root() -> PathBuf {
    std::env::var_os("TACHO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| oxagen_dir().join("tacho"))
}

fn read_json(path: &Path) -> Option<Value> {
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

/// The daemon's `/status` on the loopback port with the per-install bearer.
fn daemon_status(host: &Value) -> Option<Value> {
    let port = host.get("port")?.as_u64()?;
    let token = host.get("local_token")?.as_str()?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1500))
        .build();
    agent
        .get(&format!("http://127.0.0.1:{port}/status"))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .ok()?
        .into_json::<Value>()
        .ok()
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Where Tauri put the sidecars: next to the app executable.
fn sidecar_dir() -> Option<PathBuf> {
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
fn is_transient_dir(dir: &Path, appimage_env: bool) -> bool {
    let text = dir.to_string_lossy().replace('\\', "/");
    text.starts_with("/tmp/.mount_")
        || text.contains("/AppTranslocation/")
        || text.starts_with("/Volumes/")
        || appimage_env
}

fn sidecar_dir_is_transient() -> bool {
    sidecar_dir()
        .map(|dir| is_transient_dir(&dir, std::env::var_os("APPIMAGE").is_some()))
        .unwrap_or(false)
}

/// A per-user directory the app copies the sidecars into when it runs from
/// a transient one: `~/Library/Application Support/oxagen/bin` on macOS,
/// `~/.local/share/oxagen/bin` on Linux. Windows installs are never
/// transient (the shims embed the Program Files path).
fn durable_bin_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("oxagen")
        .join("bin")
}

fn has_both_sidecars(dir: &Path) -> bool {
    ["oxagen", "tacho"].iter().all(|name| dir.join(exe(name)).is_file())
}

/// The directory `tacho` should derive its hook and daemon commands from:
/// the sidecar directory when it lasts, else the durable copy when one
/// exists, else nothing (enrolling is refused by tacho itself until
/// `install_cli` makes the copy or the app is moved).
fn bin_dir() -> Option<PathBuf> {
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
fn export_bin_dir() {
    if sidecar_dir_is_transient() {
        if let Some(dir) = bin_dir() {
            std::env::set_var("TACHO_BIN_DIR", dir);
        }
    }
}

fn on_path(name: &str) -> Option<String> {
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

#[derive(Serialize)]
struct DesktopState {
    platform: &'static str,
    arch: &'static str,
    app_version: String,
    config: CliConfigView,
    host: Option<Value>,
    host_path: String,
    daemon: Option<Value>,
    log_path: String,
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
}

#[tauri::command]
fn desktop_state(app: tauri::AppHandle) -> DesktopState {
    let (config, _) = cli_config();
    let root = tacho_root();
    let host_path = root.join("host.json");
    let host = read_json(&host_path);
    let daemon = host.as_ref().and_then(daemon_status);
    DesktopState {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: app.package_info().version.to_string(),
        config,
        host: host.as_ref().map(host_view),
        host_path: host_path.display().to_string(),
        daemon,
        log_path: root.join("tachod.log").display().to_string(),
        sidecar_dir: sidecar_dir().map(|p| p.display().to_string()),
        sidecar_transient: sidecar_dir_is_transient(),
        bin_dir: bin_dir().map(|p| p.display().to_string()),
        oxagen_on_path: on_path("oxagen"),
        tacho_on_path: on_path("tacho"),
        cli_install_dir: cli_install_dir().display().to_string(),
    }
}

/// The only control-plane routes the webview may reach, by exact match. A
/// prefix check on the raw string is not a route check: `ureq` parses the
/// URL with the `url` crate, which resolves `..` and `%2e%2e` segments
/// before the request line is built, so `/v1/user/../../v1/<org>/...` would
/// have passed `starts_with("/v1/user/")` and reached an org-scoped route
/// with the session token.
const USER_ROUTES: [&str; 2] = ["/v1/user/organizations", "/v1/user/workspaces"];

fn is_user_route(path: &str) -> bool {
    USER_ROUTES.contains(&path)
}

/// POST to a user-scoped control-plane route with the CLI's session token.
/// Only the two picker routes in `USER_ROUTES` are reachable from the app.
#[tauri::command]
fn api_post(path: String, body: Value) -> Result<Value, String> {
    if !is_user_route(&path) {
        return Err(format!("{path} is not a user-scoped route"));
    }
    let (config, token) = cli_config();
    let token = token.ok_or_else(|| "not signed in".to_string())?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
    let response = agent
        .post(&format!("{}{}", config.api_url, path))
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "oxagen-desktop")
        .send_json(body);
    match response {
        Ok(res) => res.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, res)) => {
            let text = res.into_string().unwrap_or_default();
            Err(format!("{code}: {}", text.chars().take(300).collect::<String>()))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Where the PATH links go: a directory the user owns on every platform.
fn cli_install_dir() -> PathBuf {
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

#[derive(Serialize)]
struct InstallResult {
    dir: String,
    files: Vec<String>,
    on_path: bool,
    note: String,
}

/// Copy the two sidecars out of a transient directory into `durable_bin_dir`
/// so links, hooks and the service unit have a path that outlives this
/// launch. Returns the directory the links should target.
#[cfg(not(windows))]
fn keep_sidecars(sidecars: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let durable = durable_bin_dir();
    fs::create_dir_all(&durable)
        .map_err(|e| format!("cannot create {}: {e}", durable.display()))?;
    for name in ["oxagen", "tacho"] {
        let from = sidecars.join(exe(name));
        let to = durable.join(exe(name));
        // Copy beside, then rename: a running daemon keeps its old inode
        // and the link never points at a half-written file.
        let staging = durable.join(format!(".{}.tmp", exe(name)));
        fs::copy(&from, &staging)
            .map_err(|e| format!("cannot copy {} to {}: {e}", from.display(), staging.display()))?;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot chmod {}: {e}", staging.display()))?;
        fs::rename(&staging, &to)
            .map_err(|e| format!("cannot move {} to {}: {e}", staging.display(), to.display()))?;
    }
    Ok(durable)
}

/// Put `oxagen` and `tacho` on PATH: symlinks to the sidecars on macOS and
/// Linux, `.cmd` shims plus a user-PATH entry on Windows. Never elevates.
/// When the app runs from a directory that is gone after this launch, the
/// sidecars are first copied to a durable one and the links point there.
#[tauri::command]
fn install_cli() -> Result<InstallResult, String> {
    let bundled = sidecar_dir().ok_or("cannot locate the bundled binaries")?;
    for name in ["oxagen", "tacho"] {
        let target = bundled.join(exe(name));
        if !target.is_file() {
            return Err(format!("bundled {} is missing at {}", name, target.display()));
        }
    }
    #[cfg(not(windows))]
    let sidecars = if sidecar_dir_is_transient() {
        let kept = keep_sidecars(&bundled)?;
        export_bin_dir();
        kept
    } else {
        bundled
    };
    #[cfg(windows)]
    let sidecars = bundled;
    let dir = cli_install_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let mut files = Vec::new();
    for name in ["oxagen", "tacho"] {
        let target = sidecars.join(exe(name));
        #[cfg(windows)]
        {
            let shim = dir.join(format!("{name}.cmd"));
            fs::write(&shim, format!("@\"{}\" %*\r\n", target.display()))
                .map_err(|e| format!("cannot write {}: {e}", shim.display()))?;
            files.push(shim.display().to_string());
        }
        #[cfg(not(windows))]
        {
            let link = dir.join(name);
            let _ = fs::remove_file(&link);
            std::os::unix::fs::symlink(&target, &link)
                .map_err(|e| format!("cannot link {}: {e}", link.display()))?;
            files.push(link.display().to_string());
        }
    }
    let dir_text = dir.display().to_string();
    let already = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d == dir))
        .unwrap_or(false);
    let note = if cfg!(windows) {
        if !already {
            add_to_user_path_windows(&dir_text)?;
        }
        "Added to your user PATH; open a new terminal.".to_string()
    } else if already {
        "Already on your PATH.".to_string()
    } else {
        format!("Add `export PATH=\"{dir_text}:$PATH\"` to your shell profile.")
    };
    Ok(InstallResult {
        dir: dir_text,
        files,
        on_path: already || cfg!(windows),
        note,
    })
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

/// Remove the PATH links `install_cli` made. The sidecars stay with the app.
#[tauri::command]
fn uninstall_cli() -> Result<Vec<String>, String> {
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
    Ok(removed)
}

/// Delete `~/.config/oxagen` (session, telemetry prefs, and whatever Tacho
/// left after `unenroll --purge`). The UI only offers this after unenroll.
#[tauri::command]
fn remove_local_data() -> Result<String, String> {
    let dir = oxagen_dir();
    if tacho_root().join("host.json").is_file() {
        return Err("this machine is still enrolled; unenroll first".into());
    }
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.display().to_string())
}

#[tauri::command]
fn log_tail(lines: usize) -> String {
    let text = fs::read_to_string(tacho_root().join("tachod.log")).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any sidecar is spawned: a durable copy from an earlier
    // "Link into PATH" is what tacho must write into hooks when the app
    // runs from an AppImage or a mounted .dmg.
    export_bin_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            api_post,
            install_cli,
            uninstall_cli,
            remove_local_data,
            log_tail
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Oxagen desktop app");
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

    #[test]
    fn transient_directories_are_the_per_launch_ones() {
        let t = |p: &str| is_transient_dir(Path::new(p), false);
        assert!(t("/tmp/.mount_OxagenAb12Cd/usr/bin"));
        assert!(t("/Volumes/Oxagen/Oxagen.app/Contents/MacOS"));
        assert!(t(
            "/private/var/folders/x/T/AppTranslocation/1234-abcd/d/Oxagen.app/Contents/MacOS"
        ));
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
}
