// The lists the record pickers offer (choice-actions.ts), over a stubbed data
// source: a cursor read stops at its bound and says partial, a retired agent is
// never offered, each tool gets one `slug@*` row, a model named twice is listed
// once, one failed read of two leaves a partial list instead of none, and a
// refused read answers with the reason the store gave rather than a bare no.
// A tool row carries its server's name and logo, a title read from its API
// name, what it does and its risk grade, and never the server uuid its slug
// holds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";

const { source } = vi.hoisted(() => ({
  source: {
    tools: { versions: vi.fn(), mcpServers: vi.fn() },
    agents: { list: vi.fn() },
    org: { members: vi.fn() },
    spend: { priceBook: vi.fn(), unpricedModels: vi.fn() },
  },
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("@/server/viewer", () => ({
  requireViewer: vi.fn(() => Promise.resolve({})),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(translator(namespace)),
  };
});

const {
  chooseAgents,
  chooseApprovers,
  chooseModels,
  chooseServerTools,
  chooseSwitchTargets,
  chooseToolPatterns,
} = await import("./choice-actions");

const ok = <T>(value: T) => ({ ok: true as const, value });

function version(slug: string, v: number) {
  return {
    id: `tlv_${slug}${String(v)}`,
    slug,
    version: v,
    name: slug,
    description: null,
    source: "custom",
    serverId: null,
    readOnly: false,
    riskGrade: "low",
    classification: null,
  };
}

const NOTION_UUID = "7c084658-9d6d-480d-81eb-499322416dae";

/** An imported Notion tool, slugged the way the registry slugs one. */
function notion(name: string, v: number) {
  return {
    ...version(`mcp.${NOTION_UUID}.${name}`, v),
    name,
    source: "mcp",
    serverId: "mcs_notion",
  };
}

const NOTION_SERVER = {
  id: "mcs_notion",
  name: "Notion",
  iconUrl: "https://notion.so/icon.png",
};

beforeEach(() => {
  vi.clearAllMocks();
  source.tools.mcpServers.mockResolvedValue(ok({ servers: [NOTION_SERVER] }));
});

describe("chooseToolPatterns", () => {
  it("offers each tool once as slug@*, then every version", async () => {
    source.tools.versions.mockResolvedValue(
      ok({
        items: [version("stripe", 1), version("stripe", 2)],
        nextCursor: null,
      }),
    );
    const result = await chooseToolPatterns("acme", "core");
    const facts = [
      { text: "May write", tone: "denied" },
      { text: "Low risk", tone: "quiet" },
    ];
    expect(result).toEqual({
      ok: true,
      value: {
        partial: false,
        options: [
          {
            value: "stripe@*",
            label: "Stripe",
            context: "Custom tool · every version",
            facts,
          },
          {
            value: "stripe@1",
            label: "Stripe v1",
            context: "Custom tool · version 1 only",
            facts,
          },
          {
            value: "stripe@2",
            label: "Stripe v2",
            context: "Custom tool · version 2 only",
            facts,
          },
        ],
      },
    });
  });

  it("names an imported tool by its server and title, never the server uuid", async () => {
    source.tools.versions.mockResolvedValue(
      ok({
        items: [
          {
            ...notion("notion-create-database", 1),
            description: "Create a database in a page.",
            riskGrade: "high",
            classification: { sideEffect: "write" },
          },
          { ...notion("notion-search", 1), readOnly: true },
        ],
        nextCursor: null,
      }),
    );
    const result = await chooseToolPatterns("acme", "core");
    if (!result.ok) throw new Error("expected a list");
    const [create, search] = result.value.options;
    expect(create).toEqual({
      value: `mcp.${NOTION_UUID}.notion-create-database@*`,
      label: "Create database",
      context: "Notion · every version",
      description: "Create a database in a page.",
      icon: { name: "Notion", url: "https://notion.so/icon.png" },
      facts: [
        { text: "Writes", tone: "approval" },
        { text: "High risk", tone: "denied" },
      ],
    });
    expect(search?.label).toBe("Search");
    expect(search?.facts?.[0]).toEqual({ text: "Read only", tone: "allowed" });
    for (const option of result.value.options) {
      const drawn = [
        option.label,
        option.context,
        option.detail,
        option.description,
      ].join(" ");
      expect(drawn).not.toContain(NOTION_UUID);
    }
    expect(result.value.namespaces).toEqual([
      {
        prefix: `mcp.${NOTION_UUID}.`,
        label: "Notion",
        icon: { name: "Notion", url: "https://notion.so/icon.png" },
      },
    ]);
  });

  it("still lists the tools when the server read is refused, without a logo (negative)", async () => {
    source.tools.mcpServers.mockResolvedValue(
      readError("mcp_servers_unavailable", 503),
    );
    source.tools.versions.mockResolvedValue(
      ok({ items: [notion("notion-search", 1)], nextCursor: null }),
    );
    const result = await chooseToolPatterns("acme", "core");
    if (!result.ok) throw new Error("expected a list");
    expect(result.value.partial).toBe(false);
    expect(result.value.options[0]).toMatchObject({
      label: "Notion search",
      context: "MCP server · every version",
    });
    expect(result.value.options[0]?.icon).toBeUndefined();
    expect(result.value.namespaces).toBeUndefined();
  });

  it("stops at ten pages and says the list is partial", async () => {
    source.tools.versions.mockResolvedValue(
      ok({ items: [version("stripe", 1)], nextCursor: "more" }),
    );
    const result = await chooseToolPatterns("acme", "core");
    expect(source.tools.versions).toHaveBeenCalledTimes(10);
    expect(result.ok && result.value.partial).toBe(true);
  });

  it("fails the list with the reason the page gave", async () => {
    source.tools.versions.mockResolvedValue(
      readError("tool_registry_unavailable", 503),
    );
    expect(await chooseToolPatterns("acme", "core")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "tool_registry_unavailable",
    });
  });

  it("carries a denial as a denial, not as an outage (negative)", async () => {
    source.tools.versions.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "tools.read",
    });
    expect(await chooseToolPatterns("acme", "core")).toEqual({
      ok: false,
      reason: "denied",
      code: "tools.read",
    });
  });
});

describe("chooseServerTools", () => {
  it("offers each tool name of one provider once, and no other provider's", async () => {
    source.tools.versions.mockResolvedValue(
      ok({
        items: [
          { ...version("notion_get", 1), name: "get_page", serverId: "mcs_1" },
          { ...version("notion_get", 2), name: "get_page", serverId: "mcs_1" },
          {
            ...version("gh_issue", 1),
            name: "create_issue",
            serverId: "mcs_2",
          },
          { ...version("local", 1), name: "local", serverId: null },
        ],
        nextCursor: null,
      }),
    );
    expect(await chooseServerTools("acme", "core", "mcs_1")).toEqual({
      ok: true,
      value: {
        partial: false,
        options: [{ value: "get_page", label: "Get page", detail: "get_page" }],
      },
    });
  });

  it("draws the provider's logo and drops its name from each title", async () => {
    source.tools.versions.mockResolvedValue(
      ok({ items: [notion("notion-fetch", 1)], nextCursor: null }),
    );
    const result = await chooseServerTools("acme", "core", "mcs_notion");
    expect(result.ok && result.value.options).toEqual([
      {
        value: "notion-fetch",
        label: "Fetch",
        detail: "notion-fetch",
        icon: { name: "Notion", url: "https://notion.so/icon.png" },
      },
    ]);
  });

  it("stops at ten pages and says the list is partial", async () => {
    source.tools.versions.mockResolvedValue(
      ok({
        items: [{ ...version("notion_get", 1), serverId: "mcs_1" }],
        nextCursor: "more",
      }),
    );
    const result = await chooseServerTools("acme", "core", "mcs_1");
    expect(source.tools.versions).toHaveBeenCalledTimes(10);
    expect(result.ok && result.value.partial).toBe(true);
  });

  it("fails the list with the reason the page gave (negative)", async () => {
    source.tools.versions.mockResolvedValue(
      readError("tool_registry_unavailable", 503),
    );
    expect(await chooseServerTools("acme", "core", "mcs_1")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "tool_registry_unavailable",
    });
  });
});

describe("chooseSwitchTargets", () => {
  it("offers a tool version by its title, server and version, keyed by its public id", async () => {
    source.tools.versions.mockResolvedValue(
      ok({
        items: [{ ...notion("notion-create-pages", 3), riskGrade: "critical" }],
        nextCursor: null,
      }),
    );
    const result = await chooseSwitchTargets("acme", "core", "tool_version");
    if (!result.ok) throw new Error("expected a list");
    expect(result.value.options).toEqual([
      {
        value:
          "tlv_mcp.7c084658-9d6d-480d-81eb-499322416dae.notion-create-pages3",
        label: "Create pages v3",
        context: "Notion · version 3 only",
        icon: { name: "Notion", url: "https://notion.so/icon.png" },
        facts: [
          { text: "May write", tone: "denied" },
          { text: "Critical risk", tone: "critical" },
        ],
      },
    ]);
  });
});

describe("chooseAgents", () => {
  it("never offers a retired agent", async () => {
    source.agents.list.mockResolvedValue(
      ok({
        agents: [
          {
            id: "agt_1",
            name: "Invoice bot",
            slug: "invoice-bot",
            status: "active",
          },
          { id: "agt_2", name: "Old bot", slug: "old-bot", status: "retired" },
        ],
        nextCursor: null,
      }),
    );
    const result = await chooseAgents("acme", "core");
    expect(result.ok && result.value.options).toEqual([
      { value: "agt_1", label: "Invoice bot", detail: "invoice-bot" },
    ]);
  });
});

describe("chooseApprovers", () => {
  it("offers the four roles, then members by name", async () => {
    source.org.members.mockResolvedValue(
      ok({ members: [{ id: "usr_1", name: null, email: "priya@acme.test" }] }),
    );
    const result = await chooseApprovers("acme");
    expect(result.ok && result.value.options.map((o) => o.value)).toEqual([
      "role:Owner",
      "role:Admin",
      "role:Compliance",
      "role:Billing",
      "user:usr_1",
    ]);
    expect(result.ok && result.value.options[4]?.label).toBe("priya@acme.test");
  });
});

describe("chooseModels", () => {
  it("lists a model once under its name and aliases", async () => {
    source.spend.priceBook.mockResolvedValue(
      ok({
        entries: [
          {
            model: "claude-sonnet-5",
            provider: "anthropic",
            modelAliases: ["sonnet", "claude-sonnet-5"],
          },
        ],
      }),
    );
    source.spend.unpricedModels.mockResolvedValue(
      ok({ models: [{ model: "sonnet", provider: null }] }),
    );
    const result = await chooseModels("acme", "core");
    expect(result.ok && result.value.options.map((o) => o.value)).toEqual([
      "claude-sonnet-5",
      "sonnet",
    ]);
    expect(result.ok && result.value.partial).toBe(false);
  });

  it("keeps the list it could read when one read fails", async () => {
    source.spend.priceBook.mockResolvedValue(
      readError("price_book_unavailable", 503),
    );
    source.spend.unpricedModels.mockResolvedValue(
      ok({ models: [{ model: "kimi-k2", provider: "moonshot" }] }),
    );
    const result = await chooseModels("acme", "core");
    expect(result).toEqual({
      ok: true,
      value: {
        partial: true,
        options: [{ value: "kimi-k2", label: "kimi-k2", detail: "moonshot" }],
      },
    });
  });
});
