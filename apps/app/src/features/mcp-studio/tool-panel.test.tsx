// @vitest-environment jsdom
// One tool's panel on a Studio server (#4678): its classification and the
// suggestion a person confirms or changes, the description agents see and
// Draft, the gateway's shaping, what the server says, what agents' calls
// said, and the kill switch. The panel writes nothing. It hands each edit to
// the page through onStage, so each test asserts the draft op it handed over,
// and the page's answer decides whether the refused alert shows. The panel is
// controlled, so a test that needs the page to hold a staged edit renders it
// again with that edit in `ops`. axe checks the state each test ends in
// (INV-26).
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { DESCRIPTION_MAX, type DraftOp } from "./draft";
import type { StudioTool } from "./model";
import type { DraftDescription } from "./seams";
import {
  BILLING,
  fakeDraft,
  graphqlTool,
  SCRATCH,
  STRIPE,
  studioTool,
  studioView,
  WAREHOUSE,
} from "./studio.builders";
import { ToolPanel } from "./tool-panel";

// No child reads the router today. The mock keeps a later one from reaching
// the real App Router, which does not exist in jsdom.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    window.sessionStorage.clear();
  }
});

type PanelProps = ComponentProps<typeof ToolPanel>;
type DraftAnswer = Awaited<ReturnType<DraftDescription>>;

/** The panel's words, from messages/mcp-studio.json (`mcpStudio.panel`). */
const COPY = {
  unclassified: "This tool has no classification yet.",
  importFirst:
    "Import this tool before you change its classification or description.",
  draftHint:
    "Draft asks a model to write the description. Its cost is billed as in-app agent spend.",
  draftNotBuilt:
    "Draft is not available yet. You can write the description yourself.",
  refused:
    "The draft cannot hold that edit, so it was not kept. Remove an edit on the Changes tab or discard the draft first.",
  shapingMissing:
    "Shaping is set in tools.toml, and Oxagen has not read this server's tools.toml yet.",
  serverMissing:
    "Oxagen has not recorded what the server says about this tool yet.",
  feedbackMissing: "Oxagen has not recorded how agents use this tool yet.",
  offNone:
    "The registry holds no version of this tool, so it has no switch to turn off.",
} as const;

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}

/** One tool of a fixture server's page, as buildStudioView joins it. */
function toolOn(serverId: string, name: string): StudioTool {
  const tool = studioView(serverId).tools.find((row) => row.name === name);
  if (tool === undefined) throw new Error(`no tool ${name} on ${serverId}`);
  return tool;
}

/** Warehouse's first row: `tool_000`, imported, confirmed, with a version. */
function warehouseFirst(): StudioTool {
  const [first] = studioView(WAREHOUSE).tools;
  if (first === undefined) throw new Error("Warehouse lists no tools");
  return first;
}

/** A panel section, found by its heading. */
const region = (name: string) => screen.getByRole("region", { name });

/** The `dd` after the `dt` that reads `term`. */
function factOf(scope: HTMLElement, term: string): HTMLElement {
  const dt = [...scope.querySelectorAll("dt")].find(
    (node) => node.textContent === term,
  );
  return element(dt?.nextElementSibling, `the value of ${term}`);
}

const fact = (scope: HTMLElement, term: string) =>
  factOf(scope, term).textContent;

/** The text of each item in a list. */
const items = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);

/**
 * The panel open on `tool` for a person who can edit, with an empty draft, a
 * page that accepts every edit, and a switch and its facts from the page.
 */
function renderPanel(
  tool: StudioTool,
  over: Partial<Omit<PanelProps, "tool" | "onStage" | "onOpenChange">> = {},
) {
  const onStage = vi.fn<(op: DraftOp) => boolean>(() => true);
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const props: PanelProps = {
    serverId: STRIPE,
    tool,
    ops: [],
    canEdit: true,
    onStage,
    off: <button type="button">Turn off</button>,
    offFacts: <p>Turned off by Dana Reyes on 26 September.</p>,
    open: true,
    onOpenChange,
    ...over,
  };
  const view = render(
    <IntlProvider>
      <ToolPanel {...props} />
    </IntlProvider>,
  );
  const rerenderWith = (next: Partial<PanelProps>) => {
    view.rerender(
      <IntlProvider>
        <ToolPanel {...props} {...next} />
      </IntlProvider>,
    );
  };
  return { onStage, onOpenChange, rerenderWith };
}

describe("ToolPanel sheet", () => {
  it("draws nothing while the page holds it closed", () => {
    const panel = renderPanel(toolOn(STRIPE, "create_payment"), {
      open: false,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("studio-tool-panel")).toBeNull();
    expect(screen.queryByText("Charges a customer.")).toBeNull();
    expect(panel.onOpenChange).not.toHaveBeenCalled();
  });

  it("opens as a dialog named for the tool", () => {
    renderPanel(toolOn(STRIPE, "create_payment"));
    expect(
      screen.getByRole("dialog", { name: "create_payment" }),
    ).toHaveAttribute("data-testid", "studio-tool-panel");
  });

  it.each(["Close create_payment", "Close"])(
    "tells the page it closed when a person presses %s",
    async (name) => {
      const user = userEvent.setup();
      const panel = renderPanel(toolOn(STRIPE, "create_payment"));
      await user.click(screen.getByRole("button", { name }));
      expect(panel.onOpenChange.mock.calls).toEqual([[false]]);
    },
  );
});

describe("ToolPanel classification", () => {
  it("shows a confirmed classification from the registry with its impacts", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), { canEdit: false });
    const section = within(region("Classification"));
    const facts = section.getByTestId("studio-panel-classification");
    expect(fact(facts, "Risk")).toBe("Critical");
    expect(fact(facts, "Side effect")).toBe("irreversible");
    expect(fact(facts, "Egress")).toBe("third party");
    expect(fact(facts, "Impacts")).toBe("moves_money");
    expect(section.queryByTestId("studio-panel-suggested")).toBeNull();
    expect(section.queryByTestId("studio-panel-staged")).toBeNull();
  });

  it("reads a confirmed classification with no impacts as none", () => {
    renderPanel(warehouseFirst(), { serverId: WAREHOUSE, canEdit: false });
    const facts = within(region("Classification")).getByTestId(
      "studio-panel-classification",
    );
    expect(fact(facts, "Risk")).toBe("Low");
    expect(fact(facts, "Side effect")).toBe("read");
    expect(fact(facts, "Egress")).toBe("org tenant");
    expect(fact(facts, "Impacts")).toBe("None");
  });

  it("says a tool has no classification yet and suggests none", () => {
    renderPanel(toolOn(BILLING, "create_refund"), {
      serverId: BILLING,
      canEdit: false,
    });
    const section = within(region("Classification"));
    expect(section.getByText(COPY.unclassified)).toBeInTheDocument();
    expect(section.queryByTestId("studio-panel-classification")).toBeNull();
    expect(section.queryByTestId("studio-panel-suggested")).toBeNull();
  });

  it("marks a suggestion nobody confirmed and says what it came from", () => {
    renderPanel(toolOn(BILLING, "void_invoice"), {
      serverId: BILLING,
      canEdit: false,
    });
    const section = within(region("Classification"));
    const suggested = section.getByTestId("studio-panel-suggested");
    expect(suggested).toHaveTextContent("Suggested");
    expect(suggested).toHaveTextContent("From the operation's HTTP method.");
    const facts = section.getByTestId("studio-panel-classification");
    expect(fact(facts, "Risk")).toBe("Critical");
    expect(fact(facts, "Side effect")).toBe("irreversible");
    expect(fact(facts, "Egress")).toBe("org tenant");
    expect(fact(facts, "Impacts")).toBe("moves_money");
    expect(
      section.queryByRole("button", { name: "Confirm suggestion" }),
    ).toBeNull();
  });

  it("marks a suggestion with no recorded basis and adds no basis sentence", () => {
    const tool = studioTool("lookup_account", {
      classification: {
        risk: "medium",
        sideEffect: "write",
        egress: "local",
        impacts: [],
        confirmed: false,
        basis: null,
      },
    });
    renderPanel(tool, { canEdit: false });
    expect(screen.getByTestId("studio-panel-suggested")).toHaveTextContent(
      /^Suggested$/,
    );
  });

  it("asks for the import before a person edits a tool nobody imported", () => {
    renderPanel(toolOn(BILLING, "void_invoice"), { serverId: BILLING });
    const classification = within(region("Classification"));
    expect(classification.getByText(COPY.importFirst)).toBeInTheDocument();
    expect(classification.queryByRole("combobox")).toBeNull();
    expect(classification.queryByRole("button")).toBeNull();
    const description = within(region("Description"));
    expect(description.queryByRole("textbox")).toBeNull();
    expect(description.getByText("None")).toBeInTheDocument();
  });

  it("asks for the import again once the draft removes an imported tool", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), {
      ops: [{ kind: "remove", tool: "create_payment" }],
    });
    const classification = within(region("Classification"));
    expect(classification.getByText(COPY.importFirst)).toBeInTheDocument();
    expect(classification.queryByRole("combobox")).toBeNull();
    const description = within(region("Description"));
    expect(description.queryByRole("textbox")).toBeNull();
    expect(description.getByText("Charges a customer.")).toBeInTheDocument();
  });

  it("confirms a suggestion into the draft with the suggestion's own values", async () => {
    const user = userEvent.setup();
    const ops: DraftOp[] = [{ kind: "import", tool: "void_invoice" }];
    const panel = renderPanel(toolOn(BILLING, "void_invoice"), {
      serverId: BILLING,
      ops,
    });
    const section = within(region("Classification"));
    expect(section.getByLabelText("Risk")).toHaveValue("critical");
    expect(section.getByLabelText("Side effect")).toHaveValue("irreversible");
    expect(section.getByLabelText("Egress")).toHaveValue("org_tenant");
    await user.click(section.getByRole("button", { name: "Confirm suggestion" }));
    const confirmed: DraftOp = {
      kind: "classify",
      tool: "void_invoice",
      risk: "critical",
      sideEffect: "irreversible",
      egress: "org_tenant",
      impacts: ["moves_money"],
    };
    expect(panel.onStage.mock.calls).toEqual([[confirmed]]);

    panel.rerenderWith({ ops: [...ops, confirmed] });
    expect(screen.queryByTestId("studio-panel-suggested")).toBeNull();
    expect(screen.getByTestId("studio-panel-staged")).toHaveTextContent(
      "In the draft",
    );
    expect(
      screen.queryByRole("button", { name: "Confirm suggestion" }),
    ).toBeNull();
  });

  it("puts the suggestion back in the choices when a person confirms after changing one", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(toolOn(BILLING, "void_invoice"), {
      serverId: BILLING,
      ops: [{ kind: "import", tool: "void_invoice" }],
    });
    const section = within(region("Classification"));
    await user.selectOptions(section.getByLabelText("Risk"), "high");
    expect(section.getByLabelText("Risk")).toHaveValue("high");
    await user.click(section.getByRole("button", { name: "Confirm suggestion" }));
    expect(section.getByLabelText("Risk")).toHaveValue("critical");
    expect(panel.onStage.mock.calls).toEqual([
      [
        {
          kind: "classify",
          tool: "void_invoice",
          risk: "critical",
          sideEffect: "irreversible",
          egress: "org_tenant",
          impacts: ["moves_money"],
        },
      ],
    ]);
  });

  it("stages a changed suggestion with the suggestion's impacts", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(toolOn(BILLING, "void_invoice"), {
      serverId: BILLING,
      ops: [{ kind: "import", tool: "void_invoice" }],
    });
    const section = within(region("Classification"));
    await user.selectOptions(section.getByLabelText("Risk"), "high");
    await user.click(section.getByRole("button", { name: "Add to draft" }));
    expect(panel.onStage.mock.calls).toEqual([
      [
        {
          kind: "classify",
          tool: "void_invoice",
          risk: "high",
          sideEffect: "irreversible",
          egress: "org_tenant",
          impacts: ["moves_money"],
        },
      ],
    ]);
  });

  it("offers the registry's words for each value", () => {
    renderPanel(toolOn(BILLING, "create_refund"), { serverId: BILLING });
    const section = within(region("Classification"));
    const options = (label: string) =>
      within(section.getByLabelText(label))
        .getAllByRole("option")
        .map((option) => option.textContent);
    expect(options("Risk")).toEqual([
      "Choose",
      "Low",
      "Medium",
      "High",
      "Critical",
    ]);
    expect(options("Side effect")).toEqual([
      "Choose",
      "read",
      "write",
      "irreversible",
    ]);
    expect(options("Egress")).toEqual([
      "Choose",
      "local",
      "org tenant",
      "third party",
    ]);
  });

  it("stages a classification for an unclassified tool only once all three values are chosen", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(toolOn(BILLING, "create_refund"), {
      serverId: BILLING,
    });
    const section = within(region("Classification"));
    const risk = section.getByLabelText("Risk");
    const sideEffect = section.getByLabelText("Side effect");
    const egress = section.getByLabelText("Egress");
    const stage = section.getByRole("button", { name: "Add to draft" });
    expect(risk).toHaveValue("");
    expect(sideEffect).toHaveValue("");
    expect(egress).toHaveValue("");
    expect(stage).toBeDisabled();
    expect(
      section.queryByRole("button", { name: "Confirm suggestion" }),
    ).toBeNull();

    await user.selectOptions(risk, "high");
    expect(stage).toBeDisabled();
    await user.selectOptions(sideEffect, "write");
    expect(stage).toBeDisabled();
    await user.selectOptions(egress, "local");
    expect(stage).toBeEnabled();

    // Choosing "Choose" again empties that value and holds the stage.
    await user.selectOptions(risk, "");
    expect(risk).toHaveValue("");
    expect(stage).toBeDisabled();
    await user.selectOptions(risk, "high");
    await user.selectOptions(sideEffect, "");
    expect(sideEffect).toHaveValue("");
    expect(stage).toBeDisabled();
    await user.selectOptions(sideEffect, "write");
    await user.selectOptions(egress, "");
    expect(egress).toHaveValue("");
    expect(stage).toBeDisabled();
    await user.selectOptions(egress, "local");
    expect(stage).toBeEnabled();

    await user.click(stage);
    expect(panel.onStage.mock.calls).toEqual([
      [
        {
          kind: "classify",
          tool: "create_refund",
          risk: "high",
          sideEffect: "write",
          egress: "local",
          impacts: [],
        },
      ],
    ]);
  });

  it("carries a confirmed classification's impacts into a changed one", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(toolOn(STRIPE, "create_payment"));
    const section = within(region("Classification"));
    expect(section.getByLabelText("Risk")).toHaveValue("critical");
    expect(section.getByLabelText("Side effect")).toHaveValue("irreversible");
    expect(section.getByLabelText("Egress")).toHaveValue("third_party");
    expect(
      section.queryByRole("button", { name: "Confirm suggestion" }),
    ).toBeNull();
    const stage = section.getByRole("button", { name: "Add to draft" });
    expect(stage).toBeDisabled();
    await user.selectOptions(section.getByLabelText("Risk"), "high");
    expect(stage).toBeEnabled();
    await user.click(stage);
    expect(panel.onStage.mock.calls).toEqual([
      [
        {
          kind: "classify",
          tool: "create_payment",
          risk: "high",
          sideEffect: "irreversible",
          egress: "third_party",
          impacts: ["moves_money"],
        },
      ],
    ]);
  });

  it("shows the draft's classification over the tool's own and edits from it", async () => {
    const user = userEvent.setup();
    const staged: DraftOp = {
      kind: "classify",
      tool: "create_payment",
      risk: "high",
      sideEffect: "write",
      egress: "local",
      impacts: ["moves_money", "changes_entitlement"],
    };
    const panel = renderPanel(toolOn(STRIPE, "create_payment"), {
      ops: [staged],
    });
    const section = within(region("Classification"));
    const facts = section.getByTestId("studio-panel-classification");
    expect(fact(facts, "Risk")).toBe("High");
    expect(fact(facts, "Side effect")).toBe("write");
    expect(fact(facts, "Egress")).toBe("local");
    expect(fact(facts, "Impacts")).toBe("moves_money, changes_entitlement");
    expect(section.getByTestId("studio-panel-staged")).toHaveTextContent(
      "In the draft",
    );
    expect(section.queryByTestId("studio-panel-suggested")).toBeNull();
    expect(section.getByLabelText("Risk")).toHaveValue("high");
    expect(section.getByLabelText("Side effect")).toHaveValue("write");
    expect(section.getByLabelText("Egress")).toHaveValue("local");
    const stage = section.getByRole("button", { name: "Add to draft" });
    expect(stage).toBeDisabled();

    await user.selectOptions(section.getByLabelText("Egress"), "third_party");
    expect(stage).toBeEnabled();
    await user.click(stage);
    expect(panel.onStage.mock.calls).toEqual([
      [{ ...staged, egress: "third_party" }],
    ]);
  });
});

describe("ToolPanel description", () => {
  it("shows the description agents see, read-only, to a person who cannot edit", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), { canEdit: false });
    const section = within(region("Description"));
    expect(section.getByText("Charges a customer.")).toBeInTheDocument();
    expect(section.queryByRole("textbox")).toBeNull();
    expect(section.queryByRole("button")).toBeNull();
  });

  it("shows the draft's description over the tool's own when read-only", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), {
      canEdit: false,
      ops: [
        {
          kind: "describe",
          tool: "create_payment",
          description: "Charges a customer. The amount is in cents.",
        },
      ],
    });
    const section = within(region("Description"));
    expect(
      section.getByText("Charges a customer. The amount is in cents."),
    ).toBeInTheDocument();
    expect(section.queryByText("Charges a customer.")).toBeNull();
  });

  it("stages an edited description trimmed, and only once it differs from the current one", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(toolOn(STRIPE, "create_payment"));
    const section = within(region("Description"));
    const text = section.getByRole("textbox", { name: "Description" });
    const stage = section.getByRole("button", { name: "Add to draft" });
    expect(text).toHaveValue("Charges a customer.");
    expect(text).toHaveAttribute("maxlength", String(DESCRIPTION_MAX));
    expect(stage).toBeDisabled();

    fireEvent.change(text, { target: { value: "   " } });
    expect(stage).toBeDisabled();
    fireEvent.change(text, { target: { value: "  Charges a customer.  " } });
    expect(stage).toBeDisabled();
    fireEvent.change(text, {
      target: { value: "  Charges a customer. The amount is in cents.  " },
    });
    expect(stage).toBeEnabled();

    await user.click(stage);
    expect(panel.onStage.mock.calls).toEqual([
      [
        {
          kind: "describe",
          tool: "create_payment",
          description: "Charges a customer. The amount is in cents.",
        },
      ],
    ]);
  });

  it("starts an edit from the draft's description and marks it as in the draft", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), {
      ops: [
        {
          kind: "describe",
          tool: "create_payment",
          description: "Charges a customer in cents.",
        },
      ],
    });
    const section = within(region("Description"));
    expect(section.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Charges a customer in cents.",
    );
    expect(section.getByText("In the draft")).toBeInTheDocument();
    const stage = section.getByRole("button", { name: "Add to draft" });
    expect(stage).toBeDisabled();
    fireEvent.change(section.getByRole("textbox", { name: "Description" }), {
      target: { value: "Charges a customer in cents, once." },
    });
    expect(stage).toBeEnabled();
    expect(
      within(region("Classification")).queryByTestId("studio-panel-staged"),
    ).toBeNull();
  });

  it("starts a tool with no description blank and stages once text is written", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(studioTool("ping"), { serverId: SCRATCH });
    const section = within(region("Description"));
    const text = section.getByRole("textbox", { name: "Description" });
    const stage = section.getByRole("button", { name: "Add to draft" });
    expect(text).toHaveValue("");
    expect(stage).toBeDisabled();
    fireEvent.change(text, { target: { value: "Checks the server answers." } });
    expect(stage).toBeEnabled();
    await user.click(stage);
    expect(panel.onStage.mock.calls).toEqual([
      [
        {
          kind: "describe",
          tool: "ping",
          description: "Checks the server answers.",
        },
      ],
    ]);
  });
});

describe("ToolPanel Draft", () => {
  it("says Draft bills as in-app agent spend beside the Draft button", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), {
      draft: fakeDraft({ ok: true, description: "Unused." }).draft,
    });
    const section = within(region("Description"));
    expect(section.getByText(COPY.draftHint)).toBeInTheDocument();
    expect(section.getByRole("button", { name: "Draft" })).toBeEnabled();
  });

  it("asks Draft once for this server's tool, fills the text and stages nothing", async () => {
    const user = userEvent.setup();
    const drafted = "Creates a PaymentIntent and confirms it. The amount is in cents.";
    const { draft, calls } = fakeDraft({ ok: true, description: drafted });
    const panel = renderPanel(toolOn(STRIPE, "create_payment"), { draft });
    const section = within(region("Description"));
    const text = section.getByRole("textbox", { name: "Description" });

    await user.click(section.getByRole("button", { name: "Draft" }));
    await waitFor(() => {
      expect(text).toHaveValue(drafted);
    });
    expect(calls).toEqual([{ serverId: STRIPE, tool: "create_payment" }]);
    expect(panel.onStage).not.toHaveBeenCalled();
    expect(section.getByRole("button", { name: "Draft" })).toBeEnabled();
    expect(section.queryByRole("status")).toBeNull();
    expect(section.queryByRole("alert")).toBeNull();

    await user.click(section.getByRole("button", { name: "Add to draft" }));
    expect(panel.onStage.mock.calls).toEqual([
      [{ kind: "describe", tool: "create_payment", description: drafted }],
    ]);
  });

  it("holds Draft while one runs, so one click asks for one draft", async () => {
    const user = userEvent.setup();
    const calls: Parameters<DraftDescription>[0][] = [];
    let answer: (result: DraftAnswer) => void = () => undefined;
    const running = new Promise<DraftAnswer>((resolve) => {
      answer = resolve;
    });
    const draft: DraftDescription = (input) => {
      calls.push(input);
      return running;
    };
    renderPanel(toolOn(STRIPE, "create_payment"), { draft });
    const section = within(region("Description"));
    const button = section.getByRole("button", { name: "Draft" });

    await user.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(calls).toEqual([{ serverId: STRIPE, tool: "create_payment" }]);

    await act(async () => {
      answer({ ok: true, description: "Charges a customer in cents." });
      await running;
    });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(section.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Charges a customer in cents.",
    );
  });

  it.each([
    { gap: "capability", ref: "#4678" },
    { gap: "steeringPr", ref: "#4686" },
  ] as const)(
    "says Draft is not built yet and points the note at $ref for the $gap gap",
    async ({ gap, ref }) => {
      const user = userEvent.setup();
      const { draft } = fakeDraft({ ok: false, reason: "not_built", gap });
      renderPanel(toolOn(STRIPE, "create_payment"), { draft });
      const section = within(region("Description"));
      await user.click(section.getByRole("button", { name: "Draft" }));
      const note = await section.findByTestId("studio-panel-draft-not-built");
      expect(note).toHaveAttribute("role", "status");
      expect(note).toHaveAttribute("data-state", "not-built");
      expect(note).toHaveAttribute("data-gap", ref);
      expect(note).toHaveTextContent(COPY.draftNotBuilt);
      expect(section.getByRole("textbox", { name: "Description" })).toHaveValue(
        "Charges a customer.",
      );
      expect(section.getByRole("button", { name: "Draft" })).toBeEnabled();
    },
  );

  it("answers not built from the default seam when the page passes no Draft", async () => {
    const user = userEvent.setup();
    renderPanel(toolOn(STRIPE, "create_payment"));
    const section = within(region("Description"));
    await user.click(section.getByRole("button", { name: "Draft" }));
    const note = await section.findByTestId("studio-panel-draft-not-built");
    expect(note).toHaveAttribute("data-gap", "#4678");
    expect(note).toHaveTextContent(COPY.draftNotBuilt);
  });

  it("shows why Draft failed, and clears it when the next Draft succeeds", async () => {
    const user = userEvent.setup();
    const { draft, calls } = fakeDraft(
      { ok: false, reason: "failed", message: "The model timed out." },
      { ok: true, description: "Charges a customer in cents." },
    );
    renderPanel(toolOn(STRIPE, "create_payment"), { draft });
    const section = within(region("Description"));
    const text = section.getByRole("textbox", { name: "Description" });

    await user.click(section.getByRole("button", { name: "Draft" }));
    const failed = await section.findByRole("alert");
    expect(failed).toHaveTextContent("Draft failed: The model timed out.");
    expect(text).toHaveValue("Charges a customer.");
    expect(section.queryByTestId("studio-panel-draft-not-built")).toBeNull();

    await user.click(section.getByRole("button", { name: "Draft" }));
    await waitFor(() => {
      expect(text).toHaveValue("Charges a customer in cents.");
    });
    expect(section.queryByRole("alert")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("says Draft did not finish when it throws, and frees the button", async () => {
    const user = userEvent.setup();
    const calls: Parameters<DraftDescription>[0][] = [];
    const draft: DraftDescription = (input) => {
      calls.push(input);
      return Promise.reject(new Error("fetch failed: socket hang up"));
    };
    renderPanel(toolOn(STRIPE, "create_payment"), { draft });
    const section = within(region("Description"));
    const button = section.getByRole("button", { name: "Draft" });

    await user.click(button);
    const error = await section.findByTestId("studio-panel-draft-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent("Draft did not finish. Try again.");
    expect(error).not.toHaveTextContent("socket hang up");
    expect(section.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Charges a customer.",
    );
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy", "true");
    await user.click(button);
    await section.findByTestId("studio-panel-draft-error");
    expect(calls).toHaveLength(2);
  });
});

describe("ToolPanel refused edits", () => {
  it("says the draft refused an edit, and clears the alert on the next edit it keeps", async () => {
    const user = userEvent.setup();
    const panel = renderPanel(toolOn(STRIPE, "create_payment"));
    panel.onStage.mockReturnValueOnce(false);
    expect(screen.queryByTestId("studio-panel-refused")).toBeNull();
    const section = within(region("Description"));
    fireEvent.change(section.getByRole("textbox", { name: "Description" }), {
      target: { value: "Charges a customer in cents." },
    });
    const stage = section.getByRole("button", { name: "Add to draft" });

    await user.click(stage);
    const refused = screen.getByTestId("studio-panel-refused");
    expect(refused).toHaveAttribute("role", "alert");
    expect(refused).toHaveTextContent(COPY.refused);

    await user.click(stage);
    expect(screen.queryByTestId("studio-panel-refused")).toBeNull();
    expect(panel.onStage).toHaveBeenCalledTimes(2);
  });
});

describe("ToolPanel shaping", () => {
  it("lists the hidden inputs, the fixed inputs and the result paths", () => {
    renderPanel(toolOn(BILLING, "list_invoices"), {
      serverId: BILLING,
      canEdit: false,
    });
    const section = within(region("Shaping"));
    const facts = section.getByTestId("studio-panel-shaping");
    expect(fact(facts, "Hidden inputs")).toBe("tenant_id");
    expect(items(factOf(facts, "Fixed inputs"))).toEqual([
      "X-Request-Source = oxagen",
    ]);
    expect(fact(facts, "Returns")).toBe("$.data[*].id, $.data[*].total");
    expect(
      section.queryByRole("group", { name: "GraphQL selection set" }),
    ).toBeNull();
    expect(section.queryByTestId("studio-panel-shaping-missing")).toBeNull();
  });

  it("shows a GraphQL operation's selection set, and reads empty shaping as none and the whole result", () => {
    renderPanel(graphqlTool(), { canEdit: false });
    const section = within(region("Shaping"));
    const facts = section.getByTestId("studio-panel-shaping");
    expect(fact(facts, "Hidden inputs")).toBe("None");
    expect(fact(facts, "Fixed inputs")).toBe("None");
    expect(fact(facts, "Returns")).toBe("The whole result");
    expect(
      section.getByRole("group", { name: "GraphQL selection set" }),
    ).toHaveTextContent("{ edges { node { id total status } } }");
  });
});

describe("ToolPanel what the server says", () => {
  it("shows the server's own description and the annotations it set", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), { canEdit: false });
    const section = within(region("Server's own description"));
    expect(
      section.getByText("Creates a PaymentIntent and confirms it."),
    ).toBeInTheDocument();
    expect(items(section.getByRole("list", { name: "Annotations" }))).toEqual([
      "destructiveHint",
    ]);
    expect(section.queryByTestId("studio-panel-server-missing")).toBeNull();
  });

  it("draws no annotation list when the server set none", () => {
    renderPanel(toolOn(BILLING, "list_invoices"), {
      serverId: BILLING,
      canEdit: false,
    });
    const section = within(region("Server's own description"));
    expect(section.getByText("GET /invoices")).toBeInTheDocument();
    expect(section.queryByRole("list", { name: "Annotations" })).toBeNull();
  });
});

describe("ToolPanel agent feedback", () => {
  it("counts agents' calls, rejections, errors and retries, with their notes", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), { canEdit: false });
    const section = within(region("Agent feedback"));
    const facts = section.getByTestId("studio-panel-feedback");
    expect(fact(facts, "Calls")).toBe("1,204");
    expect(fact(facts, "Schema rejections")).toBe("3");
    expect(fact(facts, "Error results")).toBe("12");
    expect(fact(facts, "Retries")).toBe("5");
    expect(items(section.getByRole("list", { name: "Agent notes" }))).toEqual([
      "The amount is in cents; two runs sent dollars.",
    ]);
  });

  it("draws no notes list when agents left no notes", () => {
    renderPanel(toolOn(BILLING, "list_invoices"), {
      serverId: BILLING,
      canEdit: false,
    });
    const section = within(region("Agent feedback"));
    expect(fact(section.getByTestId("studio-panel-feedback"), "Calls")).toBe(
      "88",
    );
    expect(section.queryByRole("list", { name: "Agent notes" })).toBeNull();
  });

  it("lists a note agents repeated once, in the order first given", () => {
    const tool = studioTool("create_payment", {
      feedback: {
        calls: 3,
        schemaRejections: 0,
        errorResults: 0,
        retries: 1,
        notes: [
          "Sent dollars, not cents.",
          "Retried after a rate limit.",
          "Sent dollars, not cents.",
        ],
      },
    });
    renderPanel(tool, { canEdit: false });
    const section = within(region("Agent feedback"));
    expect(items(section.getByRole("list", { name: "Agent notes" }))).toEqual([
      "Sent dollars, not cents.",
      "Retried after a rate limit.",
    ]);
  });
});

describe("ToolPanel kill switch", () => {
  it("draws the page's switch and who flipped it for a tool with a version", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), { canEdit: false });
    const section = within(region("Kill switch"));
    expect(section.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    expect(
      section.getByText("Turned off by Dana Reyes on 26 September."),
    ).toBeInTheDocument();
    expect(section.queryByText(COPY.offNone)).toBeNull();
  });

  it("draws the switch alone when the page has no flip to report", () => {
    renderPanel(toolOn(BILLING, "create_refund"), {
      serverId: BILLING,
      offFacts: null,
    });
    const section = within(region("Kill switch"));
    expect(section.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    expect(section.queryByText(/Turned off by/)).toBeNull();
    expect(section.queryByText(COPY.offNone)).toBeNull();
  });

  it("says a tool with no version has no switch, even when the page passes one", () => {
    renderPanel(toolOn(STRIPE, "list_customers"));
    const section = within(region("Kill switch"));
    expect(section.getByText(COPY.offNone)).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Turn off" })).toBeNull();
    expect(section.queryByText(/Turned off by/)).toBeNull();
  });
});

describe("ToolPanel tools the record barely holds", () => {
  it("marks everything missing on a tool that has only a name", () => {
    renderPanel(studioTool("ping"), {
      serverId: SCRATCH,
      canEdit: false,
      off: null,
      offFacts: null,
    });
    expect(
      within(region("Classification")).getByText(COPY.unclassified),
    ).toBeInTheDocument();
    expect(
      within(region("Description")).getByText("None"),
    ).toBeInTheDocument();

    const shaping = screen.getByTestId("studio-panel-shaping-missing");
    expect(shaping).toHaveAttribute("role", "note");
    expect(shaping).toHaveAttribute("data-state", "not-recorded");
    expect(shaping).toHaveAttribute("data-gap", "#4678");
    expect(shaping).toHaveTextContent(COPY.shapingMissing);
    expect(screen.queryByTestId("studio-panel-shaping")).toBeNull();

    const server = screen.getByTestId("studio-panel-server-missing");
    expect(server).toHaveAttribute("data-gap", "#4678");
    expect(server).toHaveTextContent(COPY.serverMissing);
    expect(screen.queryByTestId("studio-panel-annotations")).toBeNull();

    const feedback = screen.getByTestId("studio-panel-feedback-missing");
    expect(feedback).toHaveAttribute("data-gap", "#4678");
    expect(feedback).toHaveTextContent(COPY.feedbackMissing);
    expect(screen.queryByTestId("studio-panel-feedback")).toBeNull();

    expect(
      within(region("Kill switch")).getByText(COPY.offNone),
    ).toBeInTheDocument();
  });

  it("marks the Warehouse tool's missing shaping, server text and feedback, and keeps its switch", () => {
    renderPanel(warehouseFirst(), { serverId: WAREHOUSE, canEdit: false });
    expect(
      within(region("Description")).getByText("None"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("studio-panel-shaping-missing"),
    ).toHaveTextContent(COPY.shapingMissing);
    expect(screen.getByTestId("studio-panel-server-missing")).toHaveTextContent(
      COPY.serverMissing,
    );
    expect(
      screen.getByTestId("studio-panel-feedback-missing"),
    ).toHaveTextContent(COPY.feedbackMissing);
    const offSection = within(region("Kill switch"));
    expect(
      offSection.getByRole("button", { name: "Turn off" }),
    ).toBeInTheDocument();
    expect(offSection.queryByText(COPY.offNone)).toBeNull();
  });
});

describe("ToolPanel read-only", () => {
  it("draws no edit controls for a person who cannot edit", () => {
    renderPanel(toolOn(STRIPE, "create_payment"), { canEdit: false });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Draft" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Confirm suggestion" }),
    ).toBeNull();
    expect(screen.queryByText(COPY.importFirst)).toBeNull();
    expect(screen.queryByText(COPY.draftHint)).toBeNull();
    expect(screen.queryByTestId("studio-panel-refused")).toBeNull();
  });
});
