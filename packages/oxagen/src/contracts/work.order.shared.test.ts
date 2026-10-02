import { describe, expect, it } from "vitest";
import {
  WORK_ACTION_CLOSE_RESOLUTIONS,
  WORK_ACTION_DELIVERY_STATES,
  WORK_ACTION_ITEM_STATES,
  workAgentIdSchema,
  workDigestSchema,
  workHeadShaSchema,
  workItemAfterSchema,
  workItemIdSchema,
  workItemVersionSchema,
  workOrderAfterSchema,
  workOrderIdSchema,
  workReasonSchema,
  workRevisionSchema,
} from "./work.order.shared";

// The schemas every Phase 1 work action shares (P1-04, ADR-250).
describe("work action shared schemas", () => {
  it("takes each public id by its own prefix and refuses another", () => {
    expect(workItemIdSchema.safeParse("wi_0a1b2c").success).toBe(true);
    expect(workOrderIdSchema.safeParse("wo_0a1b2c").success).toBe(true);
    expect(workAgentIdSchema.safeParse("agt_0a1b2c").success).toBe(true);
    for (const [schema, value] of [
      [workItemIdSchema, "wo_0a1b2c"],
      [workItemIdSchema, "WI_X"],
      [workItemIdSchema, "wi_"],
      [workItemIdSchema, "wi_0a1b-2c"],
      [workOrderIdSchema, "wi_0a1b2c"],
      [workOrderIdSchema, "wo_ABC"],
      [workAgentIdSchema, "agent_0a1b2c"],
    ] as const) {
      expect(schema.safeParse(value).success, value).toBe(false);
    }
  });

  it("takes version 0 and refuses revision 0", () => {
    expect(workItemVersionSchema.safeParse(0).success).toBe(true);
    expect(workItemVersionSchema.safeParse(-1).success).toBe(false);
    expect(workItemVersionSchema.safeParse(1.5).success).toBe(false);
    expect(workRevisionSchema.safeParse(1).success).toBe(true);
    expect(workRevisionSchema.safeParse(0).success).toBe(false);
  });

  it("takes a SHA-256 digest in lowercase hex", () => {
    expect(workDigestSchema.safeParse(`sha256:${"a".repeat(64)}`).success).toBe(true);
    for (const value of [
      `sha256:${"a".repeat(63)}`,
      `sha256:${"a".repeat(65)}`,
      `sha256:${"A".repeat(64)}`,
      `sha512:${"a".repeat(64)}`,
      "a".repeat(64),
    ]) {
      expect(workDigestSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("takes a full head commit of 40 lowercase hex characters", () => {
    expect(workHeadShaSchema.safeParse("a1".repeat(20)).success).toBe(true);
    for (const value of ["a".repeat(39), "a".repeat(41), "A1".repeat(20), "g".repeat(40)]) {
      expect(workHeadShaSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("trims a reason and refuses an empty or long one", () => {
    expect(workReasonSchema.parse("  The run used the wrong base.  ")).toBe("The run used the wrong base.");
    expect(workReasonSchema.safeParse("").success).toBe(false);
    expect(workReasonSchema.safeParse("   ").success).toBe(false);
    expect(workReasonSchema.safeParse("r".repeat(2001)).success).toBe(false);
  });

  it("answers the item and the send in their own states, with no extra keys", () => {
    const item = { id: "wi_0a1b2c", state: "ready", revision: 2, version: 7 };
    expect(workItemAfterSchema.safeParse(item).success).toBe(true);
    expect(workItemAfterSchema.safeParse({ ...item, state: "open" }).success).toBe(false);
    expect(workItemAfterSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
    const order = { id: "wo_0a1b2c", send: 1, key: "wi_0a1b2c:r1:s1", delivery: "waiting_for_claim" };
    expect(workOrderAfterSchema.safeParse(order).success).toBe(true);
    expect(workOrderAfterSchema.safeParse({ ...order, delivery: "queued" }).success).toBe(false);
    expect(workOrderAfterSchema.safeParse({ ...order, send: 0 }).success).toBe(false);
  });

  it("lists the item states, delivery states, and close resolutions", () => {
    expect(WORK_ACTION_ITEM_STATES).toContain("ready");
    expect(WORK_ACTION_DELIVERY_STATES).toContain("waiting_for_claim");
    expect(WORK_ACTION_CLOSE_RESOLUTIONS).toEqual(["cancelled", "declined", "duplicate"]);
  });
});
