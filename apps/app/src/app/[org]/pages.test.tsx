// @vitest-environment jsdom
// Every route under /[org] and the root render between WL-08 and their page
// item (ARCHITECTURE.md §8): the four gap-lane pages render their one
// UNRECORDED row under the title, the four rev1 pages and the root render the
// title alone. Every page under /[org] resolves its viewer first and renders
// nothing for a person requireViewer refuses. Fleet, Run, People, API keys and
// Billing gain their bodies in WL-34 to WL-38 and the root becomes a redirect
// in WL-32.
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

const { requireViewer } = vi.hoisted(() => ({
  requireViewer: vi.fn<(org: string, ws?: string) => Promise<unknown>>(),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve((key: string) => {
      let node: unknown = Reflect.get(en, namespace);
      for (const part of key.split("."))
        node =
          typeof node === "object" && node !== null
            ? Reflect.get(node, part)
            : undefined;
      if (typeof node !== "string") throw new Error(`missing ${key}`);
      return node;
    }),
}));

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

/** Every segment a page under /[org] can have; each page reads the ones in its path. */
const SEGMENTS = { org: "acme", ws: "core-platform", run: "arun_1" };
type Page = (props: {
  params: Promise<typeof SEGMENTS>;
  searchParams: Promise<Record<string, string>>;
}) => Promise<ReactElement>;
type Load = () => Promise<{ default: Page }>;

const props = () => ({
  params: Promise.resolve(SEGMENTS),
  searchParams: Promise.resolve({}),
});
const ORG = ["acme"];
const WS = ["acme", "core-platform"];

async function renderPage(page: Promise<ReactElement>) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {await page}
    </NextIntlClientProvider>,
  );
}

const GAP_LANE: [string, string, Load][] = [
  ["Agents", "agents", () => import("./[ws]/agents/page")],
  ["Tools", "tools", () => import("./[ws]/tools/[[...tab]]/page")],
  ["Steering", "steering", () => import("./[ws]/steering/[[...tab]]/page")],
  ["Spend", "spend", () => import("./[ws]/spend/[[...drill]]/page")],
];

const REV1: [string, string[], Load][] = [
  ["Fleet", WS, () => import("./[ws]/page")],
  ["Run", WS, () => import("./[ws]/runs/[run]/[[...tab]]/page")],
  ["Organization", ORG, () => import("./page")],
  ["API keys", ORG, () => import("./api-keys/page")],
  ["Billing", ORG, () => import("./billing/page")],
];

describe("gap-lane pages", () => {
  it.each(GAP_LANE)(
    "%s resolves the workspace viewer, then renders its title and one NotRecorded row",
    async (title, section, load) => {
      await renderPage((await load()).default(props()));
      expect(requireViewer).toHaveBeenCalledWith(...WS);
      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        title,
      );
      expect(screen.getByTestId("not-recorded")).toHaveAttribute(
        "data-section",
        section,
      );
    },
  );
});

describe("rev1 pages before their page item", () => {
  it.each(REV1)(
    "%s resolves its viewer, then renders its title and no body, never a NotRecorded row (negative)",
    async (title, segments, load) => {
      await renderPage((await load()).default(props()));
      expect(requireViewer).toHaveBeenCalledWith(...segments);
      const main = screen.getByRole("main");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        title,
      );
      expect(screen.queryByTestId("not-recorded")).toBeNull();
      expect(main.querySelectorAll("p, table, form, ul")).toHaveLength(0);
    },
  );

  it("the root renders its title alone", async () => {
    await renderPage((await import("../page")).default());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Mission Control",
    );
  });
});

describe("a person requireViewer refuses", () => {
  it.each([...GAP_LANE.map(([t, , l]) => [t, WS, l] as const), ...REV1])(
    "%s renders nothing (negative)",
    async (_title, _segments, load) => {
      requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
      await expect((await load()).default(props())).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
    },
  );
});
