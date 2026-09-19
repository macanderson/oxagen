# Homebrew formula for the two compiled CLIs without the desktop app:
# `tacho` (the wrapper: enroll, status, reassign, unenroll, daemon, hook) and
# `oxagen` (the platform CLI), each a Node single-executable the Desktop
# workflow builds per OS (tools/sea/compile.mjs) and attaches to the
# desktop-v<version> release next to a `<asset>.sha256` file.
#
# This is a template until a tap exists. A formula cannot say
# `sha256 :no_check` (that stanza is cask-only), so every digest below is a
# per-asset digest token that `tools/packaging/stamp.mjs` fills from the
# release's .sha256 files; see tools/packaging/README.md for the flow.
class Tacho < Formula
  desc "Wrapper putting coding agents under Oxagen control, plus the oxagen CLI"
  homepage "https://oxagen.sh/"
  version "{{version}}"
  license :cannot_represent

  livecheck do
    url :stable
    strategy :github_releases
    regex(/^desktop-v(\d+(?:\.\d+)+)$/i)
  end

  on_macos do
    on_arm do
      url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/tacho-aarch64-apple-darwin"
      sha256 "{{sha256:tacho-aarch64-apple-darwin}}"

      resource "oxagen" do
        url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/oxagen-aarch64-apple-darwin"
        sha256 "{{sha256:oxagen-aarch64-apple-darwin}}"
      end
    end

    on_intel do
      url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/tacho-x86_64-apple-darwin"
      sha256 "{{sha256:tacho-x86_64-apple-darwin}}"

      resource "oxagen" do
        url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/oxagen-x86_64-apple-darwin"
        sha256 "{{sha256:oxagen-x86_64-apple-darwin}}"
      end
    end
  end

  on_linux do
    # The release matrix builds Linux on x86_64 only (ubuntu-22.04).
    on_intel do
      url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/tacho-x86_64-unknown-linux-gnu"
      sha256 "{{sha256:tacho-x86_64-unknown-linux-gnu}}"

      resource "oxagen" do
        url "https://github.com/macanderson/oxagen/releases/download/desktop-v#{version}/oxagen-x86_64-unknown-linux-gnu"
        sha256 "{{sha256:oxagen-x86_64-unknown-linux-gnu}}"
      end
    end
  end

  def install
    # Both assets are bare executables named with their Rust triple; tacho's
    # `runtimeCommands` finds the multi-call layout (`<bin>/tacho hook`,
    # `<bin>/tacho daemon`) in a Homebrew prefix as it does inside the app.
    bin.install Dir["tacho-*"].first => "tacho"
    resource("oxagen").stage do
      bin.install Dir["oxagen-*"].first => "oxagen"
    end
  end

  def caveats
    <<~EOS
      Sign in, then enroll this machine (installs the tachod user service
      and the hooks for the harnesses you name):
        oxagen login
        tacho enroll --harness claude-code,codex,cursor,stella

      Before `brew uninstall tacho`, run `tacho unenroll` so the hooks, the
      service and the enrollment on the control plane are removed with it.
      Managed machines enroll without a browser:
        tacho enroll --token <apiKey> --org <org> --workspace <ws> --managed --harness claude-code,codex,cursor,stella
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tacho --version")
    assert_match version.to_s, shell_output("#{bin}/oxagen --version")
    # Not enrolled: status reports it and exits 1.
    assert_match "not enrolled", shell_output("#{bin}/tacho status", 1).downcase
  end
end
