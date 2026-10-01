/**
 * The hidden machine commands in the command tree run the same code the
 * entry's fast path does (#4879), so a call that reaches the tree, rather
 * than `index.ts`'s dispatch, behaves the same. Mocks: the machine modules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../program.js";

const { runHook, runRecorderCommand } = vi.hoisted(() => ({
  runHook: vi.fn(async () => undefined),
  runRecorderCommand: vi.fn(async () => undefined),
}));
vi.mock("../machine/hook.js", () => ({ runHook }));
vi.mock("../machine/recorder.js", () => ({ runRecorderCommand }));

const argv = process.argv;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.argv = argv;
});

async function run(...args: string[]) {
  process.argv = ["node", "oxagen", ...args];
  await buildProgram().exitOverride().parseAsync(process.argv);
}

describe("the hidden machine commands", () => {
  it("runs the hook with every flag the harness passed, unparsed", async () => {
    await run("hook", "--enrollment", "tch_1", "--harness", "codex");
    expect(runHook).toHaveBeenCalledWith([
      "node",
      "oxagen",
      "hook",
      "--enrollment",
      "tch_1",
      "--harness",
      "codex",
    ]);
    expect(runRecorderCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["daemon"],
    ["mcp-stdio", "--enrollment", "tch_1", "--port", "47001"],
    ["credential", "issue", "--harness", "claude-code"],
    ["github", "credential", "get", "--harness", "codex", "--cwd", "/repo"],
    ["arp", "verify", "--bundle", "/tmp/x"],
  ])("hands `%s` to the recorder's command tree", async (...args) => {
    await run(...args);
    expect(runRecorderCommand).toHaveBeenCalledWith([
      "node",
      "oxagen",
      ...args,
    ]);
    expect(runHook).not.toHaveBeenCalled();
  });
});
