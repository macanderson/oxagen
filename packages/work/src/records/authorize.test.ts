// authorize.test.ts: a workspace Viewer reads and does nothing else, every
// action names a permission bundle, and the send duties hold.
import { describe, expect, it } from "vitest";
import {
  WORK_ACTION_PERMISSION,
  WORK_ITEM_ACTIONS,
  WORK_PERMISSIONS,
  checkSendDuties,
  workActionRoles,
} from "./authorize";
import { isWorkRecordError } from "./errors";

describe("workActionRoles", () => {
  it("lets every workspace role read, and only an Owner or Member act", () => {
    expect(workActionRoles("read")).toEqual({ org: ["Owner", "Admin"], workspace: ["Owner", "Member", "Viewer"] });
    for (const action of WORK_ITEM_ACTIONS.filter((entry) => entry !== "read")) {
      expect(workActionRoles(action).workspace).toEqual(["Owner", "Member"]);
      expect(workActionRoles(action).workspace).not.toContain("Viewer");
      expect(workActionRoles(action).org).toEqual(["Owner", "Admin"]);
    }
  });

  it("puts approve and accept under work.approve, and every other change under work.control", () => {
    expect(WORK_ACTION_PERMISSION.read).toBe("run.read");
    expect(WORK_ACTION_PERMISSION.approve_brief).toBe("work.approve");
    expect(WORK_ACTION_PERMISSION.accept).toBe("work.approve");
    expect(WORK_ACTION_PERMISSION.send).toBe("work.control");
    for (const action of WORK_ITEM_ACTIONS) expect(WORK_PERMISSIONS).toContain(WORK_ACTION_PERMISSION[action]);
  });
});

describe("checkSendDuties", () => {
  const send = { actorId: "marcus", governanceMode: "team" as const, approverId: "marcus", operatesAgent: true };

  it("admits an operator sending their own approved brief outside a regulated workspace", () => {
    expect(() => checkSendDuties(send)).not.toThrow();
    expect(() => checkSendDuties({ ...send, governanceMode: null })).not.toThrow();
    expect(() => checkSendDuties({ ...send, governanceMode: "regulated", approverId: "amara" })).not.toThrow();
  });

  it("refuses a person who does not operate the agent", () => {
    try {
      checkSendDuties({ ...send, operatesAgent: false });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isWorkRecordError(error, "forbidden")).toBe(true);
      expect((error as Error).message).toContain("operate");
    }
  });

  it("refuses the approver as the sender in a regulated workspace", () => {
    try {
      checkSendDuties({ ...send, governanceMode: "regulated" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isWorkRecordError(error, "forbidden")).toBe(true);
      expect((error as Error).message).toContain("regulated");
    }
  });
});

describe("isWorkRecordError", () => {
  it("matches only a WorkRecordError, and the code when one is given", async () => {
    const { WorkRecordError } = await import("./errors");
    const error = new WorkRecordError("stale_head", "Review the new head.");
    expect(error.name).toBe("WorkRecordError");
    expect(isWorkRecordError(error)).toBe(true);
    expect(isWorkRecordError(error, "stale_head")).toBe(true);
    expect(isWorkRecordError(error, "stale_brief")).toBe(false);
    expect(isWorkRecordError(new Error("x"))).toBe(false);
  });
});
