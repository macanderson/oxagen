/**
 * Unit tests for assistant-switch: the flags, the slug lookups, the input
 * `set_assistant_switch` receives, and the line the operator reads back. The
 * invoke path itself (lib/platform-operator-run.ts) has its own tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  describeOutcome,
  parseAssistantSwitchFlags,
  runAssistantSwitch,
  type AssistantSwitchRunDeps,
} from "./assistant-switch";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const REASON = "Incident 2026-10-01: the assistant quotes stale spend";

const argv = (onOff: "--on" | "--off" = "--on") => [
  "--org",
  "acme",
  "--workspace",
  "default",
  onOff,
  "--reason",
  REASON,
];

function deps(
  over: Partial<AssistantSwitchRunDeps> = {},
  output: unknown = { switchId: "emd_1", changed: true },
) {
  const lines: string[] = [];
  const invoke = vi.fn(
    async (_name: string, _input: unknown, _ctx: CapabilityContext) => output,
  );
  const d: AssistantSwitchRunDeps = {
    resolveOrg: vi.fn(async () => ({ id: ORG, name: "Acme" })),
    resolveWorkspace: vi.fn(async () => ({ id: WS, name: "Default" })),
    invoke,
    setSecurityEventEmitter: vi.fn(),
    recordSecurityEvent: vi.fn(async () => {}),
    requestId: "req-1",
    log: (l) => lines.push(l),
    ...over,
  };
  return { d, invoke, lines };
}

describe("parseAssistantSwitchFlags", () => {
  it("reads --on and --off", () => {
    expect(parseAssistantSwitchFlags(argv("--on"))).toEqual({
      orgSlug: "acme",
      workspaceSlug: "default",
      on: true,
      reason: REASON,
    });
    expect(parseAssistantSwitchFlags(argv("--off")).on).toBe(false);
  });

  it.each(["--org", "--workspace", "--reason"])("requires %s", (flag) => {
    const full = argv();
    const i = full.indexOf(flag);
    const without = [...full.slice(0, i), ...full.slice(i + 2)];
    expect(() => parseAssistantSwitchFlags(without)).toThrow(
      new RegExp(`${flag} is required`),
    );
  });

  it("requires exactly one of --on and --off", () => {
    const neither = argv().filter((a) => a !== "--on");
    expect(() => parseAssistantSwitchFlags(neither)).toThrow(
      /exactly one of --on and --off/,
    );
    expect(() => parseAssistantSwitchFlags([...argv(), "--off"])).toThrow(
      /exactly one of --on and --off/,
    );
  });

  it("trims the reason and holds it to the contract's 500 characters", () => {
    const padded = argv();
    padded[padded.length - 1] = `  ${REASON}  `;
    expect(parseAssistantSwitchFlags(padded).reason).toBe(REASON);
    for (const reason of ["   ", "x".repeat(501)]) {
      const bad = argv();
      bad[bad.length - 1] = reason;
      expect(() => parseAssistantSwitchFlags(bad)).toThrow(
        /--reason must be 1 to 500 characters/,
      );
    }
  });

  it("refuses an unknown flag, such as an agent id", () => {
    expect(() =>
      parseAssistantSwitchFlags([...argv(), "--agent", "agt_1"]),
    ).toThrow(/unknown flag: --agent/);
  });
});

describe("runAssistantSwitch", () => {
  it("invokes set_assistant_switch with the resolved organization and workspace ids", async () => {
    const { d, invoke, lines } = deps();

    const stored = await runAssistantSwitch(
      parseAssistantSwitchFlags(argv()),
      d,
    );

    expect(d.resolveWorkspace).toHaveBeenCalledWith(ORG, "default");
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0]).toBe("set_assistant_switch");
    expect(invoke.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      workspaceId: WS,
      on: true,
      reason: REASON,
    });
    // The context carries no tenant and no user, and the runner surface.
    expect(invoke.mock.calls[0]![2]).toMatchObject({
      orgId: "",
      workspaceId: "",
      userId: null,
      surface: "runner",
      requestId: "req-1",
    });
    expect(stored).toEqual({ switchId: "emd_1", changed: true });
    expect(lines.join("\n")).toMatch(/Workspace {4}: Default \(default\)/);
    expect(lines.at(-1)).toMatch(/Stopped: switch emd_1 is on/);
  });

  it("refuses an unknown organization before resolving the workspace or invoking", async () => {
    const { d, invoke } = deps({ resolveOrg: vi.fn(async () => null) });
    await expect(
      runAssistantSwitch(parseAssistantSwitchFlags(argv()), d),
    ).rejects.toThrow(/no organization with slug "acme"/);
    expect(d.resolveWorkspace).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a workspace slug the organization does not hold before invoking", async () => {
    const { d, invoke } = deps({ resolveWorkspace: vi.fn(async () => null) });
    await expect(
      runAssistantSwitch(parseAssistantSwitchFlags(argv()), d),
    ).rejects.toThrow(
      /no workspace with slug "default" in organization "acme"/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an output the contract does not describe", async () => {
    const { d } = deps({}, { switchId: "emd_1" });
    await expect(
      runAssistantSwitch(parseAssistantSwitchFlags(argv()), d),
    ).rejects.toThrow();
  });
});

describe("describeOutcome", () => {
  it("says what each call did", () => {
    expect(describeOutcome(true, { switchId: "emd_1", changed: true })).toBe(
      "Stopped: switch emd_1 is on. The assistant refuses every turn in this workspace.",
    );
    expect(describeOutcome(true, { switchId: "emd_1", changed: false })).toBe(
      "Already stopped: switch emd_1 was on. Nothing written.",
    );
    expect(describeOutcome(false, { switchId: "emd_1", changed: true })).toBe(
      "Restarted: switch emd_1 is off. The assistant answers again.",
    );
    expect(describeOutcome(false, { switchId: null, changed: false })).toBe(
      "No switch was on. Nothing written.",
    );
  });
});
