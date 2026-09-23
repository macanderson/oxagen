// @vitest-environment jsdom
// The server half: the chrome renders what the source read for the context the
// layout resolved; the frame streams a skeleton and the pre-paint theme script.
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode, use } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import shellMessages from "../../../messages/shell.json";
import { shellData } from "./shell.builders";
import type { ShellData } from "./shell-data";

const { shellSource } = vi.hoisted(() => ({
  shellSource: vi.fn(() => Promise.resolve(shellData())),
}));
vi.mock("./source", () => ({ shellSource }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
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

describe("ShellChrome", () => {
  it("hands the client shell what the source read for the layout's context", async () => {
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
    const source = {
      pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
      shell: { context: vi.fn(), preferences: vi.fn() },
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
        transcript: vi.fn(),
        chain: vi.fn(),
        outputs: vi.fn(),
        work: vi.fn(),
        outcomesSettings: vi.fn(),
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
        sso: vi.fn(),
      },
      mandates: { list: vi.fn(), get: vi.fn() },
      audit: { events: vi.fn(), exportEvents: vi.fn() },
      skills: { inventory: vi.fn(), configuration: vi.fn() },
      steering: {
        records: vi.fn(),
        record: vi.fn(),
        proposals: vi.fn(),
        contextPr: vi.fn(),
        freshness: vi.fn(),
        hub: vi.fn(),
        deliveries: vi.fn(),
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
