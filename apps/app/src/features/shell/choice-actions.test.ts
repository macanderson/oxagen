// The lists the record pickers offer (choice-actions.ts), over a stubbed data
// source: a cursor read stops at its bound and says partial, a retired agent is
// never offered, each tool gets one `slug@*` row, a model named twice is listed
// once, one failed read of two leaves a partial list instead of none, and a
// refused read answers with the reason the store gave rather than a bare no.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";

const { source } = vi.hoisted(() => ({
  source: {
    tools: { versions: vi.fn() },
    agents: { list: vi.fn() },
    org: { members: vi.fn() },
    spend: { priceBook: vi.fn(), unpricedModels: vi.fn() },
  },
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("@/server/viewer", () => ({
  requireViewer: vi.fn(() => Promise.resolve({})),
}));

const { chooseAgents, chooseApprovers, chooseModels, chooseToolPatterns } =
  await import("./choice-actions");

const ok = <T>(value: T) => ({ ok: true as const, value });

function version(slug: string, v: number) {
  return { id: `tlv_${slug}${String(v)}`, slug, version: v, name: slug };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(result).toEqual({
      ok: true,
      value: {
        partial: false,
        options: [
          { value: "stripe@*", label: "stripe@*", detail: "stripe" },
          { value: "stripe@1", label: "stripe@1", detail: "stripe" },
          { value: "stripe@2", label: "stripe@2", detail: "stripe" },
        ],
      },
    });
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
