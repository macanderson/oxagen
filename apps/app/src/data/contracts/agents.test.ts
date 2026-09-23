import { SUBAGENT_FILE_HARNESSES as CONTRACT_SUBAGENT_FILE_HARNESSES } from "@oxagen/oxagen/contracts/agent.propose";
import { describe, expect, it } from "vitest";
import { SUBAGENT_FILE_HARNESSES } from "./agents";

// The agent wizard is a client component, and the `propose_agent` contract
// module registers its capability when it loads (#3521). The harness list is
// mirrored in `./agents`, and this test keeps the mirror equal to the contract.
describe("agents contract mirrors", () => {
  it("mirrors the harnesses that read a generated subagent file", () => {
    expect([...SUBAGENT_FILE_HARNESSES]).toEqual([
      ...CONTRACT_SUBAGENT_FILE_HARNESSES,
    ]);
  });
});
