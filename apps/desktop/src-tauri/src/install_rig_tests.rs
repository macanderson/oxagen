//! The desktop half of the install and uninstall rig. It runs "Link into
//! PATH", the launch-time copy of the sidecars, and "Uninstall" for real
//! against a scratch home seeded with a user's own files, and compares the
//! whole tree before and after. Nothing
//! here reads `$HOME`, `$SHELL` or the real `~/.local/bin`: every path comes
//! from a `Roots` over a temp directory, and no login shell is spawned. The
//! other half, `tacho enroll` and `unenroll`, is
//! `packages/tacho/src/cli/install-rig.test.ts`.

use crate::cli_install::{
    ensure_cli_installed_in, link_cli_in, record_config_dir, remove_everything_in, unlink_cli_in, write_auto_link_cli,
    CliInstallState, InstallEnv,
};
use crate::machine::test_support::{scratch_roots, snapshot};
use crate::machine::Roots;
use std::fs;
use std::path::{Path, PathBuf};

const USER_ZPROFILE: &str = "export EDITOR=vim\nexport PATH=\"$HOME/bin:$PATH\"\n";

fn put(path: &Path, text: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// The version every rig environment carries, and so the name of the
/// per-user directory its sidecars are copied into.
const RIG_VERSION: &str = "2.1.3";

/// The installed app's sidecars, and an environment that never asks a shell.
fn env_for(roots: Roots, transient: bool) -> InstallEnv {
    let sidecars: PathBuf = roots
        .home
        .join("Applications")
        .join("Oxagen.app")
        .join("Contents")
        .join("MacOS");
    for name in ["oxagen", "tacho"] {
        put(&sidecars.join(name), b"#!/bin/sh\n");
    }
    InstallEnv {
        roots,
        sidecars: Some(sidecars),
        transient,
        version: RIG_VERSION.to_string(),
        process_path: "/usr/bin:/bin".to_string(),
        login_path: Some("/usr/bin:/bin".to_string()),
    }
}

/// What "Uninstall" is allowed to change: nothing outside `.config/oxagen`,
/// which is Oxagen's own directory and is removed whole (the CLI session
/// `oxagen login` wrote included). Everything else must be byte-identical.
fn without_oxagen_dir(
    mut tree: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    tree.retain(|path, _| !path.starts_with(".config/oxagen"));
    tree
}

#[cfg(unix)]
#[test]
fn link_twice_then_uninstall_twice_leaves_the_home_byte_identical() {
    let roots = scratch_roots("zsh", "/bin/zsh");
    put(&roots.home.join(".zprofile"), USER_ZPROFILE.as_bytes());
    // The user's own `oxagen`, which is not ours to replace or remove.
    put(&roots.home.join(".local/bin/oxagen"), b"#!/bin/sh\necho mine\n");
    put(&roots.home.join(".config/other/keep.toml"), b"x = 1\n");
    put(&roots.oxagen_dir().join("config.json"), b"{\"token\":\"t\"}\n");
    let env = env_for(roots, false);
    let before = snapshot(&env.roots.home);

    let first = link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(first.state, "linked", "{first:?}");
    // The link names the per-user copy, never the bundle (ADR-230).
    let link = env.roots.home.join(".local/bin/tacho");
    assert_eq!(fs::read_link(&link).unwrap(), env.kept_dir().join("tacho"));
    assert_eq!(env.kept_dir(), env.roots.durable_bin_dir().join(RIG_VERSION));
    assert_eq!(
        fs::read(env.roots.home.join(".local/bin/oxagen")).unwrap(),
        b"#!/bin/sh\necho mine\n"
    );
    assert!(first.skipped.iter().any(|note| note.contains("oxagen")), "{first:?}");
    let profile = fs::read_to_string(env.roots.home.join(".zprofile")).unwrap();
    assert!(profile.starts_with(USER_ZPROFILE));
    assert_eq!(profile.matches("# >>> oxagen >>>").count(), 1);
    // Appended: the user's own `$HOME/bin` still wins over `~/.local/bin`.
    let line = format!(
        "export PATH=\"$PATH:{}\"\n",
        env.roots.home.join(".local/bin").display()
    );
    assert!(profile.contains(&line), "{profile}");

    // Again: nothing moves, nothing is duplicated.
    let linked = snapshot(&env.roots.home);
    let second = link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert_ne!(second.state, "failed");
    assert_eq!(snapshot(&env.roots.home), linked);

    // Uninstall: identical but for Oxagen's own directory, which is gone.
    let report = remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(report.left.iter().all(|note| note.contains("left alone")), "{report:?}");
    assert_eq!(snapshot(&env.roots.home), without_oxagen_dir(before.clone()));
    assert!(!env.roots.oxagen_dir().exists());

    // Again: a clean no-op.
    let again = remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(again.removed.is_empty(), "{again:?}");
    assert_eq!(snapshot(&env.roots.home), without_oxagen_dir(before));
}

#[cfg(unix)]
#[test]
fn what_install_had_to_create_is_removed_with_it() {
    // No profile, no ~/.local, no ~/.config: install makes all three.
    let env = env_for(scratch_roots("bare", "/bin/zsh"), false);
    let before = snapshot(&env.roots.home);
    assert_eq!(link_cli_in(&env, &CliInstallState::default()).unwrap().state, "linked");
    assert!(env.roots.home.join(".zprofile").is_file());
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), before);
}

#[cfg(unix)]
#[test]
fn a_created_profile_the_user_has_since_written_in_is_kept() {
    let env = env_for(scratch_roots("kept", "/bin/zsh"), false);
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    let profile = env.roots.home.join(".zprofile");
    let mut text = fs::read_to_string(&profile).unwrap();
    text.insert_str(0, "export MINE=1\n");
    fs::write(&profile, text).unwrap();
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(fs::read_to_string(&profile).unwrap().trim_end(), "export MINE=1");
}

#[cfg(unix)]
#[test]
fn the_versioned_copy_made_for_a_disk_image_launch_is_removed() {
    let env = env_for(scratch_roots("transient", "/bin/zsh"), true);
    put(&env.roots.home.join(".zprofile"), USER_ZPROFILE.as_bytes());
    let before = snapshot(&env.roots.home);
    assert_eq!(link_cli_in(&env, &CliInstallState::default()).unwrap().state, "linked");
    let kept = env.kept_dir();
    assert!(kept.join("tacho").is_file());
    assert_eq!(
        fs::read_link(env.roots.home.join(".local/bin/tacho")).unwrap(),
        kept.join("tacho")
    );
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), before);
}

/// #4298: the app moved to the Trash takes its bundle with it. Every link,
/// and the per-user copy the hooks name, is outside the bundle, so each
/// still resolves to a file.
#[cfg(unix)]
#[test]
fn the_app_in_the_trash_leaves_every_link_resolving_to_the_kept_copy() {
    let env = env_for(scratch_roots("trash", "/bin/zsh"), false);
    assert_eq!(link_cli_in(&env, &CliInstallState::default()).unwrap().state, "linked");
    let bundle = env.sidecars.clone().unwrap();
    // The whole `Oxagen.app`, as Finder removes it.
    fs::remove_dir_all(bundle.parent().unwrap().parent().unwrap()).unwrap();
    assert!(!bundle.exists());
    let kept = fs::canonicalize(env.kept_dir()).unwrap();
    for name in ["oxagen", "tacho"] {
        let resolved = fs::canonicalize(env.roots.home.join(".local/bin").join(name)).unwrap();
        assert!(resolved.starts_with(&kept), "{resolved:?}");
        assert!(resolved.is_file());
    }
}

/// A Linux package whose binaries are already on PATH needs no link, and
/// still gets the per-user copy: removing the package takes `/usr/bin/tacho`
/// with it, and the hooks name the copy.
#[cfg(unix)]
#[test]
fn a_package_already_on_path_still_gets_the_kept_copy() {
    let mut env = env_for(scratch_roots("package", "/bin/zsh"), false);
    env.process_path = format!("{}:/usr/bin", env.sidecars.clone().unwrap().display());
    let before = snapshot(&env.roots.home);
    let view = link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(view.state, "already", "{view:?}");
    assert!(env.kept_dir().join("tacho").is_file());
    assert!(!env.roots.home.join(".local/bin").exists());
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), without_oxagen_dir(before));
}

#[cfg(unix)]
#[test]
fn macos_bash_gets_its_block_in_the_profile_bash_already_reads() {
    let mut roots = scratch_roots("bash", "/bin/bash");
    roots.os = "macos";
    put(&roots.home.join(".profile"), b"export FROM_PROFILE=1\n");
    let env = env_for(roots, false);
    let before = snapshot(&env.roots.home);
    let view = link_cli_in(&env, &CliInstallState::default()).unwrap();
    // Creating .bash_profile would stop bash reading .profile at all.
    assert!(!env.roots.home.join(".bash_profile").exists());
    assert_eq!(
        view.profile,
        Some(env.roots.home.join(".profile").display().to_string())
    );
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), before);
}

#[cfg(unix)]
#[test]
fn a_profile_that_is_not_utf8_is_never_rewritten() {
    let roots = scratch_roots("latin1", "/bin/zsh");
    let original = b"export NAME=Jos\xe9\nexport KEEP=1\n".to_vec();
    put(&roots.home.join(".zprofile"), &original);
    let env = env_for(roots, false);
    let view = link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(fs::read(env.roots.home.join(".zprofile")).unwrap(), original);
    assert!(view.skipped.iter().any(|note| note.contains("not UTF-8")), "{view:?}");
    assert!(view.profile.is_none());
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(fs::read(env.roots.home.join(".zprofile")).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn a_symlinked_profile_stays_a_link_and_comes_back_byte_identical() {
    let roots = scratch_roots("dotfiles", "/bin/zsh");
    put(&roots.home.join("dotfiles/zprofile"), USER_ZPROFILE.as_bytes());
    std::os::unix::fs::symlink(Path::new("dotfiles").join("zprofile"), roots.home.join(".zprofile")).unwrap();
    let env = env_for(roots, false);
    let before = snapshot(&env.roots.home);
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert!(fs::read_to_string(env.roots.home.join("dotfiles/zprofile"))
        .unwrap()
        .contains(">>> oxagen >>>"));
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), before);
}

#[cfg(unix)]
#[test]
fn fish_gets_its_own_file_and_loses_it_again() {
    let env = env_for(scratch_roots("fish", "/opt/homebrew/bin/fish"), false);
    let before = snapshot(&env.roots.home);
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    let fish = fs::read_to_string(env.roots.home.join(".config/fish/conf.d/oxagen.fish")).unwrap();
    assert!(fish.contains("fish_add_path --global --path --append "), "{fish}");
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), before);
}

#[cfg(unix)]
#[test]
fn uninstall_is_refused_while_enrolled_and_allowed_once_the_host_is_retired() {
    let env = env_for(scratch_roots("retired", "/bin/zsh"), false);
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    let host = env.roots.tacho_root().join("agents/0a1b2c3d/host.json");
    put(&host, br#"{"host_enrollment_id":"tch_1","revoked_at":null}"#);
    let enrolled = snapshot(&env.roots.home);
    assert!(remove_everything_in(&env, &CliInstallState::default())
        .unwrap_err()
        .contains("still enrolled"));
    assert_eq!(snapshot(&env.roots.home), enrolled);
    // An offline `tacho unenroll` keeps host.json, marked. That is not enrolled.
    put(
        &host,
        br#"{"host_enrollment_id":"tch_1","revoked_at":"2026-09-18T00:00:00Z"}"#,
    );
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(!env.roots.oxagen_dir().exists());
    assert!(!env.roots.home.join(".local/bin/tacho").exists());
}

/// ADR-203: each agent keeps its own enrollment under `agents/`. One live
/// agent refuses Uninstall whatever else is there, and so does the legacy
/// root file tachod has not moved yet.
#[cfg(unix)]
#[test]
fn uninstall_is_refused_while_any_agent_is_still_enrolled() {
    let env = env_for(scratch_roots("two-agents", "/bin/zsh"), false);
    let root = env.roots.tacho_root();
    put(
        &root.join("agents/ffff0001/host.json"),
        br#"{"host_enrollment_id":"tch_1","revoked_at":"2026-09-18T00:00:00Z"}"#,
    );
    let live = root.join("agents/0000aaaa/host.json");
    put(&live, br#"{"host_enrollment_id":"tch_2","revoked_at":null}"#);
    assert!(remove_everything_in(&env, &CliInstallState::default())
        .unwrap_err()
        .contains("still enrolled"));
    fs::remove_file(&live).unwrap();
    let legacy = root.join("host.json");
    put(&legacy, br#"{"host_enrollment_id":"tch_3","revoked_at":null}"#);
    assert!(remove_everything_in(&env, &CliInstallState::default())
        .unwrap_err()
        .contains("still enrolled"));
    fs::remove_file(&legacy).unwrap();
    // Only the retired agent is left, and its revoke is reported.
    let report = remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(report.pending_revoke.unwrap().host_enrollment_id, "tch_1");
    assert!(!root.exists());
}

/// `tree` without the per-user copy, the directories above it, and
/// `desktop.json`, which records the directories made for the copy.
fn without_kept_copy(
    env: &InstallEnv,
    mut tree: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let data_local = env
        .roots
        .data_local
        .strip_prefix(&env.roots.home)
        .unwrap()
        .to_path_buf();
    tree.retain(|path, _| {
        let path = Path::new(path);
        !path.starts_with(&data_local)
            && !data_local.starts_with(path)
            && path != Path::new(".config/oxagen/desktop.json")
    });
    tree
}

#[cfg(unix)]
#[test]
fn remove_links_without_a_link_changes_nothing_and_an_opted_out_launch_only_keeps_the_copy() {
    let env = env_for(scratch_roots("noop", "/bin/zsh"), false);
    put(&env.roots.home.join(".zprofile"), USER_ZPROFILE.as_bytes());
    let before = snapshot(&env.roots.home);
    let outcome = unlink_cli_in(&env);
    assert!(outcome.removed.is_empty() && outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(snapshot(&env.roots.home), before);
    write_auto_link_cli(&env.roots, false).unwrap();
    let opted_out = snapshot(&env.roots.home);
    assert_eq!(
        ensure_cli_installed_in(&env, &CliInstallState::default()).state,
        "opted_out"
    );
    // No link and no profile edit. The copy is made all the same, because
    // enrollment names it whatever the PATH setting says (ADR-230).
    assert!(env.kept_dir().join("tacho").is_file());
    assert!(!env.roots.home.join(".local/bin").exists());
    assert_eq!(
        without_kept_copy(&env, snapshot(&env.roots.home)),
        without_kept_copy(&env, opted_out)
    );
}

/// #4298: "Remove links" cannot remove the per-user copy's directories,
/// because every launch fills them with the sidecars. It keeps them recorded,
/// so Uninstall, which removes the copy, then removes them too.
#[cfg(unix)]
#[test]
fn uninstall_after_remove_links_leaves_the_home_as_it_was() {
    let env = env_for(scratch_roots("unlinked", "/bin/zsh"), false);
    put(&env.roots.home.join(".zprofile"), USER_ZPROFILE.as_bytes());
    let before = snapshot(&env.roots.home);
    assert_eq!(link_cli_in(&env, &CliInstallState::default()).unwrap().state, "linked");
    unlink_cli_in(&env);
    assert!(env.kept_dir().join("tacho").is_file());
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(!env.roots.durable_bin_dir().exists());
    assert_eq!(snapshot(&env.roots.home), before);
}

#[cfg(unix)]
#[test]
fn a_stale_link_into_an_older_app_is_replaced_and_a_foreign_one_is_not() {
    let env = env_for(scratch_roots("stale", "/bin/zsh"), false);
    let bin = env.roots.home.join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    std::os::unix::fs::symlink("/Volumes/Oxagen/Oxagen.app/Contents/MacOS/tacho", bin.join("tacho")).unwrap();
    std::os::unix::fs::symlink("/opt/homebrew/Cellar/oxagen/1.0/bin/oxagen", bin.join("oxagen")).unwrap();
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(fs::read_link(bin.join("tacho")).unwrap(), env.kept_dir().join("tacho"));
    assert_eq!(
        fs::read_link(bin.join("oxagen")).unwrap(),
        Path::new("/opt/homebrew/Cellar/oxagen/1.0/bin/oxagen")
    );
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(fs::symlink_metadata(bin.join("tacho")).is_err());
    assert!(fs::symlink_metadata(bin.join("oxagen")).is_ok());
}

/// Each pass stores what `desktop_state` reports before it lets the next one
/// in. The launch-time pass used to store its "linked" after releasing the
/// lock, so a "Remove links" that ran in between was reported as linked.
#[cfg(unix)]
#[test]
fn every_pass_stores_its_outcome_while_it_still_holds_the_lock() {
    let env = env_for(scratch_roots("state", "/bin/zsh"), false);
    write_auto_link_cli(&env.roots, true).unwrap();
    let state = CliInstallState::default();
    let current = |state: &CliInstallState| state.0.lock().unwrap().state.clone();
    assert_eq!(ensure_cli_installed_in(&env, &state).state, "linked");
    assert_eq!(current(&state), "linked");
    remove_everything_in(&env, &state).unwrap();
    assert_eq!(current(&state), "opted_out");
    assert_eq!(link_cli_in(&env, &state).unwrap().state, "linked");
    assert_eq!(current(&state), "linked");

    // A launch pass racing a removal: whichever runs second is what the
    // state says, and it matches the disk.
    let (launch, removed) = std::thread::scope(|scope| {
        let launch = scope.spawn(|| ensure_cli_installed_in(&env, &state));
        let removed = remove_everything_in(&env, &state);
        (launch.join().unwrap(), removed)
    });
    assert!(removed.is_ok(), "{removed:?}");
    let linked = fs::symlink_metadata(env.roots.home.join(".local/bin/tacho")).is_ok();
    assert_eq!(current(&state) == "linked", linked, "{launch:?}");
}

/// #4318: an empty `~/.config` the person had before Oxagen is still there
/// after Uninstall. Only a launch that found no `~/.config` records that the
/// app made it, and only then does Uninstall remove it.
#[cfg(unix)]
#[test]
fn an_empty_config_directory_the_person_already_had_is_kept() {
    let roots = scratch_roots("config-kept", "/bin/zsh");
    fs::create_dir_all(roots.home.join(".config")).unwrap();
    let env = env_for(roots, false);
    let before = snapshot(&env.roots.home);
    // Launch, then what `oxagen login` writes, then Link into PATH.
    record_config_dir(&env.roots).unwrap();
    put(&env.roots.oxagen_dir().join("config.json"), b"{\"token\":\"t\"}\n");
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(env.roots.home.join(".config").is_dir());
    assert_eq!(snapshot(&env.roots.home), before);
}

#[cfg(unix)]
#[test]
fn a_config_directory_the_app_created_goes_with_it() {
    let env = env_for(scratch_roots("config-created", "/bin/zsh"), false);
    let before = snapshot(&env.roots.home);
    assert!(!env.roots.home.join(".config").exists());
    record_config_dir(&env.roots).unwrap();
    assert!(env.roots.home.join(".config").is_dir());
    // A second launch finds `~/.config` and changes nothing.
    let launched = snapshot(&env.roots.home);
    record_config_dir(&env.roots).unwrap();
    assert_eq!(snapshot(&env.roots.home), launched);
    put(&env.roots.oxagen_dir().join("config.json"), b"{\"token\":\"t\"}\n");
    let report = remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(!env.roots.home.join(".config").exists());
    assert!(
        report.removed.iter().any(|path| path.ends_with(".config")),
        "{report:?}"
    );
    assert_eq!(snapshot(&env.roots.home), before);
}

/// Audit D-06: an offline `tacho unenroll` keeps a retired `host.json` so the
/// revoke can be finished, and Uninstall then deletes it. The report names
/// the agent key the fleet page still lists, read before the file goes.
#[cfg(unix)]
#[test]
fn uninstall_names_the_revoke_a_retired_host_still_owes() {
    let env = env_for(scratch_roots("pending-revoke", "/bin/zsh"), false);
    let host = env.roots.tacho_root().join("agents/0a1b2c3d/host.json");
    put(
        &host,
        br#"{"host_enrollment_id":"tch_1","agent_key":"acme.core.cc-laptop","revoked_at":"2026-09-18T00:00:00Z"}"#,
    );
    let report = remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert!(!host.exists());
    let pending = report
        .pending_revoke
        .as_ref()
        .expect("the retired host's revoke is reported");
    assert_eq!(pending.agent_key, "acme.core.cc-laptop");
    assert_eq!(pending.host_enrollment_id, "tch_1");
    assert!(report.left.is_empty(), "{report:?}");
    // Nothing retired, nothing owed.
    let clean = env_for(scratch_roots("no-revoke", "/bin/zsh"), false);
    assert!(remove_everything_in(&clean, &CliInstallState::default())
        .unwrap()
        .pending_revoke
        .is_none());
}

/// The journal as `desktop.json` holds it.
fn journal_of(roots: &Roots) -> Vec<serde_json::Value> {
    let text = fs::read_to_string(roots.desktop_config_path()).unwrap();
    let config: serde_json::Value = serde_json::from_str(&text).unwrap();
    config
        .get("journal")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// ADR-230, amendment of 2026-10-02: a launch journals what it wrote, so
/// `oxagen agent uninstall` can remove exactly that once the app is gone
/// (`packages/tacho/src/cli/uninstall.test.ts` reads this shape). The
/// person's own `oxagen` was not written, so nothing names it. "Remove links"
/// drops what it took off, and the copy stays named.
#[cfg(unix)]
#[test]
fn the_journal_names_what_an_install_wrote_and_drops_what_remove_links_took() {
    let roots = scratch_roots("journal", "/bin/zsh");
    put(&roots.home.join(".zprofile"), USER_ZPROFILE.as_bytes());
    put(&roots.home.join(".local/bin/oxagen"), b"#!/bin/sh\necho mine\n");
    let env = env_for(roots, false);
    assert_eq!(link_cli_in(&env, &CliInstallState::default()).unwrap().state, "linked");
    let kept = env.kept_dir();
    let copy = serde_json::json!({ "kind": "copy", "path": kept.display().to_string() });
    let journal = vec![
        copy.clone(),
        serde_json::json!({
            "kind": "link",
            "path": env.roots.home.join(".local/bin/tacho").display().to_string(),
            "target": kept.join("tacho").display().to_string(),
        }),
        serde_json::json!({
            "kind": "profile",
            "path": env.roots.home.join(".zprofile").display().to_string(),
        }),
    ];
    assert_eq!(journal_of(&env.roots), journal);

    // A second launch finds each thing as it left it and records nothing new.
    link_cli_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(journal_of(&env.roots), journal);

    let outcome = unlink_cli_in(&env);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(journal_of(&env.roots), vec![copy]);
}
