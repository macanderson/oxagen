// The Waiting on a human figure (#3839): approvals plus open interjections,
// the oldest wait the basis line names, and a failed read kept apart from a
// zero.
import { describe, expect, it } from "vitest";
import { readError } from "@/data/read";
import {
  approvalItem,
  approvalQueue,
  interjectionItem,
  interjectionQueue,
  NO_INTERJECTIONS,
  NOW,
} from "./fleet.builders";
import { oldestInterjection, unreadCode, waitingOf } from "./waiting";

const DENIED = {
  ok: false as const,
  reason: "denied" as const,
  permission: "workspace.read",
};

describe("waitingOf", () => {
  it("adds the open interjections to the pending approvals", () => {
    const w = waitingOf(
      approvalQueue([approvalItem(), approvalItem({ id: "apr_2" })]),
      interjectionQueue([interjectionItem()]),
    );
    expect(w.count).toBe(3);
    expect(w.interjections).toBe(1);
    expect(w.floor).toBe(false);
  });

  it("names the oldest approval when one waits, whatever the interjections", () => {
    const w = waitingOf(
      approvalQueue([approvalItem()]),
      interjectionQueue([interjectionItem()]),
    );
    expect(w.oldest).toEqual({
      kind: "approval",
      since: NOW - 150_000,
      windowSeconds: 600,
    });
  });

  it("names the oldest interjection, with its 30-minute window, when no approval waits", () => {
    const w = waitingOf(
      approvalQueue([]),
      interjectionQueue([
        interjectionItem({
          id: "inj_newer",
          raisedAt: new Date(NOW - 60_000).toISOString(),
        }),
        interjectionItem(),
      ]),
    );
    expect(w.count).toBe(2);
    expect(w.oldest).toEqual({
      kind: "interjection",
      since: NOW - 216_000,
      windowSeconds: 1800,
    });
  });

  it("answers zero with nothing to name when nothing waits", () => {
    const w = waitingOf(approvalQueue([]), NO_INTERJECTIONS);
    expect(w.count).toBe(0);
    expect(w.oldest).toBeNull();
    expect(w.floor).toBe(false);
  });

  it("marks the figure a floor when either queue ran past its read", () => {
    expect(
      waitingOf(approvalQueue([approvalItem()], true), NO_INTERJECTIONS),
    ).toMatchObject({ floor: true, approvalsMore: true });
    expect(
      waitingOf(
        approvalQueue([]),
        interjectionQueue([interjectionItem()], true),
      ),
    ).toMatchObject({ floor: true, interjectionsMore: true });
  });

  it("counts the approvals as a floor and names the code when the interjections were not read (negative)", () => {
    const w = waitingOf(
      approvalQueue([approvalItem()]),
      readError("record_unmappable", 502),
    );
    expect(w.count).toBe(1);
    expect(w.floor).toBe(true);
    expect(w.interjections).toBeNull();
    expect(w.interjectionsUnread).toBe("record_unmappable");
  });

  it("has no figure when the approvals were not read, never a zero (negative)", () => {
    const w = waitingOf(DENIED, interjectionQueue([interjectionItem()]));
    expect(w.count).toBeNull();
    expect(w.approvalsUnread).toBe("workspace.read");
    expect(w.interjections).toBe(1);
    expect(w.oldest).toBeNull();
  });
});

describe("oldestInterjection", () => {
  it("is null for no question", () => {
    expect(oldestInterjection([])).toBeNull();
  });

  it("clamps a window that ends before it starts to zero (negative)", () => {
    expect(
      oldestInterjection([
        interjectionItem({
          raisedAt: new Date(NOW).toISOString(),
          expiresAt: new Date(NOW - 1000).toISOString(),
        }),
      ]),
    ).toEqual({ since: NOW, windowSeconds: 0 });
  });
});

describe("unreadCode", () => {
  it("names the permission, the error code or the access request, and null for a read that landed", () => {
    expect(unreadCode(DENIED)).toBe("workspace.read");
    expect(unreadCode(readError("down", 503))).toBe("down");
    expect(
      unreadCode({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_1",
      }),
    ).toBe("acr_1");
    expect(unreadCode(NO_INTERJECTIONS)).toBeNull();
  });
});
