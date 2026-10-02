// The Work actions through the kernel seam (INV-19): the viewer and
// `kernelWrite` are the fakes, so each case shows the exact capability input
// an action sends and what the page gets back. Every action has an ok case, a
// denied case, and a conflict or invalid case.
//
// The cases that matter most pin what the store relies on. Send passes the
// work order's key unchanged, because the key is fixed before the first try
// and a retry must name the same one. Save-and-approve approves with the
// version, item revision, brief revision and digest the save returned, never
// the ones the page read, so a change by anyone else between the two writes
// is refused as stale. A refusal comes back as the seam classified it, with
// nothing invented.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, kernelWrite } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  kernelWrite: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelWrite,
}));

const { workBriefApprove } = await import("@oxagen/oxagen/contracts/work.brief.approve");
const { workBriefSave } = await import("@oxagen/oxagen/contracts/work.brief.save");
const { workCollectorSet } = await import("@oxagen/oxagen/contracts/work.collector.set");
const { workCollectorSync } = await import("@oxagen/oxagen/contracts/work.collector.sync");
const { workItemClose } = await import("@oxagen/oxagen/contracts/work.item.close");
const { workItemCreate } = await import("@oxagen/oxagen/contracts/work.item.create");
const { workItemReopen } = await import("@oxagen/oxagen/contracts/work.item.reopen");
const { workOrderAccept } = await import("@oxagen/oxagen/contracts/work.order.accept");
const { workOrderCancel } = await import("@oxagen/oxagen/contracts/work.order.cancel");
const { workOrderChecksRefresh } = await import(
  "@oxagen/oxagen/contracts/work.order.checks.refresh"
);
const { workOrderReturn } = await import("@oxagen/oxagen/contracts/work.order.return");
const { workOrderSend } = await import("@oxagen/oxagen/contracts/work.order.send");
const { workOrderStop } = await import("@oxagen/oxagen/contracts/work.order.stop");
const { workTriageRetry } = await import("@oxagen/oxagen/contracts/work.triage.retry");
const { workTriageRevise } = await import("@oxagen/oxagen/contracts/work.triage.revise");
const actions = await import("./actions");

const CTX = { orgSlug: "acme", wsSlug: "core-platform" };
const ITEM_ID = "wi_12ab";
const ORDER_ID = "wo_1a";
const HEAD = "3f9a2c1000000000000000000000000000000000";
const DIGEST = `sha256:${"ab12".repeat(16)}`;
const SAVED_DIGEST = `sha256:${"cd34".repeat(16)}`;

/** The item after a write, as every person's work action answers it. */
const after = (version: number, state = "ready") => ({
  id: ITEM_ID,
  state,
  revision: 1,
  version,
});
const order = (delivery: string, send = 1) => ({
  id: ORDER_ID,
  send,
  key: `${ITEM_ID}:r1:s${String(send)}`,
  delivery,
});

const DENIED = { ok: false, reason: "denied", code: "person_required" } as const;
const STALE = { ok: false, reason: "conflict", code: "stale_version" } as const;
const INVALID = { ok: false, reason: "invalid", code: "invalid_input", field: "reason" } as const;

beforeEach(() => {
  requireViewer.mockReset().mockResolvedValue(CTX);
  kernelWrite.mockReset();
});

describe("createWorkItem", () => {
  it("enters the trimmed title and leaves out an empty description and repository", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { item_id: ITEM_ID, number: "WI-12", state: "new", revision: 1, version: 0 },
    });
    const result = await actions.createWorkItem("acme", "core-platform", {
      title: "  Retry the export  ",
      description: "  ",
      repository: "",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workItemCreate, {
      subject: "Retry the export",
      labels: [],
    });
    expect(result).toEqual({ ok: true, value: { id: ITEM_ID, number: "WI-12" } });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue(DENIED);
    expect(
      await actions.createWorkItem("acme", "core-platform", {
        title: "A",
        description: "B",
        repository: "acme/platform",
      }),
    ).toEqual(DENIED);
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workItemCreate, {
      subject: "A",
      description: "B",
      labels: [],
      repository: "acme/platform",
    });
  });

  it("passes an invalid input on with its field", async () => {
    kernelWrite.mockResolvedValue(INVALID);
    expect(
      await actions.createWorkItem("acme", "core-platform", {
        title: "",
        description: "",
        repository: "",
      }),
    ).toEqual(INVALID);
  });
});

describe("reviseTriage", () => {
  it("sends the version read, the trimmed reason, and only the fields the person changed", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { item_id: ITEM_ID, version: 5 } });
    const result = await actions.reviseTriage("acme", "core-platform", {
      itemId: ITEM_ID,
      version: 4,
      reason: "  Customers hit this daily.  ",
      priority: "P1",
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workTriageRevise, {
      item_id: ITEM_ID,
      expected_version: 4,
      reason: "Customers hit this daily.",
      priority: "P1",
    });
    expect(result).toEqual({ ok: true, value: { version: 5 } });
  });

  it("records an answer as the outcome triaged with the answer as its reason", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { item_id: ITEM_ID, version: 5 } });
    await actions.reviseTriage("acme", "core-platform", {
      itemId: ITEM_ID,
      version: 4,
      reason: "The CSV export.",
      outcome: "triaged",
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workTriageRevise, {
      item_id: ITEM_ID,
      expected_version: 4,
      reason: "The CSV export.",
      outcome: "triaged",
    });
  });

  it("passes labels, a cleared outcome and a duplicate on as given", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { item_id: ITEM_ID, version: 5 } });
    await actions.reviseTriage("acme", "core-platform", {
      itemId: ITEM_ID,
      version: 4,
      reason: "r",
      labels: ["Bug", "Export"],
      outcome: null,
      duplicateOf: "wi_3cd",
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workTriageRevise, {
      item_id: ITEM_ID,
      expected_version: 4,
      reason: "r",
      labels: ["Bug", "Export"],
      outcome: null,
      duplicate_of: "wi_3cd",
    });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue(DENIED);
    expect(
      await actions.reviseTriage("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 4,
        reason: "r",
        priority: "P0",
      }),
    ).toEqual(DENIED);
  });

  it("passes a stale version on as a conflict", async () => {
    kernelWrite.mockResolvedValue(STALE);
    expect(
      await actions.reviseTriage("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 3,
        reason: "r",
        priority: "P0",
      }),
    ).toEqual(STALE);
  });
});

describe("retryTriage", () => {
  it("names the item and reports the run queued", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { item_id: ITEM_ID, state: "new", queued: true },
    });
    expect(await actions.retryTriage("acme", "core-platform", { itemId: ITEM_ID })).toEqual({
      ok: true,
      value: { queued: true },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workTriageRetry, { item_id: ITEM_ID });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue(DENIED);
    expect(await actions.retryTriage("acme", "core-platform", { itemId: ITEM_ID })).toEqual(
      DENIED,
    );
  });

  it("passes a not-allowed refusal on as a conflict", async () => {
    const notAllowed = { ok: false, reason: "conflict", code: "not_allowed" };
    kernelWrite.mockResolvedValue(notAllowed);
    expect(await actions.retryTriage("acme", "core-platform", { itemId: ITEM_ID })).toEqual(
      notAllowed,
    );
  });
});

const CRITERIA = [
  {
    criterion: "c1",
    text: "  The export retries after a 429.  ",
    tag: "code" as const,
    intent: "review" as const,
    evidence: " The diff ",
    provenance: "triage" as const,
  },
  {
    criterion: null,
    text: "A test covers the retry.",
    tag: "test" as const,
    intent: "check" as const,
    evidence: "",
    provenance: "person" as const,
  },
];

/** What save_work_brief receives for CRITERIA: each key kept, a new one with none, text trimmed. */
const CRITERIA_INPUT = [
  {
    id: "c1",
    text: "The export retries after a 429.",
    tag: "code",
    intent: "review",
    evidence: "The diff",
    provenance: "triage",
  },
  {
    text: "A test covers the retry.",
    tag: "test",
    intent: "check",
    evidence: "",
    provenance: "person",
  },
];

describe("saveBrief", () => {
  it("saves a draft for the item revision the editor read, each criterion keeping its key", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        item: after(5, "triaged"),
        repeat: false,
        brief: { revision: 2, digest: SAVED_DIGEST },
      },
    });
    const result = await actions.saveBrief("acme", "core-platform", {
      itemId: ITEM_ID,
      version: 4,
      itemRevision: 1,
      repository: " acme/platform ",
      criteria: CRITERIA,
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workBriefSave, {
      item_id: ITEM_ID,
      version: 4,
      item_revision: 1,
      repository: "acme/platform",
      criteria: CRITERIA_INPUT,
    });
    expect(result).toEqual({
      ok: true,
      value: { item: after(5, "triaged"), brief: { revision: 2, digest: SAVED_DIGEST } },
    });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue(DENIED);
    expect(
      await actions.saveBrief("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 4,
        itemRevision: 1,
        repository: "acme/platform",
        criteria: CRITERIA,
      }),
    ).toEqual(DENIED);
  });

  it("passes a stale revision on as a conflict", async () => {
    const stale = { ok: false, reason: "conflict", code: "stale_revision" };
    kernelWrite.mockResolvedValue(stale);
    expect(
      await actions.saveBrief("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 4,
        itemRevision: 1,
        repository: "acme/platform",
        criteria: CRITERIA,
      }),
    ).toEqual(stale);
  });
});

describe("approveBrief", () => {
  it("approves the revision and digest the page read", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { item: after(6), repeat: false } });
    const result = await actions.approveBrief("acme", "core-platform", {
      itemId: ITEM_ID,
      version: 5,
      itemRevision: 1,
      briefRevision: 2,
      briefDigest: DIGEST,
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workBriefApprove, {
      item_id: ITEM_ID,
      version: 5,
      item_revision: 1,
      brief_revision: 2,
      brief_digest: DIGEST,
    });
    expect(result).toEqual({ ok: true, value: { item: after(6) } });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue({ ok: false, reason: "denied", code: "org_role_required" });
    expect(
      await actions.approveBrief("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 5,
        itemRevision: 1,
        briefRevision: 2,
        briefDigest: DIGEST,
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });

  it("passes a stale brief on as a conflict", async () => {
    const stale = { ok: false, reason: "conflict", code: "stale_brief" };
    kernelWrite.mockResolvedValue(stale);
    expect(
      await actions.approveBrief("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 5,
        itemRevision: 1,
        briefRevision: 1,
        briefDigest: DIGEST,
      }),
    ).toEqual(stale);
  });
});

describe("saveAndApproveBrief", () => {
  const input = {
    itemId: ITEM_ID,
    version: 4,
    itemRevision: 2,
    repository: "acme/platform",
    criteria: CRITERIA,
  };

  it("approves with the version, item revision, brief revision and digest the save returned", async () => {
    kernelWrite
      .mockResolvedValueOnce({
        ok: true,
        value: {
          item: { id: ITEM_ID, state: "changed", revision: 2, version: 7 },
          repeat: false,
          brief: { revision: 2, digest: SAVED_DIGEST },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { item: { id: ITEM_ID, state: "ready", revision: 2, version: 8 }, repeat: false },
      });
    const result = await actions.saveAndApproveBrief("acme", "core-platform", input);
    expect(kernelWrite).toHaveBeenCalledTimes(2);
    expect(kernelWrite).toHaveBeenNthCalledWith(1, CTX, workBriefSave, {
      item_id: ITEM_ID,
      version: 4,
      item_revision: 2,
      repository: "acme/platform",
      criteria: CRITERIA_INPUT,
    });
    expect(kernelWrite).toHaveBeenNthCalledWith(2, CTX, workBriefApprove, {
      item_id: ITEM_ID,
      version: 7,
      item_revision: 2,
      brief_revision: 2,
      brief_digest: SAVED_DIGEST,
    });
    expect(result).toEqual({
      ok: true,
      value: { item: { id: ITEM_ID, state: "ready", revision: 2, version: 8 } },
    });
  });

  it("approves nothing when the save is denied", async () => {
    kernelWrite.mockResolvedValueOnce(DENIED);
    expect(await actions.saveAndApproveBrief("acme", "core-platform", input)).toEqual(DENIED);
    expect(kernelWrite).toHaveBeenCalledTimes(1);
  });

  it("passes on a stale approval that follows a saved draft", async () => {
    kernelWrite
      .mockResolvedValueOnce({
        ok: true,
        value: {
          item: { id: ITEM_ID, state: "changed", revision: 2, version: 7 },
          repeat: false,
          brief: { revision: 2, digest: SAVED_DIGEST },
        },
      })
      .mockResolvedValueOnce(STALE);
    expect(await actions.saveAndApproveBrief("acme", "core-platform", input)).toEqual(STALE);
    expect(kernelWrite).toHaveBeenCalledTimes(2);
  });
});

describe("sendWork", () => {
  const input = {
    itemId: ITEM_ID,
    version: 6,
    itemRevision: 1,
    briefRevision: 1,
    briefDigest: DIGEST,
    agentId: "agt_stella",
    key: "wi_12ab:r1:s1",
  };

  it("sends the key exactly as the item read it, so a retry names the same work order", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        item: after(7, "sent"),
        repeat: false,
        order: order("waiting_for_claim"),
        command_id: "tcm_1",
        target: {
          agent_id: "agt_stella",
          runtime_id: "rtm_buildbox",
          host_id: "tch_buildbox",
          runtime_tier: "gateway",
          mandate_id: null,
        },
      },
    });
    const result = await actions.sendWork("acme", "core-platform", input);
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workOrderSend, {
      item_id: ITEM_ID,
      version: 6,
      item_revision: 1,
      brief_revision: 1,
      brief_digest: DIGEST,
      agent_id: "agt_stella",
      key: "wi_12ab:r1:s1",
    });
    expect(result).toEqual({
      ok: true,
      value: { item: after(7, "sent"), orderId: ORDER_ID, repeat: false },
    });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue({ ok: false, reason: "denied", code: "agent_run" });
    expect(await actions.sendWork("acme", "core-platform", input)).toEqual({
      ok: false,
      reason: "denied",
      code: "agent_run",
    });
  });

  it("passes a stale key on as a conflict", async () => {
    kernelWrite.mockResolvedValue(STALE);
    expect(await actions.sendWork("acme", "core-platform", input)).toEqual(STALE);
  });
});

describe("cancelSend and stopSend", () => {
  const input = { itemId: ITEM_ID, version: 7, orderId: ORDER_ID, reason: " Wrong repository. " };

  it("withdraws an unclaimed send with the trimmed reason", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { item: after(8), repeat: false, order: order("withdrawn") },
    });
    expect(await actions.cancelSend("acme", "core-platform", input)).toEqual({
      ok: true,
      value: { item: after(8) },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workOrderCancel, {
      item_id: ITEM_ID,
      version: 7,
      work_order_id: ORDER_ID,
      reason: "Wrong repository.",
    });
  });

  it("asks the runtime to stop a claimed run with the trimmed reason", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { item: after(8, "running"), repeat: false, order: order("stopping") },
    });
    expect(await actions.stopSend("acme", "core-platform", input)).toEqual({
      ok: true,
      value: { item: after(8, "running") },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workOrderStop, {
      item_id: ITEM_ID,
      version: 7,
      work_order_id: ORDER_ID,
      reason: "Wrong repository.",
    });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue(DENIED);
    expect(await actions.cancelSend("acme", "core-platform", input)).toEqual(DENIED);
    expect(await actions.stopSend("acme", "core-platform", input)).toEqual(DENIED);
  });

  it("passes a not-allowed refusal on as a conflict", async () => {
    const notAllowed = { ok: false, reason: "conflict", code: "not_allowed" };
    kernelWrite.mockResolvedValue(notAllowed);
    expect(await actions.cancelSend("acme", "core-platform", input)).toEqual(notAllowed);
    expect(await actions.stopSend("acme", "core-platform", input)).toEqual(notAllowed);
  });
});

describe("returnWork", () => {
  const input = {
    itemId: ITEM_ID,
    version: 9,
    orderId: ORDER_ID,
    reason: " The 429 still has no Retry-After. ",
    resend: true,
  };

  it("returns with the trimmed reason and reports the new send", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        item: after(10, "sent"),
        repeat: false,
        order: order("returned"),
        resent: order("waiting_for_claim", 2),
        resend_refused: null,
      },
    });
    expect(await actions.returnWork("acme", "core-platform", input)).toEqual({
      ok: true,
      value: { item: after(10, "sent"), resent: true, resendRefused: null },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workOrderReturn, {
      item_id: ITEM_ID,
      version: 9,
      work_order_id: ORDER_ID,
      reason: "The 429 still has no Retry-After.",
      resend: true,
    });
  });

  it("says why no new send went out when the resend was refused", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        item: after(10),
        repeat: false,
        order: order("returned"),
        resent: null,
        resend_refused: "Stella is working on WI-7.",
      },
    });
    expect(await actions.returnWork("acme", "core-platform", input)).toEqual({
      ok: true,
      value: { item: after(10), resent: false, resendRefused: "Stella is working on WI-7." },
    });
  });

  it("passes a denial and a stale head on as they came", async () => {
    kernelWrite.mockResolvedValueOnce(DENIED);
    expect(await actions.returnWork("acme", "core-platform", input)).toEqual(DENIED);
    const staleHead = { ok: false, reason: "conflict", code: "stale_head" };
    kernelWrite.mockResolvedValueOnce(staleHead);
    expect(await actions.returnWork("acme", "core-platform", input)).toEqual(staleHead);
  });
});

describe("acceptWork", () => {
  const input = {
    itemId: ITEM_ID,
    version: 9,
    orderId: ORDER_ID,
    headSha: HEAD,
    briefDigest: DIGEST,
    criteria: ["c1", "c2"],
  };

  it("accepts the head commit with every criterion ticked", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        item: after(10, "review"),
        repeat: false,
        order: order("run_ended"),
        required_checks: ["test", "typecheck"],
      },
    });
    expect(await actions.acceptWork("acme", "core-platform", input)).toEqual({
      ok: true,
      value: { item: after(10, "review"), requiredChecks: ["test", "typecheck"] },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workOrderAccept, {
      item_id: ITEM_ID,
      version: 9,
      work_order_id: ORDER_ID,
      head_sha: HEAD,
      brief_digest: DIGEST,
      criteria: ["c1", "c2"],
    });
  });

  it("passes a denial on as it came", async () => {
    kernelWrite.mockResolvedValue({ ok: false, reason: "denied", code: "work_forbidden" });
    expect(await actions.acceptWork("acme", "core-platform", input)).toEqual({
      ok: false,
      reason: "denied",
      code: "work_forbidden",
    });
  });

  it("passes a stale head on as a conflict", async () => {
    const staleHead = { ok: false, reason: "conflict", code: "stale_head" };
    kernelWrite.mockResolvedValue(staleHead);
    expect(await actions.acceptWork("acme", "core-platform", input)).toEqual(staleHead);
  });
});

describe("refreshChecks", () => {
  it("names the item and the order, and reports what GitHub answered", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        item: after(9, "review"),
        repeat: false,
        head_sha: HEAD,
        required_checks: null,
        unread_reason: "GitHub answered 502.",
      },
    });
    expect(
      await actions.refreshChecks("acme", "core-platform", { itemId: ITEM_ID, orderId: ORDER_ID }),
    ).toEqual({
      ok: true,
      value: { requiredChecks: null, unreadReason: "GitHub answered 502." },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workOrderChecksRefresh, {
      item_id: ITEM_ID,
      work_order_id: ORDER_ID,
    });
  });

  it("passes a denial and a missing order on as they came", async () => {
    kernelWrite.mockResolvedValueOnce(DENIED);
    expect(
      await actions.refreshChecks("acme", "core-platform", { itemId: ITEM_ID, orderId: ORDER_ID }),
    ).toEqual(DENIED);
    const missing = { ok: false, reason: "not_found", code: "work_order_not_found" };
    kernelWrite.mockResolvedValueOnce(missing);
    expect(
      await actions.refreshChecks("acme", "core-platform", { itemId: ITEM_ID, orderId: ORDER_ID }),
    ).toEqual(missing);
  });
});

describe("closeItem and reopenItem", () => {
  it("closes with the resolution and the trimmed reason", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { item: after(5, "closed"), repeat: false } });
    expect(
      await actions.closeItem("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 4,
        resolution: "duplicate",
        reason: " Duplicate of WI-3. ",
      }),
    ).toEqual({ ok: true, value: { item: after(5, "closed") } });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workItemClose, {
      item_id: ITEM_ID,
      version: 4,
      resolution: "duplicate",
      reason: "Duplicate of WI-3.",
    });
  });

  it("reopens with the trimmed reason", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { item: after(12, "triaged"), repeat: false } });
    expect(
      await actions.reopenItem("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 11,
        reason: " The fix regressed. ",
      }),
    ).toEqual({ ok: true, value: { item: after(12, "triaged") } });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workItemReopen, {
      item_id: ITEM_ID,
      version: 11,
      reason: "The fix regressed.",
    });
  });

  it("passes a denial and a stale version on as they came", async () => {
    kernelWrite.mockResolvedValueOnce(DENIED).mockResolvedValueOnce(STALE);
    expect(
      await actions.closeItem("acme", "core-platform", {
        itemId: ITEM_ID,
        version: 4,
        resolution: "cancelled",
        reason: "r",
      }),
    ).toEqual(DENIED);
    expect(
      await actions.reopenItem("acme", "core-platform", { itemId: ITEM_ID, version: 3, reason: "r" }),
    ).toEqual(STALE);
  });
});

describe("setCollector and syncCollector", () => {
  it("sets a collector with the trimmed, non-empty repositories and names no connection", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { collector: {}, created: true, reconcile_queued: true },
    });
    expect(
      await actions.setCollector("acme", "core-platform", {
        name: " acme-github ",
        repos: [" acme/platform ", "", "acme/billing"],
      }),
    ).toEqual({ ok: true, value: { created: true, reconcileQueued: true } });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workCollectorSet, {
      name: "acme-github",
      repos: ["acme/platform", "acme/billing"],
    });
  });

  it("pauses a collector without naming its repositories", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { collector: {}, created: false, reconcile_queued: false },
    });
    await actions.setCollector("acme", "core-platform", { name: "acme-github", paused: true });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workCollectorSet, {
      name: "acme-github",
      paused: true,
    });
  });

  it("reads a collector again by its name", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: { queued: true } });
    expect(await actions.syncCollector("acme", "core-platform", { name: "acme-github" })).toEqual({
      ok: true,
      value: { queued: true },
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, workCollectorSync, { name: "acme-github" });
  });

  it("passes a denial and an invalid input on as they came", async () => {
    kernelWrite.mockResolvedValueOnce(DENIED).mockResolvedValueOnce(INVALID);
    expect(
      await actions.setCollector("acme", "core-platform", {
        name: "x",
        repos: [],
      }),
    ).toEqual(DENIED);
    expect(await actions.syncCollector("acme", "core-platform", { name: "x" })).toEqual(INVALID);
  });
});
