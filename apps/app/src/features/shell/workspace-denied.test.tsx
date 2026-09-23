// @vitest-environment jsdom
// The denied state a refused workspace draws inside the shell (audit-prompt
// check 22): the mock's title and permission line, the viewer's name and
// organization role, no invented policy, and a way back to a workspace the
// viewer does belong to.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { IntlProvider, translator } from "@/test/intl";

const { getAuthUser } = vi.hoisted(() => ({ getAuthUser: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
}));
vi.mock("@/features/auth", () => ({ getAuthUser }));
vi.mock("@/ui/navigation", () => ({
  SafeLink: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { WorkspaceDenied } from "./workspace-denied";

const ctx = {
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
} as never;

function sourceWith(
  context: Awaited<ReturnType<typeof readOk>> | ReturnType<typeof readError>,
) {
  return {
    shell: {
      context: vi.fn(() => Promise.resolve(context)),
      preferences: vi.fn(),
      counts: vi.fn(),
      notifications: vi.fn(),
    },
  } as never;
}

async function draw(source: never) {
  const element: ReactElement = await WorkspaceDenied({
    ctx,
    ws: "finops",
    source,
  });
  render(<IntlProvider>{element}</IntlProvider>);
}

afterEach(cleanup);

describe("WorkspaceDenied", () => {
  it("names the workspace permission, the viewer and a way back to Fleet", async () => {
    getAuthUser.mockResolvedValue({
      name: "Priya Natarajan",
      email: "p@acme.example",
    });
    await draw(
      sourceWith(
        readOk({
          orgs: [],
          workspaces: [{ slug: "core-platform", name: "Core platform" }],
        }),
      ),
    );
    expect(
      screen.getByRole("heading", { name: "You cannot see this workspace" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("workspace.read on finops").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Priya Natarajan/)).toBeTruthy();
    expect(screen.getByText("org.member")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to Fleet" }).getAttribute("href"),
    ).toBe("/acme/core-platform");
    expect(screen.getByTestId("page-denied-decided-by").textContent).toBe(
      "The refusal does not record which policy decided it.",
    );
  });

  it("goes back to the organization when the viewer's workspaces cannot be read (negative)", async () => {
    getAuthUser.mockResolvedValue({ name: "", email: "p@acme.example" });
    await draw(sourceWith(readError("control_plane_unavailable", 503)));
    expect(
      screen.getByRole("link", { name: "Back to Fleet" }).getAttribute("href"),
    ).toBe("/acme");
    expect(screen.getByText(/p@acme\.example/)).toBeTruthy();
  });
});
