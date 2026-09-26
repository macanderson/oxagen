// @vitest-environment jsdom
/**
 * The React tree against a fake bridge: the machine reads as enrolled with
 * Claude Code wrapped and the collector answering. Each test drives the
 * window the way a person does and checks what the bridge was asked to run.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectResult,
  DesktopState,
  DetectReport,
  HostView,
} from "./bridge";
import sidecarCalls from "../src-tauri/sidecar-calls.json";

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
  readState: vi.fn(),
  detectHarnesses: vi.fn(),
  runSidecar: vi.fn(),
}));

vi.mock("./bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bridge")>();
  return {
    ...real,
    readState: bridge.readState,
    detectHarnesses: bridge.detectHarnesses,
    tachoStatus: vi.fn(async () => null),
    listOrganizations: vi.fn(async () => [
      { id: "org_1", slug: "acme", name: "Acme" },
    ]),
    listWorkspaces: vi.fn(async () => [{ slug: "core", name: "Core" }]),
    logTail: vi.fn(async () => ""),
    reportBusy: bridge.reportBusy,
    connectRun: bridge.connectRun,
    runSidecar: bridge.runSidecar,
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
  bridge.readState.mockReset();
  bridge.readState.mockResolvedValue(machine);
  bridge.detectHarnesses.mockReset();
  bridge.runSidecar.mockReset();
  bridge.runSidecar.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
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

  /** The window as an older copy of this app left it: Re-apply is offered. */
  const olderSetup: DesktopState = {
    ...machine,
    host: {
      ...host,
      wrapper_version: "2.1.0",
      hook_command: `${machine.bin_dir}/tacho hook`,
    },
  };

  // Audit D-11: the Rust shell holds a close while the page changes the
  // machine.
  it("tells the Rust shell when an action that changes the machine starts and ends", async () => {
    let finish: (result: { code: number }) => void = () => undefined;
    bridge.runSidecar.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = (result) => resolve({ ...result, stdout: "", stderr: "" });
        }),
    );
    bridge.readState.mockResolvedValue(olderSetup);
    render(<App />);
    const button = await screen.findByRole("button", { name: "Re-apply" });
    expect(bridge.reportBusy).toHaveBeenLastCalledWith(false);
    await act(async () => {
      button.click();
    });
    expect(bridge.reportBusy).toHaveBeenLastCalledWith(true);
    await act(async () => {
      finish({ code: 0 });
    });
    expect(bridge.reportBusy).toHaveBeenLastCalledWith(false);
  });

  // Audit D-11 review: a first run and a sign-in held a close too, so a Quit
  // hid the window and the app ran on for as long as they waited.
  it("holds no close while a first run waits", async () => {
    bridge.connectRun.mockImplementation(() => new Promise(() => undefined));
    const button = await renderEnrolled();
    await act(async () => {
      button.click();
    });
    expect(bridge.connectRun).toHaveBeenCalledTimes(1);
    expect(bridge.reportBusy).not.toHaveBeenCalledWith(true);
  });

  it("holds no close while a sign-in waits for the browser", async () => {
    bridge.runSidecar.mockImplementation(() => new Promise(() => undefined));
    bridge.readState.mockResolvedValue({
      ...machine,
      config: { ...machine.config, logged_in: false },
      host: null,
      daemon: null,
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Sign in" });
    await act(async () => {
      button.click();
    });
    expect(bridge.runSidecar).toHaveBeenCalledWith(
      "oxagen",
      ["login", "--browser"],
      expect.any(Function),
    );
    expect(bridge.reportBusy).not.toHaveBeenCalledWith(true);
  });

  // #4318 item 6: Re-apply wrote its argv inline, a bare `tacho enroll`
  // that no builder made, so the fixture the Rust allowlist is tested
  // against never held it, and the allowlist refused the button's call.
  it("re-applies the tools with a call the Rust allowlist's fixture holds", async () => {
    bridge.readState.mockResolvedValue(olderSetup);
    render(<App />);
    const button = await screen.findByRole("button", { name: "Re-apply" });
    await act(async () => {
      button.click();
    });
    expect(bridge.runSidecar).toHaveBeenCalledTimes(1);
    const [sidecar, args] = bridge.runSidecar.mock.calls[0] ?? [];
    expect(sidecarCalls).toContainEqual({ sidecar, args });
  });

  // #4318 item 5: "connected" is the Connected tier's word (ADR-078).
  it("says the collector is running in the masthead, not connected", async () => {
    await renderEnrolled();
    const masthead = document.querySelector(".masthead .version");
    expect(masthead?.textContent).toContain("collector running · active");
    expect(masthead?.textContent).not.toContain("connected");
  });
});

// #3367: the wizard disabled every row whose scan said not installed, so a
// machine with only the Cursor editor on Linux, where the scan cannot see
// an AppImage, could not register Cursor at all.
describe("the setup wizard's agent step", () => {
  const note =
    "enrollment writes ~/.cursor/hooks.json, which governs the Cursor editor and the cursor-agent CLI alike";

  /** Sign-in done, the workspace picked: step 3 scans with this report. */
  async function scanWith(report: DetectReport) {
    bridge.readState.mockResolvedValue({
      ...machine,
      host: null,
      daemon: null,
    });
    bridge.detectHarnesses.mockResolvedValue(report);
    render(<App />);
    const next = await screen.findByRole("button", { name: "Continue" });
    await vi.waitFor(() => expect(next).not.toHaveProperty("disabled", true));
    await act(async () => {
      next.click();
    });
    await screen.findByText("Claude Code");
  }

  const checkbox = (harness: string) =>
    document.getElementById(`register-${harness}`) as HTMLInputElement;

  it("offers a Cursor the scan did not find, unticked, with the coverage note", async () => {
    await scanWith({
      enrolled: false,
      harnesses: [
        {
          harness: "claude-code",
          label: "Claude Code",
          installed: true,
          path: "/usr/local/bin/claude",
          version: "2.1.263",
          foundVia: "cli",
          enrolled: false,
        },
        {
          harness: "cursor",
          label: "Cursor",
          installed: false,
          enrolled: false,
          coverableWhenAbsent: note,
        },
        { harness: "codex", label: "Codex", installed: false, enrolled: false },
      ],
    });
    expect(checkbox("cursor").disabled).toBe(false);
    expect(checkbox("cursor").checked).toBe(false);
    expect(screen.getByText(`not found by the scan · ${note}`)).toBeTruthy();
    // An agent that is absent and not coverable is still refused.
    expect(checkbox("codex").disabled).toBe(true);
    // Ticking it adds Cursor to what registers.
    await act(async () => {
      checkbox("cursor").click();
    });
    expect(
      screen.getByRole("button", {
        name: "Yes, register Claude Code and Cursor with Oxagen",
      }),
    ).toBeTruthy();
  });

  it("offers and ticks a Cursor found as the editor", async () => {
    await scanWith({
      enrolled: false,
      harnesses: [
        {
          harness: "claude-code",
          label: "Claude Code",
          installed: false,
          enrolled: false,
        },
        {
          harness: "cursor",
          label: "Cursor",
          installed: true,
          path: "/Applications/Cursor.app",
          foundVia: "app",
          enrolled: false,
          coverableWhenAbsent: note,
        },
      ],
    });
    expect(checkbox("cursor").disabled).toBe(false);
    expect(checkbox("cursor").checked).toBe(true);
    expect(
      screen.getByText("the editor · /Applications/Cursor.app"),
    ).toBeTruthy();
  });

  // #3367 review: a Cursor registered without its command line went on to
  // `tacho verify`, which failed with "cursor-agent is not on PATH".
  it("leaves a Cursor with no command line out of the first run", async () => {
    await scanWith({
      enrolled: false,
      harnesses: [
        {
          harness: "claude-code",
          label: "Claude Code",
          installed: true,
          path: "/usr/local/bin/claude",
          foundVia: "cli",
          enrolled: false,
        },
        {
          harness: "cursor",
          label: "Cursor",
          installed: false,
          enrolled: false,
          coverableWhenAbsent: note,
        },
      ],
    });
    await act(async () => {
      checkbox("cursor").click();
    });
    // The enroll succeeds, and the next read finds the host it wrote.
    bridge.runSidecar.mockImplementation(async () => {
      bridge.readState.mockResolvedValue({
        ...machine,
        host: { ...host, harnesses: ["claude-code", "cursor"] },
      });
      return { code: 0, stdout: "", stderr: "" };
    });
    await act(async () => {
      screen
        .getByRole("button", {
          name: "Yes, register Claude Code and Cursor with Oxagen",
        })
        .click();
    });
    expect(bridge.runSidecar).toHaveBeenCalledWith(
      "tacho",
      expect.arrayContaining(["enroll", "--harness", "claude-code,cursor"]),
      expect.any(Function),
    );
    const next = await screen.findByRole("button", { name: "Continue" });
    await act(async () => {
      next.click();
    });
    await screen.findByText("reports when you use the editor");
    expect(document.getElementById("run-cursor")).toBeNull();
    expect(
      (document.getElementById("run-claude-code") as HTMLInputElement).checked,
    ).toBe(true);
    bridge.connectRun.mockResolvedValue({ ok: true, seq: 6, detail: "" });
    await act(async () => {
      screen
        .getByRole("button", { name: "Yes, run the connect prompt" })
        .click();
    });
    expect(bridge.connectRun).toHaveBeenCalledTimes(1);
    expect(bridge.connectRun).toHaveBeenCalledWith(
      "claude-code",
      expect.any(Function),
    );
  });
});
