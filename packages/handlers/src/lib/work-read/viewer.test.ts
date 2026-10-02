// The viewer flags on the Work reads (P1-05, #5163): each asks the role check
// the matching Work action makes, as the acting user. An API key and an agent
// run can take none of those actions, so both flags are false for them
// without a role read.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { workActionRoles } from "@oxagen/work/records";

const mocks = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(async (ctx: { userId: string | null }) => ctx.userId),
}));
vi.mock("@oxagen/iam/org-role", () => ({ assertOrgRole: mocks.assertOrgRole, resolveActingUserId: mocks.resolveActingUserId }));

import { workViewer } from "./viewer";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const person = { orgId: ORG, workspaceId: WS, userId: USER, apiKeyId: null } as unknown as CapabilityContext;
const apiKey = { ...person, userId: null, apiKeyId: "aky_1" } as unknown as CapabilityContext;
const agentRun = { ...person, agentRun: { principalKind: "agent" } } as unknown as CapabilityContext;

const forbidden = () => new HandlerError({ code: "forbidden", reason: "org_role_required", message: "Requires a role" });

beforeEach(() => {
  mocks.assertOrgRole.mockReset();
  mocks.resolveActingUserId.mockClear();
});

describe("workViewer", () => {
  it("asks the send and accept roles for the acting user", async () => {
    mocks.assertOrgRole.mockResolvedValue("Owner");
    expect(await workViewer(person)).toEqual({ can_control: true, can_approve: true });
    expect(mocks.assertOrgRole).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS, userId: USER }, workActionRoles("send"));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS, userId: USER }, workActionRoles("accept"));
  });

  it("answers false for a role the check refuses", async () => {
    mocks.assertOrgRole.mockRejectedValue(forbidden());
    expect(await workViewer(person)).toEqual({ can_control: false, can_approve: false });
  });

  it("answers each flag from its own check", async () => {
    mocks.assertOrgRole.mockResolvedValueOnce("Member").mockRejectedValueOnce(forbidden());
    expect(await workViewer(person)).toEqual({ can_control: true, can_approve: false });
  });

  it("answers false for an API key and an agent run without a role read", async () => {
    expect(await workViewer(apiKey)).toEqual({ can_control: false, can_approve: false });
    expect(await workViewer(agentRun)).toEqual({ can_control: false, can_approve: false });
    expect(mocks.resolveActingUserId).not.toHaveBeenCalled();
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it("answers false when no person is signed in", async () => {
    expect(await workViewer({ ...person, userId: null } as unknown as CapabilityContext)).toEqual({ can_control: false, can_approve: false });
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it("passes on an error that is not a refusal", async () => {
    mocks.assertOrgRole.mockRejectedValue(new Error("connection lost"));
    await expect(workViewer(person)).rejects.toThrow("connection lost");
  });
});
