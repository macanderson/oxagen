// shellSource: the viewer gate is the whole read. This file proves the shell
// renders what requireViewer resolved and nothing for a refused organization.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireViewer = vi.fn();
vi.mock("@/server/scope", () => ({ requireViewer }));

const { shellSource } = await import("./source");

const viewer = {
  userId: "usr_marcusbell",
  user: {
    id: "usr_marcusbell",
    email: "marcus.bell@acme.example",
    name: "Marcus Bell",
    image: null,
  },
  orgRole: "owner",
  scope: {
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    workspaceId: "00000000-0000-0000-0000-000000000000",
  },
  org: {
    id: "7a000000-0000-4000-8000-0000000000a1",
    slug: "acme",
    name: "Acme Robotics",
  },
  ws: null,
};

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(viewer);
});

describe("shellSource", () => {
  it("hands the organization and the person requireViewer admits to the shell", async () => {
    expect(await shellSource("acme")).toEqual({
      org: { slug: "acme", name: "Acme Robotics" },
      viewer: { name: "Marcus Bell", email: "marcus.bell@acme.example" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
  });

  it("keeps a viewer with no recorded name as null, never an invented one", async () => {
    requireViewer.mockResolvedValue({
      ...viewer,
      user: { ...viewer.user, name: null },
    });
    expect((await shellSource("acme")).viewer).toEqual({
      name: null,
      email: "marcus.bell@acme.example",
    });
  });

  it("renders nothing when requireViewer refuses the organization (negative)", async () => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(shellSource("globex")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
