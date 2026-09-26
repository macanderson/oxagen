import { describe, expect, it } from "vitest";
import { runIssueSchema, runIssuesGet } from "./run.issues.get";

const repository = {
  host: "github.com",
  owner: "acme",
  name: "core",
  url: "https://github.com/acme/core",
  connected: true,
};

const task = {
  ref: "acme/core#12",
  repository,
  number: 12,
  title: "Retry the upload on a 503",
  status: "open",
  statusRead: "read",
  readAt: "2026-09-25T10:00:00.000Z",
  relation: "task",
  resolvedBy: [],
  actions: ["viewed", "commented"],
  edge: "stated",
  frameSeqs: ["4", "19"],
  url: "https://github.com/acme/core/issues/12",
};

describe("get_run_issues contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped, default-deny", () => {
    expect(runIssuesGet.name).toBe("get_run_issues");
    expect(runIssuesGet.mutates).toBe(false);
    expect(runIssuesGet.noBillingGate).toBe(true);
    expect(runIssuesGet.scoped).toBe(true);
    expect(runIssuesGet.defaultEffect).toBe("deny");
    expect(runIssuesGet.surfaces).toEqual(["api", "mcp"]);
  });

  it("takes one run by its public id and refuses an unknown key (negative)", () => {
    expect(runIssuesGet.input.parse({ runId: "tse_4q8r1t6v" })).toEqual({
      runId: "tse_4q8r1t6v",
    });
    for (const input of [
      {},
      { runId: "run_0123" },
      { runId: "tse_4q8r1t6v", limit: 5 },
    ]) {
      expect(runIssuesGet.input.safeParse(input).success).toBe(false);
    }
  });

  it("carries a task, an issue a pull request closes, and one whose repository is unknown", () => {
    const resolves = {
      ...task,
      ref: "acme/core#13",
      number: 13,
      relation: "resolves",
      edge: "observed",
      actions: [],
      resolvedBy: [{ number: 40, url: "https://github.com/acme/core/pull/40" }],
      frameSeqs: ["31"],
      url: "https://github.com/acme/core/issues/13",
    };
    const unresolved = {
      ...task,
      ref: "#7",
      repository: null,
      number: 7,
      title: null,
      status: null,
      statusRead: "repository_unknown",
      readAt: null,
      relation: "referenced",
      edge: "observed",
      actions: ["mentioned"],
      url: null,
    };
    const answer = {
      runId: "tse_4q8r1t6v",
      issues: [task, resolves, unresolved],
      complete: false,
      warnings: ["issue_frame_limit"],
    };
    expect(runIssuesGet.output.parse(answer)).toEqual(answer);
  });

  it("refuses a status outside the vocabulary, an inferred edge and a seq that is not a number (negative)", () => {
    for (const issue of [
      { ...task, status: "done" },
      { ...task, statusRead: "skipped" },
      { ...task, edge: "inferred" },
      { ...task, relation: "blocks" },
      { ...task, actions: ["merged"] },
      { ...task, frameSeqs: ["4a"] },
      { ...task, ref: "" },
    ]) {
      expect(runIssueSchema.safeParse(issue).success).toBe(false);
    }
  });
});
