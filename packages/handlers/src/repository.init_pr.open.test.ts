// `open_init_pr`, retired by lane S1 (#4450). A caller the role gate lets in
// gets the typed refusal `conflict: init_pr_retired` with a message that
// points at the steering repo and `link_repository`. A caller the gate
// refuses gets the gate's own refusal, so the retired call reveals nothing
// about the workspace.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HandlerError,
  isHandlerError,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  assertOrgRole: vi.fn(
    async (
      _ctx: unknown,
      _required: { org: readonly string[]; workspace?: readonly string[] },
    ) => "Owner",
  ),
  resolveActingUserId: vi.fn(
    async (c: { userId: string | null }): Promise<string | null> => c.userId,
  ),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { repositoryInitPrOpen } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import {
  INIT_PR_RETIRED_MESSAGE,
  createInitPrOpenHandler,
  repositoryInitPrOpenHandler,
} from "./repository.init_pr.open";

const INPUT = repositoryInitPrOpen.input.parse({
  bindingId: "rpb_0a1b",
  governanceMode: "team",
  workspaceToml: 'schema = "oxagen-workspace/v0.1"\n',
  governanceToml: 'mode = "team"\n',
});

const RETIRED = {
  code: "conflict",
  reason: "init_pr_retired",
  message: INIT_PR_RETIRED_MESSAGE,
};

beforeEach(() => {
  mocks.assertOrgRole.mockReset();
  mocks.assertOrgRole.mockImplementation(async () => "Owner");
  mocks.resolveActingUserId.mockReset();
  mocks.resolveActingUserId.mockImplementation(async (c) => c.userId);
});

const HANDLERS: Array<[string, CapabilityHandler<typeof repositoryInitPrOpen>]> = [
  ["createInitPrOpenHandler", createInitPrOpenHandler()],
  ["repositoryInitPrOpenHandler", repositoryInitPrOpenHandler],
];

describe.each(HANDLERS)("%s", (_name, handler) => {
  it("refuses an allowed caller with conflict and init_pr_retired", async () => {
    const err: unknown = await handler(INPUT, makeCTX()).catch(
      (e: unknown) => e,
    );
    expect(isHandlerError(err)).toBe(true);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject(RETIRED);
  });

  it("names the steering repo and link_repository in the refusal", async () => {
    await expect(handler(INPUT, makeCTX())).rejects.toThrow(
      INIT_PR_RETIRED_MESSAGE,
    );
    expect(INIT_PR_RETIRED_MESSAGE).toContain("steering repo");
    expect(INIT_PR_RETIRED_MESSAGE).toContain("link_repository");
  });

  it("runs the role gate for an org Owner or Admin with the acting user", async () => {
    const ctx = makeCTX();
    await expect(handler(INPUT, ctx)).rejects.toMatchObject(RETIRED);
    expect(mocks.resolveActingUserId).toHaveBeenCalledTimes(1);
    expect(mocks.resolveActingUserId).toHaveBeenCalledWith(ctx);
    expect(mocks.assertOrgRole).toHaveBeenCalledTimes(1);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      { ...ctx, userId: "u_1" },
      { org: ["Owner", "Admin"] },
    );
  });

  it("gates an API key caller as the key's creator", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_creator");
    const ctx = makeCTX({ userId: null, apiKeyId: "aky_1", surface: "mcp" });
    await expect(handler(INPUT, ctx)).rejects.toMatchObject(RETIRED);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      { ...ctx, userId: "u_creator" },
      { org: ["Owner", "Admin"] },
    );
  });

  it("passes the role gate's refusal through unchanged", async () => {
    const refusal = new HandlerError({
      code: "forbidden",
      reason: "org_role_required",
    });
    mocks.assertOrgRole.mockRejectedValueOnce(refusal);
    await expect(handler(INPUT, makeCTX())).rejects.toBe(refusal);
  });

  it("passes a no_principal refusal through for a caller with no acting user", async () => {
    const refusal = new HandlerError({
      code: "forbidden",
      reason: "no_principal",
    });
    mocks.assertOrgRole.mockRejectedValueOnce(refusal);
    const ctx = makeCTX({ userId: null });
    const err: unknown = await handler(INPUT, ctx).catch((e: unknown) => e);
    expect(err).toBe(refusal);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      { ...ctx, userId: null },
      { org: ["Owner", "Admin"] },
    );
  });
});
