/**
 * Linker tests — verifies org/workspace selection logic and API paths.
 * The linker is used by both `oxagen login` and `oxagen init` to present the
 * tenant/workspace picker and resolve to a LinkedAccount.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the API module before imports
vi.mock("../api.js", () => ({
  userApiPostOrThrow: vi.fn(),
}));

import { userApiPostOrThrow } from "../api.js";
import { resolveOrg, resolveWorkspace } from "../linker.js";

const mockUserApiPostOrThrow = userApiPostOrThrow as ReturnType<typeof vi.fn>;

describe("linker", () => {
  beforeEach(() => {
    mockUserApiPostOrThrow.mockReset();
  });

  describe("resolveOrg", () => {
    it("calls the correct API endpoint (organizations, not user/organizations)", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organizations: [
          {
            id: "org-id-1",
            publicId: "pub-id-1",
            slug: "acme",
            name: "ACME Corp",
            role: "owner",
            avatarUrl: null,
          },
        ],
      });

      await resolveOrg({ isTTY: false });

      expect(mockUserApiPostOrThrow).toHaveBeenCalledWith("organizations", {});
      // Verify it was NOT called with the double-path
      expect(mockUserApiPostOrThrow).not.toHaveBeenCalledWith(
        "user/organizations",
        {},
      );
    });

    it("returns the single organization when there is only one", async () => {
      const org = {
        id: "org-id-1",
        publicId: "pub-id-1",
        slug: "acme",
        name: "ACME Corp",
        role: "owner",
        avatarUrl: null,
      };
      mockUserApiPostOrThrow.mockResolvedValue({ organizations: [org] });

      const result = await resolveOrg({ isTTY: false });

      expect(result).toEqual(org);
    });
  });

  describe("resolveWorkspace", () => {
    it("calls the correct API endpoint (workspaces, not user/workspaces)", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organization: {
          id: "org-id",
          publicId: "pub-id",
          slug: "acme",
          name: "ACME",
        },
        workspaces: [
          {
            id: "ws-id-1",
            publicId: "pub-ws-1",
            slug: "main",
            name: "Main",
            role: "owner",
          },
        ],
      });

      await resolveWorkspace({ orgSlug: "acme", isTTY: false });

      expect(mockUserApiPostOrThrow).toHaveBeenCalledWith("workspaces", {
        orgSlug: "acme",
      });
      // Verify it was NOT called with the double-path
      expect(mockUserApiPostOrThrow).not.toHaveBeenCalledWith(
        "user/workspaces",
        {
          orgSlug: "acme",
        },
      );
    });

    it("returns the workspace and org when there is one workspace", async () => {
      const ws = {
        id: "ws-id-1",
        publicId: "pub-ws-1",
        slug: "main",
        name: "Main",
        role: "owner",
      };
      const orgDetails = {
        id: "org-id",
        publicId: "pub-id",
        slug: "acme",
        name: "ACME",
      };
      mockUserApiPostOrThrow.mockResolvedValue({
        organization: orgDetails,
        workspaces: [ws],
      });

      const result = await resolveWorkspace({ orgSlug: "acme", isTTY: false });

      expect(result).toEqual({
        org: orgDetails,
        workspace: ws,
      });
    });
  });
});
