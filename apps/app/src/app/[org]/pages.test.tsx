// @vitest-environment jsdom
// Every route under /[org] renders between WL-08 and its page item
// (ARCHITECTURE.md §8): the three gap-lane pages render their one UNRECORDED
// row under the title, Billing hands its viewer, the data source, the checkout
// outcome and the invoices cursor to the Billing feature (WL-38), Steering hands
// its viewer, the data source and the query to the Steering feature (#2961),
// People renders its sections from org.members, and the other rev1 pages render
// the title alone. Each page names itself once from its pages.* key (§1.2),
// resolves its viewer first and renders nothing for a person requireViewer
// refuses. Fleet, Run and API keys gain their bodies in WL-34, WL-35 and WL-37.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import {
  expectPageTitle,
  type PageModule,
  routeProps,
} from "@/test/render-page";

const { requireViewer, Billing, Steering, members, source } = vi.hoisted(() => {
  const members = vi.fn();
  return {
    requireViewer: vi.fn<(org: string, ws?: string) => Promise<unknown>>(),
    Billing: vi.fn((_props: Record<string, unknown>) => null),
    Steering: vi.fn((props: { searchParams: Record<string, string> }) => (
      <p data-testid="steering-body" data-tab={props.searchParams.tab} />
    )),
    members,
    source: { org: { members } },
  };
});
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/features/billing", () => ({ Billing }));
vi.mock("@/features/steering", () => ({ Steering }));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({});
});

/** Every segment a page under /[org] can have; each page reads the ones in its path. */
const SEGMENTS = { org: "acme", ws: "core-platform", run: "arun_1" };
type Load = () => Promise<PageModule<typeof SEGMENTS>>;

const ORG = ["acme"];
const WS = ["acme", "core-platform"];
const title = translator("pages");

const GAP_LANE: [string, Load][] = [
  ["agents", () => import("./[ws]/agents/page")],
  ["tools", () => import("./[ws]/tools/page")],
  ["spend", () => import("./[ws]/spend/page")],
];

const STEERING: Load = () => import("./[ws]/steering/page");

const REV1: [string, string[], Load][] = [
  ["fleet", WS, () => import("./[ws]/page")],
  ["run", WS, () => import("./[ws]/runs/[run]/page")],
  ["apiKeys", ORG, () => import("./api-keys/page")],
];

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

describe("a person requireViewer refuses", () => {
  it.each([
    ...GAP_LANE.map(([key, load]) => [key, load] as const),
    ["billing", BILLING] as const,
    ["steering", STEERING] as const,
    ...REV1.map(([key, , load]) => [key, load] as const),
    ["people", () => import("./page")] as const,
  ])("pages.%s renders nothing (negative)", async (_key, load) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      Promise.resolve((await load()).default(routeProps(SEGMENTS))),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
