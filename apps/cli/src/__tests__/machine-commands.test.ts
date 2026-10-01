/**
 * The machine commands hand their argv to the recorder unchanged, and the
 * ones that write into a machine do it with this executable's runtime
 * commands, so what they write names `oxagen` (#4879). Mocks: the recorder's
 * modules; no filesystem, network, or daemon.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runHookProcess, parseAsync, buildTachoProgram } = vi.hoisted(() => {
  const parseAsync = vi.fn(async () => undefined);
  return {
    runHookProcess: vi.fn(async () => undefined),
    parseAsync,
    buildTachoProgram: vi.fn(() => ({ parseAsync })),
  };
});
const RUNTIME = { hookCommand: "/opt/oxagen/oxagen hook", program: "oxagen" };

vi.mock("@oxagen/recorder/hook", () => ({ runHookProcess }));
vi.mock("@oxagen/recorder/program", () => ({ buildTachoProgram }));
vi.mock("@oxagen/recorder/cli", () => ({
  oxagenRuntimeCommands: () => RUNTIME,
}));

import { runHook } from "../machine/hook.js";
import { runRecorderCommand } from "../machine/recorder.js";

describe("the machine commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the recorder's hook with the flags the harness passed", async () => {
    const argv = ["node", "oxagen", "hook", "--enrollment", "tch_1"];
    await runHook(argv);
    expect(runHookProcess).toHaveBeenCalledWith(argv);
  });

  it("runs the recorder's command tree under the oxagen name and runtime", async () => {
    const argv = ["node", "oxagen", "credential", "issue", "--harness", "codex"];
    await runRecorderCommand(argv);
    expect(buildTachoProgram).toHaveBeenCalledWith({
      name: "oxagen",
      deps: { runtime: RUNTIME },
    });
    expect(parseAsync).toHaveBeenCalledWith(argv);
  });
});
