// @vitest-environment jsdom
// Agents › Toolbelt, the tab's interactive panels (spec pages/agent.md,
// Toolbelt): the presentation toggle in the model view, the belt search with
// its example queries and its miss, the per-tool decision rules with their
// layout toggle, category chips and the categories dialog, and the tool
// dialog a row opens with the input schema the belt entry carries. The static
// panels and the tab's failure states are in agent.test.tsx. Axe runs in each
// state.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Toolbelt } from "@/data/contracts/agents";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { phoneWidth } from "@/test/phone";
import { nth } from "@/test/nth";
import { toolbelt } from "./agents.builders";
import { ToolbeltSection } from "./toolbelt";

afterEach(cleanup);

const DIGEST =
  "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

function draw(belt: Toolbelt = toolbelt(), container?: HTMLElement) {
  return render(
    <IntlProvider>
      <ToolbeltSection read={readOk(belt)} />
    </IntlProvider>,
    container ? { container } : undefined,
  );
}

/**
 * Replace the clipboard for one test. `userEvent.setup()` installs its own,
 * so this runs after it and puts the original descriptor back.
 */
function stubClipboard(writeText: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

/** Opens the tool dialog from the tool's row in the decision rules. */
async function openTool(name: string) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.findByTestId("belt-tool-dialog");
}

describe("Model view", () => {
  it("starts on the recorded presentation and toggles the preview with aria-pressed", async () => {
    const { container } = draw();
    const group = screen.getByRole("group", { name: "Belt presentation" });
    const full = within(group).getByRole("button", { name: "Full belt" });
    const searchable = within(group).getByRole("button", {
      name: "Searchable belt",
    });
    expect(full).toHaveAttribute("aria-pressed", "true");
    expect(searchable).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("belt-block")).toHaveTextContent(
      '"name": "github__create_pull_request"',
    );
    expect(screen.getByTestId("belt-block")).toHaveTextContent(
      "sha256:3f1a2b4c5d6e",
    );
    await userEvent.click(searchable);
    expect(searchable).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("belt-block")).toHaveAttribute(
      "data-mode",
      "searchable",
    );
    expect(screen.getByTestId("belt-block")).toHaveTextContent("load_tools");
    expect(screen.getByTestId("belt-block")).not.toHaveTextContent(
      "github__create_pull_request",
    );
    expect(
      screen.getByText(/This is a preview and changes nothing/),
    ).toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("states the width against the workspace's full-belt limit", () => {
    draw(
      toolbelt({
        presentation: {
          mode: "searchable",
          limit: 1,
          sentToModel: "definitions",
        },
      }),
    );
    expect(
      screen.getByText(
        "The belt is 2 tools, over this workspace\u2019s full-belt limit of 1, so it is presented as a searchable belt.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Belt search", () => {
  it("offers the five example queries and lists the belt members a query matches", async () => {
    const { container } = draw();
    for (const example of [
      "pull request",
      "context record",
      "stripe payment",
      "delete repository",
      "graph",
    ]) {
      expect(screen.getByRole("button", { name: example })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("button", { name: "pull request" }));
    const hits = screen.getByTestId("belt-hits");
    expect(hits).toHaveTextContent("github__create_pull_request");
    expect(hits).toHaveTextContent("1 of 2 belt members matched.");
    expect(
      screen.getByRole("textbox", { name: "Search this agent\u2019s belt" }),
    ).toHaveValue("pull request");
    await expectNoAxe(container);
  });

  it("never returns a tool outside the belt, and says why it is off (negative)", async () => {
    draw();
    await userEvent.click(
      screen.getByRole("button", { name: "delete repository" }),
    );
    expect(screen.queryByTestId("belt-hits")).toBeNull();
    const miss = screen.getByTestId("belt-miss");
    expect(miss).toHaveTextContent("Zero results.");
    expect(miss).toHaveTextContent(
      "delete_repository exists in the registry, but it is not on this agent\u2019s belt: agent:3:deny",
    );
    expect(miss).toHaveTextContent(
      "A search never returns a tool outside the belt.",
    );
  });

  it("says nothing on the belt matches a query that finds nothing anywhere (negative)", async () => {
    draw();
    const input = screen.getByRole("textbox", {
      name: "Search this agent\u2019s belt",
    });
    await userEvent.type(input, "graph{Enter}");
    expect(screen.getByTestId("belt-miss")).toHaveTextContent(
      "Nothing on this agent\u2019s belt matches that.",
    );
  });
});

describe("Per-tool decision rules", () => {
  it("groups by category, filters by chip, and flattens with the layout toggle", async () => {
    const { container } = draw();
    const table = screen.getByRole("table", {
      name: "Per-tool decision rules",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Tool",
      "Category",
      "Decision",
      "Hazard",
      "Egress",
      "Financial",
      "Schema digest",
    ]);
    expect(screen.getAllByTestId("belt-group")).toHaveLength(2);
    expect(screen.getByTestId("belt-approval")).toHaveTextContent(
      "1 need approval",
    );

    const chips = screen.getByRole("group", { name: "Categories" });
    await userEvent.click(
      within(chips).getByRole("button", { name: /source control/ }),
    );
    expect(screen.getAllByTestId("belt-tool")).toHaveLength(1);
    expect(screen.getByText("1 of 2 shown")).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole("button", { name: "All 2" }));
    expect(screen.getAllByTestId("belt-tool")).toHaveLength(2);

    const layout = screen.getByRole("group", { name: "Layout" });
    const flat = within(layout).getByRole("button", { name: "Flat" });
    await userEvent.click(flat);
    expect(flat).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("belt-group")).toBeNull();
    await expectNoAxe(container);
  });

  it("opens What the categories mean as a dialog with each category's count", async () => {
    draw();
    await userEvent.click(
      screen.getByRole("button", { name: "What the categories mean" }),
    );
    const dialog = await screen.findByTestId("belt-categories-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveTextContent("Tool categories");
    expect(dialog).toHaveTextContent("source control1");
    expect(dialog).toHaveTextContent("no category1");
  });

  it("names egress and financial class as not recorded rather than drawing a class (negative)", () => {
    draw();
    const [row] = screen.getAllByTestId("belt-tool");
    expect(row).toHaveTextContent("not recorded");
  });
});

describe("Tool dialog", () => {
  it("shows the decision, rule, schema, origin and digest for a tool that records one", async () => {
    const { container } = draw();
    const dialog = within(await openTool("search_tools"));
    expect(dialog.getByTestId("belt-schema")).toHaveTextContent("3f1a2b4c5d6e");
    expect(dialog.getByTestId("belt-schema")).toHaveTextContent(DIGEST);
    expect(dialog.getByTestId("belt-schema")).toHaveTextContent(
      "Declared by the capability contract.",
    );
    expect(dialog.getByText("human:8:default")).toBeInTheDocument();
    expect(dialog.getByTestId("belt-schema-json").textContent).toBe(
      JSON.stringify(
        {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        null,
        2,
      ),
    );
    await expectNoAxe(container);
  });

  it("says nothing is recorded for a tool with no schema, rather than showing an empty one", async () => {
    draw();
    const dialog = within(await openTool("github__create_pull_request"));
    expect(dialog.getByTestId("belt-schema-none")).toHaveTextContent(
      "No input schema is recorded for this tool.",
    );
    expect(dialog.queryByTestId("belt-schema")).toBeNull();
  });

  it("carries a schema over the cap as its digest alone, and says where the full one is", async () => {
    const belt = toolbelt();
    draw({
      ...belt,
      tools: [
        {
          ...nth(belt.tools, 1, "the second belt entry"),
          inputSchema: null,
          schemaTruncated: true,
        },
      ],
    });
    const dialog = within(await openTool("search_tools"));
    expect(dialog.getByTestId("belt-schema")).toHaveTextContent(DIGEST);
    expect(dialog.getByTestId("belt-schema-truncated")).toHaveTextContent(
      "This schema is larger than the belt carries inline.",
    );
    expect(dialog.queryByTestId("belt-schema-json")).toBeNull();
    // Only the digest is copyable when the schema itself did not travel.
    expect(dialog.getAllByTestId("belt-schema-copy")).toHaveLength(1);
  });

  it("copies the digest and the schema", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const restore = stubClipboard(writeText);
    draw();
    await user.click(screen.getByRole("button", { name: "search_tools" }));
    const dialog = within(await screen.findByTestId("belt-tool-dialog"));
    const copies = dialog.getAllByTestId("belt-schema-copy");
    const digest = nth(copies, 0, "the digest's copy button");
    const schema = nth(copies, 1, "the schema's copy button");
    await user.click(digest);
    expect(writeText).toHaveBeenCalledWith(DIGEST);
    expect(digest).toHaveTextContent("Copied");
    await user.click(schema);
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('"type": "object"'),
    );
    restore();
  });

  it("says so when the browser refuses the clipboard, rather than reporting a copy that did not happen", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const user = userEvent.setup();
    const restore = stubClipboard(writeText);
    draw();
    await user.click(screen.getByRole("button", { name: "search_tools" }));
    const dialog = within(await screen.findByTestId("belt-tool-dialog"));
    const digest = nth(
      dialog.getAllByTestId("belt-schema-copy"),
      0,
      "the digest's copy button",
    );
    await user.click(digest);
    expect(digest).not.toHaveTextContent("Copied");
    // Each copy button carries its own live region; the digest's is first.
    expect(
      nth(dialog.getAllByRole("status"), 0, "the digest's live region"),
    ).toHaveTextContent("Copy it by hand: this browser refused the clipboard.");
    restore();
  });

  it("rises as a dialog at phone width", async () => {
    const { container, restore } = phoneWidth();
    draw(toolbelt(), container);
    const dialog = await openTool("search_tools");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeVisible();
    restore();
  });
});

describe("Off the belt", () => {
  const offTheBelt = () => screen.getByRole("region", { name: "Off the belt" });

  it("names the server of an MCP tool the belt leaves out, beside the rule", async () => {
    const { container } = draw(
      toolbelt({
        cannotSee: [
          {
            name: "github__delete_repository",
            kind: "mcp",
            server: "mcp_github",
            rule: "org:2:deny",
          },
        ],
      }),
    );
    const [row] = within(offTheBelt()).getAllByTestId("belt-off-row");
    expect(row).toHaveTextContent("github__delete_repositorymcp_github");
    expect(row).toHaveTextContent("org:2:deny");
    await expectNoAxe(container);
  });

  it("says every registry tool is on the belt when none is left out, and draws no table (negative)", async () => {
    const { container } = draw(toolbelt({ cannotSee: [] }));
    expect(offTheBelt()).toHaveTextContent(
      "Every tool in the registry is on the belt.",
    );
    expect(within(offTheBelt()).queryByRole("table")).toBeNull();
    await expectNoAxe(container);
  });
});
