// The steering repo port (lane S2, #4560): one `get_steering_repo` kernel read
// on the workspace ctx, made for the Repositories page, with the answer and a
// refusal both handed through unchanged.
import { steeringRepoGet } from "@oxagen/oxagen/contracts/steering_repo.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead } = vi.hoisted(() => ({ kernelRead: vi.fn() }));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { steeringRepo } = await import("./steering-repo");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const DRIFTED = {
  status: "ready",
  step: "bind_repository",
  failedStep: null,
  error: null,
  provider: "github",
  repository: {
    fullName: "acme/oxagen-core-platform",
    url: "https://github.com/acme/oxagen-core-platform",
  },
  publishedVersion: 3,
  health: "drifted",
  differences: [
    {
      setting: "rulesets.oxagen_merges",
      expected: "active",
      actual: "disabled",
      changedBy: "jordan-lee",
      changedAt: "2026-09-26T14:05:00.000Z",
    },
  ],
} as const;

beforeEach(() => {
  kernelRead.mockReset();
});

describe("steeringRepo.get", () => {
  it("reads get_steering_repo on the workspace for the Repositories page", async () => {
    kernelRead.mockResolvedValue(readOk(DRIFTED));
    const read = await steeringRepo.get(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: steeringRepoGet,
      input: {},
      page: "repositories",
    });
    expect(read).toEqual(readOk(DRIFTED));
  });

  it("sends the input the contract accepts", () => {
    expect(steeringRepoGet.input.safeParse({}).success).toBe(true);
  });

  it("hands a refusal through unchanged (negative)", async () => {
    const refused = readError("installation_unreachable", 503);
    kernelRead.mockResolvedValue(refused);
    await expect(steeringRepo.get(ctx)).resolves.toBe(refused);
  });
});
