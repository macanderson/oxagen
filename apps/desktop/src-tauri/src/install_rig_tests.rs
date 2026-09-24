//! The desktop half of the install and uninstall rig. It runs "Link into
//! PATH" and "Uninstall" for real against a scratch home seeded with a
//! user's own files, and compares the whole tree before and after. Nothing
//! here reads `$HOME`, `$SHELL` or the real `~/.local/bin`: every path comes
//! from a `Roots` over a temp directory, and no login shell is spawned. The
//! other half, `tacho enroll` and `unenroll`, is
//! `packages/tacho/src/cli/install-rig.test.ts`.

use crate::cli_install::{
    ensure_cli_installed_in, link_cli_in, remove_everything_in, unlink_cli_in, write_auto_link_cli, CliInstallState,
    InstallEnv,
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
    let link = env.roots.home.join(".local/bin/tacho");
    assert_eq!(
        fs::read_link(&link).unwrap(),
        env.sidecars.clone().unwrap().join("tacho")
    );
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
fn the_durable_copy_made_for_a_disk_image_launch_is_removed() {
    let env = env_for(scratch_roots("transient", "/bin/zsh"), true);
    put(&env.roots.home.join(".zprofile"), USER_ZPROFILE.as_bytes());
    let before = snapshot(&env.roots.home);
    assert_eq!(link_cli_in(&env, &CliInstallState::default()).unwrap().state, "linked");
    let durable = env.roots.durable_bin_dir();
    assert!(durable.join("tacho").is_file());
    assert_eq!(
        fs::read_link(env.roots.home.join(".local/bin/tacho")).unwrap(),
        durable.join("tacho")
    );
    remove_everything_in(&env, &CliInstallState::default()).unwrap();
    assert_eq!(snapshot(&env.roots.home), before);
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
    let host = env.roots.tacho_root().join("host.json");
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

#[cfg(unix)]
#[test]
fn remove_links_without_a_link_and_an_opted_out_launch_change_nothing() {
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
    assert_eq!(snapshot(&env.roots.home), opted_out);
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
    assert_eq!(
        fs::read_link(bin.join("tacho")).unwrap(),
        env.sidecars.clone().unwrap().join("tacho")
    );
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
