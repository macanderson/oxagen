// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { orgSource } from "./organization.builders";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("./invite-dialog", () => ({
  InviteDialog: ({
    after,
    pendingIds,
  }: {
    after: string;
    pendingIds: readonly string[];
  }) => (
    <button
      type="button"
      data-after={after}
      data-pending={pendingIds.join(",")}
    >
      Invite
    </button>
  ),
}));
vi.mock("./workspace-actions", () => ({
  CreateWorkspace: ({ org, primary }: { org: string; primary?: boolean }) => (
    <button type="button" data-org={org} data-primary={String(primary)}>
      Create workspace
    </button>
  ),
}));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { OrganizationHeader } = await import("./header");

afterEach(cleanup);

async function renderHeader(role: OrgRole, failed = false) {
  const ctx = unsafeMint(OrgCtx, {
    userId: "usr_operator",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: role,
  });
  const { source, calls } = orgSource({
    members: failed
      ? readError("control_plane_unavailable", 503)
      : readOk({
          members: [],
          invitations: [
            {
              id: "invi_pending",
              email: "new@acme.example",
              role: "member",
              invitedAt: "2026-09-22T00:00:00Z",
              expiresAt: null,
            },
          ],
        }),
  });
  const view = render(
    <IntlProvider>{await OrganizationHeader({ ctx, source })}</IntlProvider>,
  );
  await expectNoAxe(view.container);
  return { calls, ctx };
}

describe("Organization header", () => {
  it.each(["owner", "admin"] as const)(
    "names the organization and offers its authorized actions to %s",
    async (role) => {
      const { calls, ctx } = await renderHeader(role);
      expect(
        screen.getByRole("heading", { level: 1, name: "Acme Robotics" }),
      ).toBeInTheDocument();
      expect(calls.members).toEqual([[ctx]]);
      const invite = screen.getByRole("button", { name: "Invite" });
      expect(invite).toHaveAttribute("data-after", "/acme?tab=invitations");
      expect(invite).toHaveAttribute("data-pending", "invi_pending");
      const workspace = screen.getByRole("button", {
        name: "Create workspace",
      });
      expect(workspace).toHaveAttribute("data-org", "acme");
      expect(workspace).toHaveAttribute("data-primary", "true");
    },
  );

  it.each(["member", "viewer", "billing", "compliance"] as const)(
    "does not read the roster or offer membership writes to %s",
    async (role) => {
      const { calls } = await renderHeader(role);
      expect(
        screen.getByRole("heading", { level: 1, name: "Acme Robotics" }),
      ).toBeInTheDocument();
      expect(calls.members).toEqual([]);
      expect(screen.queryAllByRole("button")).toEqual([]);
    },
  );

  it("withholds Invite when its pending roster is unreadable but retains workspace creation", async () => {
    await renderHeader("owner", true);
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create workspace" }),
    ).toBeInTheDocument();
  });
});
