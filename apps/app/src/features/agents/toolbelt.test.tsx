// @vitest-environment jsdom
// Agents › Toolbelt › the input schema each belt entry carries: a tool whose
// schema is recorded, a tool whose schema is not, one over the inline cap, and
// the copy of the digest and of the schema. The section's other states (how
// the belt was computed, what the model receives, the decisions, the denied
// and error reads) are in agent.test.tsx; this file covers the disclosure,
// with an axe check in each state and a phone-width pass.
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

/** The schema block under the nth tool row. */
const schemaRow = (index: number) =>
  screen.getAllByTestId("belt-tool-schema")[index] ?? document.body;

describe("Toolbelt input schemas", () => {
  it("shows the schema, its origin and its digest for a tool that records one", async () => {
    const { container } = draw();
    const row = within(schemaRow(1));
    expect(row.getByTestId("belt-schema")).toBeTruthy();
    // The digest is the identifier: shortened in the summary, whole inside.
    expect(row.getByTestId("belt-schema")).toHaveTextContent("3f1a2b4c5d6e");
    expect(row.getByTestId("belt-schema")).toHaveTextContent(DIGEST);
    expect(row.getByTestId("belt-schema")).toHaveTextContent(
      "Declared by the capability contract.",
    );
    expect(row.getByTestId("belt-schema-json").textContent).toBe(
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
    const { container } = draw();
    const row = within(schemaRow(0));
    expect(row.getByTestId("belt-schema-none")).toHaveTextContent(
      "No input schema is recorded for this tool.",
    );
    expect(row.queryByTestId("belt-schema")).toBeNull();
    expect(row.queryByTestId("belt-schema-json")).toBeNull();
    await expectNoAxe(container);
  });

  it("carries a schema over the cap as its digest alone, and says where the full one is", async () => {
    const belt = toolbelt();
    const { container } = draw({
      ...belt,
      tools: [
        {
          ...nth(belt.tools, 1, "the second belt entry"),
          inputSchema: null,
          schemaTruncated: true,
        },
      ],
    });
    const row = within(schemaRow(0));
    expect(row.getByTestId("belt-schema")).toHaveTextContent(DIGEST);
    expect(row.getByTestId("belt-schema-truncated")).toHaveTextContent(
      "This schema is larger than the belt carries inline.",
    );
    expect(row.queryByTestId("belt-schema-json")).toBeNull();
    // Only the digest is copyable when the schema itself did not travel.
    expect(row.getAllByTestId("belt-schema-copy")).toHaveLength(1);
    await expectNoAxe(container);
  });

  it("copies the digest and the schema", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const restore = stubClipboard(writeText);
    draw();
    const row = within(schemaRow(1));
    const copies = row.getAllByTestId("belt-schema-copy");
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
    const digest = nth(
      within(schemaRow(1)).getAllByTestId("belt-schema-copy"),
      0,
      "the digest's copy button",
    );
    await user.click(digest);
    expect(digest).not.toHaveTextContent("Copied");
    // Each copy button carries its own live region; the digest's is first.
    expect(
      nth(
        within(schemaRow(1)).getAllByRole("status"),
        0,
        "the digest's live region",
      ),
    ).toHaveTextContent("Copy it by hand: this browser refused the clipboard.");
    restore();
  });

  it("keeps the schema block readable at phone width", async () => {
    const { container, restore } = phoneWidth();
    draw(toolbelt(), container);
    // The schema cell spans the table, so the card-table labeller leaves it
    // unlabelled and it reads as a block under its tool.
    const cell = within(schemaRow(1)).getByTestId("belt-schema").closest("td");
    expect(cell?.colSpan).toBe(6);
    expect(cell?.getAttribute("data-label")).toBeNull();
    await expectNoAxe(container);
    restore();
  });
});
