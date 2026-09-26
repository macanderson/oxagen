// @vitest-environment jsdom
// The agent page names its agent for the assistant. `<PageRecord>` carries
// the id the URL names and the name the agent was registered with, so a
// question asked on the page reaches the turn with the agent's label. The
// shell's component is swapped for one that draws its props where a test can
// read them. The real one draws nothing and writes the store the flyout reads,
// which `assistant-flyout.page-label.test.tsx` covers.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList } from "@/test/mandate-views";
import {
  agentDetail,
  agentsSource,
  incident,
  incidentPage,
  roleCatalog,
  runPage,
  runRow,
  spendBudgets,
  spendFindings,
  spendReport,
  spendRow,
  steeringDeliveries,
  toolbelt,
} from "./agents.builders";

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
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
  pauseAgent: vi.fn(),
  readAssignableRoles: vi.fn(),
  assignAgentRole: vi.fn(),
  revokeAgentRole: vi.fn(),
  readCostCenters: vi.fn(),
  setAgentCostCenter: vi.fn(),
  revokeHostEnrollment: vi.fn(),
  issueAgentEnrollmentToken: vi.fn(),
  moveAgent: vi.fn(),
  assignAgentToolbelt: vi.fn(),
  requestMandate: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/features/shell/client", () => ({
  chooseToolPatterns: vi.fn(() =>
    Promise.resolve({ ok: true, value: { options: [], partial: false } }),
  ),
}));
// The rest of the shell's surface is the real one, so this file also proves
// the page's import of it loads.
vi.mock("@/features/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/shell")>()),
  PageRecord: (props: {
    route: string;
    id: string | null;
    label?: string | null;
  }) => (
    <span
      data-testid="page-record"
      data-route={props.route}
      data-id={props.id ?? undefined}
      data-label={props.label ?? undefined}
    />
  ),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Agent } = await import("./agent");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

type Reads = Parameters<typeof agentsSource>[0];

async function renderAgent(agent: string, reads: Reads = {}) {
  const { source } = agentsSource({
    get: readOk(agentDetail()),
    toolbelt: readOk(toolbelt()),
    mandates: mandateList([]),
    incidents: incidentPage([incident()]),
    runs: runPage([runRow()]),
    spend: spendReport([spendRow()]),
    deliveries: steeringDeliveries(),
    findings: spendFindings([{}]),
    budgets: readOk(spendBudgets()),
    roles: roleCatalog(),
    ...reads,
  });
  const element = await Agent({ ctx, source, agent, tab: null, cursor: null });
  render(<IntlProvider>{element}</IntlProvider>);
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Agent page › the record it declares", () => {
  it("names the agent by the id the URL names and its registered name", async () => {
    await renderAgent("release-bot");
    const record = screen.getByTestId("page-record");
    expect(record).toHaveAttribute("data-route", "agents");
    expect(record).toHaveAttribute("data-id", "release-bot");
    expect(record).toHaveAttribute("data-label", "Release bot");
  });

  it("keeps the URL's form of the id, so the flyout sends the id it always sent", async () => {
    await renderAgent("agt_releasebot");
    expect(screen.getByTestId("page-record")).toHaveAttribute(
      "data-id",
      "agt_releasebot",
    );
  });

  // A refused identity read replaces the page with its failure state, and
  // that state names no agent, so there is no label to declare.
  it("declares nothing when the agent could not be read (negative)", async () => {
    await renderAgent("release-bot", {
      get: readError("registry_unreachable", 502),
    });
    expect(screen.queryByTestId("page-record")).toBeNull();
  });
});
