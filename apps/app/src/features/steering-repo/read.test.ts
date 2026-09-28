// The steering repo read (lane S2, #4560): `get_steering_repo` through the
// DataSource's `steeringRepo` port, on the viewer's workspace. An answered
// read hands the view through. A failed read stays whole, so the card and
// onboarding can say who was denied what, or which code the control plane
// answered.
import { describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import {
  failedSteeringRepo,
  settingsDifference,
  steeringRepoSource,
  steeringRepoView,
} from "./steering-repo.builders";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readSteeringRepo } = await import("./read");

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

describe("readSteeringRepo", () => {
  it("reads the viewer's workspace and hands the answered view through", async () => {
    const view = steeringRepoView({
      health: "drifted",
      differences: [settingsDifference()],
    });
    const { source, calls } = steeringRepoSource(readOk(view));
    await expect(readSteeringRepo(source, ctx)).resolves.toEqual({
      kind: "ok",
      view,
    });
    expect(calls).toEqual([[ctx]]);
  });

  it("hands a failed provisioning job through as an answered read", async () => {
    const view = failedSteeringRepo("create_repository", {
      code: "repository_name_taken",
      message: "GitHub already has a repository named acme/oxagen-core-platform.",
    });
    const { source } = steeringRepoSource(readOk(view));
    await expect(readSteeringRepo(source, ctx)).resolves.toEqual({
      kind: "ok",
      view,
    });
  });

  it("keeps the code of a read the control plane refused (negative)", async () => {
    const failure = readError("installation_unreachable", 503);
    const { source } = steeringRepoSource(failure);
    await expect(readSteeringRepo(source, ctx)).resolves.toEqual({
      kind: "failed",
      failure,
    });
  });

  it("keeps the permission a denied viewer lacks (negative)", async () => {
    const { source } = steeringRepoSource({
      ok: false,
      reason: "denied",
      permission: "repository.read",
    });
    await expect(readSteeringRepo(source, ctx)).resolves.toEqual({
      kind: "failed",
      failure: { ok: false, reason: "denied", permission: "repository.read" },
    });
  });
});
