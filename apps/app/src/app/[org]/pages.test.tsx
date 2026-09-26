// @vitest-environment jsdom
// Every route under /[org] renders between WL-08 and its page item
// (ARCHITECTURE.md §8): every page renders its title, and the one that still
// waits on its lane would render its UNRECORDED row under it. Each page names itself once from its pages.* key (§1.2), resolves
// its viewer first and renders nothing for a person requireViewer refuses.
// Fleet hands its viewer, the data source and the runs cursor to the Fleet
// feature (WL-34) and renders the cost rollup's two tiles under its title
// (#2962); the three Agents routes hand theirs, with the agent, the tab and the
// cursor the URL names, to the Agents feature (#2956); Spend hands its viewer,
// the data source and the query to its body (#2962); the Skills route moves a
// member to the Skills tab of Steering with its cursor; Steering hands its viewer,
// the data source and the query to the Steering feature (#2961); Tools hands
// theirs, with the tab and the chips the URL names, to the Tools feature
// (#2958); Billing hands
// its viewer, the data source, the checkout outcome and the invoices cursor to
// the Billing feature (WL-38); Organization, Roles and API keys hand their
// viewer, the data source and the tab or the keys' workspace to the
// Organization feature (pages/organization.md); Run hands its viewer, the data source, the
// run id and the tab, chips and frames cursor the URL carries to the Run feature
// (WL-35).
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import {
  expectPageTitle,
  type PageModule,
  type RouteProps,
  renderPage,
  routeProps,
} from "@/test/render-page";

const {
  requireViewer,
  Audit,
  Billing,
  Fleet,
  Run,
  Agents,
  Agent,
  AgentSource,
  Steering,
  Spend,
  Organization,
  OrganizationRoles,
  OrganizationApiKeys,
  OrganizationModelFunding,
  OnboardingGate,
  Skills,
  SkillsLoading,
  Tools,
  ToolsLoading,
  Runtimes,
  workspaces,
  source,
  cookieJar,
} = vi.hoisted(() => {
  const workspaces = vi.fn();
  return {
    requireViewer: vi.fn<(org: string, ws?: string) => Promise<unknown>>(),
    Audit: vi.fn((_props: Record<string, unknown>) => null),
    // Billing draws its own header (a not-loaded state replaces it), so the
    // stand-in draws the h1 from the title the route hands it.
    Billing: vi.fn((props: Record<string, unknown>) => (
      <h1>{String(props.title)}</h1>
    )),
    // Fleet draws its own h1 (so a not-loaded state can replace the whole
    // body); the stand-in draws the same one and the banners it is handed.
    Fleet: vi.fn((props: Record<string, unknown> & { banners?: ReactNode }) => (
      <>
        <h1>Fleet</h1>
        {props.banners}
      </>
    )),
    // Agents draws the page header only when it has agents to list, so the
    // stub draws the header it is handed.
    Agents: vi.fn((props: { header?: ReactNode }) => <>{props.header}</>),
    Agent: vi.fn((_props: Record<string, unknown>) => null),
    AgentSource: vi.fn((_props: Record<string, unknown>) => null),
    Steering: vi.fn(
      (props: {
        view: { tab: string };
        header: (actions: ReactNode) => ReactNode;
      }) => (
        <>
          {props.header(<span data-testid="steering-actions" />)}
          <p data-testid="steering-body" data-tab={props.view.tab} />
        </>
      ),
    ),
    Spend: vi.fn((props: { view: { tab: string } }) => (
      <p data-testid="spend-body" data-tab={props.view.tab} />
    )),
    Run: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="run-body" />
    )),
    Organization: vi.fn((_props: Record<string, unknown>) => null),
    OrganizationRoles: vi.fn((_props: Record<string, unknown>) => null),
    OrganizationApiKeys: vi.fn((_props: Record<string, unknown>) => null),
    OrganizationModelFunding: vi.fn((_props: Record<string, unknown>) => null),
    // The gate's own states are its component test; here it only has to render.
    OnboardingGate: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="onboarding-gate" />
    )),
    Skills: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="skills-body" />
    )),
    SkillsLoading: vi.fn(() => null),
    Tools: vi.fn((props: { tab: string }) => (
      <p data-testid="tools-body" data-tab={props.tab} />
    )),
    ToolsLoading: vi.fn(() => null),
    // Runtimes draws its own header (its error and access-denied states
    // replace the body with the header included), so the stand-in draws it.
    Runtimes: vi.fn((_props: Record<string, unknown>) => <h1>Runtimes</h1>),
    workspaces,
    source: { org: { workspaces } },
    cookieJar: new Map<string, string>(),
  };
});
// `WsCtx.is` is how the API keys section tells a workspace scope from an
// organization one (ADR-073); the viewer classes are branded, so the stub
// stands in for the brand with the field these fixtures carry.
vi.mock("@/server/viewer", () => ({
  requireViewer,
  WsCtx: {
    is: (x: unknown) => typeof x === "object" && x !== null && "wsSlug" in x,
  },
}));
vi.mock("@/features/audit", async (actual) => ({
  Audit,
  AuditSkeleton: () => null,
  AuditHeaderAction: ({ org }: { org: string }) => (
    <p data-testid="audit-header-action">{org}</p>
  ),
  AuditRetentionLine: () => <p data-testid="audit-retention-line" />,
  auditTabOf: (await actual<typeof import("@/features/audit")>()).auditTabOf,
}));
vi.mock("@/features/billing", () => ({ Billing }));
// Billing names the signed-in person on its denied state; the session is Better
// Auth's, so the stub answers with the name alone.
vi.mock("@/server/session", () => ({
  getAuthUser: () => Promise.resolve({ name: "Marcus Bell" }),
}));
// The page parses the saved table choice with Fleet's own reader, so the stand-in
// keeps the real one: a cookie the reader refuses must reach Fleet as defaults.
vi.mock("@/features/fleet", async () => {
  const prefs = await vi.importActual<Record<string, unknown>>(
    "@/features/fleet/prefs",
  );
  const listQuery = await vi.importActual<Record<string, unknown>>(
    "@/features/fleet/list-query",
  );
  return {
    Fleet,
    FLEET_PREFS_COOKIE: prefs.FLEET_PREFS_COOKIE,
    readFleetPrefs: prefs.readFleetPrefs,
    pullRequestFilterOf: prefs.pullRequestFilterOf,
    parseListQuery: listQuery.parseListQuery,
  };
});
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));
vi.mock("@/features/run", () => ({ Run }));
vi.mock("@/features/runtimes", () => ({
  Runtimes,
  Runtime: () => null,
  RuntimesLoading: () => null,
}));
vi.mock("@/features/agents", () => ({
  Agents,
  AgentsLoading: () => null,
  Agent,
  AgentSource,
  AgentsCreate: () => null,
}));
// The view parser and link builder stay real: the route redirects a legacy
// `?tab=` URL to its path segment with them.
vi.mock("@/features/steering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/steering")>()),
  Steering,
  SteeringCreate: (props: { searchParams: Record<string, string> }) => (
    <p data-testid="steering-create" data-tab={props.searchParams.tab} />
  ),
}));
vi.mock("@/features/spend", async () => ({
  // The real parser: the route's 404 is its answer, not the mock's.
  parseSpendView: (await import("@/features/spend/view")).parseSpendView,
  Spend,
}));
// The three Organization bodies are stubbed to show what each route hands
// them; the frame, the tabs and the states have their own tests
// (features/organization/frame.test.tsx).
vi.mock("@/features/organization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/organization")>()),
  Organization,
  OrganizationRoles,
  OrganizationApiKeys,
  OrganizationModelFunding,
}));
vi.mock("@/features/onboarding", () => ({ OnboardingGate }));
vi.mock("@/features/skills", () => ({ Skills, SkillsLoading }));
vi.mock("@/features/tools", async (load) => ({
  ...(await load<typeof import("@/features/tools")>()),
  Tools,
  ToolsLoading,
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
// People and API keys are the features this file renders for real, so their
// client islands come with them. Each island imports its server actions, and
// those import the kernel seam, which loads both handler registries on import
// (§3.2) — a graph no page test needs and one that never settles under jsdom.
// The writes have their own tests; here the roster and the table only have to
// render.
vi.mock("@/features/organization/actions", () => ({
  changeMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
}));
vi.mock("@/features/organization/api-key-actions", () => ({
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  // The Spend and Repositories routes answer a segment they do not know with
  // Next's 404, which throws, as Next's does.
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The Skills route only moves to the Steering tab, and the Steering route moves
// a legacy `?tab=` URL to its path; each redirect throws, as Next's does, with
// the target in its message.
vi.mock("@/shared/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/navigation")>()),
  redirectTo: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
  permanentRedirectTo: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({});
  workspaces.mockReset();
  cookieJar.clear();
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

/** A redirect with no title of its own, so not a `Load`. */
const SKILLS = () => import("./[ws]/skills/page");
const SKILLS_VIEW = () => import("./[ws]/skills/[...rest]/page");
const TOOLS: Load = () => import("./[ws]/tools/[[...tab]]/page");
const STEERING: Load = () => import("./[ws]/steering/page");
const STEERING_VIEW = () => import("./[ws]/steering/[...view]/page");

const FLEET: Load = () => import("./[ws]/(fleet)/page");
const AGENTS: Load = () => import("./[ws]/agents/page");
const AGENT: Load = () => import("./[ws]/agents/[agent]/page");
const AGENT_SOURCE: Load = () => import("./[ws]/agents/[agent]/source/page");
/** The agent page with its tab as a path segment; its params carry `tab`. */
const AGENT_TAB = () => import("./[ws]/agents/[agent]/[tab]/page");
const SPEND: Load = () => import("./[ws]/spend/[[...tab]]/page");
const RUNTIMES: Load = () => import("./[ws]/runtimes/page");

const RUN: Load = () => import("./[ws]/runs/[run]/page");
const API_KEYS: Load = () => import("./api-keys/page");

const BILLING: Load = () => import("./billing/page");
const AUDIT: Load = () => import("./audit/page");
const AUDIT_TAB = () => import("./audit/[tab]/page");

describe("the Tools page", () => {
  it("resolves the workspace viewer and hands the viewer, the data source, the tab the path names and the query to Tools", async () => {
    const viewer = { wsSlug: "core-platform", wsName: "Core platform" };
    requireViewer.mockResolvedValue(viewer);
    const page = await TOOLS();
    await renderPage(
      await page.default({
        params: Promise.resolve({ ...SEGMENTS, tab: ["switches"] }),
        searchParams: Promise.resolve({ names: "api" }),
      }),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Tools).toHaveBeenCalledOnce();
    expect(Tools.mock.calls[0]?.[0]).toEqual({
      ctx: viewer,
      source,
      tab: "switches",
      searchParams: { names: "api" },
    });
    expect(screen.getByTestId("tools-body")).toHaveAttribute(
      "data-tab",
      "switches",
    );
    // Tools has a page, so the UNRECORDED row it used to render is gone (§3.6).
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("names itself pages.tools in the document title", async () => {
    const page = await TOOLS();
    expect(await page.generateMetadata(routeProps(SEGMENTS))).toEqual({
      title: title("tools"),
    });
  });

  it("lands the old servers tab and a pre-rev1 ?tab= on the tab that absorbed each", async () => {
    const page = await TOOLS();
    await renderPage(
      await page.default({
        params: Promise.resolve({ ...SEGMENTS, tab: ["servers"] }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(Tools.mock.calls.at(-1)?.[0]).toMatchObject({ tab: "providers" });
    await renderPage(
      await page.default({
        params: Promise.resolve(SEGMENTS),
        searchParams: Promise.resolve({ tab: "autoapprovals" }),
      }),
    );
    expect(Tools.mock.calls.at(-1)?.[0]).toMatchObject({ tab: "policy" });
  });

  it("answers a path deeper than one tab with a 404 before resolving anyone (negative)", async () => {
    const page = await TOOLS();
    await expect(
      Promise.resolve(
        page.default({
          params: Promise.resolve({ ...SEGMENTS, tab: ["providers", "x"] }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).rejects.toThrow();
    expect(requireViewer).not.toHaveBeenCalled();
  });
});

describe("the Audit page", () => {
  it("resolves the organization viewer, names the page once with its gold action and hands the viewer, the data source, the Events tab and the filters the URL carries to Audit", async () => {
    const ctx = { orgSlug: "acme" };
    requireViewer.mockResolvedValue(ctx);
    const page = await expectPageTitle(
      await AUDIT(),
      routeProps(SEGMENTS, { outcome: "deny", offset: "50" }),
      title("audit"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(Audit).toHaveBeenCalledOnce();
    expect(Audit.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
      tab: "events",
      searchParams: { outcome: "deny", offset: "50" },
    });
    expect(page).toHaveTextContent(
      "What happened, who allowed it, under what authority, and what it cost.",
    );
    expect(screen.getByTestId("audit-retention-line")).toBeInTheDocument();
    expect(screen.getByTestId("audit-header-action")).toHaveTextContent("acme");
    // Audit has a page, so it has no UNRECORDED row (§3.6).
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("opens another tab from its segment, under the same header, with the query it carries", async () => {
    const ctx = { orgSlug: "acme" };
    requireViewer.mockResolvedValue(ctx);
    await expectPageTitle(
      await AUDIT_TAB(),
      routeProps(
        { ...SEGMENTS, tab: "exports" },
        { export: "3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01" },
      ),
      title("audit"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(Audit.mock.calls.at(-1)?.[0]).toEqual({
      ctx,
      source,
      tab: "exports",
      searchParams: { export: "3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01" },
    });
  });

  it("answers a segment that names no tab with a 404 (negative)", async () => {
    requireViewer.mockResolvedValue({ orgSlug: "acme" });
    const page = await AUDIT_TAB();
    await expect(
      page.default(routeProps({ ...SEGMENTS, tab: "events" })),
    ).rejects.toThrow("NOT_FOUND");
    expect(Audit).not.toHaveBeenCalled();
  });
});

describe("the Billing page", () => {
  it("resolves the organization viewer, names the page once and hands the viewer, the data source, the title, the signed-in name, the checkout outcome and the invoices cursor to Billing", async () => {
    const ctx = { orgSlug: "acme", orgName: "Acme Robotics" };
    requireViewer.mockResolvedValue(ctx);
    await expectPageTitle(
      await BILLING(),
      routeProps(SEGMENTS, { checkout: "success", cursor: "c2" }),
      title("billing"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(Billing).toHaveBeenCalledOnce();
    // Billing renders the header itself (eyebrow, subtext and Change plan),
    // since its not-loaded states replace the header with the body.
    expect(Billing.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
      title: title("billing"),
      viewerName: "Marcus Bell",
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
  it("resolves the workspace viewer, names the page once and hands the viewer, the data source and the view to Steering", async () => {
    const ctx = {
      orgSlug: "acme",
      wsSlug: "core-platform",
      wsName: "Core platform",
    };
    requireViewer.mockResolvedValue(ctx);
    const page = await expectPageTitle(
      await STEERING(),
      routeProps(SEGMENTS),
      title("steering"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Steering).toHaveBeenCalledOnce();
    expect(Steering.mock.calls[0]?.[0]).toMatchObject({
      ctx,
      source,
      view: { tab: "library" },
    });
    // The eyebrow is the workspace name and the subtext the design's sentence.
    expect(page.textContent).toContain("Core platform");
    expect(page.textContent).toContain(
      "Everything that can steer an agent in this workspace competes in one assembler.",
    );
    expect(screen.getByTestId("steering-actions")).toBeInTheDocument();
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("moves a ?tab= link from the one-route page to the path it names", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      wsSlug: "core-platform",
    });
    await expect(
      Promise.resolve(
        (await STEERING()).default(
          routeProps(SEGMENTS, { tab: "prs", proposal: "prp_1" }),
        ),
      ),
    ).rejects.toThrow(
      "REDIRECT /acme/core-platform/steering/proposals/prs?proposal=prp_1",
    );
  });

  it("renders a tab segment on the catch-all route", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      wsSlug: "core-platform",
      wsName: "Core platform",
    });
    await expectPageTitle(
      await STEERING_VIEW(),
      routeProps({ ...SEGMENTS, view: ["gates"] }),
      title("steering"),
    );
    expect(Steering.mock.calls[0]?.[0]).toMatchObject({
      view: { tab: "gates" },
    });
  });

  it("answers a segment that names nothing with a 404 (negative)", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      wsSlug: "core-platform",
    });
    await expect(
      Promise.resolve(
        (await STEERING_VIEW()).default(
          routeProps({ ...SEGMENTS, view: ["nowhere"] }),
        ),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the Spend page", () => {
  // The Spend feature draws its own header, so a state that does not load can
  // replace the whole body the way the design draws it; the route's part is the
  // title, the viewer and the view its path names.
  it("resolves the workspace viewer, titles the document and hands its body the viewer, the data source and the view the path names", async () => {
    const viewer = { wsSlug: "core-platform" };
    requireViewer.mockResolvedValue(viewer);
    const page = await SPEND();
    const props = routeProps({
      ...SEGMENTS,
      tab: ["agent", "acme.core.triage"],
    });
    expect((await page.generateMetadata(props)).title).toBe(title("spend"));
    await renderPage(await page.default(props));
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Spend.mock.calls[0]?.[0]).toEqual({
      ctx: viewer,
      source,
      view: { tab: "agent", drill: "acme.core.triage", finding: null },
    });
    expect(screen.getByTestId("spend-body")).toHaveAttribute(
      "data-tab",
      "agent",
    );
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("opens one finding's evidence from the query on the bare path", async () => {
    requireViewer.mockResolvedValue({ wsSlug: "core-platform" });
    const page = await SPEND();
    await renderPage(
      await page.default(routeProps(SEGMENTS, { finding: "fnd_01k5rtgh" })),
    );
    expect(Spend.mock.calls.at(-1)?.[0]).toMatchObject({
      view: { tab: "findings", drill: null, finding: "fnd_01k5rtgh" },
    });
  });

  it("answers 404 for a segment that names no tab, before reading the viewer (negative)", async () => {
    const page = await SPEND();
    await expect(
      Promise.resolve(
        page.default(routeProps({ ...SEGMENTS, tab: ["reconciliation"] })),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireViewer).not.toHaveBeenCalled();
  });
});

describe("the Runtimes page", () => {
  it("resolves the workspace viewer, names the page once and hands Runtimes the viewer, the data source, the slugs and the signed-in name", async () => {
    const viewer = { orgSlug: "acme", wsSlug: "core-platform" };
    requireViewer.mockResolvedValue(viewer);
    await expectPageTitle(
      await RUNTIMES(),
      routeProps(SEGMENTS),
      title("runtimes"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Runtimes).toHaveBeenCalledOnce();
    expect(Runtimes.mock.calls[0]?.[0]).toEqual({
      ctx: viewer,
      source,
      org: "acme",
      ws: "core-platform",
      viewerName: "Marcus Bell",
    });
  });
});

describe("the Skills route", () => {
  it("moves a member to the Skills tab of Steering with the inventory page it named", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      wsSlug: "core-platform",
    });
    await expect(
      Promise.resolve(
        (await SKILLS()).default(routeProps(SEGMENTS, { cursor: "c2" })),
      ),
    ).rejects.toThrow("REDIRECT /acme/core-platform/steering/skills?cursor=c2");
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Skills).not.toHaveBeenCalled();
  });

  it.each<[string[], Record<string, string>, string]>([
    [["search"], {}, "/acme/core-platform/steering/skills?view=search"],
    [["versions"], {}, "/acme/core-platform/steering/skills?view=versions"],
    [
      ["catalog"],
      { cursor: "c2" },
      "/acme/core-platform/steering/skills?cursor=c2",
    ],
    [
      ["a-intel.release-notes", "source"],
      {},
      "/acme/core-platform/steering/skills/a-intel.release-notes/source",
    ],
  ])(
    "moves the old /skills/%j to the Skills shelf of Steering",
    async (rest, query, to) => {
      requireViewer.mockResolvedValue({
        orgSlug: "acme",
        wsSlug: "core-platform",
      });
      await expect(
        Promise.resolve(
          (await SKILLS_VIEW()).default(
            routeProps({ ...SEGMENTS, rest }, query),
          ),
        ),
      ).rejects.toThrow(`REDIRECT ${to}`);
      expect(requireViewer).toHaveBeenCalledWith(...WS);
    },
  );

  it("answers an old /skills address that names nothing with a 404 (negative)", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      wsSlug: "core-platform",
    });
    await expect(
      Promise.resolve(
        (await SKILLS_VIEW()).default(
          routeProps({ ...SEGMENTS, rest: ["nowhere"] }),
        ),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("moves to the first page when the URL names no cursor", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      wsSlug: "core-platform",
    });
    await expect(
      Promise.resolve((await SKILLS()).default(routeProps(SEGMENTS))),
    ).rejects.toThrow("REDIRECT /acme/core-platform/steering/skills");
  });
});

describe("the Fleet page", () => {
  it("resolves the workspace viewer, names the page once and hands the viewer, the data source, the runs cursor and the onboarding banners to Fleet", async () => {
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
      prefs: { pageSize: 25, hidden: new Set() },
      pullRequests: "any",
      // No search, facet, order or page on the URL: the default list (#3837).
      list: {
        q: "",
        status: [],
        tier: [],
        replay: [],
        sort: "started",
        dir: "desc",
        page: 1,
      },
      banners: <OnboardingGate ctx={ctx} source={source} />,
    });
    expect(screen.getByTestId("onboarding-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("hands Fleet the saved columns and page size from the cookie, and the pull-request filter from the URL", async () => {
    cookieJar.set("fleet_view", "v1|50|tier~tokens~retired_column");
    await expectPageTitle(
      await FLEET(),
      routeProps(SEGMENTS, { prs: "with" }),
      title("fleet"),
    );
    expect(Fleet.mock.calls[0]?.[0]).toMatchObject({
      prefs: { pageSize: 50, hidden: new Set(["tier", "tokens"]) },
      pullRequests: "with",
    });
  });

  it("reads a cookie it cannot parse and an unknown filter as the defaults (negative)", async () => {
    cookieJar.set("fleet_view", "v9|7|everything");
    await expectPageTitle(
      await FLEET(),
      routeProps(SEGMENTS, { prs: "maybe" }),
      title("fleet"),
    );
    expect(Fleet.mock.calls[0]?.[0]).toMatchObject({
      prefs: { pageSize: 25, hidden: new Set() },
      pullRequests: "any",
    });
  });

  it("asks Fleet for the newest runs when the URL carries no cursor", async () => {
    await expectPageTitle(await FLEET(), routeProps(SEGMENTS), title("fleet"));
    expect(Fleet.mock.calls[0]?.[0]).toMatchObject({ cursor: null });
  });
});

/**
 * The agent and source routes draw no h1 of their own: the feature draws it
 * (the agent card, the file path) once the identity is read. So the route
 * owns only the document title.
 */
async function expectBodyTitled<P extends object>(
  page: PageModule<P>,
  props: RouteProps<P>,
  documentTitle: string,
): Promise<void> {
  expect((await page.generateMetadata(props)).title).toBe(documentTitle);
  const container = await renderPage(await page.default(props));
  expect(container.querySelectorAll("h1")).toHaveLength(0);
}

describe("the Agents pages", () => {
  const ctx = { wsSlug: "core-platform" };
  beforeEach(() => {
    requireViewer.mockResolvedValue(ctx);
  });

  it("the agents page hands the workspace viewer, the data source, the cursor and its header to Agents", async () => {
    await expectPageTitle(
      await AGENTS(),
      routeProps(SEGMENTS, { cursor: "c2" }),
      title("agents"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Agents.mock.calls.at(-1)?.[0]).toMatchObject({
      ctx,
      source,
      cursor: "c2",
    });
    expect(Object.keys(Agents.mock.calls.at(-1)?.[0] ?? {}).sort()).toEqual([
      "ctx",
      "cursor",
      "header",
      "showRetired",
      "source",
      "viewerName",
    ]);
    expect(Agents.mock.calls.at(-1)?.[0]).toMatchObject({ showRetired: false });
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("the agents page ignores a view in the URL: the column set is the table's session state", async () => {
    await expectPageTitle(
      await AGENTS(),
      routeProps(SEGMENTS, { view: "operations" }),
      title("agents"),
    );
    expect(Agents.mock.calls.at(-1)?.[0]).not.toHaveProperty("view");
    expect(Agents.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: null });
  });

  it("the agent page hands the agent, the tab and the cursor the URL names to Agent", async () => {
    await expectBodyTitled(
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
    await expectBodyTitled(await AGENT(), routeProps(SEGMENTS), title("agent"));
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

  it("the agent tab page hands the tab its path names, and the cursor, to Agent", async () => {
    const page = await AGENT_TAB();
    await expectBodyTitled(
      page,
      routeProps({ ...SEGMENTS, tab: "activity" }, { cursor: "c3" }),
      title("agent"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Agent.mock.calls.at(-1)?.[0]).toEqual({
      ctx,
      source,
      agent: "release-bot",
      tab: "activity",
      cursor: "c3",
    });
    await expectBodyTitled(
      page,
      routeProps({ ...SEGMENTS, tab: "identity" }),
      title("agent"),
    );
    expect(Agent.mock.calls.at(-1)?.[0]).toMatchObject({
      tab: "identity",
      cursor: null,
    });
  });

  it("the source page hands the agent to AgentSource", async () => {
    await expectBodyTitled(
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

describe("the Run page", () => {
  const ctx = { wsSlug: "core-platform" };
  beforeEach(() => {
    requireViewer.mockResolvedValue(ctx);
  });

  // The spec (pages/run.md) makes the run's id the h1 and "Run" the eyebrow,
  // so the tab title and the h1 differ here, unlike every other page. The Run
  // feature draws that header itself (its not-loaded states replace it), so
  // the route names the document and hands the whole body to Run; the h1 is
  // held in features/run/run.test.tsx.
  async function expectRunTitle(props: RouteProps<typeof SEGMENTS>) {
    const page = await RUN();
    const metadata = await page.generateMetadata(props);
    const container = await renderPage(await page.default(props));
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(screen.getByTestId("run-body")).toBeTruthy();
    expect(metadata.title).toBe(title("run"));
  }

  it("hands the run, the tab, the chips, the frames cursor and the spine's folds the URL names to Run, and drops an older link's zoom", async () => {
    await expectRunTitle(
      routeProps(SEGMENTS, {
        tab: "frames",
        zoom: "turns",
        kinds: "tools,errors",
        frames: "ZjoyMA",
        reads: "hide",
        spine: "0,3",
      }),
    );
    expect(requireViewer).toHaveBeenCalledWith(...WS);
    expect(Run.mock.calls.at(-1)?.[0]).toEqual({
      ctx,
      source,
      runId: "arun_1",
      tab: "frames",
      kinds: "tools,errors",
      frames: "ZjoyMA",
      body: null,
      reads: "hide",
      spine: "0,3",
    });
    expect(screen.queryByTestId("not-recorded")).toBeNull();
  });

  it("hands nulls, not empty strings, when the URL carries no query (negative)", async () => {
    await expectRunTitle(routeProps(SEGMENTS));
    expect(Run.mock.calls.at(-1)?.[0]).toMatchObject({
      tab: null,
      kinds: null,
      frames: null,
      body: null,
      reads: null,
      spine: null,
    });
  });
});

/**
 * The three Organization routes name themselves in the document title only:
 * the h1 is the organization's name, which the body draws once the frame has
 * checked the viewer may read it (pages/organization.md), so a stubbed body
 * leaves the route with no h1 of its own.
 */
async function expectOrganizationRoute<P extends object>(
  page: PageModule<P>,
  props: RouteProps<P>,
  name: string,
) {
  const metadata = await page.generateMetadata(props);
  expect(metadata.title).toBe(name);
  const container = await renderPage(await page.default(props));
  expect(container.querySelectorAll("h1")).toHaveLength(0);
  expect(container.querySelector("main#main")).not.toBeNull();
}

describe("Organization", () => {
  beforeEach(() => {
    Organization.mockClear();
  });

  it("resolves the organization viewer, names the page once and hands the viewer, the data source and People to the body", async () => {
    const ctx = { orgSlug: "acme", orgRole: "owner" };
    requireViewer.mockResolvedValue(ctx);
    await expectOrganizationRoute(
      await import("./page"),
      routeProps(SEGMENTS),
      title("people"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(Organization.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
      tab: "people",
    });
  });

  it("hands the tab the URL names, and People for one it does not (negative)", async () => {
    requireViewer.mockResolvedValue({ orgSlug: "acme", orgRole: "owner" });
    await expectOrganizationRoute(
      await import("./page"),
      routeProps(SEGMENTS, { tab: "workspaces" }),
      title("people"),
    );
    expect(Organization.mock.calls[0]?.[0]).toMatchObject({
      tab: "workspaces",
    });
    Organization.mockClear();
    await expectOrganizationRoute(
      await import("./page"),
      routeProps(SEGMENTS, { tab: "nonsense" }),
      title("people"),
    );
    expect(Organization.mock.calls[0]?.[0]).toMatchObject({ tab: "people" });
  });
});

describe("Organization › Model funding", () => {
  it("resolves the organization viewer, names the page once and hands the viewer and the data source to Model funding", async () => {
    const ctx = { orgSlug: "acme", orgName: "Acme Robotics", orgRole: "owner" };
    requireViewer.mockResolvedValue(ctx);
    OrganizationModelFunding.mockClear();
    await expectOrganizationRoute(
      await import("./model-funding/page"),
      routeProps(SEGMENTS),
      title("modelFunding"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(OrganizationModelFunding).toHaveBeenCalledOnce();
    expect(OrganizationModelFunding.mock.calls[0]?.[0]).toEqual({
      ctx,
      source,
    });
  });
});

describe("Organization › Roles", () => {
  it("resolves the organization viewer, names the page once and hands the viewer and the data source to Roles", async () => {
    const ctx = { orgSlug: "acme", orgName: "Acme Robotics", orgRole: "owner" };
    requireViewer.mockResolvedValue(ctx);
    await expectOrganizationRoute(
      await import("./roles/page"),
      routeProps(SEGMENTS),
      title("roles"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(OrganizationRoles).toHaveBeenCalledOnce();
    expect(OrganizationRoles.mock.calls[0]?.[0]).toEqual({ ctx, source });
  });
});

/**
 * A row as `list_workspaces` answers it. `role` is what the viewer holds; a
 * workspace they are not a member of answers null, and the picker drops it
 * because viewer resolution 404s on one (INV-15).
 */
const wsRow = (slug: string, name: string) => ({
  id: `wrk_${slug}`,
  slug,
  namespace: slug,
  name,
  avatarUrl: null,
  role: "Owner",
  archivedAt: null,
  costCenter: null,
});

describe("Organization › API keys", () => {
  beforeEach(() => {
    OrganizationApiKeys.mockClear();
    workspaces.mockResolvedValue({
      ok: true,
      value: { workspaces: [wsRow("core-platform", "Core platform")] },
    });
  });

  it("resolves the workspace the URL names and hands its viewer to the keys", async () => {
    // A key names a workspace (ADR-073): the page resolves one before it reads.
    const orgCtx = { orgSlug: "acme", orgRole: "owner" };
    const wsCtx = { ...orgCtx, wsSlug: "growth" };
    requireViewer.mockImplementation((_org, ws) =>
      Promise.resolve(ws === undefined ? orgCtx : wsCtx),
    );
    workspaces.mockResolvedValue({
      ok: true,
      value: {
        workspaces: [
          wsRow("core-platform", "Core platform"),
          wsRow("growth", "Growth"),
        ],
      },
    });
    await expectOrganizationRoute(
      await API_KEYS(),
      routeProps(SEGMENTS, { workspace: "growth" }),
      title("apiKeys"),
    );
    expect(requireViewer).toHaveBeenCalledWith(...ORG);
    expect(requireViewer).toHaveBeenCalledWith("acme", "growth");
    expect(workspaces).toHaveBeenCalledOnce();
    expect(OrganizationApiKeys.mock.calls[0]?.[0]).toMatchObject({
      ctx: orgCtx,
      keysCtx: wsCtx,
      source,
    });
  });

  it("falls back to the first workspace the viewer may enter when the URL names none", async () => {
    requireViewer.mockResolvedValue({
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole: "owner",
      wsSlug: "core-platform",
    });
    await expectOrganizationRoute(
      await API_KEYS(),
      routeProps(SEGMENTS),
      title("apiKeys"),
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
  });

  it("resolves no workspace when the viewer may enter none, and hands the org viewer for both (negative)", async () => {
    const orgCtx = { orgSlug: "acme", orgRole: "owner" };
    requireViewer.mockResolvedValue(orgCtx);
    workspaces.mockResolvedValue({ ok: true, value: { workspaces: [] } });
    await expectOrganizationRoute(
      await API_KEYS(),
      routeProps(SEGMENTS),
      title("apiKeys"),
    );
    expect(requireViewer).toHaveBeenCalledExactlyOnceWith(...ORG);
    expect(OrganizationApiKeys.mock.calls[0]?.[0]).toMatchObject({
      ctx: orgCtx,
      keysCtx: orgCtx,
    });
  });
});

describe("a person requireViewer refuses", () => {
  it.each([
    ["tools", TOOLS] as const,
    ["billing", BILLING] as const,
    ["skills", SKILLS] as const,
    ["steering", STEERING] as const,
    ["fleet", FLEET] as const,
    ["agents", AGENTS] as const,
    ["agent", AGENT] as const,
    ["agentSource", AGENT_SOURCE] as const,
    ["spend", SPEND] as const,
    ["runtimes", RUNTIMES] as const,
    ["run", RUN] as const,
    ["people", () => import("./page")] as const,
    ["roles", () => import("./roles/page")] as const,
    ["apiKeys", API_KEYS] as const,
    ["modelFunding", () => import("./model-funding/page")] as const,
  ])("pages.%s renders nothing (negative)", async (_key, load) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      Promise.resolve((await load()).default(routeProps(SEGMENTS))),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
