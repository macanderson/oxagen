import { describe, expect, it } from "vitest";
import { tachoMemoriesIngest as contract } from "./tacho.memories.ingest";

const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  harness: "codex",
  path: "/home/dev/.codex/memories/billing.md",
  statement: "Run the billing tests before a proration change.",
};

describe("host memory contract", () => {
  it("takes one memory from a named host and harness", () => {
    expect(contract.input.safeParse(input).success).toBe(true);
    for (const harness of ["claude-code", "codex", "cursor", "stella"]) {
      expect(contract.input.safeParse({ ...input, harness }).success).toBe(
        true,
      );
    }
  });

  it("refuses a malformed memory", () => {
    for (const patch of [
      { host_enrollment_id: "host" },
      { harness: "vim" },
      { path: "" },
      { path: "p".repeat(1025) },
      { statement: "   " },
      { statement: "s".repeat(2001) },
      { run: "run_1" },
    ]) {
      expect(
        contract.input.safeParse({ ...input, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("takes a memory file's frontmatter name, description, and type", () => {
    const parsed = contract.input.parse({
      ...input,
      label: " Billing tests ",
      summary: "Run them before a proration change.",
      memory_type: "feedback",
    });
    expect(parsed.label).toBe("Billing tests");
    expect(parsed.memory_type).toBe("feedback");
    for (const patch of [
      { label: "" },
      { label: "l".repeat(201) },
      { summary: "s".repeat(1001) },
      { memory_type: "Feedback" },
      { memory_type: "a type" },
    ]) {
      expect(
        contract.input.safeParse({ ...input, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("trims the statement the way remember_lesson does", () => {
    const parsed = contract.input.parse({
      ...input,
      statement: "  Keep the ledger append-only.\n",
    });
    expect(parsed.statement).toBe("Keep the ledger append-only.");
  });

  it("stays off the agent and MCP surfaces and needs an admin's key", () => {
    expect(contract.name).toBe("ingest_tacho_memories");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.sensitivity).toBe("high");
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(contract.output.safeParse({ stored: true }).success).toBe(true);
    expect(contract.output.safeParse({ stored: true, id: "m" }).success).toBe(
      false,
    );
  });
});
