// The steering repo read (#4518). No capability answers it yet, so it names
// `get_steering_repo` and makes no kernel call.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readSteeringRepo } = await import("./read");

describe("readSteeringRepo", () => {
  it("names the capability the read needs while none answers it", async () => {
    const ctx = unsafeMint(WsCtx, {
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      orgId: "7a000000-0000-4000-8000-0000000000a1",
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole: "owner",
      workspaceId: "7b000000-0000-4000-8000-000000000001",
      wsSlug: "core-platform",
      wsName: "Core platform",
      wsRole: "member",
    });
    await expect(readSteeringRepo(ctx)).resolves.toEqual({
      kind: "not_backed",
      capability: "get_steering_repo",
    });
  });
});
