// The mirror of `dispatch_command`'s reason ceiling. Tests run under Node,
// where the contract module imports fine, so this is the one place the two
// values are compared.
import { COMMAND_REASON_MAX as CONTRACT_COMMAND_REASON_MAX } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { describe, expect, it } from "vitest";
import { COMMAND_REASON_MAX } from "./command-reason";

describe("command reason mirror", () => {
  it("mirrors the ceiling the contract refuses a reason above", () => {
    expect(COMMAND_REASON_MAX).toBe(CONTRACT_COMMAND_REASON_MAX);
  });
});
