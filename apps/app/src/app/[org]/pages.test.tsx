// @vitest-environment jsdom
// Every route under /[org] renders between WL-08 and its page item
// (ARCHITECTURE.md §8): the four gap-lane pages render their one UNRECORDED
// row under the title, the rev1 pages render the title alone. Each page names
// itself once from its pages.* key (§1.2), resolves its viewer first and
// renders nothing for a person requireViewer refuses. Fleet, Run, People, API
// keys and Billing gain their bodies in WL-34 to WL-38.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import {
  expectPageTitle,
  type PageModule,
  routeProps,
} from "@/test/render-page";

const { requireViewer } = vi.hoisted(() => ({
  requireViewer: vi.fn<(org: string, ws?: string) => Promise<unknown>>(),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
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
  ["steering", () => import("./[ws]/steering/page")],
  ["spend", () => import("./[ws]/spend/page")],
];

const REV1: [string, string[], Load][] = [
  ["fleet", WS, () => import("./[ws]/page")],
  ["run", WS, () => import("./[ws]/runs/[run]/page")],
  ["people", ORG, () => import("./page")],
  ["apiKeys", ORG, () => import("./api-keys/page")],
  ["billing", ORG, () => import("./billing/page")],
];

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

describe("a person requireViewer refuses", () => {
  it.each([
    ...GAP_LANE.map(([key, load]) => [key, load] as const),
    ...REV1.map(([key, , load]) => [key, load] as const),
  ])("pages.%s renders nothing (negative)", async (_key, load) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      Promise.resolve((await load()).default(routeProps(SEGMENTS))),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
