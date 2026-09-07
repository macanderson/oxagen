/**
 * Linker tests — verifies org/workspace selection logic and API paths.
 * The linker is used by both `oxagen login` and `oxagen init` to present the
 * tenant/workspace picker and resolve to a LinkedAccount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the API module before imports
vi.mock("../api.js", () => ({
  userApiPostOrThrow: vi.fn(),
}));

import { userApiPostOrThrow } from "../api.js";
import {
  resolveLinkedAccount,
  resolveOrg,
  resolveWorkspace,
} from "../linker.js";

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

// ---------------------------------------------------------------------------
// Selection paths: explicit slug, zero options, many options (interactive), and
// the combined resolveLinkedAccount flow.
// ---------------------------------------------------------------------------

const ORG_A = {
  id: "org-a",
  publicId: "pub-a",
  slug: "acme",
  name: "Acme Inc",
  role: "owner",
  avatarUrl: null,
};
const ORG_B = { ...ORG_A, id: "org-b", publicId: "pub-b", slug: "beta", name: "Beta LLC" };
const WS_MAIN = {
  id: "ws-1",
  publicId: "pub-ws-1",
  slug: "main",
  name: "Main",
  role: "owner",
};
const WS_STAGE = { ...WS_MAIN, id: "ws-2", publicId: "pub-ws-2", slug: "stage", name: "Stage" };
const ORG_DETAILS = {
  id: "org-a",
  publicId: "pub-a",
  slug: "acme",
  name: "Acme Inc",
};

describe("linker selection paths", () => {
  let out = "";
  let stdout: typeof process.stdout.write;

  beforeEach(() => {
    mockUserApiPostOrThrow.mockReset();
    out = "";
    stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = stdout;
  });

  describe("resolveOrg", () => {
    it("throws with a signup link when the user has no organizations", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({ organizations: [] });
      await expect(resolveOrg({ isTTY: true })).rejects.toThrow(
        /no organizations/i,
      );
    });

    it("returns the org named by --org", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organizations: [ORG_A, ORG_B],
      });
      await expect(
        resolveOrg({ orgSlug: "beta", isTTY: false }),
      ).resolves.toEqual(ORG_B);
    });

    it("lists the available slugs when --org names an org the user is not in", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organizations: [ORG_A, ORG_B],
      });
      await expect(
        resolveOrg({ orgSlug: "ghost", isTTY: false }),
      ).rejects.toThrow(/Available: acme, beta/);
    });

    it("refuses to prompt for a choice outside a TTY", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organizations: [ORG_A, ORG_B],
      });
      await expect(resolveOrg({ isTTY: false })).rejects.toThrow(
        /Cannot prompt interactively/,
      );
    });

    it("prints a confirmation line when auto-selecting the only org", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({ organizations: [ORG_A] });
      await resolveOrg({ isTTY: false });
      expect(out).toContain("Organization: Acme Inc (acme)");
    });
  });

  describe("resolveWorkspace", () => {
    it("throws when the org has no workspaces", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organization: ORG_DETAILS,
        workspaces: [],
      });
      await expect(
        resolveWorkspace({ orgSlug: "acme", isTTY: true }),
      ).rejects.toThrow(/has no workspaces/);
    });

    it("returns the workspace named by --workspace", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organization: ORG_DETAILS,
        workspaces: [WS_MAIN, WS_STAGE],
      });
      const result = await resolveWorkspace({
        orgSlug: "acme",
        workspaceSlug: "stage",
        isTTY: false,
      });
      expect(result.workspace).toEqual(WS_STAGE);
      expect(out).toContain("Workspace:    Stage (stage)");
    });

    it("lists the available slugs when --workspace is unknown", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organization: ORG_DETAILS,
        workspaces: [WS_MAIN, WS_STAGE],
      });
      await expect(
        resolveWorkspace({
          orgSlug: "acme",
          workspaceSlug: "ghost",
          isTTY: false,
        }),
      ).rejects.toThrow(/Available: main, stage/);
    });

    it("refuses to prompt for a choice outside a TTY", async () => {
      mockUserApiPostOrThrow.mockResolvedValue({
        organization: ORG_DETAILS,
        workspaces: [WS_MAIN, WS_STAGE],
      });
      await expect(
        resolveWorkspace({ orgSlug: "acme", isTTY: false }),
      ).rejects.toThrow(/Cannot prompt interactively/);
    });
  });

  describe("resolveLinkedAccount", () => {
    it("chains org then workspace into one flat account record", async () => {
      mockUserApiPostOrThrow
        .mockResolvedValueOnce({ organizations: [ORG_A] })
        .mockResolvedValueOnce({
          organization: ORG_DETAILS,
          workspaces: [WS_MAIN],
        });

      await expect(resolveLinkedAccount({ isTTY: false })).resolves.toEqual({
        orgId: "org-a",
        orgSlug: "acme",
        orgName: "Acme Inc",
        workspaceId: "ws-1",
        workspaceSlug: "main",
        workspaceName: "Main",
      });
      expect(mockUserApiPostOrThrow).toHaveBeenNthCalledWith(
        2,
        "workspaces",
        { orgSlug: "acme" },
      );
    });

    it("passes both explicit slugs straight through the pickers", async () => {
      mockUserApiPostOrThrow
        .mockResolvedValueOnce({ organizations: [ORG_A, ORG_B] })
        .mockResolvedValueOnce({
          organization: { ...ORG_DETAILS, id: "org-b", slug: "beta" },
          workspaces: [WS_MAIN, WS_STAGE],
        });

      const account = await resolveLinkedAccount({
        orgSlug: "beta",
        workspaceSlug: "stage",
        isTTY: false,
      });
      expect(account.orgSlug).toBe("beta");
      expect(account.workspaceSlug).toBe("stage");
    });

    it("propagates a picker failure instead of returning a partial account", async () => {
      mockUserApiPostOrThrow.mockResolvedValueOnce({ organizations: [] });
      await expect(resolveLinkedAccount({ isTTY: true })).rejects.toThrow(
        /no organizations/i,
      );
    });
  });
});
