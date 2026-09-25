import { describe, expect, it } from "vitest";
import { workingCopyList } from "./repository.working_copy.list";

const ROW = {
  id: "wcp_0a1B",
  hostname: "mac-mini.local",
  directory: "/Users/ada/code/widgets",
  repository: "acme/widgets",
  branch: "main",
  headCommit: "abc1234",
  oxagenPresent: true,
  symlinks: "linked",
  pulledCommit: "def5678",
  lastEvent: "pull",
  reportedBy: { userId: "u_1", name: null },
  cliVersion: "1.4.0",
  firstSeenAt: "2026-09-20T08:00:00.000Z",
  lastSeenAt: "2026-09-24T17:00:00.000Z",
};

describe("list_working_copies contract", () => {
  it("is a scoped read a workspace viewer may make, outside metering", () => {
    expect(workingCopyList.scoped).toBe(true);
    expect(workingCopyList.mutates).toBe(false);
    expect(workingCopyList.noBillingGate).toBe(true);
    expect(workingCopyList.surfaces).toEqual(["api", "mcp"]);
    expect(workingCopyList.defaultRoles.workspace).toMatchObject({
      Viewer: "allow",
    });
  });

  it("defaults the limit to 100 and refuses one outside 1 to 200 (negative)", () => {
    expect(workingCopyList.input.parse({})).toEqual({ limit: 100 });
    expect(workingCopyList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(workingCopyList.input.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("answers rows with a reporter or none", () => {
    const out = { workingCopies: [ROW, { ...ROW, reportedBy: null }] };
    expect(workingCopyList.output.parse(out)).toEqual(out);
    expect(
      workingCopyList.output.safeParse({
        workingCopies: [{ ...ROW, symlinks: "broken" }],
      }).success,
    ).toBe(false);
  });
});
