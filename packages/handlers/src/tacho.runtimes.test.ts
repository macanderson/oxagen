/**
 * `@oxagen/tacho` is a leaf package: the wire schema's runtime enum cannot
 * import the database's `TACHO_RUNTIMES`, so the two lists are written twice
 * and this package -- the first that depends on both -- is where they meet.
 * A value the wire admits but the CHECK constraint rejects passes every
 * validator and dies on the insert; a value the constraint admits but the
 * wire refuses can never arrive. Either drift is a silent one.
 */
import { schema } from "@oxagen/database";
import { agentHarnessSchema } from "@oxagen/oxagen/contracts/agent.list";
import {
  TACHO_RUNTIMES as WIRE_RUNTIMES,
  WRAPPED_HARNESSES,
} from "@oxagen/tacho";
import { describe, expect, it } from "vitest";

const DB_RUNTIMES = schema.TACHO_RUNTIMES;

describe("tacho runtime enum parity", () => {
  it("the wire enum and the database CHECK list are the same list", () => {
    expect([...WIRE_RUNTIMES]).toEqual([...DB_RUNTIMES]);
  });

  it("both admit codex, so a Codex session is filed under its own runtime", () => {
    expect(WIRE_RUNTIMES).toContain("codex");
    expect(DB_RUNTIMES).toContain("codex");
  });
});

// Mac's ruling of 2026-10-01: the open-source Stella coding agent a customer
// runs as a CLI registers and is governed exactly like Claude Code and Codex
// (ADR-235). Every harness Oxagen wraps files its sessions under its own
// runtime and registers as an agent with its own harness.
describe("every wrapped harness registers and records like Claude Code", () => {
  it.each([...WRAPPED_HARNESSES])(
    "%s is a session runtime on the wire and in the database, and an agent harness",
    (harness) => {
      expect(WIRE_RUNTIMES).toContain(harness);
      expect(DB_RUNTIMES).toContain(harness);
      expect(agentHarnessSchema.options).toContain(harness);
    },
  );

  it("wraps the Stella CLI beside Claude Code and Codex", () => {
    expect(WRAPPED_HARNESSES).toEqual(
      expect.arrayContaining(["claude-code", "codex", "stella"]),
    );
  });
});
