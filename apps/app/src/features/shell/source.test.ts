// shellSource: the organization and the person the layout's context admits.
// This file proves the shell renders the context's organization and the
// session's person, and refuses to render without a session.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthUser = vi.fn();
vi.mock("@/features/auth", () => ({ getAuthUser }));
const getSession = vi.fn();
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { shellSource } = await import("./source");

const ctx = unsafeMint(OrgCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

beforeEach(() => {
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue({
    id: "usr_marcusbell",
    email: "marcus.bell@acme.example",
    name: "Marcus Bell",
  });
});

describe("shellSource", () => {
  it("hands the context's organization and the signed-in person to the shell", async () => {
    expect(await shellSource(ctx)).toEqual({
      org: { slug: "acme", name: "Acme Robotics" },
      viewer: { name: "Marcus Bell", email: "marcus.bell@acme.example" },
    });
  });

  it("keeps a person with no recorded name as null, never an invented one", async () => {
    getAuthUser.mockResolvedValue({
      id: "usr_marcusbell",
      email: "marcus.bell@acme.example",
      name: "",
    });
    expect((await shellSource(ctx)).viewer).toEqual({
      name: null,
      email: "marcus.bell@acme.example",
    });
  });

  it("refuses to render without a session (negative)", async () => {
    getAuthUser.mockResolvedValue(null);
    await expect(shellSource(ctx)).rejects.toThrow("shell_without_session");
  });
});
