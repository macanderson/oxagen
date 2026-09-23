import { COMMAND_REASON_MAX as CONTRACT_COMMAND_REASON_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { describe, expect, it } from "vitest";
import { COMMAND_REASON_MAX } from "./runs";

// The Fleet row's command dialog is a client component, and no client module
// in this app imports a kernel contract module (#3521). The reason bound is
// mirrored in `./runs`, and this test keeps the mirror equal to the limit
// `dispatch_command` enforces.
describe("runs contract mirrors", () => {
  it("mirrors the command reason bound dispatch_command enforces", () => {
    expect(COMMAND_REASON_MAX).toBe(CONTRACT_COMMAND_REASON_MAX);
  });
});
