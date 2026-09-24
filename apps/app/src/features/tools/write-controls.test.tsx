// @vitest-environment jsdom
// The three Tools writes as a person makes them: the import dialog, which
// picks its server from the registered roster, the tool dialog's
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
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  importTools,
  setToolClassification,
  flipKillSwitch,
  chooseMcpServers,
  chooseSwitchTargets,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  importTools: vi.fn(),
  setToolClassification: vi.fn(),
  flipKillSwitch: vi.fn(),
  chooseMcpServers: vi.fn(),
  chooseSwitchTargets: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  importTools,
  setToolClassification,
  flipKillSwitch,
}));
vi.mock("@/features/shell/client", () => ({
  chooseMcpServers,
  chooseSwitchTargets,
}));

const { ImportControls } = await import("./import-controls");
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
const TOOLS = "/acme/core-platform/tools";
const SWITCHES = "/acme/core-platform/tools?tab=switches";
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
    setToolClassification,
    flipKillSwitch,
  ]) {
    fn.mockReset();
  }
  chooseMcpServers.mockReset().mockResolvedValue(loaded([]));
  chooseSwitchTargets.mockReset().mockResolvedValue(loaded([]));
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

describe("ImportControls", () => {
  it("imports the server the person named and reloads the registry", async () => {
    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 2, unchanged: 1 },
    });
    withIntl(<ImportControls at={at} servers={null} />);
    fireEvent.click(screen.getByTestId("tools-import-open"));
    pick("Server", "mcs_01k5s1");
    fill("Tools", "get_page create_page");
    fireEvent.submit(formOf(screen.getByText("Import")));
    await waitFor(() => {
      expect(importTools).toHaveBeenCalledWith("acme", "core-platform", {
        serverId: "mcs_01k5s1",
        tools: ["get_page", "create_page"],
      });
    });
    expect(router.replace).toHaveBeenCalledWith(TOOLS);
    expect(await screen.findByTestId("tools-import-done")).toHaveTextContent(
      "2 new versions · 1 already registered.",
    );
  });

  it("names a refusal where the person acted and navigates nowhere", async () => {
    importTools.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    withIntl(<ImportControls at={at} servers={null} />);
    fireEvent.click(screen.getByTestId("tools-import-open"));
    pick("Server", "mcs_01k5s1");
    fireEvent.submit(formOf(screen.getByText("Import")));
    expect(await screen.findByTestId("tools-import-failure")).toHaveTextContent(
      "This needs an organization Owner or Admin.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("picks a registered server by name and submits its id", async () => {
    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 1, unchanged: 0 },
    });
    withIntl(
      <ImportControls
        at={at}
        servers={[
          { id: "mcs_01k5s1", name: "Stripe" },
          { id: "mcs_01k5s2", name: "GitHub" },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("tools-import-open"));
    // The picker shows the server's name; what goes to the kernel is the id
    // `import_tools` names a server by, never the name a person reads.
    pick("Server", "GitHub");
    expect(submitted("serverId")).toBe("mcs_01k5s2");
    // The page already held the roster, so the picker read nothing more.
    expect(chooseMcpServers).not.toHaveBeenCalled();
    fireEvent.submit(formOf(screen.getByText("Import")));
    await waitFor(() => {
      expect(importTools).toHaveBeenCalledWith("acme", "core-platform", {
        serverId: "mcs_01k5s2",
        tools: [],
      });
    });
  });

  it("says so when no server is registered to import from", () => {
    withIntl(<ImportControls at={at} servers={[]} />);
    fireEvent.click(screen.getByTestId("tools-import-open"));
    expect(
      screen.getByText(
        "No server is registered yet, so there is nothing to import from.",
      ),
    ).toBeVisible();
  });

  it("reads the roster again when the page could not, and picks a server by name", async () => {
    chooseMcpServers.mockResolvedValue(
      loaded([
        {
          value: "mcs_01k5s1",
          label: "Stripe",
          detail: "https://mcp.stripe.example",
        },
      ]),
    );
    withIntl(<ImportControls at={at} servers={null} />);
    fireEvent.click(screen.getByTestId("tools-import-open"));
    expect(screen.getByText(/could not read the server roster/)).toBeVisible();
    const input = screen.getByLabelText("Server");
    fireEvent.change(input, { target: { value: "strip" } });
    expect(chooseMcpServers).toHaveBeenCalledWith("acme", "core-platform");
    expect(await screen.findByRole("option", { name: /Stripe/ })).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted("serverId")).toBe("mcs_01k5s1");
  });

  it("names a write that threw before it answered", async () => {
    importTools.mockRejectedValue(new Error("network"));
    withIntl(<ImportControls at={at} servers={null} />);
    fireEvent.click(screen.getByTestId("tools-import-open"));
    pick("Server", "mcs_01k5s1");
    fireEvent.submit(formOf(screen.getByText("Import")));
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
    expect(dialog.getByText("MCP server")).toBeInTheDocument();
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
    expect(router.replace).toHaveBeenCalledWith(TOOLS);
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
      "No registered tool server has that id in this workspace.",
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
