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
        oxagen_on_path: on_path("oxagen"),
        tacho_on_path: on_path("tacho"),
        cli_install_dir: cli_install_dir().display().to_string(),
    }
}

/// POST to a user-scoped control-plane route with the CLI's session token.
/// Only `/v1/user/*` is reachable from the app: that is all the pickers need.
#[tauri::command]
fn api_post(path: String, body: Value) -> Result<Value, String> {
    if !path.starts_with("/v1/user/") {
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

/// Put `oxagen` and `tacho` on PATH: symlinks to the sidecars on macOS and
/// Linux, `.cmd` shims plus a user-PATH entry on Windows. Never elevates.
#[tauri::command]
fn install_cli() -> Result<InstallResult, String> {
    let sidecars = sidecar_dir().ok_or("cannot locate the bundled binaries")?;
    let dir = cli_install_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let mut files = Vec::new();
    for name in ["oxagen", "tacho"] {
        let target = sidecars.join(exe(name));
        if !target.is_file() {
            return Err(format!("bundled {} is missing at {}", name, target.display()));
        }
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

#[cfg(windows)]
fn add_to_user_path_windows(dir: &str) -> Result<(), String> {
    // setx truncates at 1024 characters; the .NET API does not.
    let script = format!(
        "$p=[Environment]::GetEnvironmentVariable('Path','User'); if(($p -split ';') -notcontains '{dir}'){{ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';{dir}'), 'User') }}"
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
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
