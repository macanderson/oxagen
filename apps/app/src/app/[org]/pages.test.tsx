// @vitest-environment jsdom
// Every route under /[org] renders between WL-08 and its page item
// (ARCHITECTURE.md §8): the gap-lane pages still waiting on their lane render
// their one UNRECORDED row under the title, and the other rev1 pages render the
// title alone. Each page names itself once from its pages.* key (§1.2), resolves
// its viewer first and renders nothing for a person requireViewer refuses.
// Fleet hands its viewer, the data source and the runs cursor to the Fleet
// feature (WL-34) and renders the cost rollup's two tiles under its title
// (#2962); the three Agents routes hand theirs, with the agent, the tab and the
// cursor the URL names, to the Agents feature (#2956); Spend hands its viewer,
// the data source and the query to its body (#2962); Skills hands its viewer,
// the data source and the cursor to its body (#3098); Steering hands its viewer,
// the data source and the query to the Steering feature (#2961); Billing hands
// its viewer, the data source, the checkout outcome and the invoices cursor to
// the Billing feature (WL-38); People renders its sections from org.members and
// API keys its table from org.apiKeys. Run gains its body in WL-35.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import {
  expectPageTitle,
  type PageModule,
  routeProps,
} from "@/test/render-page";

const {
  requireViewer,
  Billing,
  Fleet,
  Agents,
  Agent,
  AgentSource,
  Steering,
  Spend,
  FleetSpendTiles,
  OnboardingGate,
  Skills,
  SkillsLoading,
  members,
  apiKeys,
  source,
} = vi.hoisted(() => {
  const members = vi.fn();
  const apiKeys = vi.fn();
  return {
    requireViewer: vi.fn<(org: string, ws?: string) => Promise<unknown>>(),
    Billing: vi.fn((_props: Record<string, unknown>) => null),
    Fleet: vi.fn((_props: Record<string, unknown>) => null),
    Agents: vi.fn((_props: Record<string, unknown>) => null),
    Agent: vi.fn((_props: Record<string, unknown>) => null),
    AgentSource: vi.fn((_props: Record<string, unknown>) => null),
    Steering: vi.fn((props: { searchParams: Record<string, string> }) => (
      <p data-testid="steering-body" data-tab={props.searchParams.tab} />
    )),
    Spend: vi.fn((props: { searchParams: Record<string, string> }) => (
      <p data-testid="spend-body" data-tab={props.searchParams.tab} />
    )),
    FleetSpendTiles: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="fleet-spend" />
    )),
    // The gate's own states are its component test; here it only has to render.
    OnboardingGate: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="onboarding-gate" />
    )),
    Skills: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="skills-body" />
    )),
    SkillsLoading: vi.fn(() => null),
    members,
    apiKeys,
    source: { org: { members, apiKeys } },
  };
});
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/features/billing", () => ({ Billing }));
vi.mock("@/features/fleet", () => ({ Fleet }));
vi.mock("@/features/agents", () => ({ Agents, Agent, AgentSource }));
vi.mock("@/features/steering", () => ({ Steering }));
vi.mock("@/features/spend", () => ({ Spend, FleetSpendTiles }));
vi.mock("@/features/onboarding", () => ({ OnboardingGate }));
vi.mock("@/features/skills", () => ({ Skills, SkillsLoading }));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
// People is the one feature this file renders for real, so its client island
// comes with it. The island imports the two server actions, and those import
// the kernel seam, which loads both handler registries on import (§3.2) — a
// graph no page test needs and one that never settles under jsdom. The writes
// have their own tests; here the roster only has to render.
vi.mock("@/features/organization/actions", () => ({
  changeMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({});
});

/** Every segment a page under /[org] can have; each page reads the ones in its path. */
const SEGMENTS = {
  org: "acme",
  ws: "core-platform",
  run: "arun_1",
  agent: "release-bot",
};
type Load = () => Promise<PageModule<typeof SEGMENTS>>;

const ORG = ["acme"];
const WS = ["acme", "core-platform"];
const title = translator("pages");

const GAP_LANE: [string, Load][] = [
  ["tools", () => import("./[ws]/tools/page")],
];

const SKILLS: Load = () => import("./[ws]/skills/page");
const STEERING: Load = () => import("./[ws]/steering/page");

const FLEET: Load = () => import("./[ws]/page");
const AGENTS: Load = () => import("./[ws]/agents/page");
const AGENT: Load = () => import("./[ws]/agents/[agent]/page");
const AGENT_SOURCE: Load = () => import("./[ws]/agents/[agent]/source/page");
const SPEND: Load = () => import("./[ws]/spend/page");

const REV1: [string, string[], Load][] = [
  ["run", WS, () => import("./[ws]/runs/[run]/page")],
];
const API_KEYS: Load = () => import("./api-keys/page");

const BILLING: Load = () => import("./billing/page");

describe("gap-lane pages", () => {
  it.each(GAP_LANE)(
    "pages.%s resolves the workspace viewer, names the page once and renders its one NotRecorded row",
    async (key, load) => {
      await expectPageTitle(await load(), routeProps(SEGMENTS), title(key));
      expect(requireViewer).toHaveBeenCalledWith(...WS);
      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(screen.getByTestId("not-recorded")).toHaveAttribute(
        "data-section",
        key,
      );
    },
  );
});

describe("the Billing page", () => {
  it("resolves the organization viewer, names the page once and hands the viewer, the data source, the checkout outcome and the invoices cursor to Billing", async () => {
    const ctx = { orgSlug: "acme" };
    requireViewer.mockResolvedValue(ctx);
    await expectPageTitle(
      await BILLING(),
      routeProps(SEGMENTS, { checkout: "success", cursor: "c2" }),
      title("billing"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(Billing).toHaveBeenCalledOnce();
    expect(Billing.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
      checkout: "success",
      cursor: "c2",
    });
  });

  it("hands Billing no checkout outcome and the newest invoices when the URL carries neither", async () => {
    await expectPageTitle(
      await BILLING(),
      routeProps(SEGMENTS),
      title("billing"),
    );
    expect(Billing.mock.calls[0]?.[0]).toMatchObject({
      checkout: null,
      cursor: null,
    });
  });
});

describe("the Steering page", () => {
  it("resolves the workspace viewer, names the page once and hands the viewer, the data source and the query to Steering", async () => {
    const ctx = { orgSlug: "acme", wsSlug: "core-platform" };
    requireViewer.mockResolvedValue(ctx);
    await expectPageTitle(
      await STEERING(),
      routeProps(SEGMENTS, { tab: "prs", proposal: "prp_1" }),
      title("steering"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Steering).toHaveBeenCalledOnce();
    expect(Steering.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
      searchParams: { tab: "prs", proposal: "prp_1" },
    });
    expect(screen.getByTestId("steering-body")).toHaveAttribute(
      "data-tab",
      "prs",
    );
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });
});

describe("the Spend page", () => {
  it("resolves the workspace viewer, names the page once and hands its body the viewer, the data source and the query", async () => {
    const viewer = { wsSlug: "core-platform" };
    requireViewer.mockResolvedValue(viewer);
    await expectPageTitle(
      await SPEND(),
      routeProps(SEGMENTS, { tab: "waste" }),
      title("spend"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Spend.mock.calls[0]?.[0]).toEqual({
      ctx: viewer,
      source,
      searchParams: { tab: "waste" },
    });
    expect(screen.getByTestId("spend-body")).toHaveAttribute(
      "data-tab",
      "waste",
    );
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });
});

describe("the Skills page", () => {
  it("resolves the workspace viewer, names the page once under the workspace eyebrow and hands its body the viewer, the data source and the cursor", async () => {
    const viewer = { wsSlug: "core-platform", wsName: "Core platform" };
    requireViewer.mockResolvedValue(viewer);
    const page = await expectPageTitle(
      await SKILLS(),
      routeProps(SEGMENTS, { cursor: "c2" }),
      title("skills"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(page).toHaveTextContent("Workspace · Core platform");
    expect(page).toHaveTextContent(
      "Oxagen does not run a skill — the harness does.",
    );
    expect(Skills.mock.calls[0]?.[0]).toEqual({
      ctx: viewer,
      source,
      cursor: "c2",
    });
    expect(screen.getByTestId("skills-body")).toBeInTheDocument();
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("hands its body the first page when the URL names no cursor", async () => {
    await expectPageTitle(
      await SKILLS(),
      routeProps(SEGMENTS),
      title("skills"),
    );
    expect(Skills.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: null });
  });
});

describe("the Fleet page", () => {
  it("resolves the workspace viewer, names the page once and hands the viewer, the data source and the runs cursor to Fleet", async () => {
    const ctx = { wsSlug: "core-platform" };
    requireViewer.mockResolvedValue(ctx);
    await expectPageTitle(
      await FLEET(),
      routeProps(SEGMENTS, { cursor: "c2" }),
      title("fleet"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Fleet).toHaveBeenCalledOnce();
    expect(Fleet.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
      cursor: "c2",
    });
    expect(FleetSpendTiles).toHaveBeenCalledOnce();
    expect(FleetSpendTiles.mock.calls[0]?.[0]).toEqual({ ctx, source });
    expect(screen.getByTestId("fleet-spend")).toBeInTheDocument();
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("asks Fleet for the newest runs when the URL carries no cursor", async () => {
    await expectPageTitle(await FLEET(), routeProps(SEGMENTS), title("fleet"));
    expect(Fleet.mock.calls[0]?.[0]).toMatchObject({ cursor: null });
  });
});

describe("the Agents pages", () => {
  const ctx = { wsSlug: "core-platform" };
  beforeEach(() => {
    requireViewer.mockResolvedValue(ctx);
  });

  it("the identities page hands the workspace viewer, the data source and the cursor to Agents", async () => {
    await expectPageTitle(
      await AGENTS(),
      routeProps(SEGMENTS, { cursor: "c2" }),
      title("agents"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Agents.mock.calls.at(-1)?.[0]).toEqual({
      ctx,
      source,
      cursor: "c2",
    });
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("the agent page hands the agent, the tab and the cursor the URL names to Agent", async () => {
    await expectPageTitle(
      await AGENT(),
      routeProps(SEGMENTS, { tab: "incidents", cursor: "c3" }),
      title("agent"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Agent.mock.calls.at(-1)?.[0]).toEqual({
      ctx,
      source,
      agent: "release-bot",
      tab: "incidents",
      cursor: "c3",
    });
    await expectPageTitle(await AGENT(), routeProps(SEGMENTS), title("agent"));
    expect(Agent.mock.calls.at(-1)?.[0]).toMatchObject({
      tab: null,
      cursor: null,
    });
    await expectPageTitle(
      await AGENTS(),
      routeProps(SEGMENTS),
      title("agents"),
    );
    expect(Agents.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: null });
  });

  it("the source page hands the agent to AgentSource", async () => {
    await expectPageTitle(
      await AGENT_SOURCE(),
      routeProps(SEGMENTS),
      title("agentSource"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(AgentSource.mock.calls.at(-1)?.[0]).toEqual({
      ctx,
      source,
      agent: "release-bot",
    });
  });
});

describe("rev1 pages before their page item", () => {
  it.each(REV1)(
    "pages.%s resolves its viewer, names the page once and renders no body, never a NotRecorded row (negative)",
    async (key, segments, load) => {
      await expectPageTitle(await load(), routeProps(SEGMENTS), title(key));
      expect(requireViewer).toHaveBeenCalledWith(...segments);
      expect(screen.queryByTestId("not-recorded")).toBeNull();
      expect(
        screen.getByRole("main").querySelectorAll("p, table, form, ul"),
      ).toHaveLength(0);
    },
  );
});

describe("Organization › People", () => {
  it("resolves the organization viewer, names the page once and renders the roster org.members read for that viewer", async () => {
    const ctx = { orgSlug: "acme", orgRole: "owner" };
    requireViewer.mockResolvedValue(ctx);
    members.mockResolvedValue({
      ok: true,
      value: {
        members: [
          {
            id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
            name: "Marcus Bell",
            email: "marcus.bell@acme.example",
            role: "owner",
            joinedAt: "2026-03-02T09:15:00.000Z",
          },
        ],
        invitations: [],
      },
    });
    await expectPageTitle(
      await import("./page"),
      routeProps(SEGMENTS),
      title("people"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(members).toHaveBeenCalledWith(ctx);
    expect(screen.getByRole("main")).toHaveTextContent("Marcus Bell");
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });
});

describe("Organization › API keys", () => {
  it("resolves the organization viewer, names the page once and renders the keys org.apiKeys read for that viewer", async () => {
    const ctx = { orgSlug: "acme", orgRole: "owner" };
    requireViewer.mockResolvedValue(ctx);
    apiKeys.mockResolvedValue({
      ok: true,
      value: [
        {
          id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
          name: "CI runner",
          prefix: "ox_liveliveli",
          createdAt: "2026-09-13T10:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });
    await expectPageTitle(
      await API_KEYS(),
      routeProps(SEGMENTS),
      title("apiKeys"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(apiKeys).toHaveBeenCalledWith(ctx);
    expect(screen.getByRole("main")).toHaveTextContent("ox_liveliveli");
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });
});

describe("a person requireViewer refuses", () => {
  it.each([
    ...GAP_LANE.map(([key, load]) => [key, load] as const),
    ["billing", BILLING] as const,
    ["skills", SKILLS] as const,
    ["steering", STEERING] as const,
    ["fleet", FLEET] as const,
    ["agents", AGENTS] as const,
    ["agent", AGENT] as const,
    ["agentSource", AGENT_SOURCE] as const,
    ["spend", SPEND] as const,
    ...REV1.map(([key, , load]) => [key, load] as const),
    ["people", () => import("./page")] as const,
    ["apiKeys", API_KEYS] as const,
  ])("pages.%s renders nothing (negative)", async (_key, load) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      Promise.resolve((await load()).default(routeProps(SEGMENTS))),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
