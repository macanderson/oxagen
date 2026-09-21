// @vitest-environment jsdom
// The Skills page body in each of its states on a fake DataSource: the loaded
// inventory, a later page, a window with nothing reported, each refusal a read
// can answer, and the skeleton. A row prints the name, the sessions that
// reported it out of the window's sessions, its harnesses and when it was last
// seen, and nothing the record does not carry; axe checks the state each test
// ends in (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInventory } from "@/data/contracts/skills";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/skills.json";

vi.mock("./actions", () => ({
  previewSkillSearch: vi.fn(),
  proposeSkillConfig: vi.fn(),
  importSkillConfig: vi.fn(),
  publishSkillConfig: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Skills } = await import("./skills");
const { SkillsLoading } = await import("./sections");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

function inventory(over: Partial<SkillInventory> = {}): SkillInventory {
  return {
    window: {
      from: "2026-08-16T12:00:00.000Z",
      to: "2026-09-15T12:00:00.000Z",
    },
    sessions: 5,
    reportedSessions: 4,
    notReportedSessions: 1,
    skills: [
      {
        name: "release-notes",
        sessions: 2,
        harnesses: ["claude-code", "codex"],
        harnessCount: 2,
        lastSeenAt: "2026-09-12T09:00:00.000Z",
      },
      {
        name: "triage",
        sessions: 1,
        harnesses: ["claude-code"],
        harnessCount: 1,
        lastSeenAt: "2026-09-10T09:00:00.000Z",
      },
    ],
    nextCursor: null,
    ...over,
  };
}

const read = vi.fn<DataSource["skills"]["inventory"]>();
const config = vi.fn<DataSource["skills"]["configuration"]>();
const source: DataSource = {
  pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
  shell: { context: vi.fn(), preferences: vi.fn() },
  billing: {
    plan: vi.fn(),
    usageCredits: vi.fn(),
    bucket: vi.fn(),
    contractRate: vi.fn(),
    invoices: vi.fn(),
  },
  runs: {
    list: vi.fn(),
    get: vi.fn(),
    frameBody: vi.fn(),
    cost: vi.fn(),
    transcript: vi.fn(),
    chain: vi.fn(),
  },
  approvals: { pending: vi.fn(), resolved: vi.fn() },
  agents: {
    list: vi.fn(),
    get: vi.fn(),
    toolbelt: vi.fn(),
    incidents: vi.fn(),
  },
  spend: {
    byGroup: vi.fn(),
    fleet: vi.fn(),
    drill: vi.fn(),
    waste: vi.fn(),
    budgets: vi.fn(),
    findings: vi.fn(),
    findingEvidence: vi.fn(),
    priceBook: vi.fn(),
    unpricedModels: vi.fn(),
  },
  onboarding: { state: vi.fn(), firstFrame: vi.fn() },
  org: {
    members: vi.fn(),
    roles: vi.fn(),
    workspaces: vi.fn(),
    apiKeys: vi.fn(),
    modelCredential: vi.fn(),
  },
  skills: { inventory: read, configuration: config },
  mandates: { list: vi.fn(), get: vi.fn() },
  audit: { events: vi.fn(), exportEvents: vi.fn() },
  steering: {
    records: vi.fn(),
    proposals: vi.fn(),
    contextPr: vi.fn(),
    freshness: vi.fn(),
  },
  tools: {
    versions: vi.fn(),
    grants: vi.fn(),
    killSwitches: vi.fn(),
    approvalRules: vi.fn(),
    connections: vi.fn(),
    mcpServers: vi.fn(),
  },
};

function withIntl(element: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {element}
    </NextIntlClientProvider>,
  );
}

async function renderSkills(cursor: string | null = null) {
  return withIntl(await Skills({ ctx, source, cursor }));
}

function state(): string | null {
  return (
    document.querySelector<HTMLElement>("[data-state]")?.dataset.state ?? null
  );
}

beforeEach(() => {
  read.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Skills › loaded", () => {
  it.each([20, 23])(
    "shows omitted harness names only above the cap (%s)",
    async (count) => {
      const model = inventory();
      const [first] = model.skills;
      if (!first) throw new Error("inventory() must hold at least one skill");
      model.skills = [
        {
          ...first,
          harnesses: Array.from(
            { length: 20 },
            (_, index) => `harness-${String(index)}`,
          ),
          harnessCount: count,
        },
      ];
      read.mockResolvedValue(readOk(model));
      await renderSkills();
      if (count > 20) expect(screen.getByText("+3 more")).toBeVisible();
      else expect(document.querySelector("[data-harness-omitted]")).toBeNull();
    },
  );

  it("states the window and its counts, and prints each reported name with its sessions, harnesses and last sighting", async () => {
    read.mockResolvedValue(readOk(inventory()));
    await renderSkills();

    expect(read).toHaveBeenCalledExactlyOnceWith(ctx, { cursor: null });
    expect(state()).toBe("loaded");
    expect(document.body).toHaveTextContent(
      "Skills are steering, and they are files. Oxagen does not run a skill: the harness does.",
    );
    const section = screen.getByRole("region", {
      name: "Skills sessions reported",
    });
    expect(section).toHaveTextContent(
      "Sessions started Aug 16, 2026 to Sep 15, 2026: 5 sessions.",
    );
    expect(section).toHaveTextContent("4 sessions reported their skills.");
    expect(section).toHaveTextContent("1 session reported no inventory.");

    const list = screen.getByRole("list", {
      name: "Skills reported in this window",
    });
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((li) => li.hasAttribute("data-skill"));
    expect(rows.map((row) => row.dataset.skill)).toEqual([
      "release-notes",
      "triage",
    ]);
    const [notes] = rows;
    expect(notes).toHaveTextContent("2 of 5 sessions");
    expect(notes).toHaveTextContent("Last seen Sep 12, 2026");
    expect(
      within(notes ?? document.body)
        .getByRole("list", { name: "Harnesses" })
        .querySelectorAll("[data-harness]"),
    ).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
  });

  it("prints no version, digest, cost or decision the record does not carry (negative)", async () => {
    read.mockResolvedValue(readOk(inventory()));
    await renderSkills();
    const body = document.body.textContent;
    expect(body).not.toMatch(/\$|@\d|sha256|digest|allowed|denied|tokens?\b/i);
  });

  it("links the next page of the inventory by its cursor, and reads the page the URL names", async () => {
    read.mockResolvedValue(readOk(inventory({ nextCursor: "c2" })));
    await renderSkills("c1");
    expect(read).toHaveBeenCalledWith(ctx, { cursor: "c1" });
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/acme/core-platform/steering?tab=skills&cursor=c2",
    );
  });
});

describe("Skills › empty", () => {
  it("says no session reported an inventory, never that zero sessions reported, with the enroll hint", async () => {
    read.mockResolvedValue(
      readOk(
        inventory({
          sessions: 2,
          reportedSessions: null,
          notReportedSessions: 2,
          skills: [],
        }),
      ),
    );
    await renderSkills();
    expect(state()).toBe("empty");
    expect(
      screen.getByRole("heading", { name: "No skill reported in this window" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No session in this window reported its skills."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 sessions reported no inventory."),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("0 sessions reported their");
    expect(screen.getByText("oxagen agent enroll").tagName).toBe("CODE");
  });

  it("renders the empty state when sessions reported inventories that named no skill", async () => {
    read.mockResolvedValue(
      readOk(
        inventory({
          sessions: 3,
          reportedSessions: 3,
          notReportedSessions: 0,
          skills: [],
        }),
      ),
    );
    await renderSkills();
    expect(state()).toBe("empty");
    expect(
      screen.getByText("3 sessions reported their skills."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("Skills › refusals", () => {
  it("renders denied with the permission and the way back to Fleet", async () => {
    read.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "skills.read",
    });
    await renderSkills();
    expect(state()).toBe("denied");
    expect(
      screen.getByRole("heading", {
        name: "You cannot see the skills of this workspace",
      }),
    ).toBeInTheDocument();
    expect(document.body).toHaveTextContent("skills.read");
    expect(screen.getByRole("link", { name: "Back to Fleet" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(screen.queryByRole("link", { name: "Try again" })).toBeNull();
  });

  it("renders a pending approval with its request, not as a refusal", async () => {
    read.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_01k5",
    });
    await renderSkills();
    expect(state()).toBe("pending_approval");
    expect(document.body).toHaveTextContent("Access request acr_01k5");
  });

  it("renders error with its code and Try again on the same page", async () => {
    read.mockResolvedValue(readError("session_store_unavailable", 503));
    await renderSkills("c1");
    expect(state()).toBe("error");
    expect(
      screen.getByRole("heading", { name: "Skills could not be loaded" }),
    ).toBeInTheDocument();
    expect(document.body).toHaveTextContent("session_store_unavailable · 503");
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/acme/core-platform/steering?tab=skills&cursor=c1",
    );
  });
});

describe("Skills › loading", () => {
  it("renders a busy skeleton with no figures", () => {
    withIntl(<SkillsLoading />);
    const skeleton = screen.getByRole("region", { name: "Loading skills" });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton).toHaveAttribute("data-state", "loading");
    expect(skeleton.textContent).toBe("");
  });
});

it("reads configuration only on Search and Versions, with refusal in the selected view", async () => {
  config.mockResolvedValue(readError("config_unavailable", 503));
  read.mockClear();
  withIntl(await Skills({ ctx, source, cursor: null, view: "search" }));
  expect(config).toHaveBeenCalledWith(ctx);
  expect(read).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Preview search" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    "/acme/core-platform/steering?tab=skills&view=search",
  );
});
