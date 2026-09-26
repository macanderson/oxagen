// The kernel seam records what it knows about a failed invoke (#3841): the
// rule that refused it, the trace it ran under, the region that answered and
// the request id the seam minted. A read carries them on Denied and ReadError;
// a write carries the recorded ones. A workspace decision rule's refusal is a
// denial naming its rule, not the page's outage. kernel.test.ts covers the
// seam's guards and its classification table.
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_FAILURES } from "@/data/read";
import { kernelRead, kernelWrite } from "./kernel";
import { InviteeCtx, OrgCtx } from "./viewer";
import { unsafeMint } from "./viewer.testing";

const { invoke, captureError, currentTraceIds } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  captureError: vi.fn(),
  currentTraceIds: vi.fn(() => ({ trace_id: "", span_id: "" })),
}));

vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError, currentTraceIds }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");

const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";
const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

const orgCtx = unsafeMint(OrgCtx, {
  userId: USER_ID,
  orgId: ORG_ID,
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
});
const inviteeCtx = unsafeMint(InviteeCtx, {
  userId: USER_ID,
  orgId: ORG_ID,
  invitationId: "0192f1c4-0000-7000-8000-0000000000bb",
});
const membersCall = {
  contract: listMembers,
  input: { scope: "org" },
  page: "organization",
} as const;

/** A decision rule's refusal, shaped as @oxagen/rules throws it. */
class RuleRefusal extends Error {
  constructor(
    readonly code: "decision_rule_denied" | "decision_rule_approval_required",
    readonly verdict: { ruleId: string; description: string },
  ) {
    super(`refused by decision rule "${verdict.ruleId}"`);
  }
}

const iamDenial = (decidedBy?: string) =>
  new kernel.CapabilityError(
    "list_members",
    "authz_denied",
    "denied",
    undefined,
    undefined,
    decidedBy,
  );

/** The request id the seam handed the kernel on the last invoke. */
const sentRequestId = (): string => {
  const context = invoke.mock.calls.at(-1)?.[2];
  expect(context?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  return context?.requestId ?? "";
};

beforeEach(() => {
  invoke.mockReset();
  captureError.mockReset();
  currentTraceIds.mockReset();
  currentTraceIds.mockReturnValue({ trace_id: "", span_id: "" });
  vi.stubEnv("OXAGEN_REGION", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("kernelRead records the facts of a denial", () => {
  it("names the IAM rule, the trace, the region and the request", async () => {
    invoke.mockRejectedValue(iamDenial("7:role_grant"));
    currentTraceIds.mockReturnValue({ trace_id: TRACE, span_id: "00f0" });
    vi.stubEnv("OXAGEN_REGION", "us-east-1");

    const read = await kernelRead(orgCtx, membersCall);
    expect(read).toEqual({
      ok: false,
      reason: "denied",
      permission: PAGE_FAILURES.organization.permission,
      decidedBy: { source: "iam", id: "7:role_grant" },
      traceId: TRACE,
      region: "us-east-1",
      requestId: sentRequestId(),
    });
  });

  it("reads null for a rule, a trace and a region nothing recorded", async () => {
    invoke.mockRejectedValue(iamDenial());
    const read = await kernelRead(orgCtx, membersCall);
    expect(read).toMatchObject({
      reason: "denied",
      decidedBy: null,
      traceId: null,
      region: null,
    });
  });

  it("answers a decision rule's refusal as denied, naming the rule, and reports nothing", async () => {
    invoke.mockRejectedValue(
      new RuleRefusal("decision_rule_denied", {
        ruleId: "rul_no_weekend_deploys",
        description: "no deploys on a weekend",
      }),
    );
    const read = await kernelRead(orgCtx, membersCall);
    // Before #3841 this read as the page's 503 and was reported as a
    // failure nobody had classified.
    expect(read).toMatchObject({
      ok: false,
      reason: "denied",
      decidedBy: { source: "decision_rule", id: "rul_no_weekend_deploys" },
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers a rule that wants a person as denied too, since the app has no approval channel for it", async () => {
    invoke.mockRejectedValue(
      new RuleRefusal("decision_rule_approval_required", {
        ruleId: "rul_two_person",
        description: "two people approve",
      }),
    );
    expect(await kernelRead(orgCtx, membersCall)).toMatchObject({
      reason: "denied",
      decidedBy: { source: "decision_rule", id: "rul_two_person" },
    });
  });
});

describe("kernelRead records the facts of an error", () => {
  it("carries the trace, the region and the request on a classified error", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError("x", "invalid_output", "x"),
    );
    currentTraceIds.mockReturnValue({ trace_id: TRACE, span_id: "00f0" });
    vi.stubEnv("OXAGEN_REGION", "eu-west-1");
    expect(await kernelRead(orgCtx, membersCall)).toEqual({
      ok: false,
      reason: "error",
      code: "contract_output_mismatch",
      status: 502,
      traceId: TRACE,
      region: "eu-west-1",
      requestId: sentRequestId(),
    });
  });

  it("carries them on the page's fallback for an unclassified failure", async () => {
    invoke.mockRejectedValue(new Error("ECONNRESET"));
    currentTraceIds.mockReturnValue({ trace_id: TRACE, span_id: "00f0" });
    expect(await kernelRead(orgCtx, membersCall)).toEqual({
      ok: false,
      reason: "error",
      code: PAGE_FAILURES.organization.error.code,
      status: PAGE_FAILURES.organization.error.status,
      traceId: TRACE,
      region: null,
      requestId: sentRequestId(),
    });
  });

  it("reads the trace as not recorded when no span is active, or the read throws", async () => {
    invoke.mockRejectedValue(new Error("ECONNRESET"));
    expect(await kernelRead(orgCtx, membersCall)).toMatchObject({
      traceId: null,
    });
    currentTraceIds.mockImplementation(() => {
      throw new Error("tracer misconfigured");
    });
    expect(await kernelRead(orgCtx, membersCall)).toMatchObject({
      reason: "error",
      traceId: null,
    });
  });

  it("carries no facts on a refusal the seam made before the kernel ran", async () => {
    // @ts-expect-error an invitee has no read access
    const read = await kernelRead(inviteeCtx, membersCall);
    expect(read).toEqual({
      ok: false,
      reason: "error",
      code: "invalid_ctx",
      status: 500,
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("kernelWrite carries the facts that were recorded", () => {
  const accept = { invitationPublicId: "invi_live" };

  it("names the rule, the trace and the region on a denied write", async () => {
    invoke.mockRejectedValue(iamDenial("8:default"));
    currentTraceIds.mockReturnValue({ trace_id: TRACE, span_id: "00f0" });
    vi.stubEnv("OXAGEN_REGION", "us-east-1");
    expect(
      await kernelWrite(inviteeCtx, orgMemberInviteAccept, accept),
    ).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
      decidedBy: { source: "iam", id: "8:default" },
      traceId: TRACE,
      region: "us-east-1",
    });
  });

  it("answers a decision rule's refusal as denied with the rule's code", async () => {
    invoke.mockRejectedValue(
      new RuleRefusal("decision_rule_denied", {
        ruleId: "rul_freeze",
        description: "change freeze",
      }),
    );
    expect(
      await kernelWrite(inviteeCtx, orgMemberInviteAccept, accept),
    ).toEqual({
      ok: false,
      reason: "denied",
      code: "decision_rule_denied",
      decidedBy: { source: "decision_rule", id: "rul_freeze" },
    });
  });

  it("leaves out every fact nothing recorded", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    expect(
      await kernelWrite(inviteeCtx, orgMemberInviteAccept, accept),
    ).toEqual({ ok: false, reason: "unavailable", code: "kernel_failure" });
  });
});
