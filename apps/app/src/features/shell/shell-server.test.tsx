// @vitest-environment jsdom
// The server half: the chrome renders what the source read for the context the
// layout resolved; the frame streams a skeleton and the pre-paint theme script.
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode, use } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import shellMessages from "../../../messages/shell.json";
import { approvalItem, shellData, shellWorkspace } from "./shell.builders";
import type { ShellData } from "./shell-data";

const { shellSource, ApprovalCardAlone } = vi.hoisted(() => ({
  shellSource: vi.fn(),
  ApprovalCardAlone: vi.fn((_props: unknown) => null),
}));
vi.mock("./source", () => ({ shellSource }));
// The card is the Fleet lane's; the chrome only renders it once per parked
// call, alone, with no Fleet panel (heading, parked count, grid) around it.
vi.mock("@/features/fleet", () => ({ ApprovalCardAlone }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
// The page-name provider reads the client router and the intl catalogue,
// neither of which a server render test mounts; route-page-name.test.tsx
// covers it on its own.
vi.mock("./route-page-name", () => ({
  ShellRoutePageName: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

vi.mock("next-intl/server", () => ({
  getTranslations: () =>
    Promise.resolve((key: string) => {
      const value: unknown = Reflect.get(shellMessages.shell, key);
      if (typeof value !== "string") throw new Error(`missing shell.${key}`);
      return value;
    }),
}));

// The first import of the chrome pulls the whole shell graph through jsdom. On
// the CI runner that alone outlasted the first test's 5s budget, so load it once
// here; each test's own `await import` then resolves from the module cache.
beforeAll(async () => {
  await import("./shell-chrome");
}, 30_000);

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

/** A DataSource whose every read is a bare mock; ShellChrome reads it only through shellSource. */
function stubSource() {
  return {
    runtimes: { list: vi.fn(), agents: vi.fn() },
    conversations: { latest: vi.fn() },
    pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
    shell: {
      context: vi.fn(),
      preferences: vi.fn(),
      counts: vi.fn(),
      notifications: vi.fn(),
      assistantEngine: vi.fn(),
    },
    billing: {
      plan: vi.fn(),
      usageCredits: vi.fn(),
      retention: vi.fn(),
      bucket: vi.fn(),
      contractRate: vi.fn(),
      invoices: vi.fn(),
    },
    runs: {
      list: vi.fn(),
      get: vi.fn(),
      frameBody: vi.fn(),
      cost: vi.fn(),
      turns: vi.fn(),
      transcript: vi.fn(),
      chain: vi.fn(),
      outputs: vi.fn(),
      work: vi.fn(),
      outcomesSettings: vi.fn(),
    },
    approvals: {
      pending: vi.fn(),
      resolved: vi.fn(),
      resolvedSince: vi.fn(),
    },
    interjections: { open: vi.fn() },
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
      gatewayPolicy: vi.fn(),
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
      costCenters: vi.fn(),
      modelCredential: vi.fn(),
      dataPlane: vi.fn(),
      workspaceFacts: vi.fn(),
      sso: vi.fn(),
    },
    mandates: { list: vi.fn(), get: vi.fn() },
    audit: {
      events: vi.fn(),
      exportEvents: vi.fn(),
      retention: vi.fn(),
      bundle: vi.fn(),
    },
    skills: { inventory: vi.fn(), configuration: vi.fn() },
    steering: {
      records: vi.fn(),
      record: vi.fn(),
      proposals: vi.fn(),
      contextPr: vi.fn(),
      freshness: vi.fn(),
      hub: vi.fn(),
      deliveries: vi.fn(),
      memories: vi.fn(),
      tree: vi.fn(),
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
}

describe("ShellChrome", () => {
  it("hands the client shell what the source read for the layout's context", async () => {
    shellSource.mockResolvedValue({
      data: shellData(),
      cards: { mandates: new Map() },
    });
    const { ShellChrome } = await import("./shell-chrome");
    const { OrgCtx } = await import("@/server/viewer");
    const { unsafeMint } = await import("@/server/viewer.testing");
    const ctx = unsafeMint(OrgCtx, {
      userId: "usr_marcusbell",
      orgId: "7a000000-0000-4000-8000-0000000000a1",
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole: "owner",
    });
    const source = stubSource();
    // The chrome is wrapped in the viewer's zone, so its own dates agree with
    // the page's; the client shell is the provider's one child.
    const element: ReactElement<{
      timeZone: string;
      children: ReactElement<{ data: ShellData }>;
    }> = await ShellChrome({
      ctx,
      source,
    });
    expect(isValidElement(element)).toBe(true);
    expect(element.props.timeZone).toBe(shellData().viewer.timeZone);
    expect(isValidElement(element.props.children)).toBe(true);
    expect(element.props.children.props.data).toEqual(shellData());
    expect(shellSource).toHaveBeenCalledWith(ctx, source);
  });

  it("renders the Fleet lane's card once per parked call, with that workspace's mandates", async () => {
    const { ShellChrome } = await import("./shell-chrome");
    const { OrgCtx } = await import("@/server/viewer");
    const { unsafeMint } = await import("@/server/viewer.testing");
    const { readOk } = await import("@/data/read");
    const mandates = new Map([["mnd_7K2ETQ4", { id: "mnd_7K2ETQ4" }]]);
    const item = approvalItem({ mandateId: "mnd_7K2ETQ4" });
    shellSource.mockResolvedValue({
      data: shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              slug: "finops",
              name: "FinOps",
              pending: readOk({ items: [item], more: false }),
            }),
          ],
          truncated: false,
          readAt: 1,
        },
      }),
      cards: { mandates: new Map([["finops", mandates]]) },
    });
    const ctx = unsafeMint(OrgCtx, {
      userId: "usr_marcusbell",
      orgId: "7a000000-0000-4000-8000-0000000000a1",
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole: "owner",
    });
    const element: ReactElement<{
      children: ReactElement<{ cards: Record<string, ReactElement> }>;
    }> = await ShellChrome({ ctx, source: stubSource() });
    const cards = element.props.children.props.cards;
    expect(Object.keys(cards)).toEqual([item.id]);
    expect(cards[item.id]?.type).toBe(ApprovalCardAlone);
    expect(cards[item.id]?.props).toMatchObject({
      item,
      mandates,
      now: 1,
      org: "acme",
      ws: "finops",
    });
  });
});

describe("ShellFrame", () => {
  it("renders the page beside the chrome, with the pre-paint theme script", async () => {
    const { ShellFrame } = await import("./shell-frame");
    const { THEME_SCRIPT } = await import("./theme");
    const { container } = render(
      await ShellFrame({
        chrome: <p>chrome</p>,
        children: <main id="main">page</main>,
      }),
    );
    expect(screen.getByTestId("shell")).toBeInTheDocument();
    expect(screen.getByText("chrome")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("page");
    expect(container.querySelector("script")?.innerHTML).toBe(THEME_SCRIPT);
  });

  it("paints the workspace on the content-panel token, not the page canvas", async () => {
    // AGENTS.md "Design Token Usage in Shell Components": the shell frame is
    // the reskin knob for the content panel. A dark-mode pass once moved it
    // to `bg-app-canvas`, which put the workspace on the black page canvas
    // and took the frame out of reach of a `--app-panel-bg` change.
    const { ShellFrame } = await import("./shell-frame");
    render(await ShellFrame({ chrome: <p>chrome</p>, children: null }));
    const shell = screen.getByTestId("shell");
    expect(shell.className).toContain("bg-app-panel-bg");
    expect(shell.className).not.toContain("bg-app-canvas");
  });

  it("puts the page body on the ink in the dark theme, as the design's body and viewport are", () => {
    // engine.css: `body` and `#viewport` sit on `--ink` and `.main` draws no
    // fill, so the token the frame paints with is the ink in both dark
    // blocks (the `.dark` class and the system preference before the theme
    // script runs). Panels and drawers stay on the panel.
    // Vitest runs from apps/app, as messages/ is read in src/i18n/request.ts.
    const css = readFileSync(
      path.join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    const declarations = [...css.matchAll(/--app-panel-bg:\s*([^;]+);/g)].map(
      (match) => match[1],
    );
    expect(declarations).toEqual(["var(--ink)", "var(--ink)"]);
  });

  it("keeps the drawers on a raised token that the app's ink does not move", () => {
    // The drawers, the flyout and the phone bar's count pills paint with
    // `--app-raised-bg`. The house kit maps it to the card and gives it a
    // Tailwind colour. The app leaves it alone, so the ink stays behind them.
    const kit = readFileSync(
      path.join(process.cwd(), "../../packages/ui/src/styles/globals.css"),
      "utf8",
    );
    expect(kit).toMatch(/--app-raised-bg:\s*var\(--card\);/);
    expect(kit).toMatch(/--color-app-raised-bg:\s*var\(--app-raised-bg\);/);
    const app = readFileSync(
      path.join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(app).not.toMatch(/--app-raised-bg:/);
  });

  it("streams a labelled skeleton while the chrome loads", async () => {
    const { ShellFrame } = await import("./shell-frame");
    const pending = new Promise<never>(() => undefined);
    function PendingChrome(): ReactNode {
      return use(pending);
    }
    render(await ShellFrame({ chrome: <PendingChrome />, children: null }));
    expect(screen.getByTestId("shell-loading")).toHaveTextContent(
      "Loading Oxagen",
    );
  });
});
