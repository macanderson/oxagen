// @vitest-environment jsdom
// The three Tools writes as a person makes them: the import dialog's three
// steps (Connect, Review tools/list, Classify and import), the tool dialog's
// reclassification form, and the switch dialog — which states the
// blast radius before the confirming button, never after. A completed write
// reloads the view it leads to; a refusal is named where the person acted and
// navigates nowhere. Every refusal code the three handlers throw has its own
// sentence. Each state gets an axe check.
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@/data/contracts/tools";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  importTools,
  registerServer,
  setToolClassification,
  flipKillSwitch,
  chooseSwitchTargets,
  chooseServerTools,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  importTools: vi.fn(),
  registerServer: vi.fn(),
  setToolClassification: vi.fn(),
  flipKillSwitch: vi.fn(),
  chooseSwitchTargets: vi.fn(),
  chooseServerTools: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  importTools,
  registerServer,
  setToolClassification,
  flipKillSwitch,
}));
vi.mock("@/features/shell/client", () => ({
  chooseSwitchTargets,
  chooseServerTools,
}));
// The wizard opens on the registry browser; these paths use the other sources.
vi.mock("./provider-auth-actions", () => ({
  searchRegistry: vi.fn().mockResolvedValue({
    ok: true,
    value: { servers: [], nextCursor: null, registryReachable: true },
  }),
  startProviderAuthorization: vi.fn(),
  providerRedirectUrl: vi.fn().mockResolvedValue({
    ok: true,
    value: { redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback" },
  }),
}));

const { ImportProvider } = await import("./import-provider");
const { ToolDialog } = await import("./tool-dialog");
const { splitTags, versionLabel } = await import("./view");
const { FlipControls } = await import("./switch-controls");
const { useActionFailure } = await import("./action-failure");
const { toolVersionPage, killSwitchBoard } = await import("./tools.builders");

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}
const formOf = (node: HTMLElement) => element(node.closest("form"), "form");

const at = { org: "acme", ws: "core-platform" };
const SWITCHES = "/acme/core-platform/tools/switches";
const GENERATION = { org: 12, workspace: 4 };
/** The operator level's picker (#3147): one member, so its option is unambiguous. */
const MEMBERS = [
  { id: "usr_finops1", name: "Priya Shah", email: "priya@acme.example" },
];

/** The nth record of a fixture page, or a failure naming which one was missing. */
function nth<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no ${what}`);
  return item;
}
const financial = () => nth(toolVersionPage().items, 0, "financial version");
const plain = () => nth(toolVersionPage().items, 1, "unclassified version");
const classSwitch = () => nth(killSwitchBoard().switches, 0, "class switch");
/** Index 2: the tool-server switch, one of the four the record writes under the workspace. */
const clearedSwitch = () =>
  nth(killSwitchBoard().switches, 2, "workspace-scoped switch");

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

function withIntl(element: ReactNode) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Types into a record picker and presses Enter, as a person picks a row. */
function pick(label: string, typed: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/** What a record picker's hidden input submits under `name`. */
function submitted(name: string): string | undefined {
  return document.querySelector<HTMLInputElement>(
    `input[type="hidden"][name="${name}"]`,
  )?.value;
}

/** A picker read that answered with these rows. */
function loaded(options: { value: string; label: string; detail?: string }[]) {
  return { ok: true, value: { options, partial: false } };
}

beforeEach(() => {
  for (const fn of [
    router.replace,
    router.refresh,
    importTools,
    registerServer,
    setToolClassification,
    flipKillSwitch,
  ]) {
    fn.mockReset();
  }
  chooseSwitchTargets.mockReset().mockResolvedValue(loaded([]));
  chooseServerTools.mockReset().mockResolvedValue(loaded([]));
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

// splitTags and versionLabel live in view.ts, not in a "use client" module:
// the registry table is a Server Component and calls versionLabel directly.
describe("splitTags", () => {
  it("splits on commas and whitespace, drops blanks and keeps each tag once", () => {
    expect(splitTags(" moves_money, destroys_data  moves_money ")).toEqual([
      "moves_money",
      "destroys_data",
    ]);
    expect(splitTags("   ")).toEqual([]);
  });
});

describe("versionLabel", () => {
  it("is the one spelling of a version's identity", () => {
    expect(versionLabel(financial())).toBe("stripe__create_payment@4");
  });
});

describe("ImportProvider", () => {
  const ROSTER = [
    { id: "mcs_01k5s1", name: "Stripe" },
    { id: "mcs_01k5s2", name: "GitHub" },
  ];

  function open(servers: readonly { id: string; name: string }[] | null) {
    withIntl(<ImportProvider at={at} servers={servers} />);
    fireEvent.click(screen.getByTestId("tools-import-open"));
    return screen.getByTestId("tools-import-dialog");
  }

  it("walks the three steps in order, naming the one the person is on", () => {
    const dialog = open(ROSTER);
    const steps = within(dialog).getByRole("list", { name: "Import steps" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual(["1 Connect", "2 Review tools/list", "3 Classify and import"]);
    expect(within(steps).getByText("1 Connect")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("imports the tools picked for a provider off the roster, by its id, and reloads the registry", async () => {
    chooseServerTools.mockResolvedValue({
      ok: true,
      value: {
        options: [{ value: "get_page", label: "get_page", detail: "notion" }],
        partial: false,
      },
    });
    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 2, unchanged: 1 },
    });
    open(ROSTER);
    // The picker shows the provider's name; what goes to the kernel is the id
    // `import_tools` names a provider by, never the name a person reads.
    fireEvent.click(screen.getByTestId("tools-import-source-existing"));
    fill("Provider", "mcs_01k5s2");
    fireEvent.submit(formOf(screen.getByLabelText("Provider")));
    // The tools field offers the names this provider's versions carry, found
    // by typing part of one, and takes a pin never imported as typed.
    const tools = screen.getByRole("combobox", { name: "Tools" });
    fireEvent.focus(tools);
    expect(chooseServerTools).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "mcs_01k5s2",
    );
    fireEvent.change(tools, { target: { value: "get_p" } });
    expect(
      await screen.findByRole("option", { name: /get_page/ }),
    ).toBeVisible();
    fireEvent.keyDown(tools, { key: "Enter" });
    fireEvent.change(tools, { target: { value: "create_page," } });
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    expect(
      screen.getByText("What import does not do.", { exact: false }),
    ).toBeVisible();
    fireEvent.click(screen.getByTestId("tools-import-confirm"));
    await waitFor(() => {
      expect(importTools).toHaveBeenCalledWith("acme", "core-platform", {
        serverId: "mcs_01k5s2",
        tools: ["get_page", "create_page"],
      });
    });
    // The page behind re-reads in place: moving to another tab would unmount
    // a dialog opened from a tab's own panel before its receipt is read.
    expect(router.refresh).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(await screen.findByTestId("tools-import-done")).toHaveTextContent(
      "2 new versions · 1 already registered.",
    );
  });

  it("imports every pin when no name is typed, and says so before it runs", async () => {
    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 1, unchanged: 0 },
    });
    open(ROSTER);
    fireEvent.click(screen.getByTestId("tools-import-source-existing"));
    fill("Provider", "mcs_01k5s1");
    fireEvent.submit(formOf(screen.getByLabelText("Provider")));
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    expect(screen.getByText("Every tool the provider pins.")).toBeVisible();
    fireEvent.click(screen.getByTestId("tools-import-confirm"));
    await waitFor(() => {
      expect(importTools).toHaveBeenCalledWith("acme", "core-platform", {
        serverId: "mcs_01k5s1",
        tools: [],
      });
    });
  });

  it("connects a new provider, offers every tool it listed, and imports only the ones left checked", async () => {
    registerServer.mockResolvedValue({
      ok: true,
      value: {
        serverId: "mcs_01k5s9",
        healthStatus: "healthy",
        discoveredTools: ["get_page", "create_page"],
      },
    });
    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d2", published: 1, unchanged: 0 },
    });
    open([]);
    fireEvent.click(screen.getByTestId("tools-import-source-custom"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fill("Auth", "none");
    fireEvent.submit(formOf(screen.getByLabelText("Name")));
    await waitFor(() => {
      expect(registerServer).toHaveBeenCalledWith("acme", "core-platform", {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "none",
        authConfig: {},
      });
    });
    // The provider exists now whether or not anything is imported.
    expect(router.refresh).toHaveBeenCalled();
    expect(await screen.findByText("Review tools/list")).toBeVisible();
    expect(screen.getByTestId("tools-import-selected")).toHaveTextContent(
      "2 of 2 selected",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "create_page" }));
    expect(screen.getByTestId("tools-import-selected")).toHaveTextContent(
      "1 of 2 selected",
    );
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    fireEvent.click(screen.getByTestId("tools-import-confirm"));
    await waitFor(() => {
      expect(importTools).toHaveBeenCalledWith("acme", "core-platform", {
        serverId: "mcs_01k5s9",
        tools: ["get_page"],
      });
    });
  });

  it("offers no Classify while every listed tool is unchecked (negative)", async () => {
    registerServer.mockResolvedValue({
      ok: true,
      value: {
        serverId: "mcs_01k5s9",
        healthStatus: "healthy",
        discoveredTools: ["get_page"],
      },
    });
    open(null);
    fireEvent.click(screen.getByTestId("tools-import-source-custom"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fill("Auth", "none");
    fireEvent.submit(formOf(screen.getByLabelText("Name")));
    fireEvent.click(await screen.findByRole("checkbox", { name: "get_page" }));
    expect(screen.getByTestId("tools-import-classify")).toBeDisabled();
  });

  it("names a refused connect where the person acted and moves to no later step", async () => {
    registerServer.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    open([]);
    fireEvent.click(screen.getByTestId("tools-import-source-custom"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fill("Auth", "none");
    fireEvent.submit(formOf(screen.getByLabelText("Name")));
    expect(await screen.findByTestId("tools-import-failure")).toHaveTextContent(
      "This needs an organization Owner or Admin.",
    );
    expect(screen.queryByText("Review tools/list")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names a refused import and navigates nowhere", async () => {
    importTools.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    open(ROSTER);
    fireEvent.click(screen.getByTestId("tools-import-source-existing"));
    fill("Provider", "mcs_01k5s1");
    fireEvent.submit(formOf(screen.getByLabelText("Provider")));
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    fireEvent.click(screen.getByTestId("tools-import-confirm"));
    expect(await screen.findByTestId("tools-import-failure")).toHaveTextContent(
      "This needs an organization Owner or Admin.",
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered", async () => {
    importTools.mockRejectedValue(new Error("network"));
    open(ROSTER);
    fireEvent.click(screen.getByTestId("tools-import-source-existing"));
    fill("Provider", "mcs_01k5s1");
    fireEvent.submit(formOf(screen.getByLabelText("Provider")));
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    fireEvent.click(screen.getByTestId("tools-import-confirm"));
    expect(await screen.findByTestId("tools-import-failure")).toHaveTextContent(
      "action_failed",
    );
  });
});

describe("ToolDialog", () => {
  it("opens on the row and prints what the version's record carries", async () => {
    withIntl(
      <ToolDialog at={at} version={financial()} canClassify>
        <span>Create payment</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Create payment"));
    const dialog = within(await screen.findByTestId("tool-dialog"));
    expect(dialog.getByText("mcp.stripe.create_payment")).toBeInTheDocument();
    expect(dialog.getByText("Imported from a provider")).toBeInTheDocument();
    // The `tlv_…` a tool-version kill switch names: the switch dialog asks for
    // it, so the registry has to be somewhere a person can read it off.
    expect(dialog.getByText("tlv_01k5a1")).toBeInTheDocument();
    expect(
      dialog.getByText("a1b2c3d4e5f60718293a4b5c6d7e8f90"),
    ).toBeInTheDocument();
    expect(dialog.getByText("amount $.amount")).toBeInTheDocument();
  });

  it("says a version is not classified yet rather than showing a blank", async () => {
    withIntl(
      <ToolDialog at={at} version={plain()} canClassify={false}>
        <span>Get file contents</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Get file contents"));
    const dialog = within(await screen.findByTestId("tool-dialog"));
    expect(dialog.getByText("Not classified yet")).toBeInTheDocument();
    expect(
      dialog.getByText(
        "Reclassifying a tool version needs an organization Owner or Admin.",
      ),
    ).toBeInTheDocument();
  });

  it("reclassifies the version, carrying its measures through unchanged", async () => {
    setToolClassification.mockResolvedValue({
      ok: true,
      value: { classifiedAt: "2026-09-16T09:00:00.000Z" },
    });
    withIntl(
      <ToolDialog at={at} version={financial()} canClassify>
        <span>Create payment</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Create payment"));
    await screen.findByTestId("tool-dialog");
    fireEvent.change(screen.getByLabelText("Risk grade"), {
      target: { value: "high" },
    });
    fill("Consequence tags", "moves_money, changes_access");
    fill("Reason", "Narrowed after the audit.");
    fireEvent.submit(formOf(screen.getByText("Reclassify this version")));
    await waitFor(() => {
      expect(setToolClassification).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        {
          toolVersionId: "tlv_01k5a1",
          riskGrade: "high",
          sideEffect: "irreversible",
          egress: "third_party",
          consequenceTags: ["moves_money", "changes_access"],
          // The round trip: the data classes were not touched, so they come
          // back byte for byte — the multiword one included.
          dataClasses: ["customer financial data", "payment"],
          measures: financial().classification?.measures,
          reason: "Narrowed after the audit.",
        },
      );
    });
    // It refreshes where it stands, so a classify from the Providers tab
    // stays on Providers (#3800).
    expect(router.refresh).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("keeps a multiword data class whole when the person edits it", async () => {
    setToolClassification.mockResolvedValue({
      ok: true,
      value: { classifiedAt: "2026-09-16T09:00:00.000Z" },
    });
    withIntl(
      <ToolDialog at={at} version={financial()} canClassify>
        <span>Create payment</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Create payment"));
    await screen.findByTestId("tool-dialog");
    // One class per line, so a class may contain spaces and commas.
    fill("Data classes", "customer financial data\npayment, refunds\n\n");
    fill("Reason", "The refund path was added.");
    fireEvent.submit(formOf(screen.getByText("Reclassify this version")));
    await waitFor(() => {
      expect(setToolClassification).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        expect.objectContaining({
          dataClasses: ["customer financial data", "payment, refunds"],
        }),
      );
    });
  });

  it("classifies a version that had none from the form's defaults, with no measure to carry", async () => {
    setToolClassification.mockResolvedValue({
      ok: true,
      value: { classifiedAt: "2026-09-16T09:00:00.000Z" },
    });
    withIntl(
      <ToolDialog at={at} version={plain()} canClassify>
        <span>Get file contents</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Get file contents"));
    await screen.findByTestId("tool-dialog");
    // An unclassified version opens on the narrowest axes, never blank ones.
    expect(screen.getByLabelText("Side effect")).toHaveValue("read");
    expect(screen.getByLabelText("Egress")).toHaveValue("local");
    expect(screen.getByLabelText("Consequence tags")).toHaveValue("");
    fill("Reason", "First classification.");
    fireEvent.submit(formOf(screen.getByText("Reclassify this version")));
    await waitFor(() => {
      expect(setToolClassification).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        {
          toolVersionId: "tlv_01k5a2",
          riskGrade: "low",
          sideEffect: "read",
          egress: "local",
          consequenceTags: [],
          dataClasses: [],
          measures: [],
          reason: "First classification.",
        },
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tool-dialog")).not.toBeInTheDocument();
    });
  });

  it("names a reclassification that threw before it answered, and keeps the dialog open", async () => {
    setToolClassification.mockRejectedValue(new Error("network"));
    withIntl(
      <ToolDialog at={at} version={financial()} canClassify>
        <span>Create payment</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Create payment"));
    await screen.findByTestId("tool-dialog");
    fill("Reason", "x");
    fireEvent.submit(formOf(screen.getByText("Reclassify this version")));
    expect(
      await screen.findByTestId("tool-classify-failure"),
    ).toHaveTextContent("action_failed");
    expect(screen.getByTestId("tool-dialog")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a refusal on the form", async () => {
    setToolClassification.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "tool_version_not_found",
    });
    withIntl(
      <ToolDialog at={at} version={financial()} canClassify>
        <span>Create payment</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Create payment"));
    await screen.findByTestId("tool-dialog");
    fill("Reason", "x");
    fireEvent.submit(formOf(screen.getByText("Reclassify this version")));
    expect(
      await screen.findByTestId("tool-classify-failure"),
    ).toHaveTextContent("No tool version has that id in this workspace.");
  });
});

describe("FlipControls", () => {
  it("states the blast radius before the confirming button, and flips the level the person picked", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_new",
        on: true,
        changed: true,
        denyGeneration: { org: 13, workspace: 4 },
        grantsRevoked: 0,
      },
    });
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    const radius = within(dialog).getByTestId("tools-flip-blast-radius");
    expect(radius).toHaveTextContent("Blast radius");
    expect(radius).toHaveTextContent(
      "Every tool version carrying this consequence tag",
    );
    // The blast radius is above the confirming button in the document.
    expect(
      radius.compareDocumentPosition(within(dialog).getByText("Deny now")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(dialog).getByText(/deny generation 12 → 13/)).toBeVisible();

    pick("Target", "moves_money");
    fill(/^Reason/, "Suspected compromise.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    await waitFor(() => {
      expect(flipKillSwitch).toHaveBeenCalledWith("acme", "core-platform", {
        kind: "class",
        target: "moves_money",
        on: true,
        reason: "Suspected compromise.",
      });
    });
    expect(router.replace).toHaveBeenCalledWith(SWITCHES);
  });

  it("changes the blast radius with the level, and names what a connection switch also revokes", async () => {
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "connection" },
    });
    expect(screen.getByTestId("tools-flip-blast-radius")).toHaveTextContent(
      "live grants are revoked with the flip",
    );
    expect(
      screen.getByText(
        "A connection switch also revokes every credential grant that drew on it.",
      ),
    ).toBeVisible();
  });

  it("clears a switch that is on, and says what that restores", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_01k5c1",
        on: false,
        changed: true,
        denyGeneration: { org: 13, workspace: 4 },
        grantsRevoked: 0,
      },
    });
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={classSwitch()}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-emd_01k5c1"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    expect(
      within(dialog).getByTestId("tools-flip-blast-radius"),
    ).toHaveTextContent("What this restores");
    fill(/^Reason/, "Rotation confirmed.");
    fireEvent.submit(formOf(within(dialog).getByText("Allow again")));
    await waitFor(() => {
      expect(flipKillSwitch).toHaveBeenCalledWith("acme", "core-platform", {
        kind: "class",
        target: "moves_money",
        on: false,
        reason: "Rotation confirmed.",
      });
    });
  });

  it("flips a switch that is off back on, on its own scope's generation", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "store_down",
    });
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={clearedSwitch()}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-emd_01k5c3"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    expect(within(dialog).getByText(/deny generation 4 → 5/)).toBeVisible();
    fill(/^Reason/, "Halt the server.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    expect(await screen.findByTestId("tools-flip-failure")).toHaveTextContent(
      "store_down",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("makes the header's generation claim conditional, and says so when nothing changed", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_01k5c1",
        on: true,
        // The target was already denied at this level: the kernel wrote
        // nothing and no generation advanced.
        changed: false,
        denyGeneration: { org: 12, workspace: 4 },
        grantsRevoked: 0,
      },
    });
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    // The header names a target it cannot know the state of, so it promises
    // the bump only if the flip changes the switch.
    expect(
      within(dialog).getByText(/if this flip changes the switch/),
    ).toBeVisible();

    pick("Target", "moves_money");
    fill(/^Reason/, "Suspected compromise.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    expect(await screen.findByTestId("tools-flip-unchanged")).toHaveTextContent(
      "no deny generation advanced",
    );
    // Nothing moved, so the dialog does not close on a reload that shows the
    // same board.
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("forgets that nothing changed once the dialog is closed, so the next flip starts clean", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_01k5c1",
        on: true,
        changed: false,
        denyGeneration: { org: 12, workspace: 4 },
        grantsRevoked: 0,
      },
    });
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fill("Target", "moves_money");
    fill(/^Reason/, "Suspected compromise.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    await screen.findByTestId("tools-flip-unchanged");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("tools-flip-dialog")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    await screen.findByTestId("tools-flip-dialog");
    expect(
      screen.queryByTestId("tools-flip-unchanged"),
    ).not.toBeInTheDocument();
  });

  it("names a flip that threw before it answered, and navigates nowhere", async () => {
    flipKillSwitch.mockRejectedValue(new Error("network"));
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fill("Target", "moves_money");
    fill(/^Reason/, "Suspected compromise.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    expect(await screen.findByTestId("tools-flip-failure")).toHaveTextContent(
      "action_failed",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("promises the bump outright on a card, whose switch it knows the state of", async () => {
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={classSwitch()}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-emd_01k5c1"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    expect(
      within(dialog).queryByText(/if this flip changes the switch/),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText(/deny generation 12 → 13/)).toBeVisible();
  });

  it("reads the generation off the level picked, not off the switch it has none of", async () => {
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    // A class switch is recorded org-wide; a tool-server switch under the
    // workspace. The preview names the counter each one actually advances.
    expect(within(dialog).getByText(/deny generation 12 → 13/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "tool_server" },
    });
    expect(within(dialog).getByText(/deny generation 4 → 5/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "org" },
    });
    expect(within(dialog).getByText(/deny generation 12 → 13/)).toBeVisible();
  });

  it.each([
    ["org", "This organization."],
    ["workspace", "This workspace."],
  ] as const)(
    "asks for no target at the %s level and lets the viewer supply it",
    async (kind, stated) => {
      flipKillSwitch.mockResolvedValue({
        ok: true,
        value: {
          switchId: "emd_new",
          on: true,
          changed: true,
          denyGeneration: { org: 13, workspace: 5 },
          grantsRevoked: 0,
        },
      });
      withIntl(
        <FlipControls
          at={at}
          denyGeneration={GENERATION}
          existing={null}
          members={MEMBERS}
        />,
      );
      fireEvent.click(screen.getByTestId("tools-flip-open"));
      const dialog = await screen.findByTestId("tools-flip-dialog");
      fireEvent.change(screen.getByLabelText("Level"), {
        target: { value: kind },
      });
      // The page never prints the tenant's uuid, so it never asks for one.
      expect(within(dialog).queryByLabelText("Target")).not.toBeInTheDocument();
      expect(
        within(dialog).getByTestId("tools-flip-self-target"),
      ).toHaveTextContent(stated);

      fill(/^Reason/, "Stop everything.");
      fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
      await waitFor(() => {
        expect(flipKillSwitch).toHaveBeenCalledWith("acme", "core-platform", {
          kind,
          target: null,
          on: true,
          reason: "Stop everything.",
        });
      });
    },
  );

  it("flips an operator switch from a member picked off the roster, submitting their usr_ id (#3147)", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_new",
        on: true,
        changed: true,
        denyGeneration: { org: 13, workspace: 4 },
        grantsRevoked: 0,
      },
    });
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "operator" },
    });
    // A picker over the org's members, not a free-text field: the person
    // finds them by name, and the value it submits is always the usr_ id the
    // contract can resolve.
    pick("Target", "priya");
    expect(submitted("target")).toBe("usr_finops1");
    expect(chooseSwitchTargets).not.toHaveBeenCalled();
    fill(/^Reason/, "Compromised laptop.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    await waitFor(() => {
      expect(flipKillSwitch).toHaveBeenCalledWith("acme", "core-platform", {
        kind: "operator",
        target: "usr_finops1",
        on: true,
        reason: "Compromised laptop.",
      });
    });
  });
});

describe("FlipControls target picker", () => {
  it("picks an agent by name from the loaded roster and submits its id", async () => {
    flipKillSwitch.mockResolvedValue({
      ok: true,
      value: {
        switchId: "emd_new",
        on: true,
        changed: true,
        denyGeneration: { org: 12, workspace: 5 },
        grantsRevoked: 0,
      },
    });
    chooseSwitchTargets.mockResolvedValue(
      loaded([
        { value: "agt_01k5r1", label: "Release bot", detail: "agt_01k5r1" },
        { value: "agt_01k5r2", label: "Billing bot", detail: "agt_01k5r2" },
      ]),
    );
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "agent" },
    });
    const input = screen.getByLabelText("Target");
    fireEvent.change(input, { target: { value: "release" } });
    expect(chooseSwitchTargets).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agent",
    );
    expect(
      await within(dialog).findByRole("option", { name: /Release bot/ }),
    ).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted("target")).toBe("agt_01k5r1");
    fill(/^Reason/, "Runaway loop.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    await waitFor(() => {
      expect(flipKillSwitch).toHaveBeenCalledWith("acme", "core-platform", {
        kind: "agent",
        target: "agt_01k5r1",
        on: true,
        reason: "Runaway loop.",
      });
    });
  });

  it("drops a picked target when the level changes", async () => {
    chooseSwitchTargets.mockResolvedValue(
      loaded([{ value: "agt_01k5r1", label: "Release bot" }]),
    );
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "agent" },
    });
    const input = screen.getByLabelText("Target");
    fireEvent.change(input, { target: { value: "release" } });
    await within(dialog).findByRole("option", { name: /Release bot/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted("target")).toBe("agt_01k5r1");
    // An agent id is no connection id, so the next level starts empty.
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "connection" },
    });
    expect(submitted("target")).toBe("");
  });

  it("offers the starter consequence tags at the class level", async () => {
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Target"), {
      target: { value: "money" },
    });
    expect(
      within(dialog).getByRole("option", { name: /moves_money/ }),
    ).toBeVisible();
    expect(chooseSwitchTargets).not.toHaveBeenCalled();
  });
});

describe("useActionFailure", () => {
  it.each([
    [
      { ok: false, reason: "denied", code: "no_principal" },
      "This session carries no person to record the action against.",
    ],
    [
      { ok: false, reason: "not_found", code: "server_not_found" },
      "No registered provider has that id in this workspace.",
    ],
    [
      { ok: false, reason: "conflict", code: "kill_switch_on" },
      "A kill switch names this target",
    ],
    [
      { ok: false, reason: "conflict", code: "something_else" },
      "Refused: something_else.",
    ],
    // Both concurrency refusals read the same to the person: reload the tab
    // and make the change again over the rules as they are now.
    [
      { ok: false, reason: "conflict", code: "rule_changed" },
      "changed this rule set while this dialog was open",
    ],
    [
      { ok: false, reason: "conflict", code: "rule_set_changed" },
      "changed this rule set while this dialog was open",
    ],
    [
      { ok: false, reason: "invalid", code: "invalid_input" },
      "Check the values above",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_1" },
      "acr_1",
    ],
    [
      { ok: false, reason: "exhausted", code: "gau_exhausted" },
      "gau_exhausted",
    ],
  ] as const)("names %j", (failure, expected) => {
    const hook = renderHook(() => useActionFailure(), { wrapper: intl });
    expect(hook.result.current(failure)).toContain(expected);
    hook.unmount();
  });
});

describe("FlipControls with a fixed target", () => {
  it("flips the fixed class target with no level select, naming the level when no label is given", async () => {
    flipKillSwitch.mockReturnValue(new Promise(() => undefined));
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        fixed={{ kind: "class", ref: "moves_money" }}
        members={MEMBERS}
      />,
    );
    const toggle = screen.getByTestId("tools-flip-class-moves_money");
    expect(toggle).toHaveAccessibleName("Deny Class");
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId("tools-flip-dialog");
    expect(within(dialog).queryByLabelText("Level")).toBeNull();
    expect(dialog).toHaveTextContent("Class · Class");
    fill(/^Reason/, "Freeze payments.");
    const form = formOf(within(dialog).getByText("Deny now"));
    fireEvent.submit(form);
    // A second submit while the first is pending sends nothing.
    fireEvent.submit(form);
    expect(flipKillSwitch).toHaveBeenCalledTimes(1);
    expect(flipKillSwitch).toHaveBeenCalledWith("acme", "core-platform", {
      kind: "class",
      target: "moves_money",
      on: true,
      reason: "Freeze payments.",
    });
  });

  it("marks a self-targeted fixed switch as self and sends no target", async () => {
    flipKillSwitch.mockReturnValue(new Promise(() => undefined));
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        fixed={{ kind: "org", ref: null }}
        label="Organization"
        members={MEMBERS}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-org-self"));
    const dialog = await screen.findByTestId("tools-flip-dialog");
    fill(/^Reason/, "Stop everything.");
    fireEvent.submit(formOf(within(dialog).getByText("Deny now")));
    expect(flipKillSwitch).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({ kind: "org", target: null }),
    );
  });
});

describe("FlipControls operator picker", () => {
  it("names a member with no name by email, and says when there is nobody to choose (negative)", async () => {
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={[{ id: "usr_anon", name: null, email: "anon@acme.example" }]}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "operator" },
    });
    // The target is a RecordPicker now, so the member list opens on focus and
    // the row reads as the name a person knows — here the email, because the
    // member has no name recorded.
    fireEvent.focus(screen.getByRole("combobox", { name: "Target" }));
    expect(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: /anon@acme\.example/,
      }),
    ).toBeInTheDocument();
    cleanup();
    withIntl(
      <FlipControls
        at={at}
        denyGeneration={GENERATION}
        existing={null}
        members={[]}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-flip-open"));
    await screen.findByTestId("tools-flip-dialog");
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "operator" },
    });
    expect(
      screen.getByText("No org members to choose from."),
    ).toBeInTheDocument();
  });
});

describe("ToolDialog while a classification is pending", () => {
  it("says a disabled version is not enabled, and sends one classification however often the form is submitted", async () => {
    setToolClassification.mockReturnValue(new Promise(() => undefined));
    withIntl(
      <ToolDialog
        at={at}
        version={{ ...financial(), enabled: false }}
        canClassify
      >
        <span>Create payment</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Create payment"));
    const dialog = await screen.findByTestId("tool-dialog");
    expect(dialog).toHaveTextContent("EnabledNo");
    const form = element(dialog.querySelector("form"), "classify form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(setToolClassification).toHaveBeenCalledTimes(1);
  });
});

describe("ToolDialog tabs", () => {
  const stripe = McpServer.parse({
    id: "mcs_01k5s1",
    name: "Stripe",
    transportType: "streamable-http",
    endpointUrl: "https://mcp.stripe.example/v1",
    healthStatus: "healthy",
    lastHealthcheckAt: "2026-09-18T09:00:00.000Z",
    toolCount: 12,
    authKind: "bearer",
    iconUrl: "https://mcp.stripe.example/icon.svg",
    authorization: null,
  });
  /** The shape Notion's MCP tools publish: markdown, a placeholder, and inline examples. */
  const NOTION = [
    "Update a data source.",
    "",
    "## Statements",
    "",
    '- ADD COLUMN "Name" <type>',
    "- **DROP** a column",
    "",
    '<example description="Add properties">{"data_source_id": "f336d0bc"}</example>',
    "<example>not json</example>",
  ].join("\n");

  async function open(
    version = financial(),
    options: { canClassify?: boolean; provider?: McpServer | null } = {},
  ) {
    withIntl(
      <ToolDialog
        at={at}
        version={version}
        canClassify={options.canClassify ?? true}
        provider={options.provider ?? null}
      >
        <span>Open the tool</span>
      </ToolDialog>,
    );
    fireEvent.click(screen.getByText("Open the tool"));
    return within(await screen.findByTestId("tool-dialog"));
  }

  /** The selected tab's name: one dialog is open, so its tabs are the page's. */
  const selected = () =>
    screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true")
      .map((tab) => tab.textContent);

  it("heads the dialog with the provider's logo, the tool's name, and its API name", async () => {
    const dialog = await open(financial(), { provider: stripe });
    const logo = element(
      document.querySelector("[data-sheet-icon] img"),
      "provider logo",
    );
    expect(logo).toHaveAttribute("src", "https://mcp.stripe.example/icon.svg");
    expect(
      dialog.getByRole("heading", { name: "Create payment" }),
    ).toBeInTheDocument();
    expect(dialog.getByText("Stripe")).toBeInTheDocument();
    // The API name heads the dialog and is copyable on Details.
    expect(dialog.getAllByText(versionLabel(financial()))).toHaveLength(2);
  });

  it("opens on Overview and moves between tabs from the keyboard", async () => {
    const dialog = await open();
    expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Details",
      "Classification",
    ]);
    expect(selected()).toEqual(["Overview"]);
    const overview = dialog.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(selected()).toEqual(["Details"]);
    expect(dialog.getByRole("tab", { name: "Details" })).toHaveFocus();
    expect(dialog.getByRole("tabpanel")).toHaveTextContent("tlv_01k5a1");
    fireEvent.keyDown(document.activeElement ?? overview, { key: "End" });
    expect(selected()).toEqual(["Classification"]);
    fireEvent.keyDown(document.activeElement ?? overview, {
      key: "ArrowRight",
    });
    expect(selected()).toEqual(["Overview"]);
    fireEvent.keyDown(document.activeElement ?? overview, { key: "ArrowLeft" });
    expect(selected()).toEqual(["Classification"]);
    fireEvent.keyDown(document.activeElement ?? overview, { key: "Home" });
    expect(selected()).toEqual(["Overview"]);
    // Only the selected tab is in the Tab order.
    expect(
      dialog.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex")),
    ).toEqual(["0", "-1", "-1"]);
  });

  it("renders the description as markdown and keeps a placeholder in angle brackets as text", async () => {
    const dialog = await open({ ...plain(), description: NOTION });
    const overview = within(dialog.getByRole("tabpanel"));
    expect(
      overview.getByRole("heading", { name: "Statements" }),
    ).toBeInTheDocument();
    expect(overview.getByText("DROP")).toHaveAttribute(
      "data-streamdown",
      "strong",
    );
    expect(overview.getByText('ADD COLUMN "Name" <type>')).toBeInTheDocument();
    // The examples moved to their own tab and left nothing in the prose.
    expect(overview.queryByText(/data_source_id/)).not.toBeInTheDocument();
  });

  it("lists the provider's examples as code on their own tab, with a count", async () => {
    const dialog = await open({ ...plain(), description: NOTION });
    fireEvent.click(dialog.getByRole("tab", { name: "Examples 2" }));
    const examples = within(dialog.getByRole("tabpanel"));
    expect(
      examples.getByRole("heading", { name: "Add properties" }),
    ).toBeInTheDocument();
    expect(
      examples.getByRole("heading", { name: "Example 2" }),
    ).toBeInTheDocument();
    const blocks = document.querySelectorAll("[data-code-block]");
    expect([...blocks].map((block) => block.textContent)).toEqual([
      '{\n  "data_source_id": "f336d0bc"\n}',
      "not json",
    ]);
  });

  it("sends a person who can classify from the unclassified notice to the form", async () => {
    const dialog = await open(plain());
    expect(dialog.getByTestId("tool-unclassified")).toHaveTextContent(
      "No one has classified this version.",
    );
    fireEvent.click(
      dialog.getByRole("button", { name: "Classify this version" }),
    );
    expect(selected()).toEqual(["Classification"]);
    expect(dialog.getByRole("tab", { name: "Classification" })).toHaveFocus();
    expect(
      dialog.getByRole("button", { name: "Reclassify this version" }),
    ).toBeInTheDocument();
  });

  it("says a version has no description, and offers no form to a person who cannot classify", async () => {
    const dialog = await open(plain(), { canClassify: false });
    expect(
      dialog.getByText("This version carries no description."),
    ).toBeInTheDocument();
    expect(
      dialog.queryByRole("button", { name: "Classify this version" }),
    ).not.toBeInTheDocument();
    expect(
      dialog.queryByRole("tab", { name: /Examples/ }),
    ).not.toBeInTheDocument();
  });

  it("copies the version id, and says so when the clipboard refuses", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      const dialog = await open();
      fireEvent.click(dialog.getByRole("tab", { name: "Details" }));
      const copy = dialog.getByRole("button", { name: "Copy version id" });
      fireEvent.click(copy);
      expect(await dialog.findByText("Copied")).toBeInTheDocument();
      expect(writeText).toHaveBeenCalledWith("tlv_01k5a1");
      fireEvent.click(copy);
      expect(
        await dialog.findByText("Copy failed. Select the text instead."),
      ).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("copies an example's body as the tab shows it", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      const dialog = await open({ ...plain(), description: NOTION });
      fireEvent.click(dialog.getByRole("tab", { name: "Examples 2" }));
      fireEvent.click(
        dialog.getByRole("button", { name: "Copy example: Add properties" }),
      );
      expect(await dialog.findByText("Copied")).toBeInTheDocument();
      expect(writeText).toHaveBeenCalledWith(
        '{\n  "data_source_id": "f336d0bc"\n}',
      );
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("walks four tabs in order from the keyboard, and ignores a key it does not handle", async () => {
    const dialog = await open({ ...plain(), description: NOTION });
    const overview = dialog.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(selected()).toEqual(["Examples 2"]);
    fireEvent.keyDown(document.activeElement ?? overview, {
      key: "ArrowRight",
    });
    expect(selected()).toEqual(["Details"]);
    fireEvent.keyDown(document.activeElement ?? overview, { key: "End" });
    expect(selected()).toEqual(["Classification"]);
    // Tab leaves the strip, so the handler must not swallow it.
    const handled = !fireEvent.keyDown(document.activeElement ?? overview, {
      key: "Tab",
    });
    expect(handled).toBe(false);
    expect(selected()).toEqual(["Classification"]);
  });

  it("keeps a half-filled form when the person looks at another tab", async () => {
    const dialog = await open(plain());
    fireEvent.click(dialog.getByRole("tab", { name: "Classification" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Reads only public files" },
    });
    fireEvent.click(dialog.getByRole("tab", { name: "Overview" }));
    expect(
      dialog.queryByRole("textbox", { name: "Reason" }),
    ).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("tab", { name: "Classification" }));
    expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue(
      "Reads only public files",
    );
  });

  it("opens on Overview again after it was closed on another tab", async () => {
    const dialog = await open();
    fireEvent.click(dialog.getByRole("tab", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("tool-dialog")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Open the tool"));
    await screen.findByTestId("tool-dialog");
    expect(selected()).toEqual(["Overview"]);
  });

  it("falls back to Overview when a refreshed description loses the examples it was showing", async () => {
    const version = { ...plain(), description: NOTION };
    const view = (next: typeof version) => (
      <IntlProvider>
        <ToolDialog at={at} version={next} canClassify provider={null}>
          <span>Open the tool</span>
        </ToolDialog>
      </IntlProvider>
    );
    const { rerender } = render(view(version));
    fireEvent.click(screen.getByText("Open the tool"));
    const dialog = within(await screen.findByTestId("tool-dialog"));
    fireEvent.click(dialog.getByRole("tab", { name: "Examples 2" }));
    rerender(view({ ...version, description: "Update a data source." }));
    expect(selected()).toEqual(["Overview"]);
    expect(dialog.getAllByRole("tabpanel")).toHaveLength(1);
    expect(dialog.getByRole("tabpanel")).toHaveTextContent(
      "Update a data source.",
    );
  });

  it("gives a description made only of examples an Examples tab and no empty notice", async () => {
    const dialog = await open({
      ...plain(),
      description: '<example description="Only">{"a": 1}</example>',
    });
    expect(
      dialog.queryByText("This version carries no description."),
    ).not.toBeInTheDocument();
    expect(dialog.queryByTestId("tool-description")).not.toBeInTheDocument();
    expect(dialog.getByRole("tab", { name: "Examples 1" })).toBeInTheDocument();
  });

  describe("at a glance", () => {
    /** The value a Glance tile prints, found by its term on the Overview panel. */
    function tile(term: string): Element | null {
      const dialog = within(screen.getByTestId("tool-dialog"));
      return within(dialog.getByRole("tabpanel")).getByText(term, {
        selector: "dt",
      }).nextElementSibling;
    }

    it("names where a version not imported from a provider was declared", async () => {
      await open({ ...plain(), source: "custom" });
      expect(tile("Provider")).toHaveTextContent("Declared here");
    });

    it("says an unclassified version's egress and missing call count plainly", async () => {
      await open(plain());
      expect(tile("Egress")).toHaveTextContent("Unclassified");
      expect(tile("Calls 30d")).toHaveTextContent("not recorded");
    });

    it("prints a classified version's egress and its calls, with no unclassified notice", async () => {
      const dialog = await open(financial());
      expect(tile("Egress")).toHaveTextContent("third party");
      expect(tile("Calls 30d")).toHaveTextContent("1,204");
      expect(dialog.queryByTestId("tool-unclassified")).not.toBeInTheDocument();
    });
  });
});
