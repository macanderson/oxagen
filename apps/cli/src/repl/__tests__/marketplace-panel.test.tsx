import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  MarketplacePanel,
  pluginTypeLabel,
  MARKETPLACE_TABS,
  type MarketplaceClient,
  type MarketplaceEntry,
  type MarketplaceBrowseOptions,
} from "../marketplace-panel.js";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const ARROW_RIGHT = `${ESC}[C`;
const ENTER = "\r";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function entry(
  over: Partial<MarketplaceEntry> & { id: string },
): MarketplaceEntry {
  return {
    id: over.id,
    name: over.name ?? over.id,
    description: over.description ?? `${over.id} description`,
    pluginType: over.pluginType ?? "mcp_server",
    version: over.version ?? "1.0.0",
    installed: over.installed ?? false,
    categories: over.categories ?? [],
    ...(over.title !== undefined ? { title: over.title } : {}),
  };
}

const CATALOG: MarketplaceEntry[] = [
  entry({
    id: "github",
    title: "GitHub",
    pluginType: "mcp_server",
    description: "GitHub MCP server",
    categories: ["dev", "vcs"],
  }),
  entry({
    id: "slack",
    title: "Slack",
    pluginType: "integration",
    description: "Slack integration",
    installed: true,
  }),
  entry({
    id: "code-review",
    title: "Code Review",
    pluginType: "agent_skill",
    description: "reviews diffs",
  }),
];

/** A catalog-backed client that filters by type/search and installs by mutating a clone. */
function makeCatalogClient(seed: MarketplaceEntry[] = CATALOG): {
  client: MarketplaceClient;
  browse: ReturnType<typeof vi.fn>;
} {
  const rows = seed.map((e) => ({ ...e }));
  const browse = vi.fn(async (opts: MarketplaceBrowseOptions) => {
    let filtered = rows;
    if (opts.pluginType)
      filtered = filtered.filter((e) => e.pluginType === opts.pluginType);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          (e.title ?? "").toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }
    return {
      entries: filtered.map((e) => ({ ...e })),
      total: filtered.length,
      nextOffset: null,
    };
  });
  const install = vi.fn(async (id: string) => {
    const row = rows.find((e) => e.id === id);
    if (row) row.installed = true;
    return { ok: true };
  });
  return { client: { browse, install }, browse };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof MarketplacePanel>> = {},
) {
  const { client } = makeCatalogClient();
  const props: React.ComponentProps<typeof MarketplacePanel> = {
    onClose: () => {},
    client,
    debounceMs: 20,
    ...overrides,
  };
  return render(<MarketplacePanel {...props} />);
}

describe("pluginTypeLabel", () => {
  it("labels every plugin type", () => {
    expect(pluginTypeLabel("mcp_server")).toBe("mcp");
    expect(pluginTypeLabel("agent_capability")).toBe("agent");
    expect(pluginTypeLabel("agent_skill")).toBe("skill");
    expect(pluginTypeLabel("knowledge_source")).toBe("knowledge");
    expect(pluginTypeLabel("integration")).toBe("integration");
  });
  it("covers every tab", () => {
    expect(MARKETPLACE_TABS[0]?.label).toBe("All");
    expect(MARKETPLACE_TABS.length).toBe(6);
  });
});

describe("MarketplacePanel", () => {
  it("loads and renders the catalog", async () => {
    const { lastFrame } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("GitHub"));
    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("Marketplace");
    expect(frame).toContain("3 plugins");
    expect(frame).toContain("GitHub");
    expect(frame).toContain("Slack");
    expect(frame).toContain("✓ installed"); // slack is installed
    expect(frame).toContain("[All]"); // active tab
  });

  it("shows a loading state before the first page resolves", async () => {
    let resolve!: (r: {
      entries: MarketplaceEntry[];
      total: number;
      nextOffset: null;
    }) => void;
    const client: MarketplaceClient = {
      browse: () =>
        new Promise((r) => {
          resolve = r;
        }),
      install: async () => ({ ok: true }),
    };
    const { lastFrame } = render(
      <MarketplacePanel onClose={() => {}} client={client} />,
    );
    await until(() => (lastFrame() ?? "").includes("loading…"));
    resolve({
      entries: [entry({ id: "x", title: "Xt" })],
      total: 1,
      nextOffset: null,
    });
    await until(() => (lastFrame() ?? "").includes("Xt"));
  });

  it("cycles the type-filter tabs and re-browses by plugin type", async () => {
    const { client, browse } = makeCatalogClient();
    const { lastFrame, stdin } = render(
      <MarketplacePanel onClose={() => {}} client={client} debounceMs={20} />,
    );
    await until(() => (lastFrame() ?? "").includes("GitHub"));
    stdin.write(ARROW_RIGHT); // All → MCP
    await until(() => (lastFrame() ?? "").includes("[MCP]"));
    await until(() =>
      browse.mock.calls.some((c) => c[0]?.pluginType === "mcp_server"),
    );
    // MCP tab shows github, hides the slack integration.
    await until(() => {
      const f = stripAnsi(lastFrame() ?? "");
      return f.includes("GitHub") && !f.includes("Slack");
    });
  });

  it("debounces the `/` search and filters the list", async () => {
    const { client, browse } = makeCatalogClient();
    const { lastFrame, stdin } = render(
      <MarketplacePanel onClose={() => {}} client={client} debounceMs={30} />,
    );
    await until(() => (lastFrame() ?? "").includes("GitHub"));
    const before = browse.mock.calls.length; // 1 (initial load)
    stdin.write("/"); // focus search
    await until(() => (lastFrame() ?? "").includes("█"));
    stdin.write("slack"); // typed as one chunk → one debounced browse
    await until(() => browse.mock.calls.some((c) => c[0]?.search === "slack"));
    await until(() => {
      const f = stripAnsi(lastFrame() ?? "");
      return f.includes("Slack") && !f.includes("GitHub");
    });
    // Debounce coalesced the 5 keystrokes into a single extra browse.
    expect(browse.mock.calls.length).toBeLessThanOrEqual(before + 1);
  });

  it("moves the selection with the arrow keys, wrapping", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    expect(lastFrame()).toMatch(/❯.*GitHub/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*Slack/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP);
    await until(() => /❯.*GitHub/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP); // wraps to the last row
    await until(() => /❯.*Code Review/.test(lastFrame() ?? ""));
  });

  it("Enter opens detail with the full description; Esc steps back", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("GitHub MCP server"));
    const detail = stripAnsi(lastFrame()!);
    expect(detail).toContain("dev · vcs"); // categories
    expect(detail).toContain("v1.0.0");
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("↑↓ select"));
  });

  it("installs the highlighted entry and re-browses so it flips to installed", async () => {
    const { client, browse } = makeCatalogClient();
    const { lastFrame, stdin } = render(
      <MarketplacePanel onClose={() => {}} client={client} debounceMs={20} />,
    );
    await until(() => (lastFrame() ?? "").includes("GitHub"));
    const before = browse.mock.calls.length;
    stdin.write("i"); // install the highlighted GitHub (uninstalled)
    await until(() => (lastFrame() ?? "").includes("installed github"));
    await until(() => browse.mock.calls.length > before); // re-browsed after install
    // The GitHub row now reports installed (there were two rows with ✓ installed).
    await until(() => {
      const f = stripAnsi(lastFrame() ?? "");
      return (f.match(/✓ installed/g) ?? []).length >= 2;
    });
  });

  it("surfaces an install failure as a readable notice", async () => {
    const client: MarketplaceClient = {
      browse: async () => ({
        entries: [entry({ id: "z", title: "Zed" })],
        total: 1,
        nextOffset: null,
      }),
      install: async () => ({
        ok: false,
        error: "already installed elsewhere",
      }),
    };
    const { lastFrame, stdin } = render(
      <MarketplacePanel onClose={() => {}} client={client} debounceMs={20} />,
    );
    await until(() => (lastFrame() ?? "").includes("Zed"));
    stdin.write("i");
    await until(() =>
      (lastFrame() ?? "").includes("already installed elsewhere"),
    );
  });

  it("pages forward with n and back with p when nextOffset is present", async () => {
    const browse = vi.fn(async (opts: MarketplaceBrowseOptions) => {
      if ((opts.offset ?? 0) === 0)
        return {
          entries: [entry({ id: "p1", title: "Page One" })],
          total: 2,
          nextOffset: 1,
        };
      return {
        entries: [entry({ id: "p2", title: "Page Two" })],
        total: 2,
        nextOffset: null,
      };
    });
    const client: MarketplaceClient = {
      browse,
      install: async () => ({ ok: true }),
    };
    const { lastFrame, stdin } = render(
      <MarketplacePanel onClose={() => {}} client={client} debounceMs={20} />,
    );
    await until(() => (lastFrame() ?? "").includes("Page One"));
    stdin.write("n"); // next page
    await until(() => (lastFrame() ?? "").includes("Page Two"));
    expect(browse.mock.calls.some((c) => c[0]?.offset === 1)).toBe(true);
    stdin.write("p"); // previous page
    await until(() => (lastFrame() ?? "").includes("Page One"));
  });

  it("surfaces a browse rejection and retries with r", async () => {
    let fail = true;
    const browse = vi.fn(async () => {
      if (fail) throw new Error("network down");
      return {
        entries: [entry({ id: "ok", title: "Recovered" })],
        total: 1,
        nextOffset: null,
      };
    });
    const client: MarketplaceClient = {
      browse,
      install: async () => ({ ok: true }),
    };
    const { lastFrame, stdin } = render(
      <MarketplacePanel onClose={() => {}} client={client} debounceMs={20} />,
    );
    await until(() => (lastFrame() ?? "").includes("network down"));
    expect(lastFrame()).toContain("press r to retry");
    fail = false;
    stdin.write("r");
    await until(() => (lastFrame() ?? "").includes("Recovered"));
  });

  it("Esc closes the panel from the list", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onClose });
    await until(() => (lastFrame() ?? "").includes("Marketplace"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });
});
