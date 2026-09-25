// @vitest-environment jsdom
// The denied state a refused workspace draws inside the shell (audit-prompt
// check 22): the mock's title and permission line, the viewer's name and
// organization role, no invented policy, and a way back to a workspace the
// viewer does belong to.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { getAuthUser } = vi.hoisted(() => ({ getAuthUser: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
}));
vi.mock("@/features/auth", () => ({ getAuthUser }));
// SafeLink stays real; only the router the navigate hook reads is stood in.
vi.mock("@/ui/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/navigation")>()),
  useNavigate: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WorkspaceDenied } = await import("./workspace-denied");

const ctx = unsafeMint(OrgCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
});

type ShellPort = Pick<DataSource, "shell">;

function sourceWith(
  context: Awaited<ReturnType<ShellPort["shell"]["context"]>>,
): ShellPort {
  const unread = () => Promise.reject(new Error("not read by this state"));
  return {
    shell: {
      context: vi.fn(() => Promise.resolve(context)),
      preferences: unread,
      counts: unread,
      notifications: unread,
      assistantEngine: unread,
    },
  };
}

async function draw(source: ShellPort) {
  const element: ReactElement = await WorkspaceDenied({
    ctx,
    ws: "finops",
    source,
  });
  render(<IntlProvider>{element}</IntlProvider>);
}

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

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
      "policy not recorded · deny wins over every allow",
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
