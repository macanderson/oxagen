// @vitest-environment jsdom
// The invitation page has two titles (ARCHITECTURE.md §1.2): pages.invitation
// when the token resolves and pages.invitationNotFound otherwise, the same in
// generateMetadata and the h1. The decision states are views.test.tsx's.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvitationView } from "@/data/contracts/invitations";
import type { Read } from "@/data/read";
import { translator } from "@/test/intl";
import { expectPageTitle, routeProps } from "@/test/render-page";

const { loadInvitation } = vi.hoisted(() => ({
  loadInvitation: vi.fn<(token: string) => Promise<Read<InvitationView>>>(),
}));
vi.mock("next/server", () => ({ connection: () => Promise.resolve() }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<typeof import("@/features/auth/invitation")>(
    "@/features/auth/invitation",
  )),
  loadInvitation,
  getAuthUser: () => Promise.resolve(null),
  InvitationBody: () => <section data-testid="invite-body" />,
  InvitationNotFound: () => <section data-testid="invite-not-found" />,
}));

const page = await import("./page");
const TOKEN = "inv_a1b2c3";
const pages = translator("pages");

const invitation: InvitationView = {
  token: TOKEN,
  orgName: "Anderson Intelligence Corp.",
  orgSlug: "a-intel",
  email: "marcus@a-intel.com",
  role: "member",
  status: "pending",
  invitedAt: "2026-09-10T12:00:00.000Z",
  expiresAt: null,
};

beforeEach(() => {
  loadInvitation.mockReset();
});

describe("/invite/[token]", () => {
  it("names a resolved invitation after its organization, in the tab and the h1", async () => {
    loadInvitation.mockResolvedValue({ ok: true, value: invitation });
    await expectPageTitle(
      page,
      routeProps({ token: TOKEN }),
      pages("invitation", { org: "Anderson Intelligence Corp." }),
    );
    expect(loadInvitation).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByTestId("invite-body")).toBeInTheDocument();
  });

  it("names a token that resolves to nothing as not found, in the tab and the h1 (negative)", async () => {
    loadInvitation.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "invitation_not_found",
      status: 404,
    });
    await expectPageTitle(
      page,
      routeProps({ token: TOKEN }),
      pages("invitationNotFound"),
    );
    expect(screen.getByTestId("invite-not-found")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-body")).toBeNull();
  });
});
