/**
 * Contract test for run_studio_selection (mcp-studio-spec, lane M16).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioSelectionRun } from "./tool.studio.selection.run";

describe("run_studio_selection is registered as declared", () => {
  it("is scoped, reads only, keeps the billing gate, and grants the Studio roles", () => {
    const cap = getCapability("run_studio_selection");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mode).toBe("sync");
    expect(cap?.mutates).toBe(false);
    // Every task is a model call, so the billing gate stays on.
    expect(cap?.noBillingGate).toBeUndefined();
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.layers).toEqual(["schema", "api", "mcp", "unit", "docs"]);
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
    expect(cap?.audit).toBeUndefined();
  });

  it("is offered to no agent, so only a person starts a run", () => {
    expect(getCapability("run_studio_selection")?.surfaces).not.toContain("agent");
  });
});

describe("run_studio_selection input", () => {
  it("takes a server and refuses anything else", () => {
    expect(toolStudioSelectionRun.input.parse({ server: "billing" })).toEqual({ server: "billing" });
    for (const bad of [
      {},
      { server: "Billing" },
      { server: "builtin" },
      { server: "billing", tool: "list_charges" },
      { server: "billing", tasks: [{ task: "Refund a charge.", expect: null }] },
    ]) {
      expect(toolStudioSelectionRun.input.safeParse(bad).success).toBe(false);
    }
  });
});

describe("run_studio_selection output", () => {
  const out = {
    server: "billing",
    basis: "published" as const,
    revision: null,
    model: "fast-model",
    counts: { total: 4, hits: 1, misses: 1, malformed: 1, skipped: 1, errors: 0, notRun: 0 },
    cases: [
      { line: 1, task: "Refund $40 of charge ch_3P9.", expected: "billing__create_refund", status: "hit" as const, chosen: "billing__create_refund" },
      { line: 2, task: "Write a haiku.", expected: null, status: "miss" as const, chosen: "billing__list_charges" },
      { line: 3, task: "List charges.", expected: "billing__list_charges", status: "malformed" as const, reason: "The reply did not parse." },
      { line: 4, task: "Void an invoice.", expected: "billing__void_invoice", status: "skipped" as const, reason: "The server does not offer it." },
    ],
    stopped: null,
  };

  it("carries each task's result and the counts", () => {
    expect(toolStudioSelectionRun.output.parse(out)).toEqual(out);
  });

  it("takes a run that asked nothing", () => {
    const empty = {
      ...out,
      model: null,
      counts: { total: 0, hits: 0, misses: 0, malformed: 0, skipped: 0, errors: 0, notRun: 0 },
      cases: [],
    };
    expect(toolStudioSelectionRun.output.parse(empty)).toEqual(empty);
  });

  it("carries a run that stopped at its deadline, with the tasks it did not run", () => {
    const stopped = {
      ...out,
      counts: { total: 5, hits: 1, misses: 1, malformed: 1, skipped: 1, errors: 0, notRun: 1 },
      cases: [
        ...out.cases,
        { line: 5, task: "Refund charge ch_9.", expected: "billing__create_refund", status: "not_run" as const, reason: "The run stopped." },
      ],
      stopped: "deadline" as const,
    };
    expect(toolStudioSelectionRun.output.parse(stopped)).toEqual(stopped);
  });

  it("carries a run that stopped on a failed model call, with the failed task and the tasks it did not run", () => {
    const failed = {
      ...out,
      counts: { total: 6, hits: 1, misses: 1, malformed: 1, skipped: 1, errors: 1, notRun: 1 },
      cases: [
        ...out.cases,
        { line: 5, task: "Refund charge ch_8.", expected: "billing__create_refund", status: "error" as const, reason: "The model call failed: 503." },
        { line: 6, task: "Refund charge ch_9.", expected: "billing__create_refund", status: "not_run" as const, reason: "The run stopped." },
      ],
      stopped: "model_failed" as const,
    };
    expect(toolStudioSelectionRun.output.parse(failed)).toEqual(failed);
  });

  it("refuses a stop reason it does not know", () => {
    expect(toolStudioSelectionRun.output.safeParse({ ...out, stopped: "timeout" }).success).toBe(false);
  });

  it("parses an output from before the stop fields, and fills their defaults", () => {
    const { stopped: _stopped, ...older } = out;
    const { errors: _errors, notRun: _notRun, ...olderCounts } = out.counts;

    expect(toolStudioSelectionRun.output.parse({ ...older, counts: olderCounts })).toEqual(out);
  });

  it.each([
    ["a hit with no chosen tool field", { line: 1, task: "t", expected: null, status: "hit" }],
    ["a malformed reply with no reason", { line: 1, task: "t", expected: null, status: "malformed" }],
    ["an unknown status", { line: 1, task: "t", expected: null, status: "timed_out", reason: "x" }],
    ["a failed task with no reason", { line: 1, task: "t", expected: null, status: "error" }],
    ["a task the run did not finish with no reason", { line: 1, task: "t", expected: null, status: "not_run" }],
    ["a line of 0", { line: 0, task: "t", expected: null, status: "hit", chosen: null }],
  ])("refuses %s", (_label, entry) => {
    expect(toolStudioSelectionRun.output.safeParse({ ...out, cases: [entry] }).success).toBe(false);
  });

  it("refuses a draft revision of 0", () => {
    expect(toolStudioSelectionRun.output.safeParse({ ...out, basis: "draft", revision: 0 }).success).toBe(false);
  });
});
