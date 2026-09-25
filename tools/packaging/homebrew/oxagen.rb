# Homebrew cask for the Oxagen desktop app (apps/desktop): the .dmg the
# Desktop workflow attaches to the desktop-v<version> GitHub release.
#
# This is a template until a tap exists. `tools/packaging/stamp.mjs` fills
# the version and the `# stamp:` line from the release's .sha256 files; see
# tools/packaging/README.md for the flow.
cask "oxagen" do
  arch arm: "aarch64", intel: "x64"

  version "{{version}}"
  # Unsigned rev-1 builds carry no digest in this file, so :no_check is the
  # honest value here. The stamped copy in the tap replaces the next line with:
  # stamp: sha256 arm:   "{{sha256:Oxagen_{{version}}_aarch64.dmg}}",
  # stamp:        intel: "{{sha256:Oxagen_{{version}}_x64.dmg}}"
  sha256 :no_check

  url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/Oxagen_#{version}_#{arch}.dmg"
  name "Oxagen"
  desc "Put this machine's coding agent sessions under Oxagen control"
  homepage "https://oxagen.sh/"

  livecheck do
    url :url
    strategy :github_releases
    regex(/^desktop-v(\d+(?:\.\d+)+)$/i)
  end

  # tauri.conf.json: bundle.macOS.minimumSystemVersion = 12.0
  depends_on macos: :monterey

  app "Oxagen.app"
  # The two compiled CLIs ship as Tauri sidecars next to the app binary; the
  # app's own Command line panel links the same two files into ~/.local/bin.
  binary "#{appdir}/Oxagen.app/Contents/MacOS/tacho"
  binary "#{appdir}/Oxagen.app/Contents/MacOS/oxagen"

  # The uninstall order the app enforces: stop the collector, unenroll (strips
  # the hooks in every wrapped harness, removes the service, revokes on the
  # control plane, deletes the host credentials), then remove the app.
  # must_succeed is off because an unenrolled machine has nothing to unenroll.
  uninstall launchctl: "sh.oxagen.tachod",
            script:    {
              executable:   "#{appdir}/Oxagen.app/Contents/MacOS/tacho",
              args:         ["unenroll"],
              sudo:         false,
              must_succeed: false,
            }

  # `brew uninstall --zap`: the CLI session and whatever Tacho left behind.
  zap trash: "~/.config/oxagen"

  caveats <<~EOS
    Until releases are Developer ID signed and notarized, macOS refuses the
    first open of Oxagen.app. Choose Done, then open System Settings >
    Privacy & Security and click Open Anyway. Or clear the quarantine flag:
      xattr -dr com.apple.quarantine /Applications/Oxagen.app
  EOS
end
