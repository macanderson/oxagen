// @vitest-environment jsdom
/**
 * The React tree against a fake bridge: the machine reads as enrolled with
 * Claude Code wrapped and the collector answering. Each test drives the
 * window the way a person does and checks what the bridge was asked to run.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectResult, DesktopState, HostView } from "./bridge";

// React warns unless the test environment says it drives updates in act().
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const host: HostView = {
  host_enrollment_id: "tch_1",
  agent_key: "acme.core.cc-laptop",
  organization_id: "org_1",
  workspace_id: "ws_1",
  org_slug: "acme",
  workspace_slug: "core",
  api_url: "https://api.oxagen.sh",
  host_status: "active",
  port: 47001,
  hostname: "mac",
  os_user: "mac",
  platform: "darwin",
  harnesses: ["claude-code"],
  managed: false,
  claude_version: "2.1.263",
  claude_execpath: "/usr/local/bin/claude",
  wrapper_version: "2.1.1",
  hook_command: "tacho hook",
  daemon_command: ["tacho", "daemon"],
  enrolled_at: "2026-09-01T00:00:00Z",
  expires_at: "2027-09-01T00:00:00Z",
  revoked_at: null,
  bundle_fetched_at: "2026-09-15T00:00:00Z",
  device_key_fingerprint: "ed25519:abc",
  bundle: { version: 3, mode: "enforce", expires_at: "2027-09-01T00:00:00Z" },
};

const machine: DesktopState = {
  platform: "macos",
  arch: "aarch64",
  app_version: "2.1.1",
  config: {
    path: "/Users/a/.config/oxagen/config.json",
    logged_in: true,
    org_slug: "acme",
    workspace_slug: "core",
    api_url: "https://api.oxagen.sh",
    app_url: "https://app.oxagen.sh",
  },
  host,
  host_path: "/Users/a/.config/oxagen/tacho/host.json",
  daemon: { uptime_s: 100, spool_depth: 0, agents: [] },
  log_path: "/Users/a/.config/oxagen/tacho/tachod.log",
  log_present: true,
  sidecar_dir: "/Applications/Oxagen.app/Contents/MacOS",
  sidecar_transient: false,
  bin_dir: "/Applications/Oxagen.app/Contents/MacOS",
  oxagen_on_path: null,
  tacho_on_path: null,
  cli_install_dir: "/Users/a/.local/bin",
};

const bridge = vi.hoisted(() => ({
  connectRun: vi.fn(),
  reportBusy: vi.fn(),
}));

vi.mock("./bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bridge")>();
  return {
    ...real,
    readState: vi.fn(async () => machine),
    tachoStatus: vi.fn(async () => null),
    listOrganizations: vi.fn(async () => [
      { id: "org_1", slug: "acme", name: "Acme" },
    ]),
    listWorkspaces: vi.fn(async () => [{ slug: "core", name: "Core" }]),
    logTail: vi.fn(async () => ""),
    reportBusy: bridge.reportBusy,
    connectRun: bridge.connectRun,
    runSidecar: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  };
});
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("./update-watch", () => ({
  promptVisible: () => false,
  startUpdateWatch: () => ({ stop: () => undefined, handled: () => undefined }),
}));
vi.mock("./updater", () => ({
  checkForUpdate: vi.fn(async () => ({
    result: { available: false },
    update: null,
  })),
  describeCheck: () => null,
  installUpdate: vi.fn(),
}));

const { App } = await import("./app");

/** Render the window and let the first read of the machine land. */
async function renderEnrolled() {
  render(<App />);
  return screen.findByRole("button", { name: "Run connect prompt" });
}

beforeEach(() => {
  bridge.connectRun.mockReset();
  bridge.reportBusy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("the window", () => {
  // #4318 item 7: runConnect set `busy` but not `busyRef`, so a second
  // click that landed before React disabled the button started a second
  // verify loop beside the first, and each recorded its own run.
  it("starts one first run when the button is clicked twice before React disables it", async () => {
    let finish: (result: ConnectResult) => void = () => undefined;
    bridge.connectRun.mockImplementation(
      () =>
        new Promise<ConnectResult>((resolve) => {
          finish = resolve;
        }),
    );
    const button = await renderEnrolled();
    // Both clicks in one batch: the second lands before the re-render that
    // disables the button.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bridge.connectRun).toHaveBeenCalledTimes(1);
    expect(bridge.connectRun).toHaveBeenCalledWith(
      "claude-code",
      expect.any(Function),
    );
    await act(async () => {
      finish({ ok: true, seq: 6, detail: "chained" });
    });
    // Done, so the next click runs again.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bridge.connectRun).toHaveBeenCalledTimes(2);
  });

  // Audit D-11: the Rust shell holds a close while the page is busy.
  it("tells the Rust shell when an action starts and when it ends", async () => {
    let finish: (result: ConnectResult) => void = () => undefined;
    bridge.connectRun.mockImplementation(
      () =>
        new Promise<ConnectResult>((resolve) => {
          finish = resolve;
        }),
    );
    const button = await renderEnrolled();
    expect(bridge.reportBusy).toHaveBeenLastCalledWith(false);
    await act(async () => {
      button.click();
    });
    expect(bridge.reportBusy).toHaveBeenLastCalledWith(true);
    await act(async () => {
      finish({ ok: true, seq: 6, detail: "chained" });
    });
    expect(bridge.reportBusy).toHaveBeenLastCalledWith(false);
  });

  // #4318 item 5: "connected" is the Connected tier's word (ADR-078).
  it("says the collector is running in the masthead, not connected", async () => {
    await renderEnrolled();
    const masthead = document.querySelector(".masthead .version");
    expect(masthead?.textContent).toContain("collector running · active");
    expect(masthead?.textContent).not.toContain("connected");
  });
});
