// admit.test.ts: a person's action is refused when it rests on a stale read
// (revision, brief, or head) or when the item's state forbids it, and a
// repeat of an action already recorded changes nothing.
import { describe, expect, it } from "vitest";
import { type WorkItemDecision, admitDecision } from "./admit";
import { type WorkRecordErrorCode, isWorkRecordError } from "./errors";
import type { WorkFact } from "./facts";
import { reduceWorkItem } from "./reduce";
import { IN_REVIEW, READY, SHA1, SHA2, digest, f } from "./test-fixtures";

const ITEM = "wi_x";

function admit(facts: WorkFact[], decision: WorkItemDecision) {
  return admitDecision(reduceWorkItem(facts), decision);
}

function refused(facts: WorkFact[], decision: WorkItemDecision, code: WorkRecordErrorCode): string {
  try {
    admit(facts, decision);
  } catch (error) {
    expect(isWorkRecordError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return (error as Error).message;
  }
  throw new Error(`expected ${decision.kind} to be refused with ${code}`);
}

const accept = (over: Partial<Extract<WorkItemDecision, { kind: "accept" }>> = {}): WorkItemDecision => ({
  kind: "accept",
  orderId: "o1",
  headSha: SHA1,
  briefDigest: digest(1),
  criteria: ["c1", "c2"],
  briefCriteria: ["c1", "c2"],
  ...over,
});

const send = (over: Partial<Extract<WorkItemDecision, { kind: "send" }>> = {}): WorkItemDecision => ({
  kind: "send",
  item: ITEM,
  itemRevision: 1,
  briefRevision: 1,
  briefDigest: digest(1),
  key: "wi_x:r1:s1",
  ...over,
});

const approve = (over: Partial<Extract<WorkItemDecision, { kind: "approve_brief" }>> = {}): WorkItemDecision => ({
  kind: "approve_brief",
  itemRevision: 1,
  briefRevision: 1,
  briefDigest: digest(1),
  ...over,
});

const DRAFTED = READY.slice(0, 3);
const DONE = [...IN_REVIEW, f.accepted("o1", SHA1, 1, 12), f.merged("o1", SHA1, 13)];
const CLOSED = [...READY, f.closed(1, 5)];

describe("save_brief", () => {
  it("admits a save on the current revision", () => {
    expect(admit(DRAFTED, { kind: "save_brief", itemRevision: 1 })).toEqual({ repeat: false });
  });

  it("refuses a save on a stale revision, and on a closed or done item", () => {
    expect(refused([...DRAFTED, f.sourceChanged(2, 4)], { kind: "save_brief", itemRevision: 1 }, "stale_revision")).toContain(
      "revision 2",
    );
    refused(CLOSED, { kind: "save_brief", itemRevision: 1 }, "not_allowed");
    refused(DONE, { kind: "save_brief", itemRevision: 1 }, "not_allowed");
  });
});

describe("approve_brief", () => {
  it("admits the latest brief on the current revision, and calls a second approval a repeat", () => {
    expect(admit(DRAFTED, approve())).toEqual({ repeat: false });
    expect(admit(READY, approve())).toEqual({ repeat: true });
  });

  it("refuses a stale revision or a brief that is not the latest", () => {
    refused([...DRAFTED, f.sourceChanged(2, 4)], approve(), "stale_revision");
    refused([...DRAFTED, f.saved(2, 1, 4)], approve(), "stale_brief");
    refused(DRAFTED, approve({ briefDigest: digest(7) }), "stale_brief");
  });

  it("refuses a brief written against an older revision", () => {
    const message = refused([...DRAFTED, f.sourceChanged(2, 4)], approve({ itemRevision: 2 }), "stale_revision");
    expect(message).toContain("Save the brief again");
  });

  it("refuses with no brief, a second brief on an approved revision, or open triage questions", () => {
    refused([f.collected(), f.triage("triaged")], approve(), "not_allowed");
    refused(READY, approve({ briefDigest: digest(9) }), "not_allowed");
    refused([f.collected(), f.triage("needs_info"), f.saved(1, 1, 2)], approve(), "not_allowed");
    refused([f.collected(), f.triage("duplicate"), f.saved(1, 1, 2)], approve(), "not_allowed");
    refused(CLOSED, approve(), "not_allowed");
  });
});

describe("send", () => {
  it("admits the approved brief with the next send's key", () => {
    expect(admit(READY, send())).toEqual({ repeat: false });
    const returned = [...IN_REVIEW, f.returned("o1", 12)];
    expect(admit(returned, send({ key: "wi_x:r1:s2" }))).toEqual({ repeat: false });
  });

  it("refuses a send while another is open", () => {
    expect(refused([...READY, f.send("o1", 1, 1, 1, 4)], send({ key: "wi_x:r1:s2" }), "not_allowed")).toContain("Send 1");
  });

  it("refuses a stale revision, an unapproved revision, and a superseded brief", () => {
    refused([...READY, f.sourceChanged(2, 4)], send(), "stale_revision");
    refused([...READY, f.sourceChanged(2, 4)], send({ itemRevision: 2 }), "not_allowed");
    const reapproved = [...READY, f.saved(2, 2, 4, true), f.approved(2, 2, 5)];
    refused(reapproved, send({ itemRevision: 2 }), "stale_brief");
    expect(admit(reapproved, send({ itemRevision: 2, briefRevision: 2, briefDigest: digest(2), key: "wi_x:r2:s1" }))).toEqual({
      repeat: false,
    });
  });

  it("refuses a key that does not name the next send, so an old send cannot come back", () => {
    const returned = [...IN_REVIEW, f.returned("o1", 12)];
    expect(refused(returned, send({ key: "wi_x:r1:s1" }), "stale_version")).toContain("wi_x:r1:s2");
  });

  it("refuses a send on a done or closed item", () => {
    refused(DONE, send({ key: "wi_x:r1:s2" }), "not_allowed");
    refused(CLOSED, send(), "not_allowed");
  });
});

describe("withdraw, stop, and return", () => {
  const sent = [...READY, f.send("o1", 1, 1, 1, 4)];
  const claimed = [...sent, f.runtime("claimed", "o1", 5)];

  it("withdraws only a send no runtime claimed", () => {
    expect(admit(sent, { kind: "withdraw", orderId: "o1" })).toEqual({ repeat: false });
    expect(admit([...sent, f.withdrawn("o1", 5)], { kind: "withdraw", orderId: "o1" })).toEqual({ repeat: true });
    refused(claimed, { kind: "withdraw", orderId: "o1" }, "not_allowed");
    refused(sent, { kind: "withdraw", orderId: "o9" }, "not_found");
  });

  it("stops only a claimed or running send", () => {
    expect(admit(claimed, { kind: "stop", orderId: "o1" })).toEqual({ repeat: false });
    expect(admit([...claimed, f.stopRequested("o1", 6)], { kind: "stop", orderId: "o1" })).toEqual({ repeat: true });
    expect(refused(sent, { kind: "stop", orderId: "o1" }, "not_allowed")).toContain("Withdraw");
    expect(refused(IN_REVIEW, { kind: "stop", orderId: "o1" }, "not_allowed")).toContain("Return");
    refused([...sent, f.rejected("o1", 5)], { kind: "stop", orderId: "o1" }, "not_allowed");
  });

  it("returns only a send whose run ended or whose pull request closed or merged", () => {
    expect(admit(IN_REVIEW, { kind: "return", orderId: "o1" })).toEqual({ repeat: false });
    expect(admit([...IN_REVIEW, f.returned("o1", 12)], { kind: "return", orderId: "o1" })).toEqual({ repeat: true });
    refused(claimed, { kind: "return", orderId: "o1" }, "not_allowed");
    refused([...sent, f.rejected("o1", 5)], { kind: "return", orderId: "o1" }, "not_allowed");
    expect(admit([...claimed, f.prLinked("o1", 6), f.head("o1", SHA1, 7), f.prClosed("o1", 8)], { kind: "return", orderId: "o1" })).toEqual({
      repeat: false,
    });
  });
});

describe("accept", () => {
  it("admits the head with every required check passing and every criterion ticked", () => {
    expect(admit(IN_REVIEW, accept())).toEqual({ repeat: false });
  });

  it("refuses an old head, and names both commits", () => {
    const moved = [...IN_REVIEW, f.head("o1", SHA2, 12)];
    const message = refused(moved, accept(), "stale_head");
    expect(message).toContain(SHA1.slice(0, 7));
    expect(message).toContain(SHA2.slice(0, 7));
  });

  it("refuses a brief that is not the approved one, and a revision with no approval yet", () => {
    refused(IN_REVIEW, accept({ briefDigest: digest(5) }), "stale_brief");
    refused([...IN_REVIEW, f.sourceChanged(2, 12)], accept(), "stale_brief");
  });

  it("admits against a newly approved revision while the send keeps its brief", () => {
    const reapproved = [...IN_REVIEW, f.sourceChanged(2, 12), f.saved(2, 2, 13), f.approved(2, 2, 14)];
    expect(admit(reapproved, accept({ briefDigest: digest(2) }))).toEqual({ repeat: false });
  });

  it("fails closed on missing, failing, skipped, or unread required checks", () => {
    refused([...IN_REVIEW, f.required("o1", SHA1, ["test", "e2e"], 12)], accept(), "not_allowed");
    expect(refused([...IN_REVIEW, f.check("o1", SHA1, "test", "skipped", 12)], accept(), "not_allowed")).toContain("test: skipped");
    const unread = [...READY, f.send("o1", 1, 1, 1, 4), f.prLinked("o1", 5), f.head("o1", SHA1, 6), f.runtime("run_ended", "o1", 7)];
    expect(refused(unread, accept(), "not_allowed")).toContain("required checks");
  });

  it("accepts on the ticks alone when the base branch requires no check, and names the head", () => {
    const none = [...READY, f.send("o1", 1, 1, 1, 4), f.prLinked("o1", 5), f.head("o1", SHA1, 6), f.runtime("run_ended", "o1", 7), f.required("o1", SHA1, [], 8)];
    expect(admit(none, accept())).toEqual({ repeat: false });
    expect(refused(none, accept({ criteria: ["c1"] }), "not_allowed")).toContain("c2");
  });

  it("refuses a tick on a criterion the brief does not have", () => {
    expect(refused(IN_REVIEW, accept({ criteria: ["c1", "c2", "c9"] }), "invalid_input")).toContain("c9");
  });

  it("refuses while the run is active, after the pull request closed, with no pull request, and on an ended send", () => {
    const claimed = [...READY, f.send("o1", 1, 1, 1, 4), f.runtime("claimed", "o1", 5)];
    refused(claimed, accept(), "not_allowed");
    refused([...IN_REVIEW, f.prClosed("o1", 12)], accept(), "not_allowed");
    refused([...READY, f.send("o1", 1, 1, 1, 4), f.runtime("run_ended", "o1", 5)], accept(), "not_allowed");
    refused([...IN_REVIEW, f.returned("o1", 12)], accept(), "not_allowed");
    refused(IN_REVIEW, accept({ orderId: "o9" }), "not_found");
  });

  it("calls a second acceptance of the same head a repeat, and refuses it on a done item", () => {
    const accepted = [...IN_REVIEW, f.accepted("o1", SHA1, 1, 12)];
    expect(admit(accepted, accept())).toEqual({ repeat: true });
    refused(DONE, accept(), "not_allowed");
  });
});

describe("close, reopen, and triage", () => {
  it("closes an item with no send out, and calls a second close a repeat", () => {
    expect(admit(READY, { kind: "close" })).toEqual({ repeat: false });
    expect(admit(CLOSED, { kind: "close" })).toEqual({ repeat: true });
    expect(admit([...IN_REVIEW, f.prClosed("o1", 12)], { kind: "close" })).toEqual({ repeat: false });
  });

  it("refuses to close a done item or one with a send still out", () => {
    refused(DONE, { kind: "close" }, "not_allowed");
    expect(refused([...READY, f.send("o1", 1, 1, 1, 4), f.runtime("claimed", "o1", 5)], { kind: "close" }, "not_allowed")).toContain(
      "Withdraw or stop",
    );
  });

  it("reopens only a closed or done item", () => {
    expect(admit(CLOSED, { kind: "reopen" })).toEqual({ repeat: false });
    expect(admit(DONE, { kind: "reopen" })).toEqual({ repeat: false });
    refused(READY, { kind: "reopen" }, "not_allowed");
  });

  it("changes triage only on an open item", () => {
    expect(admit(READY, { kind: "override_triage" })).toEqual({ repeat: false });
    refused(CLOSED, { kind: "override_triage" }, "not_allowed");
  });
});
