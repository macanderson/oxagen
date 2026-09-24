// The kernel seam (ARCHITECTURE.md §3.2; the kernelRead and kernelWrite guards
// of §6.1). The kernel's invoke() is a mock except where a test says it runs
// the real kernel; contracts, the registry and the error classes are real.
// Every `@ts-expect-error` below is a compile-time refusal, and the same call
// then runs to show the runtime twin of that refusal.
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PAGE_FAILURES, type Read, readError, readOk } from "@/data/read";
import { type ActionResult, kernelRead, kernelWrite } from "./kernel";
import { InviteeCtx, OrgCtx, PretenantCtx, WsCtx } from "./viewer";
import { unsafeMint } from "./viewer.testing";

const { invoke, captureError, loaded } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  captureError: vi.fn(),
  loaded: { handlers: false, agent: false },
}));

vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@oxagen/handlers/register", () => {
  loaded.handlers = true;
  return {};
});
vi.mock("@oxagen/agent/register", () => {
  loaded.agent = true;
  return {};
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");

const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";
const WS_ID = "7b000000-0000-4000-8000-0000000000b1";
const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPROVAL_ID = "0192f1c4-0000-7000-8000-0000000000aa";

const orgFields = {
  userId: USER_ID,
  orgId: ORG_ID,
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
} as const;
const orgCtx = unsafeMint(OrgCtx, orgFields);
const wsCtx = unsafeMint(WsCtx, {
  ...orgFields,
  workspaceId: WS_ID,
  wsSlug: "core",
  wsName: "Core platform",
  wsRole: "member",
});
const pretenantCtx = unsafeMint(PretenantCtx, { userId: USER_ID });
const inviteeCtx = unsafeMint(InviteeCtx, {
  userId: USER_ID,
  orgId: ORG_ID,
  invitationId: "0192f1c4-0000-7000-8000-0000000000bb",
});

const members = {
  scope: "org",
  members: [
    {
      id: "usr_marcusbell",
      name: null,
      email: "marcus.bell@acme.example",
      role: "member",
      joinedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  invitations: [],
} as const;
const membersCall = {
  contract: listMembers,
  input: { scope: "org" },
  page: "organization",
} as const;
const resolveInput = { approvalId: APPROVAL_ID, decision: "approved" } as const;
// resolve_approval answers the mandate settlement (ADR-059); a chat-gate row settles none.
const resolved = {
  approvalId: APPROVAL_ID,
  resolution: "approved",
  mandate: null,
} as const;

const DENIED = {
  ok: false,
  reason: "denied",
  permission: PAGE_FAILURES.organization.permission,
} as const;
const PAGE_ERROR = readError(
  PAGE_FAILURES.organization.error.code,
  PAGE_FAILURES.organization.error.status,
);

/** A billing gate's refusal, by the code the kernel seam keys on. */
class GauExhausted extends Error {
  readonly code = "gau_exhausted";
}
class Coded extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const capabilityError = (
  code: ConstructorParameters<typeof kernel.CapabilityError>[1],
  accessRequestId?: string,
) => new kernel.CapabilityError("list_members", code, code, accessRequestId);
const handlerError = (code: "forbidden" | "not_found" | "conflict") =>
  new kernel.HandlerError({ code, reason: `${code}_reason` });
/** A CapabilityError copied field by field: same shape, not an instance. */
const clonedError = {
  name: "CapabilityError",
  capability: "list_members",
  code: "authz_denied",
  message: "denied",
};

const sentContext = () => {
  expect(invoke).toHaveBeenCalledOnce();
  const call = invoke.mock.calls[0];
  // No `opts`: the app never claims a surface, so a surfaces allowlist cannot refuse it.
  expect(call).toHaveLength(3);
  return call?.[2];
};

async function expectRefused(
  result: Promise<Read<unknown> | ActionResult<unknown>>,
  expected: Read<unknown> | ActionResult<unknown>,
) {
  expect(await result).toEqual(expected);
  expect(invoke).not.toHaveBeenCalled();
  expect(captureError).toHaveBeenCalledOnce();
}

beforeEach(() => {
  invoke.mockReset();
  captureError.mockReset();
});

afterEach(() => {
  kernel.clearBillingAdmissionGate();
  kernel.clearHandlersForTests();
});

describe("kernelRead", () => {
  it("loads both handler registries first, and invokes with the context the kernel scopes", async () => {
    invoke.mockImplementation(() => {
      expect(loaded).toEqual({ handlers: true, agent: true });
      return Promise.resolve({ ...members, extra: 1 });
    });
    // Parsed by the contract's output schema: the unknown key is stripped.
    expect(await kernelRead(orgCtx, membersCall)).toEqual(readOk(members));
    const call = invoke.mock.calls[0];
    expect(call?.[0]).toBe("list_members");
    expect(call?.[1]).toEqual({ scope: "org" });
    // Exactly these keys: surface "app", never a platformOperator binding, and
    // the org-only sentinel for an organization-level context.
    const context = sentContext();
    expect(context?.requestId).toMatch(UUID);
    expect({ ...context, requestId: null }).toEqual({
      orgId: ORG_ID,
      workspaceId: ORG_ONLY_WS,
      userId: USER_ID,
      apiKeyId: null,
      requestId: null,
      surface: "app",
      messageId: null,
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  // The per-request read table comes from React `cache`. Outside a request
  // React hands back a fresh table each call, so nothing is shared between
  // tests or across requests and every read still reaches invoke. The sharing
  // itself is covered in kernel-read-memo.test.ts, which stands a request up.
  it("does not share a read outside a request scope", async () => {
    invoke.mockResolvedValue(members);
    expect(await kernelRead(orgCtx, membersCall)).toEqual(readOk(members));
    expect(await kernelRead(orgCtx, membersCall)).toEqual(readOk(members));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("carries the workspace of a WsCtx", async () => {
    invoke.mockResolvedValue(members);
    await kernelRead(wsCtx, membersCall);
    expect(sentContext()).toMatchObject({ orgId: ORG_ID, workspaceId: WS_ID });
  });

  it("reads an unscoped contract for a PretenantCtx with empty tenant ids", async () => {
    invoke.mockResolvedValue({ organizations: [] });
    const read = await kernelRead(pretenantCtx, {
      contract: orgList,
      input: {},
      page: "shell",
    });
    expect(read).toEqual(readOk({ organizations: [] }));
    expect(sentContext()).toMatchObject({ orgId: "", workspaceId: "" });
  });

  it("refuses a contract that does not declare mutates: false, by type and at runtime (negative)", async () => {
    const mutating = {
      contract: agentApprovalResolve,
      input: resolveInput,
      page: "fleet",
    } as const;
    // @ts-expect-error resolve_approval is not a ReadContract
    const read = kernelRead(wsCtx, mutating);
    await expectRefused(read, readError("contract_mutates", 500));
  });

  it("refuses a structurally forged read contract at runtime (negative)", async () => {
    const forged = { ...agentApprovalResolve, mutates: false } as const;
    const read = kernelRead(wsCtx, {
      contract: forged,
      input: resolveInput,
      page: "fleet",
    });
    await expectRefused(read, readError("contract_mutates", 500));
  });

  it("refuses an unregistered tool (negative)", async () => {
    const unregistered = {
      name: "list_nothing",
      mutates: false,
      input: z.object({}),
      output: z.object({}),
    } as const;
    const read = kernelRead(orgCtx, {
      contract: unregistered,
      input: {},
      page: "organization",
    });
    await expectRefused(read, readError("tool_not_registered", 500));
  });

  it("refuses a PretenantCtx on a scoped contract, by type and at runtime (negative)", async () => {
    // @ts-expect-error list_members is scoped; a PretenantCtx reaches only scoped: false
    const read = kernelRead(pretenantCtx, membersCall);
    await expectRefused(read, readError("contract_scoped", 500));
  });

  it("refuses an InviteeCtx, by type and at runtime (negative)", async () => {
    // @ts-expect-error an invitee has no read access
    const read = kernelRead(inviteeCtx, membersCall);
    await expectRefused(read, readError("invalid_ctx", 500));
  });

  describe("refuses a ctx viewer.ts did not mint as invalid_ctx, reported once (negative)", () => {
    const invalidCtx = readError("invalid_ctx", 500);

    it("an Object.assign copy", async () => {
      // eslint-disable-next-line no-restricted-syntax -- the copy INV-02 refuses at runtime
      const copy = Object.assign({}, orgCtx, { orgId: "victim" });
      await expectRefused(kernelRead(copy, membersCall), invalidCtx);
    });

    it("a spread copy", async () => {
      // eslint-disable-next-line @typescript-eslint/no-misused-spread -- the copy INV-02 refuses at runtime
      const copy = { ...orgCtx, orgId: "victim" };
      // @ts-expect-error a spread drops the #brand the compiler requires
      await expectRefused(kernelRead(copy, membersCall), invalidCtx);
    });

    it("a structuredClone", async () => {
      // eslint-disable-next-line no-restricted-syntax -- the clone INV-02 refuses at runtime
      const clone = structuredClone(orgCtx);
      await expectRefused(kernelRead(clone, membersCall), invalidCtx);
    });

    it("a plain object with the right keys", async () => {
      const plain = { ...orgFields };
      // @ts-expect-error a plain object is not an OrgCtx
      await expectRefused(kernelRead(plain, membersCall), invalidCtx);
    });
  });

  it.each<[string, unknown, Read<unknown>, number]>([
    ["authz_denied", capabilityError("authz_denied"), DENIED, 0],
    [
      "capability_not_installed",
      capabilityError("capability_not_installed"),
      DENIED,
      0,
    ],
    ["no_handler", capabilityError("no_handler"), DENIED, 0],
    [
      "pending_approval",
      capabilityError("pending_approval", "arq_123"),
      { ok: false, reason: "pending_approval", accessRequestId: "arq_123" },
      0,
    ],
    [
      "pending_approval with no access request",
      capabilityError("pending_approval"),
      DENIED,
      0,
    ],
    [
      "invalid_input",
      capabilityError("invalid_input"),
      readError("invalid_input", 400),
      0,
    ],
    [
      "invalid_output",
      capabilityError("invalid_output"),
      readError("contract_output_mismatch", 502),
      1,
    ],
    ["HandlerError forbidden", handlerError("forbidden"), DENIED, 0],
    // The handler's reason rides in `code`, the kind in the status, so a page's
    // failure sentence written for `github_not_connected` gets the reason.
    [
      "HandlerError not_found",
      handlerError("not_found"),
      readError("not_found_reason", 404),
      0,
    ],
    [
      "HandlerError conflict",
      handlerError("conflict"),
      readError("conflict_reason", 409),
      0,
    ],
    ["a structurally cloned error", clonedError, DENIED, 0],
    ["an error with no known code", new Coded("ECONNRESET"), PAGE_ERROR, 1],
    ["a thrown non-object", "boom", PAGE_ERROR, 1],
  ])("classifies %s", async (_label, thrown, expected, reports) => {
    invoke.mockRejectedValue(thrown);
    expect(await kernelRead(orgCtx, membersCall)).toEqual(expected);
    expect(captureError).toHaveBeenCalledTimes(reports);
  });

  it("answers output its contract rejects with contract_output_mismatch, reported once (negative)", async () => {
    invoke.mockResolvedValue({ scope: "org", members: 42 });
    expect(await kernelRead(orgCtx, membersCall)).toEqual(
      readError("contract_output_mismatch", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("reads a noBillingGate contract for an org whose GAU bucket is empty, through the real kernel (INV-28)", async () => {
    invoke.mockImplementation(kernel.invoke);
    kernel.setBillingAdmissionGate(() => Promise.reject(new GauExhausted()));
    kernel.registerHandler("list_members", () =>
      Promise.resolve(() => Promise.resolve(members)),
    );
    kernel.registerHandler("resolve_approval", () =>
      Promise.resolve(() => Promise.resolve(resolved)),
    );
    expect(await kernelRead(orgCtx, membersCall)).toEqual(readOk(members));
    // The same gate refuses the one governed action.
    expect(
      await kernelWrite(wsCtx, agentApprovalResolve, resolveInput),
    ).toEqual({ ok: false, reason: "exhausted", code: "gau_exhausted" });
  });
});

describe("kernelWrite", () => {
  it("writes with a parsed output and the context the kernel scopes", async () => {
    invoke.mockResolvedValue({ ...resolved, extra: 1 });
    expect(
      await kernelWrite(wsCtx, agentApprovalResolve, resolveInput),
    ).toEqual({ ok: true, value: resolved });
    expect(invoke.mock.calls[0]?.[0]).toBe("resolve_approval");
    const context = sentContext();
    expect(context?.requestId).toMatch(UUID);
    expect({ ...context, requestId: null }).toEqual({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      userId: USER_ID,
      apiKeyId: null,
      requestId: null,
      surface: "app",
      messageId: null,
    });
  });

  it("pre-parses input with the contract's schema and names the field, with no kernel call (negative)", async () => {
    const result = await kernelWrite(wsCtx, agentApprovalResolve, {
      approvalId: "not-an-approval",
      decision: "approved",
    });
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "approvalId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers a kernel invalid_input after a successful pre-parse as invalid with no field", async () => {
    invoke.mockRejectedValue(capabilityError("invalid_input"));
    expect(
      await kernelWrite(wsCtx, agentApprovalResolve, resolveInput),
    ).toEqual({ ok: false, reason: "invalid", code: "invalid_input" });
  });

  it.each<[string, unknown, ActionResult<unknown>, number]>([
    [
      "authz_denied",
      capabilityError("authz_denied"),
      { ok: false, reason: "denied", code: "authz_denied" },
      0,
    ],
    [
      "capability_not_installed",
      capabilityError("capability_not_installed"),
      { ok: false, reason: "denied", code: "capability_not_installed" },
      0,
    ],
    [
      "no_handler",
      capabilityError("no_handler"),
      { ok: false, reason: "denied", code: "no_handler" },
      0,
    ],
    [
      "pending_approval",
      capabilityError("pending_approval", "arq_123"),
      { ok: false, reason: "pending_approval", accessRequestId: "arq_123" },
      0,
    ],
    [
      "invalid_output",
      capabilityError("invalid_output"),
      { ok: false, reason: "unavailable", code: "contract_output_mismatch" },
      1,
    ],
    [
      "gau_exhausted",
      new Coded("gau_exhausted"),
      { ok: false, reason: "exhausted", code: "gau_exhausted" },
      0,
    ],
    [
      "billing_suspended",
      new Coded("billing_suspended"),
      { ok: false, reason: "exhausted", code: "billing_suspended" },
      0,
    ],
    [
      "budget_exceeded",
      new Coded("budget_exceeded"),
      { ok: false, reason: "exhausted", code: "budget_exceeded" },
      0,
    ],
    [
      "insufficient_credits",
      new Coded("insufficient_credits"),
      { ok: false, reason: "exhausted", code: "insufficient_credits" },
      0,
    ],
    [
      "assistant_spend_cap",
      new Coded("assistant_spend_cap"),
      { ok: false, reason: "exhausted", code: "assistant_spend_cap" },
      0,
    ],
    // #3227: the engine's own codes reach the caller, so the flyout can say
    // the engine is down rather than the generic kernel_failure. Each is a
    // service outage, reported once like any other.
    [
      "engine_unavailable",
      new Coded("engine_unavailable"),
      { ok: false, reason: "unavailable", code: "engine_unavailable" },
      1,
    ],
    [
      "assistant_run_not_recorded",
      new Coded("assistant_run_not_recorded"),
      { ok: false, reason: "unavailable", code: "assistant_run_not_recorded" },
      1,
    ],
    [
      "engine_aborted",
      new Coded("engine_aborted"),
      { ok: false, reason: "conflict", code: "engine_aborted" },
      0,
    ],
    [
      "HandlerError forbidden",
      handlerError("forbidden"),
      { ok: false, reason: "denied", code: "forbidden_reason" },
      0,
    ],
    [
      "HandlerError not_found",
      handlerError("not_found"),
      { ok: false, reason: "not_found", code: "not_found_reason" },
      0,
    ],
    [
      "HandlerError conflict",
      new kernel.HandlerError({ code: "conflict", reason: "approval_expired" }),
      { ok: false, reason: "conflict", code: "approval_expired" },
      0,
    ],
    [
      "a structurally cloned error",
      clonedError,
      { ok: false, reason: "denied", code: "authz_denied" },
      0,
    ],
    [
      "an error with no known code",
      new Error("boom"),
      { ok: false, reason: "unavailable", code: "kernel_failure" },
      1,
    ],
  ])("classifies %s", async (_label, thrown, expected, reports) => {
    invoke.mockRejectedValue(thrown);
    expect(
      await kernelWrite(wsCtx, agentApprovalResolve, resolveInput),
    ).toEqual(expected);
    expect(captureError).toHaveBeenCalledTimes(reports);
  });

  it("writes an unscoped contract for a PretenantCtx with empty tenant ids", async () => {
    invoke.mockResolvedValue({ organizations: [] });
    expect(await kernelWrite(pretenantCtx, orgList, {})).toEqual({
      ok: true,
      value: { organizations: [] },
    });
    expect(sentContext()).toMatchObject({ orgId: "", workspaceId: "" });
  });

  it("refuses a PretenantCtx on a scoped contract, by type and at runtime (negative)", async () => {
    const input = resolveInput;
    // @ts-expect-error resolve_approval is scoped; a PretenantCtx reaches only scoped: false
    const result = kernelWrite(pretenantCtx, agentApprovalResolve, input);
    await expectRefused(result, {
      ok: false,
      reason: "unavailable",
      code: "contract_scoped",
    });
  });

  it("writes an invitation decision for an InviteeCtx in the invitation's organization", async () => {
    const accepted = {
      orgUserId: "0192f1c4-0000-7000-8000-0000000000cc",
      orgId: ORG_ID,
      role: "member",
      joinedAt: "2026-09-15T00:00:00.000Z",
    };
    invoke.mockResolvedValue(accepted);
    const result = await kernelWrite(inviteeCtx, orgMemberInviteAccept, {
      invitationPublicId: "invi_live",
    });
    expect(result).toEqual({ ok: true, value: accepted });
    expect(sentContext()).toMatchObject({
      orgId: ORG_ID,
      workspaceId: ORG_ONLY_WS,
      userId: USER_ID,
    });
  });

  it("refuses an InviteeCtx on any other write, by type and at runtime (negative)", async () => {
    const input = resolveInput;
    // @ts-expect-error an invitee reaches the two invitation writes alone
    const result = kernelWrite(inviteeCtx, agentApprovalResolve, input);
    await expectRefused(result, {
      ok: false,
      reason: "unavailable",
      code: "contract_not_invitation",
    });
  });

  it("refuses a ctx viewer.ts did not mint as unavailable / invalid_ctx, reported once (negative)", async () => {
    const plain = { ...orgFields, workspaceId: WS_ID };
    // @ts-expect-error a plain object is not a WsCtx
    const result = kernelWrite(plain, agentApprovalResolve, resolveInput);
    await expectRefused(result, {
      ok: false,
      reason: "unavailable",
      code: "invalid_ctx",
    });
  });
});

describe("handler registries (INV-23)", () => {
  it("resolve list_mcp_servers, bound by @oxagen/agent, in a fresh module graph", async () => {
    vi.resetModules();
    vi.doUnmock("@oxagen/handlers/register");
    vi.doUnmock("@oxagen/agent/register");
    const registered: boolean[] = [];
    vi.doMock("@oxagen/oxagen", async (importOriginal) => {
      const fresh = await importOriginal<typeof import("@oxagen/oxagen")>();
      return {
        ...fresh,
        invoke: (name: string) => {
          registered.push(
            fresh.hasHandler(name),
            fresh.hasHandler("list_orgs"),
          );
          return Promise.resolve({ servers: [] });
        },
      };
    });
    const { kernelRead: freshRead } = await import("./kernel");
    const viewer = await import("./viewer");
    const testing = await import("./viewer.testing");
    const { agentMcpList } = await import(
      "@oxagen/oxagen/contracts/agent.mcp.list"
    );
    const ctx = testing.unsafeMint(viewer.WsCtx, {
      ...orgFields,
      workspaceId: WS_ID,
      wsSlug: "core",
      wsName: "Core platform",
      wsRole: "member",
    });
    const read = await freshRead(ctx, {
      contract: agentMcpList,
      input: {},
      page: "fleet",
    });
    expect(read).toEqual(readOk({ servers: [] }));
    // Both registries were loaded before the one invoke: the agent-bound
    // capability and a @oxagen/handlers-bound one.
    expect(registered).toEqual([true, true]);
  }, 60_000);
});

// The other end of `toRead`'s encoding. `Read` has no not_found, conflict or
// invalid variant, so those three kinds arrive as a `ReadError` whose status
// names the kind and whose `code` keeps the handler's reason. A converter
// reading `reason` alone calls a missing row unavailable, which tells a person
// to come back for something that was never there and hides a 404 behind a
// 503; one keyed on `code` would drop the reason the failure sentences need.
describe("readToActionResult", () => {
  it("keeps not_found, conflict and invalid apart from a real outage", async () => {
    const { readToActionResult } = await import("./kernel");
    expect(readToActionResult(readError("not_found", 404))).toEqual({
      ok: false,
      reason: "not_found",
      code: "not_found",
    });
    expect(readToActionResult(readError("conflict", 409))).toEqual({
      ok: false,
      reason: "conflict",
      code: "conflict",
    });
    expect(readToActionResult(readError("github_not_connected", 409))).toEqual({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    expect(readToActionResult(readError("invalid_input", 400))).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
    });
  });

  it("calls a store that is down unavailable, keeping its code (negative)", async () => {
    const { readToActionResult } = await import("./kernel");
    expect(
      readToActionResult(readError("control_plane_unavailable", 503)),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: "control_plane_unavailable",
    });
  });

  it("carries a denial's permission and a pending approval's id", async () => {
    const { readToActionResult } = await import("./kernel");
    expect(
      readToActionResult({
        ok: false,
        reason: "denied",
        permission: "workspace.read",
      }),
    ).toEqual({ ok: false, reason: "denied", code: "workspace.read" });
    expect(
      readToActionResult({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "req_1",
      }),
    ).toEqual({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "req_1",
    });
  });

  it("passes a value through", async () => {
    const { readToActionResult } = await import("./kernel");
    expect(readToActionResult(readOk({ a: 1 }))).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });
});
