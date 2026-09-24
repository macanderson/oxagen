// @vitest-environment jsdom
// The gate's later steps over a fake DataSource: who may see Wrap an agent and
// Start a run (an org Owner or Admin, checked before anything is read), which
// agent the steps enrol, the wait for the first frame, the silent host that is
// the run step's error state, and the installer's screens in the auth shell.
// Axe runs after every test.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { renderPage } from "@/test/render-page";
import { agentDetail } from "../agents/agents.builders";
import {
  firstFrame,
  onboardingGate,
  onboardingSource,
} from "./onboarding.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("./actions", () => ({
  createOrganizationAction: vi.fn(),
  registerAgent: vi.fn(),
  issueEnrollmentToken: vi.fn(),
  advanceOnboarding: vi.fn(),
  bindMainRepository: vi.fn(),
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: () =>
    Promise.resolve({ name: "Marcus Bell", email: "marcus@acme.example" }),
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WelcomeInstaller, WelcomeRun, WelcomeWrap } = await import("./welcome");

function ctxAs(orgRole: "owner" | "admin" | "member") {
  return unsafeMint(WsCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "owner",
  });
}

const NOW = Date.parse("2026-09-15T14:02:30.000Z");

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("who may see the gate's later steps", () => {
  it("shows a member the denied state on Wrap an agent and reads nothing (negative)", async () => {
    const { source, calls } = onboardingSource({});
    const element = await WelcomeWrap({
      ctx: ctxAs("member"),
      source,
      agent: "agt_releasebot",
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "You cannot see onboarding",
    );
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "enrollment.create on core-platform",
    );
    expect(screen.getByTestId("gate-email")).toHaveTextContent(
      "marcus@acme.example",
    );
    expect(calls.agent).toEqual([]);
    expect(calls.state).toEqual([]);
  });

  it("shows a member the denied state on Start a run and reads nothing (negative)", async () => {
    const { source, calls } = onboardingSource({});
    const element = await WelcomeRun({
      ctx: ctxAs("member"),
      source,
      agent: "agt_releasebot",
      now: NOW,
      pollRevision: "rev_1",
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "repo.bind on core-platform",
    );
    expect(calls.firstFrame).toEqual([]);
  });
});

describe("Wrap an agent", () => {
  it("reads the named agent and the gate, and draws the rail with step 2 current", async () => {
    const { source, calls } = onboardingSource({
      state: readOk(onboardingGate()),
      agent: readOk(agentDetail()),
    });
    const element = await WelcomeWrap({
      ctx: ctxAs("admin"),
      source,
      agent: "agt_releasebot",
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(calls.agent).toEqual([[ctxAs("admin"), "agt_releasebot"]]);
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Wrap an agent" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("wrap-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("page-state-denied")).toBeNull();
  });
});

describe("Start a run", () => {
  it("waits for the first frame while the enrolled host is still heartbeating", async () => {
    const { source, calls } = onboardingSource({
      state: readOk(onboardingGate({ step: "run" })),
      agent: readOk(agentDetail()),
      firstFrame: readOk(firstFrame()),
    });
    const element = await WelcomeRun({
      ctx: ctxAs("owner"),
      source,
      agent: "agt_releasebot",
      now: NOW,
      pollRevision: "rev_1",
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(calls.firstFrame).toHaveLength(1);
    expect(screen.getByTestId("first-frame-waiting")).toBeInTheDocument();
    expect(screen.queryByTestId("first-frame-error")).toBeNull();
    expect(screen.getByTestId("repo-detected")).toBeInTheDocument();
  });

  it("reads a host silent for longer than the heartbeat window as the error state", async () => {
    const { source } = onboardingSource({
      state: readOk(onboardingGate({ step: "run" })),
      agent: readOk(agentDetail()),
      firstFrame: readOk(firstFrame()),
    });
    const element = await WelcomeRun({
      ctx: ctxAs("owner"),
      source,
      agent: "agt_releasebot",
      now: NOW + 10 * 60_000,
      pollRevision: "rev_2",
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("first-frame-error")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-detected")).toBeNull();
  });
});

describe("the installer's screens", () => {
  it("renders the Download screen in the auth shell with no rail", async () => {
    const { source } = onboardingSource({
      state: readOk(onboardingGate()),
      agent: readOk(agentDetail()),
    });
    const element = await WelcomeInstaller({
      ctx: ctxAs("owner"),
      source,
      agent: "agt_releasebot",
    });
    // The auth shell's brandmark is an async Server Component, so the page is
    // prerendered rather than mounted.
    await renderPage(element);
    expect(screen.getByTestId("installer-download")).toBeInTheDocument();
    expect(screen.queryByTestId("gate-rail")).toBeNull();
  });
});
