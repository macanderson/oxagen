// @vitest-environment jsdom
// Create the first workspace, onboarding step 3, over a fake DataSource: who
// may see it (an org Owner or Admin, checked before anything is read), the
// name form while the organization has no live workspace, the steering repo's
// provisioning once one exists, the failed read that keeps the form under an
// alert, a failed steering repo read that still lets the person continue, and
// the line a GitHub install leaves behind. The steering-repo lane is stubbed
// at its barrel, so these tests pin what this step hands it. Axe runs after
// every test.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";
import { readError } from "@/data/read";
import type { SteeringRepoRead } from "@/features/steering-repo";
import type { WsCtx as WsCtxType } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { onboardingSource, workspaceList } from "./onboarding.builders";

const mocks = vi.hoisted(() => ({
  requireViewer: vi.fn<(org: string, ws: string) => Promise<WsCtxType>>(),
  readSteeringRepo:
    vi.fn<
      (source: DataSource, ctx: WsCtxType) => Promise<SteeringRepoRead>
    >(),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({ createFirstWorkspace: vi.fn() }));
vi.mock("@/features/steering-repo", () => ({
  readSteeringRepo: mocks.readSteeringRepo,
  SteeringRepoProvisioning: ({
    org,
    ws,
    view,
    canAct,
    returnTo,
  }: {
    org: string;
    ws: string | null;
    view: { status: string };
    canAct: boolean;
    returnTo: string;
  }) => (
    <section
      data-testid="steering-repo-provisioning"
      data-org={org}
      data-ws={ws ?? ""}
      data-status={view.status}
      data-can-act={String(canAct)}
      data-return-to={returnTo}
    />
  ),
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: () =>
    Promise.resolve({ name: "Marcus Bell", email: "marcus@acme.example" }),
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer: mocks.requireViewer,
}));

const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WelcomeFirstWorkspace } = await import("./first-workspace");

const ORG = {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
};

function ctxAs(orgRole: "owner" | "admin" | "member") {
  return unsafeMint(OrgCtx, { ...ORG, orgRole });
}

const WS_CTX = unsafeMint(WsCtx, {
  ...ORG,
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "owner",
});

const PROVISIONING: SteeringRepoRead = {
  kind: "ok",
  view: {
    status: "provisioning",
    step: "create_repository",
    failedStep: null,
    error: null,
    provider: "github",
    repository: null,
    publishedVersion: null,
    health: null,
    differences: [],
    legacySource: null,
    connection: null,
    requestedName: null,
    connectionChoices: [],
    importRun: null,
  },
};

const CORE = { slug: "core-platform", name: "Core platform" };

function rail() {
  return [
    ...screen
      .getByTestId("gate-rail")
      .querySelectorAll<HTMLElement>("li[data-step]"),
  ].map((li) => [li.dataset.step, li.dataset.state]);
}

beforeEach(() => {
  mocks.requireViewer.mockReset();
  mocks.readSteeringRepo.mockReset();
  mocks.requireViewer.mockResolvedValue(WS_CTX);
  mocks.readSteeringRepo.mockResolvedValue(PROVISIONING);
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Create the first workspace", () => {
  it("asks for a name when the organization has no workspace, and reads no steering repo", async () => {
    const { source, calls } = onboardingSource({
      workspaces: workspaceList([]),
    });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("owner"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByText("Step 3 of 5")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Create the first workspace",
      }),
    ).toBeInTheDocument();
    expect(rail()).toEqual([
      ["organization", "done"],
      ["connect", "done"],
      ["workspace", "current"],
      ["wrap", "todo"],
      ["run", "todo"],
    ]);
    expect(screen.getByLabelText("Workspace name")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      routes.welcomeConnect("acme"),
    );
    expect(calls.workspaces).toHaveLength(1);
    expect(mocks.requireViewer).not.toHaveBeenCalled();
    expect(mocks.readSteeringRepo).not.toHaveBeenCalled();
    expect(screen.queryByTestId("first-workspace-read-failed")).toBeNull();
    expect(screen.queryByTestId("workspace-continue")).toBeNull();
  });

  it("asks for a name when every workspace is archived or holds no role for the viewer", async () => {
    const { source } = onboardingSource({
      workspaces: workspaceList([
        { ...CORE, archivedAt: "2026-09-01T00:00:00.000Z" },
        { slug: "platform-ops", name: "Platform ops", role: null },
      ]),
    });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("admin"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByLabelText("Workspace name")).toBeInTheDocument();
    expect(mocks.requireViewer).not.toHaveBeenCalled();
    expect(screen.queryByTestId("steering-repo-provisioning")).toBeNull();
  });

  it("shows the first live workspace's steering repo being provisioned, and continues to Wrap an agent", async () => {
    const { source } = onboardingSource({
      workspaces: workspaceList([
        {
          slug: "old-lab",
          name: "Old lab",
          archivedAt: "2026-09-01T00:00:00.000Z",
        },
        CORE,
        { slug: "platform-ops", name: "Platform ops" },
      ]),
    });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("owner"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(
      screen.getByRole("heading", { level: 1, name: "Your first workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Oxagen provisions the steering repo for Core platform on the code host you connected.",
      ),
    ).toBeInTheDocument();
    expect(mocks.requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(mocks.readSteeringRepo).toHaveBeenCalledWith(source, WS_CTX);
    const provisioning = screen.getByTestId("steering-repo-provisioning");
    expect(provisioning).toHaveAttribute("data-org", "acme");
    expect(provisioning).toHaveAttribute("data-ws", "core-platform");
    expect(provisioning).toHaveAttribute("data-status", "provisioning");
    expect(provisioning).toHaveAttribute("data-can-act", "true");
    expect(provisioning).toHaveAttribute(
      "data-return-to",
      routes.welcomeFirstWorkspace("acme"),
    );
    expect(screen.getByTestId("workspace-continue")).toHaveAttribute(
      "href",
      routes.welcome("acme", "core-platform", "wrap"),
    );
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
  });

  it("names the code a failed steering repo read answered, and still continues (negative)", async () => {
    mocks.readSteeringRepo.mockResolvedValueOnce({
      kind: "failed",
      failure: readError("installation_unreachable", 503),
    });
    const { source } = onboardingSource({ workspaces: workspaceList([CORE]) });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("owner"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    const failure = document.querySelector("[data-reason]");
    expect(failure).toHaveAttribute("data-reason", "error");
    expect(failure).toHaveTextContent(
      "Steering repo could not be loaded: the control plane answered installation_unreachable. Nothing was changed, and runs kept recording.",
    );
    expect(screen.queryByTestId("steering-repo-provisioning")).toBeNull();
    expect(screen.getByTestId("workspace-continue")).toBeInTheDocument();
  });

  it("names the permission a denied steering repo read needed, and still continues (negative)", async () => {
    mocks.readSteeringRepo.mockResolvedValueOnce({
      kind: "failed",
      failure: { ok: false, reason: "denied", permission: "repository.read" },
    });
    const { source } = onboardingSource({ workspaces: workspaceList([CORE]) });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("owner"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    const failure = document.querySelector("[data-reason]");
    expect(failure).toHaveAttribute("data-reason", "denied");
    expect(failure).toHaveTextContent(
      "You cannot see Steering repo in this workspace. Your roles do not include repository.read. An organization owner can grant it.",
    );
    expect(screen.queryByTestId("steering-repo-provisioning")).toBeNull();
    expect(screen.getByTestId("workspace-continue")).toBeInTheDocument();
  });

  it("shows a member the denied state and reads nothing (negative)", async () => {
    const { source, calls } = onboardingSource({
      workspaces: workspaceList([CORE]),
    });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("member"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "workspace.create on acme",
    );
    expect(calls.workspaces).toHaveLength(0);
    expect(mocks.requireViewer).not.toHaveBeenCalled();
    expect(mocks.readSteeringRepo).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
  });

  it("keeps the form under an alert naming the code when the workspace list fails (negative)", async () => {
    const { source } = onboardingSource({
      workspaces: readError("org_store_unavailable", 503),
    });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("owner"),
      source,
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("first-workspace-read-failed")).toHaveTextContent(
      "The workspace list did not load (org_store_unavailable). Reload the page before you create one.",
    );
    expect(screen.getByLabelText("Workspace name")).toBeInTheDocument();
    expect(mocks.requireViewer).not.toHaveBeenCalled();
  });

  it("shows the line the GitHub install left in the query", async () => {
    const { source } = onboardingSource({ workspaces: workspaceList([CORE]) });
    const element = await WelcomeFirstWorkspace({
      ctx: ctxAs("owner"),
      source,
      result: { kind: "connected" },
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("steering-connected")).toHaveTextContent(
      "GitHub is connected.",
    );
  });
});
