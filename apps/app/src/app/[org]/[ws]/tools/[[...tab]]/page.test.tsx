// @vitest-environment jsdom
// /{org}/{ws}/tools/servers/{mcs_id}[/{tab}] is one MCP Studio server's page
// (#4678). The route resolves the workspace viewer and hands the viewer, the
// data source and the parsed route to the Studio body. A Studio path that
// names no page is a 404 before anyone is resolved, and every other path
// moves to the Agents tab that absorbed the Tools page (#4806); pages.test.tsx
// covers each of those moves.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import { renderPage } from "@/test/render-page";

const { requireViewer, StudioServer, StudioLoading, source } = vi.hoisted(
  () => ({
    requireViewer: vi.fn(),
    StudioServer: vi.fn((props: { route: { tab: string } }) => (
      <p data-testid="studio-body" data-tab={props.route.tab} />
    )),
    StudioLoading: vi.fn(() => null),
    source: {},
  }),
);
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The real parsers decide which page a path names; only the bodies are
// stand-ins, because each has its own component tests.
vi.mock("@/features/mcp-studio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/mcp-studio")>()),
  StudioServer,
  StudioLoading,
}));
// A redirect throws, as Next's does, with the target in its message.
vi.mock("@/shared/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/navigation")>()),
  permanentRedirectTo: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const SEGMENTS = { org: "acme", ws: "core-platform" };
const VIEWER = { orgSlug: "acme", wsSlug: "core-platform" };

// Imported once, at module scope: the route pulls both feature barrels in
// behind it, and paying that inside the first test would spend its budget.
const page = await import("./page");

function open(tab: string[]) {
  return page.default({
    params: Promise.resolve({ ...SEGMENTS, tab }),
    searchParams: Promise.resolve({}),
  });
}

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(VIEWER);
  StudioServer.mockClear();
});

describe("the MCP Studio server page", () => {
  it("opens the Tools tab on the server's own path", async () => {
    await renderPage(await open(["servers", "mcs_01k5s1"]));
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(StudioServer).toHaveBeenCalledOnce();
    expect(StudioServer.mock.calls[0]?.[0]).toEqual({
      ctx: VIEWER,
      source,
      route: { serverId: "mcs_01k5s1", tab: "tools" },
    });
    expect(screen.getByTestId("studio-body")).toHaveAttribute(
      "data-tab",
      "tools",
    );
  });

  it.each(["connection", "try", "changes"])(
    "hands the %s tab its segment",
    async (tab) => {
      await renderPage(await open(["servers", "mcs_01k5s1", tab]));
      expect(StudioServer.mock.calls[0]?.[0]).toMatchObject({
        route: { serverId: "mcs_01k5s1", tab },
      });
    },
  );

  it.each([
    [["servers", "stripe"]],
    [["servers", "mcs_01k5s1", "settings"]],
    [["servers", "mcs_01k5s1", "tools", "create_payment"]],
  ])(
    "answers %j with a 404 before resolving anyone (negative)",
    async (tab) => {
      await expect(Promise.resolve(open(tab))).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(requireViewer).not.toHaveBeenCalled();
      expect(StudioServer).not.toHaveBeenCalled();
    },
  );

  it("moves every other path to the Agents tab that absorbed it, after resolving the viewer", async () => {
    await expect(Promise.resolve(open(["providers"]))).rejects.toThrow(
      "REDIRECT /acme/core-platform/agents?tab=servers",
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(StudioServer).not.toHaveBeenCalled();
    // `/tools/servers` alone names no server, so it is the old Providers tab.
    await expect(Promise.resolve(open(["servers"]))).rejects.toThrow(
      "REDIRECT /acme/core-platform/agents?tab=servers",
    );
  });

  it("names its one page, a server's, by the Studio title", async () => {
    // The paths that redirect never render, so the route reads no segment to
    // title them: every page it renders is a Studio server's.
    expect((await page.generateMetadata()).title).toBe(
      translator("mcpStudio")("title"),
    );
  });
});
