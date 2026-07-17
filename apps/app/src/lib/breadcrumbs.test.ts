import { describe, it, expect, vi, beforeEach } from "vitest";

// resolve-org does a DB lookup — stub it so the helper is exercised in isolation.
// (routes.ts is a pure builder and is used for real.)
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  resolveWorkspace: vi.fn(),
}));

import { workspaceCrumb } from "./breadcrumbs";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";

const mockResolveOrg = vi.mocked(resolveOrg);
const mockResolveWorkspace = vi.mocked(resolveWorkspace);

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOrg.mockResolvedValue({
    id: "org-1",
    publicId: "org_pub",
    name: "Acme",
    slug: "acme",
  } as never);
});

describe("workspaceCrumb", () => {
  it("labels the crumb by the workspace display name, not the URL slug", async () => {
    // The slug is lowercase "default"; the display name is "Default" — the crumb
    // must read the display name so it matches the topbar workspace pill.
    mockResolveWorkspace.mockResolvedValue({
      id: "ws-1",
      publicId: "ws_pub",
      orgId: "org-1",
      name: "Default",
      slug: "default",
      description: "",
      avatarUrl: null,
    } as never);

    const crumb = await workspaceCrumb("acme", "default");

    expect(crumb.label).toBe("Default");
    expect(mockResolveWorkspace).toHaveBeenCalledWith("org-1", "default");
    expect(crumb.href).toBe("/acme/default/sessions");
  });
});
